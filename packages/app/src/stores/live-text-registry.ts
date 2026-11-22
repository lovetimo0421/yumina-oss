import type { WorldDefinition } from "@yumina/engine";

/**
 * What the editor store needs to know about text fields being typed in
 * together (features/collab/live-text), without depending on it.
 *
 * While a field is live, its shared document is the truth: other people's
 * saves, refreshes and merges must not put an older copy of its text back in
 * the draft, so every such path passes the draft through `overlayLiveText`.
 * A save names the live fields (`liveTextKeys`) so the server neither checks
 * them for conflicts nor folds them back into their own document.
 */
export interface LiveTextProvider {
  /** `world` with every live field set to its document's current text. */
  overlay(world: WorldDefinition): WorldDefinition;
  /** Keys (engine textFieldKey) of the fields live in this tab. */
  keys(): string[];
}

let provider: LiveTextProvider | null = null;

export function setLiveTextProvider(next: LiveTextProvider | null): void {
  provider = next;
}

export function overlayLiveText(world: WorldDefinition): WorldDefinition {
  if (!provider) return world;
  try { return provider.overlay(world); } catch { return world; }
}

export function liveTextKeys(): string[] {
  try { return provider?.keys() ?? []; } catch { return []; }
}

/** Others are on the card right now: structural edits save sooner. */
let peersPresent = false;
export function setCollaboratorsPresent(value: boolean): void {
  peersPresent = value;
}
export function collaboratorsPresent(): boolean {
  return peersPresent;
}
