import { create } from "zustand";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

interface ConfirmRequest {
  description: string;
  title?: string;
  confirmLabel?: string;
  tone?: "destructive" | "warning";
}

interface ConfirmState {
  request: ConfirmRequest | null;
  resolve: ((value: boolean) => void) | null;
}

const useGlobalConfirmStore = create<ConfirmState>(() => ({
  request: null,
  resolve: null,
}));

export function confirmAction(
  description: string,
  options: Omit<ConfirmRequest, "description"> = {},
): Promise<boolean> {
  return new Promise((resolve) => {
    const previous = useGlobalConfirmStore.getState().resolve;
    previous?.(false);
    useGlobalConfirmStore.setState({
      request: { description, ...options },
      resolve,
    });
  });
}

export function GlobalConfirmDialog() {
  const { t } = useTranslation();
  const request = useGlobalConfirmStore((state) => state.request);

  const settle = (value: boolean) => {
    const resolve = useGlobalConfirmStore.getState().resolve;
    useGlobalConfirmStore.setState({ request: null, resolve: null });
    resolve?.(value);
  };

  return (
    <ConfirmDialog
      open={request !== null}
      onOpenChange={(open) => { if (!open) settle(false); }}
      title={request?.title ?? t("action.confirm")}
      description={request?.description}
      confirmLabel={request?.confirmLabel ?? (request?.tone === "destructive" ? t("action.delete") : t("action.confirm"))}
      cancelLabel={t("action.cancel")}
      onConfirm={() => settle(true)}
      tone={request?.tone ?? "warning"}
    />
  );
}
