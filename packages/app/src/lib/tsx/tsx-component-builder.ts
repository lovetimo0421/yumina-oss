/** Component-building helpers that turn ALREADY-TRANSFORMED JS code into a
 *  React component via `new Function(...)`. Importantly, this module has NO
 *  Sucrase dependency — so when the sandbox iframe imports from here, Rollup
 *  tree-shakes the ~956K Sucrase bundle out of the sandbox entry completely.
 *
 *  Split from tsx-compiler.ts so:
 *    - Parent (main app) uses tsx-compiler.ts for the full TSX→JS pipeline
 *      (Studio editor preview + pre-install compile before postMessage).
 *    - Sandbox iframe uses only this module on the install-time fast path —
 *      it receives pre-compiled JS from the parent and evaluates it.
 *
 *  Perf note: this saves ~956K on the critical-path sandbox boot bundle,
 *  which is the largest single chunk the sandbox used to pull in.
 */
import React from "react";
import { LucideScope } from "./lucide-scope";

export interface CompileResult {
  Component: React.ComponentType<Record<string, unknown>> | null;
  error: string | null;
}

export interface CompileRuntimeScope {
  useAssetFont?: (assetRef: string, options?: Record<string, unknown>) => string;
  ChatCanvas?: React.ComponentType<Record<string, unknown>>;
  Chat?: React.ComponentType<Record<string, unknown>>;
  MessageList?: React.ComponentType<Record<string, unknown>>;
  MessageInput?: React.ComponentType<Record<string, unknown>>;
  ModelPickerModal?: React.ComponentType<Record<string, unknown>>;
  ModelTrigger?: React.ComponentType<Record<string, unknown>>;
  SessionMemoryModal?: React.ComponentType<Record<string, unknown>>;
  LoreSlot?: React.ComponentType<Record<string, unknown>>;
  LoreButton?: React.ComponentType<Record<string, unknown>>;
  LorePanel?: React.ComponentType<Record<string, unknown>>;
  LoreGroup?: React.ComponentType<Record<string, unknown>>;
  LoreSwitch?: React.ComponentType<Record<string, unknown>>;
}

/** Wraps ALREADY-TRANSFORMED JS code in a `new Function(...)` with the runtime
 *  scope (React, useYumina, Icons, chat building blocks) injected as arguments. */
export function buildComponent(
  transformedCode: string,
  useYuminaHook?: () => unknown,
  runtimeScope: CompileRuntimeScope = {}
): CompileResult {
  // Strip ES module syntax (not supported by new Function())
  let strippedCode = transformedCode;

  // 0. Strip import statements (multi-file root components have inter-file imports)
  strippedCode = strippedCode.replace(/import\s+.*?\s+from\s+['"][^'"]+['"]\s*;?/g, "");
  strippedCode = strippedCode.replace(/import\s+['"][^'"]+['"]\s*;?/g, "");

  // 1. Named function export: export default function Foo(...) → capture name
  let defaultExportName: string | null = null;
  strippedCode = strippedCode.replace(
    /export\s+default\s+function\s+(\w+)/,
    (_, name) => {
      defaultExportName = name;
      return `function ${name}`;
    }
  );

  // 2. Any remaining export default <expr> → assign to temp var
  if (!defaultExportName) {
    strippedCode = strippedCode.replace(
      /export\s+default\s+/,
      "var __yumina_default__ = "
    );
  }

  // 3. Strip named exports: export { Foo, Bar }
  strippedCode = strippedCode.replace(/export\s*\{[^}]*\}\s*;?/g, "");

  // 4. Strip named function/const/let/var exports: export function X → function X
  strippedCode = strippedCode.replace(/export\s+function\s+/g, "function ");
  strippedCode = strippedCode.replace(/export\s+(const|let|var)\s+/g, "$1 ");

  const fallback = defaultExportName
    ? defaultExportName
    : "typeof __yumina_default__ !== 'undefined' ? __yumina_default__ : null";

  const wrappedCode = `
    ${strippedCode}
    return typeof exports !== 'undefined' && exports.default
      ? exports.default
      : typeof module !== 'undefined' && module.exports && module.exports.default
        ? module.exports.default
        : ${fallback};
  `;

  const safeHook =
    useYuminaHook ??
    (() => ({
      sendMessage: () => {},
      setVariable: () => {},
      executeAction: () => {},
      variables: {},
      worldName: "",
    }));
  const safeUseAssetFont = runtimeScope.useAssetFont ?? (() => "");

  try {
    const factory = new Function(
      "React",
      "useYumina",
      "useAssetFont",
      "Icons",
      "ChatCanvas",
      "Chat",
      "MessageList",
      "MessageInput",
      "ModelPickerModal",
      "ModelTrigger",
      "SessionMemoryModal",
      "LoreSlot",
      "LoreButton",
      "LorePanel",
      "LoreGroup",
      "LoreSwitch",
      "exports",
      "module",
      wrappedCode
    );
    const exports: Record<string, unknown> = {};
    const module = { exports: {} as Record<string, unknown> };
    const safeChatCanvas = runtimeScope.ChatCanvas ?? (() => null);
    const safeChat = runtimeScope.Chat ?? (() => null);
    const safeMessageList = runtimeScope.MessageList ?? (() => null);
    const safeMessageInput = runtimeScope.MessageInput ?? (() => null);
    const safeModelPickerModal = runtimeScope.ModelPickerModal ?? (() => null);
    const safeModelTrigger = runtimeScope.ModelTrigger ?? (() => null);
    const safeSessionMemoryModal = runtimeScope.SessionMemoryModal ?? (() => null);
    const safeLoreSlot = runtimeScope.LoreSlot ?? (() => null);
    const safeLoreButton = runtimeScope.LoreButton ?? (() => null);
    const safeLorePanel = runtimeScope.LorePanel ?? (() => null);
    const safeLoreGroup = runtimeScope.LoreGroup ?? (() => null);
    const safeLoreSwitch = runtimeScope.LoreSwitch ?? (() => null);
    const Component = factory(
      React,
      safeHook,
      safeUseAssetFont,
      LucideScope,
      safeChatCanvas,
      safeChat,
      safeMessageList,
      safeMessageInput,
      safeModelPickerModal,
      safeModelTrigger,
      safeSessionMemoryModal,
      safeLoreSlot,
      safeLoreButton,
      safeLorePanel,
      safeLoreGroup,
      safeLoreSwitch,
      exports,
      module,
    );

    if (typeof Component === "function") {
      return { Component, error: null };
    }

    const defaultExport = exports.default ?? module.exports.default;
    if (typeof defaultExport === "function") {
      return {
        Component: defaultExport as React.ComponentType<Record<string, unknown>>,
        error: null,
      };
    }

    return {
      Component: null,
      error: "No component exported. Use `export default function ...`",
    };
  } catch (err) {
    return {
      Component: null,
      error: err instanceof Error ? err.message : "Runtime error",
    };
  }
}
