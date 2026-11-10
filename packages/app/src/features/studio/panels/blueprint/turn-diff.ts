import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { diffGraphs, toGraph, type CardGraph, type GraphDiff, type ToGraphOptions, type WorldDefinition } from "@yumina/engine";
import { feedback } from "@/lib/feedback";
import i18n from "@/lib/i18n";
import { draftFromStoredSchema, useEditorStore } from "@/stores/editor";
import { useStudioStore } from "@/stores/studio";

/**
 * "What did the AI just do to my card?"
 *
 * The Studio agent applies its writes and then reports them, so the honest
 * contract is not "approve this first" — it is "here is exactly what moved,
 * and here is the way back". The server already snapshots the schema before
 * each write turn, keyed by agent run; diffing that snapshot's graph against
 * the live one turns the turn into something the canvas can point at.
 *
 * The way back takes back the turn and only the turn. The banner stays up
 * until dismissed, so by the time the author presses undo they may have
 * kept working, and rolling the card back to the snapshot would take that
 * work with it. Undo instead reverts what the assistant changed and the
 * author has not touched since (see engine revertTurn), as one ordinary
 * editor step that Ctrl+Z can take back again.
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
  restore: () => void;
} {
  const chatMessages = useStudioStore((s) => s.chatMessages);
  // The text and defaults the graph leaves out, so a turn that only rewrote
  // a setting or a starting value still shows (and can still be undone).
  const liveEntries = useEditorStore((s) => s.worldDraft.entries);
  const liveVariables = useEditorStore((s) => s.worldDraft.variables);
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
  /** The card as the turn left it — what tells the assistant's changes
   *  (snapshot → here) from the author's (here → now). The Studio pulls the
   *  server's copy into the editor when a run ends, so it is the first server
   *  copy the editor takes in after that. Not the draft at some moment after
   *  the run: the snapshot can arrive before the refresh does, and a draft
   *  taken then is the card without the turn's writes. */
  const afterTurn = useRef<{ runId: string; world: WorldDefinition } | null>(null);
  const [dismissedRunId, setDismissedRunId] = useState<string | null>(null);
  const fetchedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!runId || isAgentWorking || afterTurn.current?.runId === runId) return;
    const held = useEditorStore.getState()._baseSchema;
    const unsubscribe = useEditorStore.subscribe((s) => {
      if (!s._baseSchema || s._baseSchema === held || afterTurn.current?.runId === runId) return;
      afterTurn.current = { runId, world: s._baseSchema };
      unsubscribe();
    });
    return unsubscribe;
  }, [runId, isAgentWorking]);

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
          world: draftFromStoredSchema(row.schemaData, worldId),
        });
      } catch {
        // A missing snapshot just means no diff to show — never block the canvas.
      }
    })();
    return () => { cancelled = true; };
  }, [runId, worldId, isAgentWorking]);

  const dismiss = useCallback(() => setDismissedRunId(runId), [runId]);

  const restore = useCallback(() => {
    if (!baseline) return;
    const editor = useEditorStore.getState();
    // Should the editor never have taken in the turn's result (the refresh
    // failed), the last server copy it holds is the nearest thing to it.
    const end = afterTurn.current?.runId === baseline.runId
      ? afterTurn.current.world
      : editor._baseSchema ?? editor.worldDraft;
    const { reverted, kept } = editor.revertAssistantTurn(baseline.world, end);
    setDismissedRunId(baseline.runId);
    // What the author changed after the turn stayed theirs. They could not
    // see that happen, so say it, once and briefly.
    if (kept > 0) {
      feedback.notice(reverted
        ? i18n.t("blueprint.turn.undoKeptYours", { ns: "editor", count: kept })
        : i18n.t("blueprint.turn.undoAllKept", { ns: "editor" }));
    }
  }, [baseline]);

  // Every derived value here has to be referentially stable: the canvas feeds
  // the turn marks into its node-rebuild effect, so a fresh object per render
  // is an infinite update loop, not a wasted allocation.
  const active = useMemo(
    () => (baseline && baseline.runId === runId && baseline.runId !== dismissedRunId ? baseline : null),
    [baseline, runId, dismissedRunId],
  );
  const turn = useMemo(() => {
    if (!active) return null;
    const diff = diffGraphs(toGraph(active.world, graphOptions), graph, {
      before: active.world,
      after: { entries: liveEntries, variables: liveVariables },
    });
    return diff.isEmpty ? null : { runId: active.runId, snapshotId: active.snapshotId, diff };
  }, [active, graph, graphOptions, liveEntries, liveVariables]);

  return { turn, dismiss, restore };
}
