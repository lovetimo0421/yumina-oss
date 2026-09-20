// The registration map from extension clientEntry ids (see
// ExtensionDefinition.clientEntry in packages/shared/src/types/extension.ts)
// to their sandbox client register() functions.
//
// These are STATIC imports, NOT runtime dynamic import()s, and that is
// load-bearing: the sandbox runs inside an opaque-origin iframe
// (sandbox="allow-scripts" with no allow-same-origin) served under a strict
// CSP (connect-src 'none'). A runtime dynamic import() of a code-split chunk
// does NOT load there in production — it only appeared to work under the dev
// server's permissive CORS + absent CSP. Bundling the client modules eagerly
// and gating them by install state at render time (SlotOutlet → enabledEntries)
// keeps the Context button correct in every environment.
//
// Trade-off vs. the original lazy design: a first-party extension's client code
// ships in the sandbox bundle even when uninstalled (the heavy modal already
// did in the pre-registry system) — but it is never RENDERED unless installed.
//
// Adding a first-party extension's UI = add its module under
// sandbox/extensions/<entry>/client.tsx and one line here.

import { makeExtensionClientContext, setEnabledExtensionEntries, type ExtensionClientContext } from "./registry";
import registerSessionMemory from "./session-memory/client";
import registerTurnCounter from "./turn-counter/client";
import registerStateUpdateGuard from "./state-update-guard/client";

type ExtensionRegister = (ctx: ExtensionClientContext) => void;

const EXTENSION_CLIENT_MODULES: Record<string, ExtensionRegister> = {
  "session-memory": registerSessionMemory,
  "turn-counter": registerTurnCounter,
  "state-update-guard": registerStateUpdateGuard,
};

const registered = new Set<string>();

/**
 * Called by the component host whenever the ui channel delivers the installed
 * list. Registers each newly-installed extension's contributions (once) and
 * updates the render gate. Uninstall mid-session: the registration stays but
 * its contributions stop rendering (gated by enabledEntries); reinstall
 * re-enables them instantly.
 */
export function syncInstalledExtensions(installedEntries: string[]): void {
  for (const entry of installedEntries) {
    if (registered.has(entry)) continue;
    const register = EXTENSION_CLIENT_MODULES[entry];
    if (!register) continue;
    registered.add(entry);
    try {
      register(makeExtensionClientContext(entry));
    } catch (err) {
      console.error(`[Extensions] register("${entry}") failed:`, err);
      registered.delete(entry); // allow a retry on the next push
    }
  }
  setEnabledExtensionEntries(installedEntries);
}
