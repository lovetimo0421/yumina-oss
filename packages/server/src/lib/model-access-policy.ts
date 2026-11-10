/**
 * Model-access tripwire registry (2026-10-10). Every source file that calls
 * an LLM or hands out a provider key says who picks the model and where the
 * player's plan is checked. The billing tripwire (billing-coverage.test.ts)
 * guarantees every call is paid for; this one guarantees no call quietly
 * runs a model above the player's plan. model-access-coverage.test.ts fails
 * when a file is missing here, or when a "plan-gated" file stops checking.
 *
 * Adding a new AI call (a plugin, a card feature, an extension): route it
 * through planAllowedModel / beginModuleGeneration / validateModelAccess and
 * register it as "plan-gated". Anything else needs a reason below.
 */
export type ModelAccessPolicy =
  /** The player or the card picks the model and the player pays: the plan is
   *  checked in each `gatedIn` file (paths relative to src/). */
  | { kind: "plan-gated"; gatedIn: string[] }
  /** Studio: creators may build with any model on purpose (owner, 2026-10-10:
   *  "我们鼓励创作者用任何模型创作"). */
  | { kind: "studio-open" }
  /** The platform fixes the model; no player or card can choose it. */
  | { kind: "platform-model" }
  /** Runs only on the player's own key. */
  | { kind: "byok-only" }
  /** Transport or key resolution itself, not a call site. */
  | { kind: "provider" };

const self = (file: string): ModelAccessPolicy => ({ kind: "plan-gated", gatedIn: [file] });

export const MODEL_ACCESS_POLICY: Record<string, ModelAccessPolicy> = {
  // ── Player / card chosen, plan-gated ──
  "routes/messages.ts": self("routes/messages.ts"),
  "routes/completions.ts": self("routes/completions.ts"),
  "routes/realtime-video.ts": self("routes/realtime-video.ts"),
  "lib/session-compaction.ts": self("lib/session-compaction.ts"),
  "lib/session-memory.ts": self("lib/session-memory.ts"),
  "lib/summaryception.ts": self("lib/summaryception.ts"),
  "lib/module-generation-access.ts": self("lib/module-generation-access.ts"),
  "lib/station-model.ts": self("lib/station-model.ts"),
  "lib/group-reply.ts": self("lib/group-reply.ts"),
  "lib/plan-model-gate.ts": self("lib/plan-model-gate.ts"),
  "extensions/state-update-guard/model.ts": self("extensions/state-update-guard/model.ts"),
  "extensions/state-update-guard/validate.ts": { kind: "plan-gated", gatedIn: ["extensions/state-update-guard/model.ts"] },

  // ── Studio: any model, on purpose ──
  "routes/agent.ts": { kind: "studio-open" },
  "lib/studio-tools/generate-stream-with-retry.ts": { kind: "studio-open" },
  "lib/studio-source-digest.ts": { kind: "studio-open" },

  // ── Platform-fixed models ──
  "routes/decisions.ts": { kind: "platform-model" }, // Jev judge; narrativeModel only picks whose key
  "lib/continuity/missed-updates.ts": { kind: "platform-model" },
  "lib/music/openrouter-music.ts": { kind: "platform-model" },
  "lib/per-turn-image/illustrate.ts": { kind: "platform-model" },
  "lib/translate.ts": { kind: "platform-model" },
  "lib/changelog-translate.ts": { kind: "platform-model" }, // admin update log, fixed model

  // ── Player's own key only ──
  "lib/memory-extractor.ts": { kind: "byok-only" },

  // ── Transport / key resolution ──
  "lib/llm/openrouter.ts": { kind: "provider" },
  "lib/llm/openai.ts": { kind: "provider" },
  "lib/llm/custom.ts": { kind: "provider" },
};
