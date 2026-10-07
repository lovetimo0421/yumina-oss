import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Bot, ChevronLeft, ChevronRight } from "lucide-react";
import { computeActiveWorldbookIds, CONTINUITY_KEEP, CONTINUITY_NONE, CONTINUITY_PLAYLIST, UNPLACED_WORLDBOOK_ID, type Variable } from "@yumina/engine";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/stores/chat";
import { useEditorStore } from "@/stores/editor";
import type { PromptSegmentKind, RuntimeRecord } from "../lib/runtime-records";
import { changeHint, explainTurn, type ChangeSource, type HeldReason, type RuleRow } from "../lib/turn-explain";

const OPEN_KEY = "yumina-playtest-why-open";
const show = (value: unknown) => {
  if (typeof value === "boolean") return value ? "✓" : "✗";
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "—";
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
};
const pct = (p: number) => Math.round(p * 100);
const readOpen = () => { try { return localStorage.getItem(OPEN_KEY) !== "0"; } catch { return true; } };

type Tone = "ai" | "judge" | "rule" | "fix" | "warn" | "plain";
const toneClass: Record<Tone, string> = {
  ai: "border-amber-500/40 text-amber-300",
  judge: "border-sky-400/40 text-sky-300",
  rule: "border-violet-400/40 text-violet-300",
  fix: "border-emerald-400/40 text-emerald-300",
  warn: "border-red-400/45 text-red-300",
  plain: "border-border text-muted-foreground",
};
function Tag({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={cn("shrink-0 rounded border px-1 text-[10.5px] leading-[17px]", toneClass[tone])}>{children}</span>;
}
function Why({ tone, tag, children }: { tone: Tone; tag: ReactNode; children?: ReactNode }) {
  return <div className="flex items-start gap-1.5 text-[11.5px] leading-relaxed text-foreground/80"><Tag tone={tone}>{tag}</Tag>{children && <span className="min-w-0">{children}</span>}</div>;
}
function Item({ children, dim }: { children: ReactNode; dim?: boolean }) {
  return <div className={cn("flex flex-col gap-1 rounded-lg border border-border/70 bg-card/70 px-2.5 py-2", dim && "opacity-70")}>{children}</div>;
}
function Group({ title, children }: { title: string; children: ReactNode }) {
  return <section className="flex flex-col gap-1.5"><h5 className="text-[11px] tracking-wider text-muted-foreground">{title}</h5>{children}</section>;
}

/** One colour per part of the prompt, in the order the server assembles it. */
const SEGMENT: Record<PromptSegmentKind, { dot: string; label: string }> = {
  lore: { dot: "bg-teal-400", label: "设定 · 每回合都发" },
  persona: { dot: "bg-cyan-300", label: "玩家人设" },
  platform: { dot: "bg-zinc-500", label: "平台指令" },
  examples: { dot: "bg-sky-300", label: "示例对话" },
  "lore-triggered": { dot: "bg-teal-200", label: "设定 · 这回合说到了" },
  memory: { dot: "bg-violet-300", label: "记忆摘要" },
  inputs: { dot: "bg-fuchsia-300", label: "别的情境交过来的" },
  history: { dot: "bg-violet-500", label: "最近的对话" },
  pending: { dot: "bg-rose-300", label: "行为塞进来的" },
  state: { dot: "bg-amber-400", label: "数值和上回合的变化" },
  scene: { dot: "bg-orange-400", label: "现场" },
  post: { dot: "bg-orange-300", label: "回复前最后的提示" },
};

/**
 * Every AI call of this playtest on one time axis, a lane per speaker:
 * solid where it spoke or changed something, hollow where it was woken and
 * chose silence. Once a card has a clock, "turn 3" stops being enough — this
 * is what happened when, and who stayed quiet. Click a dot to read that call.
 */
function Timeline({ turns, silences, picked, onPick, variableName }: {
  turns: RuntimeRecord[];
  silences: Array<{ at: string; speakerId: string; speakerName: string }>;
  picked: string | null;
  onPick: (id: string) => void;
  variableName: (id: string) => string;
}) {
  const { t } = useTranslation("editor");
  type Dot = { at: number; solid: boolean; id?: string; tip: string };
  const lanes = new Map<string, Dot[]>();
  const add = (lane: string, dot: Dot) => { const l = lanes.get(lane) ?? []; l.push(dot); lanes.set(lane, l); };
  const you = t("studio.why.timeline.you", { defaultValue: "你" });
  const card = t("studio.why.seen.card", { defaultValue: "旁白" });
  const judge = t("studio.why.timeline.judge", { defaultValue: "精准追踪" });
  for (const r of turns) {
    const at = Date.parse(r.at);
    const changed = r.changes.length;
    if (r.kind === "action") { add(t("studio.why.actionShort", { defaultValue: "按钮" }), { at, solid: true, id: r.id, tip: "" }); continue; }
    if (r.kind === "quiet") { add(r.quietSpeaker?.name ?? "?", { at, solid: true, id: r.id, tip: changed ? r.changes.map((c) => variableName(c.variableId)).join("、") : "" }); continue; }
    if (r.kind === "turn") add(you, { at, solid: true, id: r.id, tip: "" });
    add(r.prompt?.speaker?.name ?? card, { at, solid: true, id: r.id, tip: "" });
    const asked = r.trace?.asked ?? [];
    if (asked.length > 0) add(judge, { at, solid: asked.some((q) => q.applied), id: r.id, tip: "" });
  }
  for (const s of silences) add(s.speakerName || "?", { at: Date.parse(s.at), solid: false, tip: t("studio.why.timeline.silent", { defaultValue: "叫醒了，没出声" }) });
  const all = [...lanes.values()].flat();
  if (all.length < 2) return null;
  const t0 = Math.min(...all.map((d) => d.at));
  const t1 = Math.max(...all.map((d) => d.at), t0 + 1000);
  const x = (at: number) => 4 + ((at - t0) / (t1 - t0)) * 92;
  const span = Math.round((t1 - t0) / 1000);
  const order = [you, card, ...[...lanes.keys()].filter((k) => k !== you && k !== card && k !== judge), judge].filter((k) => lanes.has(k));
  return (
    <div className="border-b border-border px-3 pb-2 pt-2" data-playtest-timeline>
      <div className="flex flex-col gap-1">
        {order.map((lane) => <div key={lane} className="flex items-center gap-2">
          <span className="w-14 shrink-0 truncate text-[10.5px] text-muted-foreground" title={lane}>{lane}</span>
          <div className="relative h-3.5 flex-1 border-b border-dashed border-border/70">
            {lanes.get(lane)!.map((d, i) => <button key={i} type="button" disabled={!d.id} title={d.tip || undefined}
              onClick={() => d.id && onPick(d.id)}
              className={cn("absolute top-0.5 h-2.5 w-2.5 -translate-x-1/2 rounded-full",
                d.solid ? "bg-amber-400" : "border border-muted-foreground/70 bg-transparent",
                d.id && d.id === picked && "ring-2 ring-foreground/80 ring-offset-1 ring-offset-background")}
              style={{ left: `${x(d.at)}%` }} />)}
          </div>
        </div>)}
      </div>
      <div className="mt-1 flex justify-between pl-16 text-[10px] tabular-nums text-muted-foreground">
        <span>0:00</span><span>{Math.floor(span / 60)}:{String(span % 60).padStart(2, "0")}</span>
      </div>
    </div>
  );
}

/** The playtest's "what happened this turn" column: who moved each value, what
 *  held the others, how far each behavior still is from firing. */
export function PlaytestRuntimeLog({ sessionId, overlay = false }: { sessionId: string; overlay?: boolean }) {
  const { t } = useTranslation("editor");
  const records = useChatStore((s) => s.runtimeRecords);
  const silences = useChatStore((s) => s.quietSilences);
  const messages = useChatStore((s) => s.messages);
  const world = useEditorStore((s) => s.worldDraft);
  // Over the card (narrow screens) it only opens when asked.
  const [open, setOpen] = useState(() => !overlay && readOpen());
  const [picked, setPicked] = useState<string | null>(null);
  const [allHeld, setAllHeld] = useState(false);
  const [allRules, setAllRules] = useState(false);

  const turns = useMemo(() => records.filter((r) => r.sessionId === sessionId && r.kind !== "restore"), [records, sessionId]);
  const latest = turns[turns.length - 1] ?? null;
  // A new result always takes the column back to the newest turn.
  useEffect(() => { setPicked(null); setAllHeld(false); setAllRules(false); }, [latest?.id]);
  const current = turns.find((r) => r.id === picked) ?? latest;
  const index = current ? turns.indexOf(current) : -1;
  const explained = useMemo(
    () => current ? explainTurn(world, current, turns.slice(0, index)) : null,
    [world, current, turns, index],
  );

  /** Where the player is: the situations open after this turn, and which of
   *  them this turn opened or closed. Without it the only way to tell that
   *  「后仓」 had opened was the settings' character count going up by 31. */
  const places = useMemo(() => {
    const books = (world.worldbooks ?? []).filter((b) => b.activation?.mode !== "always" && b.id !== UNPLACED_WORLDBOOK_ID);
    if (!current?.state || books.length === 0) return null;
    const now = computeActiveWorldbookIds(books, current.state);
    // The first turn compares with the start of the run: what the turn did
    // not switch (a condition already true, an opening's situation) was
    // already there; a door a word opens starts shut.
    const start = { ...current.state, ruleState: { ...current.state.ruleState, toggledWorldbooks: {} } } as typeof current.state;
    const before = index > 0
      ? (turns[index - 1]?.state ? computeActiveWorldbookIds(books, turns[index - 1]!.state!) : null)
      : computeActiveWorldbookIds(books, start);
    return {
      open: books.filter((b) => now.has(b.id)).map((b) => ({ id: b.id, name: b.name, ai: !!b.station, entered: !!before && !before.has(b.id) })),
      left: before ? books.filter((b) => before.has(b.id) && !now.has(b.id)).map((b) => ({ id: b.id, name: b.name, ai: !!b.station })) : [],
    };
  }, [world.worldbooks, current, turns, index]);

  const toggle = (next: boolean) => {
    setOpen(next);
    if (overlay) return;
    try { localStorage.setItem(OPEN_KEY, next ? "1" : "0"); } catch { /* per-viewer convenience only */ }
  };
  const variable = (id: string) => world.variables.find((v) => v.id === id);
  const ruleName = (id: string) => world.reactions?.find((r) => r.id === id)?.name ?? world.rules?.find((r) => r.id === id)?.name ?? id;

  if (!open) {
    const moved = latest?.changes.length ?? 0;
    return (
      <button type="button" onClick={() => toggle(true)} data-playtest-why="rail"
        aria-label={t("studio.why.open", { defaultValue: "展开这回合发生了什么" })}
        className="flex w-10 shrink-0 flex-col items-center gap-3 border-l border-border bg-card/40 pt-3 text-muted-foreground hover:text-foreground">
        <ChevronLeft className="h-4 w-4" />
        <span className="text-[11.5px] tracking-[.2em] [writing-mode:vertical-rl]">{t("studio.why.title", { defaultValue: "这回合" })}</span>
        {moved > 0 && <span className="w-7 rounded-full bg-emerald-500/15 py-0.5 text-center text-[10.5px] text-emerald-300 tabular-nums">{moved}</span>}
      </button>
    );
  }

  const varButton = (rootId: string, suffix = "") => {
    const v = variable(rootId);
    return <span className={cn("truncate", v ? "text-sky-300" : "text-muted-foreground")}>{v?.name ?? rootId}{suffix}</span>;
  };
  const hintLine = (v: Variable | undefined) => {
    const hint = changeHint(v);
    return hint
      ? t("studio.why.yourHint", { hint, defaultValue: "你写的：{{hint}}" })
      : <span className="text-amber-300">{t("studio.why.noHint", { defaultValue: "这个数还没写什么时候变" })}</span>;
  };

  const sourceWhy = (source: ChangeSource, rootId: string) => {
    switch (source.kind) {
      case "ai": if (current?.quietSpeaker) return <Why tone="ai" tag={current.quietSpeaker.name}>{t("studio.why.quietChanged", { defaultValue: "安静时自己改的" })}</Why>;
        return source.repaired
        ? <Why tone="fix" tag={t("studio.why.src.repaired", { defaultValue: "补写" })}>{t("studio.why.repaired", { defaultValue: "AI 讲到了但没改数，另一个 AI 检查后补上" })}</Why>
        : <Why tone="ai" tag={t("studio.why.src.ai", { defaultValue: "AI 改的" })}>{hintLine(variable(rootId))}</Why>;
      case "judge": return <Why tone="judge" tag={t("studio.why.src.judge", { defaultValue: "精准追踪" })}>
        {source.confidence !== null && t("studio.why.judgeSure", { p: pct(source.confidence), defaultValue: "判断把握 {{p}}%" })}</Why>;
      case "rule": return <Why tone="rule" tag={t("studio.why.src.rule", { defaultValue: "行为" })}>
        {source.ids.map((id, i) => <span key={id}>{i > 0 && "、"}「{ruleName(id)}」</span>)}
        {t("studio.why.ruleFired", { defaultValue: "触发了" })}</Why>;
      case "action": return <Why tone="rule" tag={t("studio.why.src.action", { defaultValue: "按钮" })}>{t("studio.why.action", { defaultValue: "玩家点了按钮" })}</Why>;
      case "setup": return <Why tone="plain" tag={t("studio.why.src.setup", { defaultValue: "开局设定" })} />;
      case "settle": return <Why tone="plain" tag={t("studio.why.src.settle", { defaultValue: "连带变化" })}>{t("studio.why.settle", { defaultValue: "别的数变了，它跟着算出来" })}</Why>;
      default: return <Why tone="plain" tag={t("studio.why.src.unknown", { defaultValue: "来源未知" })} />;
    }
  };

  const heldWhy = (reason: HeldReason, v: Variable | undefined) => {
    switch (reason.kind) {
      case "dropped": {
        const text = {
          "read-only": t("studio.why.drop.readOnly", { defaultValue: "AI 想改，但这个数设成了 AI 只能看" }),
          internal: t("studio.why.drop.hidden", { defaultValue: "AI 想改，但这个数对 AI 是隐藏的" }),
          inactive: t("studio.why.drop.inactive", { defaultValue: "AI 想改，但这个数现在没启用" }),
          judge: t("studio.why.drop.judge", { defaultValue: "AI 想改，但这个数交给精准追踪管" }),
        }[reason.reason];
        return <Why tone="warn" tag={t("studio.why.tag.blocked", { defaultValue: "被挡了" })}>{text}</Why>;
      }
      case "rejected": return <Why tone="warn" tag={t("studio.why.tag.broken", { defaultValue: "写坏了" })}>{t("studio.why.rejected", { defaultValue: "AI 的写法有错，保留原值" })}</Why>;
      case "judge": {
        const sure = pct(reason.confidence);
        const text = reason.reason === "no-answer"
          ? t("studio.why.judgeNoAnswer", { defaultValue: "这回合没判断出来，保持原值" })
          // A yes/no is usually "has this happened yet" — say it that way.
          : v?.type === "boolean" && reason.chosen === false
            ? t("studio.why.judgeNotYet", { p: sure, defaultValue: "判断还没发生（把握 {{p}}%）" })
          : v?.type === "boolean" && reason.chosen === null
            ? t("studio.why.judgeUnsure", { p: sure, defaultValue: "说不准有没有发生（把握 {{p}}%，要 80% 才改）" })
          : reason.reason === "keep" || reason.reason === "unchanged" || reason.chosen === null || reason.chosen === 0
            ? t("studio.why.judgeKeep", { p: sure, defaultValue: "判断不用变（把握 {{p}}%）" })
            : t("studio.why.judgeBelow", { to: typeof reason.chosen === "number" ? (reason.chosen > 0 ? `+${reason.chosen}` : String(reason.chosen)) : show(reason.chosen), p: sure, defaultValue: "觉得要变成 {{to}}，但把握只有 {{p}}%，要 80% 才改" });
        return <Why tone="judge" tag={t("studio.why.src.judge", { defaultValue: "精准追踪" })}>{text}</Why>;
      }
      case "ai-same": return <Why tone="plain" tag={t("studio.why.tag.same", { defaultValue: "没变化" })}>{t("studio.why.aiSame", { defaultValue: "AI 写了，但和原来的值一样" })}</Why>;
      case "rules-only": return <Why tone="plain" tag={t("studio.why.tag.rulesOnly", { defaultValue: "只给行为" })}>{t("studio.why.rulesOnly", { defaultValue: "只有行为和按钮能改它" })}</Why>;
      default: return <Why tone="plain" tag={t("studio.why.tag.silent", { defaultValue: "AI 没动" })}>{hintLine(v)}</Why>;
    }
  };

  const ruleWhy = (row: RuleRow) => {
    const s = row.status;
    switch (s.kind) {
      case "fired": return <Why tone="rule" tag={t("studio.why.rule.fired", { defaultValue: "触发了" })} />;
      case "unmet": return null;
      case "stopped": return <Why tone="plain" tag={t("studio.why.rule.notFired", { defaultValue: "没触发" })}>{t("studio.why.rule.stopped", { defaultValue: "停止条件成立了" })}</Why>;
      case "cooldown": return <Why tone="plain" tag={t("studio.why.rule.cooldownTag", { defaultValue: "冷却中" })}>{t("studio.why.rule.cooldown", { n: s.turnsLeft, defaultValue: "还要等 {{n}} 回合" })}</Why>;
      case "maxed": return <Why tone="plain" tag={t("studio.why.rule.maxedTag", { defaultValue: "用完了" })}>{t("studio.why.rule.maxed", { n: s.count, defaultValue: "已经触发过 {{n}} 次" })}</Why>;
      case "inactive": return <Why tone="plain" tag={t("studio.why.rule.notFired", { defaultValue: "没触发" })}>{t("studio.why.rule.inactive", { defaultValue: "它所在的情境现在没开" })}</Why>;
      case "chance": return <Why tone="plain" tag={t("studio.why.rule.chanceTag", { defaultValue: "没抽中" })}>{t("studio.why.rule.chance", { p: s.percent, defaultValue: "条件满足了，{{p}}% 的概率这次没中" })}</Why>;
      case "timing": {
        const tr = s.trigger;
        const text = tr.kind === "every-n" ? t("studio.why.rule.everyN", { n: tr.n, next: tr.next, defaultValue: "每 {{n}} 回合一次，下次在第 {{next}} 回合" })
          : tr.kind === "crossing" ? t("studio.why.rule.crossing", { defaultValue: "只在越过那条线的那一下触发" })
          : tr.kind === "player-words" ? t("studio.why.rule.playerWords", { defaultValue: "要等玩家说到关键词" })
          : tr.kind === "ai-words" ? t("studio.why.rule.aiWords", { defaultValue: "要等 AI 写到关键词" })
          : tr.kind === "action" ? t("studio.why.rule.action", { defaultValue: "要等玩家点按钮" })
          : tr.kind === "every-turn" ? t("studio.why.rule.nextTurn", { defaultValue: "条件现在满足了，下回合会触发" })
          : t("studio.why.rule.timing", { defaultValue: "触发时机还没到" });
        return <Why tone="plain" tag={t("studio.why.rule.notFired", { defaultValue: "没触发" })}>{text}</Why>;
      }
      default: return null;
    }
  };

  const said = (() => {
    if (!current?.messageId || current.kind === "action" || current.kind === "quiet") return null;
    const i = messages.findIndex((m) => m.id === current.messageId);
    for (let j = i - 1; j >= 0; j -= 1) if (messages[j]!.role === "user") return messages[j]!.content;
    return null;
  })();


  const seen = current?.prompt ?? null;
  const injected = new Set(current?.injectedEntryIds ?? []);
  const sentEntries = world.entries.filter((e) => injected.has(e.id));
  const entryNames = (always: boolean) => sentEntries.filter((e) => !!e.alwaysSend === always);
  const unsent = current?.injectedEntryIds ? world.entries.filter((e) => e.enabled !== false && !e.alwaysSend && !injected.has(e.id)).length : 0;
  const entryChips = (list: typeof sentEntries) => list.length > 0 && <div className="flex flex-wrap gap-1 pl-3.5">
    {list.slice(0, 4).map((e) => <span key={e.id}
      className="max-w-[9rem] truncate rounded bg-muted/70 px-1.5 text-[10.5px] leading-[18px] text-foreground/75">{e.name}</span>)}
    {list.length > 4 && <span className="text-[10.5px] leading-[18px] text-muted-foreground">+{list.length - 4}</span>}
  </div>;
  const asked = current?.trace?.asked ?? [];
  const jevSubject = (q: (typeof asked)[number]) => {
    if (q.key.startsWith("var__")) return variable(q.key.slice(5))?.name ?? q.key.slice(5);
    if (q.kind === "bgm") return t("studio.why.jev.bgm", { defaultValue: "配乐" });
    if (q.kind === "image") return t("studio.why.jev.image", { defaultValue: "场景图" });
    if (q.kind === "sfx") return t("studio.why.jev.sfx", { name: q.key.replace(/^sfx__/, ""), defaultValue: "音效「{{name}}」" });
    return q.key;
  };
  const jevAnswer = (q: (typeof asked)[number]) => {
    if (q.chosen === null) return t("studio.why.jev.noAnswer", { defaultValue: "没答出来" });
    if (typeof q.chosen === "boolean") return q.chosen ? t("studio.why.jev.yes", { defaultValue: "是" }) : t("studio.why.jev.no", { defaultValue: "否" });
    if (typeof q.chosen === "number") return q.chosen === 0 ? t("studio.why.jev.noChange", { defaultValue: "不变" }) : q.chosen > 0 ? `+${q.chosen}` : String(q.chosen);
    // Music and pictures answer with ids and the judge's own words for "leave
    // it" / "none" / "back to the playlist", none of them a thing to show.
    if (q.chosen === CONTINUITY_KEEP) return t("studio.why.jev.keep", { defaultValue: "不换" });
    if (q.chosen === CONTINUITY_NONE) return t("studio.why.jev.noImage", { defaultValue: "不放图" });
    if (q.chosen === CONTINUITY_PLAYLIST) return t("studio.why.jev.playlist", { defaultValue: "回到歌单" });
    if (q.kind === "image") return world.sceneImages?.find((img) => img.id === q.chosen)?.name || show(q.chosen);
    if (q.kind === "bgm") return world.audioTracks?.find((track) => track.id === q.chosen)?.name || show(q.chosen);
    return show(q.chosen);
  };
  const held = explained?.held ?? [];
  const loud = held.filter((h) => h.reason.kind !== "ai-silent");
  const silent = held.filter((h) => h.reason.kind === "ai-silent");
  const showSilentRows = allHeld || silent.length <= 3;
  const rules = explained?.rules ?? [];
  const shownRules = allRules ? rules : rules.slice(0, 3);

  return (
    <aside data-playtest-why="column" className={cn("flex w-[300px] shrink-0 flex-col border-l border-border",
      overlay ? "absolute inset-y-0 right-0 z-20 max-w-[90%] bg-background shadow-2xl" : "bg-card/40")} aria-label={t("studio.why.title", { defaultValue: "这回合" })}>
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-xs font-medium">{t("studio.why.title", { defaultValue: "这回合" })}</span>
        <button type="button" onClick={() => toggle(false)} aria-label={t("studio.why.close", { defaultValue: "收起" })}
          className="ml-auto rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"><ChevronRight className="h-4 w-4" /></button>
      </div>
      <Timeline turns={turns} silences={silences.filter((q) => q.sessionId === sessionId)} picked={current?.id ?? null}
        onPick={setPicked} variableName={(id) => variable(id)?.name ?? id} />
      <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-3 pb-4 pt-2.5">
        {!current && <p className="py-3 text-xs leading-relaxed text-muted-foreground">
          {t("studio.why.empty", { defaultValue: "发一句话试试，这里会写每个数为什么变、为什么没变。" })}</p>}
        {current?.quietSpeaker && <p className="text-[11.5px] leading-relaxed text-muted-foreground">
          <span className="text-foreground">{current.quietSpeaker.name}</span>
          {" "}{current.group
            ? t("studio.why.groupAnswered", { defaultValue: "接着上一个 AI 回了玩家" })
            : t("studio.why.quietWoke", { defaultValue: "在没人说话时被叫醒" })}</p>}
        {said && <p className="line-clamp-3 text-[11.5px] leading-relaxed text-muted-foreground">
          {t("studio.why.youSaid", { defaultValue: "你说" })} <span className="text-foreground">{said}</span></p>}
        {places && (places.open.length > 0 || places.left.length > 0) && <div data-why-places className="flex flex-wrap items-center gap-1.5 text-[11.5px]">
          {/* An AI is not somewhere the player is: it comes and goes. */}
          <span className="text-muted-foreground">{[...places.open, ...places.left].some((p) => p.ai)
            ? t("studio.why.places.nowAi", { defaultValue: "现在" })
            : t("studio.why.places.now", { defaultValue: "现在在" })}</span>
          {places.open.length === 0 && <span className="text-foreground/80">{t("studio.why.places.cardOnly", { defaultValue: "只有卡本身" })}</span>}
          {places.open.map((p) => <span key={p.id}
            className={cn("rounded-full border px-2 py-0.5", p.entered ? "border-emerald-400/50 bg-emerald-400/10 text-emerald-200" : "border-white/15 text-foreground")}>
            {p.ai && <Bot className="mr-1 inline h-3 w-3 align-[-2px] text-pink-300" />}{p.name}{p.entered && <span className="ml-1 text-[10.5px] text-emerald-300">{p.ai
              ? t("studio.why.places.aiCame", { defaultValue: "来了" })
              : t("studio.why.places.entered", { defaultValue: "刚进来" })}</span>}
          </span>)}
          {places.left.map((p) => <span key={p.id} className="rounded-full border border-dashed border-white/15 px-2 py-0.5 text-muted-foreground line-through decoration-1">
            {p.name}<span className="ml-1 text-[10.5px] no-underline">{p.ai
              ? t("studio.why.places.aiWent", { defaultValue: "走了" })
              : t("studio.why.places.left", { defaultValue: "刚离开" })}</span>
          </span>)}
        </div>}
        {seen && <Group title={t("studio.why.seen.title", { defaultValue: "AI 收到了" })}>
          <Item>
            <div className="flex items-baseline gap-1 text-xs">
              {seen.speaker
                ? <span className="min-w-0 truncate text-foreground">{seen.speaker.name}</span>
                : <span className="text-foreground">{t("studio.why.seen.card", { defaultValue: "旁白" })}</span>}
              <span className="shrink-0 text-muted-foreground">{t("studio.why.seen.speaks", { defaultValue: "在说话" })}</span>
              <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">{t("studio.why.seen.total", { n: seen.totalChars.toLocaleString(), defaultValue: "{{n}} 字" })}</span>
            </div>
            <div className="flex h-2 overflow-hidden rounded-sm bg-muted" aria-hidden>
              {seen.segments.map((seg) => <i key={seg.kind} className={cn("block h-full", SEGMENT[seg.kind].dot)}
                style={{ width: `${seen.totalChars ? (seg.chars / seen.totalChars) * 100 : 0}%` }} />)}
            </div>
            <div className="flex flex-col gap-1 pt-0.5">
              {seen.segments.map((seg) => <div key={seg.kind} className="flex flex-col gap-0.5">
                <div className="flex items-center gap-1.5 text-[11.5px] text-foreground/80">
                  <i className={cn("h-2 w-2 shrink-0 rounded-[2px]", SEGMENT[seg.kind].dot)} />
                  <span className="min-w-0 truncate">{seg.kind === "history"
                    ? t("studio.why.seen.history", { n: seen.historyMessages, defaultValue: "最近 {{n}} 条对话" })
                    : t(`studio.why.seen.seg.${seg.kind}`, { defaultValue: SEGMENT[seg.kind].label })}</span>
                  <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">{seg.chars.toLocaleString()}</span>
                </div>
                {seg.kind === "lore" && entryChips(entryNames(true))}
                {seg.kind === "lore-triggered" && entryChips(entryNames(false))}
              </div>)}
              {unsent > 0 && <p className="text-[11px] text-muted-foreground">
                {t("studio.why.seen.unsent", { n: unsent, defaultValue: "这次没发：{{n}} 条设定（没说到关键词，或不在现在的情境）" })}</p>}
            </div>
          </Item>
        </Group>}
        {current && current.storyEvents.length > 0 && <Group title={t("studio.why.events", { defaultValue: "AI 触发了" })}>
          {current.storyEvents.map((name) => <Item key={name}><Why tone="rule" tag={t("studio.why.eventTag", { defaultValue: "事件" })}>{name}</Why></Item>)}
        </Group>}
        {explained && explained.changed.length > 0 && <Group title={t("studio.why.changed", { defaultValue: "变了" })}>
          {explained.changed.map((c, i) => <Item key={`${c.rootId}${c.subPath}:${i}`}>
            <div className="flex items-baseline gap-1.5 text-xs tabular-nums">
              {varButton(c.rootId, c.subPath)}
              <span className="min-w-0 truncate text-muted-foreground">{show(c.oldValue)} → <span className="text-foreground">{show(c.newValue)}</span></span>
              {c.delta !== null && c.delta !== 0 && <span className={cn("ml-auto font-semibold", c.delta > 0 ? "text-emerald-300" : "text-red-300")}>{c.delta > 0 ? `+${c.delta}` : c.delta}</span>}
            </div>
            {sourceWhy(c.source, c.rootId)}
          </Item>)}
        </Group>}
        {current && current.changes.length === 0 && current.kind !== "action" && held.length === 0 && <p className="text-[11.5px] text-muted-foreground">
          {current.trace ? t("studio.why.nothing", { defaultValue: "这回合没有数变化。" }) : t("studio.why.oldServer", { defaultValue: "这次没有返回来源信息。" })}</p>}
        {(loud.length > 0 || silent.length > 0) && <Group title={t("studio.why.held", { defaultValue: "没变" })}>
          {[...loud, ...(showSilentRows ? silent : [])].map((h) => <Item key={h.rootId}>
            <div className="flex items-baseline gap-1.5 text-xs tabular-nums">{varButton(h.rootId)}<span className="min-w-0 truncate text-muted-foreground">{show(h.value)}</span></div>
            {heldWhy(h.reason, variable(h.rootId))}
          </Item>)}
          {!showSilentRows && <button type="button" onClick={() => setAllHeld(true)} className="self-start text-[11px] text-muted-foreground hover:text-foreground">
            {t("studio.why.silentMore", { names: silent.slice(0, 3).map((h) => variable(h.rootId)?.name ?? h.rootId).join("、"), n: silent.length, defaultValue: "AI 没动：{{names}} 等 {{n}} 个 ›" })}</button>}
        </Group>}
        {asked.length > 0 && <Group title={t("studio.why.jev.title", { defaultValue: "精准追踪问了" })}>
          {asked.map((q) => <Item key={q.key} dim={!q.applied}>
            <div className="flex items-baseline gap-1.5 text-xs" title={q.question}>
              <span className="min-w-0 truncate text-sky-300">{jevSubject(q)}</span>
              <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground">{pct(q.confidence)}%</span>
            </div>
            <div className="h-1 overflow-hidden rounded bg-muted"><i className="block h-full bg-sky-400" style={{ width: `${pct(q.confidence)}%` }} /></div>
            <div className="flex items-start gap-1.5 text-[11.5px] text-foreground/80">
              <Tag tone={q.applied ? "judge" : "plain"}>{q.applied ? t("studio.why.jev.used", { defaultValue: "用了" }) : t("studio.why.jev.notUsed", { defaultValue: "没改" })}</Tag>
              <span className="min-w-0">{jevAnswer(q)}</span>
            </div>
          </Item>)}
        </Group>}
        {rules.length > 0 && <Group title={t("studio.why.rules", { defaultValue: "行为" })}>
          {shownRules.map((row) => <Item key={row.id} dim={row.status.kind !== "fired" && !row.progress}>
            <div className="flex items-baseline gap-1.5 text-xs">
              <span className="min-w-0 truncate text-violet-300">{row.name}</span>
              {row.status.kind === "unmet" && <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{t("studio.why.rule.notFired", { defaultValue: "没触发" })}</span>}
            </div>
            {row.progress ? <>
              <div className="h-1.5 overflow-hidden rounded bg-muted"><i className="block h-full bg-violet-400"
                style={{ width: `${Math.max(2, Math.min(100, row.progress.target === 0 ? 0 : (row.progress.current / row.progress.target) * 100))}%` }} /></div>
              <div className="flex justify-between text-[11px] tabular-nums text-muted-foreground">
                <span>{t("studio.why.rule.now", { name: variable(row.progress.variableId.split(".")[0]!)?.name ?? row.progress.variableId, c: row.progress.current, target: row.progress.target, defaultValue: "{{name}} 现在 {{c}} / 要到 {{target}}" })}</span>
                <span>{t("studio.why.rule.left", { n: Math.abs(row.progress.remaining), defaultValue: "还差 {{n}}" })}</span>
              </div>
              {row.progress.eta !== null && <p className="text-[11px] text-muted-foreground">{t("studio.why.rule.eta", { n: row.progress.eta, defaultValue: "照最近的速度，大约还要 {{n}} 回合" })}</p>}
            </> : row.status.kind === "unmet"
              ? <Why tone="plain" tag={t("studio.why.rule.notFired", { defaultValue: "没触发" })}>{t("studio.why.rule.unmet", { defaultValue: "条件还没满足" })}</Why>
              : ruleWhy(row)}
          </Item>)}
          {rules.length > shownRules.length && <button type="button" onClick={() => setAllRules(true)} className="self-start text-[11px] text-muted-foreground hover:text-foreground">
            {t("studio.why.rulesMore", { n: rules.length - shownRules.length, defaultValue: "还有 {{n}} 条 ›" })}</button>}
        </Group>}
      </div>
    </aside>
  );
}
