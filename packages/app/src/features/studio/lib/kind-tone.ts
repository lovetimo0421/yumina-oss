import { KIND_STYLE, ROW_TONE } from "../panels/blueprint/style";

/**
 * The board's colours, lent to the assistant panel: an entry the creator
 * picked, an entry the assistant changed, an entry on the canvas — the same
 * violet everywhere, so the eye links them without reading. One kind, one
 * hue (panels/blueprint/style.ts); nothing new is invented here.
 */
export type ToneKind = keyof typeof KIND_STYLE;

/** Border + faint wash + readable text, the board's chip. */
export const toneChip = (kind: ToneKind): string => ROW_TONE[kind].chip;

/** The kind's own text colour (icons, small labels). */
export const toneText = (kind: ToneKind): string =>
  KIND_STYLE[kind].chip.split(" ").find((c) => c.startsWith("text-")) ?? "text-muted-foreground";

/** The kind's border, as on the board's blocks. */
export const toneBorder = (kind: ToneKind): string => KIND_STYLE[kind].accent;

/** What an assistant write touches. An opening is written as an entry, so its arguments decide. */
export function toolKind(tool: string, args?: Record<string, unknown>): ToneKind {
  switch (tool) {
    case "write_entry": return args?.role === "greeting" ? "greeting" : "entry";
    case "write_variable": return "variable";
    case "write_behavior": return "rule";
    case "write_audio": return "audio";
    case "write_scene_image": return "image";
    case "write_worldbook": return "module";
    case "write_custom_ui": case "edit_custom_ui": case "set_ui_knobs": case "write_ui_knob_groups":
    case "edit_ui_doc": case "write_lore_binding": return "component";
    default: return "world";
  }
}

/** What a piece the creator pointed at is (lib/ai-focus.ts kinds). */
export function focusKind(kind: string): ToneKind {
  switch (kind) {
    case "entry": return "entry";
    case "greeting": return "greeting";
    case "variable": return "variable";
    case "rule": return "rule";
    case "audio": return "audio";
    case "module": return "module";
    case "frontend": case "block": return "component";
    default: return "world";
  }
}
