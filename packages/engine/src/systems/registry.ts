import type { SystemDefinition } from "./types.js";
import { SPATIAL_SYSTEM } from "../spatial/system.js";
import { TIMER_SYSTEM } from "../timer/system.js";

// ── Built-in System Definitions ──
// These are metadata-only — they declare what events exist and what state paths are available.
// The actual runtime behavior lives in the server (message route) and client (stores).

const CHAT_SYSTEM: SystemDefinition = {
  id: "chat",
  name: "Chat & AI",
  description: "Player messages, AI responses, and turn management",
  category: "Core",
  alwaysActive: true,
  events: [
    {
      type: "message:user",
      description: "Player sends a message",
      dataFields: [
        { name: "content", type: "string", description: "Message text" },
      ],
    },
    {
      type: "message:ai",
      description: "AI finishes responding",
      dataFields: [
        { name: "content", type: "string", description: "Response text" },
      ],
    },
    {
      type: "turn:complete",
      description: "A player-AI exchange completes",
      dataFields: [
        { name: "turnCount", type: "number", description: "Current turn number" },
      ],
    },
    {
      type: "session:start",
      description: "A new session begins",
      dataFields: [],
    },
    {
      type: "action:fired",
      description: "An action button is pressed",
      dataFields: [
        { name: "actionId", type: "string", description: "The action's ID" },
      ],
    },
  ],
  statePaths: [
    { path: "@ai.request", description: "Set to trigger an AI generation without user input", valueType: "string" },
    { path: "@ai.context", description: "One-shot context message for next AI call", valueType: "string" },
  ],
};

const STATE_SYSTEM: SystemDefinition = {
  id: "state",
  name: "Game State",
  description: "Variable change detection and threshold crossing",
  category: "Core",
  alwaysActive: true,
  events: [
    {
      type: "state:changed",
      description: "A variable's value changed",
      dataFields: [
        { name: "variableId", type: "string", description: "Which variable changed" },
      ],
    },
    {
      type: "state:crossed",
      description: "A variable crossed a threshold",
      dataFields: [
        { name: "variableId", type: "string", description: "Which variable crossed" },
        { name: "direction", type: "string", description: "rises-above or drops-below" },
        { name: "threshold", type: "number", description: "The threshold value" },
      ],
    },
  ],
  statePaths: [
    { path: "@vars.enabled.*", description: "Override a variable's enable gate (true/false) — inactive variables leave the AI prompt and player UI but keep their value", valueType: "boolean" },
  ],
};

const AUDIO_SYSTEM: SystemDefinition = {
  id: "audio",
  name: "Audio",
  description: "Background music, sound effects, and ambient audio",
  category: "Media",
  alwaysActive: false,
  events: [
    {
      type: "audio:track-ended",
      description: "An audio track finished playing",
      dataFields: [
        { name: "trackId", type: "string", description: "Which track ended" },
      ],
    },
  ],
  statePaths: [
    { path: "@audio.bgm", description: "Play a background music track", valueType: "string" },
    { path: "@audio.sfx", description: "Play a one-shot sound effect", valueType: "string" },
    { path: "@audio.stop", description: "Stop a playing track", valueType: "string" },
  ],
};

const PROMPT_SYSTEM: SystemDefinition = {
  id: "prompt",
  name: "AI Context",
  description: "Directives, entry overrides, and context injection for the AI",
  category: "Core",
  alwaysActive: true,
  events: [],
  statePaths: [
    { path: "@prompt.directive.*", description: "Inject persistent text into the AI's system prompt", valueType: "string" },
    { path: "@prompt.entry.*", description: "Override an entry's enabled state (true/false)", valueType: "boolean" },
    { path: "@prompt.context", description: "One-shot context message injected before next AI response", valueType: "string" },
  ],
};

const UI_SYSTEM: SystemDefinition = {
  id: "ui",
  name: "Player UI",
  description: "Notifications, choices, and player-facing feedback",
  category: "Core",
  alwaysActive: true,
  events: [],
  statePaths: [
    { path: "@ui.notification", description: "Show a toast notification to the player", valueType: "string" },
    { path: "@ui.choices", description: "Show action choices to the player", valueType: "json" },
  ],
};

/** All built-in systems shipped with the engine */
export const BUILT_IN_SYSTEMS: SystemDefinition[] = [
  CHAT_SYSTEM,
  STATE_SYSTEM,
  AUDIO_SYSTEM,
  PROMPT_SYSTEM,
  UI_SYSTEM,
  SPATIAL_SYSTEM,
  TIMER_SYSTEM,
];

/**
 * Registry of available systems. Populated with built-ins on creation,
 * extensible via register() for community/custom systems.
 */
export class SystemRegistry {
  private systems = new Map<string, SystemDefinition>();

  constructor() {
    for (const system of BUILT_IN_SYSTEMS) {
      this.systems.set(system.id, system);
    }
  }

  /** Register a new system (or override a built-in) */
  register(system: SystemDefinition): void {
    this.systems.set(system.id, system);
  }

  /** Get a system by ID */
  get(id: string): SystemDefinition | undefined {
    return this.systems.get(id);
  }

  /** Get all registered systems */
  getAll(): SystemDefinition[] {
    return [...this.systems.values()];
  }

  /** Get systems filtered by active state for a world */
  getForWorld(systemIds?: string[]): SystemDefinition[] {
    if (!systemIds) {
      // Default: return all always-active systems
      return this.getAll().filter((s) => s.alwaysActive);
    }
    // Return always-active + explicitly requested
    return this.getAll().filter(
      (s) => s.alwaysActive || systemIds.includes(s.id)
    );
  }

  /** Get all event definitions from active systems (for editor WHEN picker) */
  getAvailableEvents(systemIds?: string[]): Array<{ system: string; event: import("./types.js").EventDefinition }> {
    const systems = this.getForWorld(systemIds);
    const result: Array<{ system: string; event: import("./types.js").EventDefinition }> = [];
    for (const sys of systems) {
      for (const event of sys.events) {
        result.push({ system: sys.id, event });
      }
    }
    return result;
  }

  /** Get all state path definitions from active systems (for editor THEN picker) */
  getAvailableStatePaths(systemIds?: string[]): Array<{ system: string; statePath: import("./types.js").StatePathDefinition }> {
    const systems = this.getForWorld(systemIds);
    const result: Array<{ system: string; statePath: import("./types.js").StatePathDefinition }> = [];
    for (const sys of systems) {
      for (const sp of sys.statePaths) {
        result.push({ system: sys.id, statePath: sp });
      }
    }
    return result;
  }
}
