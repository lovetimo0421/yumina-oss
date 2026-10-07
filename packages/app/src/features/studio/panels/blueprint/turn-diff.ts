import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { diffGraphs, toGraph, type CardGraph, type GraphDiff, type ToGraphOptions, type WorldDefinition } from "@yumina/engine";
import i18n from "@/lib/i18n";
import { useEditorStore } from "@/stores/editor";
import { useStudioStore } from "@/stores/studio";

/**
 * "What did the AI just do to my card?"
 *
 * The Studio agent applies its writes and then reports them, so the honest
 * contract is not "approve this first" — it is "here is exactly what moved,
 * and here is the way back". The server already snapshots the schema before
 * each write turn, keyed by agent run; diffing that snapshot's graph against
 * the live one turns the turn into something the canvas can point at.
 */

const apiBase = import.meta.env.VITE_API_URL || "";

export interface TurnDiff {
  runId: string;
  snapshotId: string;
  diff: GraphDiff;
}

interface SnapshotRow {
  id: string;
  agentRunId: string | null;
  schemaData?: Record<string, unknown>;
}

/** The most recent agent run that actually wrote something. */
function lastWritingRunId(messages: Array<{ agentRunId?: string; toolCalls?: unknown[] }>): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.agentRunId && m.toolCalls?.length) return m.agentRunId;
  }
  return null;
}

/**
 * `graphOptions` must be the ones the live `graph` was compiled with. The
 * pre-turn snapshot is compiled the same way, or a projection difference (the
 * canvas lists every entry; the default folds plain ones into one summary node)
 * reads as the AI adding and removing things it never touched.
 */
export function useTurnDiff(graph: CardGraph, worldId: string | null, graphOptions?: ToGraphOptions): {
  turn: TurnDiff | null;
  dismiss: () => void;
  restoring: boolean;
  restore: () => Promise<void>;
} {
  const chatMessages = useStudioStore((s) => s.chatMessages);
  const isAgentWorking = useStudioStore((s) => s.isAgentWorking);
  const lastRunId = lastWritingRunId(chatMessages);

  /** Only a turn that actually ran while this canvas was open counts.
   *  Opening an old conversation also loads its run ids, and diffing a
   *  week-old snapshot against today's card would blame that turn for a week
   *  of the author's own edits — and offer to "undo" all of it. Staying quiet
   *  when unsure is the only safe failure for a panel whose whole claim is
   *  that its wires are true. */
  const [sawTurn, setSawTurn] = useState(false);
  useEffect(() => {
    if (isAgentWorking) setSawTurn(true);
  }, [isAgentWorking]);
  const runId = sawTurn ? lastRunId : null;

  /** The pre-turn graph, fetched once per run. Kept in a ref-backed state so a
   *  redraw of the live graph re-diffs without re-fetching. */
  const [baseline, setBaseline] = useState<{ runId: string; snapshotId: string; world: WorldDefinition } | null>(null);
  const [dismissedRunId, setDismissedRunId] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const fetchedFor = useRef<string | null>(null);

  useEffect(() => {
    // Wait for the turn to finish: mid-run the draft is still moving.
    if (!runId || !worldId || isAgentWorking) return;
    if (fetchedFor.current === runId) return;
    fetchedFor.current = runId;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `${apiBase}/api/studio/${worldId}/snapshots?agentRunId=${encodeURIComponent(runId)}&includeSchema=true`,
          { credentials: "include" },
        );
        if (!res.ok) return;
        const body = (await res.json()) as { data?: SnapshotRow[] };
        const row = body.data?.[0];
        if (cancelled || !row?.schemaData) return;
        setBaseline({
          runId,
          snapshotId: row.id,
          world: row.schemaData as unknown as WorldDefinition,
        });
      } catch {
        // A missing snapshot just means no diff to show — never block the canvas.
      }
    })();
    return () => { cancelled = true; };
  }, [runId, worldId, isAgentWorking]);

  const dismiss = useCallback(() => setDismissedRunId(runId), [runId]);

  const restore = useCallback(async () => {
    if (!baseline || !worldId) return;
    setRestoring(true);
    try {
      // Flush unsaved edits first, so the rollback's own snapshot covers them.
      if (useEditorStore.getState().isDirty) {
        const ok = await useEditorStore.getState().saveDraft();
        if (!ok) return;
      }
      const res = await fetch(`${apiBase}/api/studio/${worldId}/rollback/${baseline.snapshotId}`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error(String(res.status));
      await useEditorStore.getState().loadWorld(worldId);
      setDismissedRunId(baseline.runId);
    } catch {
      toast.error(i18n.t("blueprint.turn.undoFailed", { ns: "editor" }));
    } finally {
      setRestoring(false);
    }
  }, [baseline, worldId]);

  // Every derived value here has to be referentially stable: the canvas feeds
  // the turn marks into its node-rebuild effect, so a fresh object per render
  // is an infinite update loop, not a wasted allocation.
  const active = useMemo(
    () => (baseline && baseline.runId === runId && baseline.runId !== dismissedRunId ? baseline : null),
    [baseline, runId, dismissedRunId],
  );
  const turn = useMemo(() => {
    if (!active) return null;
    const diff = diffGraphs(toGraph(active.world, graphOptions), graph);
    return diff.isEmpty ? null : { runId: active.runId, snapshotId: active.snapshotId, diff };
  }, [active, graph, graphOptions]);

  return { turn, dismiss, restoring, restore };
}
