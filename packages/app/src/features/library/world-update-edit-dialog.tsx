import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { MAX_WORLD_UPDATE_CONTENT, MAX_WORLD_UPDATE_TITLE } from "@yumina/shared";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createWorldUpdate, saveWorldUpdate, type WorldUpdateItem } from "./world-update-history-data";

interface UpdateDialogCallbacks {
  trigger: HTMLButtonElement;
  onClose: () => void;
  onSaved: (update: WorldUpdateItem) => void;
}

type EditDialogProps = UpdateDialogCallbacks & { update: WorldUpdateItem };
type CreateDialogProps = UpdateDialogCallbacks & { worldId: string; canNotify: boolean };

export function WorldUpdateEditDialog(props: EditDialogProps) {
  return <WorldUpdateDialog {...props} mode="edit" />;
}

export function WorldUpdateCreateDialog(props: CreateDialogProps) {
  return <WorldUpdateDialog {...props} mode="create" />;
}

function WorldUpdateDialog(props: (EditDialogProps & { mode: "edit" }) | (CreateDialogProps & { mode: "create" })) {
  const { trigger, onClose, onSaved } = props;
  const creating = props.mode === "create";
  const update = props.mode === "edit" ? props.update : null;
  const worldId = props.mode === "create" ? props.worldId : props.update.worldId;
  const { t } = useTranslation("library");
  const id = useId();
  const titleRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef<AbortController | null>(null);
  const [title, setTitle] = useState(update?.title ?? "");
  const [content, setContent] = useState(update?.content ?? "");
  const [isMajor, setIsMajor] = useState(false);
  const [notifyPlayers, setNotifyPlayers] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<"required" | "save" | null>(null);

  useEffect(() => () => requestRef.current?.abort(), []);

  const close = () => {
    if (!requestRef.current) onClose();
  };

  const save = async () => {
    if (requestRef.current || !worldId) return;
    if (!title.trim()) {
      setError("required");
      titleRef.current?.focus();
      return;
    }
    const controller = new AbortController();
    requestRef.current = controller;
    setSaving(true);
    setError(null);
    try {
      const fields = {
        worldId,
        title,
        content,
        signal: controller.signal,
      };
      const saved = props.mode === "create"
        ? await createWorldUpdate({ ...fields, isMajor, notifyPlayers: props.canNotify && notifyPlayers })
        : await saveWorldUpdate({ ...fields, updateId: props.update.id });
      if (!controller.signal.aborted) onSaved(saved);
    } catch {
      if (!controller.signal.aborted) setError("save");
    } finally {
      if (!controller.signal.aborted) {
        requestRef.current = null;
        setSaving(false);
      }
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] max-w-md overflow-y-auto rounded-2xl p-5 sm:rounded-2xl"
        aria-describedby={undefined}
        onKeyDown={(event) => {
          if (!event.ctrlKey && !event.metaKey) return;
          const key = event.key.toLowerCase();
          if (key === "z" || key === "y") {
            // Keep native text undo/redo inside the dialog, away from the
            // editor's global shortcuts that mutate the work itself.
            event.stopPropagation();
          } else if (key === "s") {
            event.preventDefault();
            event.stopPropagation();
            void save();
          }
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (trigger.isConnected) trigger.focus();
        }}
        onEscapeKeyDown={(event) => { if (requestRef.current) event.preventDefault(); }}
        onInteractOutside={(event) => { if (requestRef.current) event.preventDefault(); }}
      >
        <DialogHeader className="text-left">
          <DialogTitle className="pr-6 text-base">{t(creating ? "detail.createUpdateTitle" : "detail.editUpdateTitle")}</DialogTitle>
        </DialogHeader>
        <form
          noValidate
          aria-busy={saving}
          onSubmit={(event) => { event.preventDefault(); void save(); }}
          className="space-y-4"
        >
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3 text-sm">
              <label htmlFor={`${id}-title`}>{t("detail.updateTitleLabel")}</label>
              <span className="text-xs tabular-nums text-muted-foreground" aria-hidden="true">
                {title.length}/{MAX_WORLD_UPDATE_TITLE}
              </span>
            </div>
            <Input
              ref={titleRef}
              id={`${id}-title`}
              value={title}
              onChange={(event) => { setTitle(event.target.value); setError(null); }}
              maxLength={MAX_WORLD_UPDATE_TITLE}
              required
              disabled={saving}
              aria-invalid={error === "required" || undefined}
              aria-describedby={error === "required" ? `${id}-error` : undefined}
              className="h-11 rounded-lg text-base"
            />
          </div>
          <div className="space-y-2">
            <label htmlFor={`${id}-content`} className="block text-sm">{t("detail.updateContentLabel")}</label>
            <textarea
              id={`${id}-content`}
              value={content}
              onChange={(event) => { setContent(event.target.value); setError(null); }}
              maxLength={MAX_WORLD_UPDATE_CONTENT}
              rows={4}
              disabled={saving}
              placeholder={t("detail.updateContentPlaceholder")}
              className="block min-h-28 w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-base leading-relaxed placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50"
            />
          </div>
          {props.mode === "create" && (
            <div className="space-y-2">
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input type="checkbox" checked={isMajor} onChange={(event) => setIsMajor(event.target.checked)} disabled={saving} className="h-4 w-4 shrink-0 accent-primary" />
                {t("detail.updateMajorLabel")}
              </label>
              {props.canNotify ? (
                <label className="flex min-h-11 items-center gap-2 text-sm">
                  <input type="checkbox" checked={notifyPlayers} onChange={(event) => setNotifyPlayers(event.target.checked)} disabled={saving} className="h-4 w-4 shrink-0 accent-primary" />
                  {t("detail.updateNotifyPlayers")}
                </label>
              ) : (
                <p className="text-sm text-muted-foreground">{t("detail.updateNotifyAfterPublish")}</p>
              )}
            </div>
          )}
          {error && (
            <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
              {t(error === "required" ? "detail.updateTitleRequired" : creating ? "detail.updateCreateError" : "detail.updateSaveError")}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" onClick={close} disabled={saving} className="min-h-11 rounded-lg">
              {t("detail.updateCancel")}
            </Button>
            <Button type="submit" disabled={saving} className="min-h-11 rounded-lg">
              {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {t(creating ? saving ? "detail.updateAdding" : "detail.updateAdd" : saving ? "detail.updateSaving" : "detail.updateSave")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
