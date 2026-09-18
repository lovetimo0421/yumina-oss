import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useChatStore } from "@/stores/chat";
import {
  ArrowLeft,
  BookOpen,
  PanelRight,
  Undo2,
  MoreHorizontal,
  Maximize,
  Minimize,
  GitBranch,
  X,
} from "lucide-react";
import { PlayZoomControl } from "./play-zoom-control";
import { TipButton } from "@/edition/slots";
import { useFeature } from "@/edition/edition";
import { BranchPopover } from "./branch-popover";
import { useImmersiveMode } from "@/hooks/use-fullscreen";
import { isTouchDevice } from "@/hooks/use-touch-device";
import { useUiStore } from "@/stores/ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { TopBarAccountControls } from "@/components/layout/top-bar";
import { safeParseWorldDef } from "@/lib/utils";
import { useOpenWorldPreview } from "@/edition/slots";
import { useStoryNavigation } from "@/hooks/use-story-navigation";


interface SessionHeaderProps {
  showSidebarToggle?: boolean;
  sidebarOpen?: boolean;
  onToggleSidebar?: () => void;
  onBack: () => void;
}

export function SessionHeader({
  showSidebarToggle,
  sidebarOpen,
  onToggleSidebar,
  onBack,
}: SessionHeaderProps) {
  const { t } = useTranslation(["chat", "common"]);
  const session = useChatStore(s => s.session);
  const messages = useChatStore(s => s.messages);
  const isStreaming = useChatStore(s => s.isStreaming);
  const streamStartTime = useChatStore(s => s.streamStartTime);
  const revertLastExchange = useChatStore(s => s.revertLastExchange);
  const branchFromMessage = useChatStore(s => s.branchFromMessage);
  const openSessionManager = useUiStore(s => s.openSessionManager);
  const navigateToStory = useStoryNavigation();
  const { openWorldPreview } = useOpenWorldPreview(session?.id);
  const billingEnabled = useFeature("billing");
  const hubEnabled = useFeature("hub");
  const branchRequestInFlightRef = useRef(false);
  const [branching, setBranching] = useState(false);

  const { isImmersive, toggle: toggleImmersive } = useImmersiveMode();

  const handleBranchFromLatest = async () => {
    if (messages.length === 0 || isStreaming || branchRequestInFlightRef.current) return;
    const latest = messages[messages.length - 1]!;
    branchRequestInFlightRef.current = true;
    setBranching(true);
    try {
      const newSessionId = await branchFromMessage(latest.id);
      if (newSessionId) {
        navigateToStory(newSessionId);
      }
      // A null id means the store already showed the failure pill — one pill
      // per failure, so nothing more happens here.
    } finally {
      branchRequestInFlightRef.current = false;
      setBranching(false);
    }
  };

  const handleOpenCardOverview = () => {
    if (session?.worldId) {
      void openWorldPreview(session.worldId, { sessionId: session.id, openedFromPlaySession: true });
    }
  };

  // F11 immersive mode shortcut (desktop only)
  useEffect(() => {
    if (isTouchDevice()) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "F11") {
        e.preventDefault();
        toggleImmersive();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleImmersive]);

  if (!session) return null;

  const worldDef = safeParseWorldDef(session.world?.schema);
  const characterEntry = worldDef?.entries?.find((e) => e.role === "character");
  const characterName =
    characterEntry?.name ?? worldDef?.characters?.[0]?.name ?? "AI";
  const worldName = session.world?.name ?? t("unknownWorld");
  const worldId = session.worldId;
  const creatorId = session.world?.creatorId;
  const currentUserId = session.currentUser?.id;

  return (
    <div className="play-header-shell shrink-0 border-b border-border">
      <div className="play-header-inner play-session-header">
        <div className="play-header-leading">
          <button
            onClick={onBack}
            aria-label={t("replay.back")}
            title={t("replay.back")}
            className="play-header-icon-button hover-surface rounded-md text-muted-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>

          <div className="play-header-title-group min-w-0 flex-1 overflow-hidden">
            <h2 className="play-header-title truncate text-[0.95rem] font-medium text-foreground">
              {worldName}
            </h2>
            <p className="play-header-subtitle truncate text-xs text-muted-foreground/50">
              {characterName}
            </p>
          </div>
        </div>

        <div className="play-header-actions play-header-actions--desktop">
          {isStreaming && streamStartTime && (
            <StreamingTimer startTime={streamStartTime} />
          )}

          <PlayZoomControl />

          {billingEnabled && (
          <TipButton
            worldId={worldId}
            worldName={worldName}
            currentUserId={currentUserId}
            creatorId={creatorId}
            variant="header"
          />
          )}

          {hubEnabled && (
          <button
            onClick={handleOpenCardOverview}
            className="play-header-action-button rounded-md text-muted-foreground transition-colors hover:text-foreground"
            title={t("header.cardOverview")}
          >
            <BookOpen className="h-4 w-4" />
          </button>
          )}

          <button
            onClick={() => void revertLastExchange()}
            disabled={isStreaming || messages.length < 2}
            className="play-header-action-button rounded-md text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-20"
            title={t("header.revertLastExchange")}
          >
            <Undo2 className="h-4 w-4" />
          </button>

          <BranchPopover
            sessionId={session.id}
            canBranchFromLatest={!isStreaming && messages.length > 0 && !branching}
            onBranchFromLatest={handleBranchFromLatest}
            onOpenManager={openSessionManager}
          />

          <button
            onClick={toggleImmersive}
            className={`play-header-action-button rounded-md transition-colors ${
              isImmersive
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
            title={isImmersive ? t("header.exitFullscreen") : t("header.fullscreen")}
          >
            {isImmersive ? (
              <Minimize className="h-4 w-4" />
            ) : (
              <Maximize className="h-4 w-4" />
            )}
          </button>

          {showSidebarToggle && (
            <button
              onClick={onToggleSidebar}
              className={`play-header-action-button rounded-md transition-colors ${
                sidebarOpen
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              title={sidebarOpen ? t("header.hideComponents") : t("header.showComponents")}
            >
              <PanelRight className="h-4 w-4" />
            </button>
          )}
        </div>

        <div className="play-header-mobile-trailing">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="play-header-mobile-menu rounded-md text-muted-foreground transition-colors hover:text-foreground"
                title={t("header.moreActions")}
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {hubEnabled && (
              <DropdownMenuItem
                onClick={handleOpenCardOverview}
              >
                <BookOpen className="mr-2 h-4 w-4" />
                {t("header.cardOverview")}
              </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onClick={() => void revertLastExchange()}
                disabled={isStreaming || messages.length < 2}
              >
                <Undo2 className="mr-2 h-4 w-4" />
                {t("header.revertLastExchange")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={handleBranchFromLatest}
                disabled={isStreaming || messages.length === 0 || branching}
              >
                <GitBranch className="mr-2 h-4 w-4" />
                {t("branchPopover.branchFromLatest")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={openSessionManager}>
                <GitBranch className="mr-2 h-4 w-4" />
                {t("branchPopover.openManager")}
              </DropdownMenuItem>
              {showSidebarToggle && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={onToggleSidebar}>
                    <PanelRight className="mr-2 h-4 w-4" />
                    {sidebarOpen ? t("header.hideComponents") : t("header.showComponents")}
                  </DropdownMenuItem>
                </>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={toggleImmersive}>
                {isImmersive ? (
                  <Minimize className="mr-2 h-4 w-4" />
                ) : (
                  <Maximize className="mr-2 h-4 w-4" />
                )}
                {isImmersive ? t("header.exitFullscreen") : t("header.fullscreen")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <TopBarAccountControls />
        </div>

        <div className="play-header-account">
          <TopBarAccountControls />
        </div>
      </div>
      {session.parentSessionId && session.parentSessionName && (
        <ParentTimelineBanner
          currentSessionId={session.id}
          parentSessionId={session.parentSessionId}
          parentSessionName={session.parentSessionName}
          branchedFromMessageId={session.branchedFromMessageId ?? null}
          onNavigate={(id) => void navigateToStory(id)}
        />
      )}
    </div>
  );
}

function StreamingTimer({ startTime }: { startTime: number }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setElapsed(Date.now() - startTime);
    }, 100);
    return () => clearInterval(interval);
  }, [startTime]);

  return (
    <div className="play-header-timer">
      <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
      <span className="text-xs text-muted-foreground/50">
        {(elapsed / 1000).toFixed(1)}s
      </span>
    </div>
  );
}

interface ParentTimelineBannerProps {
  // Current branch's own session id — used as the dismissal key so sibling
  // branches under the same parent track their banner state independently.
  currentSessionId: string;
  parentSessionId: string;
  parentSessionName: string;
  branchedFromMessageId: string | null;
  onNavigate: (id: string) => void;
}

function ParentTimelineBanner({
  currentSessionId,
  parentSessionId,
  parentSessionName,
  branchedFromMessageId,
  onNavigate,
}: ParentTimelineBannerProps) {
  const { t } = useTranslation("chat");
  void branchedFromMessageId;
  const dismissKey = `yumina:branch-banner:${currentSessionId}`;
  const [dismissed, setDismissed] = useState(() =>
    localStorage.getItem(dismissKey) === "1",
  );

  if (dismissed) return null;

  return (
    <div className="flex items-center justify-between gap-2 border-b border-border/40 bg-muted/10 px-4 py-1.5 text-[11px] text-muted-foreground/70">
      <span className="truncate">
        <GitBranch className="mr-1.5 inline h-3 w-3" />
        {t("header.branchFromParent", { name: parentSessionName })}
      </span>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={() => onNavigate(parentSessionId)}
          className="rounded-md px-2 py-0.5 text-[11px] text-foreground/80 transition-colors hover:bg-white/[0.06] hover:text-foreground active:bg-white/[0.06] active:text-foreground [@media(hover:none)]:min-h-9"
        >
          {t("header.backToParentTimeline")}
        </button>
        <button
          type="button"
          onClick={() => {
            localStorage.setItem(dismissKey, "1");
            setDismissed(true);
          }}
          className="flex h-5 w-5 items-center justify-center rounded-md text-muted-foreground/40 hover:bg-white/[0.06] hover:text-muted-foreground active:bg-white/[0.06] active:text-muted-foreground [@media(hover:none)]:h-9 [@media(hover:none)]:w-9"
          aria-label={t("header.dismissBanner")}
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}
