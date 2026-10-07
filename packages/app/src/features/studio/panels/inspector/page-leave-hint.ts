import { UI_CHAT_STARTED, elementActions, type UiDoc, type UiPage } from "@yumina/engine";

/**
 * What the page list says under a page that steps aside by itself.
 *
 * The step (`leaveWhen`) belongs to the page, not to the first-page slot, so
 * it keeps working after another page becomes the first one — but only for a
 * player who is ON that page. Said the same way on every page, the old opening
 * page kept promising 「开始聊天后自动换到「聊天」」 though nobody opens on it any
 * more. So: the first page says what happens; a page a button leads to says
 * "while on this page"; a page nothing leads to says nothing, because for it
 * nothing ever happens.
 */
export interface PageLeaveHint {
  /** i18n key under `studio.element`. */
  key: "leavesTo" | "leavesToWhen" | "leavesToHere" | "leavesToHereWhen";
  /** The page it switches to. */
  target: UiPage;
  /** For a condition other than "the chat has started": the variable's name,
   *  or null when the condition is "the chat has not started yet". */
  variableName?: string | null;
}

export function pageLeaveHint(
  doc: UiDoc,
  page: UiPage,
  variables: ReadonlyArray<{ id: string; name: string }>,
): PageLeaveHint | null {
  const leave = page.leaveWhen;
  if (!leave) return null;
  const pages = doc.pages ?? [];
  const target = pages.find((p) => p.id === leave.pageId);
  if (!target || target.id === page.id) return null;
  const isEntry = page.id === doc.entryPageId;
  if (!isEntry) {
    const reached = pages.some((p) => p.id !== page.id && p.elements.some((el) =>
      elementActions(el).some((a) => a.kind === "go-page" && a.pageId === page.id)));
    if (!reached) return null;
  }
  const when = leave.when;
  const started = when.variableId === UI_CHAT_STARTED
    && (when.operator === "neq" ? when.value !== true : when.value === true);
  if (started) return { key: isEntry ? "leavesTo" : "leavesToHere", target };
  const variableName = when.variableId === UI_CHAT_STARTED
    ? null
    : variables.find((v) => v.id === when.variableId)?.name ?? when.variableId;
  return { key: isEntry ? "leavesToWhen" : "leavesToHereWhen", target, variableName };
}
