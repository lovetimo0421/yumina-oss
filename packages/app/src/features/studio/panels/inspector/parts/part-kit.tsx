import { Suspense, createContext, lazy, useContext, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { ImagePlus, X } from "lucide-react";
import type { UiImageSrc, Variable } from "@yumina/engine";
import { cn } from "@/lib/utils";
import { resolveImageUrl } from "@/lib/asset-url";

// Loaded when first opened: the picker pulls in the asset stores, which the
// part editors have no other reason to load.
const AssetPicker = lazy(() => import("@/features/editor/asset-picker").then((m) => ({ default: m.AssetPicker })));
import { idsToNames, namesToIds } from "./variable-text";

/**
 * The controls every part editor is built from. Same look as the rest of the
 * element panel (element-panel.tsx / element-behavior.tsx) — a section per
 * question, 11px labels, the small field style — so the new parts read as
 * more of the same panel rather than a second tool bolted on.
 */

export const fieldCls = "w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none focus:border-primary";
export const smallCls = "w-full rounded border border-border bg-background px-1.5 py-1 text-[11px] outline-none focus:border-primary";

export function Section({ label, hint, children, testId }: { label: string; hint?: string; children: ReactNode; testId?: string }) {
  return (
    <div className="border-b border-border/50 px-3 py-2.5" data-testid={testId}>
      <span className="mb-1.5 block text-[11px] font-medium text-muted-foreground">{label}</span>
      {children}
      {hint && <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground/70">{hint}</p>}
    </div>
  );
}

/** A row of mutually exclusive choices — 网格 / 整屏横滑 / 竖排列表. */
export function Segmented<T extends string | number>({
  value, options, onChange, label,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-md border border-border bg-background p-0.5">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            "min-w-0 flex-1 truncate rounded px-1.5 py-1 text-[11px] transition-colors",
            o.value === value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (next: boolean) => void; label: string }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-2 text-xs">
      <span className="text-foreground">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={cn("relative h-4 w-7 shrink-0 rounded-full transition-colors", checked ? "bg-primary" : "bg-muted-foreground/30")}
      >
        <span className={cn("absolute top-0.5 h-3 w-3 rounded-full bg-background shadow transition-all", checked ? "left-3.5" : "left-0.5")} />
      </button>
    </label>
  );
}

export type MakeVariable = (
  base: string,
  type: Variable["type"],
  defaultValue: Variable["defaultValue"],
  extra?: { rule?: (name: string) => string },
) => { id: string; name: string };

/**
 * How a part editor makes a variable. Provided by the panel (index.tsx wires
 * it to the editor store); a context rather than a direct store import so the
 * editors stay plain components a test can mount on their own.
 */
export const MakeVariableContext = createContext<MakeVariable>(() => ({ id: "", name: "" }));

export const useMakeVariable = () => useContext(MakeVariableContext);

/**
 * Keep a part's own variable named after its question while the name is still
 * the editor's. Provided by the panel (the store's `syncAutoVariableName`);
 * a no-op in tests that mount an editor alone.
 */
export type SyncAutoName = (
  variableId: string,
  oldText: string,
  newText: string,
  fallback: string,
  rule?: (name: string) => string,
) => void;
export const AutoNameContext = createContext<SyncAutoName>(() => {});
export const useSyncAutoName = () => useContext(AutoNameContext);

const NEW = "__new__";

/**
 * Which variable a part writes or watches, with 「新建一个变量」 at the bottom —
 * a creator adding a form question should not have to leave the canvas for
 * the 变量 tab and come back.
 */
export function VariableSelect({
  value, variables, types, onChange, newName, newType, newDefault, label, suggestName, rule,
}: {
  value: string;
  variables: Variable[];
  /** The variable types that make sense here; others are not offered. */
  types: Array<Variable["type"]>;
  onChange: (id: string) => void;
  newName: string;
  newType: Variable["type"];
  newDefault: Variable["defaultValue"];
  label: string;
  /** What the name box starts with — the part's question, as a name. */
  suggestName?: string;
  /** The AI-facing rule for the variable, given its final name. */
  rule?: (name: string) => string;
}) {
  const { t } = useTranslation("editor");
  const make = useMakeVariable();
  const offered = variables.filter((v) => types.includes(v.type) && !v.internal);
  const current = variables.find((v) => v.id === value);
  // 「＋新建一个变量」 asks what to call it, in place: a variable the creator
  // will see in the 变量 list and in their behaviours deserves a real name,
  // not 「名字 3」.
  const [naming, setNaming] = useState<string | null>(null);
  const create = () => {
    const name = (naming ?? "").trim() || suggestName?.trim() || newName;
    setNaming(null);
    onChange(make(name, newType, newDefault, rule ? { rule } : undefined).id);
  };
  if (naming !== null) {
    return (
      <div className="flex flex-col gap-1.5" data-testid="new-variable-name">
        <span className="text-[10px] text-muted-foreground">{t("studio.parts.nameVariable")}</span>
        <input
          autoFocus
          value={naming}
          aria-label={t("studio.parts.nameVariable")}
          onChange={(e) => setNaming(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); create(); }
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setNaming(null); }
          }}
          className={fieldCls}
        />
        <div className="flex justify-end gap-1.5">
          <button type="button" onClick={() => setNaming(null)} className="rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground">
            {t("studio.parts.cancelVariable")}
          </button>
          <button type="button" onClick={create} className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-semibold text-primary-foreground hover:bg-primary/90">
            {t("studio.parts.createVariable")}
          </button>
        </div>
      </div>
    );
  }
  return (
    <select
      value={value || ""}
      aria-label={label}
      onChange={(e) => {
        if (e.target.value === NEW) {
          setNaming(suggestName?.trim() || newName);
          return;
        }
        onChange(e.target.value);
      }}
      className={fieldCls}
    >
      {!value && <option value="">{t("studio.parts.noVariable")}</option>}
      {value && !offered.some((v) => v.id === value) && <option value={value}>{current?.name ?? value}</option>}
      {offered.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
      <option value={NEW}>{t("studio.parts.newVariable")}</option>
    </select>
  );
}

/** An extra thing the insert menu offers besides variables: `{{value}}`,
 *  `{{item.title}}` — the part's own tokens, named in plain words. */
export interface InsertToken { token: string; label: string }

/**
 * A text that may read variables. The document stores `{{id}}`; the box shows
 * `{{名字}}` (see variable-text.ts), and the menu under it drops one in for the
 * creator who does not know the macro exists.
 */
export function NamedText({
  value, onChange, variables, placeholder, rows = 1, tokens = [], label,
}: {
  value: string;
  onChange: (next: string) => void;
  variables: Variable[];
  placeholder?: string;
  rows?: number;
  tokens?: InsertToken[];
  label: string;
}) {
  const { t } = useTranslation("editor");
  // The part's own tokens read as words too: `{{value}}` shows as
  // `{{这个变量的内容}}`. They go through the same exact-inverse translation as
  // variables, so the document keeps `{{value}}`.
  const named = [...variables, ...tokens.map((tk) => ({ id: tk.token, name: tk.label }))];
  const shown = idsToNames(value, named);
  const write = (text: string) => onChange(namesToIds(text, named));
  const visible = variables.filter((v) => !v.internal);
  return (
    <div className="flex flex-col gap-1">
      {rows > 1 ? (
        <textarea rows={rows} aria-label={label} value={shown} placeholder={placeholder} onChange={(e) => write(e.target.value)} className={`${fieldCls} resize-y`} />
      ) : (
        <input aria-label={label} value={shown} placeholder={placeholder} onChange={(e) => write(e.target.value)} className={fieldCls} />
      )}
      {(visible.length > 0 || tokens.length > 0) && (
        <select
          value=""
          aria-label={t("studio.parts.insert")}
          onChange={(e) => {
            const picked = e.target.value;
            if (!picked) return;
            onChange(`${value}{{${picked}}}`);
          }}
          className={`${smallCls} text-muted-foreground`}
        >
          <option value="">{t("studio.parts.insert")}</option>
          {tokens.map((tk) => <option key={tk.token} value={tk.token}>{tk.label}</option>)}
          {visible.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
      )}
    </div>
  );
}

/** A picture from the card's assets, as a thumbnail with 换 / 去掉. */
export function ImageField({
  value, onChange, worldId, compact = false,
}: {
  value: UiImageSrc | string | undefined;
  onChange: (ref: string | undefined) => void;
  worldId?: string | null;
  compact?: boolean;
}) {
  const { t } = useTranslation("editor");
  const [picking, setPicking] = useState(false);
  const ref = typeof value === "string" ? value : value?.kind === "asset" ? value.ref : "";
  const url = ref ? resolveImageUrl(ref) : undefined;
  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        disabled={!worldId}
        title={worldId ? t(ref ? "studio.parts.changeImage" : "studio.parts.pickImage") : t("studio.parts.saveFirst")}
        aria-label={t(ref ? "studio.parts.changeImage" : "studio.parts.pickImage")}
        onClick={() => setPicking(true)}
        className={cn(
          "flex shrink-0 items-center justify-center overflow-hidden rounded border border-dashed border-border bg-background text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground disabled:opacity-40",
          compact ? "h-8 w-8" : "h-12 w-12",
        )}
      >
        {url ? <img src={url} alt="" className="h-full w-full object-cover" /> : <ImagePlus className="h-3.5 w-3.5" />}
      </button>
      {!compact && (
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
          {worldId ? t(ref ? "studio.parts.changeImage" : "studio.parts.pickImage") : t("studio.parts.saveFirst")}
        </span>
      )}
      {ref && (
        <button
          type="button"
          onClick={() => onChange(undefined)}
          title={t("studio.parts.removeImage")}
          aria-label={t("studio.parts.removeImage")}
          className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
        >
          <X className="h-3 w-3" />
        </button>
      )}
      {picking && worldId && createPortal(
        <Suspense fallback={null}>
          <AssetPicker
            worldId={worldId}
            filterType="image"
            onSelect={(picked) => { setPicking(false); onChange(picked); }}
            onClose={() => setPicking(false)}
          />
        </Suspense>,
        document.body,
      )}
    </div>
  );
}
