import type { ReactNode } from "react";
import { LockKeyhole } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAuthGuard } from "@/hooks/use-auth-guard";
import { cn } from "@/lib/utils";

interface GuestEditorReadOnlyProps {
  guestMode: boolean;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}

/**
 * Keeps the editor visible to guests while making the editable surface inert.
 * Navigation and auth actions live outside this boundary, so guests can still
 * inspect the editor without accidentally creating a draft that cannot persist.
 */
export function GuestEditorReadOnly({
  guestMode,
  children,
  className,
  contentClassName,
}: GuestEditorReadOnlyProps) {
  const { t } = useTranslation("common");
  const { requireAuth } = useAuthGuard();
  const message = t("auth.needAccount", {
    action: t("auth.actions.createWorlds"),
  });

  return (
    <div className={cn("relative flex min-h-0 flex-col", className)}>
      {guestMode && (
        <div
          role="region"
          aria-label={message}
          className="sticky top-0 z-30 flex shrink-0 items-center gap-3 border-b border-amber-400/20 bg-amber-400/10 px-3 py-2 backdrop-blur"
        >
          <LockKeyhole aria-hidden="true" className="h-4 w-4 shrink-0 text-amber-300" />
          <span aria-live="polite" className="min-w-0 flex-1 text-sm font-medium text-foreground">
            {message}
          </span>
          <button
            type="button"
            onClick={() => requireAuth("create worlds")}
            className="inline-flex min-h-11 shrink-0 items-center rounded-lg bg-gold px-4 text-sm font-semibold text-black transition-[filter] hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/70 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            {t("auth.signIn")}
          </button>
        </div>
      )}

      <div
        inert={guestMode ? true : undefined}
        aria-readonly={guestMode || undefined}
        className={cn(
          "min-h-0 flex-1",
          guestMode && "cursor-not-allowed",
          contentClassName,
        )}
      >
        {children}
      </div>
    </div>
  );
}
