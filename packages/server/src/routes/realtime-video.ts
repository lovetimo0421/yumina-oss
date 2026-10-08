/**
 * Realtime video (prototype) — fal H3 Max Director driven by the chat.
 *
 * ALL  /api/realtime-video/fal-proxy  authenticated passthrough so the browser can open a
 *                                     Director WebRTC session without seeing FAL_KEY
 * POST /api/realtime-video/opening    { sessionId, style, beats, greeting } → { cast, beats[] }
 * POST /api/realtime-video/shot       { sessionId, style, cast, userText, aiText, prevShot } → { shot }
 * POST /api/realtime-video/clip       { model, prompt, frame?, guide?, sessionId? } → video/mp4
 *                                     one ~5 s Comfy Cloud clip. H3 continues from `guide` (the previous clip's
 *                                     output path, returned as X-Clip-Ref) and uses the card's character portraits.
 *
 * POST /api/realtime-video/fal-meter { sessionId, run, tick } → bills fal stream seconds
 *
 * The LLM here is only a director: it turns the card's own reply into a camera
 * direction. The story text players read is still the card's normal reply.
 *
 * Experimental and paid (lib/realtime-video/film-billing.ts): every route needs the server
 * flag and the player's own switch, and every spend is charged in mushies.
 */

import { createHash } from "node:crypto";
import { Hono } from "hono";
import { and, desc, eq, lt } from "drizzle-orm";
import { createRouteHandler } from "@fal-ai/server-proxy/hono";
import { authMiddleware } from "../middleware/auth.js";
import { env } from "../lib/env.js";
import { db, readOwn } from "../db/index.js";
import { messages, playSessions, user, worlds } from "../db/schema.js";
import type { AppEnv } from "../lib/types.js";
import { resolveImageCdn } from "../lib/cdn-url.js";
import { buildClipGraph, buildH3Graph, CLIP_MODELS, type ClipModel } from "../lib/realtime-video/clip-workflows.js";
import {
  canAffordFilm, CLIP_ESTIMATE_CREDITS, TURN_CLIP_ESTIMATE_CREDITS, TURN_SHOT_ESTIMATE_CREDITS, COMFY_USD_PER_GPU_SECOND, FAL_MIN_SECONDS, FAL_USD_PER_SECOND,
  FILM_MARKUP, filmOptedIn, realtimeFilmEnabled, takeFilmCredits, type FilmEndpoint,
} from "../lib/realtime-video/film-billing.js";
import { providerCostUsdToCredits } from "../lib/provider-cost.js";
import { recordUsageLog } from "../lib/usage-log.js";
import {
  bindFilmAssets, DEPLOY_REF_RE, filmDeployWarm, maybeWakeFilmDeploy, noteFilmDeployDone, noteFilmDeployFailed,
  filmDeployEnabled, poolClipEnded, poolClipStarted, renderFilmClip, uploadFilmAsset,
} from "../lib/realtime-video/film-deploy.js";
import {
  getFilmState, getTurnClipJob, setFilmState, setTurnClipJob, stripTurnVideos, TURN_CLIP_BEAT_MS, TURN_VIDEO_DIR, turnClipLost, turnFilmNotesKey,
  turnVideoEmbed, turnVideoKeyOf, turnVideoPath, type FilmState, type TurnClipFailure, type TurnClipJob, type TurnClipProgress,
} from "../lib/realtime-video/turn-clip.js";
import { stripTurnImages } from "../lib/per-turn-image/illustrate.js";
import { messageContentUpdate } from "../lib/message-edit.js";
import { getObjectBuffer, putObject } from "../lib/s3.js";
import { acquireConcurrency, releaseConcurrency } from "../middleware/rate-limit.js";

const realtimeVideoRoutes = new Hono<AppEnv>();
realtimeVideoRoutes.use("/realtime-video/*", authMiddleware);
realtimeVideoRoutes.use("/realtime-video/*", async (c, next) => {
  if (!realtimeFilmEnabled()) return c.json({ error: "Scene video is not available", code: "FILM_UNAVAILABLE" }, 404);
  if (!(await filmOptedIn(c.get("user").id))) return c.json({ error: "Turn on scene video first", code: "FILM_OPT_IN_REQUIRED" }, 403);
  await next();
});
const NO_CREDITS = { error: "Not enough mushies for scene video", code: "INSUFFICIENT_CREDITS" } as const;

/** Who pays for a director call, and what it has cost so far. */
type FilmBill = { userId: string; sessionId?: string | null; credits: number };

/** Log one film spend (usage funnel, endpoints registered in usage-log.ts) and take its mushies:
 *  provider cost × FILM_MARKUP, for every player (all of it is platform money). */
async function chargeFilm(o: {
  userId: string; sessionId?: string | null; endpoint: FilmEndpoint; model: string;
  costUsd: number; referenceId: string; description: string; ms?: number;
  promptTokens?: number; completionTokens?: number;
}): Promise<number> {
  await recordUsageLog({
    userId: o.userId,
    sessionId: o.sessionId ?? null,
    model: o.model,
    promptTokens: o.promptTokens ?? 0,
    completionTokens: o.completionTokens ?? 0,
    totalTokens: (o.promptTokens ?? 0) + (o.completionTokens ?? 0),
    endpoint: o.endpoint,
    apiKeyTier: "regular",
    generationTimeMs: o.ms ?? 0,
    providerCostUsd: Math.max(0, o.costUsd).toFixed(12),
  }).catch((e) => console.error("[Film] usage log failed:", e instanceof Error ? e.message : e));
  return takeFilmCredits(o.userId, providerCostUsdToCredits(Math.max(0, o.costUsd), FILM_MARKUP), o.referenceId, o.description);
}

// Picked by the 2026-10-03 experiment: best score and ~1.5 s per shot (vs 6–18 s for 3.8 Flash).
const DIRECTOR_MODEL = process.env.REALTIME_DIRECTOR_MODEL || "google/gemini-3.1-flash-lite";
// The opening breakdown is one long structured answer; this model keeps its JSON valid.
const OPENING_MODEL = process.env.REALTIME_OPENING_MODEL || "google/gemini-3.1-flash-lite";

/** Director models a player may pick (OpenRouter ids); anything else falls back to the default. */
const DIRECTOR_MODELS = new Set([
  "google/gemini-3.8-flash", "anthropic/claude-sonnet-5.5", "deepseek/deepseek-v4.1-flash",
  "x-ai/grok-4.7", "z-ai/glm-5.3", "google/gemini-3.1-flash-lite",
]);
const pickModel = (m: unknown, fallback: string) => (typeof m === "string" && DIRECTOR_MODELS.has(m) ? m : fallback);

type SceneCard = { id: string; sheet: string };

const STYLES: Record<string, string> = {
  source: "Visual style: keep exactly the art style, character designs and colour palette of the first frame.",
  live: "Visual style: live-action Japanese film, photorealistic, shot on 35mm, real actors, natural skin texture, muted desaturated colour grade, cinematic depth of field. Not animation, not illustration.",
  anime: "Visual style: high-quality anime film, detailed backgrounds, cinematic lighting.",
  painted: "Visual style: dark semi-realistic painted illustration, mature realistic proportions, painterly shading, muted palette, cinematic lighting. Not chibi, not moe.",
};

const falProxy = createRouteHandler({ resolveApiKey: async () => process.env.FAL_KEY });
realtimeVideoRoutes.all("/realtime-video/fal-proxy", async (c) => {
  if (!process.env.FAL_KEY) return c.json({ error: "FAL_KEY not configured" }, 503);
  if (!(await canAffordFilm(c.get("user").id, 1))) return c.json(NO_CREDITS, 402);
  // The proxied fetch Response has immutable headers; our middleware sets headers afterwards.
  const res = await falProxy(c);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: new Headers(res.headers) });
});

async function loadWorldSchema(userId: string, sessionId: string) {
  const db = await readOwn(userId);
  const [row] = await db
    .select({ schema: worlds.schema, name: worlds.name, thumbnailUrl: worlds.thumbnailUrl })
    .from(playSessions)
    .innerJoin(worlds, eq(worlds.id, playSessions.worldId))
    .where(and(eq(playSessions.id, sessionId), eq(playSessions.userId, userId)))
    .limit(1);
  return row ?? null;
}

type Entry = { name?: string; role?: string; content?: string; enabled?: boolean };

/** The card's character entries (and any entry describing someone's appearance), for looks. */
function characterNotes(schema: unknown): string {
  const entries = ((schema as { entries?: Entry[] }).entries ?? []).filter((e) => e.enabled !== false);
  const characters = entries.filter((e) => e.role === "character" || /外貌|appearance/i.test(e.content ?? ""));
  return characters.map((e) => `## ${e.name}\n${(e.content ?? "").slice(0, 1600)}`).join("\n\n").slice(0, 14000);
}

type UserContent = string | ({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } })[];

async function callDirector(system: string, user: UserContent, maxTokens: number, model = DIRECTOR_MODEL, bill?: FilmBill) {
  const run = async () => {
    const started = Date.now();
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.YUMINA_OPENROUTER_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        response_format: { type: "json_object" },
        temperature: 0.7,
        max_tokens: maxTokens,
        usage: { include: true },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const data = (await r.json()) as { choices?: { message?: { content?: string } }[]; usage?: { cost?: number; prompt_tokens?: number; completion_tokens?: number } };
    if (!r.ok) throw new Error(JSON.stringify(data).slice(0, 400));
    // Every answer costs, parsed or not.
    if (bill) {
      bill.credits += await chargeFilm({
        userId: bill.userId, sessionId: bill.sessionId, endpoint: "film-director", model,
        costUsd: typeof data.usage?.cost === "number" ? data.usage.cost : 0,
        promptTokens: data.usage?.prompt_tokens, completionTokens: data.usage?.completion_tokens,
        referenceId: `film-director:${crypto.randomUUID()}`, description: "Scene video — director", ms: Date.now() - started,
      });
    }
    const text = data.choices?.[0]?.message?.content ?? "";
    const m = text.match(/\{[\s\S]*\}/);
    const raw = m ? m[0] : text;
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // Models sometimes leave a trailing comma or a stray quote inside Chinese text.
      return JSON.parse(raw.replace(/,\s*([}\]])/g, "$1").replace(/[“”]/g, "\\\"")) as Record<string, unknown>;
    }
  };
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await run();
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

/** How a shot is written. "temporal" is the default (best judged 2026-10-02); the others exist for quality experiments. */
const SHOT_FORMATS: Record<string, string> = {
  full: `- Then: who is on screen (paste their cast description verbatim), what they do, expression, framing and camera move, location, lighting, sound (ambience or one short spoken line in Japanese).
- 60–120 words, English.`,
  short: `- Then one or two plain sentences: who is on screen (name + 3-5 words of their look), the single action, the framing.
- 25–45 words, English.`,
  lock: `- Then: who is on screen, pasting their cast description EXACTLY word for word every time (never paraphrase it, never drop its signature detail), what they do, expression, framing and camera move, location, lighting, sound.
- 60–120 words, English.`,
  temporal: `- Then: who is on screen (paste their cast description verbatim), then the action as a time sequence of 2-4 beats ("First … Then … Finally …"), each with a concrete body movement, expression change and camera move; location, lighting, and sound (ambience, or a spoken line woven into the action as it is said).
- 90–150 words, English, literal and physical, no metaphors.`,
  structured: `- Then exactly these labelled parts on one line each: SUBJECT (cast description verbatim) | ACTION | EXPRESSION | CAMERA (framing + move) | SETTING | LIGHT | SOUND.
- 60–110 words, English.`,
  /** One ~5 s shot of a message's film (the script mode of directTurn). */
  shot: `- Then: who is on screen, each named with their cast description pasted verbatim (never just "a girl" for someone in the cast), the one action of this shot with its expression, the framing and camera angle, the place and light, and its sound (ambience, or the one line spoken in it).
- 40–80 words, English, literal and physical, no metaphors. About five seconds of film: one action, not a sequence.`,
};

/** The sentence every shot opens with. "source" without a first frame to copy has nothing to keep,
 *  so it uses the cover's look written out (`look`, from describeLook) when there is one. */
function styleSentence(style = "live", look?: string | null): string {
  if (style === "source" && look) return `Visual style: ${look}`;
  return STYLES[style] ?? STYLES.live ?? "";
}

const SHOT_RULES = (style: string, format = "temporal", look?: string | null) => `Shot rules:
- Every shot starts with this exact sentence: ${styleSentence(style, look)}
${SHOT_FORMATS[format] ?? SHOT_FORMATS.temporal}
- Only what can be seen and heard. No inner thoughts.
- The player ("you") is always first-person POV; never draw the player as a person.
- Keep location and lighting continuous unless the story clearly moves.
- No readable text, captions or titles on screen.
- Every spoken line is Japanese, written in Japanese inside 「」 (e.g. she whispers in Japanese: 「逃げて」). Never write dialogue in English or any other language.`;

/** The stream speaks whatever language the prompt quotes, and directors still slip English lines
 *  in; every shot ends by pinning the voice to Japanese. */
const VOICE = "All dialogue is spoken in Japanese only, never English. Spoken lines are heard, never shown: no subtitles, captions or on-screen text.";
export function withVoice(shot: string): string {
  return shot.includes(VOICE) ? shot : `${shot.trim()} ${VOICE}`;
}

/** A quoted line with Latin words in it: dialogue the video model would say in that language. */
const FOREIGN_LINE = /"[^"]*[A-Za-z]{3,}[^"]*"|“[^”]*[A-Za-z]{3,}[^”]*”/;
const japaneseShots = new Map<string, string>();
/** Comfy's H3 reads quoted lines as written (fal translates them on its own), and a card can write
 *  its own shots with English lines in them: put every quoted line into Japanese before rendering. */
async function japaneseDialogue(shot: string, bill: FilmBill): Promise<string> {
  if (!FOREIGN_LINE.test(shot)) return shot;
  const known = japaneseShots.get(shot);
  if (known) return known;
  const out = await callDirector(
    `Rewrite this video shot direction so that every quoted spoken line becomes natural Japanese written in 「」. Change nothing else: keep every other word exactly as it is. Output JSON only: {"shot":"…"}`,
    shot, 3000, DIRECTOR_MODEL, bill,
  ).catch(() => null);
  const fixed = typeof out?.shot === "string" && out.shot.trim() ? out.shot.trim() : shot;
  if (japaneseShots.size > 200) japaneseShots.clear();
  japaneseShots.set(shot, fixed);
  return fixed;
}

/** Directors often name a person without their look, and the video model then reinvents them
 *  (a boy turns into a girl, a uniform changes colour). Paste the look after the first mention. */
export function pinLooks(shot: string, cast: { name: string; look: string }[]): string {
  let out = shot;
  for (const p of cast) {
    if (!p?.name || !p.look) continue;
    const look = p.look.trim().replace(/[.\s]+$/, "");
    if (out.toLowerCase().includes(look.slice(0, 40).toLowerCase())) continue;
    // The full name, else the family or given name alone.
    const names = [p.name, ...p.name.split(/\s+/).filter((n) => n.length >= 3)];
    for (const n of names) {
      const re = new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b(?!\\s*\\()`);
      if (re.test(out)) { out = out.replace(re, (m) => `${m} (${look})`); break; }
    }
  }
  return out;
}

/** Every shot opens with the style sentence; directors drop it on turn shots (and a card's own
 *  <shot> never has it), and the video then drifts to its default look (live-action turns into
 *  anime, a painted cover into flat cel animation). */
export function withStyle(shot: string, style = "live", look?: string | null): string {
  const sentence = styleSentence(style, look);
  // A shot written with the generic "keep the first frame's style" sentence gets the written-out look instead.
  const text = look && STYLES.source ? shot.replace(STYLES.source, "").trim() : shot.trim();
  return text.includes(sentence.slice(0, 48)) ? text : `${sentence} ${text}`;
}

/** A look the client sent back: one plain sentence, nothing else. */
function cleanLook(look: unknown): string | null {
  return typeof look === "string" && look.trim() ? look.replace(/[\r\n<>]+/g, " ").trim().slice(0, 400) : null;
}

// Cover URL → its look in words, so a world's cover is described once per server.
const coverLooks = new Map<string, string>();
/** One sentence describing the art style of a card's cover, for H3 shots that have no first frame
 *  to copy it from (2026-10-07: without it a painted cover turned into generic flat anime by the
 *  third clip). How it is drawn only: when it named the cover's crimson sky, the first clip on
 *  prod (2026-10-08) put a whole forest in red. Null when the cover cannot be read. */
async function describeLook(coverUrl: string | null, bill: FilmBill): Promise<string | null> {
  if (!coverUrl || !/^https:\/\//.test(coverUrl)) return null;
  const known = coverLooks.get(coverUrl);
  if (known) return known;
  const out = await callDirector(
    `You describe the visual style of an image for a video model that must film new scenes in exactly this style. One English sentence of 25-45 words: the medium (photo, live-action, 3D render, anime, painted illustration, …), rendering and shading, line work, proportions, level of detail and overall tone (e.g. muted, high-contrast, soft). Then one short sentence saying what it is not (e.g. "Not flat cel animation, not chibi."). Describe only how it is drawn, never what is in it: no people, no place, no text, and no colours or lighting of this particular scene (a red night sky here must not turn every later scene red). Output JSON only: {"look":"…"}`,
    [{ type: "text", text: "The image:" }, { type: "image_url", image_url: { url: coverUrl } }],
    400, DIRECTOR_MODEL, bill,
  ).catch((e) => { console.warn("[Film] cover look failed:", e instanceof Error ? e.message : e); return null; });
  const look = typeof out?.look === "string" ? out.look.replace(/^\s*visual style:\s*/i, "").replace(/\s+/g, " ").trim().slice(0, 400) : "";
  if (!look) return null;
  if (coverLooks.size > 500) coverLooks.clear();
  coverLooks.set(coverUrl, look);
  return look;
}

realtimeVideoRoutes.post("/realtime-video/opening", async (c) => {
  const userId = c.get("user").id;
  const body = await c.req.json<{ sessionId?: string; style?: string; beats?: number; greeting?: string; model?: string; format?: string }>();
  if (!body.sessionId || !body.greeting) return c.json({ error: "sessionId and greeting required" }, 400);
  const world = await loadWorldSchema(userId, body.sessionId);
  if (!world) return c.json({ error: "session not found" }, 404);
  const lore = characterNotes(world.schema);
  const n = Math.min(10, Math.max(3, Number(body.beats) || 7));
  if (!(await canAffordFilm(userId, 1))) return c.json(NO_CREDITS, 402);
  const bill: FilmBill = { userId, sessionId: body.sessionId, credits: 0 };
  const t0 = Date.now();
  const coverUrl = resolveImageCdn(world.thumbnailUrl);
  try {
    const look = body.style === "source" ? await describeLook(coverUrl, bill) : null;
    const out = await callDirector(
      `You direct a realtime video stream for the interactive story "${world.name}". A video model renders one continuous stream, about 8 seconds per shot.

1. "cast": for every named person who appears in the opening or is clearly central, write a one-line English visual description (age, build, hair, eyes, clothing). Base it strictly on the character notes.${body.format === "lock" ? " Make each look unmistakable: name the hair length, colour and cut, eye colour, exact outfit, and give every person one signature detail no one else has (an accessory, a scar, a hair clip) so a video model can tell them apart and keep them the same." : ""} Format: {"name":"…","look":"…"}.
2. "scenes": every distinct place/time in the opening, in order of first appearance. Each = {"id":"S1","sheet": one English paragraph: the place, time of day, light and weather, and who is usually there with their look}.
3. "beats": split the opening text into exactly ${n} consecutive shots in order. Each beat = {"text": the exact passage of the opening this shot films, copied verbatim from its first sentence to its last, "scene": the scene id, "shot": the camera direction}. Consecutive beats continue where the previous one stopped, so together they cover the whole opening with nothing skipped; give a beat more text rather than leave text out. The shot films what its passage says, in the passage's order. When a beat moves to a different scene, its shot starts with "Hard cut to:" followed by that scene's sheet. Exception: if the story gets there by blacking out, fainting, falling asleep or waking up, it is not a hard cut. The beat before ends with the picture slowly fading to black as consciousness goes, and the new scene's shot starts with "Fade in from black:" then blurred, slowly focusing first-person vision of that scene's sheet. Within one scene the beats are one continuous take: each shot starts from where the previous one ended and moves the camera to the new action, with no new establishing description and no jump to another angle. Transitions the story describes (mist filling a room, someone fainting, waking up somewhere) get their own beat, so the film shows how one place leads to the next. Do not merge two different speakers or events into one shot if it makes a character do another character's action. Whatever language the opening is written in, the film is Japanese: when a shot has someone speak, translate their line into natural Japanese and write it in 「」; never copy a line from the opening into a shot untranslated.

${SHOT_RULES(body.style ?? "live", body.format, look)}

Character notes:
${lore}

Output JSON only: {"cast":[…],"scenes":[…],"beats":[…]}`,
      `Opening text:\n${body.greeting.slice(0, 12000)}`,
      12000,
      pickModel(body.model, OPENING_MODEL),
      bill,
    );
    const cast = (Array.isArray(out.cast) ? out.cast : []) as { name: string; look: string }[];
    const beats = (Array.isArray(out.beats) ? out.beats : []) as { text?: string; shot?: string; scene?: string }[];
    for (const b of beats) if (typeof b?.shot === "string") b.shot = withVoice(withStyle(pinLooks(b.shot, cast), body.style, look));
    return c.json({ cast, scenes: out.scenes ?? [], beats, coverUrl, look, ms: Date.now() - t0, model: pickModel(body.model, OPENING_MODEL), credits: bill.credits });
  } catch (e) {
    return c.json({ error: String((e as Error).message ?? e) }, 502);
  }
});

/** What the director needs to film one turn. */
type DirectInput = {
  sessionId?: string;
  style?: string; cast?: { name: string; look: string }[]; userText?: string; aiText: string; prevShot?: string;
  model?: string; scenes?: SceneCard[]; currentScene?: string; format?: string;
  /** The cover's look in words (from /opening), for style "source". */
  look?: string | null;
  /** The story just before this turn, so the director knows what is going on. */
  recent?: string;
  /** "start": the reply is still being written, film its first moment.
   *  "rest": the previous shot showed the start of this reply, film what follows. */
  part?: "start" | "rest";
  /** 1: one ~10 s shot of the reply's key moment (a clip per message). Default: about one shot
   *  per three paragraphs, at most four, that together film all of it. */
  maxBeats?: number;
  /** Where things stood at the end of the previous filmed reply (the director's scene state). */
  prevState?: string;
  /** The card's character notes, for looks while the cast is still empty. */
  notes?: string;
  /** Script mode (a film per message): the director decides how many ~5 s shots the reply needs,
   *  up to maxBeats, cutting between camera angles; `ownShot` is the card's own direction. */
  script?: { ownShot?: string };
};
/** take "same": the shot carries on the previous shot's movement as one unbroken take (script mode). */
type DirectedBeat = { text: string; shot: string; transition: "continue" | "cut" | "return"; scene: string | null; sheet: string | null; take: "new" | "same" };

/** Turn one story reply into camera directions (/shot, and the clip per message). */
async function directTurn(body: DirectInput, bill: FilmBill): Promise<{ beats: DirectedBeat[]; newCast: { name: string; look: string }[]; state?: string }> {
  const partNote = body.part === "start"
    ? "\n\n(The story reply is still being written; this is its beginning. Film its first visible moment.)"
    : body.part === "rest"
      ? "\n\n(The previous shot already shows the beginning of this reply. Film what happens after it, as the same continuous take unless the reply clearly moves somewhere else.)"
      : "";
  const cast = (body.cast ?? []).map((p) => `- ${p.name}: ${p.look}`).join("\n");
  // The start of a reply still being written gets one shot; a finished reply (or its rest) is
  // cut into shots that together film all of it: about one per three paragraphs, at most four.
  const paragraphs = body.aiText.split(/\n\s*\n/).filter((p) => p.trim().length > 20).length;
  const maxBeats = body.maxBeats ?? (body.part === "start" ? 1 : Math.min(4, Math.max(1, Math.round(paragraphs / 3))));
  // A script covers the whole reply: about one shot per four paragraphs at the least.
  const minShots = Math.min(maxBeats, Math.max(1, Math.round(paragraphs / 4)));
  const scenes = (body.scenes ?? []).slice(-20);
  const sceneList = scenes.length ? scenes.map((sc) => `- ${sc.id}: ${sc.sheet}`).join("\n") : "(none yet)";
  const nextId = `S${scenes.length + 1}`;
  const look = cleanLook(body.look);
  const filming = body.script
    ? `write the film of it as a script of shots, about five seconds each.
COVERAGE: the script films the WHOLE reply, from its first visible event to its last, in story order. The beginning is never skipped and no stretch of the reply goes unfilmed: every paragraph that shows something new is inside some shot's passage. This reply needs at least ${minShots} and at most ${maxBeats} shots.
SCENES: one place is one scene. Inside a scene every shot is in the same room, with the same people, in the poses and the state of dress the story gives them at that moment. When the reply moves to another place (a ceremony, then waking up somewhere else), that is a new scene, filmed after the first, in order. For the scene the reply ends in, write the scene state ("state"): one English paragraph with the exact place (the room, its furniture and where things are), the light, and for each person on screen their look, what they are wearing right now (or that they are undressed), their pose and where they are relative to each other. When the story is still where the previous scene state left it, start from that state and change only what the story changed. Every shot of a scene repeats that scene's place, light, people, clothing and poses (after the style sentence) before its camera angle and action; a shot never contradicts it (no clothes coming back on, no different room, no other people).
SHOTS: count shots by visible action, not by sentence. A spoken line, a sound, a moan or an inner reaction belongs to the action shot it happens in and never gets a shot of its own; a long stretch of continued action gets several shots, about one per paragraph that shows something new. Cut between camera angles inside a scene the way a film editor does (wide, close-up, reverse shot, the player's first-person view). The player is the camera: never show the player's face or body from outside, only their hands and what they see. Mark a shot "take":"same" only when it must carry on the previous shot's movement as one unbroken take (the previous shot of this turn, or for the first shot the previous shot below); otherwise "take":"new".${body.script.ownShot ? `\nThe story's author wrote this camera direction for the turn; follow it, cut into shots:\n${body.script.ownShot}` : ""}`
    : body.maxBeats === 1
    ? "film it in exactly 1 shot of about ten seconds: its key visible moment (the main event the reply is about, as far as it has gone) with the action that leads into it. Do not try to show everything."
    : `cut it into exactly ${maxBeats} consecutive shot${maxBeats > 1 ? "s" : ""} in story order that together show everything visible that happens in it${maxBeats > 1 ? ", splitting the reply into " + maxBeats + " consecutive passages of similar length" : ""}. Each shot films its own passage of the reply, in that passage's order, and does not jump ahead to later events. Shots in the same place are one continuous take: each starts where the previous one ended.`;
  const ask = (extra = "") => callDirector(
    `You direct a realtime video stream that follows an interactive story, like a film editor who can intercut storylines. The story just advanced by one turn. Film this turn: ${filming}

For each shot decide where it happens:
- "continue": still the current scene (${body.currentScene ?? "none"}). ${body.script
      ? "Same place, same people, same light; a shot may still take a new camera angle in it. No new establishing description."
      : "This is the same continuous take as the previous shot: same place, same people, same light. Start from what the previous shot ended on and let the camera move (pan, push in, follow) to the new action. No new establishing shot, no jump to a different angle or place, no repeated scene description."}
- "cut": a place/time not in the scene list. Give it id "${nextId}" and a sheet (one English paragraph: place, time of day, light and weather, who is there with their look). The shot starts with "Hard cut to:" followed by that sheet; if the story got there by blacking out, sleeping or waking up, it starts with "Fade in from black:" and blurred, slowly focusing first-person vision instead.
- "return": back to a scene already in the list. The shot starts with "Cut back to:" followed by that scene's sheet copied word for word, so it looks the same as before.
Before choosing "cut", check the scene list: if the story is in the same kind of place as a listed scene (the same forest, the same school, the same harbor), it is a "return" to that scene even if time has passed or different people are there. Only a place that matches nothing in the list is a "cut".

${SHOT_RULES(body.style ?? "live", body.format, look)}

Cast (paste the description of whoever is on screen):
${cast || "(none yet)"}
A named person who is on screen but not in the cast: add them to "newCast" with a one-line English look (age, build, hair, eyes, clothing, one signature detail) taken from the ${body.notes ? "character notes when they have one, otherwise the story" : "story"}, and paste that same look in every shot they are in.
${body.notes ? `\nCharacter notes:\n${body.notes}\n` : ""}
Scene list:
${sceneList}

Output JSON only: {${body.script ? '"state":"<the scene state>",' : ""}"newCast":[{"name":"…","look":"…"}],"beats":[{"passage":"<sentences copied word for word from the story reply: the part this shot films, from its first sentence to its last>","transition":"continue|cut|return","scene":"<scene id>","sheet":"<only for cut>",${body.script ? '"take":"new|same",' : ""}"shot":"<the camera direction, following the shot rules>"}]}
The passage is the story text itself, never the camera direction.${extra}`,
    `Story so far (most recent last):
${(body.recent ?? "").slice(-2500) || "(the opening)"}

Previous shot:
${body.prevShot ?? "(none)"}
${body.script ? `\nScene state at the end of the previous reply:\n${body.prevState ?? "(none yet)"}\n` : ""}
Player did/said:
${(body.userText ?? "").slice(0, 1500)}

Story reply:
${body.aiText.slice(0, 6000)}${partNote}`,
    body.script ? 9000 : 5000,
    pickModel(body.model, DIRECTOR_MODEL),
    bill,
  );
  let out = await ask();
  // A script that skips most of the reply (fewer shots than it needs) is sent back once.
  const shotCount = (o: Record<string, unknown>) => (Array.isArray(o.beats) ? o.beats.length : 0);
  if (body.script && shotCount(out) < minShots) {
    const first = shotCount(out);
    const again = await ask(`

Your last answer had only ${first} shot${first === 1 ? "" : "s"} and skipped most of the reply. Film ALL of it, from its first paragraph to its last: at least ${minShots} shots.`).catch(() => null);
    if (again && shotCount(again) > first) out = again;
    console.log(`[TurnClip] director script short: ${first} shots, needed ${minShots}; retried: ${again ? shotCount(again) : "failed"}`);
  }
  // Older single-shot answers ({shot, transition, …}) still count as one beat.
  const raw = (Array.isArray(out.beats) ? out.beats : [out]) as Record<string, unknown>[];
  let scene = body.currentScene ?? null;
  const known = new Set(scenes.map((sc) => sc.id));
  const isDirection = (t: unknown) => typeof t === "string" && /^\s*(Visual style|Hard cut to|Cut back to|Fade in from black)/i.test(t);
  const beats: DirectedBeat[] = raw.map((b) => {
    if (!b) return b;
    // A model that wrote the direction into the passage field: recover it.
    if (!(typeof b.shot === "string" && b.shot.trim()) && isDirection(b.passage ?? b.text)) return { ...b, shot: b.passage ?? b.text, passage: "", text: "" };
    return b;
  }).filter((b) => b && typeof b.shot === "string" && b.shot.trim()).slice(0, maxBeats).map((b) => {
    const transition = b.transition === "cut" || b.transition === "return" ? b.transition : "continue";
    // A cut to a place already in the list is a return.
    let id = typeof b.scene === "string" && b.scene ? b.scene : transition === "cut" ? `S${known.size + 1}` : scene;
    if (transition === "cut" && id && known.has(id) && id !== scene) id = `S${known.size + 1}`;
    if (id) known.add(id);
    scene = id;
    const passage = typeof b.passage === "string" ? b.passage : typeof b.text === "string" ? b.text : "";
    return { text: isDirection(passage) ? "" : passage, shot: String(b.shot), transition, scene: id, sheet: transition === "cut" && typeof b.sheet === "string" ? b.sheet : null, take: b.take === "same" ? "same" : "new" };
  });
  if (!beats.length) throw new Error(`the director wrote no shot: ${JSON.stringify(out).slice(0, 600)}`);
  const newCast = (Array.isArray(out.newCast) ? out.newCast : [])
    .filter((p): p is { name: string; look: string } => !!p && typeof p.name === "string" && typeof p.look === "string" && !!p.name && !!p.look)
    .filter((p) => !(body.cast ?? []).some((k) => k.name === p.name))
    .slice(0, 6);
  const everyone = [...(body.cast ?? []), ...newCast];
  for (const b of beats) b.shot = withVoice(withStyle(pinLooks(b.shot, everyone), body.style, look));
  // A script plays in story order whatever order the director wrote it in: each shot sits where
  // its passage is in the reply (a reordered take can no longer carry on the shot before it).
  if (body.script && beats.length > 1) {
    // Letters and digits only: a passage's quotes, dashes and asterisks often differ from the reply's.
    const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    const story = norm(body.aiText);
    const at = (t: string) => {
      const n = norm(t);
      for (const len of [40, 16]) { const i = n ? story.indexOf(n.slice(0, len)) : -1; if (i >= 0) return i; }
      return Number.POSITIVE_INFINITY;
    };
    const order = beats.map((b, i) => ({ b, i, pos: at(b.text) })).sort((x, y) => (x.pos === y.pos ? x.i - y.i : x.pos - y.pos));
    if (order.some((o, k) => o.i !== k)) {
      beats.splice(0, beats.length, ...order.map((o) => ({ ...o.b, take: "new" as const })));
      console.log(`[TurnClip] director script reordered to story order (${beats.length} shots)`);
    }
  }
  // The scene state (script mode): where things stand, carried to the next reply.
  const state = typeof out.state === "string" && out.state.trim() ? out.state.trim().slice(0, 2000) : undefined;
  return { beats, newCast, state };
}

realtimeVideoRoutes.post("/realtime-video/shot", async (c) => {
  const userId = c.get("user").id;
  const body = await c.req.json<Omit<DirectInput, "aiText" | "maxBeats" | "notes"> & { aiText?: string }>();
  if (!body.aiText) return c.json({ error: "aiText required" }, 400);
  if (!(await canAffordFilm(userId, 1))) return c.json(NO_CREDITS, 402);
  const bill: FilmBill = { userId, sessionId: body.sessionId, credits: 0 };
  const t0 = Date.now();
  try {
    const { beats, newCast } = await directTurn({ ...body, aiText: body.aiText }, bill);
    return c.json({ ...beats[0], beats, newCast, ms: Date.now() - t0, credits: bill.credits });
  } catch (e) {
    return c.json({ error: String((e as Error).message ?? e) }, 502);
  }
});

// ── Clip-chain engine (Comfy Cloud) ─────────────────────────────────
const COMFY_BASE = process.env.COMFY_CLOUD_BASE_URL || "https://cloud.comfy.org";

async function comfy<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${COMFY_BASE}${path}`, {
    ...init,
    headers: { "X-API-Key": env.COMFY_CLOUD_API_KEY, ...(init.body instanceof FormData ? {} : { "Content-Type": "application/json" }), ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Comfy ${path} ${res.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

// Frames arrive as data URLs drawn by the browser (cover or the previous clip's last frame),
// so the server never fetches arbitrary URLs.
function frameBytes(frame: string): { bytes: Uint8Array; type: string } {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(frame);
  if (!m) throw new Error("frame must be a jpeg/png/webp data URL");
  const bytes = Buffer.from(m[2]!, "base64");
  if (bytes.length > 4 * 1024 * 1024) throw new Error("frame larger than 4 MB");
  return { bytes, type: m[1]! };
}

const GUIDE_RE = /^yumina-rtv\/[0-9a-f]{64}\.mp4$/;
// Portrait URL -> uploaded Comfy input name, so a card's portraits are uploaded once per server.
const refUploads = new Map<string, string>();

async function uploadToComfy(bytes: Uint8Array, type: string, name: string): Promise<string> {
  const form = new FormData();
  form.append("image", new Blob([bytes], { type }), name);
  form.append("overwrite", "true");
  const up = await comfy<{ name: string; subfolder?: string }>("/api/upload/image", { method: "POST", body: form });
  return up.subfolder ? `${up.subfolder}/${up.name}` : up.name;
}

// Portrait URL -> asset id on the film deployment (assets live 24 h there; re-upload after 12).
const refAssets = new Map<string, { id: string; at: number }>();
const uploadPortraitAsset = async (bytes: Uint8Array, type: string, name: string) => uploadFilmAsset(bytes, type, name);

/** Characters with a portrait who are named in the shot, in the order they appear (max 3).
 *  `image` is what the graph's LoadImage names: a Comfy Cloud input file, or a film deployment asset id. */
async function portraitRefs(userId: string, sessionId: string, prompt: string, onDeploy = false): Promise<{ name: string; image: string }[]> {
  const world = await loadWorldSchema(userId, sessionId);
  if (!world) return [];
  const entries = ((world.schema as { entries?: (Entry & { portrait?: string })[] }).entries ?? []).filter((e) => e.enabled !== false && e.portrait && e.name);
  const named = entries
    .map((e) => ({ e, at: prompt.indexOf(e.name!) }))
    .filter((x) => x.at >= 0)
    .sort((a, b) => a.at - b.at)
    .slice(0, 3);
  const out: { name: string; image: string }[] = [];
  for (const { e } of named) {
    const url = resolveImageCdn(e.portrait);
    if (!url) continue;
    const known = onDeploy ? refAssets.get(url) : null;
    let image = onDeploy ? (known && Date.now() - known.at < 12 * 3600_000 ? known.id : undefined) : refUploads.get(url);
    if (!image) {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) continue;
      const type = res.headers.get("content-type")?.split(";")[0] || "image/jpeg";
      const name = `rtv-ref-${refUploads.size + refAssets.size}-${Date.now()}.${type.includes("png") ? "png" : type.includes("webp") ? "webp" : "jpg"}`;
      const bytes = new Uint8Array(await res.arrayBuffer());
      image = onDeploy ? await uploadPortraitAsset(bytes, type, name) : await uploadToComfy(bytes, type, name);
      if (onDeploy) refAssets.set(url, { id: image, at: Date.now() });
      else refUploads.set(url, image);
    }
    out.push({ name: e.name!, image });
  }
  return out;
}

type ClipBody = {
  prompt?: string; frame?: string; guide?: string; sessionId?: string; refs?: boolean; seed?: number;
  /** The film's style and, for "source", the cover's look: every clip opens with it, including
   *  shots a card's AI wrote itself (those never went through the director). */
  style?: string; look?: string;
};

/** The prompt H3 renders: the style sentence first, spoken lines in Japanese. */
async function clipPrompt(body: ClipBody, bill: FilmBill): Promise<string> {
  const shot = await japaneseDialogue(body.prompt!.slice(0, 4000), bill);
  return withVoice(body.style ? withStyle(shot, body.style, cleanLook(body.look)) : shot);
}

/** Run one graph on the shared Comfy Cloud pool: the mp4, its GPU and queue time, and its
 *  output path (a later clip can continue from it). Throws with the reason when it fails. */
async function renderOnPool(graph: Record<string, unknown>, deadlineAt: number): Promise<{ bytes: ArrayBuffer; execMs: number; queueMs: number | null; ref: string; promptId: string }> {
  const sub = await comfy<{ prompt_id?: string }>("/api/prompt", { method: "POST", body: JSON.stringify({ prompt: graph }) });
  if (!sub.prompt_id) throw new Error("no prompt_id");
  const submittedAt = Date.now();
  let status = "";
  while (Date.now() < deadlineAt) {
    await new Promise((r) => setTimeout(r, 500));
    // A passing poll error does not stop the job: keep polling until the deadline.
    status = (await comfy<{ status?: string }>(`/api/job/${sub.prompt_id}/status`).catch(() => ({ status }))).status ?? "";
    if (["completed", "success", "failed", "error", "cancelled"].includes(status)) break;
  }
  type OutFile = { filename: string; subfolder?: string; type?: string };
  const detail = await comfy<{ outputs?: Record<string, { images?: OutFile[] }>; preview_output?: OutFile; execution_start_time?: number; execution_end_time?: number; execution_error?: { exception_message?: string } }>(`/api/jobs/${sub.prompt_id}`);
  // Saved clips only; a LoadVideo guide also shows up in outputs as an input file.
  const file = Object.values(detail.outputs ?? {}).flatMap((o) => o.images ?? []).find((f) => f.type === "output" && f.filename.endsWith(".mp4")) ?? detail.preview_output;
  if (!["completed", "success"].includes(status) || !file) {
    throw new Error(detail.execution_error?.exception_message?.slice(0, 300) || `clip ${status || "timed out"}`);
  }
  const q = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder ?? "", type: "output" });
  const view = await fetch(`${COMFY_BASE}/api/view?${q}`, { headers: { "X-API-Key": env.COMFY_CLOUD_API_KEY }, redirect: "manual", signal: AbortSignal.timeout(15_000) });
  const location = view.status >= 300 && view.status < 400 ? view.headers.get("location") : null;
  const video = location ? await fetch(location, { signal: AbortSignal.timeout(60_000) }) : view;
  if (!video.ok) throw new Error(`download ${video.status}`);
  const execMs = detail.execution_start_time && detail.execution_end_time ? detail.execution_end_time - detail.execution_start_time : 0;
  const queueMs = detail.execution_start_time ? Math.max(0, detail.execution_start_time - submittedAt) : null;
  return { bytes: await video.arrayBuffer(), execMs, queueMs, ref: file.subfolder ? `${file.subfolder}/${file.filename}` : file.filename, promptId: sub.prompt_id };
}

realtimeVideoRoutes.post("/realtime-video/clip", async (c) => {
  if (!env.COMFY_CLOUD_API_KEY) return c.json({ error: "COMFY_CLOUD_API_KEY not configured" }, 503);
  const userId = c.get("user").id;
  // The Comfy clip chain is admin-only until H3's picture is good enough to open again (owner, 2026-10-07).
  const rd = await readOwn(userId);
  const [me] = await rd.select({ role: user.role }).from(user).where(eq(user.id, userId)).limit(1);
  if (me?.role !== "admin") return c.json({ error: "Comfy scene video is not open yet." }, 403);
  const body = await c.req.json<ClipBody & { model?: string }>();
  const model = (CLIP_MODELS as readonly string[]).includes(body.model ?? "") ? (body.model as ClipModel) : "causal-forcing";
  if (!body.prompt) return c.json({ error: "prompt required" }, 400);
  if (model !== "h3-turbo" && !body.frame) return c.json({ error: "frame required" }, 400);
  if (body.guide && !GUIDE_RE.test(body.guide) && !DEPLOY_REF_RE.test(body.guide)) return c.json({ error: "bad guide" }, 400);
  if (!(await canAffordFilm(userId, CLIP_ESTIMATE_CREDITS))) return c.json(NO_CREDITS, 402);
  // The film deployment once it has a warm worker; the shared pool otherwise (and if it fails).
  if (model === "h3-turbo" && filmDeployWarm()) {
    try {
      return await renderOnDeploy(userId, body);
    } catch (e) {
      noteFilmDeployFailed();
      console.warn("[Film] deployment clip failed, using the shared pool:", e instanceof Error ? e.message : e);
    }
  }
  // A clip continued from a deployment asset cannot be read by the pool: it starts fresh.
  if (body.guide && DEPLOY_REF_RE.test(body.guide)) body.guide = undefined;
  const pooled = model === "h3-turbo";
  let poolQueue: number | null = null;
  if (pooled) {
    poolClipStarted();
    maybeWakeFilmDeploy(warmGraph);
  }
  const bill: FilmBill = { userId, sessionId: body.sessionId, credits: 0 };
  const t0 = Date.now();
  try {
    const seed = body.seed ?? Math.floor(Math.random() * 1e9);
    let prompt = await clipPrompt(body, bill);
    let image: string | undefined;
    if (body.frame && !(model === "h3-turbo" && body.guide)) {
      const { bytes, type } = frameBytes(body.frame);
      image = await uploadToComfy(bytes, type, `rtv-${Date.now()}.${type.includes("png") ? "png" : "jpg"}`);
    }
    let refNames: string[] = [];
    let graph;
    if (model === "h3-turbo") {
      // Portraits only on a fresh shot: with a guide they fight the carried-over frames (ghosted faces).
      const refs = body.refs !== false && body.sessionId && !body.guide ? await portraitRefs(userId, body.sessionId, prompt).catch(() => []) : [];
      refNames = refs.map((r) => r.name);
      if (refs.length) prompt = `${refs.map((r, i) => `<Picture ${i + 1}> is ${r.name}.`).join(" ")} ${prompt}`;
      graph = buildH3Graph({ prompt, seed, frame: image, guide: body.guide, refs: refs.map((r) => r.image) });
    } else {
      graph = buildClipGraph(model, { image: image!, prompt, seconds: 5, seed });
    }
    const { bytes, execMs, queueMs, ref, promptId } = await renderOnPool(graph, t0 + 240_000);
    poolQueue = queueMs;
    // The player pays the GPU time of a clip they get; failed renders are on us.
    bill.credits += await chargeFilm({
      userId, sessionId: body.sessionId, endpoint: "film-clip", model: `comfy/${model}`,
      costUsd: (execMs / 1000) * COMFY_USD_PER_GPU_SECOND, referenceId: `film-clip:${promptId}`,
      description: `Scene video — ${(execMs / 1000).toFixed(1)} GPU s`, ms: Date.now() - t0,
    });
    return new Response(bytes, {
      headers: {
        "Content-Type": "video/mp4",
        "X-Clip-Total-Ms": String(Date.now() - t0),
        "X-Clip-Exec-Ms": String(execMs),
        "X-Clip-Queue-Ms": String(queueMs ?? 0),
        "X-Clip-Ref": ref,
        "X-Clip-Refs": encodeURIComponent(refNames.join(",")),
        "X-Film-Credits": String(bill.credits),
        "Access-Control-Expose-Headers": "X-Clip-Total-Ms, X-Clip-Exec-Ms, X-Clip-Queue-Ms, X-Clip-Ref, X-Clip-Refs, X-Film-Credits",
      },
    });
  } catch (e) {
    return c.json({ error: String((e as Error).message ?? e) }, 502);
  } finally {
    if (pooled) poolClipEnded(poolQueue);
  }
});

/** A clip the shared pool rendered (its output path), downloaded to move it to the deployment. */
async function poolClipBytes(ref: string): Promise<Uint8Array> {
  const slash = ref.lastIndexOf("/");
  const q = new URLSearchParams({ filename: ref.slice(slash + 1), subfolder: ref.slice(0, slash), type: "output" });
  const view = await fetch(`${COMFY_BASE}/api/view?${q}`, { headers: { "X-API-Key": env.COMFY_CLOUD_API_KEY }, redirect: "manual", signal: AbortSignal.timeout(15_000) });
  const location = view.status >= 300 && view.status < 400 ? view.headers.get("location") : null;
  const file = location ? await fetch(location, { signal: AbortSignal.timeout(60_000) }) : view;
  if (!file.ok) throw new Error(`pool clip ${file.status}`);
  return new Uint8Array(await file.arrayBuffer());
}

/** An H3 clip on our own film deployment (lib/realtime-video/film-deploy.ts); throws when it fails. */
async function renderOnDeploy(
  userId: string,
  body: ClipBody,
) {
  const bill: FilmBill = { userId, sessionId: body.sessionId, credits: 0 };
  const t0 = Date.now();
  {
    const seed = body.seed ?? Math.floor(Math.random() * 1e9);
    let prompt = await clipPrompt(body, bill);
    // A clip rendered on the shared pool (the film just moved here) comes along as an asset.
    let guideAssetId = body.guide && DEPLOY_REF_RE.test(body.guide) ? body.guide.slice("asset:".length) : undefined;
    if (body.guide && GUIDE_RE.test(body.guide)) {
      const bytes = await poolClipBytes(body.guide).catch(() => null);
      if (bytes) guideAssetId = await uploadFilmAsset(bytes, "video/mp4", body.guide.split("/").pop()!);
    }
    const images = new Map<string, string>();
    let frame: string | undefined;
    if (body.frame && !guideAssetId) {
      const { bytes, type } = frameBytes(body.frame);
      frame = `rtv-frame.${type.includes("png") ? "png" : type.includes("webp") ? "webp" : "jpg"}`;
      images.set(frame, await uploadFilmAsset(bytes, type, frame));
    }
    const refs = body.refs !== false && body.sessionId && !guideAssetId ? await portraitRefs(userId, body.sessionId, prompt, true).catch(() => []) : [];
    const refNames = refs.map((r) => r.name);
    if (refs.length) prompt = `${refs.map((r, i) => `<Picture ${i + 1}> is ${r.name}.`).join(" ")} ${prompt}`;
    const refFiles = refs.map((r, i) => { const name = `rtv-ref-${i}.jpg`; images.set(name, r.image); return name; });
    const graph = buildH3Graph({ prompt, seed, frame, guide: guideAssetId ? "guide" : undefined, refs: refFiles });
    const clip = await renderFilmClip(bindFilmAssets(graph, images, guideAssetId));
    noteFilmDeployDone();
    // The player pays the GPU time of a clip they get; failed renders are on us.
    bill.credits += await chargeFilm({
      userId, sessionId: body.sessionId, endpoint: "film-clip", model: "comfy-deploy/h3-turbo",
      costUsd: (clip.execMs / 1000) * COMFY_USD_PER_GPU_SECOND, referenceId: `film-clip:${clip.jobId}`,
      description: `Scene video — ${(clip.execMs / 1000).toFixed(1)} GPU s`, ms: Date.now() - t0,
    });
    return new Response(clip.bytes, {
      headers: {
        "Content-Type": "video/mp4",
        "X-Clip-Total-Ms": String(Date.now() - t0),
        "X-Clip-Exec-Ms": String(clip.execMs),
        "X-Clip-Queue-Ms": String(clip.queueMs),
        "X-Clip-Ref": clip.ref,
        "X-Clip-Refs": encodeURIComponent(refNames.join(",")),
        "X-Film-Credits": String(bill.credits),
        "Access-Control-Expose-Headers": "X-Clip-Total-Ms, X-Clip-Exec-Ms, X-Clip-Queue-Ms, X-Clip-Ref, X-Clip-Refs, X-Film-Credits",
      },
    });
  }
}

// ── A film per message ──────────────────────────────────────────────
// The Comfy film as a film per message instead of an endless stream (owner, 2026-10-07): the
// director writes the reply as a script of ~5 s shots, as many as the reply needs (one for a
// look, up to twelve for a fight), and the shots render side by side on the film deployment, so
// a long reply costs more machines rather than much more waiting. The film lands on the message
// as its shots' video embeds, which the player plays back to back (lib/realtime-video/turn-clip.ts).
// A shot marked as the same take continues the shot before it (three times at most, then it
// starts fresh: the drift rule); every other shot is a new camera angle from the portraits.

const TURN_CLIP_MAX_CHAIN = 3;
const TURN_FILM_MAX_SHOTS = 8;
/** Shots of one message rendering at once, each on its own machine. */
const TURN_FILM_LANES = 3;
/** One shot on the film deployment: a worker started from nothing pulls ~65 GB of models first
 *  (2-10 min measured 2026-10-07) before ~1.5 min of render. */
const TURN_SHOT_DEPLOY_DEADLINE_MS = 900_000;
const TURN_SHOT_POOL_DEADLINE_MS = 480_000;
/** GPU time a shot is charged at most: a render takes ~95 s, and a job on a worker that was
 *  still booting counts its model loading as running (a 3-shot film was charged 1,267 mushies
 *  instead of ~400 on prod, 2026-10-08). The cold boot is ours, not the player's. */
const TURN_SHOT_BILLED_MS_MAX = 150_000;
const SHOT_TAG_RE = /<shot>([\s\S]*?)<\/shot>/i;

/** A tiny clip that only wakes a film-deployment worker (it loads the models). */
const warmGraph = () => buildH3Graph({ prompt: "A quiet empty classroom in soft daylight; the camera holds still.", seed: 1, preset: "warm" });

/** The reply as the director reads it: no picture or clip embeds, no card <shot> direction. */
function storyText(content: string): string {
  return stripTurnVideos(stripTurnImages(content)).replace(/<shot>[\s\S]*?<\/shot>/gi, "").trim();
}

realtimeVideoRoutes.get("/realtime-video/turn-clip/:messageId", async (c) => {
  const messageId = c.req.param("messageId");
  const job = await getTurnClipJob(messageId);
  if (!job || job.userId !== c.get("user").id) return c.json({ status: "none" });
  if (turnClipLost(job)) {
    // Its server died (a deploy replaced it mid-film): the shots it finished still land.
    const landed = job.status === "rendering" ? await salvageFilm(messageId, job).catch(() => null) : null;
    if (landed) return c.json(landed);
    return c.json({ status: "failed", userId: job.userId, reason: "unavailable" });
  }
  return c.json(job);
});

/** The reply as filmed, for telling later whether it changed (a short hash of storyText). */
function storyFingerprint(content: string): string {
  return createHash("sha256").update(storyText(content)).digest("base64url").slice(0, 22);
}

/** Puts a film's shots at the end of its reply, replacing an older film, and keeps the passage
 *  each films beside them. Null when the reply changed meanwhile (regenerated, edited, deleted). */
async function landFilm(userId: string, messageId: string, sig: string, shots: { key: string; text: string }[]): Promise<string | null> {
  await putObject(turnFilmNotesKey(shots[0]!.key), Buffer.from(JSON.stringify({ shots: shots.map((s) => ({ text: s.text })) })), "application/json")
    .catch((e) => console.warn("[TurnClip] film notes not saved:", messageId, e instanceof Error ? e.message : e));
  for (let attempt = 0; attempt < 3; attempt++) {
    const [current] = await (await readOwn(userId)).select({ content: messages.content }).from(messages).where(eq(messages.id, messageId)).limit(1);
    if (!current || storyFingerprint(current.content) !== sig) return null;
    const next = `${stripTurnVideos(current.content).trimEnd()}\n\n${shots.map((s) => turnVideoEmbed(s.key)).join("\n")}`;
    const [updated] = await db.update(messages).set(messageContentUpdate(next))
      .where(and(eq(messages.id, messageId), eq(messages.content, current.content))).returning();
    if (updated) return updated.content;
  }
  return null;
}

/** A film whose server died: its finished shots land as the film, once (the job turns done). */
async function salvageFilm(messageId: string, job: Extract<TurnClipJob, { status: "rendering" }>): Promise<TurnClipJob | null> {
  if (!job.sig || !job.clips) return null;
  const shots = job.clips.flatMap((p, i) => {
    const key = p ? turnVideoKeyOf(p) : null;
    return key ? [{ key, text: job.texts?.[i] ?? "" }] : [];
  });
  if (!shots.length) return null;
  const content = await landFilm(job.userId, messageId, job.sig, shots);
  if (!content) return null;
  const done: TurnClipJob = { status: "done", userId: job.userId, content, credits: 0 };
  await setTurnClipJob(messageId, done);
  console.log(`[TurnClip] film salvaged after its server died: ${messageId} · ${shots.length}/${job.shots ?? "?"} shots`);
  return done;
}

realtimeVideoRoutes.post("/realtime-video/turn-clip/:messageId", async (c) => {
  const userId = c.get("user").id;
  const messageId = c.req.param("messageId");
  const rd = await readOwn(userId);
  const [msg] = await rd.select({ id: messages.id, sessionId: messages.sessionId, role: messages.role, content: messages.content, createdAt: messages.createdAt })
    .from(messages).where(eq(messages.id, messageId)).limit(1);
  if (!msg || msg.role !== "assistant") return c.json({ error: "Message not found" }, 404);
  const [session] = await rd.select({ id: playSessions.id }).from(playSessions)
    .where(and(eq(playSessions.id, msg.sessionId), eq(playSessions.userId, userId))).limit(1);
  if (!session) return c.json({ error: "Not authorized" }, 403);
  const running = await getTurnClipJob(messageId);
  if (running?.status === "rendering" && running.userId === userId && !turnClipLost(running)) return c.json({ status: "rendering" });
  // A film whose server died: what it finished lands instead of filming the reply again.
  if (running?.status === "rendering" && running.userId === userId) {
    const landed = await salvageFilm(messageId, running).catch(() => null);
    if (landed) return c.json(landed);
  }
  if (!(await canAffordFilm(userId, TURN_CLIP_ESTIMATE_CREDITS))) return c.json({ status: "failed", reason: "credits" });
  // Two clips at once per player: a reply that lands while the last one renders still gets its own.
  const slot = `turn-clip:${userId}`;
  if (!(await acquireConcurrency(slot, 2, 2400))) return c.json({ status: "failed", reason: "busy" });
  const startedAt = Date.now();
  const sig = storyFingerprint(msg.content);
  let progress: TurnClipProgress = { shots: 0, done: 0 };
  const report = () => setTurnClipJob(messageId, { status: "rendering", userId, startedAt, beat: Date.now(), sig, ...progress });
  await report();
  // The heartbeat says this server is still on it (see turnClipLost); it also carries the progress.
  const beat = setInterval(() => { void report(); }, TURN_CLIP_BEAT_MS);
  // The film's look: the cover's ("source", the default) or one the player picked.
  const asked = ((await c.req.json().catch(() => ({}))) as { style?: unknown }).style;
  const style = typeof asked === "string" && STYLES[asked] ? asked : "source";
  void renderTurnClip(userId, msg, (p) => { progress = p; void report(); }, style)
    .then((done) => {
      clearInterval(beat);
      console.log(`[TurnClip] film landed: ${messageId} · ${progress.done}/${progress.shots} shots · ${Math.round((Date.now() - startedAt) / 1000)}s · ${done.credits} credits`);
      return setTurnClipJob(messageId, { status: "done", userId, ...done });
    })
    .catch(async (e) => {
      clearInterval(beat);
      const reason: TurnClipFailure = e instanceof TurnClipError ? e.reason : /timed out|timeout/i.test(String(e)) ? "timeout" : "unavailable";
      console.warn("[TurnClip] failed:", messageId, reason, e instanceof TurnClipError ? "" : e instanceof Error ? e.message : e);
      await setTurnClipJob(messageId, { status: "failed", userId, reason });
    })
    .finally(() => releaseConcurrency(slot));
  return c.json({ status: "rendering" });
});

class TurnClipError extends Error {
  constructor(readonly reason: TurnClipFailure) { super(reason); }
}

type PlannedShot = {
  beat: DirectedBeat;
  /** The shot of this film it continues (an index), or null for a new angle. */
  after: number | null;
  /** The previous message's last clip, which the first shot continues. */
  guideKey: string | null;
};
type RenderedShot = { key: string; assetId?: string; depth: number; scene: string | null; shot: string; text: string };

async function renderTurnClip(
  userId: string,
  msg: { id: string; sessionId: string; content: string; createdAt: Date | null },
  onProgress: (p: TurnClipProgress) => void,
  style = "source",
): Promise<{ content: string; credits: number }> {
  const sessionId = msg.sessionId;
  const bill: FilmBill = { userId, sessionId, credits: 0 };
  const world = await loadWorldSchema(userId, sessionId);
  if (!world) throw new TurnClipError("unavailable");
  const reply = storyText(msg.content);
  if (!reply) throw new TurnClipError("stale");

  const film: FilmState = (await getFilmState(sessionId)) ?? { look: null, cast: [], scenes: [], currentScene: null, prevShot: "", lastClip: null };
  // The cover's look is written out once per film: "keep the first frame's style" means
  // nothing to a clip that starts without one.
  if (!film.look) film.look = await describeLook(resolveImageCdn(world.thumbnailUrl), bill);
  // A preset look replaces the cover's.
  const look = style === "source" ? film.look : null;

  const rd = await readOwn(userId);
  const before = await rd.select({ role: messages.role, content: messages.content }).from(messages)
    .where(and(eq(messages.sessionId, sessionId), lt(messages.createdAt, msg.createdAt ?? new Date())))
    .orderBy(desc(messages.createdAt)).limit(4);
  const userText = before.find((m) => m.role === "user")?.content ?? "";
  const recent = before.reverse().map((m) => `${m.role === "user" ? "Player" : "Story"}: ${storyText(m.content).replace(/\s+/g, " ")}`).join("\n").slice(-2500);

  // The director writes the script: how many shots, where, and which carry on the one before.
  // A card that films itself wrote its own direction, which the director follows.
  const ownShot = SHOT_TAG_RE.exec(msg.content)?.[1]?.trim();
  const directed = await directTurn({
    sessionId, style, look, cast: film.cast, userText, aiText: reply, prevShot: film.prevShot || undefined, prevState: film.state,
    scenes: film.scenes, currentScene: film.currentScene ?? undefined, recent, maxBeats: TURN_FILM_MAX_SHOTS, format: "shot",
    script: ownShot ? { ownShot } : {},
    ...(film.cast.length ? {} : { notes: characterNotes(world.schema) }),
  }, bill);
  const cast = [...film.cast, ...directed.newCast];
  const prev = film.lastClip;
  const plan: PlannedShot[] = directed.beats.map((beat, i) => {
    if (beat.take !== "same") return { beat, after: null, guideKey: null };
    if (i > 0) return { beat, after: i - 1, guideKey: null };
    // The first shot carries on the previous message's last clip in the same scene.
    const continues = prev && prev.messageId !== msg.id && prev.scene === beat.scene && prev.depth < TURN_CLIP_MAX_CHAIN;
    return { beat, after: null, guideKey: continues ? prev.key : null };
  });
  // Each shot's state, path and passage, reported as they change.
  const cells: NonNullable<TurnClipProgress["cells"]> = plan.map(() => "queued");
  const clips: (string | null)[] = plan.map(() => null);
  const texts = plan.map((p) => p.beat.text.slice(0, 600));
  let done = 0;
  const progress = () => onProgress({ shots: plan.length, done, cells: [...cells], clips: [...clips], texts });
  progress();

  // Shots render side by side, TURN_FILM_LANES at a time; one that carries on another waits
  // for it. A shot that fails is left out and the film goes on without it.
  const filmId = crypto.randomUUID();
  let free = TURN_FILM_LANES;
  const waiting: (() => void)[] = [];
  const lane = async () => { while (free === 0) await new Promise<void>((r) => waiting.push(r)); free--; };
  const leave = () => { free++; waiting.shift()?.(); };
  let broke = false;
  const tasks: Promise<RenderedShot | null>[] = [];
  plan.forEach((p, i) => {
    tasks.push((async () => {
      const parent = p.after != null ? await tasks[p.after]! : null;
      const parentDepth = parent ? parent.depth : p.guideKey && prev ? prev.depth : -1;
      // Too deep a chain, or its parent is missing: a new angle instead.
      const guide = (parent || p.guideKey) && parentDepth < TURN_CLIP_MAX_CHAIN ? { assetId: parent?.assetId, key: parent ? parent.key : p.guideKey! } : null;
      await lane();
      try {
        if (broke || !(await canAffordFilm(userId, TURN_SHOT_ESTIMATE_CREDITS))) { broke = true; cells[i] = "failed"; return null; }
        cells[i] = "rendering";
        progress();
        const keepForNext = plan.some((q) => q.after === i);
        const out = await renderShot(userId, sessionId, p.beat, style, look, cast, guide, keepForNext, bill);
        const key = `users/${userId}/${TURN_VIDEO_DIR}/${filmId}-${i}.mp4`;
        await putObject(key, Buffer.from(out.bytes), "video/mp4");
        cells[i] = "done";
        clips[i] = turnVideoPath(key);
        return { key, assetId: out.assetId, depth: out.continued ? parentDepth + 1 : 0, scene: p.beat.scene, shot: p.beat.shot, text: texts[i]! };
      } catch (e) {
        cells[i] = "failed";
        console.warn("[TurnClip] shot failed:", msg.id, i, e instanceof Error ? e.message : e);
        return null;
      } finally {
        leave();
        done++;
        progress();
      }
    })());
  });
  const shots = (await Promise.all(tasks)).filter((s): s is RenderedShot => !!s);
  if (!shots.length) throw new TurnClipError(broke ? "credits" : "unavailable");

  // The reply may have been regenerated, edited or deleted while this rendered; a picture landing
  // meanwhile is fine. The film replaces an older film of the same message.
  const content = await landFilm(userId, msg.id, storyFingerprint(msg.content), shots);
  if (!content) throw new TurnClipError("stale");

  const scenes = [...film.scenes];
  for (const b of directed.beats) {
    if (b.transition === "cut" && b.scene && b.sheet && !scenes.some((sc) => sc.id === b.scene)) scenes.push({ id: b.scene, sheet: b.sheet });
  }
  const last = shots[shots.length - 1]!;
  await setFilmState(sessionId, {
    look: film.look, cast: cast.slice(0, 24), scenes: scenes.slice(-20), currentScene: last.scene, prevShot: last.shot, state: directed.state ?? film.state,
    lastClip: { key: last.key, messageId: msg.id, scene: last.scene, depth: last.depth },
  });
  return { content, credits: bill.credits };
}

/** Shots on the film deployment right now, and how many it has warm (its always-on machines). A
 *  shot past that would wait minutes for another machine to boot, so it goes to the shared pool
 *  instead (no idle cost, starts in seconds); shots that continue or are continued stay on the
 *  deployment, whose assets the pool cannot read. */
let deployShots = 0;
const DEPLOY_WARM_MACHINES = Math.max(1, Number(process.env.REALTIME_FILM_DEPLOY_WARM) || 1);

/** One ~5 s shot: on the film deployment (continuing `guide` when given), else fresh on the shared
 *  pool. Charged at its GPU time. `keep` uploads it back as an asset for the shot that continues it. */
async function renderShot(
  userId: string, sessionId: string, beat: DirectedBeat, style: string, look: string | null, cast: { name: string; look: string }[],
  guide: { assetId?: string; key: string } | null, keep: boolean, bill: FilmBill,
): Promise<{ bytes: ArrayBuffer; assetId?: string; continued: boolean }> {
  let prompt = await clipPrompt({ prompt: pinLooks(beat.shot, cast), style, look: look ?? undefined }, bill);
  const seed = Math.floor(Math.random() * 1e9);
  let clip: { bytes: ArrayBuffer; execMs: number; model: string; jobId: string; assetId?: string; continued: boolean } | null = null;
  if (filmDeployEnabled() && (guide || keep || deployShots < DEPLOY_WARM_MACHINES)) {
    deployShots++;
    try {
      const guideAssetId = guide ? guide.assetId ?? await uploadFilmAsset(new Uint8Array((await getObjectBuffer(guide.key)).buffer), "video/mp4", "guide.mp4") : undefined;
      // Portraits only on a new angle: with a guide they fight the carried-over frames.
      const refs = guideAssetId ? [] : await portraitRefs(userId, sessionId, prompt, true).catch(() => []);
      const images = new Map<string, string>();
      const refFiles = refs.map((r, i) => { const name = `rtv-ref-${i}.jpg`; images.set(name, r.image); return name; });
      const withRefs = refs.length ? `${refs.map((r, i) => `<Picture ${i + 1}> is ${r.name}'s face and hair.`).join(" ")} Clothing and pose follow the description, not the pictures. ${prompt}` : prompt;
      const graph = buildH3Graph({ prompt: withRefs, seed, guide: guideAssetId ? "guide" : undefined, refs: refFiles, preset: "shot" });
      const out = await renderFilmClip(bindFilmAssets(graph, images, guideAssetId), TURN_SHOT_DEPLOY_DEADLINE_MS, keep);
      noteFilmDeployDone();
      clip = { bytes: out.bytes, execMs: out.execMs, model: "comfy-deploy/h3", jobId: out.jobId, assetId: keep ? out.ref.slice("asset:".length) : undefined, continued: !!guideAssetId };
    } catch (e) {
      noteFilmDeployFailed();
      console.warn("[TurnClip] film deployment failed, using the shared pool:", e instanceof Error ? e.message : e);
    } finally {
      deployShots--;
    }
  }
  if (!clip) {
    // The pool cannot read a clip stored by us, so this shot starts fresh.
    const refs = await portraitRefs(userId, sessionId, prompt).catch(() => []);
    if (refs.length) prompt = `${refs.map((r, i) => `<Picture ${i + 1}> is ${r.name}'s face and hair.`).join(" ")} Clothing and pose follow the description, not the pictures. ${prompt}`;
    const out = await renderOnPool(buildH3Graph({ prompt, seed, refs: refs.map((r) => r.image), preset: "shot" }), Date.now() + TURN_SHOT_POOL_DEADLINE_MS);
    clip = { bytes: out.bytes, execMs: out.execMs, model: "comfy/h3", jobId: out.promptId, continued: false };
  }
  // The player pays the GPU time of a shot they get, up to a render's worth; failed renders are on us.
  const billedMs = Math.min(clip.execMs, TURN_SHOT_BILLED_MS_MAX);
  bill.credits += await chargeFilm({
    userId, sessionId, endpoint: "film-clip", model: clip.model,
    costUsd: (billedMs / 1000) * COMFY_USD_PER_GPU_SECOND, referenceId: `film-clip:${clip.jobId}`,
    description: `Scene video — ${(billedMs / 1000).toFixed(1)} GPU s`,
  });
  return { bytes: clip.bytes, assetId: clip.assetId, continued: clip.continued };
}

/** Seconds of fal stream one meter tick may bill (the client ticks every 15 s). */
const FAL_TICK_MAX_SECONDS = 20;
/**
 * The fal stream runs browser-to-fal, so the client meters it: tick 0 before the stream opens
 * pays fal's 60 s minimum, then one tick per ~15 s of streaming after that minute. A 402
 * stops the film. Ticks are idempotent per (run, tick).
 */
realtimeVideoRoutes.post("/realtime-video/fal-meter", async (c) => {
  const userId = c.get("user").id;
  const body = await c.req.json<{ sessionId?: string; run?: string; tick?: number; seconds?: number }>();
  const tick = Math.max(0, Math.floor(Number(body.tick) || 0));
  if (!body.run || !/^[\w-]{8,64}$/.test(body.run)) return c.json({ error: "run required" }, 400);
  const seconds = tick === 0 ? FAL_MIN_SECONDS : Math.min(FAL_TICK_MAX_SECONDS, Math.max(0, Number(body.seconds) || 0));
  const usd = seconds * FAL_USD_PER_SECOND;
  if (!(await canAffordFilm(userId, providerCostUsdToCredits(usd, FILM_MARKUP)))) return c.json(NO_CREDITS, 402);
  const credits = await chargeFilm({
    userId, sessionId: body.sessionId, endpoint: "film-stream", model: "fal/minimax/h3-max/director",
    costUsd: usd, referenceId: `film-fal:${body.run}:${tick}`, description: `Scene video — ${seconds}s of fal stream`,
  });
  return c.json({ credits });
});

export { realtimeVideoRoutes };
