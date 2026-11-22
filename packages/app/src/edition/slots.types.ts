/**
 * Types shared by `slots.tsx` (hosted) and `slots.local.tsx` (open-source).
 *
 * Core files compile against these, never against the hosted feature
 * modules, so both slot implementations can satisfy the same call sites.
 * Keep every shape here as narrow as the core actually needs: a field
 * added here is a field the local edition has to fake.
 */
import type { ImageLoraBinding } from "@yumina/engine";
import type { StoreApi, UseBoundStore } from "zustand";
import type { RefObject } from "react";
import type { InstalledBundle, WorldDefinition, YuminaBundle } from "@yumina/engine";
import type { UseNavigateResult } from "@tanstack/react-router";
import type { MediaTool, MediaToolId } from "@yumina/shared";
import type { StudioMediaToolProposal } from "@/stores/studio-media-tool";

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
export interface WorldPlaythroughsSectionProps {
  worldId: string;
  isWorldCreator: boolean;
  currentUserId: string | null;
}
export interface LiveSeaBadgeProps {
  worldId: string;
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
/** The creator's tester list for an unpublished card; `worldId` null keeps it closed. */
export interface WorldTestersDialogProps {
  worldId: string | null;
  isOpen: boolean;
  onClose: () => void;
}
/** Parts of the card picked on the canvas to make a resource pack from. */
export interface BundleCreatorSelection {
  entryIds: string[];
  variableIds: string[];
  behaviorIds: string[];
  includeInterface: boolean;
}
export interface BundleCreatorProps {
  onClose: () => void;
  selection?: BundleCreatorSelection;
}
export interface BundleImporterProps {
  bundle: YuminaBundle;
  sourceBundleId?: string;
  worldbookId?: string;
  onClose: () => void;
}
export interface PendingBundleInstallProps {
  bundleId: string;
  onDone: () => void;
}
export interface BundleCanvasEmbedProps {
  bundleId: string;
  liveScreen?: boolean;
}
/** A new card built around a market pack (/app/worlds/create?fromBundle=). */
export type LoadWorldFromBundle = (bundleId: string) => Promise<WorldDefinition | null>;

/** The resource-pack layer of the Studio canvas: the market drawer, pack
 *  files dropped from the desktop, and the dialogs a pack install opens. */
export interface CanvasPackLayerProps {
  boardRef: RefObject<HTMLElement | null>;
  /** A desktop board the author can edit (no drawer or drops otherwise). */
  enabled: boolean;
}
/** What an installed pack's frame wears in its header: its colour, a line
 *  under its name, and the actions it offers. */
export interface PackFrameChrome {
  installId: string;
  color: string;
  line: string;
  onSettings?: () => void;
  onViewSource?: () => void;
  onDetach?: () => void;
  onRemove?: () => void;
  /** Present when a newer version of the pack is out. */
  onUpdate?: () => void;
  updateLabel?: string;
}
export interface PackFrameChromeOptions {
  readOnly: boolean;
  situationName?: string;
  newerVersion?: number;
}
export type PackFrameChromeFn = (
  record: InstalledBundle,
  t: (key: string, options?: Record<string, unknown>) => string,
  opts: PackFrameChromeOptions,
) => PackFrameChrome | null;
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

/** A media-tool proposal card in the Studio chat (hosted media tools; the local edition shows nothing). */
export interface MediaToolProposalCardProps {
  proposal: StudioMediaToolProposal;
  /** Only the card the run is waiting on has live buttons; older ones are records. */
  interactive: boolean;
  onRun: (inputs: Record<string, unknown>) => void;
  onDecline: () => void;
}

/** Open the "publish this picture to the Plaza" dialog for a chat message (hosted). */
export type OpenStoryPublish = (messageId: string, imageUrl: string) => Promise<boolean>;

/** Send the player to the hosted image generation page; the local edition has none. */
export type NavigateToGenerate = (navigate: UseNavigateResult<string>, search: { view: "image"; from?: string }) => void;

/** A picture, video or sound that landed in the creator's assets (hosted generation and media tools). */
export interface LandedAsset { assetId: string; url: string }

/** What a canvas block asks the quick generator to make. Mirrors features/generation/tools/quick-plan.ts. */
export type QuickTarget =
  | { kind: "portrait"; entryId: string }
  | { kind: "portrait-video"; entryId: string; slot: "idle" | "speaking" }
  | { kind: "voice"; entryId: string }
  | { kind: "scene-image"; sceneImageId: string }
  | { kind: "background"; backgroundId?: string }
  | { kind: "cover" }
  | { kind: "audio"; trackId?: string; type: "bgm" | "sfx" | "ambient" };

export interface QuickContext { title?: string; text?: string }

export interface QuickGenerateProps {
  target: QuickTarget;
  worldId: string;
  context: QuickContext;
  current?: LandedAsset;
  references?: LandedAsset[];
  folderId?: string;
  onLanded: (landed: LandedAsset) => void;
  onClose: () => void;
}

export interface MediaToolSheetProps {
  toolId: MediaToolId;
  inputs?: Partial<Record<string, unknown>>;
  folderId?: string;
  worldId?: string;
  onLanded?: (landed: LandedAsset[]) => void;
  onClose: () => void;
  onStarted?: (job: unknown, tool: MediaTool) => void;
}

/** The illustration LoRA picker on character, style and persona entries (hosted LoRA training and models). */
export type IllustrationLoraKind = "style" | "character" | "persona";
export interface IllustrationLoraFieldProps {
  kind: IllustrationLoraKind;
  portrait?: string;
  name?: string;
  value?: ImageLoraBinding;
  onChange: (binding: ImageLoraBinding | undefined) => void;
  variant?: "row" | "compact";
}
