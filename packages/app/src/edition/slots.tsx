/**
 * Edition seam — LOCAL (open-source) implementation, UI half.
 *
 * The export copies this file over `slots.tsx`. Every export mirrors a name
 * in the hosted file with an inert body: components render nothing, hooks
 * return still values. Core files never notice because every hosted surface
 * they render is also gated on `useFeature(...)`, so these stubs are a
 * typecheck contract more than UI. The state half is `slots.state.local.ts`.
 *
 * Keep the export list identical to `slots.tsx`.
 */
import type { MediaTool } from "@yumina/shared";
import { lazy } from "react";
import { importWithChunkRecovery } from "@/lib/stale-chunk-reload";
import type {
  BundleCreatorProps,
  BundleImporterProps,
  BundleCanvasEmbedProps,
  CanvasPackLayerProps,
  LoadWorldFromBundle,
  PackFrameChromeFn,
  PendingBundleInstallProps,
  DmMessageIconProps,
  ExtensionReviewsBagBase,
  FriendPickerProps,
  WorldTestersDialogProps,
  GenerationPanelProps,
  HubSearchHandle,
  ImportBundleModalProps,
  NotificationBellProps,
  OpenWorldPreviewHandle,
  SupportBadgeProps,
  TipButtonProps,
  TipModalProps,
  WorldPublishModalProps,
  WorldReviewsSectionProps,
  WorldPlaythroughsSectionProps,
  LiveSeaBadgeProps, MediaToolProposalCardProps, NavigateToGenerate, OpenStoryPublish, QuickGenerateProps, MediaToolSheetProps, IllustrationLoraFieldProps } from "./slots.types";

const noop = (): void => {};
const resolved = (): Promise<void> => Promise.resolve();

// ── Topbar / shell chrome ───────────────────────────────────────────────────
export function CreditIndicator() { return null; }
export function NotificationBell(_props: NotificationBellProps = {}) { return null; }
export function ContentLevelSwitcher() { return null; }
export function HalloweenTopBarEntry() { return null; }
export function ShareSeasonStrip(_props: { className?: string }) { return null; }
export function HiddenPumpkin(_props: { spot: string; size?: number; className?: string }) { return null; }
export function DmMessageIcon(_props: DmMessageIconProps) { return null; }
export function PartnerDashboardLink() { return null; }

// ── Play ────────────────────────────────────────────────────────────────────
export function TipButton(_props: TipButtonProps) { return null; }
export function TipModal(_props: TipModalProps) { return null; }
export function SupportBadge(_props: SupportBadgeProps) { return null; }
export function FriendPicker(_props: FriendPickerProps) { return null; }
export function WorldTestersDialog(_props: WorldTestersDialogProps) { return null; }
export function TestingWorldsRow() { return null; }

// ── Editor / Studio ─────────────────────────────────────────────────────────
export function BundlesSection() { return null; }
export function BundleCreator(_props: BundleCreatorProps) { return null; }
export function BundleImporter(_props: BundleImporterProps) { return null; }
export function PendingBundleInstall(_props: PendingBundleInstallProps) { return null; }
export function CanvasPackLayer(_props: CanvasPackLayerProps) { return null; }
export function openPackMarketDrawer(_kind?: "all" | "interface" | "module" | "template"): boolean { return false; }
export function closePackMarketDrawer(): void {}
export function openPackMarketStore(_use?: string): boolean { return false; }
export function usePackDrawerOpen(): boolean { return false; }
export const HAS_PACK_MARKET = false;
export function MarketInterfaceTiles(_props: { onPicked: () => void; onAll: () => void }) { return null; }
const noUpdates: Readonly<Record<string, number>> = {};
export function usePackUpdates(): Readonly<Record<string, number>> { return noUpdates; }
export const packFrameChrome: PackFrameChromeFn = () => null;
/** No market in the local edition: nothing to build a card from. */
export const loadWorldFromBundle: LoadWorldFromBundle = () => Promise.resolve(null);
export function BundleCanvasEmbed(_props: BundleCanvasEmbedProps) { return null; }
export function GenerationEditorSection() { return null; }
export function GenerationAtelier(_props: { worldId: string | null }) { return null; }
export function ShareModuleButton(_props: { book: import("@yumina/engine").Worldbook; className?: string }) { return null; }
export function ImportBundleModal(_props: ImportBundleModalProps) { return null; }
export function WorldPublishModal(_props: WorldPublishModalProps) { return null; }

// ── Library / reviews ───────────────────────────────────────────────────────
export function WorldReviewsSection(_props: WorldReviewsSectionProps) { return null; }
export function WorldPlaythroughsSection(_props: WorldPlaythroughsSectionProps) { return null; }
export function LiveSeaBadge(_props: LiveSeaBadgeProps) { return null; }
export function LibraryBundlesTab() { return null; }
export function LibraryPromptsTab() { return null; }
export function GenerationPanel(_props: GenerationPanelProps) { return null; }
export function ExtensionReviewList(_props: ExtensionReviewsBagBase) { return null; }
export function useExtensionReviews(_args: { extensionKey: string; enabled: boolean }): ExtensionReviewsBagBase {
  return { commentCount: 0, ratingData: { averageRating: 0, reviewCount: 0 } };
}

// ── Routes ──────────────────────────────────────────────────────────────────
/** `/` always redirects in the local edition; nothing to render. */
export function RootIndexComponent() { return null; }
/** `/app/profile` in the local edition: the hosted page's own-account sections, no platform. */
export const ProfileRoot = lazy(() =>
  importWithChunkRecovery(() => import("@/features/account/local-profile-page")).then((m) => ({
    default: m.LocalProfilePage,
  })),
);

// ── Account / profile sections ──────────────────────────────────────────────
/** No wallet without billing; the AI Settings card starts at the model row. */
export function ProfilePlanSummary() { return null; }

// ── Hub labels ──────────────────────────────────────────────────────────────
export function resolveTagLabel(tag: string): string { return tag; }

// ── Hub hooks ───────────────────────────────────────────────────────────────
const stillHubSearch: HubSearchHandle = { query: "", setQuery: noop };
export function useHubSearch(): HubSearchHandle { return stillHubSearch; }
export function useIsWorldPreviewOpen(): boolean { return false; }
const stillPreview: OpenWorldPreviewHandle = { openWorldPreview: resolved, loading: false };
export function useOpenWorldPreview(_scopeKey?: string): OpenWorldPreviewHandle { return stillPreview; }

// ── App shell ───────────────────────────────────────────────────────────────
export function useHostedShellEffects(_sessionUserId: string | null): void {}
export function HostedShellOverlays() { return null; }
export const hostedShellModalImporters: ReadonlyArray<() => Promise<unknown>> = [];
export function HostedShellModals() { return null; }
export function useAchievementMomentActive(): boolean { return false; }

// ── Social ──────────────────────────────────────────────────────────────────
export function useStartDm(): (targetUserId: string) => Promise<void> { return resolved; }

// ── Hosted picture features: nothing to show or do in the local edition ──
export function MediaToolProposalCard(_props: MediaToolProposalCardProps) { return null; }
export function PlazaPlayerBar() { return null; }
export function StoryPublishHost() { return null; }
export const openStoryPublish: OpenStoryPublish = () => Promise.resolve(false);
export const navigateToGenerate: NavigateToGenerate = () => {};
export function QuickGenerate(_props: QuickGenerateProps) { return null; }
export function MediaToolSheet(_props: MediaToolSheetProps) { return null; }
export function toolsFor(_mediaKind: "image" | "video" | "audio"): MediaTool[] { return []; }
export function IllustrationLoraField(_props: IllustrationLoraFieldProps) { return null; }
export function useIllustrationLorasOffered(): boolean { return false; }
