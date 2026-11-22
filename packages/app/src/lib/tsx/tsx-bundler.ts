/**
 * Multi-file TSX Bundler for root component worlds.
 *
 * Resolves imports between files in a virtual file system, compiles each
 * file independently with Sucrase, and bundles them into a single
 * new Function() for execution in the sandbox.
 *
 * Each imported file becomes an IIFE in the bundled output:
 *   const __mod_stat_bar = (() => { ...compiled code...; return exports; })();
 *
 * The entry file's import statements become variable assignments:
 *   const StatBar = __mod_stat_bar.default;
 *   const { Foo, Bar } = __mod_utils;
 */

import React from "react";
import {
  assembleBundle,
  compileFile,
  parseImports,
  resolveFile,
  type BundleInput,
} from "@yumina/shared/card-code";
import { LucideScope } from "@/lib/tsx/lucide-scope";
import { loadThree } from "./load-three";
import { loadWorld } from "./load-world";
import { createCodeDiagnostic, type CodeDiagnostic } from "./diagnostics";

// The code-generating half of the bundler (import graph, per-file Sucrase,
// stitching) lives in @yumina/shared/card-code so the server can stamp cards
// with the same bytes. This file keeps what needs React: the live component
// for Studio previews and the inspect build.
export { bundleTSX, type BundleCodeResult, type BundleInput } from "@yumina/shared/card-code";

/** The attribute the inspect build stamps onto every host element it renders.
 *  Value is `<file>:<line>` — the JSX site that produced that DOM node. */
export const SOURCE_ATTR = "data-yc-src";

/** React with a `createElement` that turns Sucrase's `__source` into
 *  {@link SOURCE_ATTR} on host elements, and drops `__source`/`__self`
 *  everywhere else so they never reach the DOM or a card's own props.
 *
 *  Prototype delegation rather than a spread: React's export object carries
 *  more than its enumerable own keys (and a card may reach for anything on
 *  it), so inheriting is the only way to stay a faithful stand-in. */
function inspectReact(base: typeof React): typeof React {
  const wrapped = Object.create(base) as typeof React;
  Object.defineProperty(wrapped, "createElement", {
    value(type: unknown, props: unknown, ...children: unknown[]) {
      if (!props || typeof props !== "object") {
        return base.createElement(type as never, props as never, ...(children as never[]));
      }
      const p = props as Record<string, unknown>;
      if (!("__source" in p) && !("__self" in p)) {
        return base.createElement(type as never, props as never, ...(children as never[]));
      }
      const src = p.__source as { fileName?: string; lineNumber?: number } | undefined;
      const next: Record<string, unknown> = { ...p };
      delete next.__source;
      delete next.__self;
      // Only host elements carry the attribute — putting it on a component
      // would hand the card an unexpected prop instead of marking the DOM.
      if (typeof type === "string" && src?.fileName && typeof src.lineNumber === "number") {
        next[SOURCE_ATTR] = `${src.fileName}:${src.lineNumber}`;
      }
      return base.createElement(type as never, next as never, ...(children as never[]));
    },
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return wrapped;
}

// ── Types ────────────────────────────────────────────────────────────

export interface CompileRuntimeScope {
  useAssetFont?: (assetRef: string, options?: Record<string, unknown>) => string;
  ChatCanvas?: React.ComponentType<Record<string, unknown>>;
  Chat?: React.ComponentType<Record<string, unknown>>;
  MessageList?: React.ComponentType<Record<string, unknown>>;
  MessageInput?: React.ComponentType<Record<string, unknown>>;
  ModelPickerModal?: React.ComponentType<Record<string, unknown>>;
  ModelTrigger?: React.ComponentType<Record<string, unknown>>;
  SessionMemoryModal?: React.ComponentType<Record<string, unknown>>;
  /** The lore-binding family. All five, because a card that names any of them
   *  and gets four is a ReferenceError, not a degraded preview — and the four
   *  that were missing here are exactly the ones the docs teach. Keep this
   *  list identical to the play sandbox's (sandbox/component-host.tsx) and to
   *  the single-file builder's (tsx-component-builder.ts): three scopes that
   *  disagree is three different answers to "does my card work". */
  LoreSlot?: React.ComponentType<Record<string, unknown>>;
  LoreButton?: React.ComponentType<Record<string, unknown>>;
  LorePanel?: React.ComponentType<Record<string, unknown>>;
  LoreGroup?: React.ComponentType<Record<string, unknown>>;
  LoreSwitch?: React.ComponentType<Record<string, unknown>>;
  RigCharacter?: React.ComponentType<Record<string, unknown>>;
  RoomParty?: React.ComponentType<Record<string, unknown>>;
}

export interface BundleResult {
  Component: React.ComponentType<Record<string, unknown>> | null;
  error: string | null;
  fileErrors?: Record<string, string>;
  diagnostic?: CodeDiagnostic;
}

/** Error-only syntax probe. new Function compiles but is NEVER invoked here.
 * Test only reachable files, so a broken unused draft cannot be blamed for an
 * unrelated failure. Runtime ReferenceErrors cannot be located this way. */
export function diagnoseBundleFailure(error: unknown, input: BundleInput): CodeDiagnostic {
  const original = createCodeDiagnostic(error, { phase: "load", files: input.files });
  if (original.name !== "SyntaxError") return original;
  const visited = new Set<string>();
  const reachable: string[] = [];
  const visit = (file: string) => {
    if (visited.has(file) || input.files[file] === undefined) return;
    visited.add(file);
    for (const imp of parseImports(input.files[file])) {
      const dependency = resolveFile(imp.specifier, file, input.files);
      if (dependency) visit(dependency);
    }
    reachable.push(file);
  };
  visit(input.entryFile);
  for (const file of reachable) {
    const compiled = compileFile(file, input.files[file]);
    if ("error" in compiled) return { ...compiled.diagnostic, revision: original.revision };
    try { new Function(compiled.code); }
    catch (failure) {
      const probe = createCodeDiagnostic(failure, { phase: "load", file, files: input.files });
      // Do not replace the original exception with a different failure.
      if (probe.name === original.name && probe.message === original.message) return { ...original, file };
    }
  }
  return original;
}

export function bundleAndCompile(
  input: BundleInput,
  useYuminaHook?: () => unknown,
  runtimeScope: CompileRuntimeScope = {},
): BundleResult {
  const assembled = assembleBundle(input);
  if (assembled.error || !assembled.code) {
    return { Component: null, error: assembled.error, fileErrors: assembled.fileErrors, diagnostic: assembled.diagnostic };
  }
  const fileErrors = assembled.fileErrors;
  const wrappedCode = assembled.code;

  // ── Step 5: Create Function and execute ──

  try {
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
    const safeRigCharacter = runtimeScope.RigCharacter ?? (() => null);
    const safeRoomParty = runtimeScope.RoomParty ?? (() => null);

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
      "RigCharacter",
      "RoomParty",
      "loadThree",
      "loadWorld",
      "exports",
      "module",
      wrappedCode,
    );

    const exports: Record<string, unknown> = {};
    const module = { exports: {} as Record<string, unknown> };

    const Component = factory(
      input.inspect ? inspectReact(React) : React,
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
      safeRigCharacter,
      safeRoomParty,
      loadThree,
      loadWorld,
      exports,
      module,
    );

    if (typeof Component === "function") {
      return { Component, error: null, fileErrors };
    }

    const defaultExport = exports.default ?? module.exports.default;
    if (typeof defaultExport === "function") {
      return {
        Component: defaultExport as React.ComponentType<Record<string, unknown>>,
        error: null,
        fileErrors,
      };
    }

    return {
      Component: null,
      error: `Entry file '${input.entryFile}' must export a default component`,
      fileErrors,
      diagnostic: createCodeDiagnostic(`Entry file '${input.entryFile}' must export a default component`, { phase: "load", file: input.entryFile, files: input.files }),
    };
  } catch (e) {
    return {
      Component: null,
      error: `Bundle runtime error: ${e instanceof Error ? e.message : String(e)}`,
      fileErrors,
      diagnostic: diagnoseBundleFailure(e, input),
    };
  }
}
