/**
 * The DO half of a behavior: the preset catalogue, the reverse lookup that
 * decides which preset an existing effect came from, and the field values it
 * puts back into the form.
 *
 * These three are one round trip — build(fields) must reproduce the effect
 * identifyPreset/extractFieldValues took apart. When it does not, opening a
 * behavior and saving it silently rewrites what the author wrote, which is why
 * they live here with a test on them rather than inside a 2000-line section.
 */
import { Bell, Eye, MessageSquare, Settings2, Volume2, Zap } from "lucide-react";
import type { ReactionEffect } from "@yumina/engine";

type TFn = (key: any) => string;

export interface DoPreset {
  id: string;
  label: string;
  icon: typeof Zap;
  category: string;
  /** Create the ReactionEffect from user input */
  build: (input: Record<string, string>) => ReactionEffect;
  /** Fields to show for this action */
  fields: DoField[];
}

export interface DoField {
  name: string;
  label: string;
  type: "text" | "textarea" | "number" | "variable" | "entry" | "audio" | "select" | "behavior" | "operand";
  placeholder?: string;
  options?: { value: string; label: string }[];
}

export function getDoPresets(t: TFn): DoPreset[] {
  return [
    // Game
    {
      id: "change-var", label: t("behaviors.doPresets.changeVar"), icon: Zap, category: t("behaviors.doCategories.game"),
      fields: [
        { name: "variableId", label: t("behaviors.doFields.variable"), type: "variable" },
        { name: "operation", label: t("behaviors.doFields.operation"), type: "select", options: [
          { value: "set", label: t("behaviors.effectOps.set") }, { value: "add", label: t("behaviors.effectOps.add") },
          { value: "subtract", label: t("behaviors.effectOps.subtract") }, { value: "multiply", label: t("behaviors.effectOps.multiply") },
          { value: "toggle", label: t("behaviors.effectOps.toggle") }, { value: "append", label: t("behaviors.effectOps.append") },
        ] },
        { name: "value", label: t("behaviors.doFields.value"), type: "operand", placeholder: "10" },
      ],
      build: (input) => {
        const raw = input.value ?? "0";
        // "@ref:<id>" means the operand is another variable's value (变量 mode).
        if (raw.startsWith("@ref:")) {
          const ref = raw.slice(5);
          return { type: "set", path: input.variableId ?? "", value: 0, operation: (input.operation ?? "set") as any, valueRef: ref || undefined };
        }
        return { type: "set", path: input.variableId ?? "", value: parseSmartValue(raw), operation: (input.operation ?? "set") as any };
      },
    },
    {
      id: "toggle-variable", label: t("behaviors.doPresets.toggleVariable"), icon: Settings2, category: t("behaviors.doCategories.game"),
      fields: [
        { name: "variableId", label: t("behaviors.doFields.variable"), type: "variable" },
        { name: "enabled", label: t("behaviors.doFields.state"), type: "select", options: [{ value: "true", label: t("behaviors.doFields.enable") }, { value: "false", label: t("behaviors.doFields.disable") }] },
      ],
      // Enable-gate override — while off, the variable leaves <game-state> and
      // the player UI but keeps its value. See state/variable-activation.ts.
      build: (input) => ({ type: "set", path: `@vars.enabled.${input.variableId ?? ""}`, value: input.enabled === "true", operation: "set" }),
    },
    // AI & Story
    {
      id: "tell-ai", label: t("behaviors.doPresets.tellAi"), icon: MessageSquare, category: t("behaviors.doCategories.aiStory"),
      fields: [
        { name: "content", label: t("behaviors.doFields.instructionForAi"), type: "textarea", placeholder: t("extra.behaviorInstr") },
      ],
      // One-shot: injected into the next AI prompt via the pendingContext channel,
      // then automatically cleared. For persistent guidance use enable/disable entry instead.
      build: (input) => ({ type: "set", path: "@prompt.context", value: input.content ?? "", operation: "set" }),
    },
    {
      id: "enable-entry", label: t("behaviors.doPresets.enableEntry"), icon: Eye, category: t("behaviors.doCategories.aiStory"),
      fields: [{ name: "entryId", label: t("behaviors.doFields.entry"), type: "entry" }],
      build: (input) => ({ type: "set", path: `@prompt.entry.${input.entryId ?? ""}`, value: true, operation: "set" }),
    },
    {
      id: "disable-entry", label: t("behaviors.doPresets.disableEntry"), icon: Eye, category: t("behaviors.doCategories.aiStory"),
      fields: [{ name: "entryId", label: t("behaviors.doFields.entry"), type: "entry" }],
      build: (input) => ({ type: "set", path: `@prompt.entry.${input.entryId ?? ""}`, value: false, operation: "set" }),
    },
    // Audio
    {
      id: "play-music", label: t("behaviors.doPresets.playMusic"), icon: Volume2, category: t("behaviors.doCategories.audio"),
      fields: [{ name: "trackId", label: t("behaviors.doFields.track"), type: "audio" }],
      build: (input) => ({ type: "set", path: "@audio.bgm", value: input.trackId ?? "", operation: "set" }),
    },
    {
      id: "play-sfx", label: t("behaviors.doPresets.playSfx"), icon: Volume2, category: t("behaviors.doCategories.audio"),
      fields: [{ name: "trackId", label: t("behaviors.doFields.track"), type: "audio" }],
      build: (input) => ({ type: "set", path: "@audio.sfx", value: input.trackId ?? "", operation: "set" }),
    },
    {
      id: "stop-audio", label: t("behaviors.doPresets.stopAudio"), icon: Volume2, category: t("behaviors.doCategories.audio"),
      fields: [{ name: "trackId", label: t("behaviors.doFields.track"), type: "audio" }],
      build: (input) => ({ type: "set", path: "@audio.stop", value: input.trackId ?? "", operation: "set" }),
    },
    // Player
    {
      id: "notify", label: t("behaviors.doPresets.notify"), icon: Bell, category: t("behaviors.doCategories.player"),
      fields: [
        { name: "message", label: t("behaviors.doFields.message"), type: "text", placeholder: t("extra.behaviorMsg") },
        { name: "style", label: t("behaviors.doFields.notifyStyle"), type: "select", options: [
          { value: "info", label: t("behaviors.doFields.notifyStyleInfo") },
          { value: "success", label: t("behaviors.doFields.notifyStyleSuccess") },
          { value: "warning", label: t("behaviors.doFields.notifyStyleWarning") },
          { value: "error", label: t("behaviors.doFields.notifyStyleError") },
        ] },
      ],
      build: (input) => ({ type: "emit", event: { type: "ui:notification", message: input.message ?? "", style: input.style || "info" } }),
    },
    // 时刻: unlock a moment once — a card with its picture, kept in a list
    // (mark the list 跨存档保留 to make it once per player).
    {
      id: "moment", label: t("behaviors.doPresets.moment"), icon: Bell, category: t("behaviors.doCategories.player"),
      fields: [
        { name: "title", label: t("behaviors.doFields.momentTitle"), type: "text", placeholder: t("behaviors.doFields.momentTitlePlaceholder") },
        { name: "message", label: t("behaviors.doFields.message"), type: "textarea" },
        { name: "image", label: t("behaviors.doFields.momentImage"), type: "text", placeholder: "https://… / assets/…" },
        { name: "collect", label: t("behaviors.doFields.momentCollect"), type: "variable" },
      ],
      build: (input) => ({ type: "emit", event: { type: "ui:moment", title: input.title ?? "", message: input.message ?? "", ...(input.image ? { image: input.image } : {}), ...(input.collect ? { collect: input.collect } : {}) } }),
    },
    // Advanced
    {
      id: "toggle-behavior", label: t("behaviors.doPresets.toggleBehavior"), icon: Settings2, category: t("behaviors.doCategories.advanced"),
      fields: [
        { name: "ruleId", label: t("behaviors.doFields.behavior"), type: "behavior" },
        { name: "enabled", label: t("behaviors.doFields.state"), type: "select", options: [{ value: "true", label: t("behaviors.doFields.enable") }, { value: "false", label: t("behaviors.doFields.disable") }] },
      ],
      build: (input) => ({ type: "set", path: `@rules.disabled.${input.ruleId ?? ""}`, value: input.enabled !== "true", operation: "set" }),
    },
  ];
}

export function parseSmartValue(raw: string): any {
  if (raw === "true") return true;
  if (raw === "false") return false;
  const num = Number(raw);
  // Whitespace-only text is not a number (Number(" ") === 0 would turn a
  // typed space into 0).
  if (!isNaN(num) && raw.trim() !== "") return num;
  return raw;
}

// ══════════════════════════════════════════════
// Reverse-engineer which preset an effect matches
// ══════════════════════════════════════════════

export function identifyPreset(effect: ReactionEffect, presets: DoPreset[]): DoPreset | null {
  if (effect.type === "set") {
    const e = effect as Extract<ReactionEffect, { type: "set" }>;
    if (!e.path.startsWith("@")) return presets.find((p) => p.id === "change-var") ?? null;
    if (e.path.startsWith("@audio.bgm")) return presets.find((p) => p.id === "play-music") ?? null;
    if (e.path.startsWith("@audio.sfx")) return presets.find((p) => p.id === "play-sfx") ?? null;
    if (e.path.startsWith("@audio.stop")) return presets.find((p) => p.id === "stop-audio") ?? null;
    // New Tell AI effects use @prompt.context. Legacy directives also appear
    // as tell-ai; text edits retain their original path and lifetime settings.
    // Legacy stop-tell-ai (value === false) is shown as a generic custom effect
    // so creators can review and delete it — the feature is gone.
    if (e.path === "@prompt.context") return presets.find((p) => p.id === "tell-ai") ?? null;
    if (e.path.startsWith("@prompt.directive.") && e.value !== false) return presets.find((p) => p.id === "tell-ai") ?? null;
    if (e.path.startsWith("@prompt.entry.")) return e.value ? presets.find((p) => p.id === "enable-entry") ?? null : presets.find((p) => p.id === "disable-entry") ?? null;
    if (e.path === "@ui.notification") return presets.find((p) => p.id === "notify") ?? null;
    if (e.path.startsWith("@rules.disabled.")) return presets.find((p) => p.id === "toggle-behavior") ?? null;
    if (e.path.startsWith("@vars.enabled.")) return presets.find((p) => p.id === "toggle-variable") ?? null;
    // @ai.request, @timer.start, @timer.cancel are intentionally not surfaced
    // — those runtime systems were removed. Legacy effects fall through to the
    // raw-effect display so creators can spot and delete them.
  }
  if (effect.type === "emit") {
    const e = effect as Extract<ReactionEffect, { type: "emit" }>;
    if (e.event.type === "ui:notification") return presets.find((p) => p.id === "notify") ?? null;
    if (e.event.type === "ui:moment") return presets.find((p) => p.id === "moment") ?? null;
  }
  return null;
}

export function extractFieldValues(effect: ReactionEffect, preset: DoPreset | null): Record<string, string> {
  if (!preset) return {};
  const fields: Record<string, string> = {};

  if (effect.type === "set") {
    const e = effect as Extract<ReactionEffect, { type: "set" }>;
    switch (preset.id) {
      case "change-var":
        fields.variableId = e.path;
        fields.operation = (e.operation ?? "set");
        fields.value = e.valueRef ? `@ref:${e.valueRef}` : String(e.value ?? "");
        break;
      case "tell-ai":
        // Handles both @prompt.context (new one-shot) and legacy @prompt.directive.* (string value).
        fields.content = typeof e.value === "string" ? e.value : typeof e.value === "object" && e.value !== null && "content" in (e.value as any) ? (e.value as any).content : String(e.value);
        break;
      case "enable-entry":
      case "disable-entry":
        fields.entryId = e.path.replace("@prompt.entry.", "");
        break;
      case "play-music":
      case "play-sfx":
      case "stop-audio":
        fields.trackId = String(e.value ?? "");
        break;
      case "notify":
        fields.message = String(e.value ?? "");
        break;
      case "toggle-behavior":
        fields.ruleId = e.path.replace("@rules.disabled.", "");
        fields.enabled = e.value ? "false" : "true"; // inverted: disabled=true means enabled=false
        break;
      case "toggle-variable":
        fields.variableId = e.path.replace("@vars.enabled.", "");
        fields.enabled = e.value ? "true" : "false";
        break;
    }
  }

  if (effect.type === "emit") {
    const e = effect as Extract<ReactionEffect, { type: "emit" }>;
    if (preset.id === "notify") {
      fields.message = String(e.event.message ?? "");
      fields.style = typeof e.event.style === "string" ? e.event.style : "info";
    }
    if (preset.id === "moment") {
      fields.title = String(e.event.title ?? "");
      fields.message = String(e.event.message ?? "");
      fields.image = typeof e.event.image === "string" ? e.event.image : "";
      fields.collect = typeof e.event.collect === "string" ? e.event.collect : "";
    }
  }

  return fields;
}
