// Per-turn illustration: draw the moment a reply ends on and hand back an
// `[image:…]` embed to append to it.
//
//   reply → uncensored small LLM writes danbooru tags for the final moment
//         → + each character's fixed look (from the card once, or from the
//           reply for an NPC the card never describes, then kept per session)
//         → 8-step Illustrious workflow on the generation provider,
//           RunPod as the second route
//         → stored like chat images, embedded with the existing render syntax.
//
// Runs after the turn has finished (the client asks for it), so a slow or
// failed picture never holds up or costs the player their reply. Every
// failure comes back as a reason the player can be shown.

import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import type { WorldDefinition } from "@yumina/engine";
import { env } from "../env.js";
import { createProvider } from "../llm/provider-factory.js";
import { getFallbackGenerationProvider, getTurnImagePoolProvider, type GenerationProvider } from "../generation/provider.js";
import { getComfyDeployProvider } from "../generation/comfy-deploy.js";
import { getObjectBuffer, putObject } from "../s3.js";
import type { MessageContent } from "../llm/types.js";
import { sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { isExplicitMoment, negativeFor, normalizeTags, stripExplicit } from "./age.js";
import { perTurnImagesEnabled, turnImagePrefs } from "./availability.js";
import { recordUsageLog } from "../usage-log.js";
import { redis } from "../redis.js";
import { markPlayerKeyDenied, playerKeyDenied, sideCallTier, type PlayerSideKey, type SideCallKeySource } from "../side-call-key.js";

export { perTurnImagesEnabled };

const TAG_TIMEOUT_MS = 20_000;
const CAST_TIMEOUT_MS = 45_000;
// A tagger still silent after this long gets company: the next model starts
// too and the first good answer is used. deepseek answers in ~2s when it
// answers at all; past 3s it is usually about to fail, and waiting on it
// held prod pictures up 10-15s (2026-10-02). grok takes ~10s.
const HEDGE_MS = 3_000;
const CAST_HEDGE_MS = 20_000;
// A warm deployment answers in seconds. When its machine is busy (a video
// clip holds it 30s-3min) the job goes to a fresh machine that loads the
// checkpoint first: 36-47s measured 2026-10-03. At 30s those pictures were
// abandoned just before they landed, so wait out a cold start.
const DEPLOY_RENDER_TIMEOUT_MS = 60_000;
const PRIMARY_RENDER_TIMEOUT_MS = 45_000;
// RunPod scales from zero: a cold worker loads the checkpoint first (~50s measured).
const FALLBACK_RENDER_TIMEOUT_MS = 90_000;
// Tried in order; the next one runs when a model errors or refuses. Measured
// on 32 real prod turns, most of them explicit (2026-09-29): grok-4.3 failed
// 1/32 and was the one that kept names, outfits and the final moment right
// (p50 10s); deepseek-v4.1-flash failed 2/32 (p50 8s); gemini-2.5-flash's
// content filter blocked 6/32 and it swapped characters; gemini-3.5-flash-lite
// is fast (1.5s) but blocked 9/32; qwen3.5-flash returned no JSON.
const DEFAULT_TAG_MODELS = ["x-ai/grok-4.3", "deepseek/deepseek-v4.1-flash", "google/gemini-2.5-flash"];

// Exactly one character and no player in shot: otherwise the model likes to
// invent a second figure (often the unseen player, drawn small). Which head
// count to push away depends on who that one character is.
const SOLO_NEGATIVE = { girl: ", 2girls, multiple girls, 1boy, 2boys, multiple boys, clone", boy: ", 1girl, 2girls, multiple girls, 2boys, multiple boys, clone" };
// The same through the player's eyes, where the player's own body is in the
// picture: only a second copy of the character is pushed away (a POV kiss or
// straddle otherwise came out as two of her, or as a collage).
const POV_SOLO_NEGATIVE = { girl: ", 2girls, multiple girls, clone", boy: ", 2boys, multiple boys, clone" };

// Most cards never file their people as character entries: the lead lives in
// a system entry, a custom entry or the greeting. So the cast is read off the
// whole card, once, and each person's body is kept apart from their clothes:
// the body never changes between turns, the clothes change with the story.
const CAST_SYSTEM = `You read an interactive-fiction card and write fixed appearance tags for its characters, for an anime illustration model (Illustrious SDXL, danbooru tags).
Return ONLY JSON: {"player":"unknown","cast":[{"name":"<name>","aliases":["<other names>"],"who":"<who they are, max 12 words>","tags":"<body tags>","outfit":"<outfit tags>","minor":false}]}
- player: the sex of the player's own character ("you"/{{user}}) when the card states or clearly implies it ("female", "male"), e.g. an otome card whose heroine is the player, or characters calling the player 哥哥/姐姐/怒那/欧巴; otherwise "unknown".
- cast: the people who can appear on screen with the player, most important first (the card's lead or heroine first). Include EVERY name listed under "Character entries"; add at most 8 others. Not the player ({{user}}, "you", the protagonist the player controls), not groups, factions, places, systems or rules.
- name: as the card writes it. aliases: nicknames, short forms, other-language or romanized forms the story may use.
- tags: 6-14 comma-separated English danbooru tags for the body only: head count first (1girl, 1boy or 1other), then hair color and style, eye color, skin, body type and size, species features (animal ears, horns, tail, wings), and permanent marks (glasses, scars, tattoos). No clothes, names, pose, expression or personality. When the card gives no appearance, infer a plausible consistent one from their role.
- outfit: 3-8 danbooru tags for what they usually wear.
- minor: true if the card gives an age under 18, or calls them a child, a minor, an elementary or middle school student, or a high school student without stating an adult age. Otherwise false. Draw everyone at their real age: for someone under 18 use plain age tags (child, young girl, young boy, teenage); never loli, lolita or shota.`;

const MOMENT_SYSTEM = `You turn the end of one interactive-story turn into an anime illustration prompt for an uncensored illustration model (danbooru tags).
Explicit adult content is allowed. When nudity or sex is visible, tag it plainly with standard danbooru tags (nude, breasts, nipples, penis, pussy, sex, cowgirl position, fellatio, footjob, cum, ...). Never soften or leave it out; never add nudity or sex the text does not show.
Draw the KEY MOMENT of this reply: the main visual event it is about (the sex act, the fight, the arrival, the reveal, the embrace), as far as it has gone by the end. If the reply winds down afterwards (an aftermath, someone leaving, the player left alone, a closing line of dialogue), still draw the main event with its characters in it. Draw an empty place only when no character is on screen anywhere in the reply.
Return ONLY JSON:
{"characters":[{"name":"<name>","look":"","outfit":"<tags>","outfit_lasting":false,"minor":false}],"player":"male","pov":false,"player_in_shot":false,"nsfw":false,"shot":"<shot>","action":"<tags>","scene":"<tags>","caption":"<one or two English sentences>"}
- characters: who is physically present and visible in the key moment, the most important first. Someone only mentioned, remembered, phoned or texted is not visible. The player ("you") is never listed, even when the story narrates the player's body. "Known characters" is a list to match against, not a list of who is here. Match a known character only when the reply uses that name or one of its other names, or clearly refers back to someone the reply already named that way ("she"/"他"). A person the reply calls by a name that is not in the list is a NEW character, even when their role sounds like a known one: give their look from how the reply describes them. Add someone new (including a monster or creature) only when the reply describes them as present; never invent extras.
- name: a known character's given name; for someone the reply never names, a short description in the reply's language (修女, the guard, 老板娘). look: "" for a known character; for anyone else, 6-12 danbooru tags starting with 1girl, 1boy or 1other, then hair, eyes, body (appearance only, reused in later scenes). minor: true if the text makes them under 18 or a child.
- outfit: what that character is wearing in the key moment, as 2-8 danbooru tags, ONLY from the text (the reply, or the player's line): clothes it names and their state (open shirt, skirt lift, pantyhose, torn clothes, bra, panties, towel, nude, naked apron...). "" when neither says anything about their clothes: the story already knows what they wear, so never guess.
- outfit_lasting: true when outfit is what they wear from now on: they got dressed or changed clothes, the text describes their clothes for the first time, or the player's line says what someone should wear or look like (then outfit is exactly that). false for a passing state of the same clothes (unbuttoned, pulled aside, taken off for sex, wet, torn).
- player: "male", "female" or "unknown": the player's sex, from the player's persona when given, otherwise from how the story addresses or describes "you" (pronouns; 怒那/欧尼/姐姐 = a woman is being addressed, 欧巴/哥哥/hyung = a man; body parts).
- pov: true when the camera should be the player's eyes: always when the player is having sex or any sexual contact with a character, and when the player is touching or kissing a character, or a character is right in front of the player's face.
- player_in_shot: true only for a non-sexual moment where pov is false and the picture must show the player's body beside a character to make sense (sleeping in their arms, carried by them). The player is then drawn as an anonymous figure of their sex. Never for sex.
- nsfw: true only when nipples, genitals or a sex act are visible in the key moment. Cleavage, tight or straining clothes, underwear glimpses, flirting, touching hands and kissing are not nsfw: tag them as they are and never undress anyone further than the text does. Then name the act itself first in action (handjob, footjob, paizuri, fellatio, sex, missionary, doggystyle, masturbation, ...). When the player's body takes part: a male player adds penis; a female player adds the partner's body parts instead.
- One camera, one frame: pick the single main act or pose the key moment shows and the one angle that shows it best. Never combine two views of it (a face close-up plus the body from behind, a cut-in of the mouth): the model then draws a collage.
- shot: one of close-up, upper body, cowboy shot, full body, from above, from side, from below, from behind.
- Two people: action says how they are together, never just that they are there: hug, kiss, holding hands, carrying, princess carry, face-to-face, looking at another, back-to-back, sitting together, fighting, walking away, ... Two people standing side by side looking at the viewer is never the key moment.
- caption: one or two plain English sentences saying exactly what the picture shows: each visible person described by their look instead of their name ("a silver-haired woman in a white haori"), what they are doing and to whom, where they are looking, and the place. Concrete and visual only; no names, story words or feelings beyond visible expressions. Sex is described as plainly as the tags. Through the player's eyes, write "the viewer".
- action: at most 10 tags; scene: at most 8 tags. Only what a camera can see: pose, hands, expression, gaze, held props, place, time of day, lighting. No sounds, smells, feelings, story words or names. Do not repeat known characters' hair or eye colors.`;

/** Why a turn got no picture. The first two are silent; the rest are shown. */
export type TurnImageFailure = "off" | "nothing" | "busy" | "timeout" | "unavailable";

export type IllustrateResult = { ok: true; embed: string } | { ok: false; reason: TurnImageFailure };


// ── Tagging ─────────────────────────────────────────────────────────

// Tagging always uses these models, never the player's chat model: their BYOK
// model may refuse explicit text, and the picture's quality shouldn't depend
// on it. Only the KEY follows the player: in OpenRouter BYOK mode the calls
// run on their own key, and any provider failure on it retries the same model
// on Yumina's key.
function tagModels(): string[] {
  const configured = env.PER_TURN_TAG_MODEL.split(",").map((m) => m.trim()).filter(Boolean);
  return configured.length ? configured : DEFAULT_TAG_MODELS;
}

/** Who a tagging call is logged against (usage_logs, endpoint "turn-image-tagging"),
 *  and the player's own OpenRouter key when they play on one. */
export interface UsageCtx { userId: string; sessionId: string; playerKey?: PlayerSideKey | null }

/** The provider itself failed (auth, balance, upstream, network) — as opposed
 *  to the model answering badly. Only these move a call to Yumina's key. */
class TagProviderError extends Error {}

const isTimeout = (message: string) => /timed? ?out|timeout|aborted/i.test(message);

async function askOnce(
  model: string, system: string, userText: MessageContent, ctx: UsageCtx,
  key: { apiKey: string; source: SideCallKeySource } = { apiKey: env.YUMINA_OPENROUTER_KEY, source: "platform" },
  maxTokens = 900,
): Promise<Record<string, unknown>> {
  const provider = createProvider("openrouter", key.apiKey);
  const started = Date.now();
  let text = "";
  let usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined;
  for await (const chunk of provider.generateStream({
    model,
    messages: [{ role: "system", content: system }, { role: "user", content: userText }],
    maxTokens,
    temperature: 0.3,
    responseFormat: { type: "json_object" },
    // Tagging needs no thinking, and grok-4.3 has no "minimal" level (it fell back to thinking).
    reasoningEffort: "none",
    singleAttempt: true,
    // Reading a whole card's cast (a long answer, once per card) takes longer than one turn's tags.
    signal: AbortSignal.timeout(maxTokens > 2000 ? CAST_TIMEOUT_MS : TAG_TIMEOUT_MS),
  })) {
    if (chunk.type === "text") text += chunk.content;
    if (chunk.type === "done" && chunk.usage) usage = chunk.usage;
    if (chunk.type === "error") throw new TagProviderError(chunk.content || "tagging failed");
  }
  if (usage) {
    void recordUsageLog({
      userId: ctx.userId, sessionId: ctx.sessionId, model, endpoint: "turn-image-tagging",
      promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, totalTokens: usage.totalTokens,
      apiKeyTier: sideCallTier(key.source), generationTimeMs: Date.now() - started, tokenMeasurement: "provider",
    }).catch(() => { /* logged inside */ });
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  // Say what came back instead, so a model that refuses or thinks out loud is visible in the log.
  if (start < 0 || end <= start) throw new Error(`${model} returned no JSON (${text.length} chars: ${JSON.stringify(text.slice(0, 120))})`);
  const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  // A refusal dressed as JSON: {"error":"I can't help with that."}
  if (typeof parsed.error === "string" && Object.keys(parsed).length === 1) throw new Error(`${model} refused`);
  return parsed;
}

/** One model, on the player's key first when they have one. */
async function askModel(model: string, system: string, userText: MessageContent, ctx: UsageCtx, maxTokens?: number): Promise<Record<string, unknown>> {
  const player = ctx.playerKey && !playerKeyDenied(ctx.playerKey, "chat") ? ctx.playerKey : null;
  if (player) {
    try {
      return await askOnce(model, system, userText, ctx, { apiKey: player.apiKey, source: "byok" }, maxTokens);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A bad answer or a timeout isn't the key's fault: the next model, as before.
      if (!(error instanceof TagProviderError) || isTimeout(message)) throw error;
      if (/\b(401|402|403)\b/.test(message)) markPlayerKeyDenied(player, "chat");
      console.warn(`[PerTurnImage] player key failed for ${model}; retrying on the platform key`);
    }
  }
  return askOnce(model, system, userText, ctx, undefined, maxTokens);
}

/** Models in order; the next starts when one fails, or — hedging a slow
 *  answer — when one has been quiet for HEDGE_MS. The first good answer wins. */
function askJson(system: string, userText: MessageContent, ctx: UsageCtx, maxTokens?: number): Promise<Record<string, unknown>> {
  const models = tagModels();
  const hedgeMs = (maxTokens ?? 0) > 2000 ? CAST_HEDGE_MS : HEDGE_MS;
  return new Promise((resolve, reject) => {
    let next = 0;
    let running = 0;
    let settled = false;
    let last: unknown;
    let hedge: ReturnType<typeof setTimeout> | undefined;
    const launch = () => {
      if (settled || next >= models.length) return;
      const model = models[next++]!;
      running++;
      clearTimeout(hedge);
      if (next < models.length) hedge = setTimeout(launch, hedgeMs);
      askModel(model, system, userText, ctx, maxTokens).then((result) => {
        if (settled) return;
        settled = true;
        clearTimeout(hedge);
        resolve(result);
      }, (error: unknown) => {
        running--;
        last = error;
        console.warn(`[PerTurnImage] tagger ${model} failed:`, error instanceof Error ? error.message : error);
        if (settled) return;
        if (next < models.length) launch();
        else if (running === 0) {
          settled = true;
          reject(last instanceof Error ? last : new Error("tagging failed"));
        }
      });
    };
    launch();
  });
}

// ── Characters ──────────────────────────────────────────────────────

interface Look {
  /** The body: head count, hair, eyes, build, species features. Never clothes. */
  tags: string;
  /** What they usually wear; a turn's own outfit replaces it. */
  outfit?: string;
  minor: boolean;
  /** The author's portrait of this character, if any: the character is drawn from it. */
  portrait?: string;
  /** Who they are, in a few words. */
  who?: string;
  /** Other names the story may use ("麻衣" for "樱岛麻衣", a romanized form). */
  aliases?: string[];
}

// Many cards keep character sheets as system entries named "X - 角色卡" /
// "X Character Card" rather than role "character".
const SHEET_NAME_RE = /\s*[-–—·:：]?\s*(角色卡|character\s*(card|sheet))\s*$/i;

// Cards split one person across entries: "樱岛麻衣 · 角色核心",
// "麻衣 · 恋人稳态 (affection 35-65)", "丰浜乃枫（触发）". Everything after a
// separator or bracket is a facet label, not part of the name.
const FACET_RE = /\s*[·•|｜:：]\s*.*$|\s+[-–—]\s+.*$|\s*[（(【[].*$/;

function personName(entryName: string): string {
  const name = entryName.replace(SHEET_NAME_RE, "").trim() || entryName;
  return name.replace(FACET_RE, "").trim() || name;
}

/** One entry per person, facets merged: otherwise the tagger invents a look
 *  for every facet that doesn't describe appearance, and they disagree. */
function characterEntries(world: WorldDefinition): { name: string; content: string; portrait?: string }[] {
  const people: { name: string; content: string; portrait?: string }[] = [];
  for (const e of world.entries ?? []) {
    if (!e.name || !e.content || !(e.role === "character" || SHEET_NAME_RE.test(e.name))) continue;
    const name = personName(e.name);
    const same = people.find((p) => sameName(p.name, name));
    if (!same) {
      people.push({ name, content: e.content, ...(e.portrait ? { portrait: e.portrait } : {}) });
      continue;
    }
    if (name.length > same.name.length) same.name = name;
    same.content += `\n\n${e.content}`;
    same.portrait ??= e.portrait;
  }
  return people.map((p) => ({ ...p, content: p.content.slice(0, 2000) }));
}

/** "Mai" / "Mai Sakurajima" / "麻衣" / "樱岛麻衣" are the same person. */
function sameName(a: string, b: string): boolean {
  const x = a.toLowerCase().trim();
  const y = b.toLowerCase().trim();
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  // Latin names need a whole word ("Mai" in "Mai Sakurajima", not "Ann" in "Joanna").
  if (/^[\x20-\x7e]+$/.test(short)) return short.length >= 3 && new RegExp(`\\b${short.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(long);
  return short.length >= 2 && long.includes(short);
}

function lookFor(looks: Record<string, Look>, name: string): Look | undefined {
  const key = lookKey(looks, name);
  return key === undefined ? undefined : looks[key];
}

/** The name a character is filed under in `looks`, by name or alias. */
function lookKey(looks: Record<string, Look>, name: string): string | undefined {
  if (Object.hasOwn(looks, name)) return name;
  const same = (a: string) => a.toLowerCase().trim() === name.toLowerCase().trim();
  return Object.keys(looks).find((k) => sameName(k, name) || (looks[k]!.aliases ?? []).some(same));
}

function toLook(raw: unknown): Look | null {
  if (typeof raw === "string" || Array.isArray(raw)) {
    const tags = str(raw);
    return tags ? { tags: normalizeTags(tags, false), minor: false } : null;
  }
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const tags = str(r.tags) || str(r.look);
  const minor = r.minor === true;
  if (!tags) return null;
  const outfit = str(r.outfit);
  const aliases = Array.isArray(r.aliases) ? r.aliases.filter((a): a is string => typeof a === "string" && a.trim() !== "") : [];
  const who = str(r.who);
  return {
    tags: normalizeTags(tags, minor), minor,
    ...(outfit ? { outfit } : {}), ...(aliases.length ? { aliases } : {}), ...(who ? { who: who.slice(0, 80) } : {}),
  };
}

// Where a card's people are described when it has no character entries.
// Appearance-heavy entries first; rules, style guides and state tables last.
const APPEARANCE_RE = /发|瞳|眼睛|身材|身高|穿着|外貌|长相|衣|裙|胸|hair|eyes|wearing|outfit|appearance|tall|body|breasts|skin|髪|服/i;
const CARD_TEXT_BUDGET = 14_000;

function cardText(world: WorldDefinition, people: { name: string; content: string }[]): string {
  const parts: string[] = [];
  let used = 0;
  const add = (label: string, text: string, cap: number) => {
    const body = text.trim().slice(0, cap);
    if (!body || used >= CARD_TEXT_BUDGET) return;
    const piece = `### ${label}\n${body}`.slice(0, CARD_TEXT_BUDGET - used);
    parts.push(piece);
    used += piece.length;
  };
  for (const p of people) add(`${p.name} (character entry)`, p.content, 2000);
  const rest = (world.entries ?? []).filter((e) => e.content && !(e.role === "character" || SHEET_NAME_RE.test(e.name ?? "")));
  const score = (e: { role?: string; content?: string }) =>
    (e.role === "greeting" ? 2 : 0) + ((e.content ?? "").match(new RegExp(APPEARANCE_RE, "gi"))?.length ?? 0);
  for (const e of [...rest].sort((a, b) => score(b) - score(a))) add(e.name || e.role || "entry", e.content ?? "", 2500);
  const description = (world as { description?: unknown }).description;
  if (typeof description === "string") add("card description", description, 1500);
  return parts.join("\n\n");
}

// Looks are a property of the card, so they are computed once and reused for
// every turn: that reuse is what keeps a character's face stable. Kept in
// Redis as well as memory: a card that doesn't say what its lead looks like
// got a fresh guess after every deploy (white hair one day, brown the next).
interface CardCast { looks: Record<string, Look>; player: "male" | "female" | "unknown" }
const MAX_CACHED_CARDS = 2000;
const CAST_RETRY_MS = 10 * 60_000;
const CAST_TTL_S = 180 * 86_400;
const cardLookCache = new Map<string, Promise<CardCast>>();
const castKey = (hash: string) => `turnimg:cast:${hash}`;

function cardLooks(world: WorldDefinition, ctx: UsageCtx): Promise<CardCast> {
  const chars = characterEntries(world);
  const text = cardText(world, chars);
  if (!text) return Promise.resolve({ looks: {}, player: "unknown" });
  const key = createHash("sha256").update(text).digest("hex");
  let looks = cardLookCache.get(key);
  if (!looks) {
    looks = (async () => {
      const saved = await redis?.get(castKey(key)).catch(() => null);
      if (saved) return JSON.parse(saved) as CardCast;
      const cast = await readCast(chars, text, ctx);
      void redis?.set(castKey(key), JSON.stringify(cast), "EX", CAST_TTL_S).catch(() => { /* memory copy still holds it */ });
      return cast;
    })();
    if (cardLookCache.size >= MAX_CACHED_CARDS) cardLookCache.delete(cardLookCache.keys().next().value!);
    cardLookCache.set(key, looks);
    // Every model refused or failed: the card has no cast for a while rather
    // than a full hedged retry in front of every turn.
    looks.catch(() => {
      cardLookCache.set(key, Promise.resolve({ looks: {}, player: "unknown" }));
      setTimeout(() => cardLookCache.delete(key), CAST_RETRY_MS).unref?.();
    });
  }
  return looks;
}

/** The tagger's reading of a card's cast, with authors' portraits read too. */
function readCast(chars: { name: string; content: string; portrait?: string }[], text: string, ctx: UsageCtx): Promise<CardCast> {
  const listed = chars.length ? `Character entries: ${chars.map((c) => c.name).join(", ")}\n\n` : "";
  return askJson(CAST_SYSTEM, listed + text, ctx, 2500).then(async (r) => {
    const out: Record<string, Look> = {};
    for (const raw of Array.isArray(r.cast) ? r.cast : []) {
      const name = str((raw as Record<string, unknown> | null)?.name);
      const look = toLook(raw);
      if (name && look && !lookFor(out, name)) out[name] = look;
    }
    // A portrait the author uploaded beats a look guessed from prose: the
    // image model follows tags read off that picture very closely.
    await Promise.all(chars.filter((c) => c.portrait).map(async (c) => {
      const read = await portraitTags(c.name, c.portrait!, ctx).catch((error) => {
        console.warn(`[PerTurnImage] portrait of ${c.name} unreadable:`, error instanceof Error ? error.message : error);
        return null;
      });
      if (!read) return;
      const key = Object.keys(out).find((k) => sameName(k, c.name)) ?? c.name;
      const prior = out[key];
      const minor = prior?.minor ?? false;
      out[key] = {
        ...prior, tags: normalizeTags(read.tags, minor), minor, portrait: c.portrait,
        ...(read.outfit ? { outfit: read.outfit } : {}), who: prior?.who ?? firstSentence(c.content),
      };
    }));
    const player = str(r.player).toLowerCase();
    return { looks: out, player: player === "male" || player === "female" ? player : "unknown" } as CardCast;
  });
}

// ── Portraits ──────────────────────────────────────────────────────

const PORTRAIT_SYSTEM = `You write fixed appearance tags for an anime illustration model (Illustrious SDXL) from a character's reference picture.
Return ONLY JSON: {"tags":"<tags>","outfit":"<tags>"}. tags: 8-14 comma-separated English danbooru tags for the body: count (1girl, 1boy, 1other), hair color and style, eye color, distinctive features (horns, wings, tail, animal ears, scars, glasses...), body type. outfit: 3-8 tags for the clothes worn. Visible traits only: no background, framing, pose or expression.`;
// Framing and pose words a tagger slips in; a look is reused in every scene.
const NOT_A_LOOK_RE = /^(full body|upper body|cowboy shot|portrait|close-?up|standing|sitting|looking at viewer|solo|.*background)$/i;
const ASSET_ID_RE = /^(?:@asset:)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const portraitCache = new Map<string, Promise<{ tags: string; outfit: string } | null>>();

/** The bytes of an entry's portrait: an @asset ref, a /cdn/key path, a raw storage key or an https URL. */
async function loadPortrait(ref: string): Promise<Buffer> {
  if (/^https?:\/\//i.test(ref)) {
    const r = await fetch(ref, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`portrait ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }
  let key: string | null = null;
  const assetId = ref.match(ASSET_ID_RE)?.[1];
  if (assetId) {
    const result = await db.execute(sql`
      SELECT url FROM assets WHERE id = ${assetId}
      UNION ALL
      SELECT url FROM user_assets WHERE id = ${assetId}
      LIMIT 1`);
    key = (result.rows as Array<{ url: string }>)[0]?.url ?? null;
  } else if (ref.startsWith("/cdn/key/")) {
    key = Buffer.from(ref.slice("/cdn/key/".length).split(/[?#]/)[0]!, "base64url").toString("utf8");
  } else {
    key = ref;
  }
  if (!key) throw new Error("portrait asset not found");
  return (await getObjectBuffer(key, { maxBytes: 20 * 1024 * 1024 })).buffer;
}

const styleCache = new Map<string, Promise<{ name: string; jpeg: Buffer }>>();

/** A portrait prepared as the reference a character is drawn from: the square
 *  from its top (head and shoulders). The adapter's image encoder sees a small
 *  centre square, so a whole tall portrait would be mostly legs and floor. */
function styleImage(ref: string): Promise<{ name: string; jpeg: Buffer }> {
  let image = styleCache.get(ref);
  if (!image) {
    image = (async () => {
      const source = sharp(await loadPortrait(ref)).rotate();
      const { width = 0, height = 0 } = await source.metadata();
      const side = Math.min(width, height);
      return {
        name: `yumina_portrait_${createHash("sha256").update(ref).digest("hex").slice(0, 16)}.jpg`,
        jpeg: await source.extract({ left: Math.floor((width - side) / 2), top: 0, width: side, height: side })
          .resize(768, 768, { withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer(),
      };
    })();
    styleCache.set(ref, image);
    image.catch(() => styleCache.delete(ref));
  }
  return image;
}

/** Body and outfit tags read off a portrait, once per portrait. */
function portraitTags(name: string, ref: string, ctx: UsageCtx): Promise<{ tags: string; outfit: string } | null> {
  let tags = portraitCache.get(ref);
  if (!tags) {
    tags = (async () => {
      const jpeg = await sharp(await loadPortrait(ref)).resize(768, 768, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
      const r = await askJson(PORTRAIT_SYSTEM, [
        { type: "text", text: `Character: ${name}` },
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${jpeg.toString("base64")}` } },
      ], ctx);
      const list = str(r.tags).split(",").map((t) => t.trim()).filter((t) => t && !NOT_A_LOOK_RE.test(t));
      return list.length ? { tags: list.join(", "), outfit: str(r.outfit) } : null;
    })();
    portraitCache.set(ref, tags);
    tags.catch(() => portraitCache.delete(ref));
  }
  return tags;
}

// What a session's pictures have established so far, kept for the session's
// whole life (Redis, so a deploy or another instance doesn't forget it):
//   looks   — NPCs the card never describes, from the reply that first drew them;
//   outfits — what each character wears now, once the story has said so
//             ("she's swallowed by her black sweater", "comes out in a red
//             sundress", the player insisting on the sweater). Without it a
//             turn that doesn't mention clothes fell back to the card's usual
//             outfit and the sweater turned into a T-shirt;
//   votes   — the player's sex as the turns have read it, majority wins: one
//             turn that only says "you" shouldn't flip an otome heroine into a boy.
interface SessionMemory {
  looks: Record<string, Look>;
  outfits: Record<string, string>;
  votes: { male: number; female: number };
}

const MAX_REMEMBERED_SESSIONS = 5000;
const SESSION_TTL_S = 120 * 86_400;
const sessionMemories = new Map<string, Promise<SessionMemory>>();
const sessionKey = (sessionId: string) => `turnimg:session:${sessionId}`;

function sessionMemory(sessionId: string): Promise<SessionMemory> {
  let memory = sessionMemories.get(sessionId);
  if (memory) {
    sessionMemories.delete(sessionId); // re-insert: most recent last
  } else {
    memory = (async () => {
      const raw = await redis?.get(sessionKey(sessionId)).catch(() => null);
      const saved = raw ? JSON.parse(raw) as Partial<SessionMemory> : {};
      return { looks: saved.looks ?? {}, outfits: saved.outfits ?? {}, votes: saved.votes ?? { male: 0, female: 0 } };
    })().catch(() => ({ looks: {}, outfits: {}, votes: { male: 0, female: 0 } }));
    if (sessionMemories.size >= MAX_REMEMBERED_SESSIONS) sessionMemories.delete(sessionMemories.keys().next().value!);
  }
  sessionMemories.set(sessionId, memory);
  return memory;
}

function saveSessionMemory(sessionId: string, memory: SessionMemory): void {
  void redis?.set(sessionKey(sessionId), JSON.stringify(memory), "EX", SESSION_TTL_S).catch(() => { /* memory copy still holds it */ });
}

// Poses that need the whole body in frame.
const BODY_POSE_RE = /straddl|on lap|sitting|lying|kneeling|on bed|spread legs|cowgirl|missionary|doggystyle|all fours|standing/i;

// Momentary states of whatever someone is wearing: drawn this turn on top of
// their outfit, never remembered as the outfit itself.
const BARE_RE = /\b(nude|naked|completely nude|topless and bottomless)\b/i;

/** What a character wears in this picture: the turn's own description when
 *  it is lasting, the remembered outfit with the turn's momentary state on
 *  top, or the card's usual clothes. */
export function outfitFor(turn: string, lasting: boolean, remembered: string | undefined, usual: string | undefined): string {
  if (lasting && turn) return turn;
  const base = remembered || usual || "";
  if (!turn) return base;
  if (BARE_RE.test(turn) || !base) return turn;
  return dedupeTags(`${base}, ${turn}`);
}

/** "Known characters (name: look)" for the tagger. Replies often say only
 *  "she"; with the look beside each name, a tail or a hair colour tells the
 *  tagger who she is (names alone: it picked the first name every time). */
function knownList(known: Record<string, Look>, remembered: Record<string, Look>): string {
  const all = { ...known, ...remembered };
  const names = Object.keys(all);
  if (names.length === 0) return "Known characters: (none)";
  return "Known characters (name / other names (who they are): look | usual outfit):\n" +
    names.map((n) => {
      const l = all[n]!;
      const aka = l.aliases?.length ? ` / ${l.aliases.join(" / ")}` : "";
      return `- ${n}${aka}${l.who ? ` (${l.who})` : ""}: ${l.tags}${l.outfit ? ` | ${l.outfit}` : ""}`;
    }).join("\n");
}

// Menus, state blocks and bookkeeping a card appends after the story: never
// part of the picture, and at the end of a reply they'd pose as its final moment.
const TRAILER_RE = /\n\s*(?:【\s*(?:去向|选项|回合结算|状态|choices|options|status)[^】]*】|<options>|大事记[:：]|chronicle\.push)[\s\S]*$/i;

/** The story text of a reply, split into what led up to the end and the end
 *  itself (its last ~450-900 characters, on paragraph or sentence boundaries). */
export function momentText(reply: string): { before: string; final: string } {
  let text = stripTurnImages(reply)
    .replace(/<options>[\s\S]*?<\/options>/gi, "")
    .replace(/\[[\w一-鿿]+:\s*[{[][\s\S]*?[}\]]\s*\]/g, "")
    .replace(/<speaker\s+id="([^"]*)">/gi, "$1: ")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/\[\/?[a-z]{1,4}\]/gi, "");
  // Menus and state panels trail the story: cut one only in the last third,
  // and keep the text as it was if cutting would leave nothing.
  const tailFrom = Math.floor(text.length * 2 / 3);
  const cut = text.slice(tailFrom).replace(TRAILER_RE, "");
  text = (text.slice(0, tailFrom) + cut).trim() || text.trim();
  const paragraphs = text.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  const final: string[] = [];
  let size = 0;
  while (paragraphs.length && (size < 450 || final.length === 0)) {
    const p = paragraphs.pop()!;
    final.unshift(p);
    size += p.length;
  }
  // One long paragraph (common in Chinese replies): its last sentences are the end.
  let end = final.join("\n");
  if (end.length > 900) {
    const from = end.length - 600;
    const boundary = end.slice(from).search(/[。！？.!?」”"]/);
    const at = boundary >= 0 ? from + boundary + 1 : from;
    paragraphs.push(end.slice(0, at));
    end = end.slice(at).trim();
  }
  return { before: paragraphs.join("\n").slice(-3500), final: end };
}

/** The first sentence of an entry, trimmed: "左边房间的魅魔。" tells the
 *  tagger that the woman in "the room on the left" is Luna. */
function firstSentence(text?: string): string | undefined {
  const line = text?.replace(/\s+/g, " ").trim().split(/(?<=[。！？.!?])/)[0]?.trim();
  return line ? line.slice(0, 80) : undefined;
}

// ── Prompt ──────────────────────────────────────────────────────────

/** Each look starts "1girl, …". One person: the look goes inline. Two: one
 *  head count leads the scene ("2girls", "1girl, 1boy") and each body follows
 *  the scene without its own head count. */
function castParts(looks: string[]): { count: string; inline: string; bodies: string[] } {
  if (looks.length <= 1) return { count: "", inline: looks[0] ?? "", bodies: [] };
  let girls = 0;
  let boys = 0;
  let others = 0;
  const bodies = looks.map((look) => {
    const tags = look.split(",").map((t) => t.trim()).filter(Boolean);
    if (tags.some((t) => /^1boy$/i.test(t))) boys++;
    else if (tags.some((t) => /^1other$/i.test(t))) others++;
    else girls++;
    return tags.join(", ");
  });
  const n = (k: number, one: string, many: string) => (k ? `${k}${k > 1 ? many : one}` : "");
  const count = [n(girls, "girl", "girls"), n(boys, "boy", "boys"), n(others, "other", "others")];
  return { count: count.filter(Boolean).join(", "), inline: "", bodies };
}

// Taggers return tag lists as a string or, just as often, an array.
function str(v: unknown): string {
  if (Array.isArray(v)) return v.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter(Boolean).join(", ");
  return typeof v === "string" ? v.trim() : "";
}

/** Each tag once, first place wins; a weighted group "(a, b:1.25)" stays whole. */
export function dedupeTags(prompt: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of prompt.split(/,(?![^(]*\))/)) {
    const tag = part.trim();
    const key = tag.toLowerCase().replace(/_/g, " ");
    if (!tag || (!tag.startsWith("(") && seen.has(key))) continue;
    seen.add(key);
    out.push(tag);
  }
  return out.join(", ");
}

// ── Rendering ───────────────────────────────────────────────────────

interface Recipe {
  checkpoint: string;
  loras: { file: string; weight: number; trigger: string }[];
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  /** Whether this host has the portrait adapter (Comfy Cloud does; our RunPod volumes don't). */
  styleReference: boolean;
}

function parseLoras(spec: string): Recipe["loras"] {
  return spec.split("|").map((s) => s.trim()).filter(Boolean).map((spec) => {
    const [file = "", weight = "1", ...trigger] = spec.split(":");
    return { file: file.trim(), weight: Number(weight) || 1, trigger: trigger.join(":").trim() };
  }).filter((l) => l.file);
}

const SPEED_LORA_RE = /dmd|lcm|lightning|hyper|turbo/i;

/** The configured checkpoint in the house style, unless an author's portrait
 *  sets the look instead (the house style LoRA would pull the picture back to
 *  its own look). With the DMD2 speed LoRA (prod's setting): 8 steps at
 *  cfg 1.8, never 1, where the sampler skips the negative prompt altogether
 *  (comic panels, undressing, a stray second figure all came back). Measured
 *  on 32 real turns (2026-09-29): this is the glossiest and fastest (~5s) of
 *  the recipes tried; 24-step cfg 5 kept negatives too but drew flatter. */
function primaryRecipe(houseStyle = true, fine = false): Recipe {
  const all = parseLoras(env.PER_TURN_IMAGE_LORAS).concat(houseStyle ? parseLoras(env.PER_TURN_IMAGE_STYLE_LORAS) : []);
  const fineSampling = fine && fineAvailable() ? env.PER_TURN_IMAGE_FINE_SAMPLING : "";
  // A fine picture runs the checkpoint's full schedule: no speed LoRA.
  const loras = fineSampling ? all.filter((l) => !SPEED_LORA_RE.test(l.file)) : all;
  const base = { checkpoint: env.PER_TURN_IMAGE_CHECKPOINT, loras, styleReference: true };
  const [steps, cfg, sampler, scheduler] = (fineSampling || env.PER_TURN_IMAGE_SAMPLING).split(":").map((s) => s.trim());
  if (steps && cfg && sampler && scheduler) return { ...base, steps: Number(steps), cfg: Number(cfg), sampler, scheduler };
  return loras.some((l) => SPEED_LORA_RE.test(l.file))
    ? { ...base, steps: 8, cfg: 1.8, sampler: "lcm", scheduler: "sgm_uniform" }
    : { ...base, steps: 24, cfg: 5, sampler: "euler_ancestral", scheduler: "normal" };
}

/** Whether the optional fine redraw is configured. */
export function fineAvailable(): boolean {
  return env.PER_TURN_IMAGE_FINE_SAMPLING.split(":").filter((s) => s.trim()).length === 4;
}

/** RunPod's volumes carry the same WAI checkpoint as plat_nsfw_anime but not
 *  the LoRAs, so the backup runs the plain model at its usual settings. */
function fallbackRecipe(): Recipe {
  return { checkpoint: "plat_nsfw_anime.safetensors", loras: [], steps: 24, cfg: 5, sampler: "euler_ancestral", scheduler: "normal", styleReference: false };
}

/** A scene prompt plus, for a two-person shot, each body (appended to it). */
export interface TurnPrompt {
  scene: string;
  /** The picture in a sentence or two of plain English, for models trained on natural captions. */
  caption?: string;
  /** Drawn on the checkpoint's full schedule (the player asked for a fine redraw). */
  fine?: boolean;
  bodies: string[];
  /** Portraits of the drawn characters, uploaded with the job. `slot` is the
   *  character's place in `bodies` (its half of a two-person frame); without
   *  bodies the one portrait covers the whole frame. */
  portraits?: { name: string; jpeg: Buffer; slot: number }[];
}

// Portrait reference: NoobAI's IP-Adapter (generic SDXL adapters barely move
// Illustrious), weighted evenly across the layers so the character's face,
// hair, horns and rendering carry over. "style transfer" mode was tried first
// and carried only the rendering: the character came out as the tags drew
// them, i.e. not like the portrait. The pose and scene still follow the prompt.
const PORTRAIT_ADAPTER = "noobIPAMARK1_mark1.safetensors";
const PORTRAIT_CLIP_VISION = "CLIP-ViT-bigG-14-laion2B-39B-b160k.safetensors";
const PORTRAIT_WEIGHT = 0.8;

export function buildTurnWorkflow(prompt: TurnPrompt | string, seed: number, negative: string, recipe?: Recipe): Record<string, unknown> {
  const { scene, bodies, portraits = [] } = typeof prompt === "string" ? { scene: prompt, bodies: [], portraits: [] } : prompt;
  const caption = typeof prompt === "string" || env.PER_TURN_IMAGE_CAPTION !== "1" ? "" : prompt.caption ?? "";
  recipe ??= primaryRecipe(portraits.length === 0, typeof prompt !== "string" && prompt.fine === true);
  const g: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {
    ckpt: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: recipe.checkpoint } },
  };
  let model: [string, number] = ["ckpt", 0];
  let clip: [string, number] = ["ckpt", 1];
  const triggers: string[] = [];
  recipe.loras.forEach((l, i) => {
    g[`lora${i}`] = { class_type: "LoraLoader", inputs: { model, clip, lora_name: l.file, strength_model: l.weight, strength_clip: l.weight } };
    model = [`lora${i}`, 0];
    clip = [`lora${i}`, 1];
    if (l.trigger) triggers.push(l.trigger);
  });
  // Two people share the one prompt, each body after the scene (the scene
  // already leads with their head count). Each body used to be prompted over
  // its own half of the frame instead: every half then drew a whole standing
  // figure, so a hug, a fight or a walk away came out as two people side by
  // side facing the camera. One prompt draws the interaction; hair and
  // outfits bleed between them a little, which reads far better.
  const people = bodies.map((body) => body.replace(/^\s*1(?:girl|boy|other)\s*,\s*/i, ""));
  Object.assign(g, {
    skip: { class_type: "CLIPSetLastLayer", inputs: { clip, stop_at_clip_layer: -2 } },
    // A caption, when the checkpoint reads them, goes after all the tags.
    pos: { class_type: "CLIPTextEncode", inputs: { clip: ["skip", 0], text: [scene, ...people, ...triggers, caption].filter(Boolean).join(", ") } },
    neg: { class_type: "CLIPTextEncode", inputs: { clip: ["skip", 0], text: negative } },
    latent: { class_type: "EmptyLatentImage", inputs: { width: 832, height: 1216, batch_size: 1 } },
  });
  const positive: [string, number] = ["pos", 0];
  const regionWidth = 480;
  if (portraits.length && recipe.styleReference) {
    Object.assign(g, {
      refcv: { class_type: "CLIPVisionLoader", inputs: { clip_name: PORTRAIT_CLIP_VISION } },
      refipa: { class_type: "IPAdapterModelLoader", inputs: { ipadapter_file: PORTRAIT_ADAPTER } },
    });
    // Two people: each portrait only over its own half, the same halves the
    // bodies are prompted in, or both would be drawn as the first one.
    const masked = bodies.length > 1;
    if (masked) g.refblank = { class_type: "SolidMask", inputs: { value: 0, width: 832, height: 1216 } };
    portraits.forEach((p, i) => {
      g[`refimg${i}`] = { class_type: "LoadImage", inputs: { image: p.name } };
      const inputs: Record<string, unknown> = {
        model, ipadapter: ["refipa", 0], image: [`refimg${i}`, 0], clip_vision: ["refcv", 0],
        weight: PORTRAIT_WEIGHT, weight_type: "linear", combine_embeds: "concat", start_at: 0, end_at: 1, embeds_scaling: "V only" };
      if (masked) {
        g[`refhalf${i}`] = { class_type: "SolidMask", inputs: { value: 1, width: regionWidth, height: 1216 } };
        g[`refmask${i}`] = { class_type: "MaskComposite", inputs: {
          destination: ["refblank", 0], source: [`refhalf${i}`, 0], x: p.slot === 0 ? 0 : 832 - regionWidth, y: 0, operation: "add" } };
        inputs.attn_mask = [`refmask${i}`, 0];
      }
      g[`ref${i}`] = { class_type: "IPAdapterAdvanced", inputs };
      model = [`ref${i}`, 0];
    });
  }
  Object.assign(g, {
    ks: { class_type: "KSampler", inputs: { model, positive, negative: ["neg", 0], latent_image: ["latent", 0],
      seed, steps: recipe.steps, cfg: recipe.cfg, sampler_name: recipe.sampler, scheduler: recipe.scheduler, denoise: 1 } },
    dec: { class_type: "VAEDecode", inputs: { samples: ["ks", 0], vae: ["ckpt", 2] } },
    save: { class_type: "SaveImage", inputs: { images: ["dec", 0], filename_prefix: "yumina_turn" } },
  });
  return g;
}

class RenderError extends Error {
  constructor(message: string, readonly kind: "busy" | "timeout" | "unavailable") { super(message); }
}

function classify(error: unknown): RenderError {
  if (error instanceof RenderError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/\b(429|queue|busy|capacity|rate limit|concurrenc)/i.test(message)) return new RenderError(message, "busy");
  if (/timed? ?out|timeout/i.test(message)) return new RenderError(message, "timeout");
  return new RenderError(message, "unavailable");
}

async function renderOn(provider: GenerationProvider, workflow: Record<string, unknown>, timeoutMs: number, portraits: TurnPrompt["portraits"] = []): Promise<Buffer> {
  const graph = JSON.stringify(workflow);
  const used = portraits.filter((p) => graph.includes(p.name));
  const images = used.length ? used.map((p) => ({ name: p.name, imageBase64: p.jpeg.toString("base64") })) : undefined;
  const jobId = await provider.submit({ workflow, ...(images ? { images } : {}) }, null);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    const status = await provider.getStatus(jobId);
    if (status.status === "failed" || status.status === "cancelled") throw new Error(status.error ?? "render failed");
    if (status.status !== "succeeded") continue;
    const out = status.outputs[0];
    if (out?.buffer) return out.buffer;
    if (out?.base64) return Buffer.from(out.base64, "base64");
    throw new Error("render returned no image");
  }
  await provider.cancel(jobId).catch(() => {});
  throw new RenderError(`render timed out after ${timeoutMs / 1000}s`, "timeout");
}

/** Our deployment first (dedicated GPUs, warm), then the shared Comfy Cloud
 *  pool, then RunPod: each takes over when the one before errors or times out. */
async function render(prompt: TurnPrompt, negative: string): Promise<{ png: Buffer; route: string }> {
  const seed = Math.floor(Math.random() * 2 ** 31);
  const routes: { provider: GenerationProvider; route: string; recipe?: Recipe; timeoutMs: number; style: boolean }[] = [];
  const deploy = getComfyDeployProvider();
  if (deploy) routes.push({ provider: deploy, route: "deployment", timeoutMs: DEPLOY_RENDER_TIMEOUT_MS, style: true });
  // The shared Comfy Cloud pool, not the 自定义生图 deployment: that build
  // carries the platform checkpoints, not this workflow's models.
  const primary = getTurnImagePoolProvider();
  if (primary) routes.push({ provider: primary, route: primary.name, timeoutMs: PRIMARY_RENDER_TIMEOUT_MS, style: true });
  const fallback = getFallbackGenerationProvider();
  if (fallback) routes.push({ provider: fallback, route: fallback.name, recipe: fallbackRecipe(), timeoutMs: FALLBACK_RENDER_TIMEOUT_MS, style: false });

  const failures: RenderError[] = [];
  for (const [i, r] of routes.entries()) {
    try {
      const workflow = buildTurnWorkflow(prompt, seed, negative, r.recipe);
      return { png: await renderOn(r.provider, workflow, r.timeoutMs, r.style ? prompt.portraits : undefined), route: r.route };
    } catch (error) {
      const failure = classify(error);
      failures.push(failure);
      const next = routes[i + 1];
      console.warn(`[PerTurnImage] ${r.route} failed, ${next ? "trying " + next.route : "no backup"}:`, failure.message);
    }
  }
  // Busy beats timeout beats unavailable: it's the one worth retrying soonest.
  const kind = failures.some((f) => f.kind === "busy") ? "busy" : failures.some((f) => f.kind === "timeout") ? "timeout" : "unavailable";
  throw new RenderError(failures.map((f) => f.message).join(" | ") || "no generation provider", kind);
}

// ── Embeds ──────────────────────────────────────────────────────────

const EMBED_RE = /\n*\[\s*image:\s*\/cdn\/key\/([A-Za-z0-9_-]+)[^\]\n]*\]/g;

/** Removes per-turn illustration embeds. The model sees earlier replies (with
 *  their embeds) in history and sometimes copies one into its new reply. */
export function stripTurnImages(text: string): string {
  return text.replace(EMBED_RE, (match, b64: string) => {
    try {
      return Buffer.from(b64, "base64url").toString("utf8").includes("/turn-images/") ? "" : match;
    } catch {
      return match;
    }
  });
}

// ── Entry point ─────────────────────────────────────────────────────

export interface IllustrateArgs {
  world: WorldDefinition;
  sessionId: string;
  playerText: string;
  replyText: string;
  /** What the player asked of this picture when redrawing it ("keep the black sweater", "closer"). */
  note?: string;
  /** Redraw on the full schedule (sharper, slower). */
  fine?: boolean;
  userId: string;
  /** True when drawn automatically after a turn (honours the player's switch). */
  auto: boolean;
  /** The player's own OpenRouter key (OpenRouter BYOK mode): tagging runs on it. */
  playerKey?: string | null;
  /** The player's persona as the chat model sees it, if they have one. */
  playerPersona?: string | null;
}

const DEFAULT_QUALITY = "masterpiece, best quality, amazing quality, very aesthetic, absurdres";
const quality = () => env.PER_TURN_IMAGE_QUALITY || DEFAULT_QUALITY;

/** What one turn's picture should show, or why it shows nothing. */
export type TurnPlan =
  | { draw: true; prompt: TurnPrompt; negative: string; shown: string[]; nsfw: boolean; pov: boolean; player: string }
  | { draw: false; shown: string[] };

export interface PlanArgs {
  world: WorldDefinition;
  sessionId: string;
  playerText: string;
  replyText: string;
  note?: string;
  playerPersona?: string | null;
  ctx: UsageCtx;
}

/** Tags the final moment of a reply and builds the prompt that draws it. */
export async function planTurn(args: PlanArgs): Promise<TurnPlan> {
  const { ctx } = args;
  const card = await cardLooks(args.world, ctx).catch((error): CardCast => {
    console.warn("[PerTurnImage] cast unreadable:", error instanceof Error ? error.message : error);
    return { looks: {}, player: "unknown" };
  });
  const known = card.looks;
  const memory = await sessionMemory(args.sessionId);
  const remembered = memory.looks;
  const { before, final } = momentText(args.replyText);
  const moment = await askJson(MOMENT_SYSTEM, [
    knownList(known, remembered),
    card.player !== "unknown" ? `The player ("you") is ${card.player}, per the card.` : "",
    args.playerPersona ? `The player's own persona (this is "you"):\n${args.playerPersona.slice(0, 800)}` : "",
    `Player's line: ${args.playerText.slice(0, 800)}`,
    // A redraw request beats the reply wherever they disagree (framing, who is
    // in it, clothes); clothes it asks for are theirs from now on.
    args.note ? `The player asks this picture to be redrawn like this, which overrides the reply where they differ (clothes it names are lasting): ${args.note.slice(0, 200)}` : "",
    before ? `Reply:\n${before}` : "",
    `${before ? "Reply, continued to its end" : "Reply"}:\n${final}`,
    // Room for the caption too: at 900 a long scene's JSON could be cut off.
  ].filter(Boolean).join("\n\n"), ctx, 1400);

  const nsfw = moment.nsfw === true;
  // A sex act always puts the camera in the player's eyes: a figure standing
  // in for the player beside the partner turns into a stray head or body.
  const pov = moment.pov === true || (nsfw && Array.isArray(moment.characters) && moment.characters.length > 0);
  // The card knows who the player is better than one turn's prose does, and
  // a session keeps the first sex a turn made clear.
  const said = str(moment.player).toLowerCase();
  const votes = memory.votes;
  if (said === "male" || said === "female") votes[said]++;
  const majority = votes.female > votes.male ? "female" : votes.male > votes.female ? "male" : said;
  const player = card.player !== "unknown" ? card.player : majority;
  const listed = Array.isArray(moment.characters) ? moment.characters : [];
  const shown: string[] = [];
  // Each person's look and what they wear in this picture.
  const cast: { look: Look; outfit: string }[] = [];
  for (const raw of listed) {
    const entry = typeof raw === "string" ? { name: raw } : (raw ?? {}) as Record<string, unknown>;
    // Someone the reply never names ("a nun at the door") is still drawn: an
    // empty name used to leave the scene empty.
    const name = str(entry.name) || str(entry.look).split(",").slice(0, 2).join(" ").trim() || "someone";
    let key = lookKey(known, name) ?? lookKey(remembered, name);
    let look = key === undefined ? undefined : known[key] ?? remembered[key];
    if (!look) {
      // Someone the card doesn't know (the story made her up this turn). With
      // no look from the tagger she is still drawn as herself, from her
      // clothes; standing in the card's lead would draw the wrong person.
      look = toLook({ tags: entry.look, minor: entry.minor })
        ?? { tags: normalizeTags(str(entry.outfit) || "1girl", entry.minor === true).split(", ").filter((t) => /^(1girl|1boy|1other|adult|child|young girl|young boy|teenage)$/i.test(t)).join(", "), minor: entry.minor === true };
      if (name !== "__proto__") remembered[name] = look;
    }
    // The turn may say someone is a minor that the card didn't: never the other way round.
    if (look && entry.minor === true && !look.minor) look = { ...look, minor: true, tags: normalizeTags(look.tags, true) };
    if (look && !cast.some((c) => c.look === look)) {
      const worn = str(entry.outfit);
      const filed = key ?? name;
      // The first clothes the story describes are theirs from then on (the
      // tagger rarely says so), unless that first mention is them undressed.
      const lasting = worn !== "" && !BARE_RE.test(worn) && (entry.outfit_lasting === true || !memory.outfits[filed]);
      if (lasting && filed !== "__proto__") memory.outfits[filed] = worn;
      cast.push({ look, outfit: outfitFor(worn, lasting, memory.outfits[filed], look.outfit) });
      shown.push(name);
    }
  }
  saveSessionMemory(args.sessionId, memory);
  // Explicit if the tagger says so OR its own tags are sexual: a tagger that
  // drops the flag but still writes "nude" is not trusted with the flag.
  const explicit = isExplicitMoment(nsfw, str(moment.action), str(moment.scene));
  // The player is intimate with someone the tagger didn't name: that is the
  // card's lead. An empty list otherwise means an empty scene.
  const leads = Object.entries(known);
  if (cast.length === 0 && leads.length > 0 && explicit && pov) {
    const [leadName, lead] = leads[0]!;
    cast.push({ look: lead, outfit: outfitFor("", false, memory.outfits[leadName], lead.outfit) });
    shown.push(leadName);
  }
  // The text models refuse sexual content about minors, but the image model
  // is open-weight and refuses nothing, so this one check lives here. It is
  // silent (no picture, no message) and only for explicit moments: ordinary
  // scenes with the same characters are drawn as usual, at their own age.
  const anyMinor = cast.some((c) => c.look.minor);
  if (anyMinor && (explicit || isExplicitMoment(false, ...cast.map((c) => c.outfit)))) return { draw: false, shown };

  const people = cast.length > 0 || pov;
  // Up to three people share the prompt (a campfire with the whole party);
  // past that SDXL drops or merges them.
  const drawn = cast.slice(0, 3);
  const minorShown = drawn.some((c) => c.look.minor);
  // A minor on screen: nothing sexual or suggestive reaches the prompt.
  const clean = (tags: string) => (minorShown ? stripExplicit(tags) : tags);
  // The body never changes; the clothes are the ones the story last put them in.
  const bodies = drawn.map((c) => [c.look.tags, clean(c.outfit)].filter(Boolean).join(", "));
  // The player beside one character (asleep in his arms): an anonymous figure
  // of the player's sex takes the second half of the frame.
  const playerShown = moment.player_in_shot === true && !pov && !nsfw && drawn.length === 1 && (player === "female" || player === "male");
  if (playerShown) bodies.push(player === "female" ? "1girl, adult" : "1boy, adult");
  // An empty scene's "action" describes the unseen player.
  const action = people ? clean(str(moment.action)) : "";
  // A close-up of a whole-body pose (straddling, lying, kneeling) is two
  // views of it, which the model draws as a collage: frame the upper body.
  const shot = /close-?up/i.test(str(moment.shot)) && BODY_POSE_RE.test(action) ? "upper body" : str(moment.shot);
  const parts = castParts(bodies);
  const femalePov = pov && player === "female";
  // Illustrious draws a lone "1boy" as a girl often enough to notice.
  const soloMale = drawn.length === 1 && /(^|,\s*)1boy(\s*,|$)/.test(parts.inline) ? "male focus" : "";
  const scene = dedupeTags([quality(), nsfw && people ? "nsfw, explicit" : "",
    nsfw && action ? `(${action}:1.25)` : "",
    drawn.length ? parts.count || parts.inline : pov ? "" : "no humans, scenery", soloMale, pov ? (femalePov ? "pov, female pov" : "pov") : "",
    people ? shot : "", nsfw ? "" : action, clean(str(moment.scene))].filter(Boolean).join(", "));
  // Each of the first two drawn characters with a portrait is drawn from it
  // (in their own half of a group frame).
  const portraits = (await Promise.all(drawn.slice(0, 2).map(async (c, slot) => {
    if (!c.look.portrait) return null;
    const image = await styleImage(c.look.portrait).catch((error) => {
      console.warn("[PerTurnImage] portrait unreadable:", error instanceof Error ? error.message : error);
      return null;
    });
    return image ? { ...image, slot } : null;
  }))).filter((p) => p !== null);
  const caption = minorShown ? "" : str(moment.caption).slice(0, 400);
  const prompt: TurnPrompt = { scene, bodies: parts.bodies, ...(caption ? { caption } : {}), ...(portraits.length ? { portraits } : {}) };
  const solo = drawn.length === 1 && !playerShown;
  const sex = soloMale || /(^|,\s*)1boy(\s*,|$)/.test(parts.inline) ? "boy" : "girl";
  const negative = negativeFor(minorShown, !explicit, env.PER_TURN_IMAGE_NEGATIVE || undefined) + (solo ? (pov ? POV_SOLO_NEGATIVE : SOLO_NEGATIVE)[sex] : "");
  return { draw: true, prompt, negative, shown, nsfw: explicit, pov, player };
}

export async function illustrateTurn(args: IllustrateArgs): Promise<IllustrateResult> {
  if (!perTurnImagesEnabled()) return { ok: false, reason: "unavailable" };
  if (!args.replyText.trim()) return { ok: false, reason: "nothing" };
  const started = Date.now();
  try {
    // Experimental opt-in first: a player who hasn't turned the feature on is never drawn for.
    const prefs = await turnImagePrefs(args.userId);
    if (!prefs.optedIn || (args.auto && !prefs.auto)) return { ok: false, reason: "off" };
    const ctx: UsageCtx = {
      userId: args.userId, sessionId: args.sessionId,
      playerKey: args.playerKey ? { userId: args.userId, apiKey: args.playerKey } : null,
    };
    const plan = await planTurn({
      world: args.world, sessionId: args.sessionId, playerText: args.playerText, replyText: args.replyText, note: args.note, playerPersona: args.playerPersona, ctx,
    });
    if (!plan.draw) {
      console.log(`[PerTurnImage] not drawn (${plan.shown.join("/")})`);
      return { ok: false, reason: "nothing" };
    }
    const { prompt, negative, shown, nsfw, pov } = plan;

    const tagged = Date.now();
    if (args.fine) prompt.fine = true;
    const { png, route } = await render(prompt, negative);
    const jpeg = await sharp(png).jpeg({ quality: 86 }).toBuffer();
    const key = `users/${args.userId}/turn-images/${randomUUID()}.jpg`;
    await putObject(key, jpeg, "image/jpeg");
    console.log(`[PerTurnImage] tags ${tagged - started}ms, render+store ${Date.now() - tagged}ms via ${route}; ` +
      `shown=${shown.join("/") || "-"} nsfw=${nsfw} pov=${pov} player=${plan.player || "-"} portraits=${prompt.portraits?.length ?? 0} ` +
      `prompt=${[prompt.scene, ...prompt.bodies].join(" | ").slice(0, 500)}`);
    // Same-origin path: the embed parser refuses anything but https / @asset / /cdn.
    return { ok: true, embed: `[image:/cdn/key/${Buffer.from(key).toString("base64url")}|alt=${(shown[0] ?? "scene").replace(/[|\]]/g, "")}]` };
  } catch (error) {
    const reason = error instanceof RenderError ? error.kind : "unavailable";
    console.warn(`[PerTurnImage] failed (${reason}) after ${Date.now() - started}ms:`, error instanceof Error ? error.message : error);
    return { ok: false, reason };
  }
}
