import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  DockviewDefaultTab,
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanel,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
} from "dockview-react";

/**
 * The page and its tools, docked the way the Studio's panels always were:
 * the page (canvas or full editor) is the middle panel, and each tool — the
 * assistant, the playtest — is a tab that can be dragged onto any edge of any
 * panel to split it, or into another panel to share its tabs; the lines
 * between panels drag to resize. This is the default, not a layout to switch
 * to. Where each tool was docked is remembered per surface and per tool, so
 * closing one and opening it again puts it back.
 *
 * Its styles (dockview.css, studio-theme.css) are imported by the page shells
 * that mount it, so tests that render the stage never load a stylesheet.
 */

export type DockTool = {
  id: string;
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  defaultPosition?: DockPosition;
  /** Keep the tool alive while its tab is closed — the assistant keeps a
   *  half-typed message and its scroll through a lesson or an inspector
   *  detour, as it did when it was a column that only hid. */
  keepMounted?: boolean;
  /** Changing this brings the tool's tab to the front (a new change to
   *  inspect, say, while the review tab sits behind another). */
  focusKey?: string | number;
};

type Direction = "left" | "right" | "above" | "below";
type DockPosition =
  | { direction: Direction; size: number; nextTo?: string }
  | { withTool: string }
  | { withMain: true };

const MAIN_ID = "main";
const MIN_SIZE = 260;

const MainContext = createContext<ReactNode>(null);
type ToolsValue = {
  content: Record<string, ReactNode>;
  /** A kept-mounted tool's content lives in this element; its tab borrows it. */
  holder: (id: string) => HTMLElement | null;
  park: (el: HTMLElement) => void;
};
const ToolsContext = createContext<ToolsValue>({ content: {}, holder: () => null, park: () => {} });

function MainPanel() {
  return <div className="flex h-full w-full min-h-0 min-w-0">{useContext(MainContext)}</div>;
}
function ToolPanel(props: IDockviewPanelProps<{ toolId: string }>) {
  const { content, holder, park } = useContext(ToolsContext);
  const id = props.params.toolId;
  const slot = useRef<HTMLDivElement>(null);
  const kept = holder(id);
  useLayoutEffect(() => {
    const el = slot.current;
    if (!kept || !el) return;
    el.appendChild(kept);
    return () => park(kept);
  }, [kept, park]);
  return <div ref={slot} className="flex h-full w-full min-h-0 min-w-0 flex-col bg-background">{kept ? null : content[id]}</div>;
}
const COMPONENTS = { main: MainPanel, tool: ToolPanel };
const TAB_COMPONENTS = {
  // The page is not something you close; it is what the tools are for.
  pinned: (props: IDockviewPanelHeaderProps) => <DockviewDefaultTab {...props} hideClose />,
};

function positionKey(scope: string, id: string) { return `yumina-dock:${scope}:${id}`; }
function readPosition(scope: string, tool: DockTool): DockPosition {
  try {
    const raw = localStorage.getItem(positionKey(scope, tool.id));
    if (raw) return JSON.parse(raw) as DockPosition;
  } catch { /* blocked storage or an old value: fall back to the default */ }
  return tool.defaultPosition ?? { direction: "right", size: 400 };
}

/** Where a tool panel sits relative to the page, in terms that survive the
 *  panel being closed: beside another tool, inside the page's tabs, or on one
 *  side of the page at some size. */
function describePosition(api: DockviewApi, panel: IDockviewPanel, toolIds: Set<string>): DockPosition | null {
  const group = panel.group;
  const mainGroup = api.getPanel(MAIN_ID)?.group;
  if (!group || !mainGroup) return null;
  const neighbour = group.panels.find(p => p.id !== panel.id && toolIds.has(p.id));
  if (neighbour) return { withTool: neighbour.id };
  if (group.id === mainGroup.id) return { withMain: true };
  const a = group.element.getBoundingClientRect();
  const m = mainGroup.element.getBoundingClientRect();
  // A layout being torn down (navigating away) measures as nothing; that is
  // not where the creator put anything.
  if (a.width < 1 || a.height < 1 || m.width < 1 || m.height < 1) return null;
  // Sharing a column (or row) with another tool: remember that edge, so it
  // comes back above / beside that tool rather than beside the page.
  const near = (x: number, y: number) => Math.abs(x - y) < 4;
  for (const other of api.panels) {
    if (other.id === panel.id || !toolIds.has(other.id) || !other.group || other.group.id === group.id) continue;
    const b = other.group.element.getBoundingClientRect();
    if (b.width < 1 || b.height < 1) continue;
    if (near(a.left, b.left) && near(a.width, b.width)) {
      if (near(a.bottom, b.top)) return { direction: "above", size: Math.round(a.height), nextTo: other.id };
      if (near(a.top, b.bottom)) return { direction: "below", size: Math.round(a.height), nextTo: other.id };
    }
    if (near(a.top, b.top) && near(a.height, b.height)) {
      if (near(a.right, b.left)) return { direction: "left", size: Math.round(a.width), nextTo: other.id };
      if (near(a.left, b.right)) return { direction: "right", size: Math.round(a.width), nextTo: other.id };
    }
  }
  const dx = (a.left + a.width / 2) - (m.left + m.width / 2);
  const dy = (a.top + a.height / 2) - (m.top + m.height / 2);
  if (Math.abs(dx) >= Math.abs(dy)) return { direction: dx < 0 ? "left" : "right", size: Math.round(a.width) };
  return { direction: dy < 0 ? "above" : "below", size: Math.round(a.height) };
}

export function DockWorkspace({ scope, mainTitle, tools, className, children }: {
  scope: string;
  mainTitle: string;
  tools: DockTool[];
  className?: string;
  children: ReactNode;
}) {
  const apiRef = useRef<DockviewApi | null>(null);
  const toolsRef = useRef(tools);
  toolsRef.current = tools;
  /** Set while this component itself removes a panel, so the removal is not
   *  mistaken for the creator closing the tab. */
  const removing = useRef(false);

  const rememberAll = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    const ids = new Set(toolsRef.current.map(t => t.id));
    for (const tool of toolsRef.current) {
      const panel = api.getPanel(tool.id);
      if (!panel) continue;
      const pos = describePosition(api, panel, ids);
      if (pos) { try { localStorage.setItem(positionKey(scope, tool.id), JSON.stringify(pos)); } catch { /* lasts this visit */ } }
    }
  }, [scope]);

  /** The page's own tab row only shows once a tool shares its panel. */
  const tidyHeaders = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    for (const group of api.groups) {
      group.header.hidden = group.panels.length === 1 && group.panels[0]!.id === MAIN_ID;
    }
  }, []);

  const addTool = useCallback((tool: DockTool) => {
    const api = apiRef.current;
    if (!api || api.getPanel(tool.id)) return;
    const pos = readPosition(scope, tool);
    const base = { id: tool.id, component: "tool", title: tool.title, params: { toolId: tool.id }, minimumWidth: MIN_SIZE, minimumHeight: 160 } as const;
    if ("withTool" in pos && api.getPanel(pos.withTool)) {
      api.addPanel({ ...base, position: { referencePanel: pos.withTool, direction: "within" } });
      return;
    }
    if ("withMain" in pos) {
      api.addPanel({ ...base, position: { referencePanel: MAIN_ID, direction: "within" } });
      return;
    }
    const side = "direction" in pos ? pos : (tool.defaultPosition && "direction" in tool.defaultPosition ? tool.defaultPosition : { direction: "right" as const, size: 400 });
    const reference = "nextTo" in side && side.nextTo && api.getPanel(side.nextTo) ? side.nextTo : MAIN_ID;
    const panel = api.addPanel({ ...base, position: { referencePanel: reference, direction: side.direction } });
    // A remembered size is a pixel count from some other window: one saved
    // on a wide screen came back on a laptop as most of the page, and the
    // canvas the tools are for was a strip. It never takes more than this.
    const room = side.direction === "left" || side.direction === "right" ? window.innerWidth * 0.42 : window.innerHeight * 0.6;
    const size = Math.max(MIN_SIZE, Math.min(side.size, Math.round(room)));
    panel.group?.api.setSize(side.direction === "left" || side.direction === "right" ? { width: size } : { height: size });
  }, [scope]);

  const reconcile = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    rememberAll();
    for (const tool of toolsRef.current) {
      const panel = api.getPanel(tool.id);
      if (tool.open && !panel) addTool(tool);
      else if (!tool.open && panel) {
        removing.current = true;
        try { api.removePanel(panel); } finally { removing.current = false; }
      } else if (panel && panel.title !== tool.title) panel.setTitle(tool.title);
    }
    tidyHeaders();
  }, [addTool, rememberAll, tidyHeaders]);

  const onReady = useCallback((event: DockviewReadyEvent) => {
    const api = event.api;
    apiRef.current = api;
    api.addPanel({ id: MAIN_ID, component: "main", title: mainTitle, tabComponent: "pinned", minimumWidth: 360 });
    api.onDidLayoutChange(() => { rememberAll(); tidyHeaders(); });
    api.onDidRemovePanel(panel => {
      if (removing.current) return;
      toolsRef.current.find(t => t.id === panel.id)?.onClose();
    });
    reconcile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openKey = tools.map(t => `${t.id}:${t.open ? 1 : 0}:${t.title}`).join(",");
  useEffect(() => { reconcile(); }, [openKey, reconcile]);
  const focusKey = tools.map(t => `${t.id}:${t.focusKey ?? ""}`).join(",");
  const lastFocus = useRef<Record<string, string | number | undefined>>({});
  useEffect(() => {
    for (const tool of toolsRef.current) {
      if (tool.focusKey === undefined || lastFocus.current[tool.id] === tool.focusKey) continue;
      lastFocus.current[tool.id] = tool.focusKey;
      apiRef.current?.getPanel(tool.id)?.api.setActive();
    }
  }, [focusKey]);
  useEffect(() => {
    const main = apiRef.current?.getPanel(MAIN_ID);
    if (main && main.title !== mainTitle) main.setTitle(mainTitle);
  }, [mainTitle]);
  // Positions are saved as the layout changes; by unmount the panels may
  // already be detached and measure as nothing.
  useEffect(() => () => { apiRef.current = null; }, []);

  // Kept-mounted tools render once into a holder that moves between their tab
  // and a hidden parking spot, so React never sees them unmount.
  const parking = useRef<HTMLDivElement>(null);
  const holders = useRef<Record<string, HTMLDivElement>>({});
  const [everOpen, setEverOpen] = useState<Record<string, true>>({});
  useEffect(() => {
    const opened = tools.filter(t => t.keepMounted && t.open && !everOpen[t.id]);
    if (opened.length) setEverOpen(prev => ({ ...prev, ...Object.fromEntries(opened.map(t => [t.id, true as const])) }));
  }, [tools, everOpen]);
  const holderFor = useCallback((id: string) => {
    if (!toolsRef.current.find(t => t.id === id)?.keepMounted || typeof document === "undefined") return null;
    let el = holders.current[id];
    if (!el) {
      el = document.createElement("div");
      el.className = "flex h-full w-full min-h-0 min-w-0 flex-col";
      holders.current[id] = el;
      parking.current?.appendChild(el);
    }
    return el;
  }, []);
  const park = useCallback((el: HTMLElement) => { parking.current?.appendChild(el); }, []);

  const toolContent: Record<string, ReactNode> = {};
  for (const tool of tools) if (tool.open) toolContent[tool.id] = tool.children;
  const toolsValue: ToolsValue = { content: toolContent, holder: holderFor, park };

  return (
    <MainContext.Provider value={children}>
      <ToolsContext.Provider value={toolsValue}>
        <div ref={parking} hidden data-dock-parking />
        {tools.filter(t => t.keepMounted && (t.open || everOpen[t.id])).map(t => {
          const el = holderFor(t.id);
          return el ? createPortal(t.children, el, t.id) : null;
        })}
        <div className={className} data-dock-workspace={scope}>
          <DockviewReact
            className="dockview-theme-yumina h-full w-full"
            components={COMPONENTS}
            tabComponents={TAB_COMPONENTS}
            onReady={onReady}
            defaultRenderer="always"
            disableFloatingGroups
          />
        </div>
      </ToolsContext.Provider>
    </MainContext.Provider>
  );
}
