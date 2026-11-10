import type { PlayModel, YuminaModel } from "./models.js";

// ─── Model families ──────────────────────────────────────────────────
// Versions of one series that cost the same show as a single row in the Play
// and Studio pickers, with a version switch inside the row. Saved selections, pins, pools
// and billing stay per model id; a family is only how the list is drawn.
//
// Members are listed newest first, each with the short label its chip shows.
// A member only joins its family's row when it matches the first member's
// price, tier and plan; one that drifts (a price change upstream) falls back to
// a row of its own instead of hiding a different cost behind the same row.
// One series at two prices is two entries with the same name (two rows).

export interface PickerModelFamily {
  name: string;
  members: ReadonlyArray<readonly [id: string, label: string]>;
}

export const PICKER_MODEL_FAMILIES: readonly PickerModelFamily[] = [
  { name: "Claude Opus", members: [["anthropic/claude-opus-5", "5"], ["anthropic/claude-opus-4.8", "4.8"], ["anthropic/claude-opus-4.7", "4.7"], ["anthropic/claude-opus-4.6", "4.6"], ["anthropic/claude-opus-4.5", "4.5"]] },
  { name: "Claude Sonnet", members: [["anthropic/claude-sonnet-5.5", "5.5"], ["anthropic/claude-sonnet-5", "5"]] },
  { name: "Claude Sonnet", members: [["anthropic/claude-sonnet-4.6", "4.6"], ["anthropic/claude-sonnet-4.5", "4.5"]] },
  { name: "GPT Sol", members: [["openai/gpt-6.1-sol", "6.1"], ["openai/gpt-6-sol", "6"], ["openai/gpt-5.6-sol", "5.6"]] },
  { name: "Grok", members: [["x-ai/grok-4.7", "4.7"], ["x-ai/grok-4.6", "4.6"], ["x-ai/grok-4.5", "4.5"]] },
  { name: "Grok", members: [["x-ai/grok-4.3", "4.3"], ["x-ai/grok-4.20", "4.20"]] },
  { name: "Gemini Flash", members: [["google/gemini-3.7-flash", "3.7"], ["google/gemini-3.6-flash", "3.6"]] },
];

/** What grouping reads: Studio-only models have no tier or plan, which compare equal. */
export type GroupableModel = Pick<YuminaModel, "id" | "name" | "inputPrice" | "outputPrice" | "tier" | "minPlan">;

export interface ModelVariant<M extends GroupableModel = PlayModel> {
  model: M;
  label: string;
}

export interface ModelGroup<M extends GroupableModel = PlayModel> {
  /** Stable React key: `family:` + the lead version's id, or the model id for a lone model. */
  key: string;
  /** Family name, or the model's own name when it stands alone. */
  name: string;
  /** Newest first. A lone model is a group of one. */
  variants: ModelVariant<M>[];
}

export type PlayModelVariant = ModelVariant<PlayModel>;
export type PlayModelGroup = ModelGroup<PlayModel>;

const sameOffer = (a: GroupableModel, b: GroupableModel) =>
  a.inputPrice === b.inputPrice && a.outputPrice === b.outputPrice && a.tier === b.tier && a.minPlan === b.minPlan;

/** Folds same-price versions of a series into one group. Order follows the
 *  input: a family sits where its first listed member would have. */
export function groupPlayModels<M extends GroupableModel>(models: readonly M[]): ModelGroup<M>[] {
  const byId = new Map(models.map((m) => [m.id, m]));
  const familyOf = new Map<string, { family: PickerModelFamily; variants: ModelVariant<M>[] }>();
  for (const family of PICKER_MODEL_FAMILIES) {
    const present = family.members.flatMap(([id, label]) => {
      const model = byId.get(id);
      return model ? [{ model, label }] : [];
    });
    const lead = present[0];
    if (!lead) continue;
    const variants = present.filter((v) => sameOffer(v.model, lead.model));
    if (variants.length < 2) continue;
    const entry = { family, variants };
    for (const v of variants) familyOf.set(v.model.id, entry);
  }

  const groups: ModelGroup<M>[] = [];
  const placed = new Set<PickerModelFamily>();
  for (const model of models) {
    const entry = familyOf.get(model.id);
    if (!entry) {
      groups.push({ key: model.id, name: model.name, variants: [{ model, label: model.name }] });
    } else if (!placed.has(entry.family)) {
      placed.add(entry.family);
      groups.push({ key: `family:${entry.variants[0]!.model.id}`, name: entry.family.name, variants: entry.variants });
    }
  }
  return groups;
}

/** The version a row stands for: the selected one if it belongs here, else the newest. */
export function activeVariant<M extends GroupableModel>(group: ModelGroup<M>, selectedModel: string | null | undefined): ModelVariant<M> {
  return group.variants.find((v) => v.model.id === selectedModel) ?? group.variants[0]!;
}
