import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useOnViewportChange, useReactFlow, useViewport } from "@xyflow/react";
import { editorClientId } from "@/stores/editor";
import { targetIdAt } from "@/features/studio/panels/blueprint/sticky-note-layer";
import { collabApi } from "./collab-api";
import { peerColor, useCollabStore, type PeerCursor } from "./collab-store";

/** At most this often while the pointer moves (Figma-like, ~12 a second). */
const SEND_EVERY_MS = 80;
/** A still pointer stays on screen this long, then fades. */
const CURSOR_STALE_MS = 30_000;
/** Followers get the view even when nothing moves, so they land somewhere. */
const VIEW_HEARTBEAT_MS = 4_000;
/** No view for this long: the person is not on the board (another editor, a phone). */
const VIEW_GONE_MS = 3 * VIEW_HEARTBEAT_MS;

type View = { x: number; y: number; zoom: number };

/** The canvas id an edit target stands at ("entries:e1" → "entry:e1"). */
const TARGET_PREFIX: Record<string, string> = {
  entries: "entry", variables: "var", reactions: "reaction", rules: "rule", audioTracks: "audio", customUI: "custom",
};
export function canvasIdForTarget(target: string): string {
  const i = target.indexOf(":");
  if (i < 0) return target;
  const prefix = TARGET_PREFIX[target.slice(0, i)];
  return prefix ? `${prefix}:${target.slice(i + 1)}` : target;
}

const esc = (s: string) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s.replace(/"/g, '\\"'));
function elementFor(root: Element, id: string): Element | null {
  if (id.startsWith("ai:")) return root.querySelector(`[data-place-ai="${esc(id.slice(3))}"]`);
  return root.querySelector(`[data-row-anchor="${esc(id)}"]`)
    ?? root.querySelector(`[data-canvas-writing-object="${esc(id)}"]`)
    ?? root.querySelector(`.react-flow__node[data-id="${esc(id)}"]`);
}

/**
 * Everyone else on the board, like Figma: their pointer with their name, an
 * outline in their colour round what they have selected, and — after a click
 * on their face in the header — your view following theirs. Mounted inside
 * the board's ReactFlow; sends nothing while you are alone on the card.
 */
export function LiveCursors({ worldId, containerRef }: { worldId: string | null; containerRef: RefObject<HTMLElement | null> }) {
  const rf = useReactFlow();
  const alone = useCollabStore((s) => Object.keys(s.peers).length === 0);
  const sel = useRef<string | null>(null);
  const pending = useRef<{ x?: number; y?: number; out?: boolean } | null>(null);
  const lastSent = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const viewNow = useCallback((): View | undefined => {
    const box = containerRef.current?.getBoundingClientRect();
    if (!box || !box.width) return undefined;
    const c = rf.screenToFlowPosition({ x: box.left + box.width / 2, y: box.top + box.height / 2 });
    return { x: Math.round(c.x), y: Math.round(c.y), zoom: Math.round(rf.getViewport().zoom * 1000) / 1000 };
  }, [rf, containerRef]);

  const flush = useCallback(() => {
    timer.current = null;
    if (!worldId || useCollabStore.getState().worldId !== worldId) return;
    lastSent.current = Date.now();
    const p = pending.current ?? {};
    pending.current = null;
    collabApi.cursor(worldId, { clientId: editorClientId, ...p, sel: sel.current, view: viewNow() });
  }, [worldId, viewNow]);

  const queue = useCallback((next: { x?: number; y?: number; out?: boolean } | null) => {
    if (alone || !worldId) return;
    pending.current = { ...pending.current, ...next };
    if (timer.current) return;
    timer.current = setTimeout(flush, Math.max(0, SEND_EVERY_MS - (Date.now() - lastSent.current)));
  }, [alone, worldId, flush]);

  // Pointer, and what was last clicked on the board.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || alone) return;
    const move = (e: PointerEvent) => {
      const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      queue({ x: Math.round(p.x), y: Math.round(p.y), out: false });
    };
    const leave = () => queue({ out: true });
    const down = (e: PointerEvent) => {
      const id = targetIdAt(e.clientX, e.clientY);
      if (id !== sel.current) { sel.current = id; queue({}); }
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerleave", leave);
    el.addEventListener("pointerdown", down, true);
    return () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", leave);
      el.removeEventListener("pointerdown", down, true);
    };
  }, [containerRef, rf, alone, queue]);

  // Typing in something marks it selected too (the editor reports each edit).
  useEffect(() => {
    const onEdit = (raw: Event) => {
      const target = (raw as CustomEvent<{ target: string }>).detail?.target;
      if (!target) return;
      const id = canvasIdForTarget(target);
      if (id !== sel.current) { sel.current = id; queue({}); }
    };
    window.addEventListener("yumina:local-edit", onEdit);
    return () => window.removeEventListener("yumina:local-edit", onEdit);
  }, [queue]);

  // The view, for anyone following; a slow heartbeat keeps it current.
  useOnViewportChange({ onChange: () => queue({}) });
  useEffect(() => {
    if (alone) return;
    queue({});
    const beat = setInterval(() => { if (document.visibilityState === "visible") queue({}); }, VIEW_HEARTBEAT_MS);
    return () => clearInterval(beat);
  }, [alone, queue]);

  // Clear the ref too: a remount (React's dev double-mount) keeps refs, and a
  // stale timer id would make queue() wait forever for a flush that never runs.
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); timer.current = null; }, []);

  // Faces in the header follow people only while this board is on screen.
  useEffect(() => {
    useCollabStore.getState().setCanFollow(true);
    return () => useCollabStore.getState().setCanFollow(false);
  }, []);

  return (
    <>
      <PeerLayer containerRef={containerRef} />
      <FollowFrame containerRef={containerRef} />
    </>
  );
}

function usePeerCursors(): PeerCursor[] {
  const cursors = useCollabStore((s) => s.cursors);
  const peers = useCollabStore((s) => s.peers);
  const [, tick] = useState(0);
  useEffect(() => { const i = setInterval(() => tick((n) => n + 1), 5_000); return () => clearInterval(i); }, []);
  const now = Date.now();
  return Object.values(cursors).filter((c) => peers[c.clientId] && now - c.at < CURSOR_STALE_MS);
}

/** Pointers and selection outlines. Drawn over the whole board (not inside
 *  its viewport, where blocks stack above them) at screen size: positions
 *  are board coordinates times the zoom, inside a layer the pan moves. */
function PeerLayer({ containerRef }: { containerRef: RefObject<HTMLElement | null> }) {
  const rf = useReactFlow();
  const { x: vx, y: vy, zoom } = useViewport();
  const cursors = usePeerCursors();
  const [boxes, setBoxes] = useState<Record<string, { x: number; y: number; w: number; h: number }>>({});

  const selKey = cursors.map((c) => `${c.clientId}=${c.sel ?? ""}`).join("|");
  useEffect(() => {
    const measure = () => {
      const root = containerRef.current?.querySelector(".react-flow") ?? containerRef.current;
      const next: Record<string, { x: number; y: number; w: number; h: number }> = {};
      for (const c of cursors) {
        if (!c.sel || !root) continue;
        const el = elementFor(root, c.sel);
        const r = el?.getBoundingClientRect();
        if (!r || (!r.width && !r.height)) continue;
        const a = rf.screenToFlowPosition({ x: r.left, y: r.top });
        const b = rf.screenToFlowPosition({ x: r.right, y: r.bottom });
        next[c.clientId] = { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
      }
      setBoxes((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    measure();
    if (cursors.every((c) => !c.sel)) return;
    // Rows move when the board relays itself out; keep the outlines on them.
    const i = setInterval(measure, 600);
    return () => clearInterval(i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selKey, rf, containerRef]);

  return (
    <div className="pointer-events-none absolute inset-0 z-[65] overflow-hidden" data-peer-layer>
      <div className="absolute left-0 top-0" style={{ transform: `translate(${vx}px, ${vy}px)` }}>
        {cursors.map((c) => {
          const color = peerColor(c.userId);
          const box = boxes[c.clientId];
          return (
            <div key={c.clientId}>
              {box && (
                <div
                  data-peer-selection={c.sel}
                  className="absolute rounded-md"
                  style={{ left: box.x * zoom - 3, top: box.y * zoom - 3, width: box.w * zoom + 6, height: box.h * zoom + 6, boxShadow: `0 0 0 2px ${color}` }}
                >
                  <span
                    className="absolute -top-[18px] left-0 whitespace-nowrap rounded-sm px-[5px] py-[3px] text-[11px] font-semibold leading-none text-white"
                    style={{ background: color }}
                  >{c.name}</span>
                </div>
              )}
              {c.x !== undefined && c.y !== undefined && !c.out && (
                <div
                  data-peer-cursor={c.name}
                  className="absolute"
                  style={{ left: c.x * zoom, top: c.y * zoom, transition: "left 110ms linear, top 110ms linear" }}
                >
                  <svg width="18" height="20" viewBox="0 0 18 20" aria-hidden style={{ display: "block", filter: "drop-shadow(0 1px 1px rgba(0,0,0,.35))" }}>
                    <path d="M2 1.5 L2 16.5 L6.2 12.6 L9.2 18.6 L11.6 17.5 L8.7 11.6 L14.6 11.6 Z" fill={color} stroke="#fff" strokeWidth="1.2" strokeLinejoin="round" />
                  </svg>
                  <span
                    className="absolute left-[14px] top-[16px] whitespace-nowrap rounded-[4px_10px_10px_10px] px-1.5 py-[2px] text-[11px] font-semibold leading-tight text-white shadow"
                    style={{ background: color }}
                  >{c.name}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Following someone: the board moves with their view, framed in their colour
 * with a bar saying whose, until you move the board yourself or press Esc.
 */
function FollowFrame({ containerRef }: { containerRef: RefObject<HTMLElement | null> }) {
  const { t } = useTranslation("editor");
  const rf = useReactFlow();
  const following = useCollabStore((s) => s.following);
  const setFollowing = useCollabStore((s) => s.setFollowing);
  const leader = useCollabStore((s) => {
    if (!s.following) return null;
    let best: PeerCursor | null = null;
    for (const c of Object.values(s.cursors)) if (c.userId === s.following && c.view && (!best || c.at > best.at)) best = c;
    return best;
  });
  const leaderName = useCollabStore((s) => Object.values(s.peers).find((p) => p.userId === s.following)?.name ?? null);
  // A view that stopped coming means they left the board; re-read every
  // couple of seconds so the bar can say so.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!following) return;
    setNow(Date.now());
    const i = setInterval(() => setNow(Date.now()), 2_000);
    return () => clearInterval(i);
  }, [following]);
  const onBoard = !!leader?.view && now - leader.at < VIEW_GONE_MS;
  const view = onBoard ? leader?.view : undefined;

  useEffect(() => {
    if (!following || !view) return;
    void rf.setCenter(view.x, view.y, { zoom: view.zoom, duration: 180 });
  }, [following, view?.x, view?.y, view?.zoom, rf]); // eslint-disable-line react-hooks/exhaustive-deps

  // They left, or you took the board back.
  useEffect(() => {
    if (following && !leaderName) setFollowing(null);
  }, [following, leaderName, setFollowing]);
  useEffect(() => {
    const el = containerRef.current;
    if (!following || !el) return;
    const stop = () => setFollowing(null);
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") stop(); };
    el.addEventListener("pointerdown", stop, true);
    el.addEventListener("wheel", stop, { capture: true, passive: true });
    window.addEventListener("keydown", key);
    return () => {
      el.removeEventListener("pointerdown", stop, true);
      el.removeEventListener("wheel", stop, true);
      window.removeEventListener("keydown", key);
    };
  }, [following, containerRef, setFollowing]);

  if (!following || !leaderName) return null;
  const color = peerColor(following);
  // They are on the card but not on this board: say so, without a frame
  // promising a view that isn't coming.
  return (
    <div
      data-follow-frame={onBoard ? "" : undefined}
      data-follow-away={onBoard ? undefined : ""}
      className="pointer-events-none absolute inset-0 z-[80]"
      style={onBoard ? { boxShadow: `inset 0 0 0 2px ${color}` } : undefined}
    >
      <div
        className="pointer-events-auto absolute left-1/2 top-0 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-b-md px-2.5 py-1 text-[11px] font-semibold text-white shadow"
        style={{ background: color }}
      >
        <span>{onBoard
          ? t("collab.following", { name: leaderName, defaultValue: "Following {{name}}" })
          : t("collab.notOnCanvas", { name: leaderName, defaultValue: "{{name}} isn't on the canvas" })}</span>
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setFollowing(null)}
          className="rounded px-1 underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-1 focus-visible:outline-white"
        >{t("collab.stopFollowing", "Stop")}</button>
      </div>
    </div>
  );
}
