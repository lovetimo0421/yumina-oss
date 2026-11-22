import { useLayoutEffect, useRef, useState } from "react";
import { create } from "zustand";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

interface ConfirmRequest {
  description: string;
  title?: string;
  confirmLabel?: string;
  tone?: "destructive" | "warning";
  /** See ConfirmDialog.armDelayMs: for asks a page outside Yumina can trigger. */
  armDelayMs?: number;
  option?: { label: string; defaultChecked?: boolean };
}

export interface ConfirmChoice {
  confirmed: boolean;
  /** The option checkbox's state when confirmed (false when declined). */
  option: boolean;
}

interface ConfirmState {
  request: ConfirmRequest | null;
  /** Bumped per request: a request replaced under an open dialog re-arms it. */
  requestId: number;
  resolve: ((value: ConfirmChoice) => void) | null;
}

const useGlobalConfirmStore = create<ConfirmState>(() => ({
  request: null,
  requestId: 0,
  resolve: null,
}));

export function confirmChoice(
  description: string,
  options: Omit<ConfirmRequest, "description"> = {},
): Promise<ConfirmChoice> {
  return new Promise((resolve) => {
    const previous = useGlobalConfirmStore.getState().resolve;
    previous?.({ confirmed: false, option: false });
    useGlobalConfirmStore.setState((state) => ({
      request: { description, ...options },
      requestId: state.requestId + 1,
      resolve,
    }));
  });
}

export function confirmAction(
  description: string,
  options: Omit<ConfirmRequest, "description" | "option"> = {},
): Promise<boolean> {
  return confirmChoice(description, options).then((choice) => choice.confirmed);
}

export function GlobalConfirmDialog() {
  const { t } = useTranslation();
  const request = useGlobalConfirmStore((state) => state.request);
  const requestId = useGlobalConfirmStore((state) => state.requestId);
  const [optionChecked, setOptionChecked] = useState(false);
  // The option starts at its default when the dialog opens; a request replacing
  // an open one keeps what the player set (it must not re-tick it).
  const wasOpen = useRef(false);
  useLayoutEffect(() => {
    if (request && !wasOpen.current) setOptionChecked(request.option?.defaultChecked === true);
    wasOpen.current = request !== null;
  }, [request]);

  const settle = (confirmed: boolean) => {
    const resolve = useGlobalConfirmStore.getState().resolve;
    useGlobalConfirmStore.setState({ request: null, resolve: null });
    resolve?.({ confirmed, option: confirmed && optionChecked });
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
      armDelayMs={request?.armDelayMs}
      armKey={requestId}
      option={request?.option ? { label: request.option.label, checked: optionChecked, onCheckedChange: setOptionChecked } : undefined}
    />
  );
}
