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

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { createRouteHandler } from "@fal-ai/server-proxy/hono";
import { authMiddleware } from "../middleware/auth.js";
import { env } from "../lib/env.js";
import { readOwn } from "../db/index.js";
import { playSessions, user, worlds } from "../db/schema.js";
import type { AppEnv } from "../lib/types.js";
import { resolveImageCdn } from "../lib/cdn-url.js";
import { buildClipGraph, buildH3Graph, CLIP_MODELS, type ClipModel } from "../lib/realtime-video/clip-workflows.js";
import {
  canAffordFilm, CLIP_ESTIMATE_CREDITS, COMFY_USD_PER_GPU_SECOND, FAL_MIN_SECONDS, FAL_USD_PER_SECOND,
  FILM_MARKUP, filmOptedIn, realtimeFilmEnabled, takeFilmCredits, type FilmEndpoint,
} from "../lib/realtime-video/film-billing.js";
import { providerCostUsdToCredits } from "../lib/provider-cost.js";
import { recordUsageLog } from "../lib/usage-log.js";
import {
  bindFilmAssets, DEPLOY_REF_RE, filmDeployWarm, maybeWakeFilmDeploy, noteFilmDeployDone, noteFilmDeployFailed,
  poolClipEnded, poolClipStarted, renderFilmClip, uploadFilmAsset,
} from "../lib/realtime-video/film-deploy.js";

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

async function callDirector(system: string, user: string, maxTokens: number, model = DIRECTOR_MODEL, bill?: FilmBill) {
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
};

const SHOT_RULES = (style: string, format = "temporal") => `Shot rules:
- Every shot starts with this exact sentence: ${STYLES[style] ?? STYLES.live}
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

/** Every shot opens with the style sentence; directors drop it on turn shots, and the stream then
 *  drifts to its default look (live-action turns into anime). */
export function withStyle(shot: string, style = "live"): string {
  const sentence = STYLES[style] ?? STYLES.live ?? "";
  return shot.includes(sentence.slice(0, 48)) ? shot : `${sentence} ${shot.trim()}`;
}

realtimeVideoRoutes.post("/realtime-video/opening", async (c) => {
  const userId = c.get("user").id;
  const body = await c.req.json<{ sessionId?: string; style?: string; beats?: number; greeting?: string; model?: string; format?: string }>();
  if (!body.sessionId || !body.greeting) return c.json({ error: "sessionId and greeting required" }, 400);
  const world = await loadWorldSchema(userId, body.sessionId);
  if (!world) return c.json({ error: "session not found" }, 404);
  const entries = ((world.schema as { entries?: Entry[] }).entries ?? []).filter((e) => e.enabled !== false);
  const characters = entries.filter((e) => e.role === "character" || /外貌|appearance/i.test(e.content ?? ""));
  const lore = characters.map((e) => `## ${e.name}\n${(e.content ?? "").slice(0, 1600)}`).join("\n\n").slice(0, 14000);
  const n = Math.min(10, Math.max(3, Number(body.beats) || 7));
  if (!(await canAffordFilm(userId, 1))) return c.json(NO_CREDITS, 402);
  const bill: FilmBill = { userId, sessionId: body.sessionId, credits: 0 };
  const t0 = Date.now();
  try {
    const out = await callDirector(
      `You direct a realtime video stream for the interactive story "${world.name}". A video model renders one continuous stream, about 8 seconds per shot.

1. "cast": for every named person who appears in the opening or is clearly central, write a one-line English visual description (age, build, hair, eyes, clothing). Base it strictly on the character notes.${body.format === "lock" ? " Make each look unmistakable: name the hair length, colour and cut, eye colour, exact outfit, and give every person one signature detail no one else has (an accessory, a scar, a hair clip) so a video model can tell them apart and keep them the same." : ""} Format: {"name":"…","look":"…"}.
2. "scenes": every distinct place/time in the opening, in order of first appearance. Each = {"id":"S1","sheet": one English paragraph: the place, time of day, light and weather, and who is usually there with their look}.
3. "beats": split the opening text into exactly ${n} consecutive shots in order. Each beat = {"text": the exact passage of the opening this shot films, copied verbatim from its first sentence to its last, "scene": the scene id, "shot": the camera direction}. Consecutive beats continue where the previous one stopped, so together they cover the whole opening with nothing skipped; give a beat more text rather than leave text out. The shot films what its passage says, in the passage's order. When a beat moves to a different scene, its shot starts with "Hard cut to:" followed by that scene's sheet. Exception: if the story gets there by blacking out, fainting, falling asleep or waking up, it is not a hard cut. The beat before ends with the picture slowly fading to black as consciousness goes, and the new scene's shot starts with "Fade in from black:" then blurred, slowly focusing first-person vision of that scene's sheet. Within one scene the beats are one continuous take: each shot starts from where the previous one ended and moves the camera to the new action, with no new establishing description and no jump to another angle. Transitions the story describes (mist filling a room, someone fainting, waking up somewhere) get their own beat, so the film shows how one place leads to the next. Do not merge two different speakers or events into one shot if it makes a character do another character's action. Whatever language the opening is written in, the film is Japanese: when a shot has someone speak, translate their line into natural Japanese and write it in 「」; never copy a line from the opening into a shot untranslated.

${SHOT_RULES(body.style ?? "live", body.format)}

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
    for (const b of beats) if (typeof b?.shot === "string") b.shot = withVoice(withStyle(pinLooks(b.shot, cast), body.style));
    return c.json({ cast, scenes: out.scenes ?? [], beats, coverUrl: resolveImageCdn(world.thumbnailUrl), ms: Date.now() - t0, model: pickModel(body.model, OPENING_MODEL), credits: bill.credits });
  } catch (e) {
    return c.json({ error: String((e as Error).message ?? e) }, 502);
  }
});

realtimeVideoRoutes.post("/realtime-video/shot", async (c) => {
  const userId = c.get("user").id;
  const body = await c.req.json<{
    sessionId?: string;
    style?: string; cast?: { name: string; look: string }[]; userText?: string; aiText?: string; prevShot?: string;
    model?: string; scenes?: SceneCard[]; currentScene?: string; format?: string;
    /** The story just before this turn, so the director knows what is going on. */
    recent?: string;
    /** "start": the reply is still being written, film its first moment.
     *  "rest": the previous shot showed the start of this reply, film what follows. */
    part?: "start" | "rest";
  }>();
  if (!body.aiText) return c.json({ error: "aiText required" }, 400);
  if (!(await canAffordFilm(userId, 1))) return c.json(NO_CREDITS, 402);
  const bill: FilmBill = { userId, sessionId: body.sessionId, credits: 0 };
  const partNote = body.part === "start"
    ? "\n\n(The story reply is still being written; this is its beginning. Film its first visible moment.)"
    : body.part === "rest"
      ? "\n\n(The previous shot already shows the beginning of this reply. Film what happens after it, as the same continuous take unless the reply clearly moves somewhere else.)"
      : "";
  const cast = (body.cast ?? []).map((p) => `- ${p.name}: ${p.look}`).join("\n");
  // The start of a reply still being written gets one shot; a finished reply (or its rest) is
  // cut into shots that together film all of it: about one per three paragraphs, at most four.
  const paragraphs = body.aiText.split(/\n\s*\n/).filter((p) => p.trim().length > 20).length;
  const maxBeats = body.part === "start" ? 1 : Math.min(4, Math.max(1, Math.round(paragraphs / 3)));
  const scenes = (body.scenes ?? []).slice(-20);
  const sceneList = scenes.length ? scenes.map((sc) => `- ${sc.id}: ${sc.sheet}`).join("\n") : "(none yet)";
  const nextId = `S${scenes.length + 1}`;
  const t0 = Date.now();
  try {
    const out = await callDirector(
      `You direct a realtime video stream that follows an interactive story, like a film editor who can intercut storylines. The story just advanced by one turn. Film this turn: cut it into exactly ${maxBeats} consecutive shot${maxBeats > 1 ? "s" : ""} in story order that together show everything visible that happens in it${maxBeats > 1 ? ", splitting the reply into " + maxBeats + " consecutive passages of similar length" : ""}. Each shot films its own passage of the reply, in that passage's order, and does not jump ahead to later events. Shots in the same place are one continuous take: each starts where the previous one ended.

For each shot decide where it happens:
- "continue": still the current scene (${body.currentScene ?? "none"}). This is the same continuous take as the previous shot: same place, same people, same light. Start from what the previous shot ended on and let the camera move (pan, push in, follow) to the new action. No new establishing shot, no jump to a different angle or place, no repeated scene description.
- "cut": a place/time not in the scene list. Give it id "${nextId}" and a sheet (one English paragraph: place, time of day, light and weather, who is there with their look). The shot starts with "Hard cut to:" followed by that sheet; if the story got there by blacking out, sleeping or waking up, it starts with "Fade in from black:" and blurred, slowly focusing first-person vision instead.
- "return": back to a scene already in the list. The shot starts with "Cut back to:" followed by that scene's sheet copied word for word, so it looks the same as before.
Before choosing "cut", check the scene list: if the story is in the same kind of place as a listed scene (the same forest, the same school, the same harbor), it is a "return" to that scene even if time has passed or different people are there. Only a place that matches nothing in the list is a "cut".

${SHOT_RULES(body.style ?? "live", body.format)}

Cast (paste the description of whoever is on screen):
${cast || "(none yet)"}
A named person who is on screen but not in the cast: add them to "newCast" with a one-line English look (age, build, hair, eyes, clothing, one signature detail) taken from the story, and paste that same look in every shot they are in.

Scene list:
${sceneList}

Output JSON only: {"newCast":[{"name":"…","look":"…"}],"beats":[{"passage":"<sentences copied word for word from the story reply: the part this shot films, from its first sentence to its last>","transition":"continue|cut|return","scene":"<scene id>","sheet":"<only for cut>","shot":"<the camera direction, following the shot rules>"}]}
The passage is the story text itself, never the camera direction.`,
      `Story so far (most recent last):
${(body.recent ?? "").slice(-2500) || "(the opening)"}

Previous shot:
${body.prevShot ?? "(none)"}

Player did/said:
${(body.userText ?? "").slice(0, 1500)}

Story reply:
${body.aiText.slice(0, 6000)}${partNote}`,
      5000,
      pickModel(body.model, DIRECTOR_MODEL),
      bill,
    );
    // Older single-shot answers ({shot, transition, …}) still count as one beat.
    const raw = (Array.isArray(out.beats) ? out.beats : [out]) as Record<string, unknown>[];
    let scene = body.currentScene ?? null;
    const known = new Set(scenes.map((sc) => sc.id));
    const isDirection = (t: unknown) => typeof t === "string" && /^\s*(Visual style|Hard cut to|Cut back to|Fade in from black)/i.test(t);
    const beats = raw.map((b) => {
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
      return { text: isDirection(passage) ? "" : passage, shot: String(b.shot), transition, scene: id, sheet: transition === "cut" && typeof b.sheet === "string" ? b.sheet : null };
    });
    if (!beats.length) throw new Error(`the director wrote no shot: ${JSON.stringify(out).slice(0, 600)}`);
    const newCast = (Array.isArray(out.newCast) ? out.newCast : [])
      .filter((p): p is { name: string; look: string } => !!p && typeof p.name === "string" && typeof p.look === "string" && !!p.name && !!p.look)
      .filter((p) => !(body.cast ?? []).some((k) => k.name === p.name))
      .slice(0, 6);
    const everyone = [...(body.cast ?? []), ...newCast];
    for (const b of beats) b.shot = withVoice(withStyle(pinLooks(b.shot, everyone), body.style));
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

realtimeVideoRoutes.post("/realtime-video/clip", async (c) => {
  if (!env.COMFY_CLOUD_API_KEY) return c.json({ error: "COMFY_CLOUD_API_KEY not configured" }, 503);
  const userId = c.get("user").id;
  // The Comfy clip chain is admin-only until H3's picture is good enough to open again (owner, 2026-10-07).
  const rd = await readOwn(userId);
  const [me] = await rd.select({ role: user.role }).from(user).where(eq(user.id, userId)).limit(1);
  if (me?.role !== "admin") return c.json({ error: "Comfy scene video is not open yet." }, 403);
  const body = await c.req.json<{ model?: string; prompt?: string; frame?: string; guide?: string; sessionId?: string; refs?: boolean; seed?: number }>();
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
    maybeWakeFilmDeploy(() => buildH3Graph({ prompt: "Visual style: live-action film. A quiet empty classroom in soft daylight; the camera holds still.", seed: 1 }));
  }
  const bill: FilmBill = { userId, sessionId: body.sessionId, credits: 0 };
  const t0 = Date.now();
  try {
    const seed = body.seed ?? Math.floor(Math.random() * 1e9);
    let prompt = withVoice(await japaneseDialogue(body.prompt.slice(0, 4000), bill));
    let image: string | undefined;
    if (body.frame && !(model === "h3-turbo" && body.guide)) {
      const { bytes, type } = frameBytes(body.frame);
      image = await uploadToComfy(bytes, type, `rtv-${Date.now()}.${type.includes("png") ? "png" : "jpg"}`);
    }
    let refNames: string[] = [];
    let graph;
    if (model === "h3-turbo") {
      const refs = body.refs !== false && body.sessionId ? await portraitRefs(userId, body.sessionId, prompt).catch(() => []) : [];
      refNames = refs.map((r) => r.name);
      if (refs.length) prompt = `${refs.map((r, i) => `<Picture ${i + 1}> is ${r.name}.`).join(" ")} ${prompt}`;
      graph = buildH3Graph({ prompt, seed, frame: image, guide: body.guide, refs: refs.map((r) => r.image) });
    } else {
      graph = buildClipGraph(model, { image: image!, prompt, seconds: 5, seed });
    }
    const sub = await comfy<{ prompt_id?: string }>("/api/prompt", { method: "POST", body: JSON.stringify({ prompt: graph }) });
    if (!sub.prompt_id) throw new Error("no prompt_id");
    const submittedAt = Date.now();
    let status = "";
    while (Date.now() - t0 < 240_000) {
      await new Promise((r) => setTimeout(r, 500));
      status = (await comfy<{ status?: string }>(`/api/job/${sub.prompt_id}/status`)).status ?? "";
      if (["completed", "success", "failed", "error", "cancelled"].includes(status)) break;
    }
    type OutFile = { filename: string; subfolder?: string; type?: string };
    const detail = await comfy<{ outputs?: Record<string, { images?: OutFile[] }>; preview_output?: OutFile; execution_start_time?: number; execution_end_time?: number; execution_error?: { exception_message?: string } }>(`/api/jobs/${sub.prompt_id}`);
    // Saved clips only; a LoadVideo guide also shows up in outputs as an input file.
    const file = Object.values(detail.outputs ?? {}).flatMap((o) => o.images ?? []).find((f) => f.type === "output" && f.filename.endsWith(".mp4")) ?? detail.preview_output;
    if (!["completed", "success"].includes(status) || !file) {
      return c.json({ error: detail.execution_error?.exception_message?.slice(0, 300) || `clip ${status || "timed out"}` }, 502);
    }
    const q = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder ?? "", type: "output" });
    const view = await fetch(`${COMFY_BASE}/api/view?${q}`, { headers: { "X-API-Key": env.COMFY_CLOUD_API_KEY }, redirect: "manual", signal: AbortSignal.timeout(15_000) });
    const location = view.status >= 300 && view.status < 400 ? view.headers.get("location") : null;
    const video = location ? await fetch(location, { signal: AbortSignal.timeout(60_000) }) : view;
    if (!video.ok) return c.json({ error: `download ${video.status}` }, 502);
    const execMs = detail.execution_start_time && detail.execution_end_time ? detail.execution_end_time - detail.execution_start_time : 0;
    poolQueue = detail.execution_start_time ? Math.max(0, detail.execution_start_time - submittedAt) : null;
    const bytes = await video.arrayBuffer();
    // The player pays the GPU time of a clip they get; failed renders are on us.
    bill.credits += await chargeFilm({
      userId, sessionId: body.sessionId, endpoint: "film-clip", model: `comfy/${model}`,
      costUsd: (execMs / 1000) * COMFY_USD_PER_GPU_SECOND, referenceId: `film-clip:${sub.prompt_id}`,
      description: `Scene video — ${(execMs / 1000).toFixed(1)} GPU s`, ms: Date.now() - t0,
    });
    return new Response(bytes, {
      headers: {
        "Content-Type": "video/mp4",
        "X-Clip-Total-Ms": String(Date.now() - t0),
        "X-Clip-Exec-Ms": String(execMs),
        "X-Clip-Queue-Ms": String(detail.execution_start_time ? Math.max(0, detail.execution_start_time - submittedAt) : 0),
        "X-Clip-Ref": file.subfolder ? `${file.subfolder}/${file.filename}` : file.filename,
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
  body: { prompt?: string; frame?: string; guide?: string; sessionId?: string; refs?: boolean; seed?: number },
) {
  const bill: FilmBill = { userId, sessionId: body.sessionId, credits: 0 };
  const t0 = Date.now();
  {
    const seed = body.seed ?? Math.floor(Math.random() * 1e9);
    let prompt = withVoice(await japaneseDialogue(body.prompt!.slice(0, 4000), bill));
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
    const refs = body.refs !== false && body.sessionId ? await portraitRefs(userId, body.sessionId, prompt, true).catch(() => []) : [];
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
