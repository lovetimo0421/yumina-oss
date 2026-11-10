import { detectUiTemplate, getUiTemplate } from "@yumina/engine";
import type { UiDoc } from "@yumina/engine";

type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * Everything `applyUiTemplate` needs beyond the layout's id, gathered from the
 * locale: the words the layout prints and the names of the variables it
 * brings. Each layout declares its own keys, so this reads exactly those
 * rather than carrying a list that goes stale the next time a layout is added.
 *
 * Shared by the Look panel and the interface block's own picker, so the two
 * ways of choosing a layout cannot install two different layouts.
 */
export function layoutChoiceArgs(next: string | null, t: Translate, cardName: string | undefined): {
  strings: Record<string, string>;
  names: Record<string, string>;
  defaults: Record<string, string>;
} {
  const template = next ? getUiTemplate(next) : null;
  const strings: Record<string, string> = { title: cardName?.trim() || t("studio.layout.title") };
  for (const key of template?.stringKeys ?? []) {
    strings[key] = t(`studio.layout.s.common.${key}`, { defaultValue: "" }) || t(`studio.layout.s.${next}.${key}`);
  }
  const names: Record<string, string> = {};
  const defaults: Record<string, string> = {};
  for (const need of template?.needs ?? []) {
    names[need.key] = t(`studio.layout.vars.${need.key}`);
    const seed = t(`studio.layout.varDefaults.${need.key}`, { defaultValue: "" });
    if (seed) defaults[need.key] = seed;
  }
  return { strings, names, defaults };
}

/**
 * Ask before a layout replaces an interface the creator has built.
 *
 * Picking a layout rebuilds the whole document — pages, parts, everything —
 * and adds the variables the layout binds. On a card that is still the bare
 * chat (or already exactly that layout) there is nothing to lose, so it just
 * happens; on anything else the creator is told what goes, and that Ctrl+Z
 * brings it back. Resolves true when the switch should go ahead.
 */
export async function confirmLayoutReplace(next: string | null, t: Translate): Promise<boolean> {
  // Loaded here rather than at the top so the pure helpers in this file stay
  // importable (and testable) without the store.
  const { useEditorStore } = await import("@/stores/editor");
  const { confirmAction } = await import("@/components/ui/global-confirm-dialog");
  const doc = useEditorStore.getState().worldDraft.uiDoc;
  if (!needsLayoutConfirm(doc, next)) return true;
  const name = next ? t(`studio.layout.preset.${next}`) : t("studio.layout.none");
  return confirmAction(t("blueprint.look.replaceBody", { name }), {
    title: t("blueprint.look.replaceTitle", { name }),
    confirmLabel: t("blueprint.look.replaceConfirm"),
    tone: "warning",
  });
}

/** Whether switching `doc` to layout `next` would throw away arranged parts. */
export function needsLayoutConfirm(doc: UiDoc | undefined, next: string | null): boolean {
  if (!doc) return false;
  const hasParts = (doc.pages ?? []).some((p) => p.elements.length > 0);
  if (!hasParts) return false;
  // Parts no layout made (a starter, a hand-built screen) are always at stake.
  const current = detectUiTemplate(doc);
  return current === null || current !== next;
}
