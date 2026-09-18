import type { SystemDefinition } from "../systems/types.js";

/** Timer System — countdown and interval timers */
export const TIMER_SYSTEM: SystemDefinition = {
  id: "timer",
  name: "Timers",
  description: "Countdown and interval timers that fire events",
  category: "Gameplay",
  alwaysActive: false,
  events: [
    {
      type: "timer:fired",
      description: "A timer reached zero",
      dataFields: [
        { name: "timerId", type: "string", description: "Timer ID" },
        { name: "timerName", type: "string", description: "Timer name" },
        { name: "duration", type: "number", description: "Timer duration in seconds" },
        { name: "repeat", type: "boolean", description: "Whether this timer repeats" },
      ],
    },
  ],
  statePaths: [
    { path: "@timer.start", description: "Start a timer: JSON { id, name, duration, repeat? }", valueType: "json" },
    { path: "@timer.pause", description: "Pause a timer by ID", valueType: "string" },
    { path: "@timer.resume", description: "Resume a paused timer by ID", valueType: "string" },
    { path: "@timer.cancel", description: "Cancel a timer by ID", valueType: "string" },
  ],
};
