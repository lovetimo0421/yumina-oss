import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "@tanstack/react-router";
import { authClient, useSession } from "@/lib/auth-client";
import { useEditorStore } from "@/stores/editor";
import { useCollabStore } from "@/features/collab/collab-store";

/** A load that failed leaves serverWorldId null, which the editor routes read as
 *  "still loading" — without this the editor spins forever on someone else's
 *  card or a dropped connection.
 *
 *  Removed from a shared card: no Retry (it can't come back), the way out is
 *  My projects, where the shared cards live, and whatever they had typed and
 *  not saved can still be copied. */
export function EditorUnavailable({ reason }: { reason: "notFound" | "failed" | "removed" }) {
  const { t } = useTranslation("common");
  const { data: session, isPending } = useSession();
  // A draft reads as "not found" to anyone but its owner, signed-out readers
  // included. Creators whose session lapsed took that for a deleted card, and
  // the page can still believe in a session the server dropped (the session
  // cookie is cached for minutes), so ask the server itself before naming an
  // account.
  const userId = session?.user?.id;
  const [server, setServer] = useState<"checking" | "in" | "out">("checking");
  useEffect(() => {
    if (reason !== "notFound" || isPending || !userId) return;
    let live = true;
    setServer("checking");
    authClient.getSession({ query: { disableCookieCache: true } })
      .then((res) => { if (live) setServer(res.data?.user ? "in" : "out"); })
      .catch(() => { if (live) setServer("in"); });
    return () => { live = false; };
  }, [reason, isPending, userId]);
  const signedOut = reason === "notFound" && !isPending && (!userId || server === "out");
  const account = server === "in" ? session?.user?.name || session?.user?.email || "" : "";
  const message = reason !== "notFound" ? t("studioLoadFailed")
    : signedOut ? t("studioSignedOut")
    : account ? t("studioNotYoursAccount", { name: account }) : t("studioNotYours");
  const returnTo = typeof window !== "undefined" ? window.location.pathname : "/app";
  const { t: te } = useTranslation("editor");
  const { t: tl } = useTranslation("library");
  const leftover = useCollabStore((s) => (reason === "removed" ? s.removedUnsaved : null));
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!leftover) return;
    try {
      await navigator.clipboard.writeText(leftover);
      setCopied(true);
    } catch { /* the clipboard was refused: the button stays */ }
  };
  return (
    <div className="flex h-full w-full items-center justify-center bg-background px-6">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <p className="text-sm leading-relaxed text-muted-foreground">
          {reason === "removed" ? t("studioNoLongerShared") : message}
        </p>
        {leftover && <p className="-mt-2 text-xs text-muted-foreground">{te("collab.removedUnsaved")}</p>}
        <div className="flex flex-wrap items-center justify-center gap-2">
          {reason === "removed" ? (
            leftover && (
              <button
                type="button"
                onClick={() => void copy()}
                className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                {copied ? te("collab.copiedUnsaved") : te("collab.copyUnsaved")}
              </button>
            )
          ) : (
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              {t("action.retry")}
            </button>
          )}
          {reason === "removed" ? (
            <Link
              to="/app/library"
              search={{ worldId: undefined, view: "projects", assetId: undefined }}
              className="rounded-lg bg-primary px-3 py-1.5 text-xs font-bold text-primary-foreground transition-opacity hover:opacity-90"
            >
              {tl("tabs.myProjects")}
            </Link>
          ) : signedOut ? (
            <a
              href={`/login?returnTo=${encodeURIComponent(returnTo)}`}
              className="rounded-lg bg-primary px-3 py-1.5 text-xs font-bold text-primary-foreground transition-opacity hover:opacity-90"
            >
              {t("studioSignIn")}
            </a>
          ) : (
            <a
              href="/app/profile"
              className="rounded-lg bg-primary px-3 py-1.5 text-xs font-bold text-primary-foreground transition-opacity hover:opacity-90"
            >
              {t("backToMyWorlds")}
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

/** Whether the loaded card belongs to someone else (and they weren't invited). A published card's GET
 *  succeeds for any signed-in user, so a 200 alone used to open a stranger's
 *  card in the editor (reached from the Library with browser Back). Admins
 *  read others' cards through read-only inspect, which is exempt. */
export function useEditorOwnership(worldId: string): "pending" | "notMine" | null {
  const { data: session, isPending } = useSession();
  const serverWorldId = useEditorStore((s) => s.serverWorldId);
  const serverCreatorId = useEditorStore((s) => s.serverCreatorId);
  const readOnlyInspect = useEditorStore((s) => s.readOnlyInspect);
  // The server names the reader's role on the card: its creator or someone
  // the creator invited to work on it with them.
  const access = useEditorStore((s) => s.access);
  if (serverWorldId !== worldId || !serverCreatorId || readOnlyInspect || access) return null;
  if (isPending) return "pending";
  return session?.user?.id === serverCreatorId ? null : "notMine";
}
