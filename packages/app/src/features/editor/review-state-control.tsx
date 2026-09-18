import { useState } from "react";
import { FieldError } from "@/components/ui/field-error";
import { handleRateLimitToast } from "@/lib/rate-limit-error";
import { useTranslation } from "react-i18next";
import {
  Clock,
  AlertCircle,
  Loader2,
  ShieldAlert,
  Send,
  Undo2,
  ChevronDown,
  CircleDot,
  RefreshCw,
  SlidersHorizontal,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useEditorStore } from "@/stores/editor";
import { useWorldsStore } from "@/stores/worlds";
import { useUserProfileStore } from "@/stores/user-profile";
import type { MaterialChangeReason } from "@yumina/shared";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const apiBase = import.meta.env.VITE_API_URL || "";

// Stable enum key → (i18n key, English fallback) for the four material surfaces.
const REASONS: Record<MaterialChangeReason, { key: string; fallback: string }> = {
  entries: { key: "review.pendingEdit.reasonEntries", fallback: "Lorebook entries" },
  frontend: { key: "review.pendingEdit.reasonFrontend", fallback: "Frontend / custom UI" },
  ageRating: { key: "review.pendingEdit.reasonRating", fallback: "Content mode" },
  cover: { key: "review.pendingEdit.reasonCover", fallback: "Cover image" },
};

type Tone = "amber" | "blue" | "violet" | "red";
type Size = "sm" | "md";

const SIZE: Record<Size, string> = {
  sm: "h-9 px-3 text-xs",
  md: "px-3.5 py-2 text-sm",
};

const TONE: Record<Tone, { dot: string; chip: string; title: string; btn: string }> = {
  amber: {
    dot: "bg-amber-400",
    chip: "border-amber-500/40 bg-amber-500/[0.08] text-amber-300 hover:bg-amber-500/[0.14]",
    title: "text-amber-300",
    btn: "border-amber-500/40 bg-amber-500/[0.08] text-amber-200 hover:bg-amber-500/[0.16]",
  },
  blue: {
    dot: "bg-blue-400 animate-pulse",
    chip: "border-blue-500/40 bg-blue-500/[0.08] text-blue-300 hover:bg-blue-500/[0.14]",
    title: "text-blue-300",
    btn: "border-blue-500/40 bg-blue-500/[0.08] text-blue-200 hover:bg-blue-500/[0.16]",
  },
  // In review, but the author saved NEWER changes since submitting — a blend
  // of "in review" (blue) and "action needed" (amber) → violet.
  violet: {
    dot: "bg-violet-400 animate-pulse",
    chip: "border-violet-500/40 bg-violet-500/[0.08] text-violet-300 hover:bg-violet-500/[0.14]",
    title: "text-violet-300",
    btn: "border-violet-500/40 bg-violet-500/[0.08] text-violet-200 hover:bg-violet-500/[0.16]",
  },
  red: {
    dot: "bg-red-400",
    chip: "border-red-500/40 bg-red-500/[0.08] text-red-300 hover:bg-red-500/[0.14]",
    title: "text-red-300",
    btn: "border-red-500/30 bg-red-500/[0.06] text-red-200 hover:bg-red-500/[0.12]",
  },
};

const PUBLISH_BTN =
  "border border-emerald-400/40 bg-emerald-500/[0.08] text-emerald-300 hover:border-emerald-400/60 hover:bg-emerald-500/[0.15] hover:text-emerald-200";

/**
 * The single publish / review control in the editor's top-right action row.
 * It *is* the Publish button — its colour + label reflect the world's review
 * state, and a caret opens a popover with the detail + the matching action.
 * This merges the old "Publish update" button and the separate status banner
 * into one affordance so the two never sit side by side.
 *
 *   - live, nothing pending → solid green "Publish update" → opens publish modal
 *   - not_live (draft / new variant the author saved but never submitted — the
 *     misleading gap) → amber "Not live" → popover explains + Publish
 *   - held_draft / held_rejected → amber / red → popover → submit / resubmit
 *   - held_pending / review_pending → blue "In review" → popover → withdraw
 *   - first-publish rejected → red "Rejected" → popover → fix + resubmit
 */
export function ReviewStateControl({
  onPublish,
  size = "md",
  disabled = false,
  className,
}: {
  onPublish: () => void;
  size?: Size;
  disabled?: boolean;
  className?: string;
}) {
  const { t } = useTranslation("editor");

  const serverWorldId = useEditorStore((s) => s.serverWorldId);
  const pendingEdit = useEditorStore((s) => s.pendingEdit);
  const worldIsPublished = useEditorStore((s) => s.worldIsPublished);
  const editorWorldStatus = useEditorStore((s) => s.worldStatus);
  const submittedForReviewAt = useEditorStore((s) => s.submittedForReviewAt);
  const baseUpdatedAt = useEditorStore((s) => s.baseUpdatedAt);
  const isDirty = useEditorStore((s) => s.isDirty);
  const readOnlyInspect = useEditorStore((s) => s.readOnlyInspect);
  const submitPendingEdit = useEditorStore((s) => s.submitPendingEdit);
  const withdrawPendingEdit = useEditorStore((s) => s.withdrawPendingEdit);
  const canAutoPublish = useUserProfileStore((s) => s.profile?.skipReview === true && s.profile?.isBanned !== true);

  const worlds = useWorldsStore((s) => s.worlds);
  const invalidate = useWorldsStore((s) => s.invalidate);
  const fetchWorlds = useWorldsStore((s) => s.fetchWorlds);

  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  // Failures stay inside the open panel, next to the button that caused them (R4).
  const [actionError, setActionError] = useState<string | null>(null);

  if (readOnlyInspect) return null;

  // Status resolution: the editor store's status is authoritative — it comes
  // from THIS world's detail response (load / refresh / publish / withdraw all
  // sync it). The worlds-list row is only a fallback for the moment before the
  // detail load resolves. The old priority (list first) showed stale statuses:
  // the list is cached, refreshed asynchronously, and collapses language
  // groups to one representative row — so right after submitting for review
  // (or on a direct editor load of a variant) an in-review card rendered as
  // "Not live"/"Publish" even though the server had it as pending_review.
  const world = serverWorldId ? worlds.find((w) => w.id === serverWorldId) : undefined;
  const status = editorWorldStatus ?? world?.status ?? null;

  // "In review, but newer changes were saved after submitting" — true when the
  // last successful save (baseUpdatedAt tracks the server row's updatedAt)
  // happened after the submission timestamp. Unsaved local edits (isDirty)
  // count too: the author has changes the reviewer hasn't seen either way.
  const hasNewerChangesThanReview =
    status === "pending_review" &&
    (isDirty ||
      (!!submittedForReviewAt &&
        !!baseUpdatedAt &&
        new Date(baseUpdatedAt).getTime() > new Date(submittedForReviewAt).getTime() + 2000));

  const sizeCls = SIZE[size];

  // Solid green Publish button — shown when the world is live with nothing
  // pending, or before the first save (no review state to surface yet).
  const renderPlainPublish = () => (
    <button
      type="button"
      onClick={onPublish}
      disabled={disabled}
      title={worldIsPublished ? t("shell.publishUpdateTooltip") : t("shell.publishTooltip")}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-lg font-semibold transition-colors disabled:opacity-40",
        sizeCls,
        PUBLISH_BTN,
        className,
      )}
    >
      {worldIsPublished ? <RefreshCw className="h-3.5 w-3.5" /> : <Send className="h-3.5 w-3.5" />}
      {worldIsPublished ? t("shell.publishUpdate", "Publish update") : t("shell.publish", "Publish")}
    </button>
  );

  const reasonText = (pendingEdit?.reasons ?? [])
    .map((r) => t(REASONS[r]?.key ?? "", { defaultValue: REASONS[r]?.fallback ?? r }))
    .join(t("review.pendingEdit.reasonSeparator", { defaultValue: ", " }));

  async function withdrawFirstPublishReview() {
    if (!serverWorldId) return;
    if (!window.confirm(t("review.withdrawConfirm"))) return;
    setBusy(true);
    setActionError(null);
    const res = await fetch(`${apiBase}/api/worlds/${serverWorldId}/withdraw-review`, {
      method: "POST",
      credentials: "include",
    });
    setBusy(false);
    if (!res.ok) {
      // Keep the panel open so the failure lands where the button is.
      setActionError(t("review.withdrawFailed"));
      return;
    }
    setOpen(false);
    // The card is back to draft — reflect it immediately in the editor store
    // (the worlds-list refetch below may not contain this row at all, e.g.
    // non-representative language variants). The chip itself flips to "Not
    // live", so there is nothing left to confirm.
    useEditorStore.setState({ worldStatus: "draft", submittedForReviewAt: null });
    invalidate();
    fetchWorlds();
  }

  // "Update review to latest version" — saving during first-publish review is
  // allowed and the admin reviews the live row, so this re-asserts the
  // submission (fresh timestamp, un-ignores a parked one) rather than moving
  // any content.
  async function refreshFirstPublishReview() {
    if (!serverWorldId) return;
    setBusy(true);
    setActionError(null);
    try {
      // The action means "submit what is currently in the editor", not merely
      // "bump the last server copy". Persist local edits first and never refresh
      // the review if that save fails. saveDraft snapshots the draft and leaves
      // isDirty=true when the user changes it again while the request is active;
      // in that race, keep the violet state and require another click rather
      // than claiming the unsaved version is under review.
      const editor = useEditorStore.getState();
      if (editor.isDirty) {
        const saved = await editor.saveDraft();
        if (!saved || useEditorStore.getState().isDirty) return;
      }

      const res = await fetch(`${apiBase}/api/worlds/${serverWorldId}/refresh-review`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        if (!handleRateLimitToast(res, errData)) {
          setActionError(t("review.updateReviewFailed"));
        }
        return;
      }

      setOpen(false);
      // The submission timestamp is now ahead of the last save — flip the
      // "newer changes" (violet) state back to plain "In review" immediately.
      // That chip change is the confirmation; no toast needed.
      useEditorStore.setState({ submittedForReviewAt: new Date().toISOString() });
      invalidate();
      fetchWorlds();
    } catch {
      setActionError(t("review.updateReviewFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function runStoreAction(fn: () => Promise<boolean>) {
    setBusy(true);
    await fn();
    setBusy(false);
    setOpen(false);
  }

  function rejectionBlock(reason: string | null | undefined, detail: string | null | undefined) {
    if (!reason && !detail) return null;
    return (
      <>
        {reason && (
          <p className="mt-1 text-xs text-red-200/90">
            {t("review.rejectedReason", {
              reason: t(`reviewState.rejectReasons.${reason}` as never, { defaultValue: reason }),
            })}
          </p>
        )}
        {detail && (
          <p className="mt-1.5 whitespace-pre-wrap text-xs text-muted-foreground">
            {t("review.rejectedDetail", { detail })}
          </p>
        )}
      </>
    );
  }

  // ── Resolve the single active view (null = nothing to surface → plain Publish)
  // Held-edit states (only meaningful on a published world) win over first-publish
  // status, since a published world's own `status` is "published".
  interface View {
    tone: Tone;
    chip: string;
    icon: typeof Clock;
    title: string;
    body?: string;
    reasons?: boolean;
    rejection?: boolean;
    hint?: string;
    actionLabel: string;
    actionIcon: typeof Send;
    onAction: () => void;
    /** Optional second (lower-emphasis) action rendered next to the primary. */
    secondaryLabel?: string;
    secondaryIcon?: typeof Send;
    onSecondary?: () => void;
  }

  let view: View | null = null;

  // A card carrying a held edit has TWO ways to reach Discover, and creators
  // could not tell them apart: "Submit for review" sends only the held content
  // change, while the publish modal ALSO rewrites tags / playtime / visibility
  // from whatever the form holds and then submits the held edit anyway. So the
  // held-edit states make submitting the primary action and demote the modal to
  // this labelled secondary — reachable when you actually want to edit
  // settings, never the obvious button to mash.
  const settingsEntry = {
    secondaryLabel: t("review.pendingEdit.editSettingsBtn", { defaultValue: "Edit tags & settings" }),
    secondaryIcon: SlidersHorizontal,
    onSecondary: () => {
      setOpen(false);
      onPublish();
    },
  } as const;

  // `status` from the worlds store is authoritative for the row's lifecycle
  // (draft / pending_review / rejected / published / unpublished). `worldIsPublished`
  // is only a fallback when the store hasn't loaded this row yet — relying on it
  // would mask "in review" right after a first-publish submit (the publish modal
  // optimistically flips worldIsPublished=true even though the row is pending).
  const isLive = status ? status === "published" : worldIsPublished;

  if (status === "pending_review") {
    view = hasNewerChangesThanReview
      ? {
          // Violet: in review AND the author saved newer changes since
          // submitting — visually distinct from plain blue "In review" and
          // amber "Not live".
          tone: "violet",
          chip: t("review.stateControl.chipInReviewNewer", { defaultValue: "In review · new changes" }),
          icon: Clock,
          title: t("review.newerChangesTitle", { defaultValue: "You have newer changes than the submitted review" }),
          body: t("review.newerChangesBody", {
            defaultValue:
              "This card is in review, but you've saved changes since submitting. Update the review so it covers your latest version, or withdraw it from the queue.",
          }),
          actionLabel: t("review.updateReview", { defaultValue: "Update review to latest version" }),
          actionIcon: RefreshCw,
          onAction: refreshFirstPublishReview,
          secondaryLabel: t("review.withdraw"),
          secondaryIcon: Undo2,
          onSecondary: withdrawFirstPublishReview,
        }
      : {
          tone: "blue",
          chip: t("review.stateControl.chipInReview", { defaultValue: "In review" }),
          icon: Clock,
          title: t("review.submittedTitle"),
          body: t("review.submittedBody"),
          hint: t("review.editableHint", {
            defaultValue:
              "You can keep editing and saving while it's in review. Use \"Update review\" after saving so reviewers see it as your newest version, or withdraw to pull it out of the queue.",
          }),
          actionLabel: t("review.updateReview", { defaultValue: "Update review to latest version" }),
          actionIcon: RefreshCw,
          onAction: refreshFirstPublishReview,
          secondaryLabel: t("review.withdraw"),
          secondaryIcon: Undo2,
          onSecondary: withdrawFirstPublishReview,
        };
  } else if (status === "rejected") {
    view = {
      tone: "red",
      chip: t("review.stateControl.chipRejected", { defaultValue: "Rejected" }),
      icon: AlertCircle,
      title: t("review.rejectedTitle"),
      rejection: true,
      actionLabel: t("review.resubmit"),
      actionIcon: Send,
      onAction: () => {
        setOpen(false);
        onPublish();
      },
    };
  } else if (isLive && pendingEdit) {
    if (pendingEdit.status === "pending") {
      view = {
        tone: "blue",
        chip: t("review.stateControl.chipInReview", { defaultValue: "In review" }),
        icon: Clock,
        title: t("review.pendingEdit.inReviewTitle", { defaultValue: "Update in review" }),
        body: t("review.pendingEdit.inReviewBody"),
        reasons: true,
        hint: t("review.pendingEdit.lockedHint"),
        actionLabel: t("review.pendingEdit.withdrawBtn", { defaultValue: "Withdraw request" }),
        actionIcon: Undo2,
        onAction: () => runStoreAction(withdrawPendingEdit),
      };
    } else if (pendingEdit.status === "rejected") {
      view = {
        tone: "red",
        chip: t("review.stateControl.chipRejected", { defaultValue: "Rejected" }),
        icon: AlertCircle,
        title: t("review.pendingEdit.rejectedTitle", { defaultValue: "Update changes rejected" }),
        rejection: true,
        hint: t("review.pendingEdit.rejectedHint"),
        actionLabel: canAutoPublish ? t("review.pendingEdit.publishBtn") : t("review.pendingEdit.resubmitBtn", { defaultValue: "Resubmit for review" }),
        actionIcon: Send,
        onAction: () => runStoreAction(submitPendingEdit),
        ...settingsEntry,
      };
    } else {
      view = {
        tone: "amber",
        chip: t("review.stateControl.chipHeldDraft", { defaultValue: "Unpublished changes" }),
        icon: ShieldAlert,
        title: t("review.pendingEdit.heldTitle", { defaultValue: "Unpublished changes" }),
        body: t(canAutoPublish ? "review.pendingEdit.autoPublishBody" : "review.pendingEdit.heldBody"),
        reasons: true,
        hint: t("review.pendingEdit.settingsHint"),
        actionLabel: canAutoPublish ? t("review.pendingEdit.publishBtn") : t("review.pendingEdit.submitBtn", { defaultValue: "Submit for review" }),
        actionIcon: Send,
        onAction: () => runStoreAction(submitPendingEdit),
        ...settingsEntry,
      };
    }
  } else if (serverWorldId && !isLive) {
    // draft / unpublished → not live yet. THE gap the author hit: they saved a
    // new variant (or draft) and assumed it went live.
    view = {
      tone: "amber",
      chip: t("review.stateControl.chipNotLive", { defaultValue: "Not live" }),
      icon: CircleDot,
      title: t("review.stateControl.notLiveTitle", { defaultValue: "This version isn't live yet" }),
      body: t("review.stateControl.notLiveBody", {
        defaultValue:
          "What you saved is a draft — only you can see and playtest it. Publish it to submit for review; players can play it once it's approved.",
      }),
      actionLabel: t("review.stateControl.publishBtn", { defaultValue: "Publish" }),
      actionIcon: Send,
      onAction: () => {
        setOpen(false);
        onPublish();
      },
    };
  }

  // Live + nothing pending (or pre-first-save) → the plain green Publish button.
  if (!view) return renderPlainPublish();

  const tone = TONE[view.tone];
  const Icon = view.icon;
  const ActionIcon = view.actionIcon;

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Otherwise closing and reopening re-shows the previous failure.
        setActionError(null);
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-lg border font-semibold transition-colors",
            sizeCls,
            tone.chip,
            className,
          )}
          title={view.title}
        >
          <span className={cn("h-2 w-2 shrink-0 rounded-full", tone.dot)} />
          {view.chip}
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[min(22rem,calc(100vw-1.5rem))] p-3">
        <div className="flex items-start gap-2.5">
          <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", tone.title)} />
          <div className="min-w-0 flex-1">
            <h3 className={cn("text-sm font-bold", tone.title)}>{view.title}</h3>
            {view.body && (
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{view.body}</p>
            )}
            {view.rejection && rejectionBlock(
              worldIsPublished ? pendingEdit?.rejectionReason : world?.rejectionReason,
              worldIsPublished ? pendingEdit?.rejectionDetail : world?.rejectionDetail,
            )}
            {view.reasons && reasonText && (
              <p className="mt-2 text-[11px] text-muted-foreground/70">
                {t("review.pendingEdit.changedLabel", { defaultValue: "Changed: {{list}}", list: reasonText })}
              </p>
            )}
            {view.hint && (
              <p className="mt-2 text-[11px] text-muted-foreground/60">{view.hint}</p>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={view.onAction}
                className={cn(
                  "inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-50",
                  tone.btn,
                )}
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ActionIcon className="h-3.5 w-3.5" />}
                {view.actionLabel}
              </button>
              {view.secondaryLabel && view.onSecondary && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={view.onSecondary}
                  className="inline-flex items-center gap-2 rounded-md border border-border/60 bg-transparent px-3 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground disabled:opacity-50"
                >
                  {view.secondaryIcon && <view.secondaryIcon className="h-3.5 w-3.5" />}
                  {view.secondaryLabel}
                </button>
              )}
            </div>
            <FieldError id="review-action-error" message={actionError} />
          </div>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
