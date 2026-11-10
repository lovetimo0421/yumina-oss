/** A colour in words — 「黑色 50%」 — for the control's label. The chip next
 *  to it shows the exact colour and the popover still takes a hex; the label
 *  is there so nobody has to read `rgba(0, 0, 0, 0.5)`. */
export type ColorWord = "black" | "white" | "gray" | "red" | "orange" | "brown" | "yellow" | "green" | "cyan" | "blue" | "purple" | "pink";
export function colorWord({ r, g, b }: { r: number; g: number; b: number }): ColorWord {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B);
  const l = (max + min) / 2;
  const d = max - min;
  const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (sat < 0.14 || d < 0.06) return l < 0.16 ? "black" : l > 0.9 ? "white" : "gray";
  let h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  h = (h * 60 + 360) % 360;
  if (h < 14 || h >= 345) return l > 0.72 ? "pink" : "red";
  if (h < 42) return l < 0.42 ? "brown" : "orange";
  if (h < 68) return l < 0.35 ? "brown" : "yellow";
  if (h < 160) return "green";
  if (h < 196) return "cyan";
  if (h < 255) return "blue";
  if (h < 292) return "purple";
  return "pink";
}
