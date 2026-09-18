import { useEffect, useRef, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useStoryNavigation } from "@/hooks/use-story-navigation";
import { GitBranch, ArrowUp, Plus, ListTree, Loader2, Check } from "lucide-react";
import { formatTimeAgo } from "@/lib/format-time";

const apiBase = import.meta.env.VITE_API_URL || "";

interface BranchNode {
  id: string;
  name: string | null;
  parentSessionId: string | null;
  branchedFromMessageId: string | null;
  messageCount: number;
  updatedAt: string;
  createdAt: string;
}

interface BranchContext {
  current: BranchNode;
  parent: BranchNode | null;
  siblings: BranchNode[];
  children: BranchNode[];
}

interface BranchPopoverProps {
  sessionId: string;
  canBranchFromLatest: boolean;
  onBranchFromLatest: () => Promise<void> | void;
  onOpenManager: () => void;
}

export function BranchPopover({
  sessionId,
  canBranchFromLatest,
  onBranchFromLatest,
  onOpenManager,
}: BranchPopoverProps) {
  const { t } = useTranslation("chat");
  const navigateToStory = useStoryNavigation();
  const containerRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [context, setContext] = useState<BranchContext | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadContext = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/sessions/${sessionId}/branch-context`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { data: BranchContext };
      setContext(data.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("failedLoadGeneric"));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  // Fetch on open; re-fetch every time the popover opens to stay fresh.
  useEffect(() => {
    if (open) void loadContext();
  }, [open, loadContext]);

  // Click-outside dismissal
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const goTo = (id: string) => {
    setOpen(false);
    void navigateToStory(id);
  };

  const handleBranchFromLatest = async () => {
    setOpen(false);
    await onBranchFromLatest();
  };

  const handleOpenManager = () => {
    setOpen(false);
    onOpenManager();
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`play-header-action-button rounded-md transition-colors ${
          open
            ? "bg-muted text-foreground"
            : "text-muted-foreground hover:text-foreground"
        }`}
        title={t("header.branches")}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <GitBranch className="h-4 w-4" />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={t("header.branches")}
          className="absolute right-0 top-full z-50 mt-2 w-80 max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl border border-white/[0.08] bg-card/95 shadow-2xl backdrop-blur-md"
        >
          <div className="max-h-[70vh] overflow-y-auto">
            {loading && !context && (
              <div className="flex items-center justify-center gap-2 p-6 text-xs text-muted-foreground/60">
                <Loader2 className="h-3 w-3 animate-spin" />
                {t("branchPopover.loading")}
              </div>
            )}

            {error && !loading && (
              <div className="p-4 text-xs text-destructive/80">
                {t("branchPopover.loadFailed")}
              </div>
            )}

            {context && !error && (
              <>
                <Section label={t("branchPopover.current")}>
                  <BranchRow node={context.current} isCurrent onSelect={() => {}} />
                </Section>

                {context.parent && (
                  <Section label={t("branchPopover.parent")}>
                    <BranchRow
                      node={context.parent}
                      onSelect={() => goTo(context.parent!.id)}
                      leadingIcon={<ArrowUp className="h-3 w-3" />}
                    />
                  </Section>
                )}

                {context.siblings.length > 0 && (
                  <Section
                    label={t("branchPopover.siblings", { count: context.siblings.length })}
                  >
                    {context.siblings.map((s) => (
                      <BranchRow
                        key={s.id}
                        node={s}
                        onSelect={() => goTo(s.id)}
                      />
                    ))}
                  </Section>
                )}

                {context.children.length > 0 && (
                  <Section
                    label={t("branchPopover.children", { count: context.children.length })}
                  >
                    {context.children.map((c) => (
                      <BranchRow
                        key={c.id}
                        node={c}
                        onSelect={() => goTo(c.id)}
                      />
                    ))}
                  </Section>
                )}

                {!context.parent &&
                  context.siblings.length === 0 &&
                  context.children.length === 0 && (
                    <p className="px-4 py-3 text-[11px] text-muted-foreground/50">
                      {t("branchPopover.empty")}
                    </p>
                  )}
              </>
            )}
          </div>

          <div className="border-t border-white/[0.06] p-1.5">
            <button
              type="button"
              onClick={() => void handleBranchFromLatest()}
              disabled={!canBranchFromLatest}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[12px] text-foreground transition-colors hover:bg-white/[0.04] disabled:pointer-events-none disabled:opacity-40"
            >
              <Plus className="h-3.5 w-3.5 text-primary" />
              {t("branchPopover.branchFromLatest")}
            </button>
            <button
              type="button"
              onClick={handleOpenManager}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[12px] text-muted-foreground transition-colors hover:bg-white/[0.04] hover:text-foreground"
            >
              <ListTree className="h-3.5 w-3.5" />
              {t("branchPopover.openManager")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-white/[0.04] last:border-b-0">
      <div className="px-3 pt-2.5 pb-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/40">
        {label}
      </div>
      <div className="px-1 pb-1.5">{children}</div>
    </div>
  );
}

function BranchRow({
  node,
  isCurrent,
  onSelect,
  leadingIcon,
}: {
  node: BranchNode;
  isCurrent?: boolean;
  onSelect: () => void;
  leadingIcon?: React.ReactNode;
}) {
  const { t, i18n } = useTranslation("chat");
  const displayName = node.name || t("header.untitledSession");
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={isCurrent}
      className={`group flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors ${
        isCurrent
          ? "bg-primary/[0.08] cursor-default"
          : "hover:bg-white/[0.04]"
      }`}
    >
      {leadingIcon && (
        <span className="shrink-0 text-muted-foreground/60">{leadingIcon}</span>
      )}
      {isCurrent && (
        <Check className="h-3 w-3 shrink-0 text-primary" />
      )}
      <div className="min-w-0 flex-1">
        <div
          className={`truncate text-[12px] ${
            isCurrent ? "text-foreground" : "text-foreground/90"
          }`}
        >
          {displayName}
        </div>
        <div className="truncate text-[10px] text-muted-foreground/40">
          {node.messageCount} {t("branchPopover.msgs")} · {formatTimeAgo(node.updatedAt, i18n.language)}
        </div>
      </div>
    </button>
  );
}


