/**
 * window.yumina — Global API for non-React sandbox components (HTML/CSS/JS).
 *
 * Mirrors the SandboxedYuminaAPI from sandbox-context.tsx but as a plain
 * global object instead of a React hook. Exposed in ALL sandbox modes so
 * HTML <script> tags can access game state and actions.
 *
 * Usage (inside HTML component):
 *   const yumina = window.yumina;
 *   yumina.sendMessage("hello");
 *   yumina.onChange(() => {
 *     console.log(yumina.variables);
 *   });
 */

import type { SandboxedYuminaAPI } from "./sandbox-context";
import { buildAPI } from "./sandbox-context";
import type { SandboxState } from "./protocol";

// ── Change listeners ───────────────────────────────────────────────

const EVENT_NAME = "yumina:statechange";

type ChangeCallback = () => void;

function onChange(callback: ChangeCallback): () => void {
  window.addEventListener(EVENT_NAME, callback);
  return () => window.removeEventListener(EVENT_NAME, callback);
}

function offChange(callback: ChangeCallback): void {
  window.removeEventListener(EVENT_NAME, callback);
}

// ── Global object ──────────────────────────────────────────────────

export interface YuminaGlobal extends SandboxedYuminaAPI {
  /** Register a listener called on every state update. Returns an unsubscribe function. */
  onChange: (callback: ChangeCallback) => () => void;
  /** Unregister a previously registered listener. */
  offChange: (callback: ChangeCallback) => void;
}

let currentGlobal: YuminaGlobal | null = null;

/**
 * Initialize window.yumina with a default (empty) state.
 * Called once during sandbox boot, before any components are installed.
 */
export function initYuminaGlobal(initialState: SandboxState): void {
  const api = buildAPI(initialState);
  currentGlobal = Object.assign(api, { onChange, offChange }) as YuminaGlobal;
  (window as any).yumina = currentGlobal;
}

/**
 * Update window.yumina with fresh state from the parent.
 * Called on every `state` message from the parent frame.
 * Mutates the existing global object in-place so that references held
 * by creator scripts remain valid.
 */
export function updateYuminaGlobal(state: SandboxState): void {
  if (!currentGlobal) {
    initYuminaGlobal(state);
    return;
  }

  const api = buildAPI(state);

  // Copy all API properties onto the existing global object.
  // This preserves the object identity so `const y = window.yumina` keeps working.
  for (const key of Object.keys(api) as (keyof SandboxedYuminaAPI)[]) {
    (currentGlobal as any)[key] = (api as any)[key];
  }

  // Notify listeners
  window.dispatchEvent(new CustomEvent(EVENT_NAME));
}
