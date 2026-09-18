import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { AccountDeletionConfirmPage } from "@/features/settings/account-deletion-confirm-page";

export const Route = createFileRoute("/delete-account")({
  component: DeleteAccountRoute,
});

function DeleteAccountRoute() {
  const [token] = useState(() => {
    if (typeof window === "undefined") return "";
    const inMemory = (window as Window & {
      __yuminaAccountDeletionToken?: string;
    }).__yuminaAccountDeletionToken;
    if (inMemory) return inMemory;
    try {
      return window.sessionStorage.getItem("yumina-account-deletion-token") ?? "";
    } catch {
      return "";
    }
  });
  return (
    <main
      className="h-[100dvh] w-full touch-pan-y overflow-x-hidden overflow-y-auto overscroll-y-contain"
      style={{ WebkitOverflowScrolling: "touch" }}
    >
      <AccountDeletionConfirmPage token={token} />
      <div aria-hidden="true" className="h-[env(safe-area-inset-bottom)]" />
    </main>
  );
}
