/**
 * The player's Settings → Display font size, applied inside the play sandbox.
 *
 * Two levers, because card text comes in two kinds:
 * - The root font-size: everything sized in rem (Yumina's own chat, composer,
 *   menus, creator Tailwind classes) follows it.
 * - `--yumina-font-scale`: most card-drawn message bubbles (`<Chat
 *   renderBubble>`, `design`) size their text in px, which ignores the root.
 *   globals.css zooms `.play-custom-component-shell` by this factor, so those
 *   bubbles grow too. Without it the setting did nothing on half the cards
 *   people play.
 */
export const SANDBOX_FONT_SCALE_VAR = "--yumina-font-scale";

type RootStyle = Pick<CSSStyleDeclaration, "fontSize" | "setProperty" | "removeProperty">;

export function applySandboxFontScale(style: RootStyle, scale: number): void {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  if (s === 1) {
    style.fontSize = "";
    style.removeProperty(SANDBOX_FONT_SCALE_VAR);
    return;
  }
  style.fontSize = `${16 * s}px`;
  style.setProperty(SANDBOX_FONT_SCALE_VAR, String(s));
}
