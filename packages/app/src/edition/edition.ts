import { create } from "zustand";

/**
 * Which Yumina this client is talking to.
 *
 *   hosted — yumina.io: hub, community, billing, admin, the works.
 *   local  — the open-source self-hosted build: play, build, library, your
 *            own model keys. Nothing platform-shaped.
 *
 * Two sources, layered:
 *   1. Build time: VITE_EDITION (the open-source export sets "local"). This
 *      picks sensible defaults before the first request and lets tree-shaking
 *      drop hosted-only chunks.
 *   2. Runtime: GET /api/edition, the server's authoritative capability list.
 *      A hosted client pointed at a local server (or the reverse) follows the
 *      server.
 *
 * Core UI never checks hostnames or import.meta.env directly for this; it asks
 * `useFeature("hub")` and friends. Hosted-only components reach core files
 * through `@/edition/slots` only (see that file), which is the seam the
 * open-source export swaps out.
 */
export type EditionName = "hosted" | "local";

export interface EditionFeatures {
  hub: boolean;
  publishing: boolean;
  community: boolean;
  billing: boolean;
  officialModels: boolean;
  achievements: boolean;
  referrals: boolean;
  dm: boolean;
  notifications: boolean;
  reviews: boolean;
  bundles: boolean;
  extensions: boolean;
  multiplayer: boolean;
  imageGeneration: boolean;
  library: boolean;
  sharedPlaythroughs: boolean;
  socialProfiles: boolean;
  admin: boolean;
  telemetry: boolean;
}

export interface EditionInfo {
  edition: EditionName;
  release: string | null;
  features: EditionFeatures;
  auth: { mode: "single-user" | "multi-user"; socialProviders: string[] };
  storage: { kind: "s3" | "local" | "none" };
}

export const BUILD_EDITION: EditionName =
  import.meta.env?.VITE_EDITION === "local" ? "local" : "hosted";
export const IS_LOCAL_BUILD = BUILD_EDITION === "local";

function allFeatures(value: boolean): EditionFeatures {
  return {
    hub: value,
    publishing: value,
    community: value,
    billing: value,
    officialModels: value,
    achievements: value,
    referrals: value,
    dm: value,
    notifications: value,
    reviews: value,
    bundles: value,
    extensions: value,
    multiplayer: value,
    imageGeneration: value,
    library: value,
    sharedPlaythroughs: value,
    socialProfiles: value,
    admin: value,
    telemetry: value,
  };
}

export const DEFAULT_EDITION_INFO: EditionInfo = {
  edition: BUILD_EDITION,
  release: import.meta.env?.VITE_APP_RELEASE ?? null,
  features: allFeatures(!IS_LOCAL_BUILD),
  auth: { mode: IS_LOCAL_BUILD ? "single-user" : "multi-user", socialProviders: [] },
  storage: { kind: IS_LOCAL_BUILD ? "local" : "s3" },
};

type LoadStatus = "idle" | "loading" | "ready" | "error";

interface EditionState {
  info: EditionInfo;
  status: LoadStatus;
  load: () => Promise<EditionInfo>;
}

let inflight: Promise<EditionInfo> | null = null;

export const useEditionStore = create<EditionState>()((set, get) => ({
  info: DEFAULT_EDITION_INFO,
  status: "idle",
  load: async () => {
    if (get().status === "ready") return get().info;
    if (inflight) return inflight;
    set({ status: "loading" });
    inflight = (async () => {
      try {
        const res = await fetch(`${import.meta.env?.VITE_API_URL || ""}/api/edition`, {
          credentials: "include",
          headers: { Accept: "application/json" },
        });
        if (!res.ok) throw new Error(`edition ${res.status}`);
        const body = (await res.json()) as { data?: Partial<EditionInfo> };
        const data = body.data ?? {};
        const info: EditionInfo = {
          ...DEFAULT_EDITION_INFO,
          ...data,
          features: { ...DEFAULT_EDITION_INFO.features, ...(data.features ?? {}) },
          auth: { ...DEFAULT_EDITION_INFO.auth, ...(data.auth ?? {}) },
          storage: { ...DEFAULT_EDITION_INFO.storage, ...(data.storage ?? {}) },
        };
        set({ info, status: "ready" });
        return info;
      } catch {
        // Old servers without /api/edition, or a network blip: keep the
        // build-time defaults. Hosted builds keep behaving as hosted.
        set({ status: "error" });
        return get().info;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  },
}));

/**
 * Resolve the edition once (cached). Safe to call from route loaders.
 *
 * Hosted builds return the build-time defaults at once and refresh from
 * /api/edition in the background: a landing redirect must not pay a round
 * trip, and a hosted client is hosted. Local builds wait, because single-user
 * sign-in and the landing route depend on what the server says.
 */
export function ensureEditionLoaded(): Promise<EditionInfo> {
  const store = useEditionStore.getState();
  if (!IS_LOCAL_BUILD) {
    if (store.status === "idle") void store.load();
    return Promise.resolve(store.info);
  }
  return store.load();
}

/** Non-hook read for stores and helpers. */
export function getEditionInfo(): EditionInfo {
  return useEditionStore.getState().info;
}

export function useEdition(): EditionInfo {
  return useEditionStore((s) => s.info);
}

export function useFeature<K extends keyof EditionFeatures>(feature: K): boolean {
  return useEditionStore((s) => s.info.features[feature]);
}

export function useIsLocalEdition(): boolean {
  return useEditionStore((s) => s.info.edition === "local");
}
