import { useTranslation } from "react-i18next";
import { Brain } from "lucide-react";
import { memoryPoolMembers, resolveStation, type Worldbook } from "@yumina/engine";
import { useEditorStore } from "@/stores/editor";
import { cn } from "@/lib/utils";

/**
 * Who this AI remembers with. `book` is null for the card itself.
 *
 * The canvas has drawn this on every module for a while. The editor showed a
 * memory setting only after you ticked "runs the conversation itself", so a
 * plain module said nothing about its memory and the card — which has one, and
 * is the only thing a card with no modules has — had nowhere to say so at all.
 *
 * There is one memory by default, and the card, every plain module and every
 * narrator that did not name a pool are all in it. A narrator that names a pool
 * steps out into that one; a pool of one is the tower whose AI never heard of
 * the town. A worker has no memory of its own — it reads what is wired to it.
 */
export function ModuleMemoryLine({ book, className }: { book: Worldbook | null; className?: string }) {
  const { t } = useTranslation("editor");
  const worldbooks = useEditorStore((s) => s.worldDraft.worldbooks) ?? [];
  const station = book ? resolveStation(book) : null;

  const nameList = (names: string[]) =>
    names.length ? names.join(String(t("blueprint.ctx.flowJoin"))) : "";

  let text: string;
  let hint: string;

  if (station?.kind === "worker") {
    text = t("blueprint.ctx.row.memoryWorker");
    hint = t("blueprint.ctx.row.memoryWorkerHint");
  } else if (station?.kind === "narrator" && station.memoryPool !== null) {
    const mates = memoryPoolMembers(worldbooks, station.memoryPool)
      .filter((b) => b.id !== book?.id)
      .map((b) => b.name);
    text = mates.length
      ? t("blueprint.ctx.row.memoryPool", { names: nameList(mates) })
      : t(station.onClose === "keep" ? "blueprint.ctx.row.memoryOwnKeep" : "blueprint.ctx.row.memoryOwnArchive");
    hint = t(mates.length ? "blueprint.ctx.row.memoryPoolHint" : "blueprint.ctx.row.memoryOwnHint");
  } else {
    // The default pool: the card plus everyone who never left it.
    const others = worldbooks
      .filter((b) => {
        if (b.id === book?.id) return false;
        const st = resolveStation(b);
        return st ? st.kind === "narrator" && st.memoryPool === null : true;
      })
      .map((b) => b.name);
    const sharers = book ? [String(t("blueprint.ctx.row.theCard")), ...others] : others;
    text = sharers.length
      ? t("blueprint.ctx.row.memoryShared", { names: nameList(sharers) })
      : t("blueprint.ctx.row.memoryCardAlone");
    // The card is not "a module with no AI of its own" — it IS the AI that
    // plays by default, so it gets its own sentence rather than the one that
    // tells a plain module its lore joins whoever is narrating.
    hint = book
      ? t(station ? "blueprint.ctx.row.memorySharedHint" : "blueprint.ctx.row.memoryPlainHint")
      : t("blueprint.ctx.row.memoryCardHint");
  }

  return (
    <div className={cn("flex items-start gap-2", className)} title={hint}>
      <Brain className="mt-0.5 h-3.5 w-3.5 shrink-0 text-teal-300" />
      <div className="min-w-0">
        <p className="text-[11px] font-semibold text-foreground">{text}</p>
        <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">{hint}</p>
      </div>
    </div>
  );
}

/** The same fact in one chip, for a row in the module list. */
export function ModuleMemoryChip({ book }: { book: Worldbook | null }) {
  const { t } = useTranslation("editor");
  const worldbooks = useEditorStore((s) => s.worldDraft.worldbooks) ?? [];
  const station = book ? resolveStation(book) : null;
  if (station?.kind === "worker") {
    return <Chip tone="violet" text={t("blueprint.frame.memory.background")} />;
  }
  if (station?.kind === "narrator" && station.memoryPool !== null) {
    const mates = memoryPoolMembers(worldbooks, station.memoryPool).filter((b) => b.id !== book?.id);
    return <Chip tone="teal" text={mates.length ? t("blueprint.frame.memory.pool", { names: mates.map((b) => b.name).join("、") }) : t("blueprint.frame.memory.own")} />;
  }
  return <Chip tone="zinc" text={t("blueprint.frame.memory.card")} />;
}

function Chip({ text, tone }: { text: string; tone: "teal" | "violet" | "zinc" }) {
  return (
    <span
      className={cn(
        "max-w-[12rem] truncate rounded-full px-2 py-0.5 text-[10px] font-semibold",
        tone === "teal" && "bg-teal-500/15 text-teal-300",
        tone === "violet" && "bg-violet-500/15 text-violet-300",
        tone === "zinc" && "bg-white/5 text-muted-foreground",
      )}
    >
      {text}
    </span>
  );
}
