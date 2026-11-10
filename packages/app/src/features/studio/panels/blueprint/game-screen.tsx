import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, ExternalLink, Gamepad2, Play, Square } from "lucide-react";
import type { Variable, WorldEntry } from "@yumina/engine";
import { gameNameOf, type GameScreen } from "@/features/editor/lib/game-interface";

/**
 * The player's screen on a card that is a game. Drawn at the desktop layout
 * size (the block scales it, like any interface preview), so its type is set
 * for that size.
 *
 * A game page is shown by its cover until the creator asks to play it: a game
 * running by itself on the board would take sound and a GPU from someone who
 * only opened the card to read it. Played here it is the real page, the way
 * a player gets it.
 *
 * An NPC in someone else's game cannot be shown running, so the screen is the
 * one thing that is true about it: what the game hands the AI each turn, who
 * the AI is, and what comes back.
 */
export function GameScreenView({ screen, worldName, entries, variables, playerName, language }: {
  screen: GameScreen;
  worldName: string;
  entries: WorldEntry[];
  variables: Variable[];
  playerName: string;
  language: string;
}) {
  return screen.kind === "page"
    ? <GamePage screen={screen} worldName={worldName} playerName={playerName} language={language} />
    : <GameNpc screen={screen} worldName={worldName} entries={entries} variables={variables} />;
}

function GamePage({ screen, worldName, playerName, language }: { screen: Extract<GameScreen, { kind: "page" }>; worldName: string; playerName: string; language: string }) {
  const { t } = useTranslation("editor");
  const [playing, setPlaying] = useState(false);
  // What chat-view hands the page: who is playing, in the card's language.
  const src = `${screen.path}${screen.path.includes("?") ? "&" : "?"}name=${encodeURIComponent(playerName)}&lang=${encodeURIComponent(language)}`;
  if (playing) {
    return (
      <div className="relative h-full w-full bg-black" data-game-playing>
        <iframe src={src} title={worldName} className="h-full w-full border-0" allow="autoplay; fullscreen" />
        <button type="button" onClick={() => setPlaying(false)} data-game-stop
          className="absolute right-4 top-4 flex items-center gap-2 rounded-full bg-black/70 px-5 py-2.5 text-[20px] font-medium text-white backdrop-blur hover:bg-black/85">
          <Square className="h-5 w-5" />{t("blueprint.gameScreen.stop")}
        </button>
      </div>
    );
  }
  return (
    <div className="relative h-full w-full overflow-hidden bg-black" data-game-cover>
      {screen.cover && <img src={screen.cover} alt="" className="absolute inset-0 h-full w-full object-cover" draggable={false} />}
      {/* Dark enough under the words that a busy game screen does not show through them. */}
      <div className="absolute inset-0 bg-gradient-to-t from-black via-black/75 to-black/10" />
      <div className="absolute inset-x-12 bottom-12 flex flex-col items-start gap-5">
        <span className="flex items-center gap-2 rounded-full bg-white/15 px-4 py-1.5 text-[20px] font-semibold text-white backdrop-blur">
          <Gamepad2 className="h-5 w-5" />{t("blueprint.gameScreen.tag")}
        </span>
        <h3 className="text-[44px] font-bold leading-tight text-white drop-shadow">{worldName}</h3>
        <p className="max-w-[760px] text-[22px] leading-relaxed text-white/85">{t("blueprint.gameScreen.pageLead")}</p>
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => setPlaying(true)} data-game-play
            className="flex items-center gap-2.5 rounded-xl bg-primary px-7 py-3.5 text-[22px] font-semibold text-primary-foreground shadow-lg hover:bg-primary/90">
            <Play className="h-6 w-6" />{t("blueprint.gameScreen.play")}
          </button>
          <a href={src} target="_blank" rel="noreferrer"
            className="flex items-center gap-2 rounded-xl border border-white/30 px-6 py-3.5 text-[20px] text-white/90 hover:bg-white/10">
            <ExternalLink className="h-5 w-5" />{t("blueprint.gameScreen.openWindow")}
          </a>
        </div>
      </div>
    </div>
  );
}

/** Inputs nobody reads off a screen: the reply language and the NPC's own id. */
const QUIET_INPUTS = new Set(["language", "canon_language", "npc", "character_id", "affection_source"]);
/** As many as the column holds at the desktop size; the rest are a count. */
const SHOWN = 5;

function GameNpc({ screen, worldName, entries, variables }: { screen: Extract<GameScreen, { kind: "mod" }>; worldName: string; entries: WorldEntry[]; variables: Variable[] }) {
  const { t } = useTranslation("editor");
  const game = gameNameOf(screen.game, t as (key: string, opts?: Record<string, unknown>) => string);
  const inputs = variables.filter((v) => screen.game.inputs.has(v.id) && !QUIET_INPUTS.has(v.id));
  const outputs = variables.filter((v) => screen.game.outputs.has(v.id));
  const lore = entries.filter((e) => e.role !== "greeting" && !e.presetId && e.content?.trim());
  const value = (v: Variable) => {
    const raw = typeof v.defaultValue === "string" ? v.defaultValue : JSON.stringify(v.defaultValue);
    return raw.length > 22 ? `${raw.slice(0, 21)}…` : raw;
  };
  // What a value is for, in the card's own words: the first sentence of its
  // behaviour rules (what the AI is told about it), cut to a line.
  const said = (v: Variable) => {
    const rules = (v as { behaviorRules?: string }).behaviorRules?.trim();
    if (!rules) return "";
    const first = rules.split(/(?<=[。！？.!?])\s/)[0] ?? rules;
    return first.length > 70 ? `${first.slice(0, 69)}…` : first;
  };
  // The plain line first (a range, or what the board knows the value is
  // for); the card's own rules are written for the AI, so they come last.
  const outputLine = (v: Variable) =>
    (v.type === "number" && v.min != null && v.max != null ? t("blueprint.gameScreen.range", { min: v.min, max: v.max }) : "")
      || (t(`blueprint.gameScreen.out.${v.id}` as never, { defaultValue: "" }) as string)
      || said(v);
  return (
    <div className="flex h-full w-full flex-col gap-7 bg-[radial-gradient(ellipse_at_top,#2a2140,#0d0b12_70%)] px-12 py-10 text-white" data-game-npc>
      <div className="flex flex-col gap-2">
        <span className="flex w-fit items-center gap-2 rounded-full bg-white/10 px-4 py-1.5 text-[19px] font-semibold text-white/85">
          <Gamepad2 className="h-5 w-5" />{t("blueprint.gameScreen.modTag", { game })}
        </span>
        <p className="text-[24px] leading-relaxed text-white/80">{t("blueprint.gameScreen.modLead", { game, npc: worldName })}</p>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[1fr_auto_1fr_auto_1fr] items-stretch gap-4">
        <Column tone="in" title={t("blueprint.gameScreen.inputs", { game })}>
          {inputs.slice(0, SHOWN).map((v) => (
            <div key={v.id} title={said(v) || undefined} className="flex items-baseline justify-between gap-3 text-[19px]">
              <span className="truncate text-white/85">{v.name}</span>
              <span className="shrink-0 font-mono text-[17px] text-sky-200/80">{value(v)}</span>
            </div>
          ))}
          {inputs.length > SHOWN && <div className="text-[17px] text-white/50">{t("blueprint.gameScreen.more", { count: inputs.length - SHOWN })}</div>}
          {inputs.length === 0 && <div className="text-[18px] leading-relaxed text-white/45" data-game-none="in">{t("blueprint.gameScreen.noneIn")}</div>}
        </Column>
        <Arrow />
        <Column tone="ai" title={t("blueprint.gameScreen.role")}>
          <div className="text-[30px] font-bold leading-tight">{worldName}</div>
          {/* Every setting by name: the card's rules (rewards, deals…) are
              settings too, and four names hid them. */}
          {lore.slice(0, 4).map((e) => <div key={e.id} className="shrink-0 truncate text-[18px] leading-snug text-white/75">{e.name}</div>)}
          {lore.length > 4 && <div className="shrink-0 text-[17px] text-white/50">{t("blueprint.gameScreen.lore", { count: lore.length })}</div>}
        </Column>
        <Arrow />
        <Column tone="out" title={t("blueprint.gameScreen.outputs", { game })}>
          {outputs.length === 0 && <div className="text-[18px] leading-relaxed text-white/45" data-game-none="out">{t("blueprint.gameScreen.noneOut")}</div>}
          {outputs.map((v) => (
            <div key={v.id} className="flex flex-col gap-0.5">
              <span className="text-[21px] font-medium">{v.name}</span>
              {outputLine(v) && <span className="line-clamp-2 text-[16px] leading-snug text-amber-100/70">{outputLine(v)}</span>}
            </div>
          ))}
        </Column>
      </div>
      <p className="text-[18px] leading-relaxed text-white/55">{t("blueprint.gameScreen.modFoot", { game })}</p>
    </div>
  );
}

function Column({ tone, title, children }: { tone: "in" | "ai" | "out"; title: string; children: React.ReactNode }) {
  const ring = tone === "in" ? "border-sky-400/40 bg-sky-400/[0.07]" : tone === "out" ? "border-amber-400/45 bg-amber-400/[0.07]" : "border-primary/50 bg-primary/[0.09]";
  const head = tone === "in" ? "text-sky-200" : tone === "out" ? "text-amber-200" : "text-primary";
  return (
    <div className={`flex min-w-0 flex-col gap-3 overflow-hidden rounded-2xl border-2 p-5 ${ring}`}>
      <div className={`text-[20px] font-semibold ${head}`}>{title}</div>
      {children}
    </div>
  );
}

function Arrow() {
  return <div className="flex items-center text-white/40"><ArrowRight className="h-8 w-8" /></div>;
}
