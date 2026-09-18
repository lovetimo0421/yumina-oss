import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useChatStore } from "@/stores/chat";
import type { TurnResult, CombatLogEntry } from "@yumina/engine";

const apiBase = import.meta.env.VITE_API_URL || "";

interface CombatAPIResponse {
  data: {
    turn: TurnResult;
    state: {
      hp: number;
      combat_enemy: Record<string, unknown>;
      combat_active: boolean;
      combat_result?: string;
    };
  };
}

const LOG_TYPE_TO_KEY: Record<CombatLogEntry["type"], string> = {
  flee_success: "combat.fleeSuccess",
  flee_fail: "combat.fleeFail",
  player_attack: "combat.playerAttack",
  enemy_attack: "combat.enemyAttack",
  enemy_counter: "combat.enemyCounter",
};

export function CombatPanel({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation("common");
  const gameState = useChatStore((s) => s.gameState);
  const setVariableDirectly = useChatStore((s) => s.setVariableDirectly);
  const [loading, setLoading] = useState(false);
  const [combatLog, setCombatLog] = useState<string[]>([]);

  const enemy = gameState.combat_enemy as Record<string, unknown> | undefined;
  if (!enemy || typeof enemy.name !== "string") return null;

  const enemyName = enemy.name as string;
  const enemyHp = (enemy.hp as number) ?? 0;
  const enemyMaxHp = (enemy.maxHp as number) ?? enemyHp;
  const hpPercent = enemyMaxHp > 0 ? (enemyHp / enemyMaxHp) * 100 : 0;

  async function doAction(action: "attack" | "flee") {
    if (loading) return;
    setLoading(true);

    try {
      const res = await fetch(`${apiBase}/api/combat/sessions/${sessionId}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ action }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Unknown error" }));
        setCombatLog((prev) => [...prev, `${t("combat.error")}: ${err.error}`].slice(-20));
        return;
      }

      const { data } = (await res.json()) as CombatAPIResponse;

      // Format structured log entries to localized strings
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tf = t as any;
      const newLines = data.turn.log.map((entry) =>
        tf(LOG_TYPE_TO_KEY[entry.type], { damage: entry.damage, name: entry.enemyName }) as string
      );
      setCombatLog((prev) => [...prev, ...newLines].slice(-20));

      // Sync state from server response
      setVariableDirectly("hp", data.state.hp);
      setVariableDirectly("combat_enemy", data.state.combat_enemy);
      setVariableDirectly("combat_active", data.state.combat_active);
      if (data.state.combat_result != null) {
        setVariableDirectly("combat_result", data.state.combat_result);
      }

      // If combat ended, notify AI to continue narrative
      if (data.turn.combatEnded) {
        // Read fresh state for accurate values
        const freshState = useChatStore.getState().gameState;
        const maxHp = (freshState.maxHp as number) ?? data.turn.playerHp;
        const resultText =
          data.turn.combatResult === "win"
            ? t("combat.resultWin", { name: enemyName, hp: data.turn.playerHp, maxHp })
            : data.turn.combatResult === "flee"
              ? t("combat.resultFlee", { name: enemyName, hp: data.turn.playerHp, maxHp })
              : t("combat.resultLose", { name: enemyName });

        queueMicrotask(() => {
          useChatStore.getState().sendMessage(`【${t("combat.combatEnded")}】${resultText}`);
        });
      }
    } catch {
      setCombatLog((prev) => [...prev, t("combat.networkError")].slice(-20));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="absolute inset-x-0 bottom-0 z-50 border-t border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="mx-auto max-w-2xl px-4 py-3 space-y-3">
        {/* Enemy info */}
        <div className="space-y-1">
          <div className="flex items-center justify-between text-sm font-medium">
            <span>{enemyName}</span>
            <span className="text-muted-foreground">
              HP {enemyHp}/{enemyMaxHp}
            </span>
          </div>
          <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-red-500 transition-all duration-300"
              style={{ width: `${hpPercent}%` }}
            />
          </div>
        </div>

        {/* Combat log */}
        {combatLog.length > 0 && (
          <div className="max-h-24 overflow-y-auto rounded bg-muted/50 px-3 py-2 text-sm space-y-0.5">
            {combatLog.slice(-5).map((line, i) => (
              <p key={i} className="text-muted-foreground">
                {line}
              </p>
            ))}
          </div>
        )}

        {/* Action buttons */}
        <div className="flex gap-2">
          <button
            onClick={() => doAction("attack")}
            disabled={loading}
            className="flex-1 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {loading ? "..." : t("combat.attack")}
          </button>
          <button
            onClick={() => doAction("flee")}
            disabled={loading}
            className="flex-1 rounded-md bg-secondary px-4 py-2 text-sm font-medium text-secondary-foreground hover:bg-secondary/80 disabled:opacity-50"
          >
            {loading ? "..." : t("combat.flee")}
          </button>
        </div>
      </div>
    </div>
  );
}
