/**
 * Learned-ranker serving (recsys Ship 2).
 *
 * The nightly Python trainer (trainer/train.py) publishes a LightGBM model
 * as its `dump_model()` JSON into the `ranker_models` table — but only
 * after it beats the live baseline on a held-out day. This module loads
 * the newest published model and evaluates it in pure TypeScript: walking
 * a few hundred decision trees is sub-millisecond work, so we get learned
 * ranking with zero native dependencies, zero Python in the request path,
 * and zero per-request model cost.
 *
 * Contract with the trainer:
 *  - Numerical splits only (decision_type "<="); the trainer never uses
 *    categorical features. Validated at load — a model that violates the
 *    contract is rejected, never mis-scored.
 *  - Objective decides the output transform: a "regression" model (the
 *    current time-value model) returns its RAW summed leaf value (predicted
 *    log1p-minutes); a legacy "binary" model gets a sigmoid → P(click). The
 *    kind is read from the model dump's `objective`, so old published rows
 *    keep scoring correctly.
 *  - Features are matched BY NAME from `feature_names`, so trainer and
 *    server can evolve the feature set independently; a feature the
 *    server can't produce scores as 0 (and warns once).
 */

import { sql } from "drizzle-orm";
import type { Database } from "../db/index.js";

// ─── LightGBM dump_model() JSON shapes (subset we use) ───────────────

interface LgbLeaf {
  leaf_value: number;
}

interface LgbInnerNode {
  split_feature: number;
  threshold: number;
  decision_type: string;
  default_left: boolean;
  left_child: LgbNode;
  right_child: LgbNode;
}

type LgbNode = LgbInnerNode | LgbLeaf;

interface LgbTree {
  tree_structure: LgbNode;
}

interface LgbModelJson {
  objective?: string;
  feature_names?: string[];
  tree_info: LgbTree[];
}

function isLeaf(node: LgbNode): node is LgbLeaf {
  return (node as LgbLeaf).leaf_value !== undefined && (node as LgbInnerNode).split_feature === undefined;
}

/** Validate every node uses the numerical "<=" contract. Throws otherwise. */
function validateTree(node: LgbNode): void {
  if (isLeaf(node)) return;
  if (node.decision_type !== "<=") {
    throw new Error(`unsupported decision_type "${node.decision_type}" — trainer contract is numerical-only`);
  }
  validateTree(node.left_child);
  validateTree(node.right_child);
}

function walkTree(node: LgbNode, features: Float64Array): number {
  let current = node;
  while (!isLeaf(current)) {
    const value = features[current.split_feature];
    const goLeft = value === undefined || Number.isNaN(value)
      ? current.default_left
      : value <= current.threshold;
    current = goLeft ? current.left_child : current.right_child;
  }
  return current.leaf_value;
}

/** binary: sigmoid → P(click). regression: raw log1p(minutes). tweedie:
 * exp(raw) → expected minutes (the zero-inflated time-value objective). */
export type RankerModelKind = "binary" | "regression" | "tweedie";

export interface RankerModelHandle {
  id: number;
  featureNames: string[];
  /** "regression" (time-value model) → predict() returns raw log1p-minutes;
   * "binary" (legacy click model) → predict() returns P(click). */
  kind: RankerModelKind;
  /** Regression only: average predicted minutes over the trainer's eval set —
   * the baseline the serving lift is a ratio against (see engagement.ts).
   * 0 for binary models. */
  valueBaseline: number;
  /** binary → P(click) via sigmoid; regression → raw predicted value
   * (log1p-minutes; caller applies expm1). Missing features default to 0. */
  predict(featuresByName: Record<string, number>): number;
}

const warnedMissingFeatures = new Set<string>();

export function buildRankerModel(
  id: number,
  modelJson: LgbModelJson,
  featureNames: string[],
  valueBaseline = 0,
): RankerModelHandle {
  if (!Array.isArray(modelJson.tree_info) || modelJson.tree_info.length === 0) {
    throw new Error("model has no trees");
  }
  for (const tree of modelJson.tree_info) validateTree(tree.tree_structure);
  const names = featureNames.length > 0 ? featureNames : (modelJson.feature_names ?? []);
  if (names.length === 0) throw new Error("model has no feature names");
  const indexByName = new Map(names.map((n, i) => [n, i] as const));
  const trees = modelJson.tree_info.map((t) => t.tree_structure);
  // LightGBM dumps "regression" for the LGBMRegressor and "binary sigmoid:1"
  // for the old classifier — so legacy rows (and any future binary model)
  // still get the sigmoid, and only regression models return raw.
  const objective = modelJson.objective ?? "";
  const kind: RankerModelKind = objective.startsWith("tweedie") ? "tweedie"
    : objective.startsWith("regression") ? "regression"
    : "binary";

  return {
    id,
    featureNames: names,
    kind,
    valueBaseline,
    predict(featuresByName: Record<string, number>): number {
      const vec = new Float64Array(names.length);
      for (const [name, value] of Object.entries(featuresByName)) {
        const idx = indexByName.get(name);
        if (idx === undefined) {
          if (!warnedMissingFeatures.has(name)) {
            warnedMissingFeatures.add(name);
            console.warn(`[ranker] server produced unknown feature "${name}" (model id ${id}) — ignored`);
          }
          continue;
        }
        vec[idx] = Number.isFinite(value) ? value : 0;
      }
      let raw = 0;
      for (const tree of trees) raw += walkTree(tree, vec);
      if (kind === "regression") return raw;
      if (kind === "tweedie") return Math.exp(raw);
      return 1 / (1 + Math.exp(-raw));
    },
  };
}

// ─── Loader (process-cached, cheap DB poll) ──────────────────────────

const MODEL_POLL_INTERVAL_MS = 5 * 60 * 1000;

let cachedHandle: RankerModelHandle | null = null;
let cachedHeadId: number | null = null;
let lastPollAt = 0;
let loadFailedForId: number | null = null;

/**
 * Newest published model, or null when none exists / it fails validation.
 * Polls the DB head id at most every 5 minutes; the full (multi-MB) model
 * row is fetched and parsed only when the head id changes. All failures
 * degrade to null → engage_v2 falls back to engage_v1 scoring.
 */
export async function loadPublishedRankerModel(db: Database): Promise<RankerModelHandle | null> {
  const now = Date.now();
  if (now - lastPollAt < MODEL_POLL_INTERVAL_MS) {
    return cachedHandle;
  }
  lastPollAt = now;

  // Hoisted so the catch can record the id that ACTUALLY failed (it lives in
  // the try otherwise, so the old catch stored cachedHeadId — the last GOOD
  // id — and the "don't re-parse a known-bad model" guard never matched,
  // re-fetching + re-parsing the multi-MB bad row on every 5-min poll).
  let headId: number | null = null;
  try {
    const head = await db.execute(sql`
      SELECT id FROM ranker_models WHERE status = 'published' ORDER BY id DESC LIMIT 1
    `);
    const headRow = (head as unknown as { rows?: Array<{ id?: unknown }> }).rows?.[0];
    headId = headRow ? Number(headRow.id) : null;

    if (headId === null) {
      cachedHandle = null;
      cachedHeadId = null;
      return null;
    }
    if (headId === cachedHeadId) return cachedHandle;
    if (headId === loadFailedForId) return cachedHandle; // don't re-parse a known-bad model every poll

    const full = await db.execute(sql`
      SELECT id, model, feature_names, metrics FROM ranker_models WHERE id = ${headId}
    `);
    const row = (full as unknown as { rows?: Array<Record<string, unknown>> }).rows?.[0];
    if (!row) return cachedHandle;

    const modelJson = (typeof row.model === "string" ? JSON.parse(row.model) : row.model) as LgbModelJson;
    const featureNames = (typeof row.feature_names === "string"
      ? JSON.parse(row.feature_names)
      : row.feature_names) as string[];
    // value_baseline_min (regression models only) — the average predicted
    // minutes the serving lift is a ratio against. Absent for legacy binary
    // models; buildRankerModel ignores it for those.
    const metrics = (typeof row.metrics === "string" ? JSON.parse(row.metrics) : row.metrics) as
      | { value_baseline_min?: number }
      | null;
    const valueBaseline = Number(metrics?.value_baseline_min) || 0;

    cachedHandle = buildRankerModel(headId, modelJson, featureNames ?? [], valueBaseline);
    cachedHeadId = headId;
    loadFailedForId = null;
    console.log(`[ranker] loaded published model id=${headId} (${cachedHandle.featureNames.length} features)`);
    return cachedHandle;
  } catch (err) {
    // Table missing (pre-DDL env) or invalid model — keep whatever we had.
    // Record the id that FAILED (not the last-good one) so the guard above
    // skips re-parsing it next poll; warn once per distinct bad id (so a
    // NEW bad publish still surfaces instead of being silently swallowed).
    if (loadFailedForId !== headId) {
      console.warn(`[ranker] model load failed for id=${headId ?? "?"} (engage_v2 degrades to v1):`, err instanceof Error ? err.message : err);
    }
    loadFailedForId = headId ?? -1;
    return cachedHandle;
  }
}

/** Test helper: reset the process cache. */
export function __resetRankerModelCache(): void {
  cachedHandle = null;
  cachedHeadId = null;
  lastPollAt = 0;
  loadFailedForId = null;
}
