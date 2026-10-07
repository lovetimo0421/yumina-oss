import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, ChevronDown, Minus, Pencil, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { isSwatchColor, summarizeUiDocChange, themeTokenLabel, type ReviewPart, type UiDocChangeItem } from "./change-review";

type Translate = (key: string | string[], opts?: Record<string, unknown>) => string;

function Swatch({ value }: { value?: string }) {
  if (!value) return <span className="inline-block h-4 w-4 rounded border border-dashed border-border" />;
  return isSwatchColor(value)
    ? <span className="inline-block h-4 w-4 shrink-0 rounded border border-border/70" style={{ background: value }} title={value} />
    : <span className="max-w-[10rem] truncate font-mono text-[11px] text-muted-foreground">{value}</span>;
}

function ItemRow({ item, t }: { item: UiDocChangeItem; t: Translate }) {
  const icon = item.kind.endsWith("added") ? <Plus className="h-3.5 w-3.5 text-emerald-400" />
    : item.kind.endsWith("removed") ? <Minus className="h-3.5 w-3.5 text-orange-300" />
    : <Pencil className="h-3.5 w-3.5 text-sky-300" />;
  let body: ReactNode;
  switch (item.kind) {
    case "page-added": body = t("studio.review.pageAdded", { name: item.name }); break;
    case "page-removed": body = t("studio.review.pageRemoved", { name: item.name }); break;
    case "page-renamed": body = t("studio.review.pageRenamed", { from: item.from, to: item.to }); break;
    case "part-added":
    case "part-removed":
      body = (
        <>
          <span>{t(item.kind === "part-added" ? "studio.review.partAdded" : "studio.review.partRemoved", { name: item.name })}</span>
          {item.text && <span className="ml-1 text-muted-foreground">「{item.text}」</span>}
        </>
      );
      break;
    case "part-changed":
      body = (
        <div className="min-w-0 space-y-1">
          <div>
            {t("studio.review.partChanged", { name: item.name })}
            {item.aspects.length > 0 && (
              <span className="ml-1 text-muted-foreground">
                · {item.aspects.map((a) => t(`studio.review.aspect.${a}`)).join("、")}
              </span>
            )}
          </div>
          {(item.textBefore !== undefined || item.textAfter !== undefined) && (
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="rounded bg-orange-300/15 px-1.5 py-0.5 text-orange-200 line-through decoration-orange-300/60">{item.textBefore || "—"}</span>
              <ArrowRight className="h-3 w-3 text-muted-foreground" />
              <span className="rounded bg-emerald-400/15 px-1.5 py-0.5 text-emerald-200">{item.textAfter || "—"}</span>
            </div>
          )}
        </div>
      );
      break;
    case "theme-preset":
      body = t("studio.review.themePreset", {
        from: item.from ? t(`studio.theme.preset.${item.from}`, { defaultValue: item.from }) : t("studio.review.none"),
        to: item.to ? t(`studio.theme.preset.${item.to}`, { defaultValue: item.to }) : t("studio.review.none"),
      });
      break;
    case "theme-font": body = t("studio.review.themeFont"); break;
    case "theme-token":
      body = (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span>{themeTokenLabel(item.token, t)}</span>
          <Swatch value={item.before} />
          <ArrowRight className="h-3 w-3 text-muted-foreground" />
          <Swatch value={item.after} />
        </div>
      );
      break;
  }
  return (
    <li className="flex items-start gap-2 rounded-lg px-2 py-1.5 text-sm text-foreground">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">{body}</div>
    </li>
  );
}

/**
 * The body of the 「对比」 view. An interface change reads as a list of what
 * happened to which part, with colours as swatches; everything else keeps the
 * text diff. The raw data is behind 「查看原始数据」 either way for interface
 * changes, where it is noise to most creators.
 */
export function ChangeReviewBody({
  parts,
  original,
  changed,
  renderDiff,
}: {
  parts?: ReviewPart[];
  original: string;
  changed: string;
  renderDiff: (original: string, changed: string) => ReactNode;
}) {
  const { t } = useTranslation("editor");
  const tr = t as unknown as Translate;
  const [showRaw, setShowRaw] = useState(false);
  const uiParts = parts?.filter((p) => p.uiDoc) ?? [];
  if (uiParts.length === 0) return <>{renderDiff(original, changed)}</>;
  const kindName = (type: string) => tr([`studio.element.kind.${type}`, `studio.parts.kind.${type}`], { defaultValue: tr("studio.review.aPart") });
  const items = uiParts.flatMap((p) => summarizeUiDocChange(p.uiDoc!.before, p.uiDoc!.after, kindName));
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-3 overflow-auto">
      <div className="rounded-xl border border-border/70 bg-background p-2">
        {items.length === 0
          ? <p className="px-2 py-3 text-sm text-muted-foreground">{tr("studio.review.noVisibleChange")}</p>
          : <ul className="space-y-0.5">{items.map((item, i) => <ItemRow key={i} item={item} t={tr} />)}</ul>}
      </div>
      <button
        type="button"
        onClick={() => setShowRaw((v) => !v)}
        className="inline-flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground"
        aria-expanded={showRaw}
      >
        <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", showRaw && "rotate-180")} />
        {tr(showRaw ? "studio.review.hideRaw" : "studio.review.showRaw")}
      </button>
      {showRaw && <div className="flex min-h-[240px] flex-1 flex-col">{renderDiff(original, changed)}</div>}
    </div>
  );
}
