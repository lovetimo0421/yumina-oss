/**
 * Whether this account may open the blueprint (Studio).
 *
 * The blueprint ships as an experimental entry inside the classic editor. Until
 * now the only way to take it away from users was a deploy that removed the
 * button. The server answers `GET /api/studio/access` from the `BLUEPRINT_ACCESS`
 * environment variable (`all` — the default — `admins`, or `off`), so the entry
 * can be narrowed or closed without shipping code. The answer is fetched once
 * per page load and shared; a failed fetch keeps the entry, because a flaky
 * network must not read as "the feature was taken away".
 *
 * The answer now gates which editor a card opens in, so the callers wait on it
 * — which makes a request that never comes back a card that never opens. It is
 * bounded: no answer in a couple of seconds is treated exactly like a failed
 * one, and the real answer still lands in the cache for the next read.
 */
import { useEffect, useState } from "react";

const apiBase = import.meta.env?.VITE_API_URL || "";

let cached: boolean | null = null;
let inflight: Promise<boolean> | null = null;

/** Long enough for a healthy round trip, short enough that nobody watches a
 *  spinner because one endpoint is wedged. */
const ANSWER_TIMEOUT_MS = 2500;

export async function fetchBlueprintAccess(): Promise<boolean> {
  if (cached !== null) return cached;
  if (inflight) return inflight;
  const answered = fetch(`${apiBase}/api/studio/access`, { credentials: "include" })
    .then(async (r) => {
      if (!r.ok) return true;
      const body = (await r.json()) as { data?: { blueprint?: boolean } };
      return body.data?.blueprint !== false;
    })
    .catch(() => true)
    .then((v) => {
      cached = v;
      inflight = null;
      return v;
    });
  // The slow answer is not abandoned — it still resolves `answered` above and
  // fills the cache. This race only stops a caller blocking on it.
  inflight = Promise.race([
    answered,
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), ANSWER_TIMEOUT_MS)),
  ]);
  return inflight;
}

/** Test hook: forget the cached answer. */
export function resetBlueprintAccessCache(): void {
  cached = null;
  inflight = null;
}

/** `true` until the server says otherwise, so the entry never flickers in. */
export function useBlueprintAccess(): boolean {
  const [allowed, setAllowed] = useState<boolean>(cached ?? true);
  useEffect(() => {
    let live = true;
    void fetchBlueprintAccess().then((v) => { if (live) setAllowed(v); });
    return () => { live = false; };
  }, []);
  return allowed;
}
