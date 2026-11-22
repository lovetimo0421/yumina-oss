import { transformTSX } from "@yumina/shared/card-code";
import { buildComponent, type CompileResult, type CompileRuntimeScope } from "./tsx-component-builder";

export type { CompileResult, CompileRuntimeScope };

// SECURITY MODEL — be precise, this compiler does NOT sandbox anything.
// Compiled creator code runs via new Function() with full access to whatever
// globals its execution context provides (window, document, fetch, …). There
// is no pattern blocking and no global shadowing here — an earlier
// BLOCKED_PATTERNS safety net was removed long ago and only its docstring
// survived, falsely advertising protection. Real containment comes from WHERE
// the code runs: play-time execution happens inside the sandboxed iframe
// (allow-scripts, opaque origin, CSP connect-src 'none', origin-validated
// postMessage bridge — see packages/app/sandbox/), and the server endpoints
// remain the sole authority for anything that matters.

/**
 * Compiles TSX code string into a React component using Sucrase.
 *
 * TypeScript annotations are transparently stripped before compilation so both
 * pure JSX and TypeScript-flavored JSX work correctly.
 *
 * @param useYuminaHook — The `useYumina` hook to expose to compiled components.
 *   When null (editor preview), a no-op version is injected.
 */
export function compileTSX(
  code: string,
  useYuminaHook?: () => unknown,
  runtimeScope: CompileRuntimeScope = {},
  file?: string,
): CompileResult {
  const result = transformTSX(code, file);
  if (result.code === null) return { Component: null, error: result.error, diagnostic: result.diagnostic };
  return buildComponent(result.code, useYuminaHook, runtimeScope, { files: { [file ?? "<component>"]: code } });
}

/** Parent-side TSX → JS transform, from @yumina/shared/card-code (the server
 *  stamps cards with the same function). The compiled JS can be fed straight
 *  into buildComponent (in either the parent or the sandbox). */
export { transformTSX, type TransformResult } from "@yumina/shared/card-code";
