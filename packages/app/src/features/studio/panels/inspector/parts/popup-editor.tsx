import { useTranslation } from "react-i18next";
import type { UiElement, Variable } from "@yumina/engine";
import { nameFromQuestion } from "@yumina/engine";
import { ImageField, NamedText, Section, Toggle, VariableSelect, useSyncAutoName, type InsertToken } from "./part-kit";

type Popup = Extract<UiElement, { type: "popup" }>;

/**
 * 弹窗: a card over everything, shown while one variable holds something.
 * The AI (or a button) writes the variable; the player reads it once and
 * closes it. `{{value}}` in the texts is whatever the variable holds.
 */
export function PopupEditor({
  el, onPatch, variables, worldId,
}: {
  el: Popup;
  onPatch: (fn: (el: Popup) => Popup) => void;
  variables: Variable[];
  worldId?: string | null;
}) {
  const { t } = useTranslation("editor");
  const tokens: InsertToken[] = [{ token: "value", label: t("studio.parts.popup.theValue") }];
  const syncName = useSyncAutoName();
  const rule = (name: string) => t("studio.parts.popup.aiRule", { name });
  const suggested = nameFromQuestion(el.title?.template ?? "") || t("studio.parts.popup.newVariableName");
  const setText = (key: "title" | "buttonLabel", template: string) =>
    onPatch((p) => {
      const next = { ...p, [key]: { template } } as Popup;
      if (!template) delete next[key];
      return next;
    });

  return (
    <div data-testid="popup-editor">
      <Section label={t("studio.parts.popup.variable")} hint={t("studio.parts.popup.variableHint")}>
        <VariableSelect
          label={t("studio.parts.popup.variable")}
          value={el.variableId}
          variables={variables}
          types={["string", "json", "boolean"]}
          newName={t("studio.parts.popup.newVariableName")}
          suggestName={suggested}
          rule={rule}
          newType="string"
          newDefault=""
          onChange={(variableId) => onPatch((p) => ({ ...p, variableId }))}
        />
      </Section>

      <Section label={t("studio.parts.popup.title")}>
        <NamedText
          label={t("studio.parts.popup.title")}
          value={el.title?.template ?? ""}
          variables={variables}
          tokens={tokens}
          onChange={(template) => {
            const before = el.title?.template ?? "";
            setText("title", template);
            syncName(el.variableId, before, template, t("studio.parts.popup.newVariableName"), rule);
          }}
        />
      </Section>

      <Section label={t("studio.parts.popup.body")}>
        <NamedText
          label={t("studio.parts.popup.body")}
          rows={4}
          value={el.body?.template ?? ""}
          variables={variables}
          tokens={tokens}
          onChange={(template) => onPatch((p) => ({ ...p, body: { template } }))}
        />
      </Section>

      <Section label={t("studio.parts.image")}>
        <ImageField
          worldId={worldId}
          value={el.image}
          onChange={(ref) => onPatch((p) => {
            if (ref) return { ...p, image: { kind: "asset", ref } };
            const { image: _i, ...rest } = p;
            return rest as Popup;
          })}
        />
      </Section>

      <Section label={t("studio.parts.popup.buttonLabel")}>
        <NamedText
          label={t("studio.parts.popup.buttonLabel")}
          value={el.buttonLabel?.template ?? ""}
          variables={variables}
          onChange={(template) => setText("buttonLabel", template)}
        />
      </Section>

      <Section label={t("studio.parts.popup.closing")} hint={t(el.clearOnClose === false ? "studio.parts.popup.keepHint" : "studio.parts.popup.clearHint")}>
        <Toggle
          label={t("studio.parts.popup.clearOnClose")}
          checked={el.clearOnClose !== false}
          onChange={(on) => onPatch((p) => {
            if (!on) return { ...p, clearOnClose: false };
            const { clearOnClose: _c, ...rest } = p;
            return rest as Popup;
          })}
        />
      </Section>
    </div>
  );
}
