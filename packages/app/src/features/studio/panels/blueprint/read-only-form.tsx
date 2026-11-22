import { useLayoutEffect, useRef, type ReactNode, type SyntheticEvent } from "react";

const block = (e: SyntheticEvent) => {
  e.preventDefault();
  e.stopPropagation();
};

/** Controls whose value changes on a key or a press, rather than by typing. */
const PICKERS = "select, [role='combobox'], [role='switch'], [role='slider'], input[type='checkbox'], input[type='radio'], input[type='range'], input[type='number'], input[type='color'], input[type='date'], input[type='file']";

/** A field whose value changes on a press: only `disabled` holds it. */
export function isPicker(el: Element): boolean {
  return el.tagName === "SELECT" || (el.tagName === "INPUT" && /^(checkbox|radio|range|color|file|date|number)$/.test((el as HTMLInputElement).type));
}

/** Every field in the form, marked read only where the browser itself will
 *  hold to it: a text field keeps its caret, selection and scroll; a picker
 *  is disabled. Fields that mount later (a fold opening) are caught too. */
function lockFields(root: HTMLElement) {
  for (const el of root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select")) {
    if (isPicker(el)) el.disabled = true;
    else (el as HTMLInputElement | HTMLTextAreaElement).readOnly = true;
  }
  for (const el of root.querySelectorAll<HTMLElement>("[contenteditable='true']")) el.contentEditable = "false";
}

/** A press that only shows or hides part of the form: allowed. */
function isDisclosure(el: Element | null): boolean {
  const button = el?.closest("button, [role='button']");
  return !!button
    && button.hasAttribute("aria-expanded")
    && !button.hasAttribute("aria-haspopup")
    && button.getAttribute("role") !== "combobox";
}

/**
 * Someone else's object, read in its own editor form: everything in it can be
 * read, scrolled, selected and copied, and folded sections still open, but
 * nothing changes. The store drops a read-only board's edits anyway; this is
 * what keeps the form from looking editable and keeps its buttons (generate,
 * delete, upload) from doing anything at all. A disabled fieldset was the
 * first try: it also locked the 「调整生效方式」 folds that hold half of what
 * there is to read.
 */
export function ReadOnlyForm({ note, children }: { note?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    lockFields(root);
    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => lockFields(root));
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={ref}
      className="flex min-w-0 flex-1 flex-col"
      data-read-only-form=""
      onClickCapture={(e) => {
        const target = e.target as Element;
        if (isDisclosure(target)) return;
        if (target.closest("button, [role='button'], a[href], label, " + PICKERS)) block(e);
      }}
      onPointerDownCapture={(e) => {
        if ((e.target as Element).closest(PICKERS)) block(e);
      }}
      onMouseDownCapture={(e) => {
        if ((e.target as Element).closest(PICKERS)) block(e);
      }}
      onKeyDownCapture={(e) => {
        if (e.key === "Tab" || e.key === "Escape") return;
        const target = e.target as Element;
        if (isDisclosure(target)) return;
        if (target.closest("button, [role='button'], " + PICKERS)) block(e);
      }}
      onBeforeInputCapture={block}
      onPasteCapture={block}
      onCutCapture={block}
      onDropCapture={block}
    >
      {note && <p className="mb-2 text-xs text-foreground/55">{note}</p>}
      {children}
    </div>
  );
}
