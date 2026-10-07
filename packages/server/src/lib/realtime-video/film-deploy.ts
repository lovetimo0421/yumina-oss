// Scene video clips on our own Comfy API deployment (build "yumina-film": H3 + its LoRAs only),
// which scales out to REALTIME_FILM_DEPLOY_MAX workers instead of queueing behind the shared
// Comfy Cloud pool's per-account limit.
//
// Workers do not share a disk, so a clip that continues the previous one cannot point at that
// clip's output file the way the shared pool does: every rendered clip is uploaded back as a v2
// asset (kept 24 h by the deployment) and the next clip's LoadVideo reads it by id. Frames and
// portraits go in the same way, as assets referenced from LoadImage.

import { env } from "../env.js";

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
interface V2Job {
  id: string;
  status: "queued" | "running" | "succeeded" | "canceling" | "canceled" | "failed" | "expired";
  outputs?: { url: string; name?: string; content_type?: string }[];
  error?: { code?: string; message?: string } | null;
}

/** A clip reference the client sends back as `guide`: an asset on the film deployment. */
export const DEPLOY_REF_RE = /^asset:[A-Za-z0-9_-]{8,80}$/;

export function filmDeployEnabled(): boolean {
  return !!env.REALTIME_FILM_DEPLOY_URL && !!env.COMFY_CLOUD_API_KEY;
}

async function request<T>(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const res = await fetch(`${env.REALTIME_FILM_DEPLOY_URL.replace(/\/$/, "")}${path}`, {
    ...init,
    signal: AbortSignal.timeout(init.timeoutMs ?? 20_000),
    headers: {
      Authorization: `Bearer ${env.COMFY_CLOUD_API_KEY}`,
      ...(init.body && !(init.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) throw new Error(`film deployment ${path.split("?")[0]} ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
  return (await res.json()) as T;
}

/** Upload bytes as a deployment asset; returns its id. */
export async function uploadFilmAsset(bytes: Uint8Array, contentType: string, name: string): Promise<string> {
  // The upload is parsed as a stream: the text fields must come before the file.
  const form = new FormData();
  form.append("file_path", name);
  form.append("content_type", contentType);
  form.append("file", new Blob([bytes], { type: contentType }), name);
  const asset = await request<{ id: string }>("/api/v2/assets", { method: "POST", body: form, timeoutMs: 60_000 });
  return asset.id;
}

const asset = (id: string, name: string) => ({ __type: "core/ASSET", info: { id, file_path: name } });

/** Point the graph's file inputs at deployment assets: LoadImage by its image name, LoadVideo at the guide. */
export function bindFilmAssets(graph: Graph, images: Map<string, string>, guideAssetId?: string): Graph {
  const g = structuredClone(graph);
  for (const node of Object.values(g)) {
    if (node.class_type === "LoadImage" && typeof node.inputs.image === "string" && images.has(node.inputs.image)) {
      node.inputs.image = asset(images.get(node.inputs.image)!, node.inputs.image);
    }
    if (node.class_type === "LoadVideo" && guideAssetId) node.inputs.file = asset(guideAssetId, "guide.mp4");
  }
  return g;
}

/**
 * Run one clip graph and return the mp4, how long it waited for a worker and how long it ran
 * (measured from the status polls: the v2 job carries no timestamps), plus the clip uploaded
 * back as an asset for the next clip to continue from.
 */
export async function renderFilmClip(graph: Graph, deadlineMs = 240_000, keep = true): Promise<{ bytes: ArrayBuffer; queueMs: number; execMs: number; ref: string; jobId: string }> {
  const t0 = Date.now();
  const job = await request<V2Job>("/api/v2/jobs", { method: "POST", body: JSON.stringify({ workflow: graph }) });
  let startedAt = 0;
  let status: V2Job = job;
  while (Date.now() - t0 < deadlineMs) {
    await new Promise((r) => setTimeout(r, 400));
    status = await request<V2Job>(`/api/v2/jobs/${job.id}`);
    if (status.status === "running" && !startedAt) startedAt = Date.now();
    if (["succeeded", "failed", "expired", "canceled"].includes(status.status)) break;
  }
  const doneAt = Date.now();
  if (status.status !== "succeeded") {
    if (!["failed", "expired", "canceled"].includes(status.status)) {
      await request(`/api/v2/jobs/${job.id}/cancel`, { method: "POST" }).catch(() => {});
    }
    throw new Error(status.error?.message || status.error?.code || `clip ${status.status === "queued" || status.status === "running" ? "timed out" : status.status}`);
  }
  const out = (status.outputs ?? []).find((o) => o.content_type?.startsWith("video/") || /\.mp4$/i.test(o.name ?? o.url));
  if (!out) throw new Error("the film deployment returned no clip");
  // The content URL answers only with the key; it redirects to signed storage.
  const file = await fetch(out.url, { headers: { Authorization: `Bearer ${env.COMFY_CLOUD_API_KEY}` }, signal: AbortSignal.timeout(60_000) });
  if (!file.ok) throw new Error(`film deployment output ${file.status}`);
  const bytes = await file.arrayBuffer();
  // Uploaded back so the next clip can continue from it (a warm-up clip is thrown away).
  const assetId = keep ? await uploadFilmAsset(new Uint8Array(bytes), "video/mp4", `rtv-${job.id}.mp4`) : "";
  const begun = startedAt || t0;
  return { bytes, queueMs: Math.max(0, begun - t0), execMs: Math.max(0, doneAt - begun), ref: `asset:${assetId}`, jobId: job.id };
}

// ── Routing between the shared pool and the deployment ──
// The deployment runs no worker while nobody films (min 0), so clips start on the shared
// Comfy Cloud pool. As soon as the pool shows it is filling up (several clips in flight, or
// clips waiting in its queue), a small warm-up job wakes a deployment worker; once a job has
// come back from the deployment, clips go there and keep it warm. Players' experience comes
// first: the wake-up thresholds are low on purpose.
const WAKE_AT_POOL_IN_FLIGHT = 3;
const WAKE_AT_POOL_QUEUE_MS = 5000;
/** How long a worker counts as warm after its last job: measured 2026-10-06, a worker idle for
 *  10 minutes still answered warm (~9 s), and one idle a while longer had shut down (~95 s). */
const WARM_FOR_MS = 8 * 60_000;
let warmUntil = 0;
let waking: Promise<void> | null = null;
let poolInFlight = 0;
let poolQueueMs = 0;

/** A deployment worker answered recently: clips render there. */
export function filmDeployWarm(): boolean {
  return filmDeployEnabled() && Date.now() < warmUntil;
}
export function noteFilmDeployDone(): void {
  warmUntil = Date.now() + WARM_FOR_MS;
}
export function noteFilmDeployFailed(): void {
  warmUntil = 0;
}
export function poolClipStarted(): void {
  poolInFlight++;
}
export function poolClipEnded(queueMs: number | null): void {
  poolInFlight = Math.max(0, poolInFlight - 1);
  if (queueMs != null) poolQueueMs = poolQueueMs * 0.6 + queueMs * 0.4;
}

/** Wake a deployment worker when the shared pool is getting busy (one warm-up at a time). */
export function maybeWakeFilmDeploy(warmupGraph: () => Graph): void {
  if (!filmDeployEnabled() || waking || filmDeployWarm()) return;
  if (poolInFlight < WAKE_AT_POOL_IN_FLIGHT && poolQueueMs < WAKE_AT_POOL_QUEUE_MS) return;
  console.log(`[Film] waking the film deployment (pool: ${poolInFlight} in flight, ~${Math.round(poolQueueMs)} ms queue)`);
  waking = renderFilmClip(warmupGraph(), 600_000, false)
    .then(() => { noteFilmDeployDone(); console.log("[Film] film deployment warm"); })
    .catch((e) => console.warn("[Film] film deployment warm-up failed:", e instanceof Error ? e.message : e))
    .finally(() => { waking = null; });
}
