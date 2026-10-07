import { resolveStation, type Worldbook } from "@yumina/engine";
import type { ContextBadge } from "@/features/editor/lib/module-context";
import type { ContextRowView } from "./block-node";

type Translate = (key: string, opts?: Record<string, unknown>) => string;
type Row = Omit<ContextRowView, "onClick">;

/**
 * A situation's AI, said as one call: what wakes it, what it remembers, who it
 * reads and hands to, and what it can do. Rows the creator has nothing to say
 * about are left out — "reads 0 · read by 0" was a sentence about storage,
 * not about the AI.
 */
export function situationAiRows(args: {
  book: Worldbook;
  books: Worldbook[];
  badge?: ContextBadge | null;
  memoryRow: Row | null;
  /** The card's interface calls api.setScene — the AI also sees the screen. */
  seesScene?: boolean;
  t: Translate;
}): Row[] {
  const { book, books, badge, memoryRow, seesScene, t } = args;
  const station = resolveStation(book);
  const join = String(t("blueprint.ctx.flowJoin"));
  const names = (list: string[]) => list.slice(0, 3).join(join) + (list.length > 3 ? ` +${list.length - 3}` : "");
  const readsFrom = (badge?.links ?? []).filter((l) => l.reads.length > 0).map((l) => l.otherName);
  const givesTo = (badge?.links ?? []).filter((l) => l.gives.length > 0).map((l) => l.otherName);
  const rows: Row[] = [];

  if (!station) {
    rows.push({ key: "wake", slot: "wake", icon: "shared", text: t("blueprint.ai.joins"), title: t("blueprint.ctx.row.memoryPlainHint") });
    return rows;
  }

  if (station.kind === "narrator") {
    rows.push({ key: "wake", slot: "wake", icon: "wake", text: t("blueprint.ai.wakeSend"), title: t("blueprint.ai.wakeSendHint") });
    if (memoryRow) rows.push({ ...memoryRow, slot: "remember" });
    if (seesScene) rows.push({ key: "scene", slot: "sees", icon: "scene", text: t("blueprint.ai.seesScene"), title: t("blueprint.ai.seesSceneHint") });
    if (readsFrom.length) rows.push({ key: "reads", slot: "reads", icon: "in", text: t("blueprint.ai.readsFrom", { names: names(readsFrom) }) });
    if (givesTo.length) rows.push({ key: "gives", slot: "reads", icon: "out", text: t("blueprint.ai.givesTo", { names: names(givesTo) }) });
    rows.push({ key: "does", slot: "does", icon: "does", text: t("blueprint.ai.doesSpeak") });
    return rows;
  }

  // A worker: it never answers the player, so when it runs and what it reads
  // are the whole of it.
  const trigger = station.trigger;
  const closedName = trigger?.on === "module-closed"
    ? (trigger.from === "*" ? null : books.find((b) => b.id === trigger.from)?.name ?? null)
    : null;
  rows.push(
    !trigger
      ? { key: "wake", slot: "wake", icon: "trap", text: t("blueprint.ai.wakeNone") }
      : {
          key: "wake",
          slot: "wake",
          icon: "wake",
          text: trigger.on === "quiet"
            ? t("blueprint.ai.wakeQuiet", { n: trigger.seconds })
            : trigger.on === "turns"
            ? t("blueprint.ai.wakeTurns", { n: trigger.every })
            : trigger.on === "conditions"
              ? t("blueprint.ai.wakeConditions")
              : closedName
                ? t("blueprint.ai.wakeClosed", { name: closedName })
                : t("blueprint.ai.wakeAnyClosed"),
        },
  );
  // A quiet station speaks into the story: it reads the last messages itself,
  // and what it can do is talk, not brief another module.
  if (trigger?.on === "quiet") {
    if (readsFrom.length) rows.push({ key: "reads", slot: "reads", icon: "in", text: t("blueprint.ai.readsFrom", { names: names(readsFrom) }) });
    rows.push({ key: "does", slot: "does", icon: "does", text: t("blueprint.ai.doesInterject") });
    return rows;
  }
  rows.push(
    readsFrom.length
      ? { key: "reads", slot: "reads", icon: "in", text: t("blueprint.ai.workerReads", { names: names(readsFrom) }) }
      : { key: "reads", slot: "reads", icon: "trap", text: t("blueprint.ai.workerReadsNothing"), title: t("blueprint.ai.workerReadsNothingHint") },
  );
  rows.push({
    key: "does",
    slot: "does",
    icon: "worker",
    text: givesTo.length ? t("blueprint.ai.workerWritesFor", { names: names(givesTo) }) : t("blueprint.ai.workerWritesForNobody"),
  });
  return rows;
}
