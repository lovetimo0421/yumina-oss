import { createFileRoute, redirect } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Suspense, useEffect } from "react";
import { useEditorStore } from "@/stores/editor";
import { Loader2 } from "lucide-react";
import { getSessionSafe } from "@/lib/auth-client";
import { fetchBlueprintAccess } from "@/lib/blueprint-access";
import { lazyRouteComponent } from "@/lib/lazy-route-component";
import { useUnsavedChangesGuard } from "@/features/editor/use-unsaved-changes-guard";
import { UnsavedChangesDialog } from "@/features/editor/unsaved-changes-dialog";
import { backupEditorDraft } from "@/features/editor/editor-draft-recovery";
import { saveEditorSurface } from "@/lib/editor-surface";
import { EditorUnavailable, useEditorOwnership } from "@/features/editor/editor-unavailable";

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
      if (state.serverWorldId === worldId) backupEditorDraft(state, localStorage);
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

  // However they got here — the switch, a bookmark, the redirect out of
  // /edit — this is now where their cards open. Recorded on arrival rather
  // than only on the switch, so a bookmarked canvas does not keep sending
  // them back to the classic editor on the next card.
  useEffect(() => { saveEditorSurface("visual"); }, []);

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
      <UnsavedChangesDialog blocker={blocker} />
    </>
  );
}

export const Route = createFileRoute("/app/studio/$worldId")({
  beforeLoad: async ({ params }) => {
    const session = await getSessionSafe();
    if (!session.data) throw redirect({ to: "/login" });
    // The blueprint can be switched off server-side (BLUEPRINT_ACCESS). A
    // bookmarked Studio link then lands on the classic editor for the same
    // card rather than on a page the account is not meant to see.
    if (!(await fetchBlueprintAccess())) {
      throw redirect({ to: "/app/worlds/$worldId/edit", params: { worldId: params.worldId } });
    }
  },
  component: StudioPage,
});
