import type { WorldDefinition } from "@yumina/engine";
import { toolLabel } from "../components/change-labels";
import type { AiPresence } from "./agent-job";

/**
 * Where the assistant is working, from the tool it is calling: while a tool's
 * arguments stream in, its whole block glows; once they are in, the exact row.
 * Reads and searches mark nothing — they change nothing.
 */

const BLOCK_FOR_TOOL: Record<string, string> = {
  write_entry: '.react-flow__node[data-id="block:starter:setting"], .react-flow__node[data-id^="block:lore"]',
  write_variable: '.react-flow__node[data-id^="block:state"]',
  write_behavior: '.react-flow__node[data-id^="block:behavior"]',
  write_custom_ui: '.react-flow__node[data-id^="block:frontend"]',
  edit_custom_ui: '.react-flow__node[data-id^="block:frontend"]',
  edit_ui_doc: '.react-flow__node[data-id^="block:frontend"]',
  set_ui_knobs: '.react-flow__node[data-id^="block:frontend"]',
  write_ui_knob_groups: '.react-flow__node[data-id^="block:frontend"]',
  write_audio: '.react-flow__node[data-id^="block:audio"]',
  write_scene_image: '.react-flow__node[data-id^="block:scene"]',
  update_settings: '.react-flow__node[data-id^="block:card"]',
};

function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

const quote = (value: string) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : value);

/** The canvas element for a tool call, and the words on its tag. */
export function presenceForTool(
  name: string,
  rawArgs: string | undefined,
  world: WorldDefinition,
  t: (key: string) => string,
): AiPresence | null {
  const block = BLOCK_FOR_TOOL[name];
  if (!block) return null;
  const args = parseArgs(rawArgs);
  const id = typeof args.id === "string" ? args.id : undefined;
  const label = typeof args.name === "string" && args.name ? args.name : undefined;
  let row: string | undefined;
  let title = label;
  if (name === "write_entry") {
    const entry = (world.entries ?? []).find((e) => (id && e.id === id) || (!id && label && e.name === label));
    if (entry) {
      row = `[data-canvas-writing-object="entry:${quote(entry.id)}"], [data-canvas-writing-object="greeting:${quote(entry.id)}"]`;
      title = entry.name || title;
    }
  } else if (name === "write_variable") {
    const variable = (world.variables ?? []).find((v) => (id && v.id === id) || (!id && label && v.name === label));
    if (variable) {
      row = `[data-row-anchor="var:${quote(variable.id)}"]`;
      title = variable.name || title;
    }
  }
  const what = toolLabel(name, t as never);
  return { target: row ? [row, block] : block, label: `${t("studio.job.presenceWorking")} · ${title ? `${what}「${title}」` : what}` };
}
