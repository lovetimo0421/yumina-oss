// Short films on fal: FLUX.2 [klein] draws the plates and keyframes, H3 Max Turbo films the shots.
//
// Measured on the Poison in the Bottle card (2026-11-06, same director scripts, two replies of 7-8
// shots): a plate in ~2 s, a keyframe in ~2 s, a 5 s 768p shot with sound in ~4.5 s (queue ~0.5 s),
// so a whole film is filmed in ~7 s once its script is written, against ~5 min for the Comfy H3
// path at the same look. Continuing a shot from the last frame of the one before takes ~4.3 s, less
// than the 5 s it plays, so a continuous take keeps ahead of playback.
//
// fal refuses some prompts and pictures (content_policy_violation). A refused or failed shot falls
// back to the Comfy path in routes/realtime-video.ts, which films what fal will not.

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** List prices (fal, 2026-11-06): H3 Max Turbo $0.04 a second at 768p, $0.025 at 480p; FLUX.2
 *  [klein] 9B edit $0.011 a megapixel (one 1344x768 picture ≈ 1 MP). */
export const FAL_TURBO_USD_PER_SECOND = { "768P": 0.04, "480P": 0.025 } as const;
export const FAL_PICTURE_USD = 0.012;

export const FAL_SHOT_ENDPOINT = "minimax/h3-max-turbo/image-to-video";
export const FAL_PICTURE_ENDPOINT = "fal-ai/flux-2/klein/9b/edit";
export const FAL_PICTURE_T2I_ENDPOINT = "fal-ai/flux-2/klein/9b";

/** Short films go to fal when the server holds a fal key; REALTIME_FILM_FAL=0 keeps them on Comfy. */
export function falFilmEnabled(): boolean {
  return !!process.env.FAL_KEY && process.env.REALTIME_FILM_FAL !== "0";
}

/** fal said no to the content (a prompt or picture its checker flagged, or a prompt its expansion
 *  could not rewrite): the Comfy path films it instead. */
export class FalRefused extends Error {}

type FalDeps = { key?: string; request?: typeof fetch; pollMs?: number };

/** One fal queue request, polled to the end. */
export async function falRun<T>(endpoint: string, input: Record<string, unknown>, deadlineAt: number, deps: FalDeps = {}): Promise<{ res: T; ms: number; requestId: string }> {
  const key = deps.key ?? process.env.FAL_KEY;
  if (!key) throw new Error("FAL_KEY not configured");
  const request = deps.request ?? fetch;
  const headers = { Authorization: `Key ${key}` };
  const started = Date.now();
  const submitted = await request(`https://queue.fal.run/${endpoint}`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(input),
    signal: AbortSignal.timeout(30_000),
  });
  const sub = (await submitted.json().catch(() => ({}))) as { request_id?: string; status_url?: string; response_url?: string; detail?: unknown };
  if (!sub.request_id || !sub.status_url || !sub.response_url) {
    throw refusalOr(`fal ${endpoint} submit ${submitted.status}: ${JSON.stringify(sub).slice(0, 300)}`, sub);
  }
  for (;;) {
    if (Date.now() > deadlineAt) throw new Error(`fal ${endpoint} timed out`);
    await new Promise((r) => setTimeout(r, deps.pollMs ?? 300));
    const st = (await (await request(sub.status_url, { headers, signal: AbortSignal.timeout(15_000) })).json().catch(() => ({}))) as { status?: string };
    if (st.status === "COMPLETED") break;
  }
  const done = await request(sub.response_url, { headers, signal: AbortSignal.timeout(30_000) });
  const res = (await done.json().catch(() => ({}))) as T & { detail?: unknown; error?: unknown };
  if (!done.ok || res.detail || res.error) throw refusalOr(`fal ${endpoint} ${done.status}: ${JSON.stringify(res).slice(0, 300)}`, res);
  return { res, ms: Date.now() - started, requestId: sub.request_id };
}

function refusalOr(message: string, body: unknown): Error {
  const text = JSON.stringify(body ?? "");
  return /content_policy_violation|prompt_expansion_failed|flagged by a content checker/i.test(text) ? new FalRefused(message) : new Error(message);
}

async function download(url: string, request: typeof fetch = fetch): Promise<Uint8Array> {
  const res = await request(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`fal download ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** A picture as fal takes it: a URL it can fetch, or the bytes inline. */
export type FalImage = string;
export const falImageFromBytes = (bytes: Uint8Array, mime = "image/png"): FalImage => `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;

/**
 * One picture from FLUX.2 [klein]: edited from `refs` (images 1..n of the prompt) when there are
 * any, else drawn from the prompt alone. 1344x768, the shots' own size.
 */
export async function falPicture(prompt: string, refs: FalImage[], seed: number, deadlineAt: number, deps: FalDeps = {}): Promise<{ bytes: Uint8Array; url: string; ms: number }> {
  const base = { prompt: prompt.slice(0, 8000), image_size: { width: 1344, height: 768 }, num_images: 1, enable_safety_checker: false, output_format: "png", seed };
  const out = refs.length
    ? await falRun<{ images?: { url: string }[] }>(FAL_PICTURE_ENDPOINT, { ...base, image_urls: refs.slice(0, 4) }, deadlineAt, deps)
    : await falRun<{ images?: { url: string }[] }>(FAL_PICTURE_T2I_ENDPOINT, base, deadlineAt, deps);
  const url = out.res.images?.[0]?.url;
  if (!url) throw new Error("fal picture: no image");
  return { bytes: await download(url, deps.request), url, ms: out.ms };
}

/** One ~5 s shot with sound from H3 Max Turbo, starting on `frame` (a keyframe, or the last frame
 *  of the shot it carries on) when given. */
export async function falShot(args: { prompt: string; frame: FalImage | null; resolution?: "768P" | "480P"; expansion?: "balanced" | "disabled"; deadlineAt: number; deps?: FalDeps }): Promise<{ bytes: Uint8Array; url: string; seconds: number; usd: number; ms: number; requestId: string }> {
  const resolution = args.resolution ?? "768P";
  const out = await falRun<{ video?: { url: string } }>(FAL_SHOT_ENDPOINT, {
    prompt: args.prompt.slice(0, 4000), ...(args.frame ? { image_url: args.frame } : {}), resolution, duration: 5,
    prompt_expansion_mode: args.expansion ?? "balanced", enable_safety_checker: false,
  }, args.deadlineAt, args.deps);
  const url = out.res.video?.url;
  if (!url) throw new Error("fal shot: no video");
  const bytes = await download(url, args.deps?.request);
  const seconds = (await videoSeconds(bytes).catch(() => null)) ?? 5.2;
  return { bytes, url, seconds, usd: seconds * FAL_TURBO_USD_PER_SECOND[resolution], ms: out.ms, requestId: out.requestId };
}

/** Runs ffmpeg/ffprobe on a clip written to a temp folder. */
async function withClip<T>(bytes: Uint8Array, fn: (file: string, dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "yumina-film-"));
  try {
    const file = path.join(dir, "clip.mp4");
    await writeFile(file, bytes);
    return await fn(file, dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** A clip's last frame as a PNG: the first frame of a shot that carries it on. */
export function lastFrame(bytes: Uint8Array): Promise<Uint8Array> {
  return withClip(bytes, async (file, dir) => {
    const png = path.join(dir, "last.png");
    await run("ffmpeg", ["-y", "-loglevel", "error", "-sseof", "-0.1", "-i", file, "-frames:v", "1", "-update", "1", png], { timeout: 30_000 });
    return new Uint8Array(await readFile(png));
  });
}

/** Hard cuts inside a clip (frames that change all at once). A shot is one take: fal's prompt
 *  rewrite still cut about one shot in fifteen into two after asking for one take (2026-11-07). */
export function cutsIn(bytes: Uint8Array): Promise<number> {
  return withClip(bytes, async (file) => {
    const { stderr } = await run("ffmpeg", ["-hide_banner", "-i", file, "-vf", "select='gt(scene,0.35)',showinfo", "-f", "null", "-"], { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
    return (stderr.match(/pts_time/g) ?? []).length;
  });
}

async function videoSeconds(bytes: Uint8Array): Promise<number | null> {
  return withClip(bytes, async (file) => {
    const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { timeout: 15_000 });
    const s = Number(stdout.trim());
    return Number.isFinite(s) && s > 0 ? s : null;
  });
}
