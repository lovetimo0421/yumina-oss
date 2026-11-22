import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Eye, Users } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { useSession } from "@/lib/auth-client";
import { useEditorStore } from "@/stores/editor";
import { isEditorSection, SECTION_LABEL_KEYS } from "@/features/editor/section-labels";
import { COLLAB_GOTO_SECTION_EVENT, peerColor, peoplePresent, useCollabStore } from "./collab-store";
import { ShareDialog } from "./share-dialog";
import { EDITING_HOLD_MS } from "./use-collab-presence";

/**
 * The header's "who's here" strip, like Figma's: a face for each other person
 * with the card open (hover says where they are), then the Share button.
 * Viewers also get a "View only" chip, since nothing they change is saved.
 *
 * A click on a face follows that person's view where the board with
 * everyone's pointers is on screen; anywhere else (the classic editor, a
 * phone) it goes to the part of the card they are in. Your own other tabs
 * are left out — that's you, not someone else.
 */
export function CollabBar({ compact = false, className }: { compact?: boolean; className?: string }) {
  const { t } = useTranslation("editor");
  const { data: session } = useSession();
  const myId = session?.user?.id;
  const worldId = useEditorStore((s) => s.serverWorldId);
  const access = useEditorStore((s) => s.access);
  const peers = useCollabStore((s) => s.peers);
  const following = useCollabStore((s) => s.following);
  const canFollow = useCollabStore((s) => s.canFollow);
  const setFollowing = useCollabStore((s) => s.setFollowing);
  const [open, setOpen] = useState(false);
  if (!worldId || !access) return null;
  const people = peoplePresent(peers).filter((p) => p.userId !== myId);
  // Never more than this many slots: past it, the last one says "+N".
  const slots = compact ? 2 : 3;
  const shown = people.length > slots ? people.slice(0, slots - 1) : people;
  const hidden = people.slice(shown.length);
  const sectionName = (section?: string) =>
    section && isEditorSection(section) ? t(SECTION_LABEL_KEYS[section] as never) : "";
  const where = (p: (typeof people)[number]) =>
    p.focus?.editing && p.focus.label && Date.now() - p.seenAt < EDITING_HOLD_MS
      ? t("collab.editingNow", { name: p.name, label: p.focus.label, defaultValue: "{{name}} is editing {{label}}" })
      : sectionName(p.focus?.section)
        ? t("collab.hereIn", { name: p.name, where: sectionName(p.focus?.section), defaultValue: "{{name}} · in {{where}}" })
        : p.name;
  const editor = people.find((p) => p.focus?.editing && p.focus.label && Date.now() - p.seenAt < EDITING_HOLD_MS);

  const faceAction = (p: (typeof people)[number]) => {
    if (canFollow) {
      const isFollowed = following === p.userId;
      return {
        hint: isFollowed ? t("collab.stopFollowing", "Stop following") : t("collab.clickToFollow", "Click to follow"),
        run: () => setFollowing(isFollowed ? null : p.userId),
        pressed: isFollowed,
      };
    }
    const section = p.focus?.section;
    if (section && isEditorSection(section)) {
      return {
        hint: t("collab.jumpTo", { where: sectionName(section), defaultValue: "Click to go to {{where}}" }),
        run: () => {
          useEditorStore.getState().setActiveSection(section);
          window.dispatchEvent(new CustomEvent(COLLAB_GOTO_SECTION_EVENT, { detail: { section } }));
        },
        pressed: undefined,
      };
    }
    return null;
  };

  const face = compact ? "h-7 w-7" : "h-6 w-6";
  return (
    <div className={cn("flex shrink-0 items-center gap-1.5", className)}>
      {access.role === "viewer" && (
        <span
          className={cn("inline-flex shrink-0 items-center gap-1 rounded-lg border border-border px-2 text-[11px] font-medium text-muted-foreground", compact ? "h-9" : "h-7")}
          title={t("collab.viewOnly", "View only")}
        >
          <Eye className="h-3 w-3" />
          {!compact && t("collab.viewOnly", "View only")}
        </span>
      )}
      {shown.length > 0 && (
        <div className={cn("flex items-center -space-x-1.5", compact && "h-9")}>
          {shown.map((p) => {
            const color = peerColor(p.userId);
            const action = faceAction(p);
            const isFollowed = canFollow && following === p.userId;
            return (
              <button
                key={p.userId}
                type="button"
                onClick={action?.run}
                disabled={!action}
                title={action ? `${where(p)} · ${action.hint}` : where(p)}
                aria-pressed={action?.pressed}
                className="rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary disabled:cursor-default"
              >
                <Avatar className={cn(face, "border-2 border-background")} style={{ boxShadow: `0 0 0 ${isFollowed ? 2 : 1.5}px ${color}` }}>
                  {p.image ? <AvatarImage src={p.image} alt="" /> : null}
                  <AvatarFallback className="text-[10px] font-semibold text-white" style={{ background: color }}>{p.name.slice(0, 1).toUpperCase()}</AvatarFallback>
                </Avatar>
              </button>
            );
          })}
          {hidden.length > 0 && (
            <span
              className={cn(face, "flex items-center justify-center rounded-full border-2 border-background bg-muted text-[10px] font-semibold text-muted-foreground")}
              title={hidden.map(where).join("\n")}
            >
              +{hidden.length}
            </span>
          )}
        </div>
      )}
      {!compact && editor && (
        <span className="hidden max-w-[220px] truncate text-[11px] lg:inline" style={{ color: peerColor(editor.userId) }} title={where(editor)}>
          {where(editor)}
        </span>
      )}
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={t("collab.shareTitle", "Invite people to work on this card")}
        aria-label={t("collab.shareTitle", "Invite people to work on this card")}
        data-collab-share
        className={cn(
          "hover-surface inline-flex shrink-0 items-center text-muted-foreground hover:text-foreground",
          compact ? "h-9 w-9 justify-center rounded-xl" : "gap-1.5 rounded-lg px-2 py-1.5 text-xs",
        )}
      >
        <Users className={compact ? "h-4 w-4" : "h-3.5 w-3.5"} />
        {!compact && t("collab.share", "Share")}
      </button>
      {open && <ShareDialog worldId={worldId} open={open} onOpenChange={setOpen} />}
    </div>
  );
}
