import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Megaphone, X } from "lucide-react";
import { FieldError } from "@/components/ui/field-error";
import { MAX_WORLD_UPDATE_CONTENT, MAX_WORLD_UPDATE_TITLE } from "@yumina/shared";
import { postWorldUpdateNote } from "./world-update-note";

interface UpdateNotifyDialogProps {
  worldId: string;
  worldName: string;
  onClose: () => void;
  /**
   * True when this save was HELD for re-review (material change to a published
   * card). The note is then parked on the held edit and posted to players only
   * when an admin approves it — instead of being posted to players right away.
   */
  held?: boolean;
}

export function UpdateNotifyDialog({ worldId, worldName, onClose, held = false }: UpdateNotifyDialogProps) {
  const { t } = useTranslation("editor");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [isMajor, setIsMajor] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleNotify = async () => {
    if (!title.trim()) return;
    setSending(true);
    setError(null);
    try {
      const apiBase = import.meta.env.VITE_API_URL || "";
      await postWorldUpdateNote({
        worldId,
        title,
        content,
        isMajor,
        held,
        apiBase,
      });
      onClose();
    } catch {
      setError(t("updateNotify.failed"));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-xl border border-zinc-700/50 bg-zinc-900 p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Megaphone className="h-5 w-5 text-blue-400" />
            <h3 className="text-lg font-semibold text-zinc-100">{t("updateNotify.title")}</h3>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 transition-colors">
            <X className="h-5 w-5" />
          </button>
        </div>

        {held && (
          <p className="text-sm text-zinc-400 mb-4">
            {t("updateNotify.heldDescription", { worldName, defaultValue: "These changes need review. Write a note for your players — it'll be posted when your update is approved and goes live." })}
          </p>
        )}

        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t("updateNotify.placeholder")}
          aria-label={t("updateNotify.placeholder")}
          maxLength={MAX_WORLD_UPDATE_TITLE}
          className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />

        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder={t("updateNotify.detailsPlaceholder")}
          aria-label={t("updateNotify.detailsPlaceholder")}
          maxLength={MAX_WORLD_UPDATE_CONTENT}
          rows={4}
          disabled={sending}
          className="mt-3 w-full resize-none rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />

        <label className="mt-3 flex items-center gap-2 text-sm text-zinc-400 cursor-pointer">
          <input
            type="checkbox"
            checked={isMajor}
            onChange={(e) => setIsMajor(e.target.checked)}
            disabled={sending}
            className="rounded border-zinc-600 bg-zinc-800 text-blue-500 focus:ring-blue-500"
          />
          {t("updateNotify.majorUpdate")}
        </label>

        <FieldError id="update-notify-error" message={error} />

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            {t("updateNotify.skip")}
          </button>
          <button
            onClick={handleNotify}
            disabled={!title.trim() || sending}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {sending
              ? t("updateNotify.sending")
              : held
                ? t("updateNotify.heldNotify", { defaultValue: "Save note for players" })
                : t("updateNotify.notify")}
          </button>
        </div>
      </div>
    </div>
  );
}
