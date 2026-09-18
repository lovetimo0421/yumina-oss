import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface UnsavedChangesDialogProps {
  blocker: { status: string; proceed?: () => void; reset?: () => void };
}

export function UnsavedChangesDialog({ blocker }: UnsavedChangesDialogProps) {
  const { t } = useTranslation("editor");

  if (blocker.status !== "blocked") return null;

  return (
    <Dialog open onOpenChange={() => blocker.reset?.()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("unsavedDialog.title")}</DialogTitle>
          <DialogDescription>{t("unsavedDialog.description")}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-0">
          <button
            type="button"
            onClick={() => blocker.reset?.()}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            {t("unsavedDialog.stay")}
          </button>
          <button
            type="button"
            onClick={() => blocker.proceed?.()}
            className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {t("unsavedDialog.leave")}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
