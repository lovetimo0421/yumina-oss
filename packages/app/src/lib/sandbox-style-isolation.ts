export const SANDBOX_WORLD_ROOT_SELECTOR = '[data-yumina-world-root="true"]';

// Creator components are allowed to author document-like styles because they
// run as a full page inside the play sandbox. Platform overlays live in that
// same document, though, so rules aimed at html/body/:root must be redirected
// to the creator's root before they can resize or re-theme Yumina UI.
const DOCUMENT_ROOT_SELECTOR = String.raw`(?::root|html|body|#sandbox-root)`;
const DOCUMENT_ROOT_RULE_RE = new RegExp(
  String.raw`(^|[{};])(\s*)(${DOCUMENT_ROOT_SELECTOR}(?:\s*,\s*${DOCUMENT_ROOT_SELECTOR})*)(?=\s*\{)`,
  "gim",
);

export function rewriteSandboxRootSelectorText(cssText: string): string {
  return cssText.replace(
    DOCUMENT_ROOT_RULE_RE,
    (_match, anchor: string, whitespace: string) =>
      `${anchor}${whitespace}${SANDBOX_WORLD_ROOT_SELECTOR}`,
  );
}

function collectStyleElements(root: ParentNode): HTMLStyleElement[] {
  const element = root as ParentNode & { nodeType?: number; nodeName?: string };
  const own = element.nodeType === 1 && element.nodeName?.toLowerCase() === "style"
    ? [root as HTMLStyleElement]
    : [];
  return [...own, ...Array.from(root.querySelectorAll<HTMLStyleElement>("style"))];
}

/**
 * Scope creator-owned document-root rules to the world root. Platform styles
 * captured at sandbox bootstrap are marked and deliberately left untouched.
 * The transform is idempotent, so it is safe for the runtime MutationObserver.
 */
export function rewriteSandboxRootSelectors(root: ParentNode): void {
  for (const styleEl of collectStyleElements(root)) {
    if (styleEl.hasAttribute("data-yumina-platform-style")) continue;
    const cssText = styleEl.textContent ?? "";
    const rewritten = rewriteSandboxRootSelectorText(cssText);
    if (rewritten !== cssText) styleEl.textContent = rewritten;
  }
}
