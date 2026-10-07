import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { memoryPoolMembers, resolveStation, type Worldbook } from "@yumina/engine";
import { useEditorStore } from "@/stores/editor";
import { cn } from "@/lib/utils";

/**
 * Who this AI shares its memory with.
 *
 * It used to be a two-way switch — the whole card, or only itself — and
 * "A and B share one memory, C and D another" had nowhere to go. A pool is a
 * name; every narrator naming it remembers the others' runs. The picker
 * hides the name: you say "with these modules", and the modules you tick
 * take this module's pool. Ticking edits THEIR station, which is the point —
 * sharing is symmetric, and one place must be enough to set it.
 */

/** A pool nobody else is in. NOT the module's deterministic own-pool name:
 *  a pool is named after whoever founded it, so "leave" has to hand the
 *  leaver a name the founder's pool cannot still be using. */
const freshPool = (bookId: string) => `pool-${bookId}-${Math.random().toString(36).slice(2, 7)}`;

const CARD = "space-y-2 rounded-lg border border-border px-2.5 py-2";
const LABEL = "text-[11px] font-semibold text-foreground";
const HINT = "text-[10px] leading-relaxed text-muted-foreground";

export function MemoryPoolPicker({
  book,
  allBooks,
  onChange,
}: {
  book: Worldbook;
  allBooks: Worldbook[];
  onChange: (patch: Partial<Worldbook>) => void;
}) {
  const { t } = useTranslation("editor");
  const updateWorldbook = useEditorStore((s) => s.updateWorldbook);
  const [pendingId, setPendingId] = useState<string | null>(null);
  useEffect(() => setPendingId(null), [book.id, book.station?.memoryPool]);
  const station = book.station;
  if (!station || station.kind !== "narrator") return null;
  const pool = resolveStation(book)?.memoryPool ?? null;
  const others = allBooks.filter((b) => b.id !== book.id && resolveStation(b)?.kind === "narrator");
  const members = memoryPoolMembers(allBooks, pool).filter((b) => b.id !== book.id);
  const pending = others.find(b => b.id === pendingId);
  const formerPool = pending ? resolveStation(pending)?.memoryPool ?? null : null;
  const formerMembers = pending ? memoryPoolMembers(allBooks, formerPool).filter(b => b.id !== pending.id) : [];

  const setSelf = (nextPool: string | null) => {
    // `history` is the old spelling of "own"; it goes when a pool is named,
    // so the two can never disagree.
    const { history: _h, memoryPool: _p, ...rest } = station;
    onChange({ station: { ...rest, ...(nextPool ? { memoryPool: nextPool } : {}) } });
  };
  const setOther = (other: Worldbook, join: boolean) => {
    if (!other.station || !pool) return;
    const { history: _h, memoryPool: _p, ...rest } = other.station;
    updateWorldbook(other.id, {
      station: { ...rest, memoryPool: join ? pool : freshPool(other.id) },
    });
    setPendingId(null);
  };

  return (
    <div className={CARD}>
      <span className={LABEL}>{t("blueprint.station.history")}</span>
      {pool !== null && <p className="rounded-md bg-amber-400/10 px-2 py-2 text-xs leading-relaxed text-amber-200">
        {members.length > 0 ? t("blueprint.workspace.currentGroup", { members: members.map(b => b.name).join("、") }) : t("blueprint.workspace.ownGroup")}
      </p>}
      <div className="flex gap-1">
        {(["card", "own"] as const).map((option) => {
          const on = option === "card" ? pool === null : pool !== null;
          return (
            <button
              key={option}
              type="button"
              onClick={() => setSelf(option === "card" ? null : (pool ?? freshPool(book.id)))}
              className={cn(
                "flex-1 rounded-md px-1.5 py-1 text-[11px] font-medium transition-colors",
                on ? "bg-primary text-primary-foreground" : "border border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {t(`blueprint.station.pool.${option}` as never)}
            </button>
          );
        })}
      </div>
      {pool === null ? null : (
        <>
          <div className="space-y-1 border-t border-border/60 pt-2">
            <div className="flex items-center justify-between gap-2">
              <span className={cn(LABEL, "text-foreground/80")}>{t("blueprint.station.pool.with")}</span>
              {/* Twenty-odd boxes and no way to take them all: a card with a
                  chronicler per dungeon wants every module in one pool, or
                  none. Bulk join skips the per-module "this leaves its old
                  pool" confirmation — the creator asked for all of them. */}
              {others.length > 1 && (
                <span className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => { for (const other of others) if (!members.some((m) => m.id === other.id)) setOther(other, true); }}
                    className="rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    {t("blueprint.station.pool.selectAll")}
                  </button>
                  <button
                    type="button"
                    onClick={() => { for (const other of others) if (members.some((m) => m.id === other.id)) setOther(other, false); }}
                    className="rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    {t("blueprint.station.pool.selectNone")}
                  </button>
                </span>
              )}
            </div>
            {others.length === 0 ? (
              <p className={HINT}>{t("blueprint.station.pool.none")}</p>
            ) : (
              others.map((other) => {
                const inPool = members.some((m) => m.id === other.id);
                return (
                  <label key={other.id} className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 hover:bg-white/[0.04]">
                    <input
                      type="checkbox"
                      checked={inPool}
                      onChange={(e) => {
                        if (e.target.checked) setPendingId(other.id);
                        else setOther(other, false);
                      }}
                      className="h-3.5 w-3.5 shrink-0 accent-amber-500"
                    />
                    <span className="min-w-0 flex-1 truncate text-[11px] text-foreground/85">{other.name}</span>
                  </label>
                );
              })
            )}
          </div>
          {pending && <div className="space-y-2 rounded-lg border border-amber-400/30 bg-amber-400/[0.06] p-3" role="region" aria-label={t("blueprint.workspace.moveMemory")}>
            <p className="text-xs font-semibold text-amber-200">{t("blueprint.workspace.moveMemory")}</p>
            <p className="text-xs leading-relaxed text-foreground/80">{t(
              formerPool === null ? "blueprint.workspace.moveMemoryCard" : formerMembers.length ? "blueprint.workspace.moveMemoryHint" : "blueprint.workspace.moveMemoryOwn",
              { name: pending.name, members: formerMembers.map(b => b.name).join("、") },
            )}</p>
            <div className="flex gap-2">
              <button type="button" onClick={() => setOther(pending, true)} className="rounded-md bg-amber-300 px-2.5 py-1.5 text-xs font-semibold text-black">{t("blueprint.workspace.applyMemory")}</button>
              <button type="button" onClick={() => setPendingId(null)} className="rounded-md px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-accent">{t("blueprint.workspace.cancel")}</button>
            </div>
          </div>}
        </>
      )}
    </div>
  );
}
