import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link2, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { feedback } from "@/lib/feedback";
import type { CollabRole } from "./collab-api";
import { inviteLinkUrl, linkApi, type InviteLink } from "./link-api";
import { RoleMenu } from "./role-menu";

/**
 * The card's invite link, under the people list: "anyone with the link" as an
 * editor or a viewer, on or off, the address to copy and a reset that retires
 * it. Creator only; the dialog doesn't render it for anyone else.
 */
export function InviteLinkSection({ worldId, onLinkChange }: { worldId: string; onLinkChange?: (on: boolean) => void }) {
  const { t } = useTranslation("editor");
  const [link, setLink] = useState<InviteLink | null>(null);
  const [role, setRole] = useState<CollabRole>("viewer");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { onLinkChange?.(!!link); }, [link, onLinkChange]);

  useEffect(() => {
    let live = true;
    linkApi.get(worldId)
      .then((l) => { if (!live) return; setLink(l); if (l) setRole(l.role); })
      .catch(() => {})
      .finally(() => { if (live) setLoaded(true); });
    return () => { live = false; };
  }, [worldId]);

  const failed = () => feedback.error(t("collab.link.failed", { defaultValue: "That didn't work — try again" }));
  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try { await fn(); } catch { failed(); } finally { setBusy(false); }
  };
  const toggle = () => run(async () => {
    if (link) { await linkApi.off(worldId); setLink(null); }
    else setLink(await linkApi.set(worldId, role));
  });
  const changeRole = (next: CollabRole) => {
    setRole(next);
    if (link) void run(async () => { setLink(await linkApi.set(worldId, next)); });
  };
  const reset = () => run(async () => {
    setLink(await linkApi.reset(worldId));
    feedback.notice(t("collab.link.resetDone", { defaultValue: "New link made — the old one no longer works" }));
  });
  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(inviteLinkUrl(link));
      feedback.notice(t("collab.link.copied", { defaultValue: "Link copied" }));
    } catch {
      inputRef.current?.select();
    }
  };

  if (!loaded) return null;
  return (
    <div className="mt-3 space-y-2 border-t border-border pt-3">
      <div className="flex items-center gap-2 px-2">
        <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm">{t("collab.link.anyone", { defaultValue: "Anyone with the link" })}</span>
        <RoleMenu
          value={role}
          options={[
            { value: "editor" as CollabRole, label: t("collab.role.editor", "Can edit") },
            { value: "viewer" as CollabRole, label: t("collab.role.viewer", "Can view") },
          ]}
          onChange={changeRole}
          disabled={busy}
          label={t("collab.link.roleLabel", { defaultValue: "What the link lets people do" })}
        />
        {/* Off has to read as a switch too: a visible knob on a bordered track. */}
        <button
          type="button"
          role="switch"
          aria-checked={!!link}
          aria-label={t("collab.link.toggle", { defaultValue: "Invite link" })}
          onClick={() => void toggle()}
          disabled={busy}
          className={cn(
            "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
            link ? "border-primary/60 bg-primary" : "border-border bg-muted",
          )}
        >
          <span
            className={cn(
              "inline-block h-3.5 w-3.5 rounded-full shadow transition-transform",
              link ? "translate-x-[18px] bg-primary-foreground" : "translate-x-[3px] bg-muted-foreground/70",
            )}
          />
        </button>
      </div>
      {link && (
        <div className="space-y-1.5 px-2">
          <div className="flex items-center gap-1.5">
            <input
              ref={inputRef}
              readOnly
              value={inviteLinkUrl(link)}
              onFocus={(e) => e.currentTarget.select()}
              aria-label={t("collab.link.address", { defaultValue: "Invite link address" })}
              className="min-w-0 flex-1 rounded-md border border-border bg-muted/40 px-2 py-1 text-xs text-muted-foreground"
            />
            <button
              type="button"
              onClick={() => void copy()}
              className="shrink-0 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-accent"
            >
              {t("collab.link.copy", { defaultValue: "Copy link" })}
            </button>
          </div>
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => void reset()}
              disabled={busy}
              className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              {busy && <Loader2 className="h-3 w-3 animate-spin" />}
              {t("collab.link.reset", { defaultValue: "Reset link" })}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
