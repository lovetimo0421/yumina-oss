import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useRouter } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { TwoTapDeleteButton } from "@/components/ui/two-tap-delete-button";
import { feedback } from "@/lib/feedback";
import { useSession } from "@/lib/auth-client";
import { collabApi, CollabError, type CollabList, type CollabPerson, type CollabRole } from "./collab-api";
import { useCollabStore } from "./collab-store";
import { InvitePicker, type InviteCandidate } from "./invite-picker";
import { InviteLinkSection } from "./invite-link-section";
import { RoleMenu } from "./role-menu";

function PersonAvatar({ name, image }: { name: string; image: string | null }) {
  return (
    <Avatar className="h-8 w-8">
      {image ? <AvatarImage src={image} alt="" /> : null}
      <AvatarFallback className="bg-primary/15 text-xs font-semibold text-primary">{name.slice(0, 1).toUpperCase()}</AvatarFallback>
    </Avatar>
  );
}

/** One menu value per thing a collaborator can be. */
type Seat = "editor" | "publisher" | "viewer";
const seatOf = (p: Pick<CollabPerson, "role" | "canPublish">): Seat =>
  p.role === "viewer" ? "viewer" : p.canPublish ? "publisher" : "editor";
const patchFor = (seat: Seat): { role: CollabRole; canPublish: boolean } =>
  seat === "viewer" ? { role: "viewer", canPublish: false } : { role: "editor", canPublish: seat === "publisher" };

/**
 * Who works on this card, Google-Docs style. The creator invites people by
 * name or from their friends, sets what each may do (edit, edit and publish,
 * view) and removes them. Everyone else sees the list and can leave.
 */
export function ShareDialog({ worldId, open, onOpenChange }: { worldId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation("editor");
  const router = useRouter();
  const { data: session } = useSession();
  const accessVersion = useCollabStore((s) => s.accessVersion);
  const [list, setList] = useState<CollabList | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [invitingId, setInvitingId] = useState<string | null>(null);
  const [linkOn, setLinkOn] = useState(false);
  const [removedWhileLinkOn, setRemovedWhileLinkOn] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setList(await collabApi.list(worldId));
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [worldId]);
  useEffect(() => { if (open) void reload(); }, [open, reload, accessVersion]);
  useEffect(() => { if (!open) setRemovedWhileLinkOn(false); }, [open]);

  const isOwner = list?.me.role === "owner";
  const errorText = (error: unknown) => {
    const code = error instanceof CollabError ? error.code : undefined;
    if (code === "USER_NOT_FOUND") return t("collab.errors.userNotFound", "No one by that username");
    if (code === "SELF") return t("collab.errors.self", "That's you — you already own this card");
    if (code === "ALREADY_INVITED") return t("collab.errors.alreadyInvited", "Already invited");
    if (code === "TOO_MANY") return t("collab.errors.tooMany", { max: list?.max ?? 10, defaultValue: "A card can have up to {{max}} collaborators" });
    return t("collab.errors.generic", "That didn't work — try again");
  };

  const invite = async (person: InviteCandidate, role: CollabRole) => {
    if (invitingId) return;
    setInvitingId(person.id);
    try {
      const sent = await collabApi.invite(worldId, { userId: person.id }, role);
      // Asked again soon after: no second notification went out, so don't say "invited".
      feedback.notice(sent.notified === false
        ? t("collab.errors.alreadyInvited", "Already invited")
        : t("collab.invited", { name: person.name, defaultValue: "Invited {{name}}" }));
      await reload();
    } catch (error) {
      feedback.error(errorText(error));
    } finally {
      setInvitingId(null);
    }
  };
  const onCard = new Set([list?.owner?.id, ...(list?.collaborators.map((c) => c.userId) ?? [])].filter((id): id is string => !!id));

  const update = async (person: CollabPerson, patch: { role?: CollabRole; canPublish?: boolean }) => {
    // A person who left or was removed meanwhile is gone from the list on reload.
    try { await collabApi.update(worldId, person.userId, patch); await reload(); } catch (error) { feedback.error(errorText(error)); void reload(); }
  };
  const remove = async (person: CollabPerson) => {
    try {
      await collabApi.remove(worldId, person.userId);
      if (linkOn) setRemovedWhileLinkOn(true);
      await reload();
    } catch (error) { feedback.error(errorText(error)); }
  };
  const leave = async () => {
    const me = session?.user?.id;
    if (!me) return;
    try {
      await collabApi.remove(worldId, me);
      onOpenChange(false);
      void router.navigate({ to: "/app/library", search: { worldId: undefined, view: "projects", assetId: undefined } });
    } catch (error) { feedback.error(errorText(error)); }
  };

  const seatOptions: { value: Seat; label: string }[] = [
    { value: "editor", label: t("collab.role.editor", "Can edit") },
    { value: "publisher", label: t("collab.role.publisher", "Can edit & publish") },
    { value: "viewer", label: t("collab.role.viewer", "Can view") },
  ];
  const seatLabel = (p: CollabPerson) => seatOptions.find((o) => o.value === seatOf(p))?.label ?? "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        {/* Room for the close button: both sides while the header is centred (phones), the right side once it is left-aligned. */}
        <DialogHeader className="px-10 sm:pl-0 sm:pr-10">
          <DialogTitle>{t("collab.title", "Work on this card together")}</DialogTitle>
          <DialogDescription>
            {list && !isOwner
              ? t("collab.descriptionCollaborator", "The assistant, pictures and test plays use your own credits.")
              : t("collab.description", "Whoever uses the assistant, makes pictures or test-plays pays with their own credits.")}
          </DialogDescription>
        </DialogHeader>

        {isOwner && <InvitePicker excludeIds={onCard} busyId={invitingId} onInvite={(person, role) => void invite(person, role)} />}

        <div className="mt-2 space-y-1">
          {loading && !list && <div className="flex justify-center py-6"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>}
          {!loading && !list && loadFailed && (
            <div className="flex items-center justify-between gap-3 px-2 py-4 text-xs text-muted-foreground">
              <span>{t("collab.loadFailed", "Couldn't load who's on this card.")}</span>
              <button type="button" onClick={() => void reload()} className="hover-surface rounded-md px-2 py-1 font-medium text-foreground">
                {t("collab.retry", "Try again")}
              </button>
            </div>
          )}
          {list?.owner && (
            <div className="flex items-center gap-3 rounded-lg px-2 py-2">
              <PersonAvatar name={list.owner.name} image={list.owner.image} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{list.owner.name}{list.owner.id === session?.user?.id ? ` ${t("collab.you", "(you)")}` : ""}</div>
                {list.owner.username && <div className="truncate text-xs text-muted-foreground">@{list.owner.username}</div>}
              </div>
              <span className="px-2 text-xs text-muted-foreground">{t("collab.role.owner", "Creator")}</span>
            </div>
          )}
          {list?.collaborators.map((person) => (
            <div key={person.userId} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-accent/40">
              <PersonAvatar name={person.name} image={person.image} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">
                  {person.name}{person.userId === session?.user?.id ? ` ${t("collab.you", "(you)")}` : ""}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {person.username ? `@${person.username}` : ""}
                  {person.username && person.status === "pending" ? " · " : ""}
                  {person.status === "pending" ? t("collab.pending", "Invited — hasn't accepted yet") : ""}
                </div>
              </div>
              {isOwner ? (
                <RoleMenu
                  value={seatOf(person)}
                  options={seatOptions}
                  label={t("collab.roleLabel", "Role")}
                  onChange={(seat) => void update(person, patchFor(seat))}
                  onRemove={() => void remove(person)}
                />
              ) : (
                <span className="shrink-0 px-2 text-xs text-muted-foreground">{seatLabel(person)}</span>
              )}
            </div>
          ))}
          {isOwner && removedWhileLinkOn && linkOn && (
            <p className="px-2 py-1 text-[11px] text-muted-foreground">{t("collab.link.stillOn", "The invite link is still on. You can reset it or turn it off below.")}</p>
          )}
        </div>

        {isOwner && <InviteLinkSection worldId={worldId} onLinkChange={setLinkOn} />}

        {list && !isOwner && (
          <div className="mt-2 flex justify-end">
            <TwoTapDeleteButton
              onConfirm={() => void leave()}
              className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              armedClassName="border-destructive/50 bg-destructive/10 text-destructive hover:bg-destructive/15"
              armedChildren={t("collab.leaveConfirm", "Tap again to leave")}
            >
              {t("collab.leave", "Leave this card")}
            </TwoTapDeleteButton>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
