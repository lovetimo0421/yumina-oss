/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string;
  readonly VITE_CREATOR_HUB_URL?: string;
  readonly VITE_PUBLIC_POSTHOG_PROJECT_TOKEN: string;
  readonly VITE_PUBLIC_POSTHOG_HOST: string;
  readonly VITE_STRIPE_PUBLISHABLE_KEY?: string;
  /** Deploy git SHA, baked in by the Dockerfile (RAILWAY_GIT_COMMIT_SHA). */
  readonly VITE_APP_RELEASE?: string;
  /** "hosted" (default) or "local" — the open-source export sets "local". */
  readonly VITE_EDITION?: "hosted" | "local";
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
