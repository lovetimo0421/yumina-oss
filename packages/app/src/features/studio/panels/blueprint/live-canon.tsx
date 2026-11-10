import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useEditorStore } from "@/stores/editor";
import { Check, Group } from "./controls";

const apiBase = import.meta.env.VITE_API_URL || "";

/** Whether this card lets players edit their run (Lore Shift), shared so a
 *  setting only offers its own switch once the card does. */
const liveCanonAllowed = new Map<string, boolean>();
const LIVE_CANON_EVENT = "yumina:live-canon-flags";
export function useLiveCanonAllowed(worldId: string | null): boolean {
  const [allowed, setAllowed] = useState(() => (worldId ? liveCanonAllowed.get(worldId) ?? false : false));
  useEffect(() => {
    if (!worldId) return;
    const sync = () => setAllowed(liveCanonAllowed.get(worldId) ?? false);
    sync();
    if (!liveCanonAllowed.has(worldId)) {
      fetch(`${apiBase}/api/worlds/${worldId}?forEdit=1`, { credentials: "include" })
        .then((r) => (r.ok ? r.json() : null))
        .then((body: { data?: { allowLiveCanon?: boolean } } | null) => {
          if (!body) return;
          liveCanonAllowed.set(worldId, Boolean(body.data?.allowLiveCanon));
          window.dispatchEvent(new Event(LIVE_CANON_EVENT));
        })
        .catch(() => {});
    }
    window.addEventListener(LIVE_CANON_EVENT, sync);
    return () => window.removeEventListener(LIVE_CANON_EVENT, sync);
  }, [worldId]);
  return allowed;
}

/** The card-level Lore Shift switches. They are columns on the world row,
 *  not part of the draft, so they read and write through the worlds API the
 *  way the publish dialog does — the same two flags, one source of truth.
 *  Until now the only way to turn them on was to leave the blueprint for the
 *  publish dialog, while the per-entry and per-variable switches sat right
 *  here doing nothing without them.
 *
 *  Lives in its own module because it is drawn in two places — the canvas
 *  inspector's card form and the Studio menu's "Card settings" overview —
 *  and the overview is itself embedded by the inspector, so it cannot import
 *  from inspector.tsx without a cycle. */
export function LiveCanonGroup({ card = false }: { card?: boolean } = {}) {
  const { t } = useTranslation("editor");
  const worldId = useEditorStore((s) => s.serverWorldId);
  const readOnly = useEditorStore((s) => s.readOnlyInspect || s.guestMode);
  const [flags, setFlags] = useState<{ allow: boolean; additions: boolean } | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!worldId) return;
    let cancelled = false;
    setFailed(false);
    fetch(`${apiBase}/api/worlds/${worldId}?forEdit=1`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body: { data?: { allowLiveCanon?: boolean; allowLiveCanonAdditions?: boolean } }) => {
        if (cancelled) return;
        setFlags({
          allow: Boolean(body.data?.allowLiveCanon),
          additions: Boolean(body.data?.allowLiveCanonAdditions),
        });
        liveCanonAllowed.set(worldId, Boolean(body.data?.allowLiveCanon));
        window.dispatchEvent(new Event(LIVE_CANON_EVENT));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [worldId, attempt]);
  // On the overview page every setting sits in its own bordered card; the
  // frame is drawn here so nothing shows while there is nothing to show.
  const frame = (node: ReactNode) => (card ? <div className="rounded-lg border border-border bg-background p-5">{node}</div> : node);
  if (!worldId || readOnly) return null;
  // A read that failed used to leave this null for good, so the group simply
  // never appeared and nothing said why. Say so, and offer the read again.
  if (!flags) {
    if (!failed) return null;
    return frame(
      <Group title={t("blueprint.insp.liveCanon")} hint={t("blueprint.tips.liveCanon")}>
        <p className="text-[10px] leading-relaxed text-destructive">
          {t("blueprint.insp.liveCanonLoadFailed", { defaultValue: "Could not load the Lore Shift settings." })}
        </p>
        <button
          type="button"
          onClick={() => setAttempt((n) => n + 1)}
          className="self-start rounded-md px-1.5 py-0.5 text-[11px] text-foreground/70 transition-colors hover:bg-white/[0.07] hover:text-foreground"
        >
          {t("versionHistory.retry")}
        </button>
      </Group>
    );
  }

  const save = async (next: { allow: boolean; additions: boolean }) => {
    const previous = flags;
    // Turning the master switch off takes additions with it — the server
    // enforces the same rule, so the panel never shows a state it cannot hold.
    const settled = next.allow ? next : { allow: false, additions: false };
    setFlags(settled);
    if (worldId) { liveCanonAllowed.set(worldId, settled.allow); window.dispatchEvent(new Event(LIVE_CANON_EVENT)); }
    setFailed(false);
    try {
      const res = await fetch(`${apiBase}/api/worlds/${worldId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ allowLiveCanon: settled.allow, allowLiveCanonAdditions: settled.additions }),
      });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      setFlags(previous);
      setFailed(true);
    }
  };

  return frame(
    <Group title={t("blueprint.insp.liveCanon")} hint={t("blueprint.tips.liveCanon")}>
      <Check
        label={t("blueprint.insp.allowLiveCanon")}
        hint={t("blueprint.insp.allowLiveCanonHint")}
        checked={flags.allow}
        onChange={(allow) => void save({ allow, additions: flags.additions })}
      />
      {flags.allow && (
        <Check
          label={t("blueprint.insp.allowLiveCanonAdditions")}
          hint={t("blueprint.insp.allowLiveCanonAdditionsHint")}
          checked={flags.additions}
          onChange={(additions) => void save({ allow: true, additions })}
        />
      )}
      {failed && (
        <p className="text-[10px] leading-relaxed text-destructive">{t("blueprint.insp.liveCanonSaveFailed")}</p>
      )}
    </Group>
  );
}
