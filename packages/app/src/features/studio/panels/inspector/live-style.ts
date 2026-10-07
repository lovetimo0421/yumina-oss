import { fitFontWeight, type UiElement } from "@yumina/engine";

/**
 * A part's look, written straight onto the part already drawn.
 *
 * The card recompiles 600ms after the last edit, and the creator saw nothing
 * until then: a font-size slider stood still while dragged and jumped on
 * release, a colour took 730ms. This writes what the compiler would emit for
 * the same fields (engine ui-doc/compile.ts, the "text" case and frameStyle),
 * so the recompile that follows draws the same thing.
 *
 * Only the fields a creator changes from the panel, and only on a part that
 * changed: the compiler also adjusts some colours for the ground they sit on
 * (ink.ts), and rewriting every part on every edit would undo that.
 */
export function paintLive(node: HTMLElement, el: UiElement, canvas: "phone" | "desktop"): void {
  node.style.opacity = el.opacity === undefined ? "" : String(el.opacity);
  node.style.transform = el.rotation ? `rotate(${el.rotation}deg)` : "";
  if (el.type === "box" || el.type === "button") { paintBox(node, el, canvas); return; }
  if (el.type !== "text") return;
  const st = el.style;
  const size = canvas === "desktop" ? st?.desktopSize ?? st?.size : st?.size;
  node.style.fontSize = `${size ?? 14}px`;
  node.style.color = st?.color ?? "#ffffff";
  if (st?.weight !== undefined) node.style.fontWeight = String(fitFontWeight(st.family, st.weight));
  node.style.letterSpacing = st?.letterSpacing === undefined ? "" : `${st.letterSpacing}px`;
  node.style.lineHeight = st?.lineHeight === undefined ? "" : String(st.lineHeight);
  node.style.textAlign = st?.align ?? "";
  node.style.fontStyle = st?.italic ? "italic" : "";
  // Plain words follow the panel's text box as it is typed; words with a
  // variable in them, or markdown, wait for the compile that resolves them.
  const template = (el as { text?: { template?: unknown } }).text?.template;
  if (!st?.markdown && typeof template === "string" && !template.includes("{{")) {
    if (node.textContent !== template) node.textContent = template;
  }
}

type BoxStyle = {
  fills?: Array<{ kind: string; color?: string; angle?: number; stops?: Array<{ color: string; at?: number }> }>;
  radius?: number | number[]; borderColor?: string; borderWidth?: number; borderStyle?: string;
  shadows?: Array<{ x: number; y: number; blur: number; spread?: number; color: string; inset?: boolean }>;
  textColor?: string; size?: number; desktopSize?: number; weight?: number; family?: string; letterSpacing?: number;
};

/** One background layer, or null when it cannot be painted here (an image
 *  waits for the compile, which resolves its URL). */
function layer(f: NonNullable<BoxStyle["fills"]>[number]): string | null {
  if (f.kind === "color" && f.color) return f.color;
  if (f.kind === "gradient" && (f.stops?.length ?? 0) >= 2) {
    return `linear-gradient(${f.angle ?? 180}deg, ${f.stops!.map((st) => `${st.color} ${st.at ?? 0}%`).join(", ")})`;
  }
  return null;
}

/** A box's or a button's paint: compile.ts boxPaint, and the button case. */
function paintBox(node: HTMLElement, el: UiElement, canvas: "phone" | "desktop"): void {
  const st = (el as { style?: BoxStyle }).style;
  const button = el.type === "button";
  const fills = st?.fills ?? [];
  const layers = fills.map(layer);
  if (layers.every((l) => l !== null)) {
    node.style.background = layers.length ? layers.join(", ") : button ? "rgba(255,255,255,0.10)" : "";
  }
  const r = st?.radius;
  node.style.borderRadius = r === undefined ? (button ? "var(--yc-send-radius, 10px)" : "") : Array.isArray(r) ? r.map((x) => `${x}px`).join(" ") : `${r}px`;
  node.style.border = st?.borderColor ? `${st.borderWidth ?? 1}px ${st.borderStyle ?? "solid"} ${st.borderColor}` : button ? "none" : "";
  node.style.boxShadow = st?.shadows?.length
    ? st.shadows.map((sh) => `${sh.inset ? "inset " : ""}${sh.x}px ${sh.y}px ${sh.blur}px${sh.spread === undefined ? "" : ` ${sh.spread}px`} ${sh.color}`).join(", ")
    : "";
  if (!button) return;
  node.style.color = st?.textColor ?? "#ffffff";
  const size = canvas === "desktop" ? st?.desktopSize ?? st?.size : st?.size;
  node.style.fontSize = `${size ?? 13}px`;
  node.style.fontWeight = String(fitFontWeight(st?.family, st?.weight ?? 600));
  node.style.letterSpacing = st?.letterSpacing === undefined ? "" : `${st.letterSpacing}px`;
  const template = (el as { label?: { template?: unknown } }).label?.template;
  if (typeof template === "string" && !template.includes("{{") && node.childElementCount === 0 && node.textContent !== template) {
    node.textContent = template;
  }
}

/** Whether two versions of a part differ in anything paintLive writes. */
export function lookChanged(a: UiElement, b: UiElement): boolean {
  if (a === b) return false;
  if (a.opacity !== b.opacity || a.rotation !== b.rotation) return true;
  if (a.type !== b.type || !["text", "box", "button"].includes(a.type)) return false;
  const k = a as { style?: unknown; text?: unknown; label?: unknown };
  const j = b as { style?: unknown; text?: unknown; label?: unknown };
  return k.style !== j.style || k.text !== j.text || k.label !== j.label;
}
