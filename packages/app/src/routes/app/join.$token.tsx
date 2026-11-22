import { useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Loader2, Users } from "lucide-react";
import { resolveImageUrl } from "@/lib/asset-url";
import { useAuthGuard } from "@/hooks/use-auth-guard";
import { CollabError } from "@/features/collab/collab-api";
import { linkApi, type InviteLinkPreview } from "@/features/collab/link-api";

export const Route = createFileRoute("/app/join/$token")({
  component: JoinCardPage,
});

/**
 * Where a card's invite link opens: who invites you to which card, as what,
 * and one button that joins and opens it in Studio. Signing in or signing up
 * first comes back to this page (auth-return allows /app/join/<token>), so the
 * button is there afterwards.
 */
function JoinCardPage() {
  const { token } = Route.useParams();
  const { t } = useTranslation("editor");
  const navigate = useNavigate();
  const { isAuthenticated, isPending, requireAuth } = useAuthGuard();
  const [preview, setPreview] = useState<InviteLinkPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);

  const errorText = (e: unknown) => {
    const code = e instanceof CollabError ? e.code : undefined;
    if (code === "REMOVED_BY_OWNER") return t("collab.join.removed");
    if (code === "BLOCKED") return t("collab.join.blocked", { defaultValue: "You can't join this card." });
    if (code === "TOO_MANY") return t("collab.join.full", { defaultValue: "This card already has as many collaborators as it can take." });
    if (code === "LINK_GONE" || (e instanceof CollabError && e.status === 404)) {
      return t("collab.join.gone", { defaultValue: "This link no longer works. Ask the card's creator for a new one." });
    }
    return t("collab.join.failed", { defaultValue: "Couldn't open this invite — try again." });
  };

  // Signed out, the preview is asked for too: when the server answers it
  // (card, cover and who invites, nothing else), the guest sees what they are
  // signing in for. When it doesn't, the page just asks them to sign in.
  useEffect(() => {
    if (isPending) return;
    let live = true;
    setError(null);
    setPreview(null);
    linkApi.preview(token)
      .then((p) => { if (live) setPreview(p); })
      .catch((e) => { if (live && isAuthenticated) setError(errorText(e)); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, isAuthenticated, isPending]);

  const join = async () => {
    if (!preview || joining) return;
    setJoining(true);
    setError(null);
    try {
      const { worldId } = preview.alreadyMember && preview.worldId ? { worldId: preview.worldId } : await linkApi.join(token);
      await navigate({ to: "/app/studio/$worldId", params: { worldId } });
    } catch (e) {
      setError(errorText(e));
      setJoining(false);
    }
  };

  const roleText = (role: string) => role === "editor"
    ? t("collab.role.editor", "Can edit")
    : role === "owner" ? t("collab.role.owner", "Creator") : t("collab.role.viewer", "Can view");

  const cardLine = preview && (
    <div className="flex items-center gap-3">
      <div className="flex h-16 w-12 shrink-0 items-center justify-center overflow-hidden rounded-md bg-gradient-to-br from-muted to-muted/40">
        {preview.thumbnailUrl
          ? <img src={resolveImageUrl(preview.thumbnailUrl)} alt="" className="h-full w-full object-cover" />
          : <Users className="h-5 w-5 text-muted-foreground/60" aria-hidden />}
      </div>
      <div className="min-w-0">
        <p className="text-sm leading-snug">
          {t("collab.join.line", { name: preview.creatorName, world: preview.worldName, defaultValue: "{{name}} invites you to work on “{{world}}” together" })}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {preview.alreadyMember && preview.myRole
            ? t("collab.join.youAre", { role: roleText(preview.myRole), defaultValue: "You're already on this card · {{role}}" })
            : roleText(preview.role)}
        </p>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-5 shadow-sm">
        {isPending ? (
          <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : !isAuthenticated ? (
          <div className="space-y-4">
            {cardLine ?? <Users className="mx-auto h-6 w-6 text-muted-foreground" />}
            <p className={preview ? "text-xs text-muted-foreground" : "text-center text-sm"}>
              {t("collab.join.signIn", { defaultValue: "Sign in to join this card." })}
            </p>
            <button
              type="button"
              onClick={() => requireAuth(t("collab.join.signInAction", { defaultValue: "join this card" }))}
              className="w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              {t("collab.join.signInButton", { defaultValue: "Sign in" })}
            </button>
          </div>
        ) : !preview ? (
          error
            ? <p className="py-4 text-center text-sm text-muted-foreground">{error}</p>
            : <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : (
          <div className="space-y-4">
            {cardLine}
            {error && <p className="text-xs text-destructive">{error}</p>}
            {/* The creator took them off this card: the link can't bring them
                back, only a new invitation can. */}
            {preview.removed && !error ? (
              <p className="text-xs text-muted-foreground">{t("collab.join.removed")}</p>
            ) : !preview.removed && <button
              type="button"
              onClick={() => void join()}
              disabled={joining}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
            >
              {joining && <Loader2 className="h-4 w-4 animate-spin" />}
              {preview.alreadyMember
                ? t("collab.join.open", { defaultValue: "Open the card" })
                : t("collab.join.button", { defaultValue: "Join and open" })}
            </button>}
          </div>
        )}
      </div>
    </div>
  );
}
