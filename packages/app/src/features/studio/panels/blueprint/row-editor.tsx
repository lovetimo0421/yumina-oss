import { useTranslation } from "react-i18next";
import { useEditorStore } from "@/stores/editor";
import { DebouncedInput } from "@/features/editor/components/debounced-field";
import { BehaviorForm, EntryForm, GreetingForm, SceneImageForm, VariableForm } from "./inspector";

/** The object kinds whose editor a row can hold. Everything on the board
 *  that has a form opens in its own row now, so a click does the same thing
 *  wherever it lands: a variable or a behaviour used to pop a floating card
 *  over the board while a setting opened in place, and newcomers never knew
 *  where the next click would put them. Those two open shorter
 *  (OPEN_SETTING_EDITOR_H): the 460px form that once opened in the middle of
 *  the shelf was, in the owner's words, meaningless and awkward. Audio tracks
 *  and legacy rules have no form of their own. */
const INLINE_KINDS = ["entry:", "greeting:", "image:", "var:", "reaction:"] as const;
export const canEditRowInline = (objectId: string) => INLINE_KINDS.some(prefix => objectId.startsWith(prefix));

/**
 * An object's editor, inside the row it belongs to.
 *
 * The drawer beside the canvas is still there and a click on a row still opens
 * it: this is the second way in, for when you would rather not cover the board
 * you are reading the object on. Both render the SAME form — a cut-down inline
 * version would mean the creator has to learn which settings only exist
 * somewhere else — and both may be open at once, because the copy that is not
 * focused re-reads the draft when the focused one commits.
 *
 * A writing row's title bar becomes its name field while it is open, so those
 * two kinds bring no name field of their own; a block row's title is not
 * editable in place, so those kinds get one here.
 */
export function BlueprintRowEditor({ objectId, readOnly, onDrill }: {
  /** `entry:` / `greeting:` / `var:` / `reaction:` / `image:` + its id. */
  objectId: string;
  readOnly: boolean;
  /** Open one of the card's full editors (the opening and scene-image forms
   *  both link out to one). */
  onDrill: (panelId: string) => void;
}) {
  const { t } = useTranslation("editor");
  const id = objectId.slice(objectId.indexOf(":") + 1);
  if (readOnly) return <p className="text-xs text-muted-foreground">{t("blueprint.insp.readOnly")}</p>;
  if (objectId.startsWith("greeting:")) return <GreetingForm key={id} entryId={id} onDrill={onDrill} />;
  if (objectId.startsWith("entry:")) return <EntryForm key={id} entryId={id} />;
  if (objectId.startsWith("var:")) return <NamedRow objectId={objectId}><VariableForm key={id} variableId={id} /></NamedRow>;
  if (objectId.startsWith("reaction:")) return <NamedRow objectId={objectId}><BehaviorForm key={id} reactionId={id} /></NamedRow>;
  if (objectId.startsWith("image:")) return <NamedRow objectId={objectId}><SceneImageForm key={id} sceneImageId={id} onDrill={onDrill} /></NamedRow>;
  return null;
}

/** A name field above the form, for the kinds the drawer renames from its own
 *  title bar — without it, the one thing you could not change in place is what
 *  the thing is called. */
function NamedRow({ objectId, children }: { objectId: string; children: React.ReactNode }) {
  const { t } = useTranslation("editor");
  const id = objectId.slice(objectId.indexOf(":") + 1);
  const name = useEditorStore(s =>
    objectId.startsWith("var:") ? s.worldDraft.variables.find(v => v.id === id)?.name
      : objectId.startsWith("reaction:") ? (s.worldDraft.reactions ?? []).find(r => r.id === id)?.name
      : (s.worldDraft.sceneImages ?? []).find(img => img.id === id)?.name);
  if (name === undefined) return null;
  const rename = (next: string) => {
    const store = useEditorStore.getState();
    if (objectId.startsWith("var:")) {
      // The list can be reordered while a debounced commit is in flight, so
      // find the index again rather than closing over the one we rendered with.
      const index = store.worldDraft.variables.findIndex(v => v.id === id);
      if (index >= 0) store.updateVariableAt(index, { name: next });
    } else if (objectId.startsWith("reaction:")) {
      store.updateReaction(id, { name: next });
    } else {
      store.updateSceneImage(id, { name: next });
    }
  };
  return (
    <div className="flex min-h-0 flex-col gap-3">
      <DebouncedInput
        value={name}
        syncKey={`row-editor-name-${objectId}`}
        onCommit={rename}
        aria-label={t("blueprint.insp.name")}
        placeholder={t("blueprint.insp.name")}
        className="studio-control w-full rounded-lg border px-2.5 py-1.5 text-sm font-medium text-foreground focus:studio-control-focus focus:outline-none"
      />
      {children}
    </div>
  );
}
