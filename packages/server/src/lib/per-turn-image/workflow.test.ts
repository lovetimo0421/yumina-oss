import assert from "node:assert/strict";
import test from "node:test";
import { env } from "../env.js";
import { adultCaption, animaText, buildTurnWorkflow, explicitNamesMinor, onePerson, PromptRefusedError, tidyExplicitPrompt, turnRoute, type TurnPrompt } from "./illustrate.js";

type Node = { class_type: string; inputs: Record<string, unknown> };
const nodes = (g: Record<string, unknown>, type: string) => Object.values(g as Record<string, Node>).filter((n) => n.class_type === type);
const jpeg = Buffer.from("x");

test("a portrait draws the character from it over the whole frame", () => {
  const g = buildTurnWorkflow({ scene: "1girl, observatory", bodies: [], portraits: [{ name: "a.jpg", jpeg, slot: 0 }] }, 1, "bad");
  const [ipa, ...rest] = nodes(g, "IPAdapterAdvanced");
  assert.equal(rest.length, 0);
  assert.equal(ipa!.inputs.weight_type, "linear");
  assert.equal(ipa!.inputs.attn_mask, undefined);
  assert.equal(nodes(g, "LoadImage")[0]!.inputs.image, "a.jpg");
});

test("two portraits each stay on their own half of a two-person frame", () => {
  const g = buildTurnWorkflow({ scene: "1girl, 1boy", bodies: ["1girl, blue hair", "1boy, black hair"],
    portraits: [{ name: "a.jpg", jpeg, slot: 0 }, { name: "b.jpg", jpeg, slot: 1 }] }, 1, "bad") as Record<string, Node>;
  const ipas = nodes(g, "IPAdapterAdvanced");
  assert.equal(ipas.length, 2);
  const xs = ipas.map((n) => g[(n.inputs.attn_mask as [string, number])[0]]!.inputs.x);
  assert.deepEqual(xs, [0, 832 - 480]);
  // Chained: the second adapter patches the first one's model, the sampler takes the last.
  assert.deepEqual(g.ref1!.inputs.model, ["ref0", 0]);
  assert.deepEqual(g.ks!.inputs.model, ["ref1", 0]);
});

test("only the second character's portrait: it goes to the right half", () => {
  const g = buildTurnWorkflow({ scene: "2girls", bodies: ["1girl", "1girl"], portraits: [{ name: "b.jpg", jpeg, slot: 1 }] }, 1, "bad") as Record<string, Node>;
  const [ipa] = nodes(g, "IPAdapterAdvanced");
  assert.equal(g[(ipa!.inputs.attn_mask as [string, number])[0]]!.inputs.x, 832 - 480);
});

test("no portrait: no adapter, and the house style stays", () => {
  const g = buildTurnWorkflow({ scene: "scenery", bodies: [] }, 1, "bad");
  assert.equal(nodes(g, "IPAdapterAdvanced").length, 0);
});

test("two people share one prompt instead of each getting half the frame", () => {
  const g = buildTurnWorkflow({ scene: "2girls, hug", bodies: ["1girl, silver hair, haori", "1girl, black hair, qipao"] }, 1, "bad") as Record<string, Node>;
  assert.equal(nodes(g, "ConditioningSetArea").length, 0);
  // Each body follows the scene, without its own head count.
  assert.equal(g.pos!.inputs.text, "2girls, hug, silver hair, haori, black hair, qipao");
  assert.deepEqual(g.ks!.inputs.positive, ["pos", 0]);
});

// ── Routes (PER_TURN_IMAGE_EDIT_MODEL / _STORY_MODEL / _EXPLICIT_CHECKPOINT) ──

function withEnv(values: Partial<Record<"PER_TURN_IMAGE_EDIT_MODEL" | "PER_TURN_IMAGE_EDIT_EXPLICIT" | "PER_TURN_IMAGE_STORY_MODEL" | "PER_TURN_IMAGE_EXPLICIT_CHECKPOINT" | "PER_TURN_IMAGE_ANIMA_MODEL" | "PER_TURN_IMAGE_ANIMA_SAMPLING" | "PER_TURN_IMAGE_ANIMA_DETAILED_MODEL" | "PER_TURN_IMAGE_ANIMA_DETAILED_SAMPLING" | "PER_TURN_IMAGE_VIVID_CHECKPOINT" | "PER_TURN_IMAGE_VIVID_SAMPLING", string>>, run: () => void) {
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, env[k as keyof typeof env]]));
  Object.assign(env, values);
  try { run(); } finally { Object.assign(env, saved); }
}
const EDIT = "qwen_image_edit_2511_fp8mixed.safetensors";
const STORY = "z-anime-distill-8step-fp8.safetensors";

test("nothing configured: every picture takes the SDXL path, as before", () => {
  withEnv({ PER_TURN_IMAGE_EDIT_MODEL: "", PER_TURN_IMAGE_STORY_MODEL: "" }, () => {
    assert.equal(turnRoute({ scene: "1girl", bodies: [], caption: "a woman", portraits: [{ name: "a.jpg", jpeg, slot: 0 }] }), "sdxl");
    assert.equal(turnRoute({ scene: "1girl", bodies: [], caption: "a woman" }), "sdxl");
  });
});

test("portraits go to the edit model, which gets every portrait as a reference image", () => {
  withEnv({ PER_TURN_IMAGE_EDIT_MODEL: EDIT, PER_TURN_IMAGE_STORY_MODEL: STORY }, () => {
    const g = buildTurnWorkflow({ scene: "2girls, hug", bodies: ["1girl, a", "1girl, b"], caption: "Two women hug at a station.",
      portraits: [{ name: "b.jpg", jpeg, slot: 1, look: "1girl, adult, red hair" }, { name: "a.jpg", jpeg, slot: 0, look: "1girl, adult, silver hair" }] }, 1, "bad") as Record<string, Node>;
    assert.equal(nodes(g, "IPAdapterAdvanced").length, 0);
    assert.equal(nodes(g, "UNETLoader")[0]!.inputs.unet_name, EDIT);
    const [pos] = nodes(g, "TextEncodeQwenImageEditPlus").filter((n) => n.inputs.prompt);
    // Image order follows the characters' order, whatever order the portraits arrived in.
    assert.equal(g[(pos!.inputs.image1 as [string, number])[0]]!.inputs.image, "a.jpg");
    assert.equal(g[(pos!.inputs.image2 as [string, number])[0]]!.inputs.image, "b.jpg");
    assert.match(pos!.inputs.prompt as string, /^Two women hug at a station\..*image 1 is the character with adult, silver hair; image 2 is the character with adult, red hair/);
  });
});

test("portraits through nudity go to the edit model; a sex act goes to SDXL without the adapter unless allowed", () => {
  const portraits = [{ name: "a.jpg", jpeg, slot: 0 }];
  withEnv({ PER_TURN_IMAGE_EDIT_MODEL: EDIT, PER_TURN_IMAGE_EDIT_EXPLICIT: "" }, () => {
    assert.equal(turnRoute({ scene: "nsfw, explicit, 1girl, nude, onsen", bodies: [], caption: "x", explicit: true, portraits }), "edit");
    const act = { scene: "nsfw, explicit, (sex, missionary:1.25), 1girl", bodies: [], caption: "x", explicit: true, portraits };
    assert.equal(turnRoute(act), "sdxl");
    assert.equal(nodes(buildTurnWorkflow(act, 1, "bad"), "IPAdapterAdvanced").length, 0);
  });
  withEnv({ PER_TURN_IMAGE_EDIT_MODEL: EDIT, PER_TURN_IMAGE_EDIT_EXPLICIT: "1" }, () => {
    assert.equal(turnRoute({ scene: "(sex, cowgirl position:1.25), 1girl", bodies: [], explicit: true, portraits }), "edit");
  });
});

test("a plain moment without portraits is drawn by the story model from the caption", () => {
  withEnv({ PER_TURN_IMAGE_STORY_MODEL: STORY }, () => {
    const g = buildTurnWorkflow({ scene: "1girl, kitchen", bodies: [], caption: "A woman kneads dough." }, 7, "bad") as Record<string, Node>;
    assert.equal(nodes(g, "UNETLoader")[0]!.inputs.unet_name, STORY);
    assert.match(g.pos!.inputs.text as string, /^A woman kneads dough\. Anime illustration\. All characters are adults\.$/);
    assert.equal(g.ks!.inputs.seed, 7);
    // No caption, or an explicit moment: SDXL.
    assert.equal(turnRoute({ scene: "1girl", bodies: [] }), "sdxl");
    assert.equal(turnRoute({ scene: "1girl, nude", bodies: [], caption: "x", explicit: true }), "sdxl");
  });
});

test("an explicit moment can use its own SDXL checkpoint; a host recipe keeps its own", () => {
  withEnv({ PER_TURN_IMAGE_EXPLICIT_CHECKPOINT: "waiIllustriousSDXL_v170.safetensors" }, () => {
    const explicit = buildTurnWorkflow({ scene: "1girl, nude", bodies: [], explicit: true }, 1, "bad") as Record<string, Node>;
    assert.equal(explicit.ckpt!.inputs.ckpt_name, "waiIllustriousSDXL_v170.safetensors");
    const plain = buildTurnWorkflow({ scene: "1girl", bodies: [] }, 1, "bad") as Record<string, Node>;
    assert.equal(plain.ckpt!.inputs.ckpt_name, env.PER_TURN_IMAGE_CHECKPOINT);
  });
});

test("an explicit prompt weights only the act and drops camera angles that fight a pov", () => {
  const tidy = tidyExplicitPrompt("masterpiece, nsfw, (sex, missionary, penis, nipples, blush, sweat, purple glow:1.25), 1girl, pov, from above, bedroom");
  assert.equal(tidy, "masterpiece, nsfw, (sex, missionary, penis, nipples:1.25), blush, sweat, purple glow, 1girl, pov, bedroom");
  // Without a pov the angle is the shot itself and stays.
  assert.match(tidyExplicitPrompt("nsfw, (lying:1.25), 1girl, from above"), /from above/);
  // A short act group is left as it is.
  assert.equal(tidyExplicitPrompt("(kiss, hug:1.25), 2girls, pov, from behind"), "(kiss, hug:1.25), 2girls, pov, from behind");
});

// ── Anima (PER_TURN_IMAGE_ANIMA_MODEL) ──

const ANIMA = "anima-turbo-v1.1.safetensors";

test("with Anima set it draws everything the edit model doesn't: plain, explicit, sex acts, empty scenes", () => {
  const portraits = [{ name: "a.jpg", jpeg, slot: 0 }];
  withEnv({ PER_TURN_IMAGE_EDIT_MODEL: EDIT, PER_TURN_IMAGE_STORY_MODEL: STORY, PER_TURN_IMAGE_ANIMA_MODEL: ANIMA }, () => {
    assert.equal(turnRoute({ scene: "1girl, kitchen", bodies: [], caption: "x" }), "anima");
    assert.equal(turnRoute({ scene: "no humans, scenery", bodies: [] }), "anima");
    assert.equal(turnRoute({ scene: "nsfw, explicit, (sex, missionary:1.25), 1girl", bodies: [], explicit: true }), "anima");
    // Portraits: the edit model keeps a plain or suggestive moment; nudity and sex acts leave it.
    assert.equal(turnRoute({ scene: "1girl, cafe", bodies: [], caption: "x", portraits }), "edit");
    assert.equal(turnRoute({ scene: "1girl, lingerie, cleavage", bodies: [], caption: "x", explicit: true, portraits }), "edit");
    assert.equal(turnRoute({ scene: "nsfw, explicit, 1girl, nude, onsen", bodies: [], caption: "x", explicit: true, portraits }), "anima");
    assert.equal(turnRoute({ scene: "(sex, cowgirl position:1.25), 1girl", bodies: [], explicit: true, portraits }), "anima");
  });
});

test("Anima's graph: its loaders and the turbo schedule; a fine redraw takes more steps", () => {
  withEnv({ PER_TURN_IMAGE_ANIMA_MODEL: ANIMA, PER_TURN_IMAGE_ANIMA_SAMPLING: "" }, () => {
    const g = buildTurnWorkflow({ scene: "1girl, kitchen", bodies: [], caption: "A woman kneads dough." }, 9, "bad") as Record<string, Node>;
    assert.equal(g.unet!.inputs.unet_name, ANIMA);
    assert.deepEqual([g.clip!.inputs.clip_name, g.clip!.inputs.type], ["qwen_3_06b_base.safetensors", "stable_diffusion"]);
    assert.deepEqual([g.ks!.inputs.steps, g.ks!.inputs.cfg, g.ks!.inputs.sampler_name, g.ks!.inputs.seed], [10, 1, "euler", 9]);
    const fine = buildTurnWorkflow({ scene: "1girl", bodies: [], fine: true }, 9, "bad") as Record<string, Node>;
    assert.deepEqual([fine.ks!.inputs.steps, fine.ks!.inputs.sampler_name], [12, "er_sde"]);
  });
  withEnv({ PER_TURN_IMAGE_ANIMA_MODEL: "anima-aesthetic-v1.1.safetensors", PER_TURN_IMAGE_ANIMA_SAMPLING: "" }, () => {
    const g = buildTurnWorkflow({ scene: "1girl", bodies: [] }, 9, "bad, 2girls") as Record<string, Node>;
    assert.deepEqual([g.ks!.inputs.steps, g.ks!.inputs.cfg, g.ks!.inputs.sampler_name], [30, 4, "er_sde"]);
    assert.match(g.neg!.inputs.text as string, /^worst quality, low quality, artist name.*bad, 2girls$/);
  });
});

test("the detailed style draws on Anima's full model at its own schedule, only where one is configured", () => {
  const AES = "anima-aesthetic-v1.1.safetensors";
  withEnv({ PER_TURN_IMAGE_ANIMA_MODEL: ANIMA, PER_TURN_IMAGE_ANIMA_SAMPLING: "", PER_TURN_IMAGE_ANIMA_DETAILED_MODEL: AES, PER_TURN_IMAGE_ANIMA_DETAILED_SAMPLING: "" }, () => {
    const g = buildTurnWorkflow({ scene: "1girl, cafe", bodies: [], style: "detailed" }, 9, "bad") as Record<string, Node>;
    assert.equal(turnRoute({ scene: "1girl, cafe", bodies: [], style: "detailed" }), "anima");
    assert.equal(g.unet!.inputs.unet_name, AES);
    assert.deepEqual([g.ks!.inputs.steps, g.ks!.inputs.cfg, g.ks!.inputs.sampler_name], [30, 4, "er_sde"]);
    // A fine redraw in the detailed style stays on its schedule.
    const fine = buildTurnWorkflow({ scene: "1girl", bodies: [], style: "detailed", fine: true }, 9, "bad") as Record<string, Node>;
    assert.equal(fine.ks!.inputs.steps, 30);
    const plain = buildTurnWorkflow({ scene: "1girl", bodies: [] }, 9, "bad") as Record<string, Node>;
    assert.equal(plain.unet!.inputs.unet_name, ANIMA);
  });
  // A saved choice outlives the setting: then it draws as before.
  withEnv({ PER_TURN_IMAGE_ANIMA_MODEL: ANIMA, PER_TURN_IMAGE_ANIMA_SAMPLING: "", PER_TURN_IMAGE_ANIMA_DETAILED_MODEL: "" }, () => {
    const g = buildTurnWorkflow({ scene: "1girl", bodies: [], style: "detailed" }, 9, "bad") as Record<string, Node>;
    assert.deepEqual([g.unet!.inputs.unet_name, g.ks!.inputs.steps], [ANIMA, 10]);
  });
});

test("Anima's prompt: its own quality and safety tags, no SDXL weights, then the caption, adults said in words", () => {
  const text = animaText({ scene: "masterpiece, best quality, nsfw, explicit, (sex, missionary:1.25), 1girl, 1boy, pov, bedroom",
    bodies: ["1girl, adult, silver hair"], caption: "A young girl lies on the bed.", explicit: true });
  assert.equal(text, "masterpiece, best quality, newest, explicit, sex, missionary, 1girl, 1boy, pov, bedroom, adult, silver hair. A woman lies on the bed. All characters are adults.");
  assert.match(animaText({ scene: "1girl, lingerie", bodies: [], explicit: true }), /^masterpiece, best quality, newest, sensitive, 1girl, lingerie\./);
  assert.match(animaText({ scene: "1girl, cafe", bodies: [] }), /, safe, 1girl, cafe\./);
});

test("captions read as adults: girls, boys, kids and petite become women, men, adults and slim", () => {
  assert.equal(adultCaption("A little girl and two boys watch a petite schoolgirl and her girlfriend."),
    "A woman and two men watch a slim adult and her girlfriend.");
  assert.equal(adultCaption("as a young black-haired girl kneads his shoulders, a young man waits"), "as a black-haired woman kneads his shoulders, a man waits");
  assert.equal(adultCaption("Two young girls; a child; teenagers; the teen."), "Two women; an adult; adults; the adult.");
});

// ── The "vivid" style (PER_TURN_IMAGE_VIVID_CHECKPOINT) ──

const WAI = "waiIllustriousSDXL_v170.safetensors";


test("vivid: one person is drawn on WAI with its tags, no speed LoRA and no caption", () => {
  withEnv({ PER_TURN_IMAGE_ANIMA_MODEL: ANIMA, PER_TURN_IMAGE_VIVID_CHECKPOINT: WAI, PER_TURN_IMAGE_VIVID_SAMPLING: "" }, () => {
    const prompt = { scene: "1girl, kitchen, morning", bodies: [], caption: "A woman in a kitchen.", style: "vivid" as const };
    assert.equal(turnRoute(prompt), "sdxl");
    const g = buildTurnWorkflow(prompt, 1, "worst quality") as Record<string, Node>;
    assert.equal(g.ckpt!.inputs.ckpt_name, WAI);
    assert.equal(nodes(g, "LoraLoader").length, 0);
    assert.equal(g.ks!.inputs.steps, 20);
    assert.equal(g.ks!.inputs.sampler_name, "euler_ancestral");
    assert.match(String(g.pos!.inputs.text), /very aesthetic/);
    assert.doesNotMatch(String(g.pos!.inputs.text), /A woman in a kitchen/);
    assert.match(String(g.neg!.inputs.text), /chibi/);
  });
});

test("vivid: two people, a portrait, or no WAI configured stay where they were", () => {
  withEnv({ PER_TURN_IMAGE_ANIMA_MODEL: ANIMA, PER_TURN_IMAGE_VIVID_CHECKPOINT: WAI }, () => {
    assert.equal(turnRoute({ scene: "1girl, 1boy, hug", bodies: ["1girl", "1boy"], style: "vivid" }), "anima");
    assert.equal(turnRoute({ scene: "2girls, cafe", bodies: [], style: "vivid" }), "anima");
    assert.equal(turnRoute({ scene: "1girl, cafe", bodies: [], style: "detailed" }), "anima");
  });
  withEnv({ PER_TURN_IMAGE_ANIMA_MODEL: ANIMA, PER_TURN_IMAGE_VIVID_CHECKPOINT: WAI, PER_TURN_IMAGE_EDIT_MODEL: EDIT }, () => {
    assert.equal(turnRoute({ scene: "1girl, cafe", bodies: [], style: "vivid", portraits: [{ name: "a.jpg", jpeg, slot: 0 }] }), "edit");
  });
  withEnv({ PER_TURN_IMAGE_ANIMA_MODEL: ANIMA, PER_TURN_IMAGE_VIVID_CHECKPOINT: "" }, () => {
    assert.equal(turnRoute({ scene: "1girl, cafe", bodies: [], style: "vivid" }), "anima");
  });
});

test("one person: a single head count and at most one body", () => {
  assert.equal(onePerson({ scene: "1girl, solo, cafe", bodies: [] }), true);
  assert.equal(onePerson({ scene: "1boy, 1boy, duel", bodies: [] }), true);
  assert.equal(onePerson({ scene: "1girl, 1boy, cafe", bodies: [] }), false);
  assert.equal(onePerson({ scene: "3girls, beach", bodies: [] }), false);
  assert.equal(onePerson({ scene: "scenery", bodies: ["1girl", "1girl"] }), false);
});

// ── Explicit pictures that name a minor (every route, with or without a LoRA) ──

const ALL_ROUTES = [
  {},
  { PER_TURN_IMAGE_ANIMA_MODEL: ANIMA },
  { PER_TURN_IMAGE_EDIT_MODEL: EDIT, PER_TURN_IMAGE_EDIT_EXPLICIT: "1", PER_TURN_IMAGE_STORY_MODEL: STORY },
  { PER_TURN_IMAGE_EXPLICIT_CHECKPOINT: "waiIllustriousSDXL_v170.safetensors" },
  { PER_TURN_IMAGE_ANIMA_MODEL: ANIMA, PER_TURN_IMAGE_VIVID_CHECKPOINT: WAI },
] as const;

test("an explicit picture whose text names a minor is refused on every route", () => {
  const refused: TurnPrompt[] = [
    { scene: "1girl, 1boy, nsfw, explicit, sex, missionary, bedroom", bodies: [], explicit: true, caption: "A schoolgirl and a man in bed." },
    { scene: "1girl, nude, onsen, Young_Girls", bodies: [], explicit: true },
    { scene: "1girl, 1boy, sex, bedroom", bodies: ["1girl, teens", "1boy"], explicit: true },
    { scene: "1girl, nude, bath", bodies: [], explicit: true, portraits: [{ name: "a.jpg", jpeg, slot: 0, look: "1girl, 萝莉" }] },
    { scene: "1girl, nude, bath", bodies: [], explicit: true, style: "vivid", caption: "A little-girls bath." },
    // The moment's own flag is enough, even without a nudity tag in the scene.
    { scene: "1girl, bedroom, lingerie", bodies: [], explicit: true, caption: "A middle school student undresses." },
    // A LoRA trigger is the picture's text too.
    { scene: "1girl, nude, bedroom", bodies: [], explicit: true, loras: [{ modelId: "m", file: "x.safetensors", weight: 0.9, trigger: "shota_style" }] },
  ];
  for (const values of ALL_ROUTES) {
    withEnv(values, () => {
      for (const prompt of refused) {
        assert.equal(explicitNamesMinor(prompt), true, prompt.scene);
        assert.throws(() => buildTurnWorkflow(prompt, 1, "bad"), PromptRefusedError, `${JSON.stringify(values)} ${prompt.scene}`);
        // The fallback recipe (RunPod) refuses it as well: nothing falls through.
        assert.throws(() => buildTurnWorkflow(prompt, 1, "bad", { checkpoint: "plat_nsfw_anime.safetensors", loras: [], steps: 24, cfg: 5, sampler: "euler_ancestral", scheduler: "normal", styleReference: false }), PromptRefusedError);
      }
    });
  }
});

test("an explicit picture of adults is drawn", () => {
  const adults: TurnPrompt[] = [
    { scene: "1girl, 1boy, nsfw, explicit, sex, missionary, adult, bedroom", bodies: [], explicit: true, caption: "A woman and a man have sex in bed." },
    { scene: "1girl, nude, onsen, mature female", bodies: ["1girl, adult, silver hair"], explicit: true, caption: "A young woman bathes in a hot spring." },
    { scene: "1girl, nude, classroom, school uniform", bodies: [], explicit: true, caption: "A teacher alone in a classroom." },
  ];
  for (const values of ALL_ROUTES) {
    withEnv(values, () => {
      for (const prompt of adults) {
        assert.equal(explicitNamesMinor(prompt), false, prompt.scene);
        assert.doesNotThrow(() => buildTurnWorkflow(prompt, 1, "bad"), `${JSON.stringify(values)} ${prompt.scene}`);
      }
    });
  }
});

test("a picture that isn't explicit is unaffected by school or youth wording", () => {
  const ordinary: TurnPrompt[] = [
    { scene: "1girl, school uniform, classroom", bodies: [], caption: "A woman waits at an elementary school gate." },
    { scene: "1girl, schoolgirl, park", bodies: [], caption: "A schoolgirl walks home from middle school." },
  ];
  for (const values of ALL_ROUTES) {
    withEnv(values, () => {
      for (const prompt of ordinary) {
        assert.equal(explicitNamesMinor(prompt), false, prompt.scene);
        assert.doesNotThrow(() => buildTurnWorkflow(prompt, 1, "bad"), `${JSON.stringify(values)} ${prompt.scene}`);
      }
    });
  }
});
