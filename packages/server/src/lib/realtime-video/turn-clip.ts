// A scene-video clip per message (the Comfy film as a picture per turn rather than a stream,
// owner 2026-10-07): the greeting and every reply can get one ~10 s clip with sound, rendered
// in the background (6-8 min, past any request timeout) and appended to the message as
// `[video:/cdn/key/<base64url of users/<uid>/turn-videos/<id>.mp4>]`, the way per-turn
// pictures ride as `[image:…/turn-images/…]` (lib/per-turn-image/illustrate.ts).
//
// Two small records live in Redis (memory when there is none, e.g. local dev):
//   turnclip:job:<messageId>  what the clip for one message is doing, for the client to poll
//   turnclip:film:<sessionId> the film so far: the cover's look, the cast and scenes the director
//                             has named, and the last clip, which the next one may continue

import { redis } from "../redis.js";

export const TURN_VIDEO_DIR = "turn-videos";

const EMBED_RE = /\n*\[\s*video:\s*\/cdn\/key\/([A-Za-z0-9_-]+)[^\]\n]*\]/g;

export function turnVideoEmbed(key: string): string {
  return `[video:${turnVideoPath(key)}|sound]`;
}

/** The public path of a stored shot (or of a film's notes). */
export function turnVideoPath(key: string): string {
  return `/cdn/key/${Buffer.from(key, "utf8").toString("base64url")}`;
}

/** The stored key of a shot from its public path (turnVideoPath), or null. */
export function turnVideoKeyOf(path: string): string | null {
  const m = /^\/cdn\/key\/([A-Za-z0-9_-]+)$/.exec(path);
  if (!m) return null;
  const key = Buffer.from(m[1]!, "base64url").toString("utf8");
  return key.includes(`/${TURN_VIDEO_DIR}/`) ? key : null;
}

/** A film's notes sit next to its shots (`<filmId>-<i>.mp4` → `<filmId>.json`): the passage each
 *  shot films, so the player can see which words are on screen. */
export function turnFilmNotesKey(shotKey: string): string {
  return shotKey.replace(/-\d+\.mp4$/, ".json");
}

/** Removes per-message clip embeds (the model sees earlier replies in history and may copy one). */
export function stripTurnVideos(text: string): string {
  return text.replace(EMBED_RE, (match, b64: string) => {
    try {
      return Buffer.from(b64, "base64url").toString("utf8").includes(`/${TURN_VIDEO_DIR}/`) ? "" : match;
    } catch {
      return match;
    }
  });
}

/** Why a message got no clip. "stale": its text changed while the clip rendered. */
export type TurnClipFailure = "busy" | "credits" | "timeout" | "unavailable" | "stale";

/** Where each shot of a film being made is: waiting for a machine, on one, finished, or left out. */
export type TurnShotState = "queued" | "rendering" | "done" | "failed";

/** How a film being made is coming along, shot by shot (polled by the player, who starts watching
 *  the finished shots at the front while the rest are made). */
export interface TurnClipProgress {
  shots: number;
  done: number;
  cells?: TurnShotState[];
  /** Finished shots' `/cdn/key/…` paths, by shot (null until finished). */
  clips?: (string | null)[];
  /** The passage of the reply each shot films. */
  texts?: string[];
}

export type TurnClipJob =
  /** `sig`: the reply as it was filmed (storyFingerprint), so the shots of a film whose server
   *  died can still land on it, and only if it is unchanged. */
  | ({ status: "rendering"; userId: string; startedAt: number; beat?: number; sig?: string } & Partial<TurnClipProgress>)
  | { status: "done"; userId: string; content: string; credits: number }
  | { status: "failed"; userId: string; reason: TurnClipFailure };

export interface FilmState {
  /** The cover's art style in words; null when the cover could not be read. */
  look: string | null;
  cast: { name: string; look: string }[];
  scenes: { id: string; sheet: string }[];
  currentScene: string | null;
  prevShot: string;
  /** Where things stand at the end of the last filmed reply: the place, the light, and each
   *  person's look, clothing and pose (the director's scene state, carried to the next reply). */
  state?: string;
  /** The newest clip: the next one may continue from its last frames. */
  lastClip: { key: string; messageId: string; scene: string | null; depth: number } | null;
}

const JOB_TTL_S = 3600;
/** A rendering clip's server writes a heartbeat this often while it works. */
export const TURN_CLIP_BEAT_MS = 30_000;

/** A clip whose server stopped beating died with it (a deploy replaced the server mid-render,
 *  2026-10-08): it is reported failed so the player can film again, instead of "rendering" until
 *  the client gives up half an hour later. */
export function turnClipLost(job: TurnClipJob, now = Date.now()): boolean {
  return job.status === "rendering" && now - (job.beat ?? job.startedAt) > 4 * TURN_CLIP_BEAT_MS;
}
const FILM_TTL_S = 14 * 24 * 3600;
const memory = new Map<string, { value: string; until: number }>();

async function get<T>(key: string): Promise<T | null> {
  let raw: string | null = null;
  if (redis) raw = await redis.get(key).catch(() => null);
  else {
    const hit = memory.get(key);
    raw = hit && hit.until > Date.now() ? hit.value : null;
  }
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function put(key: string, value: unknown, ttlS: number): Promise<void> {
  const raw = JSON.stringify(value);
  if (redis) await redis.set(key, raw, "EX", ttlS).catch((e) => console.warn("[TurnClip] redis set failed:", e instanceof Error ? e.message : e));
  else memory.set(key, { value: raw, until: Date.now() + ttlS * 1000 });
}

export const getTurnClipJob = (messageId: string) => get<TurnClipJob>(`turnclip:job:${messageId}`);
export const setTurnClipJob = (messageId: string, job: TurnClipJob) => put(`turnclip:job:${messageId}`, job, JOB_TTL_S);
export const getFilmState = (sessionId: string) => get<FilmState>(`turnclip:film:${sessionId}`);
export const setFilmState = (sessionId: string, state: FilmState) => put(`turnclip:film:${sessionId}`, state, FILM_TTL_S);
