/**
 * The canvas on a phone.
 *
 * The same board the computer draws — the card's tile, its situations beside
 * it, the wires between them, the assistant's glow on the block it is
 * changing — panned with a finger and pinched to see the whole of it. What a
 * phone cannot do is write in place: a row opened on a 390px board covers the
 * board it was opened from. So every row is its name (the board's glance,
 * always), and a tap opens what was tapped on a page of its own, in the same
 * editor the desktop board's column uses — one form, two screens. Back comes
 * back to the board exactly where it was: the page stands over it, and the
 * board underneath never unmounts.
 *
 * (The first phone canvas, 10/20, drew modules as a list of cards with no
 * wires; the owner: 「不够画布」. The board is the point.)
 */
import { TemplateBlanksChip } from "./components/template-blanks-chip";
import { useCallback, useEffect, useMemo, useState, type MutableRefObject } from "react";
import { useTranslation } from "react-i18next";
import { blockId, blockIdForNode, isBlockId, toGraph, type GraphNode } from "@yumina/engine";
import { useEditorStore } from "@/stores/editor";
import { cn } from "@/lib/utils";
import { BlueprintCanvasCore } from "./panels/blueprint-panel";
import { BlueprintInspector, type InspectorTarget } from "./panels/blueprint/inspector";
import { resolveCanvasInspectorNode } from "./panels/blueprint/canvas-inspector-target";
import { placeAis } from "./panels/blueprint/place-ais";
import { LEARNING_PANEL_EVENT, LEARNING_PHONE_OPEN_EVENT } from "./learn/learning-catalog";

type Translate = (key: string, opts?: Record<string, unknown>) => string;

/** Switch the phone shell to one of its panels (it listens for the guide's
 *  request, which carries the same panel ids). */
function showPanel(panelId: string) {
  window.dispatchEvent(new CustomEvent(LEARNING_PANEL_EVENT, { detail: { panelId } }));
}

/** The list kinds a block id names, read off its tail (`…:lore:keywords`,
 *  `…:state`): the title of a block's full-list page. */
function blockTitleKey(id: string): string | null {
  const parts = id.split(":");
  const lore = parts.indexOf("lore");
  if (lore >= 0) return `blueprint.blocks.lore.${parts[lore + 1] ?? "manual"}`;
  const kind = parts[parts.length - 1];
  if (kind === "openings") return "blueprint.frame.shelf.opening";
  return kind && ["state", "behavior", "audio", "image"].includes(kind) ? `blueprint.blocks.${kind}` : null;
}

export function MobileBoard({ bottomInset = 0, backRef, onPageChange }: {
  /** Room the assistant's drawer keeps at the foot of the screen. */
  bottomInset?: number;
  /** The shell's back arrow steps out of an open page before it leaves Studio. */
  backRef?: MutableRefObject<(() => boolean) | null>;
  onPageChange?: (open: boolean) => void;
}) {
  const { t } = useTranslation("editor");
  const worldDraft = useEditorStore((s) => s.worldDraft);
  const readOnly = useEditorStore((s) => s.readOnlyInspect || s.guestMode);
  const applyGraphPatch = useEditorStore((s) => s.applyGraphPatch);
  const [stack, setStack] = useState<string[]>([]);
  /** The board's tools (加东西, 情境目录, search, 视图), floating in its top
   *  corner as icons — a row of their own was a strip of screen the board
   *  never got back. A fixed width because it is a size container: the
   *  toolbar's labels drop at narrow widths (@max-[46rem]) and only the
   *  icons stay. */
  const [toolbarHost, setToolbarHost] = useState<HTMLElement | null>(null);
  const open = useCallback((id: string) => {
    // The interface has its own builder, a panel of the shell.
    if (id === "frontend" || id === blockId.frontend) { showPanel("frontend"); return; }
    setStack((s) => (s[s.length - 1] === id ? s : [...s, id]));
  }, []);
  const pop = useCallback(() => setStack((s) => s.slice(0, -1)), []);
  // A new card is a new board: nothing of the last one stays open.
  useEffect(() => { setStack([]); }, [worldDraft.id]);
  // The guide opens its sample the way a tap would.
  useEffect(() => {
    const show = (event: Event) => {
      const { objectId } = (event as CustomEvent<{ objectId: string }>).detail;
      if (objectId) open(objectId);
    };
    window.addEventListener(LEARNING_PHONE_OPEN_EVENT, show);
    return () => window.removeEventListener(LEARNING_PHONE_OPEN_EVENT, show);
  }, [open]);
  // A lesson about the board itself brings the board back: pages a lesson
  // opened earlier would otherwise stand over the thing being taught.
  useEffect(() => {
    const back = (event: Event) => {
      const { panelId } = (event as CustomEvent<{ panelId: string }>).detail;
      if (panelId === "board" || panelId === "blueprint") setStack([]);
    };
    window.addEventListener(LEARNING_PANEL_EVENT, back);
    return () => window.removeEventListener(LEARNING_PANEL_EVENT, back);
  }, []);

  const graph = useMemo(() => toGraph(worldDraft, { foldPlainEntries: false }), [worldDraft]);

  const targetFor = useCallback((id: string): InspectorTarget | null => {
    if (id.startsWith("ai:")) {
      const key = id.slice(3);
      const places = [undefined, ...(worldDraft.worldbooks ?? []).map((b) => b.id)];
      for (const place of places) {
        const row = placeAis(worldDraft, place, t as unknown as Translate).rows
          .find((r) => r.key === key && !r.bookId && (r.code || r.codeAt || r.game));
        if (row) return { type: "codeAi", row };
      }
    }
    const resolved = resolveCanvasInspectorNode(id, graph.nodes);
    if (resolved) {
      const g = resolved.node;
      if (g.kind === "event") return null;
      return { type: "node", node: g, title: displayTitle(g, t as unknown as Translate), kindLabel: t(`blueprint.kinds.${g.kind}` as never), section: resolved.section };
    }
    // A list block as a whole ("N more"): everything it holds.
    const titleKey = isBlockId(id) ? blockTitleKey(id) : null;
    if (titleKey) {
      const rows = graph.nodes
        .filter((n) => blockIdForNode(n) === id || (id.endsWith(":openings") && n.kind === "greeting"))
        .map((n) => ({ id: n.id, title: displayTitle(n, t as unknown as Translate), kind: n.kind }));
      return { type: "block", blockId: id, title: t(titleKey as never), rows };
    }
    return null;
  }, [graph, worldDraft, t]);

  const page = stack[stack.length - 1];
  const target = page ? targetFor(page) : null;
  // Deleted from its own page (the ⋯ menu), or never had one: step back.
  useEffect(() => { if (page && !target) pop(); }, [page, target, pop]);

  const phone = useMemo(() => ({ onOpen: open }), [open]);
  const pageOpen = stack.length > 0;
  useEffect(() => { onPageChange?.(pageOpen); }, [pageOpen, onPageChange]);
  useEffect(() => {
    if (!backRef) return;
    backRef.current = () => {
      if (!pageOpen) return false;
      pop();
      return true;
    };
    return () => { backRef.current = null; };
  }, [backRef, pageOpen, pop]);

  return (
    <div className="relative h-full min-h-0" data-mobile-board="">
      <div className="absolute inset-x-0 top-0" style={{ bottom: bottomInset }} aria-hidden={page ? true : undefined}>
        <BlueprintCanvasCore
          phone={phone}
          onDrillPanel={(panelId) => showPanel(panelId)}
          active={!page}
          edgeInsets={{ left: 0, right: 0 }}
          toolbarHost={toolbarHost}
        />
      </div>
      <div
        ref={setToolbarHost}
        data-phone-board-toolbar=""
        className={cn(
          "studio-pill absolute left-2 top-2 z-20 w-[244px] rounded-xl border p-0.5 shadow-lg backdrop-blur [container-type:inline-size]",
          (page || readOnly) && "hidden",
        )}
      />
      {/* 「还差 2 项」 on the board's free corner: the top bar is the card's
          name, and on a phone there is no width left in it. */}
      {!page && <TemplateBlanksChip className="studio-pill absolute right-2 top-2 z-20 rounded-xl py-2 shadow-lg backdrop-blur" />}
      {page && target && (
        // Above the assistant's drawer, like the board: under it the page's
        // last lines sat behind the peek and read as cut off.
        <div className="studio-canvas absolute inset-x-0 top-0 z-30 flex min-h-0 flex-col bg-background" style={{ bottom: bottomInset }} data-mobile-board-page={page}>
          <BlueprintInspector
            key={page}
            target={target}
            world={worldDraft}
            graph={graph}
            readOnly={readOnly}
            onPatch={applyGraphPatch}
            onDrill={(panelId) => showPanel(panelId)}
            onClose={pop}
            onOpenMemory={(id) => open(blockId.context(id))}
            onOpenModule={(id) => open(`module:${id}`)}
            onOpenObject={open}
          />
        </div>
      )}
    </div>
  );
}

function displayTitle(g: GraphNode, t: Translate): string {
  if (g.id === "frontend") return t("blueprint.nodes.frontend");
  if (g.id === "core-entries") return t("blueprint.nodes.coreEntries");
  if (g.id.startsWith("module-entries:")) return t("blueprint.nodes.moduleEntries");
  return g.title?.trim() || t("blueprint.mobile.untitled");
}
