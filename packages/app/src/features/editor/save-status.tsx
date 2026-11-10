import { useEffect, useState, type ButtonHTMLAttributes } from "react";
import { useTranslation } from "react-i18next";
import { Check, CloudOff, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useEditorStore } from "@/stores/editor";
import { flushPendingEditorFields } from "./components/debounced-field";

function useOnline(): boolean {
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine !== false);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}

export type SaveState = "saving" | "unsaved" | "offline" | "saved";

export function useSaveState(): SaveState {
  const saving = useEditorStore((s) => s.saving);
  const dirty = useEditorStore((s) => s.isDirty || s.layoutDirty);
  const online = useOnline();
  if (saving) return "saving";
  if (dirty && !online) return "offline";
  return dirty ? "unsaved" : "saved";
}

/**
 * Where the gold Save button used to be: a status, the way a Google doc says
 * 「已保存到云端」. Edits save themselves a few seconds after the creator
 * pauses, so this reads 已保存 almost all the time, 保存中… while a request is
 * out, and 离线 when there is no network (the edits wait on this device).
 * In the moment between an edit and its autosave it says 保存 and a tap
 * saves right away — for someone about to close the lid.
 */
export function SaveStatus({ onSave, size = "sm", iconOnly = false, className, ...rest }: {
  /** The editor's own save (it may do more than the store's, e.g. a toast). */
  onSave?: () => void;
  size?: "sm" | "md";
  /** The mark alone (✓ / spinner / dot), the words for screen readers: a
   *  phone's single header row. */
  iconOnly?: boolean;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "children" | "disabled" | "title">) {
  const { t } = useTranslation("editor");
  const state = useSaveState();
  const icon = size === "md" ? "h-3.5 w-3.5" : "h-3 w-3";
  const label = state === "saving" ? t("shell.saving") : state === "offline" ? t("shell.offline") : state === "unsaved" ? t("shell.save") : t("shell.saved");
  const title = state === "offline" ? t("shell.offlineTitle") : t("shell.autosaveTitle");
  const save = () => {
    if (onSave) { onSave(); return; }
    flushPendingEditorFields();
    void useEditorStore.getState().saveDraft();
  };
  return (
    <button
      type="button"
      {...rest}
      data-save-state={state}
      onClick={save}
      disabled={state !== "unsaved" && state !== "offline"}
      title={title}
      aria-live="polite"
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg font-medium transition-colors disabled:cursor-default",
        size === "md" ? "h-9 px-2.5 text-sm" : "h-8 px-2 text-xs",
        iconOnly && "w-8 justify-center px-0",
        state === "unsaved" && "text-foreground hover:bg-accent",
        state === "offline" && "text-amber-300 hover:bg-amber-400/10",
        (state === "saved" || state === "saving") && "text-muted-foreground",
        className,
      )}
    >
      {state === "saving" ? <Loader2 className={cn(icon, "animate-spin")} />
        : state === "offline" ? <CloudOff className={icon} />
        : state === "unsaved" ? <span className="mx-[3px] h-1.5 w-1.5 rounded-full bg-amber-400" />
        : <Check className={icon} />}
      <span className={cn(iconOnly && "sr-only")}>{label}</span>
    </button>
  );
}

/**
 * Save the moment the page goes to the background — a phone switching apps,
 * a laptop closing, a tab being left — instead of waiting out the idle
 * timer. A Google doc does the same; the timer would otherwise leave the
 * last few seconds of typing on this device only.
 */
export function useSaveWhenHidden(worldId: string) {
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState !== "hidden") return;
      const s = useEditorStore.getState();
      if (s.serverWorldId !== worldId || s.guestMode || s.readOnlyInspect || s.saving) return;
      if (!s.isDirty && !s.layoutDirty) return;
      flushPendingEditorFields();
      void s.saveDraft();
    };
    document.addEventListener("visibilitychange", onHidden);
    return () => document.removeEventListener("visibilitychange", onHidden);
  }, [worldId]);
}
