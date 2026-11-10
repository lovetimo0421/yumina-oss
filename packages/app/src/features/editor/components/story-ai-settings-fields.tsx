import { useId } from "react";
import { useTranslation } from "react-i18next";
import { AUTHOR_SAMPLING_LIMITS, clampToRange } from "@yumina/engine";
import { PLAY_MODELS } from "@yumina/shared";
import { useEditorStore } from "@/stores/editor";
import { DraftInput, NumberInput } from "@/features/studio/panels/blueprint/controls";
import { modelReach } from "../lib/ai-call-settings";

const field = "rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-foreground outline-none focus:border-primary/50";

/**
 * The story AI's model and sampling, in the classic editor's settings card:
 * the same three settings the Studio's card form holds (story-ai-settings.tsx),
 * in this page's own style. The model is always the player's; the card may
 * recommend one. Sampling is the player's unless the card locks its own.
 */
export function StoryAiSettingsFields() {
  const { t } = useTranslation("editor");
  const settings = useEditorStore((s) => s.worldDraft.settings);
  const setSettings = useEditorStore((s) => s.setSettings);
  const listId = useId();
  const author = settings?.samplingPolicy === "author";
  const recommended = settings?.recommendedModel ?? "";
  const unknown = recommended.trim() !== "" && !modelReach(recommended).known;
  const limits = AUTHOR_SAMPLING_LIMITS;
  return (
    <div className="space-y-3" data-story-ai-classic>
      <div>
        <label className="mb-1.5 block text-sm font-bold text-foreground">{t("blueprint.storyAi.sampling")}</label>
        <select
          value={author ? "author" : "player"}
          onChange={(e) => setSettings("samplingPolicy", e.target.value === "author" ? "author" : undefined)}
          className={field}
        >
          <option value="player">{t("blueprint.aiCalls.followPlayer")}</option>
          <option value="author">{t("blueprint.aiCalls.authorCustom")}</option>
        </select>
        {author && (
          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <label className="flex items-center gap-1.5">
              {t("blueprint.storyAi.temperature")}
              <NumberInput
                aria-label={t("blueprint.storyAi.temperature")}
                value={clampToRange(settings?.temperature ?? 1, limits.temperature)}
                min={limits.temperature.min}
                max={limits.temperature.max}
                step={0.05}
                onCommit={(v) => v !== undefined && setSettings("temperature", v)}
                className={`${field} w-20 text-right tabular-nums`}
              />
            </label>
            <label className="flex items-center gap-1.5">
              {t("blueprint.storyAi.topP")}
              <NumberInput
                aria-label={t("blueprint.storyAi.topP")}
                value={clampToRange(settings?.topP ?? 1, limits.topP)}
                min={limits.topP.min}
                max={limits.topP.max}
                step={0.05}
                onCommit={(v) => v !== undefined && setSettings("topP", v)}
                className={`${field} w-20 text-right tabular-nums`}
              />
            </label>
          </div>
        )}
        <p className="mt-1 text-xs text-muted-foreground/40">{t("blueprint.storyAi.samplingHint")} {t("blueprint.storyAi.alwaysPlayer")}</p>
      </div>
      <div>
        <label className="mb-1.5 block text-sm font-bold text-foreground">{t("blueprint.storyAi.recommendedModel")}</label>
        <DraftInput
          list={listId}
          value={recommended}
          onCommit={(raw) => setSettings("recommendedModel", raw.trim() || undefined)}
          placeholder={t("blueprint.storyAi.recommendedModelNone")}
          spellCheck={false}
          className={`${field} w-full`}
        />
        <datalist id={listId}>
          {PLAY_MODELS.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </datalist>
        <p className="mt-1 text-xs text-muted-foreground/40">{t(unknown ? "blueprint.storyAi.recommendedUnknown" : "blueprint.storyAi.recommendedModelHint")}</p>
      </div>
    </div>
  );
}
