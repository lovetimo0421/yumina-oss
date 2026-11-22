import { useLayoutEffect, useRef } from "react";
import { useEditorStore } from "@/stores/editor";
import { blockId } from "@yumina/engine";
import { AudioTrackForm, BehaviorForm, EntryForm, GreetingForm, ModuleMemoryForm, SceneImageForm, VariableForm } from "./inspector";
import { CardContextForm } from "./context-forms";
import { ReadOnlyForm } from "./read-only-form";

/** Every editable object uses the same expand-in-place interaction. Context
 *  belongs to the card or module, so its block id is the editor's identity. */
const INLINE_KINDS = ["entry:", "greeting:", "image:", "var:", "reaction:", "audio:"] as const;
export const isInlineContext = (objectId: string) => objectId === blockId.context() || /^block:m:.+:context$/.test(objectId);
export const canEditRowInline = (objectId: string) => isInlineContext(objectId) || INLINE_KINDS.some(prefix => objectId.startsWith(prefix));

/** Commit by stable id: rows may be reordered before a debounced rename saves. */
export function renameCanvasRow(objectId: string, name: string) {
  const store = useEditorStore.getState();
  const id = objectId.slice(objectId.indexOf(":") + 1);
  if (objectId.startsWith("var:")) {
    const index = store.worldDraft.variables.findIndex(v => v.id === id);
    if (index >= 0) store.updateVariableAt(index, { name });
  } else if (objectId.startsWith("reaction:")) store.updateReaction(id, { name });
  else if (objectId.startsWith("image:")) store.updateSceneImage(id, { name });
  else if (objectId.startsWith("audio:")) store.updateAudioTrack(id, { name });
  else if (objectId.startsWith("entry:") || objectId.startsWith("greeting:")) store.updateEntry(id, { name });
}

/** The same forms as the inspector, without a duplicate name field: the
 *  expanded row's header is its one rename control. */
export function BlueprintRowEditor({ onMeasure, hostId, ...props }: {
  objectId: string;
  readOnly: boolean;
  onDrill: (panelId: string) => void;
  onOpenObject?: (objectId: string) => void;
  hostId: string;
  onMeasure?: (objectId: string, height: number, hostId: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const row = ref.current?.parentElement;
    if (!row || !onMeasure || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(entries => {
      const entry = entries[0];
      // Border-box sizes are in canvas units, unaffected by ReactFlow zoom.
      const height = Math.ceil(entry?.borderBoxSize?.[0]?.blockSize ?? row.offsetHeight);
      if (height > 0) onMeasure(props.objectId, height, hostId);
    });
    observer.observe(row);
    return () => observer.disconnect();
  }, [props.objectId, onMeasure, hostId]);
  return <div ref={ref} className="flex flex-1 flex-col"><RowEditorForm {...props} /></div>;
}

function RowEditorForm({ readOnly, ...props }: {
  objectId: string;
  readOnly: boolean;
  onDrill: (panelId: string) => void;
  onOpenObject?: (objectId: string) => void;
}) {
  // Read only (a pack in the market, an admin's look, a signed-out visitor):
  // the same form, locked, so what is in the row can be read in full. It used to say only 「只读视图」, which left a pack's
  // entries and variables impossible to look at before installing it.
  if (!readOnly) return <EditableRowForm {...props} />;
  return <ReadOnlyForm><EditableRowForm {...props} /></ReadOnlyForm>;
}

function EditableRowForm({ objectId, onDrill, onOpenObject }: {
  /** `entry:` / `greeting:` / `var:` / `reaction:` / `image:` + its id. */
  objectId: string;
  /** Open one of the card's full editors (the opening and scene-image forms
   *  both link out to one). */
  onDrill: (panelId: string) => void;
  onOpenObject?: (objectId: string) => void;
}) {
  const id = objectId.slice(objectId.indexOf(":") + 1);
  if (objectId === blockId.context()) return <CardContextForm />;
  if (isInlineContext(objectId)) {
    const ownerId = objectId.slice("block:m:".length, -":context".length);
    return <ModuleMemoryForm key={ownerId} worldbookId={ownerId} onOpenModule={onOpenObject ? () => onOpenObject(`module:${ownerId}`) : undefined} />;
  }
  if (objectId.startsWith("audio:")) return <AudioTrackForm key={id} trackId={id} onDrill={onDrill} />;
  if (objectId.startsWith("greeting:")) return <GreetingForm key={id} entryId={id} onDrill={onDrill} />;
  if (objectId.startsWith("entry:")) return <EntryForm key={id} entryId={id} />;
  if (objectId.startsWith("var:")) return <VariableForm key={id} variableId={id} />;
  if (objectId.startsWith("reaction:")) return <BehaviorForm key={id} reactionId={id} />;
  if (objectId.startsWith("image:")) return <SceneImageForm key={id} sceneImageId={id} onDrill={onDrill} />;
  return null;
}
