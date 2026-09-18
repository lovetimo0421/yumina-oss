/**
 * Edition seam — LOCAL (open-source) implementation, state half.
 *
 * The export copies this file over `slots.state.ts`. Every export mirrors a
 * name there with a still value or a no-op: the local edition has no wallet,
 * no favorites, no Discover state and no DMs. Keep the export list identical
 * to `slots.state.ts`.
 */
import { create } from "zustand";
import type {
  CoreCreditState,
  CoreCreditStore,
  CoreFavoritesState,
  CoreFavoritesStore,
  HubReturnState,
  StreamCreditsPayload,
} from "./slots.types";

const noop = (): void => {};
const resolved = (): Promise<void> => Promise.resolve();

// ── Stores (still values; the local edition is BYOK-only with no wallet) ────
export const useCreditStore: CoreCreditStore = create<CoreCreditState>()(() => ({
  balance: null,
  plan: null,
  provider: "private",
  // Non-zero so models.ts trusts `provider` instead of the profile preference.
  lastFetched: 1,
  grokTrialRemaining: 0,
  memoryCap: null,
  loading: false,
  fetchCredits: resolved,
  forceFetchCredits: resolved,
  setBalance: noop,
  acceptProvider: noop,
  openPopup: noop,
}));

export const useFavoritesStore: CoreFavoritesStore = create<CoreFavoritesState>()(() => ({
  favorites: [],
  fetchFavorites: resolved,
  toggleFavorite: () => Promise.resolve(false),
  isFavorited: () => false,
  removeLocal: noop,
}));

// ── Hub ─────────────────────────────────────────────────────────────────────
export function getWorldShareUrl(origin: string, worldId: string, _gamePath?: unknown): string {
  return `${origin}/app/library?worldId=${encodeURIComponent(worldId)}`;
}
export function invalidateHubWorlds(): void {}
export function captureHubReturnState(): HubReturnState { return {}; }
export function isValidHubReturnState(value: unknown): value is HubReturnState {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function restoreHubReturnState(_state: HubReturnState): void {}

// ── App shell ───────────────────────────────────────────────────────────────
export function rememberDmReturnPath(_href: string, _historyIndex: number | undefined): void {}

// ── Auth / billing plumbing ─────────────────────────────────────────────────
export function resetHostedStoresOnSignOut(): void {}
export function syncCreditsFromMessageResponse(_credits: StreamCreditsPayload): void {}
export function handleStreamCreditError(_errorCode: string | undefined): void {}
export function fetchCreditsForChat(): void {}
