/**
 * Types shared by `slots.tsx` (hosted) and `slots.local.tsx` (open-source).
 *
 * Core files compile against these, never against the hosted feature
 * modules, so both slot implementations can satisfy the same call sites.
 * Keep every shape here as narrow as the core actually needs: a field
 * added here is a field the local edition has to fake.
 */
import type { StoreApi, UseBoundStore } from "zustand";
import type { YuminaBundle } from "@yumina/engine";

export type ProviderKind = "official" | "private";

/** The slice of the wallet/credits store that core play + studio code reads. */
export interface CoreCreditState {
  balance: number | null;
  plan: string | null;
  provider: ProviderKind;
  /** 0 until the first successful wallet fetch (models.ts uses it to trust `provider`). */
  lastFetched: number;
  grokTrialRemaining: number;
  memoryCap: number | null;
  loading: boolean;
  fetchCredits: (maxAgeMs?: number) => Promise<void>;
  forceFetchCredits: () => Promise<void>;
  setBalance: (balance: number) => void;
  acceptProvider: (provider: ProviderKind) => void;
  openPopup: () => void;
}
export type CoreCreditStore = UseBoundStore<StoreApi<CoreCreditState>>;

export interface FavoriteWorldSummary {
  id: string;
  worldId: string;
  worldName: string | null;
  worldThumbnailUrl: string | null;
  worldDescription: string | null;
  createdAt: string;
}
export interface FavoriteMeta {
  worldName?: string | null;
  worldThumbnailUrl?: string | null;
  worldDescription?: string | null;
}
export interface CoreFavoritesState {
  favorites: FavoriteWorldSummary[];
  fetchFavorites: () => Promise<void>;
  toggleFavorite: (worldId: string, meta?: FavoriteMeta) => Promise<boolean>;
  isFavorited: (worldId: string) => boolean;
  removeLocal: (worldIds: readonly string[]) => void;
}
export type CoreFavoritesStore = UseBoundStore<StoreApi<CoreFavoritesState>>;

export type WorldPreviewTab = "overview" | "reviews" | "playthroughs";
export interface WorldPreviewOpenOptions {
  tab?: WorldPreviewTab;
  reviewId?: string;
  replyId?: string;
  sessionId?: string;
  openedFromPlaySession?: boolean;
}
export interface OpenWorldPreviewHandle {
  openWorldPreview: (worldId: string, options?: WorldPreviewOpenOptions) => Promise<void>;
  loading: boolean;
}

/** Opaque Discover state captured into a story-return snapshot; hosted owns the shape. */
export type HubReturnState = Record<string, unknown>;

export interface HubSearchHandle {
  query: string;
  setQuery: (query: string) => void;
}

/** Payload shape the message SSE `done` event carries for the wallet. */
export interface StreamCreditsPayload {
  balance?: number | null;
  cost?: number | null;
}

export interface ExtensionReviewsBagBase {
  /** Visible comment count for the reviews tab label. */
  commentCount: number;
  /** Hero rating summary (raters, not comments). */
  ratingData: { averageRating: number; reviewCount: number };
}

export interface TipButtonProps {
  worldId: string;
  worldName: string;
  currentUserId: string | undefined;
  creatorId: string | undefined;
  variant?: "floating" | "header";
}
export interface TipModalProps {
  open: boolean;
  onClose: () => void;
  worldId?: string;
  bundleId?: string;
  worldName?: string;
  creatorId?: string;
  creatorName?: string;
  creatorImage?: string;
  onSupported?: () => void;
}
export interface SupportBadgeProps {
  creatorId: string;
  creatorName?: string;
  creatorImage?: string;
  worldId?: string;
  bundleId?: string;
  worldName?: string;
  currentUserId?: string;
  className?: string;
  size?: "sm" | "md";
}
export interface WorldPublishModalProps {
  onClose: () => void;
  onPublished: () => void;
  initialWorldId?: string | null;
}
export interface WorldReviewsSectionProps {
  worldId: string;
  allowReviews?: boolean;
  isWorldCreator: boolean;
}
export interface FriendPickerProps {
  isOpen: boolean;
  onClose: () => void;
  mode: "invite" | "browse";
  joinUrl?: string;
  worldId?: string;
  invitedIds?: ReadonlySet<string>;
  onInvited?: (friendId: string) => void;
}
export interface BundleCreatorProps {
  onClose: () => void;
}
export interface BundleImporterProps {
  bundle: YuminaBundle;
  onClose: () => void;
}
export interface ImportBundleModalProps {
  onClose: () => void;
  onImportBundle: (bundle: YuminaBundle) => void;
}
export interface NotificationBellProps {
  buttonClassName?: string;
}
/** The library's image-generation dialog (hosted: credit-metered /api/generation/*). */
export interface GenerationPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-selected target folder (the folder the library tab is showing). */
  defaultFolderId?: string | null;
  /** Called when a job finishes successfully; the parent refreshes its asset list. */
  onGenerated?: () => void;
  /** Image-first entry ("make a video from this image"): preselect these on open. */
  initialTemplateId?: string;
  initialReferenceAssetId?: string;
}
export interface DmMessageIconProps {
  className?: string;
}
