/** Platform dialogs live in a shadow root: document.activeElement is its host. */
export function activeGuardElement(doc: Document): Element | null {
  let active = doc.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}

function controls(dialog: HTMLElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]')]
    .filter((element) => element.tabIndex >= 0 && !element.matches(':disabled') && !element.closest('[hidden], [inert], [aria-hidden="true"]'));
}

export function focusGuardDialog(dialog: HTMLElement, preferred?: HTMLElement | null): void {
  if (dialog.contains(activeGuardElement(dialog.ownerDocument))) return;
  const targets = controls(dialog);
  (preferred && targets.includes(preferred) ? preferred : targets[0])?.focus({ preventScroll: true });
}

/** The active dialog getter switches between settings and its nested picker.
 * Keep this scope installed across that switch, then restore focus on Close. */
export function installGuardFocusScope(doc: Document, getDialog: () => HTMLElement | null, escape: () => void): () => void {
  const previous = activeGuardElement(doc) as HTMLElement | null;
  const keydown = (event: KeyboardEvent) => {
    const dialog = getDialog();
    if (!dialog) return;
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation(); escape(); return;
    }
    if (event.key !== "Tab") return;
    const targets = controls(dialog);
    const first = targets[0]; const last = targets.at(-1);
    const active = activeGuardElement(doc);
    if (!dialog.contains(active) || (event.shiftKey ? active === first : active === last)) {
      event.preventDefault(); (event.shiftKey ? last : first)?.focus({ preventScroll: true });
    }
  };
  const focusin = () => { const dialog = getDialog(); if (dialog) focusGuardDialog(dialog); };
  doc.addEventListener("keydown", keydown, true);
  doc.addEventListener("focusin", focusin, true);
  return () => {
    doc.removeEventListener("keydown", keydown, true);
    doc.removeEventListener("focusin", focusin, true);
    if (previous?.isConnected) previous.focus?.({ preventScroll: true });
  };
}
