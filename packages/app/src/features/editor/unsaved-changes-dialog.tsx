import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useEditorStore } from "@/stores/editor";
import { flushPendingEditorFields } from "./components/debounced-field";

interface UnsavedChangesDialogProps {
  blocker: {
    status: string;
    proceed?: () => void;
    reset?: () => void;
    current?: { pathname: string };
    next?: { pathname: string };
  };
}

// The classic editor and the canvas are two routes for the same card, so the
// 画布 pill is a navigation the leave guard catches like any other. The
// creator is changing view, not leaving — the dialog should say so.
const CLASSIC_PATH = /\/worlds\/([^/]+)\/edit\/?$/;
const VISUAL_PATH = /\/studio\/([^/]+)\/?$/;
function isEditorSwitch(from?: string, to?: string): boolean {
  if (!from || !to) return false;
  const a = from.match(CLASSIC_PATH) ?? from.match(VISUAL_PATH);
  const b = to.match(CLASSIC_PATH) ?? to.match(VISUAL_PATH);
  if (!a || !b || a[1] !== b[1]) return false;
  return CLASSIC_PATH.test(from) !== CLASSIC_PATH.test(to);
}

/**
 * Leaving with unsaved changes, the way a Google doc does it: a card that is
 * already saved somewhere is saved on the way out, with a small 「正在保存…」
 * and no question (owner, 10/18: the three-button dialog over a blurred
 * screen was the ugliest moment of leaving). Only a save that fails asks,
 * and then it says the save failed. A card never saved yet still asks:
 * saving it on the way out would make a card the creator may be abandoning.
 */
export function UnsavedChangesDialog({ blocker }: UnsavedChangesDialogProps) {
  const { t } = useTranslation("editor");
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const saved = useEditorStore((s) => Boolean(s.serverWorldId));
  const blocked = blocker.status === "blocked";
  const started = useRef(false);

  // The choice most people want: keep the work AND go. The navigation only
  // goes through once the save has landed clean — a failed save leaves them
  // here, with the store's own failure pill saying why.
  const saveAndLeave = async () => {
    if (saving) return;
    setSaving(true);
    setFailed(false);
    try {
      flushPendingEditorFields();
      const ok = await useEditorStore.getState().saveDraft();
      const after = useEditorStore.getState();
      if (ok && !after.isDirty && !after.layoutDirty) blocker.proceed?.();
      else setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    if (!blocked) { started.current = false; setFailed(false); return; }
    if (saved && !started.current) {
      started.current = true;
      void saveAndLeave();
    }
    // saveAndLeave reads the blocker it is handed this render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocked, saved]);

  if (!blocked) return null;

  // "Your changes will be lost" has to be true: the recovery copy the guard
  // left behind is dropped too, or the next open offers the very changes the
  // creator just threw away.
  const leaveWithoutSaving = () => {
    if (saving) return;
    useEditorStore.getState().discardUnsavedChanges();
    blocker.proceed?.();
  };

  if (saved && !failed) {
    return (
      <div
        role="status"
        data-leave-saving=""
        className="pointer-events-none fixed left-1/2 top-3 z-[100] inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-popover/95 px-3 py-1.5 text-xs text-foreground/80 shadow-lg"
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t("unsavedDialog.saving")}
      </div>
    );
  }

  const switching = isEditorSwitch(blocker.current?.pathname, blocker.next?.pathname);
  const copy = failed
    ? {
      title: t("unsavedDialog.failedTitle"),
      description: t("unsavedDialog.failedDescription"),
      stay: t("unsavedDialog.stay"),
      leave: t("unsavedDialog.leave"),
      saveAndLeave: t("unsavedDialog.retry"),
    }
    : switching
    ? {
      title: t("unsavedDialog.switchTitle"),
      description: t("unsavedDialog.switchDescription"),
      stay: t("unsavedDialog.switchCancel"),
      leave: t("unsavedDialog.switchWithoutSaving"),
      saveAndLeave: t("unsavedDialog.saveAndSwitch"),
    }
    : {
      title: t("unsavedDialog.title"),
      description: t("unsavedDialog.description"),
      stay: t("unsavedDialog.stay"),
      leave: t("unsavedDialog.leave"),
      saveAndLeave: t("unsavedDialog.saveAndLeave", "Save and leave"),
    };

  return (
    <Dialog open onOpenChange={() => { if (!saving) blocker.reset?.(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <button
            type="button"
            onClick={() => blocker.reset?.()}
            disabled={saving}
            className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-accent disabled:opacity-50"
          >
            {copy.stay}
          </button>
          <button
            type="button"
            onClick={leaveWithoutSaving}
            disabled={saving}
            className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            {copy.leave}
          </button>
          <button
            type="button"
            onClick={() => void saveAndLeave()}
            disabled={saving}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
          >
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {copy.saveAndLeave}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
