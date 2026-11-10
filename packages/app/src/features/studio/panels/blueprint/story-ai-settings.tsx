import { useId } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { AUTHOR_SAMPLING_LIMITS, clampToRange } from "@yumina/engine";
import { PLAY_MODELS } from "@yumina/shared";
import { useEditorStore } from "@/stores/editor";
import { modelReach } from "@/features/editor/lib/ai-call-settings";
import { cn } from "@/lib/utils";
import { DraftInput, Field, Group, NumberInput, Row, Segmented, inputClass, rowControl } from "./controls";
import { requestOpenAiCalls } from "./ai-calls-table";

type Policy = "player" | "author";

/**
 * The story AI's model and sampling, as the card sets them.
 *
 * Its model is always the player's: they pay for it, and their plan decides
 * what they can run. The card may recommend one, which the player's model
 * picker marks. Its sampling (temperature, top P) is the player's too, unless
 * the card says its own is part of how it reads; then the card's values win,
 * clamped to AUTHOR_SAMPLING_LIMITS. Reply length stays the player's.
 */
export function StoryAiSettings({ showAll = false }: { showAll?: boolean }) {
  const { t } = useTranslation("editor");
  const settings = useEditorStore((s) => s.worldDraft.settings);
  const setSettings = useEditorStore((s) => s.setSettings);
  const listId = useId();
  const policy: Policy = settings?.samplingPolicy === "author" ? "author" : "player";
  const recommended = settings?.recommendedModel ?? "";
  const unknown = recommended.trim() !== "" && !modelReach(recommended).known;
  const temperature = clampToRange(settings?.temperature ?? 1, AUTHOR_SAMPLING_LIMITS.temperature);
  const topP = clampToRange(settings?.topP ?? 1, AUTHOR_SAMPLING_LIMITS.topP);
  return (
    <Group
      title={t("blueprint.storyAi.title")}
      hint={t("blueprint.storyAi.hint")}
      right={showAll ? (
        <button type="button" onClick={requestOpenAiCalls} data-open-ai-calls className="text-[11px] font-normal text-foreground/55 underline-offset-2 hover:text-foreground hover:underline">
          {t("blueprint.aiCalls.viewAll")}
        </button>
      ) : undefined}
    >
      {/* Who sets them comes first (owner, 10/17): it is the choice the
          rest of the group follows from. */}
      <Row label={t("blueprint.storyAi.sampling")} hint={t("blueprint.storyAi.samplingHint")} wide>
        <Segmented<Policy>
          label={t("blueprint.storyAi.sampling")}
          value={policy}
          onChange={(next) => setSettings("samplingPolicy", next === "author" ? "author" : undefined)}
          options={[
            { value: "player", label: t("blueprint.aiCalls.followPlayer") },
            { value: "author", label: t("blueprint.aiCalls.authorCustom") },
          ]}
        />
      </Row>
      {policy === "author" && (
        <>
          <Row label={t("blueprint.storyAi.temperature")} hint={t("blueprint.storyAi.temperatureHint", { min: AUTHOR_SAMPLING_LIMITS.temperature.min, max: AUTHOR_SAMPLING_LIMITS.temperature.max })}>
            <NumberInput
              aria-label={t("blueprint.storyAi.temperature")}
              value={temperature}
              min={AUTHOR_SAMPLING_LIMITS.temperature.min}
              max={AUTHOR_SAMPLING_LIMITS.temperature.max}
              step={0.05}
              onCommit={(v) => v !== undefined && setSettings("temperature", v)}
              data-story-temperature
              className={cn(rowControl, "text-right tabular-nums")}
            />
          </Row>
          <Row label={t("blueprint.storyAi.topP")} hint={t("blueprint.storyAi.topPHint", { min: AUTHOR_SAMPLING_LIMITS.topP.min, max: AUTHOR_SAMPLING_LIMITS.topP.max })}>
            <NumberInput
              aria-label={t("blueprint.storyAi.topP")}
              value={topP}
              min={AUTHOR_SAMPLING_LIMITS.topP.min}
              max={AUTHOR_SAMPLING_LIMITS.topP.max}
              step={0.05}
              onCommit={(v) => v !== undefined && setSettings("topP", v)}
              data-story-top-p
              className={cn(rowControl, "text-right tabular-nums")}
            />
          </Row>
        </>
      )}
      <Field label={t("blueprint.storyAi.recommendedModel")} hint={t("blueprint.storyAi.recommendedModelHint")}>
        <DraftInput
          list={listId}
          value={recommended}
          onCommit={(raw) => setSettings("recommendedModel", raw.trim() || undefined)}
          placeholder={t("blueprint.storyAi.recommendedModelNone")}
          spellCheck={false}
          data-recommended-model
          className={inputClass}
        />
        <datalist id={listId}>
          {PLAY_MODELS.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </datalist>
        {unknown && (
          <p className="flex items-start gap-1 text-[11px] leading-snug text-amber-200/90">
            <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
            {t("blueprint.storyAi.recommendedUnknown")}
          </p>
        )}
      </Field>
      <p className="pt-1 text-[11px] leading-relaxed text-foreground/45">{t("blueprint.storyAi.alwaysPlayer")}</p>
    </Group>
  );
}
