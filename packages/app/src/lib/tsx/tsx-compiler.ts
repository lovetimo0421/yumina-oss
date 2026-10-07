import { transform } from "sucrase";
import { buildComponent, type CompileResult, type CompileRuntimeScope } from "./tsx-component-builder";

export type { CompileResult, CompileRuntimeScope };

/**
 * Strip TypeScript-specific syntax that Sucrase may struggle with in JSX context.
 * This transparently handles AI-generated TypeScript so creators don't need to
 * think about it — generics, type annotations, etc. are removed before compilation.
 */
function stripTypeScript(code: string): string {
  let result = code;

  // Remove interface/type declarations (multi-line)
  result = result.replace(/^\s*(?:export\s+)?(?:interface|type)\s+\w+[^{]*\{[^}]*\}/gm, "");
  // Remove single-line type aliases: type Foo = string | number;
  result = result.replace(/^\s*(?:export\s+)?type\s+\w+\s*=[^;\n]+;?/gm, "");

  // Remove generic type parameters from function calls: useState<string | null>() → useState()
  // Handles nested generics: Record<string, Array<number>> by matching balanced angle brackets
  result = result.replace(/(\w+)\s*<([^>]*(?:<[^>]*>[^>]*)*)>\s*\(/g, "$1(");

  // Remove 'as Type' assertions: value as string → value
  // Be careful not to match inside strings
  result = result.replace(/\bas\s+(?:const|[A-Z]\w*(?:\[\])?(?:\s*\|\s*\w+)*)/g, "");

  // Remove type annotations from function parameters: (x: string, y: number) → (x, y)
  result = result.replace(/(\w+)\s*:\s*(?:string|number|boolean|any|void|null|undefined|Record|Array|object|unknown|never)(?:<[^>]*>)?(?:\s*\|\s*(?:string|number|boolean|null|undefined|unknown|never)(?:<[^>]*>)?)*/g, "$1");

  // Remove return type annotations: function foo(): string { → function foo() {
  result = result.replace(/\)\s*:\s*(?:JSX\.Element|React\.ReactNode|React\.ReactElement|string|number|boolean|void|null|any)\s*(?:\{|\=>)/g, (match) => {
    return match.endsWith("{") ? ") {" : ") =>";
  });

  return result;
}

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
  runtimeScope: CompileRuntimeScope = {}
): CompileResult {
  try {
    // Try the original source first. Pre-stripping can corrupt large string literals
    // such as Tavern-generated renderer payloads that legitimately contain `: null`.
    const result = transform(code, {
      transforms: ["typescript", "jsx"],
      jsxRuntime: "classic",
      production: true,
    });

    return buildComponent(result.code, useYuminaHook, runtimeScope);
  } catch (firstError) {
    // Some AI-authored TSX still confuses Sucrase. Fall back to the lossy stripper
    // only after the raw source path fails, so plain JS/string-heavy renderers survive.
    const cleanedCode = stripTypeScript(code);

    try {
      const result = transform(cleanedCode, {
        transforms: ["typescript", "jsx"],
        jsxRuntime: "classic",
        production: true,
      });
      return buildComponent(result.code, useYuminaHook, runtimeScope);
    } catch {
      // Final fallback: JSX-only transform for code that was already effectively JS.
      try {
        const result = transform(cleanedCode, {
          transforms: ["jsx"],
          jsxRuntime: "classic",
          production: true,
        });
        return buildComponent(result.code, useYuminaHook, runtimeScope);
      } catch (err) {
        return {
          Component: null,
          error: err instanceof Error ? err.message : "Compilation failed",
        };
      }
    }
  }
}

/** Parent-side TSX → JS transform. The compiled JS can be fed straight into
 *  buildComponent (in either the parent or the sandbox). Exposed separately so
 *  the parent can pre-compile before posting an install message, keeping the
 *  sandbox bundle free of Sucrase. */
export interface TransformResult {
  code: string | null;
  error: string | null;
}

export function transformTSX(code: string): TransformResult {
  try {
    const result = transform(code, {
      transforms: ["typescript", "jsx"],
      jsxRuntime: "classic",
      production: true,
    });
    return { code: result.code, error: null };
  } catch {
    // Some AI-authored TSX confuses Sucrase. Fall back to the lossy stripper.
    const cleanedCode = stripTypeScript(code);
    try {
      const result = transform(cleanedCode, {
        transforms: ["typescript", "jsx"],
        jsxRuntime: "classic",
        production: true,
      });
      return { code: result.code, error: null };
    } catch {
      try {
        const result = transform(cleanedCode, {
          transforms: ["jsx"],
          jsxRuntime: "classic",
          production: true,
        });
        return { code: result.code, error: null };
      } catch (err) {
        return {
          code: null,
          error: err instanceof Error ? err.message : "Compilation failed",
        };
      }
    }
  }
}
