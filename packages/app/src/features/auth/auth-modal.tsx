import { Link } from "@tanstack/react-router";
import { LogIn, UserPlus } from "lucide-react";
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAuthModalStore } from "@/stores/auth-modal";

export function AuthModal() {
  const { t } = useTranslation();
  const { isOpen, contextMessage, close } = useAuthModalStore();
  const returnFocusRef = useRef<HTMLElement | null>(null);

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && close()}>
      <DialogContent
        className="z-[10001] max-w-sm gap-0 overflow-hidden p-0"
        overlayClassName="z-[10000]"
        onOpenAutoFocus={() => {
          const activeElement = document.activeElement;
          returnFocusRef.current =
            activeElement instanceof HTMLElement && activeElement !== document.body
              ? activeElement
              : null;
        }}
        onCloseAutoFocus={(event) => {
          // Invariant: requireAuth() must only be wired to click/submit events,
          // never onFocus — this refocus would re-trigger a focus-gated opener
          // and trap guests in an open/close loop.
          event.preventDefault();
          const returnTarget = returnFocusRef.current;
          returnFocusRef.current = null;
          if (returnTarget?.isConnected && returnTarget.getClientRects().length > 0) {
            returnTarget.focus();
            return;
          }

          const visibleNavTrigger = Array.from(
            document.querySelectorAll<HTMLElement>(
              '[data-mobile-nav-trigger], [aria-label="Open navigation"]'
            )
          ).find((target) => target.getClientRects().length > 0);
          visibleNavTrigger?.focus();
        }}
      >
        <div className="relative px-6 pb-4 pt-6 text-center">
          <div
            className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-primary/10"
            style={{ boxShadow: "0 0 30px rgba(225, 138, 36, 0.2)" }}
          >
            <LogIn className="h-7 w-7 text-primary" />
          </div>

          <DialogTitle className="text-xl font-black tracking-tight text-foreground">
            {t("auth.signInToContinue")}
          </DialogTitle>
          <DialogDescription className="mt-2 text-sm text-muted-foreground">
            {t("auth.needAccount", { action: contextMessage || t("auth.useThisFeature") })}
          </DialogDescription>
        </div>

        <div className="space-y-3 px-6 pb-6">
          <Link
            to="/login"
            onClick={close}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary py-3 text-sm font-bold text-primary-foreground transition-opacity hover:opacity-90"
          >
            <LogIn className="h-4 w-4" />
            {t("auth.signIn")}
          </Link>
          <Link
            to="/register"
            onClick={close}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-[#1A1A1C] py-3 text-sm font-bold text-foreground transition-colors hover:bg-white/10"
          >
            <UserPlus className="h-4 w-4" />
            {t("auth.createAccount")}
          </Link>
        </div>
      </DialogContent>
    </Dialog>
  );
}
