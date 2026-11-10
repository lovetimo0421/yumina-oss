import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { UiPageTemplateId } from "@yumina/engine";
import { useEditorStore } from "@/stores/editor";
import { isStarterOpening } from "@/lib/world-templates";

/** Enabled greeting entries with text: what `pick-opening` makes cards of. */
export function useOpeningCount(): number {
  return useEditorStore((s) => {
    let n = 0;
    for (const e of s.worldDraft.entries ?? []) {
      if (e.role === "greeting" && e.enabled !== false && (e.content ?? "").trim()) n++;
    }
    return n;
  });
}

/** Add a template (or a blank page) and return the page to show. */
export function useAddPageTemplate() {
  const { t } = useTranslation("editor");
  const addPageTemplate = useEditorStore((s) => s.addPageTemplate);
  return useCallback((id: UiPageTemplateId): string | null => {
    if (id === "pick-opening") topUpOpenings(t("studio.pageTemplates.tpl.pick-opening.samples" as never, { returnObjects: true }) as unknown);
    const base = `studio.pageTemplates.tpl.${id}.s`;
    const strings = (t(base as never, { returnObjects: true }) ?? {}) as unknown as Record<string, string>;
    // Every variable any template can make, named and explained in the
    // creator's language — a status page may create ones its template does
    // not list (a card that tracked nothing yet).
    const vars = (t("studio.pageTemplates.vars" as never, { returnObjects: true }) ?? {}) as unknown as Record<string, { name?: string; rule?: string; default?: string }>;
    const varNames: Record<string, string> = {};
    const varRules: Record<string, string> = {};
    const varDefaults: Record<string, string> = {};
    for (const [vid, v] of Object.entries(typeof vars === "object" ? vars : {})) {
      if (v?.name) varNames[vid] = v.name;
      if (v?.rule) varRules[vid] = v.rule;
      if (v?.default) varDefaults[vid] = v.default;
    }
    return addPageTemplate(id, {
      strings: {
        ...(t("studio.pageTemplates.menu" as never, { returnObjects: true }) as unknown as Record<string, string>),
        ...(typeof strings === "object" ? strings : {}),
        chatPageName: String(t("studio.pageTemplates.chatPageName")),
      },
      varNames,
      varRules,
      openingTitle: (n) => String(t("studio.pageTemplates.openingTitle", { n })),
      varDefaults,
      confirmStrings: t("studio.pageTemplates.tpl.confirm.s" as never, { returnObjects: true }) as unknown as Record<string, string>,
    });
  }, [t, addPageTemplate]);
}

/**
 * A page of opening cards wants openings to pick from: bring the card to
 * three with written-out samples, and name a still-untouched starter opening
 * after the first sample so its card does not read 「【玩家进入你世界…」.
 */
const OPENINGS_WANTED = 3;
function topUpOpenings(raw: unknown): void {
  const samples = (Array.isArray(raw) ? raw : []).filter((x): x is { name: string; content: string } =>
    Boolean(x && typeof x.name === "string" && typeof x.content === "string"));
  if (!samples.length) return;
  const store = useEditorStore.getState();
  const openings = (store.worldDraft.entries ?? [])
    .filter((e) => e.role === "greeting" && e.enabled !== false)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  let used = 0;
  for (const e of openings) {
    if (used >= samples.length) break;
    if (isStarterOpening(e.content ?? "")) store.updateEntry(e.id, { name: samples[used].name, content: samples[used].content });
    used++;
  }
  for (let n = openings.length; n < OPENINGS_WANTED && used < samples.length; n++, used++) {
    const sample = samples[used];
    store.addEntry("greeting", "system-presets", { content: sample.content });
    const added = useEditorStore.getState().worldDraft.entries.at(-1);
    if (added?.role === "greeting") store.updateEntry(added.id, { name: sample.name });
  }
}

/**
 * Open the interface editor from elsewhere (the board's interface block) on a
 * given page, or straight into the new-page gallery. The editor may not be
 * mounted yet — the request waits for it — or already be open, in which case
 * the event reaches it.
 */
export interface UiEditorRequest { pageId?: string; gallery?: boolean }
let pendingRequest: UiEditorRequest | null = null;
export const UI_EDITOR_REQUEST_EVENT = "yumina:ui-editor-request";
export function requestUiEditor(request: UiEditorRequest): void {
  pendingRequest = request;
  window.dispatchEvent(new CustomEvent(UI_EDITOR_REQUEST_EVENT));
}
export function takeUiEditorRequest(): UiEditorRequest | null {
  const request = pendingRequest;
  pendingRequest = null;
  return request;
}
