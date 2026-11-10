import { useEffect, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { feedback } from "@/lib/feedback";
import { useUserPromptsStore } from "@/stores/user-prompts";

interface PromptComposerDialogProps {
  open: boolean;
  onClose: () => void;
}

/**
 * 「自己写一条」 from the in-chat 提示词 panel. Lives in the host, not the
 * sandbox: card code shares the sandbox, and a prompt saved here is sent on
 * every chat, so only the player typing into host UI may create one.
 *
 * Saved like the plaza's 「最前」 position with no model binding — always on,
 * every card, every model. Placement and model binding stay in full settings.
 */
export function PromptComposerDialog({ open, onClose }: PromptComposerDialogProps) {
  const { t } = useTranslation("unrestrict");
  const router = useRouter();
  const savePrompt = useUserPromptsStore((s) => s.savePrompt);
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName("");
    setContent("");
    setSaving(false);
  }, [open]);

  const body = content.trim();
  const save = async () => {
    if (!body || saving) return;
    setSaving(true);
    const title = name.trim() || body.split("\n")[0]!.slice(0, 24);
    const ok = await savePrompt({ title, parts: [{ content: body, position: "first" }], autoModels: null });
    setSaving(false);
    if (!ok) return void feedback.error(t("prompts.compose.failed"));
    feedback.notice(t("prompts.compose.saved"));
    onClose();
  };
  const toSettings = () => {
    onClose();
    void router.navigate({ to: "/app/settings", hash: "prompts" } as never);
  };

  const input = "w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 text-sm text-main placeholder:text-muted-foreground/50 focus:border-gold/40 focus:outline-none";

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="border-white/10 bg-[#1F1D21] p-6 text-main shadow-2xl shadow-gold/5 sm:max-w-[480px] sm:rounded-3xl">
        <DialogTitle className="text-base font-semibold text-main">{t("prompts.compose.title")}</DialogTitle>
        <p className="text-sm leading-relaxed text-muted-foreground">{t("prompts.compose.explain")}</p>
        <div className="space-y-3">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            placeholder={t("prompts.compose.namePlaceholder")}
            aria-label={t("prompts.compose.name")}
            className={`${input} h-10`}
          />
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={6}
            autoFocus
            placeholder={t("prompts.compose.contentPlaceholder")}
            aria-label={t("prompts.compose.content")}
            className={`${input} resize-y py-2.5 leading-relaxed`}
          />
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={toSettings}
            className="mr-auto text-xs text-muted-foreground transition-colors hover:text-main"
          >
            {t("prompts.compose.more")}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex min-h-10 items-center rounded-xl px-4 text-sm text-muted-foreground transition-colors hover:text-main"
          >
            {t("cancel")}
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={!body || saving}
            className="inline-flex min-h-10 items-center gap-1.5 rounded-xl bg-gold px-5 text-sm font-semibold text-black transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("prompts.compose.save")}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
