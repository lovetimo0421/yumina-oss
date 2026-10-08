import { aiDropReason, resolveEffectVariable, type AiDropReason, type ContinuityDecision, type Effect, type GameState, type JevQuestion, type WorldDefinition } from "@yumina/engine";

type Change = { variableId: string; oldValue: unknown; newValue: unknown };

/** Who wrote each value this turn, and which writes never landed. Streamed
 *  with `done` so the studio playtest can say why a value moved or stayed —
 *  every field is something the server actually did, never inferred. */
export interface ChangeTrace {
  version: 1;
  /** Parallel to the payload's `stateChanges`. `ids` are the fired rules. */
  sources: Array<{ kind: "setup" | "ai" | "judge" | "rule" | "settle"; ids?: string[]; via?: "repair" | "guard" | "formula" }>;
  /** AI writes the write filter refused, with the gate that refused them. */
  dropped: Array<{ variableId: string; reason: AiDropReason }>;
  /** AI writes the engine refused as malformed (the old value was kept). */
  rejected: string[];
  /** Root ids the AI wrote at all this turn (kept by the filter). */
  aiWrote: string[];
  /** The continuity judge's per-variable verdicts, applied or not. */
  judge: Array<{ variableId: string; chosen: string | number | boolean | null; confidence: number; applied: boolean; reason?: string }>;
  /** Every question the judge was asked this turn — values, music, sound,
   *  picture — in the card's own words, with the answer it gave. */
  asked: Array<{
    key: string;
    kind: "number" | "boolean" | "string" | "bgm" | "sfx" | "image";
    question: string;
    options: string[];
    chosen: string | number | boolean | null;
    confidence: number;
    applied: boolean;
    reason?: string;
  }>;
}

const rootOf = (id: string) => id.split(/[.[]/)[0]!;

/** Call right after `filterAiEffects`, against the same snapshot. */
export function describeDroppedAiWrites(world: WorldDefinition, state: GameState, dropped: Effect[]): ChangeTrace["dropped"] {
  const out: ChangeTrace["dropped"] = [];
  for (const effect of dropped) {
    const reason = aiDropReason(world, state, effect);
    if (reason) out.push({ variableId: effect.variableId, reason });
  }
  return out;
}

export function buildChangeTrace(args: {
  world?: Pick<WorldDefinition, "variables">;
  repairEffects?: Effect[];
  guardCorrected?: boolean;
  setupCount?: number;
  /** Changes from `applyEffects([...kept, ...judge.effects])`. */
  aiAndJudge: Change[];
  judgeEffects: Effect[];
  kept: Effect[];
  rules: { changes: Change[]; changeCauses: string[][] };
  dropped: ChangeTrace["dropped"];
  rejected: Array<{ variableId: string }>;
  decisions: ContinuityDecision[];
  questions?: Record<string, JevQuestion>;
}): ChangeTrace {
  // The filter drops AI writes to judge-owned variables, so a root id is
  // written by one of the two, never both.
  const resolve = (id: string) => args.world ? resolveEffectVariable(args.world, id)?.id ?? rootOf(id) : rootOf(id);
  const judgeRoots = new Set(args.judgeEffects.map((e) => resolve(e.variableId)));
  const repairRoots = new Set((args.repairEffects ?? []).map((e) => resolve(e.variableId)));
  const formulaRoots = new Set(args.world?.variables.filter(v => v.formula).map(v => v.id));
  const sources: ChangeTrace["sources"] = [
    ...Array.from({ length: args.setupCount ?? 0 }, () => ({ kind: "setup" as const })),
    ...args.aiAndJudge.map((c): ChangeTrace["sources"][number] => {
      const id = resolve(c.variableId);
      if (formulaRoots.has(id)) return { kind: "settle", via: "formula" };
      if (judgeRoots.has(id)) return { kind: "judge" };
      return { kind: "ai", ...(repairRoots.has(id) ? { via: "repair" as const } : args.guardCorrected ? { via: "guard" as const } : {}) };
    }),
    ...args.rules.changes.map((_, i) => {
      const ids = args.rules.changeCauses[i] ?? [];
      return ids.length > 0 ? { kind: "rule" as const, ids } : { kind: "settle" as const };
    }),
  ];
  return {
    version: 1,
    sources,
    dropped: args.dropped,
    rejected: [...new Set(args.rejected.map((w) => w.variableId))],
    aiWrote: [...new Set(args.kept.map((e) => resolve(e.variableId)))],
    judge: args.decisions
      .filter((d) => d.key.startsWith("var__"))
      .map((d) => ({
        variableId: d.key.slice("var__".length),
        chosen: d.chosen, confidence: d.confidence, applied: d.applied,
        ...(d.reason ? { reason: d.reason } : {}),
      })),
    asked: args.decisions.map((d) => {
      const q = args.questions?.[d.key];
      const options = !q?.criteria ? [] : Array.isArray(q.criteria) ? q.criteria : Object.values(q.criteria);
      return {
        key: d.key, kind: d.kind,
        question: (q?.instructions ?? "").slice(0, 400),
        options: options.slice(0, 10).map((o) => String(o).slice(0, 80)),
        chosen: d.chosen, confidence: d.confidence, applied: d.applied,
        ...(d.reason ? { reason: d.reason } : {}),
      };
    }),
  };
}
