import { useTranslation } from "react-i18next";
import { useEditorStore } from "@/stores/editor";
import { declaresGameInterface, gameInterfaceOf, gameNameOf, gameSide, withGameSide, worldGameOf } from "@/features/editor/lib/game-interface";
import { Check, DraftInput, Field, Group, Row, Segmented, inputClass } from "./controls";

type Translate = (key: string, opts?: Record<string, unknown>) => string;

/**
 * 游戏接口, on the card's own form: whether this card is a character inside
 * a game that a mod runs, and the game's name. Which variables the game
 * writes and which it reads back are set on each variable (GameSideControl):
 * that is where the creator is when they make one.
 *
 * A SpireTalk card's interface is the mod's own and only described here; a
 * card that opens a game page of ours (PvZ) is a game in another sense and
 * shows nothing.
 */
export function GameInterfaceGroup() {
  const { t } = useTranslation("editor");
  const world = useEditorStore((s) => s.worldDraft);
  const setField = useEditorStore((s) => s.setField);
  const game = worldGameOf(world);
  if (typeof game?.path === "string") return null;
  const iface = gameInterfaceOf(world);
  const declared = declaresGameInterface(game);
  return (
    <Group title={t("blueprint.gameIface.title")} hint={t("blueprint.gameIface.hint")}>
      {iface && !iface.declared ? (
        <p className="text-[11.5px] leading-relaxed text-foreground/70" data-game-iface-builtin="">
          {t("blueprint.gameIface.builtin", { game: gameNameOf(iface, t as Translate), inputs: iface.inputs.size, outputs: iface.outputs.size })}
        </p>
      ) : (
        <>
          <Check
            label={t("blueprint.gameIface.on")}
            checked={declared}
            // Off is null, not absent: the database keeps a `game` key that a
            // save leaves out.
            onChange={(on) => setField("game", on ? { name: game?.name ?? "", inputs: game?.inputs ?? [], outputs: game?.outputs ?? [] } : null)}
          />
          {declared && iface && (
            <div className="space-y-2 pt-1" data-game-iface="">
              <Field label={t("blueprint.gameIface.name")}>
                <DraftInput
                  value={game?.name ?? ""}
                  placeholder={t("blueprint.gameIface.namePlaceholder")}
                  onCommit={(name) => setField("game", { ...game!, name: name.trim() })}
                  className={inputClass}
                />
              </Field>
              <p className="text-[11px] leading-relaxed text-foreground/55">
                {t("blueprint.gameIface.counts", { inputs: iface.inputs.size, outputs: iface.outputs.size })}
              </p>
            </div>
          )}
        </>
      )}
    </Group>
  );
}

/** On a variable of a card that declares a game: which side of the game it is on. */
export function GameSideControl({ variableId }: { variableId: string }) {
  const { t } = useTranslation("editor");
  const world = useEditorStore((s) => s.worldDraft);
  const setField = useEditorStore((s) => s.setField);
  const game = worldGameOf(world);
  const iface = gameInterfaceOf(world);
  if (!game || !iface?.declared) return null;
  const side = gameSide(iface, variableId) ?? "none";
  return (
    <Row label={t("blueprint.gameIface.side")} hint={t("blueprint.gameIface.sideHint", { game: gameNameOf(iface, t as Translate) })} wide>
      <Segmented<"none" | "in" | "out">
        label={t("blueprint.gameIface.side")}
        value={side}
        onChange={(next) => setField("game", withGameSide(game, variableId, next === "none" ? null : next))}
        options={[
          { value: "none", label: t("blueprint.gameIface.sideNone") },
          { value: "in", label: t("blueprint.game.in") },
          { value: "out", label: t("blueprint.game.out") },
        ]}
      />
    </Row>
  );
}
