import {
  MEDIA_TOOLS, MEDIA_TOOL_IDS, MEDIA_TOOL_MARKUP, MEDIA_TOOL_VOICES,
  type MediaTool, type MediaToolId, type MediaToolInput,
} from "@yumina/shared";
import type { ToolDefinition } from "../llm/types.js";
import { RIG_DEFAULT_MOTIONS, RIG_MAX_MOTIONS, RIG_MOTIONS } from "../generation/model3d-rig.js";

/**
 * The workbench tools as an AI sees them: the Studio assistant (run_media_tool shows a card the creator
 * presses Run on) and outside AIs over MCP (run_media_tool runs at once, capped per hour). One definition
 * set, so the two cannot drift. No database here: tools.ts imports this.
 */

export const RUN_MEDIA_TOOL_NAME = "run_media_tool";
export const LIST_MEDIA_TOOLS_NAME = "list_media_tools";
export const GET_MEDIA_JOB_NAME = "get_media_job";

/** What each tool does, in one line an AI can choose by. */
export const MEDIA_TOOL_BLURBS: Record<MediaToolId, string> = {
  "remove-bg": "cut the subject out of a picture onto transparency (PNG)",
  upscale: "enlarge a picture 2× or 4× with added detail",
  inpaint: "repaint the white area of a mask over a picture from a prompt",
  expand: "extend a picture outward to another aspect ratio (outpainting)",
  relight: "change a picture's lighting (sunset, neon, moonlight…)",
  lipsync: "make the face in a 2–10 s video speak an audio clip (a clip under 720p is scaled up); slow, ~12 min",
  talk: "make a still picture of a character speak an audio clip (2–30 s; a short one is padded); a few minutes",
  "video-upscale": "upscale a video 2× (≤20 s, ≤1080p in)",
  "video-sound": "add matching sound/foley to a silent video (≤30 s)",
  "dubbing": "translate the speech in a video (8 s-2 min) into another language, in the speaker's own voice, lips synced",
  "reframe": "change a video's shape (e.g. 16:9 to 9:16, ≤30 s), drawing the missing area instead of cropping",
  "motion": "make a character picture move like the person in a reference video (3-30 s)",
  "song-mureka": "a song with vocals from lyrics ([verse]/[chorus] tags) and an optional style prompt, best quality (Mureka V9.5)",
  "bgm-mureka": "an instrumental track from a description, about 1–3 min (Mureka V9.5)",
  song: "a song from a style prompt with optional lyrics ([verse]/[chorus] tags), 10–240 s, exact length (ElevenLabs Music v2.5)",
  "song-open": "a song from genre tags with optional lyrics, cheap (ACE-Step)",
  sfx: "a sound effect from a description, 1–30 s, can loop",
  voice: "speak text in a chosen voice (ElevenLabs v3; inline tags like [whispers] work)",
  "voice-change": "re-voice a recording in a chosen voice, keeping its delivery",
  "to-3d": "a 3D model (.glb) from one picture of ONE object or character. The picture decides the model: front view, the whole thing in frame and centred, plain background, nothing else in it (make that picture first if there is none). `model` picks the generator: hunyuan (default: the sharpest, about 4 minutes), rodin (richest colour), tripo (real-world size on its own), trellis (fastest, soft up close: drafts), meshy. `detail` is how much of it is kept: high (default: up to 200k triangles and 2K textures, 5-10 MB, for something the player looks at up close) or standard (50k triangles, 1K textures, 1-3 MB: use this for each of many props in one scene, or the card gets heavy). `heightM` is how tall the thing really is, in metres (a chair 0.9, a bookshelf 2.1, a bowl 0.08): give it whenever you know what the thing is, so it lands the right size, standing on its base. The file that lands is ready for a card: load it with loadThree() and parseGLB",
  "to-3d-character": "a 3D person who moves (.glb with a skeleton and motions), from one picture of ONE person: full body head to shoes, standing straight in an A-pose (arms a little away from the body, legs a little apart), straight-on front view, plain background (make that picture first). About 5 minutes. `motions` lists up to " + RIG_MAX_MOTIONS + " motions from the library by name, comma separated (idle is always included; list_media_tools lists them all); left empty it gets " + RIG_DEFAULT_MOTIONS.join(", ") + ". Each motion lands as an animation of that name in the one file, so a card plays it by name (in loadWorld, w.person plays idle / walk on its own and `play(name)` the rest). There is no talking motion: a person's head and the caption carry speech. `heightM` is the person's height in metres (default 1.65). Chibi figures and long hair work. A wide skirt flattens when sitting",
};

function inputLine(input: MediaToolInput): string {
  const req = "required" in input && input.required ? " (required)" : "";
  switch (input.kind) {
    case "image": case "video": case "audio": return `${input.key}: ${input.kind} @asset${req}`;
    case "mask": return `${input.key}: PNG mask @asset over ${input.of}, white = change${req}`;
    case "text": case "lyrics": return `${input.key}: ${input.kind === "lyrics" ? "lyrics" : "text"} ≤${input.maxChars} chars${req}`;
    case "number": return `${input.key}: ${input.min}-${input.max} step ${input.step}, default ${input.default}`;
    case "select": return `${input.key}: one of ${input.options.join("|")}, default ${input.default}`;
    case "boolean": return `${input.key}: true|false, default ${input.default}`;
    case "voice": return `${input.key}: voice, default ${input.default}`;
  }
}

/** One compact line per tool: id, what it does, its inputs. */
export function mediaToolLines(): string {
  return (MEDIA_TOOLS as readonly MediaTool[]).map((t) =>
    `- ${t.id} → ${t.output === "model3d" ? "3D .glb" : t.output}: ${MEDIA_TOOL_BLURBS[t.id as MediaToolId]}. Inputs: ${t.inputs.map(inputLine).join("; ")}`,
  ).join("\n");
}

const VOICES_LINE = `Voices: ${MEDIA_TOOL_VOICES.map((v) => `${v.id} (${v.gender}, ${v.accent})`).join(", ")}.`;

export function runMediaToolDefinition(mode: "studio" | "outside", perHour?: number): ToolDefinition {
  const how = mode === "studio"
    ? "It only shows the creator a card with the price; nothing runs or is charged until they press Run, and they may change the options there. Call it alone, with one short sentence saying what you will make and why. The result comes back with @asset refs once it lands (or a jobId for a long one: check it later with get_media_job)."
    : `It runs at once and COSTS the creator mushies at the normal price; at most ${perHour ?? 20} runs an hour. It returns a jobId at once: call get_media_job with it until status is succeeded (then you get @asset refs) or failed (any charge is refunded). Only run a tool the creator asked for or the card clearly needs.`;
  return {
    type: "function",
    function: {
      name: RUN_MEDIA_TOOL_NAME,
      description:
        "Run one of Yumina's media tools on the creator's files (the output lands in their asset library): picture fixes, video, songs, sound effects, voice lines, 3D models. "
        + how + " Media inputs are @asset refs of the creator's own files (find them with list_assets). Prices and limits: list_media_tools.\n"
        + mediaToolLines() + "\n" + VOICES_LINE,
      parameters: {
        type: "object",
        properties: {
          tool: { type: "string", enum: [...MEDIA_TOOL_IDS] },
          inputs: { type: "object", description: "The tool's inputs by key, as listed above. Media as \"@asset:<id>\"." },
        },
        required: ["tool", "inputs"],
      },
    },
  };
}

export const LIST_MEDIA_TOOLS_DEFINITION: ToolDefinition = {
  type: "function",
  function: {
    name: LIST_MEDIA_TOOLS_NAME,
    description: "The media tools run_media_tool can run, in full: each tool's inputs with their limits, how its price is worked out (USD from the provider × markup, 1 mushie = $0.001), roughly how long it takes, and the voices. Free.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
};

export const GET_MEDIA_JOB_DEFINITION: ToolDefinition = {
  type: "function",
  function: {
    name: GET_MEDIA_JOB_NAME,
    description: "The state of a media tool run started with run_media_tool: queued, running, succeeded (with the output's @asset refs) or failed (with a code; any charge is refunded). Free.",
    parameters: { type: "object", properties: { jobId: { type: "string" } }, required: ["jobId"] },
  },
};

/** list_media_tools' answer. */
export function listMediaToolsResult() {
  return {
    markup: MEDIA_TOOL_MARKUP,
    usdPerMushie: 0.001,
    note: "mushies = ceil(providerUsd × markup / 0.001). providerUsd = max(minUsd, units × usd) with units from `per` (call, second, minute, megapixel, kchar = 1,000 characters), rounded up to `roundUp` first; `amount` says what is measured.",
    tools: (MEDIA_TOOLS as readonly MediaTool[]).map((t) => ({
      id: t.id, group: t.group, output: t.output, what: MEDIA_TOOL_BLURBS[t.id as MediaToolId], aboutSeconds: t.seconds,
      inputs: t.inputs, price: t.price, amount: t.amount,
    })),
    voices: MEDIA_TOOL_VOICES,
    /** to-3d-character's motion library, by the name `motions` takes and the clip gets */
    characterMotions: RIG_MOTIONS.map(([, name]) => name),
  };
}
