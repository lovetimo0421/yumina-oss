import type { Effect, WorldDefinition } from "@yumina/engine";

/**
 * 现场 — what the game shows right now, told by the card's own interface.
 *
 * A turn-based prompt only knows what was said. A game knows more: where the
 * player is standing, whether the telescreen can see them, what they drew on
 * the ground. The card's frontend calls `api.setScene(scene, { events })` and
 * the next AI call — a reply or a quiet station's turn — reads it as its own
 * block. `events` are the things this game lets the AI set off ("send the
 * police in"); the AI fires one by writing `[event: name]`, which the parser
 * reads as a write to a variable called `event` — taken back out here, so it
 * never touches state, and handed to the card instead.
 *
 * The scene is not stored: it is the screen at the moment of the call. A
 * reload without a new setScene simply has no scene.
 */

export interface LiveSceneEvent { name: string; when: string }
export interface LiveScene { text: string; events: LiveSceneEvent[] }

const MAX_SCENE_CHARS = 4000;
const MAX_EVENTS = 12;

export function render(value: unknown, indent = ""): string {
  if (value === null || value === undefined) return "—";
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value)) return value.map((v) => (typeof v === "object" && v !== null ? `\n${indent}- ${render(v, indent + "  ")}` : String(v))).join(typeof value[0] === "object" ? "" : ", ");
  return Object.entries(value as Record<string, unknown>)
    .map(([k, v]) => `\n${indent}${k}: ${typeof v === "object" && v !== null && !Array.isArray(v) ? render(v, indent + "  ") : render(v, indent + "  ")}`)
    .join("");
}

/** Whatever the client sent, as something safe to put in a prompt — or null. */
export function normalizeLiveScene(raw: unknown): LiveScene | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as { scene?: unknown; events?: unknown };
  let text = "";
  if (typeof r.scene === "string") text = r.scene.trim();
  else if (r.scene && typeof r.scene === "object") text = render(r.scene).trim();
  text = text.slice(0, MAX_SCENE_CHARS);
  const events: LiveSceneEvent[] = Array.isArray(r.events)
    ? r.events
        .map((e) => (e && typeof e === "object" ? e as Record<string, unknown> : null))
        .filter((e): e is Record<string, unknown> => !!e && typeof e.name === "string" && e.name.trim().length > 0)
        .slice(0, MAX_EVENTS)
        .map((e) => ({ name: String(e.name).trim().slice(0, 40), when: typeof e.when === "string" ? e.when.trim().slice(0, 200) : "" }))
    : [];
  if (!text && events.length === 0) return null;
  return { text, events };
}

/** The prompt block. English instructions, the card's own words inside. */
export function liveSceneMessage(scene: LiveScene): { role: "system"; content: string } {
  const parts = ["[Live scene — what the game shows right now. You see only this; what is not here, you do not know.]"];
  if (scene.text) parts.push(scene.text);
  if (scene.events.length > 0) {
    parts.push(
      "Events you may set off. Write the line exactly as shown, on its own line, only when it fits — the game plays it out:",
      ...scene.events.map((e) => `[event: ${e.name}]${e.when ? ` — ${e.when}` : ""}`),
    );
  }
  return { role: "system", content: parts.join("\n") };
}

/**
 * Take the `[event: name]` writes back out of the parsed effects. Only names
 * the game offered count; a card with a real variable called `event` keeps its
 * writes. Mutates `effects`; returns the fired names in order, once each.
 */
export function takeStoryEvents(effects: Effect[], world: WorldDefinition, scene: LiveScene | null): string[] {
  if (!scene || scene.events.length === 0) return [];
  if ((world.variables ?? []).some((v) => v.id === "event")) return [];
  const offered = new Set(scene.events.map((e) => e.name));
  const fired: string[] = [];
  for (let i = effects.length - 1; i >= 0; i -= 1) {
    const e = effects[i]!;
    if (e.variableId !== "event") continue;
    effects.splice(i, 1);
    const name = String(e.value ?? "").trim();
    if (offered.has(name) && !fired.includes(name)) fired.unshift(name);
  }
  return fired;
}
