import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Suspense, useEffect, useReducer, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useEditorStore } from "@/stores/editor";
import { lazyRouteComponent } from "@/lib/lazy-route-component";
import { getEditorMode, getGlobalEditorMode } from "@/features/editor/lib/editor-mode";
import { useUnsavedChangesGuard } from "@/features/editor/use-unsaved-changes-guard";
import { UnsavedChangesDialog } from "@/features/editor/unsaved-changes-dialog";
import { backupEditorDraft } from "@/features/editor/editor-draft-recovery";
import { navigateBackSafely } from "@/lib/safe-back";
import { resolveEditorMode } from "@/features/editor/editor-entry";
import { fetchBlueprintAccess } from "@/lib/blueprint-access";
import { getEditorSurface, shouldOpenVisual } from "@/lib/editor-surface";

const QuickCreateEditor = lazyRouteComponent(
  () => import("@/features/editor/quick-create-editor"),
  (m) => m.QuickCreateEditor
);

/** Advanced mode has two surfaces: the blueprint canvas and this editor.
 *
 *  The canvas is the one a card opens on now (see `shouldOpenVisual`), and
 *  this shell is what the 画布 pill (turned off) drops you back to. That makes this a
 *  real destination rather than a fallback: a phone always lands here, so does
 *  anyone who turned the switch off, and the module page carries a module's
 *  AI, memory and context the same as it always did. */
const EditorShell = lazyRouteComponent(
  () => import("@/features/editor/editor-shell"),
  (m) => m.EditorShell
);

function WorldEditPage() {
  const { worldId } = Route.useParams();
  const router = useRouter();
  const loadWorld = useEditorStore((s) => s.loadWorld);
  const loadingWorld = useEditorStore((s) => s.loadingWorld);
  const serverWorldId = useEditorStore((s) => s.serverWorldId);
  const editorMode = useEditorStore((s) => s.worldDraft.editorMode);
  const isDirty = useEditorStore((s) => s.isDirty);
  const saving = useEditorStore((s) => s.saving);
  const guestMode = useEditorStore((s) => s.guestMode);
  // The mode is read from this card's local choice first, which the store
  // cannot see: when the draft's own field already holds the value a switch
  // writes (it reaches the server only with the next real save), setField
  // changes nothing and this page would keep showing the editor just left.
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  // null while the answer is in flight. The world fetch below is a round trip
  // of its own and holds the spinner anyway, so waiting for this costs nothing
  // in practice — and deciding without it would flash the wrong editor.
  const [blueprintAllowed, setBlueprintAllowed] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void fetchBlueprintAccess().then((v) => { if (live) setBlueprintAllowed(v); });
    return () => { live = false; };
  }, []);

  // Block SPA navigation + browser close when there are unsaved changes.
  // Like Studio, leave a local copy behind at that moment: the debounced
  // recovery write can be up to two seconds behind the last edit.
  const blocker = useUnsavedChangesGuard(isDirty, {
    getIsDirty: () => useEditorStore.getState().isDirty,
    beforeLeave: () => {
      const state = useEditorStore.getState();
      if (state.serverWorldId === worldId) backupEditorDraft(state, localStorage);
    },
  });

  // Set when the redirect to the canvas was stopped by the leave guard and
  // the creator chose to stay. The editor renders here instead — without it
  // the page kept its spinner up with nothing left to take it down.
  const [visualDeclined, setVisualDeclined] = useState(false);
  const redirectAttempted = useRef(false);
  const redirectHeld = useRef(false);
  useEffect(() => {
    setVisualDeclined(false);
    redirectAttempted.current = false;
    redirectHeld.current = false;
  }, [worldId]);

  useEffect(() => {
    if (useEditorStore.getState().serverWorldId !== worldId) void loadWorld(worldId);
    return () => {
      const state = useEditorStore.getState();
      state.stopAutosave();
      state.releaseDiscardedWorld(worldId);
    };
  }, [worldId, loadWorld]);

  const mode = !loadingWorld && serverWorldId === worldId
    ? resolveEditorMode(editorMode, getEditorMode(worldId), getGlobalEditorMode())
    : null;

  // Opening a card lands on the canvas unless the creator turned the 画布
  // switch off. `replace` so the way back out of Studio is not this route
  // bouncing them straight back in.
  const toVisual = mode !== null && blueprintAllowed !== null && shouldOpenVisual({
    mode,
    last: getEditorSurface(),
    allowed: blueprintAllowed,
    guest: guestMode,
  });

  const redirecting = toVisual && !visualDeclined;

  useEffect(() => {
    // A save in flight (the simple editor's 画布 pill saves on its way
    // out) clears the dirty flag when it lands; going before that would only
    // be stopped by the leave guard. One attempt per visit: the guard's
    // dialog owns the outcome after that.
    if (!redirecting || saving || redirectAttempted.current) return;
    redirectAttempted.current = true;
    void router.navigate({ to: "/app/studio/$worldId", params: { worldId }, replace: true });
  }, [redirecting, saving, worldId, router]);

  // A navigation the guard holds never settles its promise, so the outcome is
  // read off the blocker instead: blocked, then idle again with this editor
  // still in the address bar, means they chose to stay. "Leave" and "save and
  // leave" change the URL before the timer runs.
  useEffect(() => {
    if (!redirecting || !redirectAttempted.current) return;
    if (blocker.status === "blocked") { redirectHeld.current = true; return; }
    if (!redirectHeld.current) return;
    redirectHeld.current = false;
    const timer = setTimeout(() => {
      if (window.location.pathname.endsWith(`/worlds/${worldId}/edit`)) setVisualDeclined(true);
    }, 0);
    return () => clearTimeout(timer);
  }, [blocker.status, redirecting, worldId]);

  // Show the spinner while loading, before the correct world is in the store,
  // and while the redirect above is on its way — rendering this editor for a
  // frame first is a visible flash of the surface they are leaving. The
  // leave dialog renders here too: a redirect the guard stops has to be able
  // to ask, or it waits on an answer nobody can give.
  if (loadingWorld || serverWorldId !== worldId || mode === null || blueprintAllowed === null || redirecting) {
    return (
      <>
        <LoadingSpinner />
        <UnsavedChangesDialog blocker={blocker} />
      </>
    );
  }

  const back = () => {
    navigateBackSafely(
      router.history,
      `/app/library?worldId=${encodeURIComponent(worldId)}`,
    );
  };

  // Both modes write editorMode rather than navigating: the draft is already
  // loaded, and a route change here would re-enter the load/guard cycle for a
  // card that never left the store.
  return (
    <>
      <Suspense fallback={<LoadingSpinner />}>
        {mode === "simple" ? (
          <QuickCreateEditor
            onOpenFullEditor={() => { useEditorStore.getState().setField("editorMode", "advanced"); rerender(); }}
            onBack={back}
          />
        ) : (
          <EditorShell
            onBack={back}
            onSwitchToSimple={() => { useEditorStore.getState().setField("editorMode", "simple"); rerender(); }}
          />
        )}
      </Suspense>
      <UnsavedChangesDialog blocker={blocker} />
    </>
  );
}

export const Route = createFileRoute("/app/worlds/$worldId/edit")({
  component: WorldEditPage,
});

function LoadingSpinner() {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground/40" />
    </div>
  );
}
