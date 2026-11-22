import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDownToLine, ChevronDown, Copy, ExternalLink, Loader2, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { lookupHfRepo, parseHfRepo, recommendedQuant, type GgufQuant, type HfLookup } from "./hf-gguf";

/**
 * Paste a Hugging Face link, get one line to copy. Original-weight repos
 * (what labs publish) list the community GGUF conversions instead.
 */
export function LocalModelHf({ onCopy }: { onCopy: (text: string) => void }) {
  const { t } = useTranslation("profile");
  const k = (key: string, opts?: Record<string, unknown>) => String(t(`localModel.hf.${key}` as never, opts as never));
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<HfLookup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showOthers, setShowOthers] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const lookup = async (raw: string) => {
    const repo = parseHfRepo(raw);
    setResult(null);
    setShowOthers(false);
    if (!repo) { setError(k("badInput")); return; }
    setError(null);
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    try {
      setResult(await lookupHfRepo(repo, ctrl.signal));
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError(k("failed"));
    } finally {
      if (abortRef.current === ctrl) setLoading(false);
    }
  };

  const pick = (repo: string) => {
    setInput(repo);
    void lookup(repo);
  };

  const quants = result?.kind === "quants" ? result.quants : [];
  const recName = recommendedQuant(quants);
  const rec = quants.find((q) => q.quant === recName);
  const others = quants.filter((q) => q !== rec);

  return (
    <div className="mt-3 border-t border-white/[0.06] pt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 text-left"
      >
        <span className="text-[12px] font-semibold text-main">{k("title")}</span>
        <ChevronDown className={cn("ml-auto h-4 w-4 text-sub/50 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="mt-3 space-y-2.5 text-[11px]">
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void lookup(input); }}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={k("placeholder")}
              spellCheck={false}
              className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 text-[11px] text-main placeholder:text-sub/35 focus:border-white/25 focus:outline-none"
            />
            <button
              type="submit"
              disabled={loading || !input.trim()}
              aria-label={k("check")}
              title={k("check")}
              className="inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-sub hover:border-white/20 hover:text-main disabled:opacity-40"
            >
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
            </button>
            <a
              href="https://huggingface.co/models?library=gguf&sort=trending"
              target="_blank"
              rel="noreferrer"
              aria-label={k("browse")}
              title={k("browse")}
              className="inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-sub hover:border-white/20 hover:text-main"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </form>

          {error && <p className="px-1 text-amber-200/80">{error}</p>}
          {result?.kind === "notFound" && <p className="px-1 text-amber-200/80">{k("notFound")}</p>}
          {result?.kind === "noGguf" && <p className="px-1 text-amber-200/80">{k("noGguf")}</p>}

          {result?.kind === "alternatives" && (
            <div className="space-y-0.5">
              <p className="px-1 pb-1 text-sub/50">{k("alternatives")}</p>
              {result.repos.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => pick(r.id)}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sub/80 hover:bg-white/[0.04] hover:text-main"
                >
                  <span className="min-w-0 flex-1 truncate">{r.id}</span>
                  <span className="inline-flex shrink-0 items-center gap-0.5 tabular-nums text-sub/40">
                    <ArrowDownToLine className="h-3 w-3" />
                    {r.downloads.toLocaleString()}
                  </span>
                </button>
              ))}
            </div>
          )}

          {rec && (
            <div className="space-y-1.5">
              <QuantRow q={rec} badge={k("recommended")} vram={k("vram", { gb: rec.vramGb })} copyLabel={k("copy")} onCopy={onCopy} primary />
              {others.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowOthers((v) => !v)}
                  className="inline-flex items-center gap-1 px-1 text-sub/50 hover:text-sub"
                >
                  {k("others", { n: others.length })}
                  <ChevronDown className={cn("h-3 w-3 transition-transform", showOthers && "rotate-180")} />
                </button>
              )}
              {showOthers && (
                <div>
                  {others.map((q) => (
                    <QuantRow key={q.quant} q={q} vram={k("vram", { gb: q.vramGb })} copyLabel={k("copy")} onCopy={onCopy} />
                  ))}
                </div>
              )}
              <p className="px-1 text-sub/40">{k("after")}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function QuantRow({ q, badge, vram, copyLabel, onCopy, primary = false }: {
  q: GgufQuant;
  badge?: string;
  vram: string;
  copyLabel: string;
  onCopy: (text: string) => void;
  primary?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-lg px-2.5",
        primary ? "border border-emerald-400/20 bg-emerald-400/[0.06] py-2" : "py-1 hover:bg-white/[0.03]",
      )}
    >
      <span className={cn("font-mono", primary ? "text-[12px] text-main" : "text-sub/80")}>{q.quant}</span>
      {badge && <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300">{badge}</span>}
      <span className="ml-auto shrink-0 tabular-nums text-sub/45">{(q.bytes / 1e9).toFixed(1)} GB · {vram}</span>
      <button
        type="button"
        onClick={() => onCopy(q.command)}
        title={q.command}
        aria-label={copyLabel}
        className={cn(
          "inline-flex shrink-0 items-center gap-1 rounded-md",
          primary
            ? "bg-emerald-500/90 px-2.5 py-1 text-[11px] font-semibold text-black hover:bg-emerald-400"
            : "p-1 text-sub/50 hover:text-main",
        )}
      >
        <Copy className="h-3 w-3" />
        {primary && copyLabel}
      </button>
    </div>
  );
}
