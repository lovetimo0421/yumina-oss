import { resolveStation, type WorldDefinition } from "@yumina/engine";

type Translate = (key: string, opts?: Record<string, unknown>) => string;

/**
 * The card's AIs. Each is one kind of call: the card's own narrator, a
 * situation that answers in its own voice, a background writer, a voice that
 * speaks when it is quiet, and precise tracking. `lensCall` says the things
 * about one — when it wakes, whether it speaks, what it sees, what it can do,
 * and who pays — for its row in the 「AI」 block (ai-roster.ts).
 */

export type LensKind = "card" | "narrator" | "worker" | "quiet" | "judge";
export interface LensAi { key: string; name: string; kind: LensKind }

const precise = (world: WorldDefinition) => (world.variables ?? []).filter((v) => (v as { precise?: boolean }).precise === true);

export function lensAis(world: WorldDefinition, t: Translate): LensAi[] {
  const out: LensAi[] = [{ key: "card", name: String(t("blueprint.lens.card")), kind: "card" }];
  for (const book of world.worldbooks ?? []) {
    const st = resolveStation(book);
    if (!st) continue;
    out.push({ key: `book:${book.id}`, name: book.name, kind: st.kind === "narrator" ? "narrator" : st.trigger?.on === "quiet" ? "quiet" : "worker" });
  }
  if (world.continuity?.enabled !== false && precise(world).length > 0) {
    out.push({ key: "judge", name: String(t("blueprint.lens.judge")), kind: "judge" });
  }
  return out;
}

export interface LensCall {
  wake: string;
  speaks: string;
  sees: string[];
  remembers?: string;
  does: string[];
  cost: string;
}

export function lensCall(world: WorldDefinition, key: string, opts: { seesScene: boolean; memoryText?: string; t: Translate }): LensCall {
  const { t, seesScene } = opts;
  const books = world.worldbooks ?? [];
  const entries = (world.entries ?? []).filter((e) => e.enabled !== false && e.role !== "greeting");
  const always = (owner: string | null) => entries.filter((e) => e.alwaysSend && (e.worldbookId ?? null) === owner).length;
  const keyed = (owner: string | null) => entries.filter((e) => !e.alwaysSend && (e.worldbookId ?? null) === owner).length;
  const vars = (world.variables ?? []).length;
  const historyLimit = world.settings?.historyLimit;
  const scene = seesScene ? [String(t("blueprint.lens.sees.scene"))] : [];
  const events = seesScene ? [String(t("blueprint.lens.does.events"))] : [];

  if (key === "judge") {
    const n = precise(world).length;
    return {
      wake: String(t("blueprint.lens.wake.afterReply")),
      speaks: String(t("blueprint.lens.speaks.never")),
      sees: [String(t("blueprint.lens.sees.turnOnly")), String(t("blueprint.lens.sees.rulesOf", { n }))],
      does: [String(t("blueprint.lens.does.setTracked", { n }))],
      cost: String(t("blueprint.lens.cost.platform")),
    };
  }

  const home = key === "card" ? null : key.slice(5);
  const book = home ? books.find((b) => b.id === home) : undefined;
  const st = book ? resolveStation(book) : null;
  const plainIds = books.filter((b) => !resolveStation(b)).map((b) => b.id);
  const model = st?.model ? String(st.model) : null;

  if (key === "card" || st?.kind === "narrator") {
    const lore = always(null) + (home ? always(home) : 0);
    const key2 = keyed(null) + (home ? keyed(home) : 0) + plainIds.reduce((s, id) => s + always(id) + keyed(id), 0);
    const takeover = key === "card" && books.some((b) => resolveStation(b)?.kind === "narrator");
    return {
      wake: String(t(key === "card" ? (takeover ? "blueprint.ai.line.wakeCardTakeover" : "blueprint.ai.wakeSend") : "blueprint.ai.line.wakeHere")),
      speaks: String(t("blueprint.lens.speaks.always")),
      sees: [
        String(t("blueprint.lens.sees.always", { n: lore })),
        ...(key2 ? [String(t("blueprint.lens.sees.keyword", { n: key2 }))] : []),
        ...(vars ? [String(t("blueprint.lens.sees.vars", { n: vars }))] : []),
        String(historyLimit ? t("blueprint.lens.sees.recent", { n: historyLimit }) : t("blueprint.lens.sees.all")),
        ...scene,
        ...((st?.inputs?.length ?? 0) > 0 ? [String(t("blueprint.lens.sees.inputs", { n: st!.inputs!.length }))] : []),
      ],
      remembers: opts.memoryText,
      does: [String(t("blueprint.lens.does.reply")), ...(vars ? [String(t("blueprint.lens.does.change", { n: vars }))] : []), ...events],
      cost: String(model ? t("blueprint.lens.cost.model", { model }) : t("blueprint.lens.cost.player")),
    };
  }

  const trigger = st?.trigger;
  if (trigger?.on === "quiet") {
    return {
      wake: String(t("blueprint.ai.wakeQuiet", { n: trigger.seconds })),
      speaks: String(t("blueprint.lens.speaks.decides")),
      sees: [
        String(t("blueprint.lens.sees.own", { n: always(home) + keyed(home) })),
        String(t("blueprint.lens.sees.always", { n: always(null) })),
        ...(vars ? [String(t("blueprint.lens.sees.vars", { n: vars }))] : []),
        String(t("blueprint.lens.sees.recent", { n: 12 })),
        ...scene,
      ],
      does: [String(t("blueprint.lens.does.interject")), ...(vars ? [String(t("blueprint.lens.does.change", { n: vars }))] : []), ...events],
      cost: String(model ? t("blueprint.lens.cost.model", { model }) : t("blueprint.lens.cost.cheap")),
    };
  }
  return {
    wake: String(!trigger ? t("blueprint.ai.wakeNone") : trigger.on === "turns" ? t("blueprint.ai.wakeTurns", { n: trigger.every }) : trigger.on === "conditions" ? t("blueprint.ai.wakeConditions") : t("blueprint.ai.wakeAnyClosed")),
    speaks: String(t("blueprint.lens.speaks.never")),
    sees: [String(t("blueprint.lens.sees.own", { n: always(home) + keyed(home) })), ...((st?.inputs?.length ?? 0) > 0 ? [String(t("blueprint.lens.sees.inputs", { n: st!.inputs!.length }))] : [String(t("blueprint.lens.sees.nothingWired"))])],
    does: [String(t("blueprint.lens.does.writeBehind"))],
    cost: String(model ? t("blueprint.lens.cost.model", { model }) : t("blueprint.lens.cost.cheap")),
  };
}
