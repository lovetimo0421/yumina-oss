import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDownLeft, ArrowUpRight, Boxes, CheckSquare, ChevronRight, Network, Plus, Search, Settings2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { WorldDefinition } from "@yumina/engine";
import { getObjectRelationships, type ObjectRelationship, type RelationshipObject } from "./object-relationships";

type RelationshipGraph = Parameters<typeof getObjectRelationships>[1];

/** Something a new relation could be drawn to (outgoing) or from (incoming):
 *  the board's own wiring rules, offered as a list. */
export interface RelationCandidate { id: string; title: string; kind: string; direction: "incoming" | "outgoing" }

/** Rows on the board that a selection can hold. */
const SELECTABLE = /^(var|entry|greeting|reaction|rule):/;

/**
 * A contextual map of one object's configured dependencies. Every edit
 * returns to the shared object editor rather than duplicating its controls.
 *
 * It also ADDS and REMOVES them. The panel used to be read-only — every line
 * a jump to the other object, where the binding had to be found in a form —
 * and a tester concluded that relations could only be made "by writing
 * code". They never could; but a panel called Relationships that offers no
 * way to make one is where that belief comes from. "+ relation" lists what
 * the board would let a dragged wire reach, ✕ takes a wire away, and "select
 * all" hands the related rows to the board's multi-selection, to be moved
 * into a module together.
 */
export function ObjectRelationshipsPanel({ world, graph, objectId, onOpenObject, onEditObject, onShowInBlueprint, onClose, readOnly, candidates, onAdd, onRemove, onSelectRelated }: {
  world: WorldDefinition;
  graph: RelationshipGraph;
  objectId: string;
  onOpenObject: (id: string) => void;
  onEditObject: (id: string) => void;
  onShowInBlueprint: (id: string) => void;
  onClose: () => void;
  readOnly?: boolean;
  candidates?: RelationCandidate[];
  onAdd?: (targetId: string, direction: "incoming" | "outgoing") => void;
  /** Remove the wires behind one relation. Only relations that ARE wires
   *  offer this; one written into a condition has to be edited there. */
  onRemove?: (edgeIds: string[]) => void;
  onSelectRelated?: (ids: string[]) => void;
}) {
  const { t } = useTranslation("editor");
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const relationships = useMemo(() => getObjectRelationships(world, graph, objectId), [world, graph, objectId]);
  const { object, owner, members, incoming, outgoing, hasDynamicCodeAccess } = relationships;
  const editable = !readOnly;
  const selectable = useMemo(() => [...new Set([...incoming, ...outgoing].filter(item => !item.target.missing && SELECTABLE.test(item.target.graphNodeId)).map(item => item.target.graphNodeId))], [incoming, outgoing]);
  // Already related in that direction: offering it again would only make a
  // second copy of the same wire.
  const offered = useMemo(() => {
    const have = new Set([...incoming.map(i => `incoming:${i.target.graphNodeId}`), ...outgoing.map(o => `outgoing:${o.target.graphNodeId}`)]);
    const q = query.trim().toLowerCase();
    return (candidates ?? []).filter(c => !have.has(`${c.direction}:${c.id}`) && (!q || c.title.toLowerCase().includes(q)));
  }, [candidates, incoming, outgoing, query]);
  const detail = (item: ObjectRelationship) => {
    if (item.labelKey) return t(`blueprint.${item.labelKey}` as never);
    if (item.kind !== "write-value" || !item.label) return item.label;
    const operations = new Set(["set", "add", "subtract", "multiply", "toggle", "append", "merge", "push", "delete"]);
    return item.label.split(" · ").map(value => operations.has(value) ? t(`blueprint.relationships.operations.${value}` as never) : value).join(" · ");
  };
  const name = (target: RelationshipObject) => {
    if (target.kind === "world") return world.name || t("blueprint.relationships.untitled");
    if (target.graphNodeId === "frontend") return t("studio.stage.tabFrontend");
    if (target.kind === "event") {
      const events: Record<string, string> = {
        "evt:user": "playerInput", "evt:turn": "eachTurn", "evt:session": "sessionStart",
        "evt:turn:complete": "eachTurn", "evt:session:start": "sessionStart", "evt:message:user": "playerInput",
        "evt:message:ai": "aiReply", "evt:state:changed": "stateChanged", "evt:action:fired": "actionFired",
      };
      const event = events[target.graphNodeId];
      if (event) return t(`blueprint.events.${event}` as never);
    }
    return target.title;
  };
  const relatedObject = (target: RelationshipObject, description?: string) => {
    const content = <>
      <div className="min-w-0 flex-1"><div className="break-words text-xs font-medium text-foreground">{name(target)}</div>
        {description && <p className="mt-1 break-words text-[11px] leading-5 text-muted-foreground">{description}</p>}
        {target.missing && <p className="mt-1 text-[11px] text-amber-300">{t("blueprint.relationships.missing")}</p>}
      </div>
      {target.objectId && !target.missing && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
    </>;
    return target.objectId && !target.missing
      ? <button type="button" onClick={() => onOpenObject(target.objectId!)} className="studio-control flex w-full items-center gap-2 rounded-lg border px-3 py-2.5 text-left transition-colors hover:bg-white/[0.07] focus-visible:studio-control-focus focus-visible:outline-none">{content}</button>
      : <div className="flex items-center gap-2 rounded-lg border border-white/[0.06] px-3 py-2.5">{content}</div>;
  };
  const group = (direction: "incoming" | "outgoing", items: ObjectRelationship[]) => {
    if (!items.length) return null;
    const Icon = direction === "incoming" ? ArrowDownLeft : ArrowUpRight;
    return <section className="space-y-2" data-relationship-direction={direction}>
      <h3 className="flex items-center gap-2 text-xs font-medium"><Icon className="h-3.5 w-3.5 text-sky-300" />{t(`blueprint.relationships.${direction}`)}<span className="ml-auto text-[11px] tabular-nums text-muted-foreground">{items.length}</span></h3>
      {items.map(item => {
        const removable = editable && !!onRemove && item.edgeIds.length > 0;
        return <div key={item.id} className={cn(removable && "flex items-stretch gap-1")}>
          <div className="min-w-0 flex-1">{relatedObject(item.target, [t(`blueprint.relationships.kinds.${item.kind}` as never), detail(item)].filter(Boolean).join(" · "))}</div>
          {removable && <button type="button" data-relationship-remove={item.id} onClick={() => onRemove(item.edgeIds)} title={t("blueprint.relationships.remove")} aria-label={t("blueprint.relationships.remove")} className="flex w-7 shrink-0 items-center justify-center rounded-lg border border-white/[0.06] text-foreground/45 transition-colors hover:border-destructive/50 hover:bg-destructive/10 hover:text-destructive"><X className="h-3.5 w-3.5" /></button>}
        </div>;
      })}
    </section>;
  };
  const KINDS = new Set(["module", "variable", "greeting", "entry", "rule", "event", "component", "audio", "image", "world"]);
  const kindLabel = (kind: string) => KINDS.has(kind) ? t(`blueprint.kinds.${kind}` as never) : kind;
  return <div className="flex h-full min-h-0 w-full flex-col bg-[#131118]" data-object-relationships={objectId}>
    <div className="flex items-center gap-2.5 border-b border-white/[0.07] px-3.5 py-3">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-sky-500/10 text-sky-300"><Network className="h-4 w-4" /></span>
      <div className="min-w-0 flex-1"><h2 className="truncate text-sm font-semibold">{name(object)}</h2><p className="text-[11px] text-muted-foreground">{t("blueprint.relationships.title")}</p></div>
      <button type="button" onClick={onClose} title={t("blueprint.rowEdit.close")} aria-label={t("blueprint.rowEdit.close")} className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"><X className="h-4 w-4" /></button>
    </div>
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-3.5">
      <div className="flex flex-wrap gap-2">
        {object.objectId && !object.missing && <button type="button" onClick={() => onEditObject(object.objectId!)} className="studio-control flex items-center gap-1.5 rounded-lg border px-2.5 py-2 text-xs text-foreground/80 hover:text-foreground"><Settings2 className="h-3.5 w-3.5" />{t("blueprint.relationships.editObject")}</button>}
        {object.inGraph && <button type="button" onClick={() => onShowInBlueprint(object.graphNodeId)} className="flex items-center gap-1.5 rounded-lg border border-primary/30 bg-primary/5 px-2.5 py-2 text-xs text-foreground hover:bg-primary/10"><Network className="h-3.5 w-3.5" />{t("blueprint.navigation.showInBlueprint")}</button>}
        {editable && onAdd && !object.missing && (candidates?.length ?? 0) > 0 && <button type="button" data-relationship-add aria-expanded={adding} onClick={() => setAdding(v => !v)} className={cn("flex items-center gap-1.5 rounded-lg border px-2.5 py-2 text-xs text-foreground/80 hover:text-foreground", adding ? "studio-button-lit" : "studio-control")}><Plus className="h-3.5 w-3.5" />{t("blueprint.relationships.add")}</button>}
        {onSelectRelated && selectable.length > 0 && <button type="button" data-relationship-select-all onClick={() => onSelectRelated(selectable)} className="studio-control flex items-center gap-1.5 rounded-lg border px-2.5 py-2 text-xs text-foreground/80 hover:text-foreground"><CheckSquare className="h-3.5 w-3.5" />{t("blueprint.relationships.selectAll", { count: selectable.length })}</button>}
      </div>
      {adding && editable && onAdd && (
        <section className="space-y-2 rounded-lg border border-amber-400/30 bg-amber-400/[0.04] p-2.5" data-relationship-picker>
          <label className="relative block">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder={t("blueprint.relationships.addPick")} className="studio-control h-8 w-full rounded-md border pl-7 pr-2 text-xs text-foreground placeholder:text-foreground/35 focus-visible:studio-control-focus focus-visible:outline-none" />
          </label>
          <div className="max-h-56 space-y-0.5 overflow-y-auto">
            {offered.length === 0 && <p className="px-1 py-2 text-[11px] text-muted-foreground">{t("blueprint.relationships.addEmpty")}</p>}
            {offered.map(c => {
              const Icon = c.direction === "incoming" ? ArrowDownLeft : ArrowUpRight;
              return <button key={`${c.direction}:${c.id}`} type="button" onClick={() => { onAdd(c.id, c.direction); setAdding(false); setQuery(""); }} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-400/60">
                <Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-foreground">{c.title}</span>
                <span className="shrink-0 text-[10px] text-muted-foreground">{kindLabel(c.kind)}</span>
              </button>;
            })}
          </div>
        </section>
      )}
      {object.missing ? <p className="text-xs leading-6 text-amber-300">{t("blueprint.relationships.missingObject")}</p> : <>
        {object.kind !== "world" && <section className="space-y-2">
          <h3 className="text-xs font-medium">{t("blueprint.relationships.scope")}</h3>
          {owner ? relatedObject(owner) : <p className="text-xs text-muted-foreground">{t("blueprint.writing.sharedScope")}</p>}
        </section>}
        {group("incoming", incoming)}
        {group("outgoing", outgoing)}
        {!incoming.length && !outgoing.length && <p className="rounded-lg border border-dashed border-white/[0.1] px-3 py-4 text-xs leading-6 text-foreground/45">{t("blueprint.relationships.empty")}</p>}
        {members.length > 0 && <section className="space-y-2">
          <h3 className="flex items-center gap-2 text-xs font-medium"><Boxes className="h-3.5 w-3.5 text-violet-300" />{t("blueprint.relationships.members")}<span className="ml-auto text-[11px] tabular-nums text-muted-foreground">{members.length}</span></h3>
          {members.map(member => <div key={member.graphNodeId}>{relatedObject(member)}</div>)}
        </section>}
        {hasDynamicCodeAccess && <p className="mt-auto border-t border-white/[0.06] pt-3 text-[11px] leading-5 text-foreground/45">{t("blueprint.relationships.dynamicCodeHint")}</p>}
      </>}
    </div>
  </div>;
}
