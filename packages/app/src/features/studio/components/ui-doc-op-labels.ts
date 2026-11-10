/**
 * What an `edit_ui_doc` call did, in the creator's words.
 *
 * The change card used to print the raw ops — `update_part open-cards ·
 * add_part text · add_part meter` — which is the tool's vocabulary, not the
 * creator's. Each op now reads as a short phrase ("Changed Opening cards",
 * "New Text"), naming a part by the name the creator sees in the layers list,
 * or by its kind when it has none. Ids never show.
 */

interface UiDocOpLike {
  op?: string;
  id?: string;
  page?: string;
  name?: string;
  look?: string;
  part?: { type?: string; name?: string };
}

type Translate = (key: string | string[], opts?: Record<string, unknown>) => string;

/** A part as the editor knows it: its name, and its type as a fallback. */
export type PartLookup = (id: string) => { name?: string; type?: string } | undefined;

const KIND_KEYS = (type: string) => [`studio.element.kind.${type}`, `studio.parts.kind.${type}`];

export function uiDocOpLabel(op: UiDocOpLike, t: Translate, lookup: PartLookup = () => undefined): string {
  const kind = (type: string | undefined) => (type ? t(KIND_KEYS(type), { defaultValue: "" }) : "");
  const partName = (): string => {
    const known = op.id ? lookup(op.id) : undefined;
    return known?.name?.trim() || kind(known?.type) || "";
  };
  const withName = (key: string) => {
    const name = partName();
    return name ? t(`studio.entity.uiOp.${key}`, { name }) : t(`studio.entity.uiOp.${key}Unnamed`);
  };
  switch (op.op) {
    case "add_part": {
      const name = op.part?.name?.trim() || kind(op.part?.type);
      return name ? t("studio.entity.uiOp.addPart", { name }) : t("studio.entity.uiOp.addPartUnnamed");
    }
    case "update_part": return withName("updatePart");
    case "remove_part": return withName("removePart");
    case "move_part": return withName("movePart");
    case "reorder": return withName("reorder");
    case "apply_look": return withName("applyLook");
    case "add_page": return t("studio.entity.uiOp.addPage");
    case "update_page": return t("studio.entity.uiOp.updatePage");
    case "rename_page": return t("studio.entity.uiOp.renamePage");
    case "remove_page": return t("studio.entity.uiOp.removePage");
    case "set_entry_page": return t("studio.entity.uiOp.setEntryPage");
    case "set_theme": return t("studio.entity.uiOp.setTheme");
    case "detach_to_code": return t("studio.entity.uiOp.detachToCode");
    default: return t("studio.entity.uiOp.other");
  }
}

/** Every op of one call, in order, with repeats folded ("Changed Title ×2"). */
export function describeUiDocOps(ops: readonly UiDocOpLike[] | undefined, t: Translate, lookup?: PartLookup): string {
  const counts = new Map<string, number>();
  for (const op of ops ?? []) {
    const label = uiDocOpLabel(op, t, lookup);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, n]) => (n > 1 ? `${label} ×${n}` : label)).join(" · ");
}
