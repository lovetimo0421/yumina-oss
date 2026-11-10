import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDownLeft, ArrowUpRight, Boxes, ChevronRight, Globe2 } from 'lucide-react';
import { toGraph, UNPLACED_WORLDBOOK_ID, type CardGraph, type GraphNode, type WorldDefinition } from '@yumina/engine';
import { useEditorStore } from '@/stores/editor';

const jump = (objId: string) => window.dispatchEvent(new CustomEvent('yumina:studio-canvas-focus', { detail: { objId } }));
const moduleLinkClass = 'min-w-0 rounded px-1.5 py-1 text-left text-[11px] text-foreground/80 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';
const summaryClass = 'flex cursor-pointer list-none items-center gap-1.5 rounded py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring [&::-webkit-details-marker]:hidden';

const selectClass = 'studio-control nodrag h-6 min-w-0 max-w-[60%] truncate rounded-md border px-1.5 text-[11px] text-foreground/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

/**
 * Membership and direct references use the same persisted objects as the canvas.
 *
 * This strip is where an object's home is CHANGED, not only read. It used to
 * say "module-only / Campus" here and offer the dropdown that changes it
 * three groups further down under "who owns it" — the same fact twice, once
 * you could read and once you could edit, and a tester asked why. The
 * dropdown is here now and the lower group is gone. The enabled switch rides
 * along for the two kinds that have one: whether a thing is in play and
 * whose it is are the two questions asked in the same breath.
 */
export function ObjectContext({ node, world, readOnly, graph: sharedGraph }: {
  node: GraphNode;
  world: WorldDefinition;
  readOnly?: boolean;
  /** The canvas's own projection of `world`. Recompiling it here re-ran the
   *  whole graph on every debounced keystroke in the inspector, a second time
   *  over, for a strip that reads a handful of edges. Only a host without a
   *  graph of its own pays for one. */
  graph?: CardGraph;
}) {
  const { t } = useTranslation('editor');
  const graph = useMemo(() => sharedGraph ?? toGraph(world, { foldPlainEntries: false }), [sharedGraph, world]);
  const id = node.id.slice(node.id.indexOf(':') + 1);
  const isVariable = node.kind === 'variable';
  const isEntry = node.kind === 'entry' || node.kind === 'greeting';
  const isReaction = node.id.startsWith('reaction:');
  const object = isVariable ? world.variables.find(v => v.id === id)
    : isEntry ? world.entries.find(e => e.id === id)
    : isReaction ? world.reactions?.find(r => r.id === id) : undefined;
  if (!object) return null;
  const owner = world.worldbooks?.find(b => b.id === object.worldbookId);
  const modules = owner ? [owner] : (world.worldbooks ?? []);
  const books = world.worldbooks ?? [];
  const setOwner = (worldbookId: string | undefined) => {
    const store = useEditorStore.getState();
    if (isVariable) {
      const index = store.worldDraft.variables.findIndex(v => v.id === id);
      if (index >= 0) store.updateVariableAt(index, { worldbookId });
    } else if (isEntry) store.updateEntry(id, { worldbookId });
    else if (isReaction) store.updateReaction(id, { worldbookId });
  };
  // Variables have no switch: a variable that is not wanted is deleted.
  const enabled = isVariable ? null : (object as { enabled?: boolean }).enabled !== false;
  const setEnabled = (on: boolean) => {
    const store = useEditorStore.getState();
    if (isEntry) store.updateEntry(id, { enabled: on });
    else if (isReaction) store.updateReaction(id, { enabled: on });
  };
  const outside = object.worldbookId === UNPLACED_WORLDBOOK_ID;
  const ownerControl = (books.length > 0 || outside) && !readOnly
    ? <select aria-label={t('blueprint.insp.module')} value={object.worldbookId ?? ''} onChange={e => setOwner(e.target.value || undefined)} className={selectClass}>
        <option value="">{t('blueprint.insp.sharedAll')}</option>
        {books.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
        <option value={UNPLACED_WORLDBOOK_ID}>{t('blueprint.insp.unplaced')}</option>
      </select>
    : null;
  const enabledControl = enabled === null || readOnly ? null
    : <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[11px] text-foreground/66">
        {t('blueprint.insp.enabled')}
        {/* A switch that is on is lit (studio material); off is glass. */}
        <button type="button" role="switch" aria-checked={enabled} aria-label={t('blueprint.insp.enabled')} onClick={() => setEnabled(!enabled)}
          className={`relative inline-flex h-[18px] w-[30px] shrink-0 items-center rounded-full transition-colors ${enabled ? 'bg-[rgba(240,198,116,0.22)] shadow-[0_0_12px_rgba(240,198,116,0.35),inset_0_1px_0_rgba(255,255,255,0.15)]' : 'bg-white/10'}`}>
          <span className={`absolute top-[2px] h-[14px] w-[14px] rounded-full transition-[left] ${enabled ? 'left-[14px] bg-[#f5d48a] shadow-[0_0_8px_2px_rgba(240,198,116,0.5)]' : 'left-[2px] bg-foreground/60'}`} />
        </button>
      </span>;
  const nodesById = new Map(graph.nodes.map(n => [n.id, n]));
  const related = graph.edges.filter(e => (e.from === node.id || e.to === node.id) && !e.id.startsWith('e:world'))
    .map(e => ({ edge: e, other: nodesById.get(e.from === node.id ? e.to : e.from) }))
    .filter(({ edge, other }) => other && edge.fromPort !== 'governs');
  const unique = related.filter((x, i) => related.findIndex(y => y.other!.id === x.other!.id && (y.edge.from === node.id) === (x.edge.from === node.id)) === i);
  return (
    <section className="mb-1 shrink-0 border-b border-white/[0.06] pb-2" aria-label={t('blueprint.workspace.context')}>
      {ownerControl ? (
        <div className="flex min-w-0 items-center gap-1.5 py-0.5 text-[11px] text-muted-foreground">
          {owner ? <Boxes className="h-3.5 w-3.5 shrink-0" /> : <Globe2 className="h-3.5 w-3.5 shrink-0" />}
          <span className="shrink-0">{t(owner ? 'blueprint.workspace.local' : 'blueprint.workspace.shared')}</span>
          {ownerControl}
          {owner && <button type="button" onClick={() => jump(`module:${owner.id}`)} title={t('blueprint.navigation.showInBlueprint')} aria-label={t('blueprint.navigation.showInBlueprint')} className={moduleLinkClass}><ArrowUpRight className="h-3 w-3" /></button>}
          {enabledControl}
        </div>
      ) : owner ? (
        <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          <Boxes className="h-3.5 w-3.5 shrink-0" />
          <span className="shrink-0">{t('blueprint.workspace.local')}</span>
          <span className="text-border" aria-hidden="true">/</span>
          <button type="button" onClick={() => jump(`module:${owner.id}`)} title={owner.name} className={moduleLinkClass}>
            <span className="block truncate">{owner.name}</span>
          </button>
          {enabledControl}
        </div>
      ) : modules.length > 0 ? (
        <details className="group/members">
          <summary className={summaryClass} title={t('blueprint.workspace.sharedHint', { count: modules.length })}>
            <Globe2 className="h-3.5 w-3.5 shrink-0" />
            <span>{t('blueprint.workspace.shared')}</span>
            <span className="text-muted-foreground/60">· {modules.length}</span>
            <ChevronRight className="ml-auto h-3 w-3 transition-transform group-open/members:rotate-90" />
          </summary>
          <div className="flex flex-wrap gap-x-1 gap-y-0.5 pb-1 pl-5">
            {modules.map(m => <button key={m.id} type="button" onClick={() => jump(`module:${m.id}`)} title={m.name} className={moduleLinkClass}>{m.name}</button>)}
          </div>
        </details>
      ) : (
        <div className="flex items-center gap-1.5 py-1 text-[11px] text-muted-foreground"><Globe2 className="h-3.5 w-3.5" />{t('blueprint.workspace.shared')}{enabledControl}</div>
      )}
      {unique.length > 0 && (
        <details className="group/references">
          <summary className={summaryClass}>
            <ArrowUpRight className="h-3.5 w-3.5 shrink-0" />
            <span>{t('blueprint.workspace.references', { count: unique.length })}</span>
            <ChevronRight className="ml-auto h-3 w-3 transition-transform group-open/references:rotate-90" />
          </summary>
          <div className="space-y-0.5 pb-1 pt-1">
            {unique.map(({ edge, other }) => (
              <button key={edge.id} type="button" onClick={() => jump(other!.id)} className="flex w-full items-start gap-2 rounded-md px-1.5 py-1.5 text-left text-[11px] transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
                {edge.from === node.id ? <ArrowUpRight className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" /> : <ArrowDownLeft className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />}
                <span className="min-w-0 flex-1 break-words text-foreground/80">{other!.title}</span>
                <span className="shrink-0 text-[10px] text-muted-foreground">{t(edge.toPort === 'write' ? 'blueprint.workspace.writes' : edge.toPort === 'activate' ? 'blueprint.workspace.activates' : edge.from === node.id ? 'blueprint.workspace.outgoing' : 'blueprint.workspace.incoming')}</span>
              </button>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}
