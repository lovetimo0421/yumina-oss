import { useEffect, useState } from "react";
import { formatUsd } from "./money";
import { useTranslation } from "react-i18next";
import { Check, Copy, Download, ImageIcon, Loader2, Share2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { feedback } from "@/lib/feedback";
import { DEFAULT_INVITE_RACE_RULES, type InviteRaceRules } from "@yumina/shared";
import { renderInviteRacePoster } from "./poster";

export function inviteUrlFor(code: string) {
  return `${window.location.origin}/invite/${code}`;
}

export function useInviteRacePoster(code: string | null, rules: InviteRaceRules = DEFAULT_INVITE_RACE_RULES) {
  const { t } = useTranslation("profile");
  return async () => {
    if (!code) throw new Error("no code");
    const max = rules.bands.reduce((s, b) => s + Math.floor((b.to - b.from) / b.per), 0);
    const pool = rules.sharedPotUsd + rules.rankPrizesUsd.reduce((x, y) => x + y, 0);
    return renderInviteRacePoster({
      brand: `YUMINA · ${t("inviteRace.title")}`,
      line1: t("inviteRace.poster.line1"),
      line2: t("inviteRace.poster.line2"),
      amount: formatUsd(pool, 0),
      sub: t("inviteRace.poster.sub"),
      capLabel: t("inviteRace.poster.capLabel"),
      capValue: String(rules.signupTickets + rules.activeTickets + max),
      capUnit: t("inviteRace.poster.capUnit"),
      capDetail: t("inviteRace.poster.capDetail", { a: rules.signupTickets, b: rules.activeTickets, c: max }),
      steps: [
        { title: t("inviteRace.poster.st1"), body: t("inviteRace.poster.sb1") },
        { title: t("inviteRace.poster.st2"), body: t("inviteRace.poster.sb2") },
        { title: t("inviteRace.poster.st3"), body: t("inviteRace.poster.sb3", { pool: `$${pool.toLocaleString("en-US")}` }) },
      ],
      tipLabel: t("inviteRace.poster.tipLabel"),
      tip: t("inviteRace.poster.tip"),
      codeLabel: t("inviteRace.poster.codeLabel"),
      code,
      scan: t("inviteRace.poster.scan"),
      url: inviteUrlFor(code),
      artUrl: "/images/invite-race/mascot-art.jpg",
    });
  };
}

/** The first thing on the page: your link, one tap to copy, one to share, one for a poster. */
export function ShareBar({ code, rules }: { code: string | null; rules: InviteRaceRules }) {
  const { t } = useTranslation("profile");
  const [copied, setCopied] = useState(false);
  const [posterOpen, setPosterOpen] = useState(false);
  if (!code) return null;
  const url = inviteUrlFor(code);
  const shareText = t("inviteRace.shareText", { url });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shareText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      feedback.error(t("inviteRace.copyFailed"));
    }
  };
  const share = async () => {
    if (navigator.share) {
      try { await navigator.share({ text: shareText, url }); } catch { /* cancelled */ }
    } else void copy();
  };

  return (
    <>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
        <div className="flex min-w-0 flex-1 items-center gap-3 rounded-xl border border-white/[0.08] bg-black/30 px-3.5 py-2.5">
          <span className="shrink-0 text-[11px] font-semibold text-sub/55">{t("inviteRace.inviteLink")}</span>
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-main">{url.replace(/^https?:\/\//, "")}</span>
          <span className="hidden shrink-0 font-mono text-xs font-bold tracking-wider text-gold/90 sm:inline">{code}</span>
        </div>
        <div className="grid grid-cols-[1fr_auto_auto] gap-2">
          <button type="button" onClick={copy} className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-gold px-5 py-2.5 text-sm font-bold text-black hover:brightness-110">
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            {copied ? t("inviteRace.copied") : t("inviteRace.copy")}
          </button>
          <button type="button" onClick={share} aria-label={t("inviteRace.share")} className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-white/10 px-3.5 py-2.5 text-sm font-semibold text-main hover:bg-white/[0.05]">
            <Share2 className="h-4 w-4" /><span className="hidden sm:inline">{t("inviteRace.share")}</span>
          </button>
          <button type="button" onClick={() => setPosterOpen(true)} aria-label={t("inviteRace.poster.button")} className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-white/10 px-3.5 py-2.5 text-sm font-semibold text-main hover:bg-white/[0.05]">
            <ImageIcon className="h-4 w-4" /><span className="hidden sm:inline">{t("inviteRace.poster.button")}</span>
          </button>
        </div>
      </div>
      <p className="mt-2 text-[11.5px] text-sub/50">{t("inviteRace.worldLinkHint")}</p>
      <PosterDialog open={posterOpen} onOpenChange={setPosterOpen} code={code} rules={rules} />
    </>
  );
}

export function PosterDialog({ open, onOpenChange, code, rules }: { open: boolean; onOpenChange: (v: boolean) => void; code: string; rules: InviteRaceRules }) {
  const { t } = useTranslation("profile");
  const make = useInviteRacePoster(code, rules);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    let objectUrl: string | null = null;
    make().then((b) => {
      if (!alive) return;
      objectUrl = URL.createObjectURL(b);
      setBlob(b);
      setSrc(objectUrl);
    }).catch(() => feedback.error(t("inviteRace.poster.failed")));
    return () => { alive = false; if (objectUrl) URL.revokeObjectURL(objectUrl); setSrc(null); setBlob(null); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, code]);

  const download = () => {
    if (!src) return;
    const a = document.createElement("a");
    a.href = src;
    a.download = `yumina-invite-${code}.png`;
    a.click();
  };
  const shareImage = async () => {
    if (!blob) return;
    const file = new File([blob], `yumina-invite-${code}.png`, { type: "image/png" });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], text: t("inviteRace.shareText", { url: inviteUrlFor(code) }) }); } catch { /* cancelled */ }
    } else download();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md border-white/10 bg-[#16171d] p-4">
        <DialogTitle className="text-base font-bold text-main">{t("inviteRace.poster.title")}</DialogTitle>
        <DialogDescription className="text-xs text-sub/60">{t("inviteRace.poster.hint")}</DialogDescription>
        <div className="mt-2 flex aspect-[3/4] items-center justify-center overflow-hidden rounded-xl border border-white/10 bg-black/30">
          {src ? <img src={src} alt="" className="h-full w-full object-contain" /> : <Loader2 className="h-5 w-5 animate-spin text-sub/50" />}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button type="button" disabled={!src} onClick={download} className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-white/15 px-3 py-2.5 text-sm font-bold text-main disabled:opacity-40">
            <Download className="h-4 w-4" />{t("inviteRace.poster.download")}
          </button>
          <button type="button" disabled={!blob} onClick={shareImage} className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-gold px-3 py-2.5 text-sm font-bold text-black disabled:opacity-40">
            <Share2 className="h-4 w-4" />{t("inviteRace.share")}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
