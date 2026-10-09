import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, FileText } from "lucide-react";
import type { StudioBuildProposal } from "@yumina/shared";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { handoffKey, hasSeenBuildOffer, markBuildOfferSeen } from "../lib/build-handoff";

export function BuildHandoff({ proposal, worldId, conversationId, available, onBuild }: {
  proposal: StudioBuildProposal | null;
  worldId: string | null;
  conversationId: string | null;
  available: boolean;
  onBuild: (proposal: StudioBuildProposal) => boolean;
}) {
  const { t } = useTranslation("editor");
  const [openKey, setOpenKey] = useState<string | null>(null);
  const submitting = useRef(false);
  const key = proposal && worldId && conversationId ? handoffKey(worldId, conversationId, proposal.revision) : null;
  const open = available && !!key && openKey === key;

  useEffect(() => {
    if (!key || !available) { setOpenKey(null); return; }
    submitting.current = false;
    if (!hasSeenBuildOffer(key)) {
      markBuildOfferSeen(key);
      setOpenKey(key);
    }
  }, [key, available]);

  if (!proposal || !key || !available) return null;
  return (
    <>
      <button type="button" onClick={() => setOpenKey(key)} className="flex items-center gap-1.5 py-2 text-xs text-primary hover:underline">
        {t("studio.aiChat.mode.reviewBuild")}<ArrowRight className="h-3 w-3" aria-hidden="true" />
      </button>
      <Dialog open={open} onOpenChange={value => setOpenKey(value ? key : null)}>
        <DialogContent mobileSheet hideClose className="gap-0 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:max-w-sm">
          <div className="mx-auto mb-5 h-1 w-8 rounded-full bg-border sm:hidden" aria-hidden="true" />
          <p className="mb-2 text-xs text-primary">{t("studio.aiChat.mode.briefSaved")}</p>
          <DialogTitle className="mb-2 text-xl leading-snug">{t("studio.aiChat.mode.buildTitle")}</DialogTitle>
          <DialogDescription className="mb-5 leading-relaxed">{proposal.summary}</DialogDescription>
          <ul className="mb-5 space-y-3 border-y border-border py-4">
            {proposal.steps.map((step, index) => (
              <li key={index} className="flex items-start gap-3 text-sm leading-relaxed">
                <FileText className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 break-words">{step}</span>
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <button type="button" onClick={() => setOpenKey(null)} className="min-h-11 flex-1 rounded-lg border border-border bg-background px-3 py-2.5 text-sm hover:bg-muted">
              {t("studio.aiChat.mode.keepPlanning")}
            </button>
            <button type="button" onClick={() => {
              if (submitting.current) return;
              submitting.current = true;
              if (onBuild(proposal)) setOpenKey(null);
              else submitting.current = false;
            }} className="min-h-11 flex-1 rounded-lg bg-primary px-3 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90">
              {t("studio.aiChat.mode.startBuild")}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
