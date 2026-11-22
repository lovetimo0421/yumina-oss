import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Suspense, useEffect } from "react";
import { saveBeforeLeaving, useEditorStore } from "@/stores/editor";
import { flushPendingEditorFields } from "@/features/editor/components/flush-pending-edits";
import { useExternalWrites } from "@/features/studio/lib/use-external-writes";
import { useCollabPresence } from "@/features/collab/use-collab-presence";
import { Loader2 } from "lucide-react";
import { requireSession } from "@/lib/require-session";
import { fetchBlueprintAccess } from "@/lib/blueprint-access";
import { lazyRouteComponent } from "@/lib/lazy-route-component";
import { useUnsavedChangesGuard } from "@/features/editor/use-unsaved-changes-guard";
import { UnsavedChangesDialog } from "@/features/editor/unsaved-changes-dialog";
import { backupEditorDraft } from "@/features/editor/editor-draft-recovery";
import { useSaveWhenHidden } from "@/features/editor/save-status";
import { EditorUnavailable, useEditorOwnership } from "@/features/editor/editor-unavailable";
import { PendingBundleInstall } from "@/edition/slots";

const StudioShell = lazyRouteComponent(
  () => import("@/features/studio/studio-shell"),
  (m) => m.StudioShell
);

function StudioLoading() {
  const { t } = useTranslation("common");
  return (
    <div className="flex h-full w-full items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-3 text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" />
        <span className="text-sm">{t("loadingStudio")}</span>
      </div>
    </div>
  );
}

function StudioPage() {
  const { worldId } = Route.useParams();
  const { installBundle, focus } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  useSaveWhenHidden(worldId);
  // Saves from other tabs, devices and the assistant land here live.
  const liveWorldId = useEditorStore((s) => (s.serverWorldId === worldId && s.access ? worldId : null));
  useExternalWrites(liveWorldId);
  // Who else has it open (and showing them we do).
  useCollabPresence(liveWorldId);
  const loadWorld = useEditorStore((s) => s.loadWorld);
  const serverWorldId = useEditorStore((s) => s.serverWorldId);
  const loadingWorld = useEditorStore((s) => s.loadingWorld);
  const loadError = useEditorStore((s) => s.loadError);
  const ownership = useEditorOwnership(worldId);
  const isDirty = useEditorStore((s) => s.isDirty || s.layoutDirty);
  const backup = () => {
    const state = useEditorStore.getState();
    if (state.serverWorldId === worldId) backupEditorDraft(state, localStorage);
  };
  const blocker = useUnsavedChangesGuard(isDirty, {
    getIsDirty: () => {
      const state = useEditorStore.getState();
      return state.serverWorldId === worldId && !state.guestMode && !state.readOnlyInspect && (state.isDirty || state.layoutDirty);
    },
    beforeLeave: backup,
  });

  useEffect(() => {
    const flush = () => {
      const state = useEditorStore.getState();
      if (state.serverWorldId !== worldId) return;
      // Text still waiting in a field's typing pause goes in first, or the
      // backup and the last save both miss the last words typed.
      try { flushPendingEditorFields(); } catch { /* fields are on their own */ }
      backupEditorDraft(useEditorStore.getState(), localStorage);
      saveBeforeLeaving();
    };
    const onHidden = () => { if (document.visibilityState === "hidden") flush(); };
    window.addEventListener("beforeunload", flush);
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      flush();
      window.removeEventListener("beforeunload", flush);
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onHidden);
      const state = useEditorStore.getState();
      if (state.serverWorldId === worldId) state.stopAutosave();
      state.releaseDiscardedWorld(worldId);
    };
  }, [worldId]);

  useEffect(() => {
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }, [worldId]);

  useEffect(() => {
    if (serverWorldId !== worldId) {
      loadWorld(worldId);
    }
  }, [worldId, loadWorld, serverWorldId]);

  // `focus`: arrived from 放进我的卡's 去看看; open the thing that landed once the card is loaded.
  const ready = !loadingWorld && serverWorldId === worldId && ownership !== "pending";
  useEffect(() => {
    if (!ready || !focus) return;
    const [kind, ...rest] = focus.split(":");
    const id = rest.join(":");
    if (id && (kind === "entry" || kind === "greeting" || kind === "audio" || kind === "sceneImage")) useEditorStore.getState().focusObject(kind, id);
    void navigate({ search: (prev) => ({ ...prev, focus: undefined }), replace: true });
  }, [ready, focus, navigate]);

  if (loadError && !loadingWorld) {
    return <EditorUnavailable reason={loadError} />;
  }

  if (ownership === "notMine") {
    return <EditorUnavailable reason="notFound" />;
  }

  if (loadingWorld || serverWorldId !== worldId || ownership === "pending") {
    return <StudioLoading />;
  }

  return (
    <>
      <Suspense fallback={<StudioLoading />}>
        <StudioShell />
      </Suspense>
      {installBundle && (
        <PendingBundleInstall
          bundleId={installBundle}
          onDone={() => void navigate({ search: {}, replace: true })}
        />
      )}
      <UnsavedChangesDialog blocker={blocker} />
    </>
  );
}

export const Route = createFileRoute("/app/studio/$worldId")({
  beforeLoad: async ({ params, location }) => {
    await requireSession(location);
    // The blueprint can be switched off server-side (BLUEPRINT_ACCESS). A
    // bookmarked Studio link then lands on the classic editor for the same
    // card rather than on a page the account is not meant to see.
    if (!(await fetchBlueprintAccess())) {
      throw redirect({ to: "/app/worlds/$worldId/edit", params: { worldId: params.worldId } });
    }
  },
  // `installBundle`: arrived from the market's "install into my card"; the
  // pack's install question opens over the card once it has loaded.
  // `focus`: "<entry|greeting|audio|sceneImage>:<id>", the thing to open (放进我的卡's 去看看).
  validateSearch: (search: Record<string, unknown>): { installBundle?: string; focus?: string } => ({
    installBundle: typeof search.installBundle === "string" && search.installBundle ? search.installBundle : undefined,
    focus: typeof search.focus === "string" && /^[\w]+:[\w-]{1,120}$/.test(search.focus) ? search.focus : undefined,
  }),
  component: StudioPage,
});
