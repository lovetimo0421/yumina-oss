import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Code2, MousePointerSquareDashed, Sparkles, Check, Wand2 } from "lucide-react";
import type { UiKnobGroup } from "@yumina/engine";
import { useEditorStore } from "@/stores/editor";
import { describeElement, nearestKnobGroup, nearestSourceRef, ownSourceRef } from "./hit-test";
import { describeSliceForAgent, sliceSource } from "./source-slice";
import { KnobPanel } from "./knob-panel";

/** What the inspector does with a selection.
 *
 *  Two exits, plus one shortcut. "Open the code" is for people who read TSX;
 *  "hand it to the AI" is for people who do not; knobs are for the cases where
 *  neither is needed because the constant was already lifted out.
 */

export interface InspectExits {
  onOpenCode: (file: string, line: number) => void;
  onSendToAgent: (message: string, label: string, file: string, line: number) => void;
  onSetKnob: (groupId: string, knobId: string, value: string | number) => void;
  /** Ask the agent to lift this card's visual constants into knobs. */
  onAskDecompose: () => void;
}

const SECTION = "border-b border-border/50 px-3 py-2.5";
const ACTION =
  "flex w-full items-center gap-2 rounded-md px-2 py-2 text-xs font-medium transition-colors disabled:opacity-40 disabled:hover:bg-transparent";

export function InspectSidebar({
  selected,
  chain,
  boundary,
  knobGroups,
  attachedRef,
  exits,
}: {
  selected: Element | null;
  chain: Element[];
  boundary: HTMLElement | null;
  knobGroups: UiKnobGroup[];
  /** The block currently pinned to the AI composer, if any. */
  attachedRef: { file: string; line: number } | null;
  exits: InspectExits;
}) {
  const { t } = useTranslation("editor");
  const files = useEditorStore((s) => s.worldDraft.rootComponent?.files);

  const description = useMemo(() => (selected ? describeElement(selected) : null), [selected]);

  // The nearest source line at or above the selection. Platform building blocks
  // (<Chat>, <MessageList>) and anything a card injects as raw HTML carry no
  // stamp, so "inherited" is a real and frequent state — say so rather than
  // pointing at a line the creator did not write.
  const source = useMemo(
    () => (selected ? nearestSourceRef(selected, boundary) : null),
    [selected, boundary],
  );
  const inherited = !!selected && !!source && source.element !== selected;

  const slice = useMemo(() => {
    if (!source || !files) return null;
    const text = files[source.ref.file];
    if (text === undefined) return null;
    return sliceSource(text, source.ref.file, source.ref.line);
  }, [source, files]);

  const knobGroup = useMemo(() => {
    if (!selected) return null;
    const id = nearestKnobGroup(selected, boundary);
    return id ? knobGroups.find((g) => g.id === id) ?? null : null;
  }, [selected, boundary, knobGroups]);

  if (!selected || !description) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <MousePointerSquareDashed className="h-5 w-5 text-muted-foreground/30" />
        <p className="text-[11px] leading-relaxed text-muted-foreground/50">
          {t("studio.inspect.emptyHint")}
        </p>
      </div>
    );
  }

  const isAttached =
    !!attachedRef && !!source && attachedRef.file === source.ref.file && attachedRef.line === source.ref.line;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className={SECTION}>
        <div className="break-all font-mono text-[13px] font-semibold text-foreground">{description.label}</div>
        {description.ownText && (
          <div className="mt-1 line-clamp-2 break-words text-xs leading-relaxed text-muted-foreground/70">“{description.ownText}”</div>
        )}
        <div className="mt-1.5 text-[10px] text-muted-foreground/45">
          {Math.round(selected.getBoundingClientRect().width)} ×{" "}
          {Math.round(selected.getBoundingClientRect().height)}
        </div>
      </div>

      <div className={SECTION}>
        <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/50">
          {t("studio.inspect.sourceTitle")}
        </div>
        {source ? (
          <>
            <div className="break-all font-mono text-xs text-amber-300/90">
              {source.ref.file}:{source.ref.line}
            </div>
            {slice?.component && (
              <div className="mt-0.5 text-[10px] text-muted-foreground/50">
                {t("studio.inspect.inComponent", { name: slice.component })}
              </div>
            )}
            {inherited && (
              <div className="mt-1 text-[10px] leading-relaxed text-muted-foreground/50">
                {t("studio.inspect.inheritedFrom", { label: describeElement(source.element).label })}
              </div>
            )}
          </>
        ) : (
          <div className="text-[10px] leading-relaxed text-muted-foreground/50">
            {t("studio.inspect.noSource")}
          </div>
        )}
      </div>

      <div className="space-y-1 px-2 py-2">
        <button
          type="button"
          disabled={!source}
          onClick={() => source && exits.onOpenCode(source.ref.file, source.ref.line)}
          className={`${ACTION} text-foreground hover:bg-accent`}
        >
          <Code2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          {t("studio.inspect.openCode")}
        </button>
        <button
          type="button"
          disabled={!slice || !source}
          onClick={() =>
            slice &&
            source &&
            exits.onSendToAgent(
              describeSliceForAgent(slice, description.label),
              description.label,
              source.ref.file,
              source.ref.line,
            )
          }
          className={`${ACTION} ${
            isAttached ? "bg-primary/15 text-primary" : "text-foreground hover:bg-accent"
          }`}
        >
          {isAttached ? (
            <Check className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <Sparkles className="h-3.5 w-3.5 shrink-0 text-primary" />
          )}
          {isAttached ? t("studio.inspect.attached") : t("studio.inspect.sendToAgent")}
        </button>
      </div>

      {knobGroup ? (
        <div className={SECTION}>
          <KnobPanel group={knobGroup} onChange={(knobId, value) => exits.onSetKnob(knobGroup.id, knobId, value)} />
        </div>
      ) : (
        knobGroups.length === 0 && (
          // Knobs have to come from somewhere. The decomposition used to live
          // on the deleted builder's toolbar; without a door here, a card that
          // was never decomposed could never acquire one.
          <div className={SECTION}>
            <button
              type="button"
              onClick={exits.onAskDecompose}
              className={`${ACTION} text-muted-foreground hover:bg-accent hover:text-foreground`}
            >
              <Wand2 className="h-3.5 w-3.5 shrink-0 text-amber-400" />
              {t("studio.inspect.askDecompose")}
            </button>
            <p className="mt-1 px-2 text-[9px] leading-relaxed text-muted-foreground/45">
              {t("studio.inspect.askDecomposeHint")}
            </p>
          </div>
        )
      )}

      {description.classes.length > 0 && (
        <details className={SECTION}>
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
            {t("studio.inspect.classesTitle")}
            <span className="ml-1.5 text-[10px] tabular-nums text-muted-foreground/50">{description.classes.length}</span>
          </summary>
          <div className="mt-2 flex flex-wrap gap-1">
            {description.classes.map((c) => (
              <span
                key={c}
                className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/80"
              >
                {c}
              </span>
            ))}
          </div>
        </details>
      )}

      {slice && (
        <details className="px-3 py-2.5">
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
            {t("studio.inspect.snippetTitle")}
          </summary>
          <pre className="mt-2 max-h-64 overflow-auto rounded bg-black/30 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground/80">
            {slice.text}
          </pre>
        </details>
      )}

      {/* Chain is rendered by the stage's breadcrumb; kept here only so a
          selection made by keyboard still reports where it sits. */}
      <div className="sr-only">{chain.map((el) => ownSourceRef(el)?.line ?? "").join(" ")}</div>
    </div>
  );
}
