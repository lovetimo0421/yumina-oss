import { useGuestSessionStart } from "./use-guest-session-start";
import { useState, useEffect, useMemo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useRouter } from "@tanstack/react-router";
import { ArrowLeft, Loader2, LogIn } from "lucide-react";
import { useAuthGuard } from "@/hooks/use-auth-guard";
import { TopBarAccountControls } from "@/components/layout/top-bar";
import { GuestWorldStage, isGeneratedDefaultChatRoot, resolveGuestPreviewRootComponent } from "./guest-world-stage";
import type { WorldDefinition } from "@yumina/engine";
import { safeParseWorldDef } from "@/lib/utils";
import { navigateToStoryReturn, type StoryReturnContext } from "@/lib/story-return";
import { CARD_CODE_REQUEST_HEADERS } from "@yumina/shared";

const apiBase = import.meta.env.VITE_API_URL || "";

interface WorldData {
  id: string;
  name: string;
  description: string | null;
  thumbnailUrl: string | null;
  schema: WorldDefinition;
}

/**
 * Client-side world preview for guests.
 * Fetches the world schema from the public API and renders the full chat UI
 * (greeting, widgets, custom components) inside a sandboxed iframe.
 * All interactive actions are gated behind authentication.
 */
export function WorldPreview({
  worldId,
  returnContext,
}: {
  worldId: string;
  returnContext: StoryReturnContext;
}) {
  const { t } = useTranslation("chat");
  const router = useRouter();
  const { requireAuth, isAuthenticated } = useAuthGuard();
  const [world, setWorld] = useState<WorldData | null>(null);
  const [loading, setLoading] = useState(true);
  const handleBack = useCallback(() => {
    navigateToStoryReturn(router.history, returnContext);
  }, [returnContext, router.history]);

  // ── Fetch world schema ──────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${apiBase}/api/worlds/${worldId}`, {
          credentials: "include",
          headers: CARD_CODE_REQUEST_HEADERS,
        });
        if (res.ok) {
          const { data } = await res.json();
          setWorld(data);
        }
      } catch {
        // silent
      } finally {
        setLoading(false);
      }
    })();
  }, [worldId]);

  const { startError, retryStart } = useGuestSessionStart(isAuthenticated && world?.id === worldId, worldId, returnContext);

  // ── Derived data (ALL hooks before any early return) ────────────
  const worldDef = useMemo<WorldDefinition | undefined>(
    () => safeParseWorldDef(world?.schema),
    [world?.schema],
  );

  // Every world is v2 with rootComponent (migrateWorldDefinition guarantees it).
  // Guest preview also repairs the legacy edge case where a default rootComponent
  // masks an older customUI card in the public schema.
  const rootComponent = useMemo(
    () => resolveGuestPreviewRootComponent(worldDef, world?.schema),
    [worldDef, world?.schema],
  );
  const isDefaultChatPreview = isGeneratedDefaultChatRoot(rootComponent);
  const requestSignIn = useCallback(() => { requireAuth("continue the story"); }, [requireAuth]);

  const characterName = useMemo(() => {
    if (!worldDef) return "";
    return worldDef.characters?.[0]?.name ?? world?.name ?? "AI";
  }, [worldDef, world?.name]);

  // World preview renders via v2 WorldRenderer (same path as real play).
  // extraProps / canvasMode existed only for the deleted v1 SandboxedRenderer.

  // ── Early returns (all hooks are above) ─────────────────────────
  if (loading) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground/40" />
      </div>
    );
  }

  if (!world || !worldDef) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-4">
        <p className="text-sm text-muted-foreground/50">{t("preview.worldNotFound")}</p>
        <button
          onClick={handleBack}
          className="text-sm text-primary hover:underline"
        >
          {t("replay.back")}
        </button>
      </div>
    );
  }

  if (startError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-6" role="alert">
        <p>{t("failedStartSession", { ns: "toasts" })}</p>
        <button className="rounded-lg bg-primary px-4 py-2 text-primary-foreground" onClick={retryStart}>{t("action.retry", { ns: "common" })}</button>
        <button className="px-4 py-2 text-primary" onClick={handleBack}>{t("replay.back")}</button>
      </div>
    );
  }

  // ── Shared sign-up banner (consistent across all preview modes) ──
  const signUpBanner = (
    <div
      className="shrink-0 z-50 flex items-center justify-center gap-3 border-t border-white/10 bg-[#0C0C0E]/95 px-4 pt-3 backdrop-blur-md"
      style={{ paddingBottom: "calc(0.75rem + var(--mobile-safe-bottom))" }}
    >
      <button
        onClick={() => requireAuth("continue playing")}
        className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
      >
        <LogIn className="h-3.5 w-3.5" />
        {t("preview.signUpToPlay")}
      </button>
    </div>
  );

  const previewHeader = (
    <div className="play-header-shell shrink-0 border-b border-border">
      <div className="play-header-inner play-preview-header">
        <div className="play-header-leading">
          <button
            onClick={handleBack}
            aria-label={t("replay.back")}
            title={t("replay.back")}
            className="play-header-icon-button hover-surface rounded-md text-muted-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="play-header-title-group min-w-0 flex-1 overflow-hidden">
            <h2 className="play-header-title truncate text-[0.95rem] font-medium text-foreground">{world.name}</h2>
            <p className="play-header-subtitle truncate text-xs text-muted-foreground/50">{characterName}</p>
          </div>
        </div>
        <div className="play-header-account">
          <TopBarAccountControls />
        </div>
      </div>
    </div>
  );

  // Every world renders through the v2 rootComponent pipeline — same runtime
  // as real play. Legacy v1 fullscreen/canvas forks were deleted in phase 5.
  if (!rootComponent) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
        {world.name} has no rootComponent. Schema may be corrupted.
      </div>
    );
  }

  if (isDefaultChatPreview) {
    return (
      <div className="play-page-root flex h-full w-full flex-col overflow-hidden">
        {previewHeader}
        <div className="flex min-h-0 flex-1 items-center justify-center bg-[#0D0E11] p-6">
          <div className="flex max-w-sm flex-col items-center gap-4 text-center">
            <p className="text-sm text-muted-foreground">{t("preview.signInToSend")}</p>
            <button
              onClick={() => requireAuth("continue playing")}
              className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
            >
              <LogIn className="h-3.5 w-3.5" />
              {t("preview.signUpToStart")}
            </button>
          </div>
        </div>
        {signUpBanner}
      </div>
    );
  }

  return (
    <div className="play-page-root flex h-full w-full flex-col overflow-hidden">
      {previewHeader}
      <GuestWorldStage
        worldDef={worldDef}
        rootComponent={rootComponent}
        worldId={worldId}
        worldName={world.name}
        worldCover={world.thumbnailUrl}
        onLlmRequest={requestSignIn}
        className="flex-1 min-h-0"
      />
      {signUpBanner}
    </div>
  );
}
