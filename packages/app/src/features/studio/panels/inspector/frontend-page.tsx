import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import type { IDockviewPanelProps } from "dockview-react";
import { ChevronRight, ChevronUp, LayoutTemplate, MessageSquare, Monitor, MousePointerSquareDashed, PanelRight, Play, Plus, Smartphone, X } from "lucide-react";
import {
  addPage, boxOn, copyElements, findElementPage, fitTextOnPage, groupOf, nudgeElements, pasteElements, PromptBuilder,
  removeGroup, reorderElements, snapMove, snapResize, unitsOf, updateElements,
  UI_CANVAS_W, UI_DESKTOP_H, UI_DESKTOP_W,
} from "@yumina/engine";
import type { UiDoc, UiElement, UiGuide, WorldDefinition } from "@yumina/engine";
import { cn } from "@/lib/utils";
import { useEditorStore } from "@/stores/editor";
import { feedback } from "@/lib/feedback";
import { captureHubEvent } from "@/lib/analytics";
import { layoutChoiceArgs } from "../blueprint/look-actions";
import { LiveFrontendPreview, PREVIEW_GREETING_ATTR } from "@/features/editor/components/preview/live-frontend-preview";
import { resolvePreviewOpening } from "@/features/editor/components/preview/preview-opening";
import { OpeningHoverRing, OpeningOnScreenEditor, StoryNotes } from "./screen-first";
import { describeElement, IGNORE_ATTR, isInspectorOverlayTarget, nearestUiElementId } from "./hit-test";
import { ElementPanel, leadOf } from "./element-panel";
import { NewPageGallery } from "./new-page-gallery";
import { PageStrip } from "./page-strip";
import { UI_EDITOR_REQUEST_EVENT, takeUiEditorRequest, useAddPageTemplate } from "./new-page-hooks";
import { partKindKeys } from "./parts";
import { DragHandles, type DragDelta, type DragEdge, type Guide } from "./drag-handles";
import { InlineTextEditor, pageBoxOf, partClipboard } from "./canvas-selection";
import { FloatingTextBar } from "./floating-text-bar";
import { lookChanged, paintLive } from "./live-style";
import { coalesce } from "./style-section";
import { InspectSidebar } from "./inspect-sidebar";
import { useInspector, type Rect } from "./use-inspector";
import { isDefaultChatInterface } from "../blueprint/starter-state";
import { chatPageDoc } from "../../lib/ui-doc-takeover";
import { confirmLayoutReplace } from "../blueprint/look-actions";
import { selectAllOnPage } from "./selection-units";
import { phoneFitFor } from "./phone-fit";

/**
 * The frontend inspector — devtools pointed at the card the creator is making.
 *
 * The premise is that a creator can see their card but not read it. Everything
 * here exists to close that gap in one gesture: point at the thing that looks
 * wrong, and get either the line of code that draws it or an AI that already
 * knows which line you mean.
 *
 * Selection is DOM-exact and climbs by breadcrumb, deliberately. Snapping to
 * "meaningful blocks" was the other option and it fails the same way every
 * heuristic selection fails — when it guesses wrong there is no gesture that
 * argues with it. Devtools' behaviour is the one every creator has already
 * learned somewhere else.
 */

const VIEWPORTS = { desktop: null, phone: 390 } as const;
/** 「适应」 stops shrinking here and lets the stage scroll. */
const MIN_FIT_ZOOM = 0.6;
const ZOOM_STEPS = [0.25, 0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5, 2] as const;
function stepZoom(current: number, dir: 1 | -1): number {
  const list = dir > 0 ? ZOOM_STEPS : [...ZOOM_STEPS].reverse();
  return list.find((z) => (dir > 0 ? z > current + 0.001 : z < current - 0.001)) ?? current;
}
type Viewport = keyof typeof VIEWPORTS;

/** The element that stands for a grouped part (a meter's track, not its label). */
function unitLead(doc: UiDoc, el: UiElement): UiElement {
  if (!el.group) return el;
  const page = doc.pages.find((p) => p.elements.some((e) => e.id === el.id));
  return leadOf(page ? page.elements.filter((e) => e.group === el.group) : [el]);
}

export function FrontendPage({
  active = true,
  immersive = false,
  assistant,
  screenFirst = false,
}: Partial<IDockviewPanelProps> & {
  active?: boolean;
  /** Prototype (?screen=1): the opening is edited on the screen and the
   *  setting sits under it as notes. */
  screenFirst?: boolean;
  /** The editor's assistant column, which the player view covers — so it
   *  lends its toggle to the floating capsule rather than becoming
   *  unreachable the moment the page goes fullscreen. */
  assistant?: { open: boolean; toggle: () => void };
  /** Hosted as the whole screen rather than as a page inside the editor's
   *  frame: the toolbar leaves the flow and rides over the card instead, and
   *  the element panel floats rather than taking a column away from it. */
  immersive?: boolean;
} = {}) {
  const { t } = useTranslation("editor");
  const rootComponent = useEditorStore((s) => s.worldDraft.rootComponent);
  const uiDoc = useEditorStore((s) => s.worldDraft.uiDoc);
  const setUiDoc = useEditorStore((s) => s.setUiDoc);
  const readOnly = useEditorStore((s) => s.readOnlyInspect || s.guestMode);
  const entries = useEditorStore(s => s.worldDraft.entries);
  const defaultChat = isDefaultChatInterface({ rootComponent, uiDoc });
  // A bare chat edits like any arranged screen: the add-part menu works on
  // the chat as a page of parts, and the first part added makes it one (the
  // store compiles that first document). The inspector of raw markup a bare
  // chat used to open on was a developer's tool in a newcomer's first click.
  const bareChat = defaultChat && !uiDoc;
  const chatDoc = useMemo(
    () => (bareChat ? chatPageDoc(String(t("studio.pageTemplates.chatPageName"))) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one stand-in per bare spell, not per render
    [bareChat],
  );
  const panelDoc = uiDoc ?? chatDoc;
  const hasOpening = entries.some(entry => entry.role === "greeting" && entry.enabled && entry.content.trim());

  const stageRef = useRef<HTMLDivElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  /** The box the stage scrolls in (the frame `stageRef` sits inside). */
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const [stageBox, setStageBox] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState<"fit" | number>("fit");
  useLayoutEffect(() => {
    const el = scrollEl;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const cs = getComputedStyle(el);
      const w = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const h = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      setStageBox((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [scrollEl]);
  /** Which other canvas a just-added part was also placed on, for the hint. */
  const [placedHint, setPlacedHint] = useState<"phone" | "desktop" | null>(null);
  useEffect(() => {
    if (!placedHint) return;
    const timer = window.setTimeout(() => setPlacedHint(null), 8000);
    return () => window.clearTimeout(timer);
  }, [placedHint]);
  // A narrow screen edits the phone arrangement first: the desktop canvas
  // squeezed into 360px is 5px type, and the phone is what a phone is for.
  const [viewport, setViewport] = useState<Viewport>(() => (typeof window !== "undefined" && window.innerWidth < 768 ? "phone" : "desktop"));
  const [attachedRef, setAttachedRef] = useState<{ file: string; line: number } | null>(null);
  // The column is the toolbox of an ARRANGED card (a uiDoc with parts) — the
  // pages, 添加部件, the layers — so a creator who lands here to edit a screen
  // does not have to find it first. A bare chat has nothing for it to hold:
  // the layouts it once opened on live in the template gallery now, and the
  // colours in their own small menu. Screen-first opens on the screen alone.
  const [sidebarOpen, setSidebarOpen] = useState(!screenFirst && !defaultChat && !!uiDoc);
  // Below the two-column width the column is a sheet under the card. Open, it
  // took the lower half of a phone and left ~290px of card to edit; it now
  // rests as one row naming the selected part, and opens on a tap or an
  // upward swipe. A part being dragged folds it for the drag.
  const [sheetUp, setSheetUp] = useState(false);
  const [dragging, setDragging] = useState(false);
  const sheetSwipe = useRef<{ y: number; moved: boolean } | null>(null);
  const sidebarId = useId();
  const applyUiTemplate = useEditorStore((s) => s.applyUiTemplate);
  const cardName = useEditorStore((s) => s.worldDraft.name);
  // Which arrangement is on, read off the elements the layout installs rather
  // than from a flag: the creator can move, restyle and delete them afterwards,
  // and a doc that no longer holds the layout should stop claiming it does.
  const chooseLayout = useCallback(async (next: string | null) => {
    if (!(await confirmLayoutReplace(next, (key, options) => String(t(key as never, options as never))))) return;
    // Each layout declares the words and the variables it needs, so the picker
    // fetches exactly those rather than carrying a list that goes stale the
    // next time a layout is added.
    const { strings, names, defaults } = layoutChoiceArgs(next, (key, options) => String(t(key as never, options as never)), cardName);
    applyUiTemplate(next, strings, names, defaults);
    captureHubEvent("studio_look_applied", { world_id: useEditorStore.getState().serverWorldId ?? "", kind: "layout", id: next ?? "none" });
    // What the previous layout left behind, offered — the pill stays until the
    // creator clears them or closes it, and a further switch replaces it.
    dismissLeftoversPill.current?.();
    dismissLeftoversPill.current = null;
    const leftovers = useEditorStore.getState().templateLeftovers;
    if (leftovers && leftovers.variableIds.length > 0) {
      dismissLeftoversPill.current = feedback.persistent(
        t("studio.layout.leftovers", { count: leftovers.variableIds.length }),
        { label: t("studio.layout.leftoversDiscard"), onClick: () => useEditorStore.getState().discardTemplateLeftovers() },
      );
    }
  }, [applyUiTemplate, cardName, t]);
  const dismissLeftoversPill = useRef<(() => void) | null>(null);
  useEffect(() => () => { dismissLeftoversPill.current?.(); }, []);

  const variables = useEditorStore((s) => s.worldDraft.variables);
  const addMeterVariable = useCallback(
    (name: string) => {
      // The meter's own variable: named like its label (a second one takes
      // "… 2"), 0–100 from 50, and owned by the interface — deleting the meter
      // takes it along unless something else has started reading it.
      const store = useEditorStore.getState();
      const made = store.makeAutoVariable(name, "number", 50);
      const index = useEditorStore.getState().worldDraft.variables.findIndex((v) => v.id === made.id);
      if (index >= 0) useEditorStore.getState().updateVariableAt(index, { min: 0, max: 100 });
      return made;
    },
    [],
  );

  const inspector = useInspector(stageRef, previewRef);
  const { picking, setPicking, selected, select, move, hoverRect, selectedRect, chain } = inspector;

  // The card's openings as "切换开场白" counts them: the same filter and order
  // the server builds the greeting's swipes from, so index N here is swipe N
  // in the player's chat.
  const greetingOptions = useMemo(
    () => new PromptBuilder()
      .buildGreetingEntries({ entries } as unknown as WorldDefinition)
      .map((entry, index) => ({
        index,
        id: entry.id,
        label: `${index + 1} · ${entry.name?.trim() || entry.content.trim().slice(0, 24)}`,
      })),
    [entries],
  );
  const audioTracks = useEditorStore((s) => s.worldDraft.audioTracks);
  const serverWorldId = useEditorStore((s) => s.serverWorldId);
  // Picking stays live while a part is selected. The picker's own click is a
  // one-shot (use-inspector disarms it), but a creator who has just selected
  // a meter and then clicks the title next to it means "that one now", not
  // "press the title's button". So every click while the inspector holds a
  // selection is a pick, and shift adds. Escape, or closing the panel, hands
  // the card back to itself.
  //
  // An arranged card is always being edited, the way a slide is: every click
  // points at a part, and there is no "arm the picker first" step between the
  // creator and the thing they want to move.
  //
  // 「编辑」 is that mode, and it starts on. Turning it off hands the card back
  // to itself — tap its buttons, fill its form — without leaving the page.
  const [editOn, setEditOn] = useState(true);
  const pickingActive = active && (picking || !!selected || (!!uiDoc && editOn));

  // ── Screen-first: the opening is typed where it shows. ──
  const [openingEdit, setOpeningEdit] = useState<{ id: string; rect: Rect } | null>(null);
  const [openingHover, setOpeningHover] = useState<Rect | null>(null);
  const openingOnScreen = screenFirst && active && !readOnly;
  const openingNodeFrom = (event: { nativeEvent: Event }): HTMLElement | null => {
    if (!openingOnScreen) return null;
    for (const node of event.nativeEvent.composedPath()) {
      if (node instanceof HTMLElement && node.hasAttribute(PREVIEW_GREETING_ATTR)) return node;
    }
    return null;
  };
  const rectOnStage = (node: HTMLElement): Rect | null => {
    const frame = stageRef.current?.getBoundingClientRect();
    if (!frame) return null;
    const r = node.getBoundingClientRect();
    return { left: r.left - frame.left, top: r.top - frame.top, width: r.width, height: r.height };
  };
  const openOpeningEditor = (event: React.MouseEvent): boolean => {
    const node = openingNodeFrom(event);
    const opening = node ? resolvePreviewOpening(entries) : null;
    const rect = node ? rectOnStage(node) : null;
    if (!node || !opening || !rect) return false;
    event.preventDefault();
    event.stopPropagation();
    select(null);
    setExtraIds([]);
    setOpeningHover(null);
    setOpeningEdit({ id: opening.id, rect });
    return true;
  };

  // The click lands on whatever is inside a compiled element — the span of a
  // label, the div painting a track — so the panel is told the nearest stamped
  // ancestor rather than the exact node.
  const selectedUiElementId = useMemo(
    () => (selected ? nearestUiElementId(selected, previewRef.current) : null),
    [selected],
  );

  // ── More than one part at a time ──────────────────────────────────────
  //
  // Shift adds and removes; a plain click replaces. The extras are held here
  // rather than in the inspector hook, which owns ONE DOM selection and drives
  // the highlight, the breadcrumb and the keyboard walk off it. The lead stays
  // that single selection, so none of that changes — `extraIds` is a set of
  // companions that every group-wide action includes.
  const [extraIds, setExtraIds] = useState<string[]>([]);
  // Shift, Ctrl or ⌘ — every design tool's "add to the selection".
  const shiftHeld = useRef(false);
  /** Set when the selection is replaced wholesale (marquee, paste, layers):
   *  the next lead change keeps the companions it was given. */
  const keepExtras = useRef(false);
  /** The click that made the current pick held a modifier. */
  const additivePick = useRef(false);
  useEffect(() => {
    const track = (event: KeyboardEvent | MouseEvent) => { shiftHeld.current = event.shiftKey || event.ctrlKey || event.metaKey; };
    window.addEventListener("keydown", track);
    window.addEventListener("keyup", track);
    window.addEventListener("mousedown", track, true);
    return () => {
      window.removeEventListener("keydown", track);
      window.removeEventListener("keyup", track);
      window.removeEventListener("mousedown", track, true);
    };
  }, []);

  const previousLead = useRef<string | null>(null);
  useEffect(() => {
    // A shift-click keeps what was selected and adds the old lead to the
    // companions; a plain click starts over.
    if (keepExtras.current) { keepExtras.current = false; previousLead.current = selectedUiElementId; return; }
    // Read off the click itself, not a key tracker: the key can come up before
    // this effect runs, and the pick would then silently replace the set.
    const additive = additivePick.current || shiftHeld.current;
    additivePick.current = false;
    if (!additive) { setExtraIds([]); previousLead.current = selectedUiElementId; return; }
    const was = previousLead.current;
    previousLead.current = selectedUiElementId;
    if (!was || was === selectedUiElementId) return;
    setExtraIds((ids) => (ids.includes(was) || ids.includes(selectedUiElementId ?? "") ? ids : [...ids, was]));
  }, [selectedUiElementId]);

  /** Every element the current gesture acts on: the lead's group, plus the
   *  group of each companion. */
  const selectionIds = useMemo(() => {
    if (!uiDoc || !selectedUiElementId) return [];
    const pageId = findElementPage(uiDoc, selectedUiElementId);
    if (!pageId) return [];
    const out = new Set(groupOf(uiDoc, pageId, selectedUiElementId));
    for (const id of extraIds) {
      if (findElementPage(uiDoc, id) !== pageId) continue;
      for (const member of groupOf(uiDoc, pageId, id)) out.add(member);
    }
    return [...out];
  }, [uiDoc, selectedUiElementId, extraIds]);

  // ── The page being edited ─────────────────────────────────────────────
  //
  // A card with more than one page is edited one page at a time, and the
  // preview has to be showing that page — but the preview is the compiled
  // card, remounted on every edit, and it opens on the entry page. So the page
  // travels to it out of band: a window flag the compiled card reads when it
  // mounts, and an event for when it is already mounted. (The preview renders
  // into a shadow root in this window; a played card runs in its own iframe
  // and never sees either.) The same flag asks it to show parts hidden by a
  // condition faded rather than not at all, or they could not be clicked.
  const [editPageId, setEditPageId] = useState<string | null>(null);
  const currentPageId = uiDoc && editPageId && (uiDoc.pages ?? []).some((p) => p.id === editPageId)
    ? editPageId
    : uiDoc?.entryPageId ?? null;
  useEffect(() => {
    if (!uiDoc || !selectedUiElementId) return;
    const pageId = findElementPage(uiDoc, selectedUiElementId);
    if (pageId) setEditPageId(pageId);
  }, [uiDoc, selectedUiElementId]);
  useEffect(() => {
    const w = window as unknown as { __yuminaUiEditing?: boolean; __yuminaUiEditPage?: string | null };
    // …and which canvas is being arranged. Left to itself the stage picks by
    // the shape of its box, and in a narrow column the phone button drew the
    // desktop canvas (and the desktop one the phone).
    const flags = w as typeof w & { __yuminaUiEditCanvas?: "phone" | "desktop" | null };
    w.__yuminaUiEditing = active;
    w.__yuminaUiEditPage = active ? currentPageId : null;
    flags.__yuminaUiEditCanvas = active ? (viewport === "phone" ? "phone" : "desktop") : null;
    window.dispatchEvent(new CustomEvent("yumina:ui-edit-page", { detail: currentPageId }));
    return () => {
      w.__yuminaUiEditing = false;
      w.__yuminaUiEditPage = null;
      flags.__yuminaUiEditCanvas = null;
      window.dispatchEvent(new CustomEvent("yumina:ui-edit-page", { detail: null }));
    };
  }, [active, currentPageId, viewport]);
  // A button in the card that jumps pages moves the page picker with it.
  useEffect(() => {
    const onShown = (event: Event) => {
      const id = (event as CustomEvent).detail;
      if (typeof id === "string") setEditPageId(id);
    };
    window.addEventListener("yumina:ui-page-shown", onShown);
    return () => window.removeEventListener("yumina:ui-page-shown", onShown);
  }, []);
  const choosePage = useCallback((pageId: string) => {
    select(null);
    setEditPageId(pageId);
  }, [select]);

  // 新建一页: a ready-made function, or a blank page.
  const [galleryOpen, setGalleryOpen] = useState(false);
  /** Opened from the Templates button rather than for a new page. */
  const [galleryAsTemplates, setGalleryAsTemplates] = useState(false);
  // Asked for from the board: open on a page, or straight into the gallery.
  useEffect(() => {
    const take = () => {
      const request = takeUiEditorRequest();
      if (!request) return;
      if (request.pageId) { setEditOn(true); choosePage(request.pageId); }
      if (request.gallery) setGalleryOpen(true);
    };
    take();
    window.addEventListener(UI_EDITOR_REQUEST_EVENT, take);
    return () => window.removeEventListener(UI_EDITOR_REQUEST_EVENT, take);
  }, [choosePage]);
  const addPageTemplate = useAddPageTemplate();
  const pickNewPage = useCallback((id: import("@yumina/engine").UiPageTemplateId | "blank") => {
    setGalleryOpen(false);
    let pageId: string | null = null;
    if (id === "blank") {
      const store = useEditorStore.getState();
      if (!store.worldDraft.uiDoc) store.adoptUiDoc();
      const doc = useEditorStore.getState().worldDraft.uiDoc;
      if (!doc) return;
      pageId = `page-${crypto.randomUUID().slice(0, 8)}`;
      setUiDoc(addPage(doc, { id: pageId, name: t("studio.element.pageN", { n: (doc.pages ?? []).length + 1 }) }));
    } else {
      pageId = addPageTemplate(id);
    }
    if (!pageId) return;
    setEditOn(true);
    choosePage(pageId);
  }, [addPageTemplate, choosePage, setUiDoc, t]);

  // A part just added is selected as soon as the recompiled preview draws it,
  // so the next thing the creator sees is its controls, not a hunt for it.
  const pendingSelect = useRef<string | null>(null);
  const selectWhenDrawn = useCallback((elementId: string) => {
    pendingSelect.current = elementId;
    const started = Date.now();
    const look = () => {
      if (pendingSelect.current !== elementId) return;
      const found = findUiElementNode(previewRef.current, elementId);
      if (found) {
        pendingSelect.current = null;
        select(found);
        // On a phone the canvas scrolls; bring the new part into view.
        try { found.scrollIntoView({ block: "nearest", behavior: "smooth" }); } catch { /* old engines */ }
        return;
      }
      if (Date.now() - started < 4000) window.setTimeout(look, 120);
    };
    window.setTimeout(look, 120);
  }, [select]);

  /** Replace the selection with these parts: the first leads, the rest ride
   *  along. Waits for the preview when a part is not drawn yet (just pasted). */
  const selectIds = useCallback((ids: string[]) => {
    if (ids.length === 0) { select(null); setExtraIds([]); return; }
    const [lead, ...rest] = ids;
    setExtraIds(rest);
    if (lead !== selectedUiElementId) keepExtras.current = true;
    const found = findUiElementNode(previewRef.current, lead!);
    if (found) select(found);
    else selectWhenDrawn(lead!);
  }, [select, selectWhenDrawn, selectedUiElementId]);

  // On an arranged card the part has a name — "meter", "button" — so the badge
  // says that instead of `div:224`. The DOM tree under a compiled element is
  // ours, not the creator's, and naming its rows at them is noise.
  // ── Dragging the selection ────────────────────────────────────────────
  //
  // The gesture edits the same document the panel edits, through the same
  // helpers, so a drag and a typed number are one behaviour. The box the drag
  // started from is held still for the length of the gesture: applying each
  // delta to the PREVIOUS result would compound rounding, and a slow drag
  // would travel further than a fast one over the same distance.
  const dragOrigin = useRef<{ pageId: string; ids: string[]; boxes: Record<string, { x: number; y: number; w: number; h: number }> } | null>(null);

  const canvas: "phone" | "desktop" = viewport === "phone" ? "phone" : "desktop";

  const beginDrag = useCallback(() => {
    if (!uiDoc || !selectedUiElementId) return null;
    const pageId = findElementPage(uiDoc, selectedUiElementId);
    if (!pageId) return null;
    const ids = selectionIds.length > 0 ? selectionIds : groupOf(uiDoc, pageId, selectedUiElementId);
    const page = uiDoc.pages.find((p) => p.id === pageId);
    const boxes: Record<string, { x: number; y: number; w: number; h: number }> = {};
    for (const el of page?.elements ?? []) {
      if (!ids.includes(el.id)) continue;
      const b = boxOn(el, canvas);
      if (b) boxes[el.id] = b;
    }
    return { pageId, ids, boxes };
  }, [uiDoc, selectedUiElementId, canvas, selectionIds]);

  // A drag is one undo step, not one per pointermove: every move goes through
  // setUiDoc, and at MAX_HISTORY entries a single slow drag used to push the
  // whole history out. The batch opens on the first move that actually edits
  // (a press without a move leaves no step behind) and closes wherever the
  // gesture ends — pointer up, Escape, or the selection going away under it.
  const batchOpen = useRef(false);
  const finishDrag = useCallback(() => {
    dragOrigin.current = null;
    setDragging(false);
    if (batchOpen.current) {
      batchOpen.current = false;
      useEditorStore.getState().commitBatch();
    }
  }, []);

  const onDrag = useCallback((input: DragDelta) => {
    let delta = input;
    if (!uiDoc) return;
    const origin = dragOrigin.current ?? beginDrag();
    if (!origin) return;
    dragOrigin.current = origin;
    if (!batchOpen.current) {
      batchOpen.current = true;
      useEditorStore.getState().beginBatch();
      setDragging(true);
    }
    const lead = selectedUiElementId;
    // Keep the selection on the page sideways and below its top: a part
    // dragged past the edge went on under the side panel, its grips out of
    // reach. Pages scroll down, so the bottom is left free.
    const pageW = canvas === "desktop" ? UI_DESKTOP_W : UI_CANVAS_W;
    const boxes = Object.values(origin.boxes);
    if (boxes.length && delta.dw === 0 && delta.dh === 0) {
      const left = Math.min(...boxes.map((b) => b.x));
      const right = Math.max(...boxes.map((b) => b.x + b.w));
      const top = Math.min(...boxes.map((b) => b.y));
      delta = { ...delta, dx: Math.min(Math.max(delta.dx, -left), pageW - right), dy: Math.max(delta.dy, -top) };
    } else if (lead && origin.boxes[lead]) {
      const from = origin.boxes[lead];
      const x = Math.max(0, from.x + delta.dx);
      const w = Math.min(from.w + delta.dw - (x - (from.x + delta.dx)), pageW - x);
      delta = { ...delta, dx: x - from.x, dw: w - from.w, dy: Math.max(delta.dy, -from.y), dh: delta.dh - Math.max(0, -(from.y + delta.dy)) };
    }
    setUiDoc(updateElements(uiDoc, origin.pageId, origin.ids, (el) => {
      const from = origin.boxes[el.id];
      if (!from) return el;
      // The group travels together; only the part that was gripped resizes, so
      // a label does not stretch into a track.
      const next = el.id === lead
        ? { x: from.x + delta.dx, y: from.y + delta.dy, w: Math.max(1, from.w + delta.dw), h: Math.max(1, from.h + delta.dh) }
        : { ...from, x: from.x + delta.dx, y: from.y + delta.dy };
      return canvas === "desktop"
        ? { ...el, desktop: next }
        : { ...el, x: next.x, y: next.y, w: next.w, h: next.h };
    }));
  }, [uiDoc, beginDrag, selectedUiElementId, setUiDoc, canvas]);

  /** The selection's width in DESIGN px, which with its width on screen gives
   *  the scale the card is being drawn at. */
  const selectedDesignWidth = useMemo(() => {
    if (!uiDoc || !selectedUiElementId) return 0;
    const pageId = findElementPage(uiDoc, selectedUiElementId);
    const el = pageId && uiDoc.pages.find((p) => p.id === pageId)?.elements.find((e) => e.id === selectedUiElementId);
    const b = el ? boxOn(el, canvas) : null;
    return b?.w ?? 0;
  }, [uiDoc, selectedUiElementId, canvas]);

  /**
   * The SELECTED uiDoc element's box on screen.
   *
   * `selectedRect` is the node the pointer landed on, which inside a meter is
   * the div painting the filled portion — half the width of the track at 50%.
   * Handles drawn there sit inside the element rather than around it, the ratio
   * taken from it is wrong by however full the meter happens to be, and the
   * grip on its right edge lands exactly where a creator would press to drag.
   */
  const selectedUiRect = useMemo(() => {
    // Measured from the STAGE, not the card.
    //
    // These rects are drawn into a layer that is `absolute inset-0` in the
    // stage, so its origin is the stage's padding box — while the card sits
    // inside the stage's padding. Measuring from the card put every outline,
    // badge and drag grip out by exactly that padding: 24px sideways once the
    // stage got a surface to sit on, and 24 across / 64 down in the player
    // view, which is where it finally became impossible to miss.
    const host = stageRef.current;
    if (!host || !selected || !selectedUiElementId) return null;
    const root = selected.getRootNode() as ParentNode;
    const node = root.querySelector?.(`[data-ui-el="${CSS.escape(selectedUiElementId)}"]`);
    if (!node) return null;
    const origin = host.getBoundingClientRect();
    const r = node.getBoundingClientRect();
    return { top: r.top - origin.top, left: r.left - origin.left, width: r.width, height: r.height };
    // selectedRect ticks each frame while the card animates; this must follow.
  }, [selected, selectedUiElementId, selectedRect]);

  /** Where the companions are on screen, for their outlines. Measured from the
   *  card itself rather than computed, so it needs no scale of its own. */
  const extraRects = useMemo(() => {
    // Same origin as the lead's — see `selectedUiRect`.
    const host = stageRef.current;
    if (!host || extraIds.length === 0 || !selected) return [];
    // The card renders inside a shadow root, which `querySelector` on the host
    // does not enter. The lead selection is already a node INSIDE it, so its
    // root is the tree the companions live in too.
    const root = selected.getRootNode() as ParentNode;
    const origin = host.getBoundingClientRect();
    const out: Rect[] = [];
    for (const id of extraIds) {
      const node = root.querySelector?.(`[data-ui-el="${CSS.escape(id)}"]`);
      if (!node) continue;
      const r = node.getBoundingClientRect();
      // A part that is not on this canvas has no box to outline.
      if (r.width === 0 && r.height === 0) continue;
      out.push({ top: r.top - origin.top, left: r.left - origin.left, width: r.width, height: r.height });
    }
    return out;
    // selectedRect ticks every frame while the card animates, which is exactly
    // when these need re-measuring too.
  }, [extraIds, selectedRect, selected]);

  const endDrag = useCallback(() => { finishDrag(); setGuide(null); }, [finishDrag]);

  // The origin belongs to the element it was taken from. If the selection
  // moves on without the gesture ending cleanly — Escape deselecting, a click
  // elsewhere, the page closing — a stale origin would make the next drag on a
  // different element move the old one, so it goes (and the batch with it).
  useEffect(() => {
    endDrag();
  }, [selectedUiElementId, canvas, endDrag]);
  useEffect(() => () => finishDrag(), [finishDrag]);

  // ── Smart guides ──────────────────────────────────────────────────────
  //
  // Everything here is in DESIGN px until the last step. The guide has to be
  // drawn in screen px, and the two are related by the scale and origin the
  // selection itself reveals: its width on screen over its width in the
  // document, and where its top-left lands.
  const [guide, setGuide] = useState<Guide | null>(null);

  /** Design px → screen px (relative to the stage), read off the lead part as
   *  it is drawn right now. */
  const designToScreen = useCallback(() => {
    if (!uiDoc || !selectedUiElementId || !selectedUiRect || selectedDesignWidth <= 0) return null;
    const pageId = findElementPage(uiDoc, selectedUiElementId);
    const el = pageId ? uiDoc.pages.find((p) => p.id === pageId)?.elements.find((e) => e.id === selectedUiElementId) : null;
    const b = el ? boxOn(el, canvas) : null;
    if (!b) return null;
    const scale = selectedUiRect.width / selectedDesignWidth;
    return { scale, x: selectedUiRect.left - b.x * scale, y: selectedUiRect.top - b.y * scale };
  }, [uiDoc, selectedUiElementId, selectedUiRect, selectedDesignWidth, canvas]);

  const showGuide = useCallback((g: UiGuide) => {
    const map = designToScreen();
    if (!map || (!g.vertical && !g.horizontal)) { setGuide(null); return; }
    setGuide({
      vertical: g.vertical && {
        x: map.x + g.vertical.x * map.scale,
        from: map.y + g.vertical.from * map.scale,
        to: map.y + g.vertical.to * map.scale,
      },
      horizontal: g.horizontal && {
        y: map.y + g.horizontal.y * map.scale,
        from: map.x + g.horizontal.from * map.scale,
        to: map.x + g.horizontal.to * map.scale,
      },
    });
  }, [designToScreen]);

  const snapDrag = useCallback((delta: DragDelta, edge: DragEdge, free: boolean): DragDelta => {
    const origin = dragOrigin.current ?? beginDrag();
    if (!uiDoc || !origin) return delta;
    dragOrigin.current = origin;
    // Alt: exactly where the pointer says, the way every design tool does it.
    if (free) { setGuide(null); return delta; }
    const page = uiDoc.pages.find((p) => p.id === origin.pageId);
    if (!page) return delta;
    const others = page.elements
      .filter((el) => !origin.ids.includes(el.id))
      .map((el) => boxOn(el, canvas))
      .filter((b): b is { x: number; y: number; w: number; h: number } => b !== null && b.w > 0 && b.h > 0);
    const pageBox = pageBoxOf(uiDoc, origin.pageId, canvas);
    const THRESHOLD = 6;

    if (edge === "move") {
      // The group's outer box is what snaps, not each part of it.
      const parts = Object.values(origin.boxes);
      if (parts.length === 0) return delta;
      const left = Math.min(...parts.map((b) => b.x)) + delta.dx;
      const top = Math.min(...parts.map((b) => b.y)) + delta.dy;
      const moving = {
        x: left, y: top,
        w: Math.max(...parts.map((b) => b.x + b.w)) + delta.dx - left,
        h: Math.max(...parts.map((b) => b.y + b.h)) + delta.dy - top,
      };
      const snap = snapMove(moving, others, pageBox, THRESHOLD);
      showGuide(snap.guide);
      return { ...delta, dx: delta.dx + Math.round(snap.box.x - left), dy: delta.dy + Math.round(snap.box.y - top) };
    }

    // A resize: only the gripped part changes size, and only the edges the
    // grip drags are pulled to a line.
    const from = origin.boxes[selectedUiElementId ?? ""];
    if (!from) return delta;
    const box = { x: from.x + delta.dx, y: from.y + delta.dy, w: Math.max(1, from.w + delta.dw), h: Math.max(1, from.h + delta.dh) };
    const snap = snapResize(box, {
      left: edge.includes("w"), right: edge.includes("e"), top: edge.includes("n"), bottom: edge.includes("s"),
    }, others, pageBox, THRESHOLD);
    showGuide(snap.guide);
    const b = snap.box;
    return { dx: Math.round(b.x - from.x), dy: Math.round(b.y - from.y), dw: Math.round(b.w - from.w), dh: Math.round(b.h - from.h) };
  }, [uiDoc, beginDrag, canvas, selectedUiElementId, showGuide]);

  /** Each part as last drawn here, to tell which ones an edit changed. */
  const paintedRef = useRef(new Map<string, UiElement>());
  // ── Drawing geometry at once ──────────────────────────────────────────
  //
  // The card recompiles 600ms after the last edit, which is right for a
  // colour and wrong for a drag: the part would sit still under the pointer and
  // then jump. So every edit writes the new boxes straight onto the parts
  // already drawn — the compiled card places them by exactly these four
  // numbers — and the recompile that follows draws the same thing.
  useEffect(() => {
    if (!uiDoc || !currentPageId) return;
    const page = uiDoc.pages.find((p) => p.id === currentPageId);
    if (!page) return;
    // What was drawn before this edit, recorded even when the card has not
    // drawn yet — or the first edit after opening would have nothing to
    // compare with and wait for the compile.
    const before = paintedRef.current;
    paintedRef.current = new Map(page.elements.map((el) => [el.id, el]));
    const root = previewRef.current;
    if (!root) return;
    const host = findCardRoot(root);
    if (!host) return;
    for (const el of page.elements) {
      const b = boxOn(el, canvas);
      if (!b) continue;
      const node = host.querySelector<HTMLElement>(`[data-ui-el="${CSS.escape(el.id)}"]`);
      if (!node) continue;
      node.style.left = `${b.x}px`;
      node.style.top = `${b.y}px`;
      node.style.width = `${b.w}px`;
      // A popup is as tall as what it says, up to its box (popFit in the
      // parts runtime) — pinning the box height here drew every popup at its
      // maximum in the editor and nowhere else.
      if (el.type === "popup") node.style.maxHeight = `${b.h}px`;
      else node.style.height = `${b.h}px`;
      // And its look, when that is what just changed (see live-style.ts).
      const was = before.get(el.id);
      if (was && lookChanged(was, el)) paintLive(node, el, canvas);
    }
  }, [uiDoc, currentPageId, canvas]);

  const uiElementLabel = useCallback((el: Element): string | null => {
    if (!uiDoc) return null;
    const id = nearestUiElementId(el, previewRef.current);
    if (!id) return null;
    const found = (uiDoc.pages ?? []).flatMap((page) => page.elements).find((e) => e.id === id);
    return found ? t(partKindKeys(unitLead(uiDoc, found).type) as never) : null;
  }, [uiDoc, t]);

  // Inspecting opens the context for that selection — until the creator
  // closes it. Reopening it on every pick put it back over a page they had
  // just cleared it from; once closed it stays closed (the floating bar and
  // its 更多 cover the common edits) until they open it again.
  const panelClosedByUser = useRef(false);
  const panelBeforePreview = useRef(false);
  const choosePanel = useCallback((open: boolean) => {
    panelClosedByUser.current = !open;
    if (open) setSheetUp(true);
    setSidebarOpen(open);
  }, []);
  useEffect(() => {
    if (!picking && !selected) return;
    if (!panelClosedByUser.current) setSidebarOpen(true);
  }, [picking, selected]);

  const hasFrontend = !!rootComponent?.files && Object.keys(rootComponent.files).length > 0;

  // ── Picking with a modifier, and with a marquee ──────────────────────
  //
  // Shift/Ctrl-click on a part already picked takes it back out; on a new part
  // it joins. A press on empty canvas that drags draws a marquee, and every
  // part it touches is picked — groups whole.
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const suppressClick = useRef(false);

  const uiIdAt = useCallback((x: number, y: number): string | null => {
    const hit = inspector.hitTest(x, y);
    return hit ? nearestUiElementId(hit, previewRef.current) : null;
  }, [inspector]);

  const toggleInSelection = useCallback((id: string): boolean => {
    if (!uiDoc || !selectedUiElementId) return false;
    const pageId = findElementPage(uiDoc, selectedUiElementId);
    if (!pageId || findElementPage(uiDoc, id) !== pageId) return false;
    const unit = groupOf(uiDoc, pageId, id);
    if (unit.includes(selectedUiElementId)) {
      // Taking the lead out: the next companion leads.
      const rest = extraIds.filter((e) => !unit.includes(e));
      selectIds(rest);
      return true;
    }
    if (extraIds.some((e) => unit.includes(e))) {
      setExtraIds((ids) => ids.filter((e) => !unit.includes(e)));
      return true;
    }
    return false;
  }, [uiDoc, selectedUiElementId, extraIds, selectIds]);

  const startMarquee = useCallback((event: React.PointerEvent) => {
    const stage = stageRef.current;
    if (!stage || !uiDoc || !currentPageId) return;
    // A finger dragging over empty canvas is scrolling the page, not drawing
    // a box.
    if (event.pointerType === "touch") return;
    const origin = stage.getBoundingClientRect();
    const sx = event.clientX;
    const sy = event.clientY;
    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    const startIds = additive && selectedUiElementId ? [selectedUiElementId, ...extraIds] : [];
    let moved = false;
    const rectOf = (x: number, y: number) => ({
      left: Math.min(sx, x) - origin.left, top: Math.min(sy, y) - origin.top,
      width: Math.abs(x - sx), height: Math.abs(y - sy),
    });
    const onMove = (e: PointerEvent) => {
      if (!moved && Math.hypot(e.clientX - sx, e.clientY - sy) < 4) return;
      moved = true;
      setMarquee(rectOf(e.clientX, e.clientY));
    };
    const onUp = (e: PointerEvent) => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
      setMarquee(null);
      if (e.type === "pointercancel") return;
      if (!moved) return;
      suppressClick.current = true;
      window.setTimeout(() => { suppressClick.current = false; }, 0);
      const r = rectOf(e.clientX, e.clientY);
      const host = previewRef.current ? findCardRoot(previewRef.current) : null;
      if (!host) return;
      const page = uiDoc.pages.find((p) => p.id === currentPageId);
      if (!page) return;
      // Measured on screen, from the parts as drawn: nothing to convert.
      const hits: string[] = [];
      for (const unit of unitsOf(uiDoc, currentPageId, page.elements.map((el) => el.id), canvas)) {
        const members = unit.ids.map((id) => page.elements.find((el) => el.id === id)!);
        if (members.some((el) => el.type === "chat" || el.type === "messages" || el.type === "composer")) continue;
        let touched = false;
        for (const id of unit.ids) {
          const node = host.querySelector(`[data-ui-el="${CSS.escape(id)}"]`);
          if (!node) continue;
          const b = node.getBoundingClientRect();
          const bl = b.left - origin.left;
          const bt = b.top - origin.top;
          if (bl < r.left + r.width && r.left < bl + b.width && bt < r.top + r.height && r.top < bt + b.height) touched = true;
        }
        if (touched) hits.push(unit.ids[0]!);
      }
      selectIds([...new Set([...startIds, ...hits])]);
    };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
  }, [uiDoc, currentPageId, canvas, selectedUiElementId, extraIds, selectIds]);

  // ── Press and drag in one gesture ─────────────────────────────────────
  //
  // The grips cover only what is already selected. Pressing any other part
  // and dragging moves it straight away, as on a slide — no click to select
  // first. Pressing a part that is already among the picked moves them all.
  const latestDrag = useRef({ onDrag: (_d: DragDelta) => {}, snapDrag: (d: DragDelta, _e: DragEdge, _f: boolean) => d, endDrag: () => {}, lead: null as string | null });
  const startPressDrag = useCallback((event: React.PointerEvent, id: string) => {
    if (!uiDoc) return;
    const pageId = findElementPage(uiDoc, id);
    const el = pageId ? uiDoc.pages.find((p) => p.id === pageId)?.elements.find((e) => e.id === id) : null;
    const box = el ? boxOn(el, canvas) : null;
    const node = findUiElementNode(previewRef.current, id);
    if (!el || !box || !node || box.w <= 0) return;
    if (el.type === "chat" || el.type === "messages" || el.type === "composer") return;
    const scale = node.getBoundingClientRect().width / box.w;
    if (!(scale > 0)) return;
    const inSelection = selectionIds.includes(id);
    // On a touch screen a press-and-move over the canvas is a scroll. A tap
    // picks the part (the click does that); once picked, its handles — which
    // take the finger outright — move it.
    if (event.pointerType === "touch") return;
    if (!inSelection) {
      const hit = inspector.hitTest(event.clientX, event.clientY);
      if (hit) select(hit);
    }
    const sx = event.clientX;
    const sy = event.clientY;
    let moved = false;
    const onMove = (e: PointerEvent) => {
      if (!moved && Math.hypot(e.clientX - sx, e.clientY - sy) < 3) return;
      const L = latestDrag.current;
      // The selection has to have caught up with the press before it moves.
      if (!inSelection && L.lead !== id) return;
      moved = true;
      let dx = Math.round((e.clientX - sx) / scale);
      let dy = Math.round((e.clientY - sy) / scale);
      // Shift keeps the move to one axis, as in Slides.
      if (e.shiftKey) { if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0; }
      L.onDrag(L.snapDrag({ dx, dy, dw: 0, dh: 0 }, "move", e.altKey));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      if (moved) latestDrag.current.endDrag();
      // The press already picked. The click that follows lands wherever the
      // part is NOW — the panel opening can reflow the card under the pointer —
      // and must not pick again (or put the selection down).
      if (!moved && inSelection) return;
      suppressClick.current = true;
      window.setTimeout(() => { suppressClick.current = false; }, 0);
    };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
  }, [uiDoc, canvas, selectionIds, inspector, select]);

  // ── Editing words in place ────────────────────────────────────────────
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  useEffect(() => { if (editingTextId && editingTextId !== selectedUiElementId) setEditingTextId(null); }, [selectedUiElementId, editingTextId]);
  const editableLead = (() => {
    if (!uiDoc || !selectedUiElementId) return null;
    const el = uiDoc.pages.flatMap((p) => p.elements).find((e) => e.id === selectedUiElementId);
    return el && (el.type === "text" || el.type === "button") ? el : null;
  })();
  const editWhenSelected = useRef<string | null>(null);
  useEffect(() => {
    if (!editableLead || editWhenSelected.current !== editableLead.id || !selectedUiRect) return;
    editWhenSelected.current = null;
    setEditingTextId(editableLead.id);
  }, [editableLead, selectedUiRect]);
  const leadIsImage = Boolean(uiDoc && selectedUiElementId && extraIds.length === 0
    && uiDoc.pages.flatMap((p) => p.elements).find((e) => e.id === selectedUiElementId)?.type === "image");
  const beginTextEdit = useCallback(() => {
    if (editableLead && extraIds.length === 0) setEditingTextId(editableLead.id);
  }, [editableLead, extraIds.length]);

  // ── Hidden in the editor (the layers list's eye) ─────────────────────
  const [hiddenIds, setHiddenIds] = useState<string[]>([]);
  const toggleHidden = useCallback((id: string) => {
    setHiddenIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  }, []);
  useEffect(() => {
    const host = previewRef.current ? findCardRoot(previewRef.current) : null;
    if (!host) return;
    let tag = host.querySelector<HTMLStyleElement>("style[data-yc-editor-hidden]");
    if (!tag) {
      tag = document.createElement("style");
      tag.setAttribute("data-yc-editor-hidden", "");
      host.appendChild(tag);
    }
    // A popup is drawn over everything, which in the editor meant over the
    // very parts the creator was trying to click. So it shows only while it is
    // picked — from the layers list, where it is always listed.
    const popups = (uiDoc?.pages ?? []).flatMap((p) => p.elements)
      .filter((el) => el.type === "popup" && !selectionIds.includes(el.id))
      .map((el) => `[data-ui-el="${CSS.escape(el.id)}"]{display:none!important}`);
    tag.textContent = [
      ...hiddenIds.map((id) => `[data-ui-el="${CSS.escape(id)}"]{visibility:hidden!important}`),
      ...popups,
    ].join("\n");
  }, [hiddenIds, rootComponent, uiDoc, selectionIds]);

  const selectFromLayers = useCallback((id: string, additive: boolean) => {
    if (!uiDoc) return;
    const pageId = findElementPage(uiDoc, id);
    if (pageId && pageId !== currentPageId) setEditPageId(pageId);
    if (additive && selectedUiElementId) {
      if (!toggleInSelection(id)) selectIds([selectedUiElementId, ...extraIds, id]);
      return;
    }
    selectIds([id]);
  }, [uiDoc, currentPageId, selectedUiElementId, extraIds, toggleInSelection, selectIds]);

  /** The part under the pointer, outlined whole rather than whichever span
   *  inside it the pointer happens to be over. */
  const hoverUiRect = useMemo(() => {
    const host = stageRef.current;
    const hovered = inspector.hovered;
    if (!uiDoc || !host || !hovered || !hoverRect) return hoverRect;
    const id = nearestUiElementId(hovered, previewRef.current);
    if (!id) return null;
    if (id === selectedUiElementId || extraIds.includes(id)) return null;
    const node = (hovered.getRootNode() as ParentNode).querySelector?.(`[data-ui-el="${CSS.escape(id)}"]`);
    if (!node) return null;
    const origin = host.getBoundingClientRect();
    const r = node.getBoundingClientRect();
    return { top: r.top - origin.top, left: r.left - origin.left, width: r.width, height: r.height };
  }, [uiDoc, inspector.hovered, hoverRect, selectedUiElementId, extraIds]);

  latestDrag.current = { onDrag, snapDrag, endDrag, lead: selectedUiElementId };

  // Ctrl/⌘ + = / − / 0, and Ctrl/⌘ + wheel over the stage: the zoom keys of
  // every slide editor (0 goes back to 适应).
  const zoomRef = useRef({ zoom, current: 1 });
  useEffect(() => {
    if (!active || !uiDoc) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      const now = zoomRef.current.current;
      if (e.key === "=" || e.key === "+") { e.preventDefault(); setZoom(stepZoom(now, 1)); }
      else if (e.key === "-") { e.preventDefault(); setZoom(stepZoom(now, -1)); }
      else if (e.key === "0") { e.preventDefault(); setZoom("fit"); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, uiDoc]);
  useEffect(() => {
    const el = scrollEl;
    if (!el || !uiDoc) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      setZoom(stepZoom(zoomRef.current.current, e.deltaY < 0 ? 1 : -1));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [scrollEl, uiDoc]);

  // Picking a part to edit makes the part's panel the right-hand column, as
  // a slide editor's format pane does (owner, 9/2: opening an object should
  // take the assistant's place). Both open squeezed the page to a third of
  // the stage. Only on the pick itself: an assistant reopened afterwards stays.
  const hadPick = useRef(false);
  useEffect(() => {
    const picked = !!selectedUiElementId;
    if (picked && !hadPick.current && assistant?.open && immersive) assistant.toggle();
    hadPick.current = picked;
  }, [selectedUiElementId, assistant, immersive]);

  // ── The right-click menu, as a slide editor has it ────────────────────
  // Every item is the keyboard command of the same name, so the two can
  // never do different things.
  const [partMenu, setPartMenu] = useState<{ x: number; y: number } | null>(null);
  const runCommand = (key: string, opts: { code?: string; shift?: boolean; mod?: boolean } = {}) => {
    handleCanvasKeyRef.current?.({
      key, code: opts.code ?? "", shiftKey: !!opts.shift, ctrlKey: opts.mod !== false, metaKey: false,
      preventDefault() {},
    } as unknown as KeyboardEvent);
    setPartMenu(null);
  };
  // ── The keyboard, as a slide editor has it ────────────────────────────
  //
  // Arrows nudge (Shift: 10px), Delete removes, Ctrl+C / X / V / D copy, cut,
  // paste and duplicate, Ctrl+] / [ restack (with Shift: to the very front or
  // back), Ctrl+A picks everything on the page. Undo is the editor's own
  // Ctrl+Z — every one of these is an ordinary document edit.
  const handleCanvasKey = useCallback((event: KeyboardEvent): boolean => {
    if (!uiDoc) return false;
    const mod = event.ctrlKey || event.metaKey;
    const pageId = (selectedUiElementId && findElementPage(uiDoc, selectedUiElementId)) || currentPageId;
    if (!pageId) return false;
    const page = uiDoc.pages.find((p) => p.id === pageId);
    if (!page) return false;
    const ids = selectionIds;
    const loadBearing = (id: string) => {
      const el = page.elements.find((e) => e.id === id);
      return !!el && (el.type === "chat" || el.type === "messages" || el.type === "composer");
    };
    const movable = ids.filter((id) => !loadBearing(id));
    const key = event.key;

    const arrow = key === "ArrowLeft" ? [-1, 0] : key === "ArrowRight" ? [1, 0] : key === "ArrowUp" ? [0, -1] : key === "ArrowDown" ? [0, 1] : null;
    if (arrow && ids.length > 0 && !mod) {
      event.preventDefault();
      const step = event.shiftKey ? 10 : 1;
      coalesce("nudge");
      setUiDoc(nudgeElements(uiDoc, pageId, ids, canvas, arrow[0]! * step, arrow[1]! * step));
      return true;
    }
    if ((key === "Delete" || key === "Backspace") && !mod && movable.length > 0) {
      event.preventDefault();
      setUiDoc(removeGroup(uiDoc, pageId, movable));
      select(null);
      setExtraIds([]);
      return true;
    }
    if (!mod) return false;
    const lower = key.toLowerCase();
    // Text the creator selected somewhere on the page is theirs to copy.
    const textSelected = !!window.getSelection()?.toString();
    if ((lower === "c" || lower === "x") && !event.shiftKey && movable.length > 0 && !textSelected) {
      event.preventDefault();
      partClipboard.items = copyElements(uiDoc, pageId, movable);
      partClipboard.pastes = 0;
      if (lower === "x") {
        // A cut is half of a move: the variables a form part wrote have to be
        // there when it is pasted back, so this removal keeps them.
        setUiDoc(removeGroup(uiDoc, pageId, movable), { keepAutoVariables: true });
        select(null);
        setExtraIds([]);
      }
      return true;
    }
    const pasteFrom = (items: UiElement[]) => {
      const stem = `el-${crypto.randomUUID().slice(0, 8)}`;
      // No offset of our own: the engine steps the copy only when it would
      // land on its original (same page, still there), on both canvases.
      const result = pasteElements(uiDoc, pageId, items, stem, canvas);
      setUiDoc(result.doc);
      // One representative per unit is enough: the rest of a group follows.
      const reps = unitsOf(result.doc, pageId, result.ids, canvas).map((u) => u.ids[0]!);
      selectIds(reps.length ? reps : result.ids);
    };
    if (lower === "v" && !event.shiftKey && partClipboard.items?.length) {
      event.preventDefault();
      partClipboard.pastes += 1;
      pasteFrom(partClipboard.items);
      return true;
    }
    if (lower === "d" && movable.length > 0) {
      event.preventDefault();
      pasteFrom(copyElements(uiDoc, pageId, movable));
      return true;
    }
    if (lower === "a" && !event.shiftKey) {
      event.preventDefault();
      // Everything on the page, including parts that are only on the other
      // canvas — they are listed (「只在手机」/「只在电脑」) and they go with a
      // delete, copy or cut. Aligning and nudging move only what is drawn here.
      selectIds(selectAllOnPage(page, canvas));
      return true;
    }
    if ((event.code === "BracketRight" || event.code === "BracketLeft") && ids.length > 0) {
      event.preventDefault();
      const up = event.code === "BracketRight";
      setUiDoc(reorderElements(uiDoc, pageId, ids, event.shiftKey ? (up ? "front" : "back") : (up ? "forward" : "backward")));
      return true;
    }
    return false;
  }, [uiDoc, selectedUiElementId, currentPageId, selectionIds, canvas, setUiDoc, select, selectIds]);
  const handleCanvasKeyRef = useRef(handleCanvasKey);
  handleCanvasKeyRef.current = handleCanvasKey;

  // Ctrl/⌘+Shift+C arms the picker and Escape stands it down — the same keys
  // that do it in every browser, so the muscle memory transfers intact.
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // Mid-drag, Escape belongs to the drag: its own handler puts the boxes
        // back where they started. Swallowing it here to deselect instead left
        // the element wherever the pointer had got to.
        if (dragOrigin.current) return;
        // An open colour/font popover or a word being edited in place close
        // first; they handle their own Escape.
        if (document.querySelector("[data-style-popover]")) return;
        if ((event.target as HTMLElement | null)?.isContentEditable) return;
        // A field in the panel (a label, a new variable's name) owns its
        // Escape too; it must not also drop the part being edited.
        if (/^(INPUT|TEXTAREA|SELECT)$/.test((event.target as HTMLElement | null)?.tagName ?? "")) return;
        // Each Escape undoes the smallest thing: a word being typed (the
        // inline editor, above), then the picker, then the selection. With
        // nothing left it does nothing — it used to leave the whole editor,
        // which is what a creator pressing Escape twice to "deselect" got.
        // Leaving is the 退出 button's job.
        if (picking) {
          setPicking(false);
          event.stopPropagation();
        } else if (selected) {
          select(null);
          setExtraIds([]);
          event.stopPropagation();
        }
        return;
      }
      // Arrow keys walk the tree and Ctrl+Shift+C arms the picker, but only
      // when the creator is not typing into the AI composer or a knob field.
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (target?.isContentEditable) return;
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "c") {
        event.preventDefault();
        setPicking(!picking);
        return;
      }
      if (target?.closest("[role=textbox], [role=combobox], [contenteditable]")) return;
      if (uiDoc && handleCanvasKey(event)) return;
      const direction =
        event.key === "ArrowUp" ? "up"
        : event.key === "ArrowDown" ? "down"
        : event.key === "ArrowLeft" ? "left"
        : event.key === "ArrowRight" ? "right"
        : null;
      if (direction && selected && move(direction)) event.preventDefault();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, picking, selected, setPicking, select, move, uiDoc, handleCanvasKey]);

  const openCode = useCallback((file: string, line: number) => {
    window.dispatchEvent(
      new CustomEvent("yumina:studio-open-code", { detail: { file, line } }),
    );
  }, []);

  const sendToAgent = useCallback((message: string, label: string, file: string, line: number) => {
    // The block stays pinned to the composer rather than being spent on one
    // message: reshaping a region takes several turns, and re-picking it before
    // each of them is the kind of tax that makes a tool go unused.
    window.dispatchEvent(
      new CustomEvent("yumina:studio-attach-block", {
        detail: { label, file, line, context: message },
      }),
    );
    setAttachedRef({ file, line });
  }, []);

  const setKnob = useCallback(
    (groupId: string, knobId: string, value: string | number) => {
      if (!uiDoc?.base) return;
      const next: UiDoc = {
        ...uiDoc,
        base: {
          ...uiDoc.base,
          groups: (uiDoc.base.groups ?? []).map((g) =>
            g.id !== groupId
              ? g
              : { ...g, knobs: g.knobs.map((k) => (k.id === knobId ? { ...k, value } : k)) },
          ),
        },
      };
      setUiDoc(next);
    },
    [uiDoc, setUiDoc],
  );

  const askDecompose = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent("yumina:studio-ai-send", {
        detail: {
          message:
            "把这张卡自带的前端拆成样式积木（拆积木）：把颜色、显示文字、字号这些视觉常量提取成可视化旋钮并分区安装。拆完之后默认画面必须和现在一模一样。",
        },
      }),
    );
  }, []);

  useEffect(() => {
    const onDetach = () => setAttachedRef(null);
    window.addEventListener("yumina:studio-detach-block", onDetach);
    return () => window.removeEventListener("yumina:studio-detach-block", onDetach);
  }, []);

  if (!hasFrontend) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
        <MousePointerSquareDashed className="h-6 w-6 text-muted-foreground/25" />
        <p className="text-sm font-medium text-muted-foreground/70">{t("studio.inspect.noFrontend")}</p>
        <p className="max-w-sm text-[11px] leading-relaxed text-muted-foreground/45">
          {t("studio.inspect.noFrontendHint")}
        </p>
      </div>
    );
  }

  const width = VIEWPORTS[viewport];
  // ── Zoom, as a slide editor has it ────────────────────────────────────
  // 「适应」 fits the page in the room there is, but never below a size its
  // words can be read at: with the panel and the assistant both open, the
  // whole desktop page squeezed into 430px and its body text was 7px. Past
  // that the page keeps its size and the stage scrolls. A number is that
  // zoom exactly.
  const zoomPage = uiDoc?.pages.find((p) => p.id === currentPageId);
  const designW = viewport === "phone" ? UI_CANVAS_W : UI_DESKTOP_W;
  const designH = viewport === "phone" ? zoomPage?.height ?? 812 : zoomPage?.desktopHeight ?? UI_DESKTOP_H;
  const fitScale = stageBox ? Math.min(stageBox.w / designW, stageBox.h / designH) : 1;
  const zoomScale = zoom === "fit" ? (uiDoc && fitScale < MIN_FIT_ZOOM ? MIN_FIT_ZOOM : null) : zoom;
  const shownZoom = Math.round((zoomScale ?? fitScale) * 100);
  zoomRef.current = { zoom, current: zoomScale ?? fitScale };
  const phoneFit = zoomScale === null && viewport === "phone" && stageBox ? phoneFitFor(stageBox.w, stageBox.h) : null;
  const desktopFit = zoomScale === null && viewport !== "phone" && uiDoc && stageBox
    ? { w: Math.round(designW * fitScale), h: Math.round(designH * fitScale), top: Math.max(0, Math.round((stageBox.h - designH * fitScale) / 2)) }
    : null;
  const sheetOpen = sheetUp && !dragging;
  const panelTitle = t(panelDoc ? "studio.element.panelTitle" : "studio.inspect.panelTitle");
  // What the folded sheet says: the part it would open on.
  const sheetPart = (() => {
    if (!uiDoc || !selectedUiElementId) return null;
    const el = uiDoc.pages.flatMap((p) => p.elements).find((e) => e.id === selectedUiElementId);
    if (!el) return null;
    // A meter's label is one of three elements; the sheet names the part the
    // panel below edits (状态条), not the label that took the click (文字).
    const lead = unitLead(uiDoc, el);
    return lead.name?.trim() || el.name?.trim() || t(partKindKeys(lead.type) as never);
  })();

  return (
    // The available workspace decides the layout, including when this page is
    // hosted in a narrow dock on a wide monitor.
    <div className="@container flex h-full min-h-0 w-full flex-col">
      <div className="relative flex min-h-0 flex-1 flex-col @[880px]:flex-row">
      {!readOnly && (
        <div className={cn("hidden @[880px]:flex", immersive && "pt-3")}>
          <PageStrip doc={uiDoc} currentPageId={currentPageId} onPage={choosePage} onNew={() => setGalleryOpen(true)} onEdit={setUiDoc} wide={viewport !== "phone"} />
        </div>
      )}
      <NewPageGallery open={galleryOpen} onClose={() => { setGalleryOpen(false); setGalleryAsTemplates(false); }} onPick={(id) => { setGalleryAsTemplates(false); pickNewPage(id); }}
        title={galleryAsTemplates ? String(t("studio.pageTemplates.templatesTitle")) : undefined}
        onPickLayout={(id) => { setGalleryOpen(false); void chooseLayout(id); }} />
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Toolbar. Docked to an edge inside the frame; a floating capsule
            over the card when this page IS the frame. */}
        <div
          className={cn(
            // max-content: centred at left:50%, the bar was given only the
            // room right of the middle and wrapped every label in two.
            "flex shrink-0 items-center gap-1.5 whitespace-nowrap",
            immersive
              ? cn(
                "absolute left-1/2 top-3 z-30 w-max -translate-x-1/2 rounded-full border border-white/10 bg-[#15131d]/85 px-2 py-1.5 shadow-[0_10px_40px_rgba(0,0,0,0.5)] backdrop-blur-xl",
                // With the floating column open, centred would put the right
                // half under it: it moves to the left edge instead.
                sidebarOpen && "@[880px]:left-3 @[880px]:translate-x-0",
              )
              : "border-b border-border/50 px-2 py-1.5",
          )}
        >
          <button
            type="button"
            data-testid="edit-mode"
            aria-pressed={bareChat ? sidebarOpen : panelDoc ? editOn : picking}
            onClick={() => {
              if (!panelDoc) { setPicking(!picking); return; }
              // Nothing on a bare chat to select yet: 编辑 is the add-part menu.
              if (bareChat) { setSheetUp(true); setSidebarOpen(!sidebarOpen); return; }
              // Off: the card is live under the pointer, as a player sees it.
              // The part panel has nothing to edit then and only takes room
              // from the page, so it folds away and comes back with 编辑.
              if (editOn) { select(null); setExtraIds([]); setPicking(false); panelBeforePreview.current = sidebarOpen; setSidebarOpen(false); }
              else if (panelBeforePreview.current) { panelBeforePreview.current = false; setSidebarOpen(true); }
              setEditOn(!editOn);
            }}
            title={panelDoc ? t("studio.inspect.editModeHint") : "Ctrl+Shift+C"}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
              (bareChat ? sidebarOpen : panelDoc ? editOn : picking)
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <MousePointerSquareDashed className="h-3.5 w-3.5" />
            {t("studio.inspect.pick")}
          </button>
          {/* With 编辑 off the card already plays — buttons flip pages, nothing
              calls the AI — but nothing said so, and creators reached for 试玩. */}
          {panelDoc && !bareChat && !editOn && (
            <span data-preview-chip="" className="flex items-center gap-1 rounded-md bg-emerald-500/15 px-2 py-1 text-[11px] font-medium text-emerald-300">
              <Play className="h-3 w-3" />
              {t("studio.inspect.previewing")}
            </span>
          )}
          {!readOnly && (
            <button
              type="button"
              data-testid="ui-templates"
              onClick={() => { setGalleryAsTemplates(true); setGalleryOpen(true); }}
              className="flex items-center gap-1.5 rounded-md bg-primary/15 px-2 py-1 text-[11px] font-semibold text-primary transition-colors hover:bg-primary/25"
            >
              <LayoutTemplate className="h-3.5 w-3.5" />
              {t("studio.pageTemplates.templates")}
            </button>
          )}
          {screenFirst && !readOnly && (
            <button
              type="button"
              data-testid="screen-add-feature"
              onClick={() => setGalleryOpen(true)}
              className="flex items-center gap-1.5 rounded-md bg-primary/15 px-2 py-1 text-[11px] font-semibold text-primary transition-colors hover:bg-primary/25"
            >
              <Plus className="h-3.5 w-3.5" />
              {t("studio.screenFirst.addFeature")}
            </button>
          )}
          <div className="mx-1 h-4 w-px bg-border/60" />
          {(["desktop", "phone"] as const).map((v) => (
            <button
              key={v}
              type="button"
              data-viewport={v}
              aria-pressed={viewport === v}
              title={t(`studio.inspect.${v}` as never)}
              onClick={() => { setViewport(v); setPlacedHint(null); }}
              className={cn(
                "flex items-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors",
                viewport === v
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {v === "desktop" ? <Monitor className="h-3.5 w-3.5" /> : <Smartphone className="h-3.5 w-3.5" />}
              {/* Beside the open panel the bar has ~340px; the icons say it. */}
              <span className={cn(immersive && sidebarOpen && "sr-only")}>{t(`studio.inspect.${v}` as never)}</span>
            </button>
          ))}
          <div className="mx-1 h-4 w-px bg-border/60" />
          <div className="flex items-center" data-zoom-controls="">
            <button type="button" onClick={() => setZoom(stepZoom(zoomScale ?? fitScale, -1))} title={t("studio.inspect.zoomOut")} aria-label={t("studio.inspect.zoomOut")}
              className="rounded-md px-1.5 py-1 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground">−</button>
            <button type="button" onClick={() => setZoom(zoom === "fit" ? 1 : "fit")} title={t(zoom === "fit" ? "studio.inspect.zoomActual" : "studio.inspect.zoomFit")}
              className={cn("min-w-[48px] rounded-md px-1.5 py-1 text-center text-[11px] tabular-nums hover:bg-accent", zoom === "fit" ? "text-muted-foreground" : "text-foreground")}>
              {zoom === "fit" ? t("studio.inspect.zoomFitShort", { pct: shownZoom }) : `${shownZoom}%`}
            </button>
            <button type="button" onClick={() => setZoom(stepZoom(zoomScale ?? fitScale, 1))} title={t("studio.inspect.zoomIn")} aria-label={t("studio.inspect.zoomIn")}
              className="rounded-md px-1.5 py-1 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground">＋</button>
          </div>
          {!immersive && <div className="flex-1" />}
          {selected && !immersive && (
            <span className="hidden truncate text-[10px] text-muted-foreground/40 @[1080px]:block">
              {t(uiDoc ? "studio.canvasEdit.keyboardHint" : "studio.inspect.keyboardHint")}
            </span>
          )}
          <button
            type="button"
            onClick={() => choosePanel(!sidebarOpen)}
            title={t(sidebarOpen ? "studio.inspect.hidePanel" : "studio.inspect.showPanel")}
            aria-label={t(sidebarOpen ? "studio.inspect.hidePanel" : "studio.inspect.showPanel")}
            aria-expanded={sidebarOpen}
            aria-controls={sidebarId}
            className={cn(
              "shrink-0 rounded-md p-1.5 transition-colors",
              sidebarOpen ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <PanelRight className="h-3.5 w-3.5" />
          </button>
          {immersive && assistant && (
            <button
              type="button"
              onClick={assistant.toggle}
              aria-pressed={assistant.open}
              title={t("studio.panels.aiAssistant")}
              aria-label={t("studio.panels.aiAssistant")}
              className={cn(
                "shrink-0 rounded-md p-1.5 transition-colors",
                assistant.open ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <MessageSquare className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {defaultChat && !screenFirst && <div className={cn(
          "flex shrink-0 items-center gap-3 text-[11px] text-muted-foreground",
          immersive
            ? "absolute left-3 top-14 z-30 max-w-[min(440px,calc(100%-24px))] rounded-xl border border-white/10 bg-[#15131d]/85 px-3 py-2 shadow-[0_10px_40px_rgba(0,0,0,0.5)] backdrop-blur-xl"
            : "border-b border-border/50 px-4 py-2",
        )}>
          <span className="min-w-0 flex-1">{t("blueprint.writing.defaultInterface")} · {t(hasOpening ? "blueprint.writing.previewHint" : "blueprint.writing.emptyOpening")}</span>
          <button type="button" className="shrink-0 text-foreground hover:underline" onClick={() => window.dispatchEvent(new CustomEvent("yumina:studio-stage-open-panel", { detail: { panelId: "first-message" } }))}>{t("blueprint.writing.editOpening")}</button>
        </div>}

        {/* A part added here was placed on the OTHER canvas too. Said once,
            quietly, with the one-click way to go and look — never a dialog. */}
        {placedHint && (
          <div
            role="status"
            data-testid="placed-hint"
            className={cn(
              "flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground",
              immersive
                ? "absolute bottom-4 left-1/2 z-30 -translate-x-1/2 rounded-full border border-white/10 bg-[#15131d]/90 px-3 py-1.5 shadow-[0_10px_40px_rgba(0,0,0,0.5)] backdrop-blur-xl"
                : "border-b border-border/50 px-3 py-1.5",
            )}
          >
            {placedHint === "phone" ? <Smartphone className="h-3.5 w-3.5 shrink-0" /> : <Monitor className="h-3.5 w-3.5 shrink-0" />}
            <span className="min-w-0 flex-1">{t(placedHint === "phone" ? "studio.element.placedOnPhone" : "studio.element.placedOnDesktop")}</span>
            <button type="button" className="shrink-0 font-medium text-foreground hover:underline" onClick={() => { setViewport(placedHint); setPlacedHint(null); }}>
              {t(placedHint === "phone" ? "studio.element.showPhone" : "studio.element.showDesktop")}
            </button>
            <button type="button" aria-label={t("studio.inspect.hidePanel")} className="shrink-0 rounded p-0.5 hover:text-foreground" onClick={() => setPlacedHint(null)}>
              <X className="h-3 w-3" />
            </button>
          </div>
        )}

        {/* Stage.
            While armed, the stage itself intercepts the pointer in the CAPTURE
            phase rather than parking a transparent layer on top. A layer would
            be simpler but it cannot work: `shadowRoot.elementFromPoint`
            retargets the real topmost hit into that tree, and when the topmost
            hit is a light-DOM layer the answer is nothing at all — the picker
            would see the shadow host and never the card inside it. Capturing
            leaves the card as the topmost element, which is exactly what the
            hit test needs to be true. */}
        <div
          ref={setScrollEl}
          data-stage-scroll=""
          className={cn(
            // Padding so the card has an edge to sit inside rather than
            // bleeding to the chrome. Without it the desktop preview covers
            // the stage completely and the surface under it is theoretical.
            //
            // On a phone the phone canvas is drawn full width and this
            // scrolls, rather than squeezing 812px of card into what is left.
            "relative min-h-0 flex-1",
            zoomScale !== null ? "overflow-auto overscroll-contain" : phoneFit ? "overflow-y-auto overflow-x-hidden overscroll-contain" : "overflow-hidden",
            immersive
              ? cn(
                  // Room for the capsule above and, when it is open, for the
                  // panel floating at the right edge. On the default chat the
                  // "opening preview" strip also floats at the top-left, and
                  // 64px put its bottom edge across the opening's first line.
                  defaultChat ? "px-4 pb-4 pt-[104px] @[880px]:px-6 @[880px]:pb-6" : "px-4 pb-4 pt-16 @[880px]:px-6 @[880px]:pb-6",
                  // The panel takes its own column: the stage ends at its
                  // edge (a margin, not padding — overflowing content runs
                  // into padding, so a zoomed page slid under the panel).
                  sidebarOpen && "@[880px]:mr-[352px]",
                )
              : "p-4 @[880px]:p-6",
            // Editing the screen, a part under the pointer can be moved, as in
            // a slide editor; the crosshair is for picking out of a card's code.
            pickingActive && (uiDoc && editOn ? (inspector.hovered ? "cursor-move" : "cursor-default") : "cursor-crosshair"),
          )}
          /*
           * A surface, not a backdrop.
           *
           * The card being edited is a small bright object, and it was sitting
           * on a flat #0d0c11 rectangle that gave the eye nothing to place it
           * against — every card looked like it was floating in a void, and
           * the editor looked like a viewport rather than a place of work.
           *
           * Three layers, all nearly invisible on their own: a cool wash from
           * the top, as if the stage were lit from above; a 32px grid at 2%
           * white, which is what says "canvas" without ever being read as
           * content; and a deep indigo ground the app's own surfaces already
           * lean towards.
           */
          style={
            immersive
              ? {
                  // Fullscreen, the grid has nowhere to show — the card covers
                  // it. What is left to do is light the card from above, the
                  // way a stage lights what is on it, so the floating controls
                  // have something to sit on and the mode reads as a place.
                  backgroundColor: "#07060b",
                  backgroundImage: [
                    "radial-gradient(1200px 380px at 50% -8%, rgba(139,124,214,0.20), transparent 70%)",
                    "linear-gradient(180deg, #14111d 0%, #07060b 42%)",
                  ].join(","),
                }
              : {
                  backgroundColor: "#0b0a10",
                  backgroundImage: [
                    "radial-gradient(1100px 520px at 50% -12%, rgba(126,114,196,0.13), transparent 62%)",
                    "linear-gradient(rgba(255,255,255,0.020) 1px, transparent 1px)",
                    "linear-gradient(90deg, rgba(255,255,255,0.020) 1px, transparent 1px)",
                    "linear-gradient(180deg, #13111c 0%, #0b0a10 58%)",
                  ].join(","),
                  backgroundSize: "auto, 32px 32px, 32px 32px, auto",
                }
          }
          onMouseMoveCapture={pickingActive || openingOnScreen ? (event) => {
            if (openingOnScreen && !openingEdit) {
              const node = openingNodeFrom(event);
              const rect = node ? rectOnStage(node) : null;
              setOpeningHover((prev) => (rect && prev && prev.top === rect.top && prev.left === rect.left && prev.height === rect.height ? prev : rect));
              if (node) return;
            }
            if (pickingActive) inspector.onPointerMove(event);
          } : undefined}
          onMouseLeave={pickingActive || openingOnScreen ? () => {
            setOpeningHover(null);
            if (pickingActive) inspector.onPointerMove({ clientX: -1, clientY: -1 });
          } : undefined}
          onClickCapture={
            pickingActive || openingOnScreen
              ? (event) => {
                  // A portalled menu's clicks travel the React tree through
                  // here; they are not clicks on the page.
                  if (!(event.currentTarget as Node).contains(event.target as Node)) return;
                  // The drag handles live inside the stage. Their press, and
                  // the click that follows a drag, are theirs — not picks.
                  if (isInspectorOverlayTarget(event.target)) return;
                  if (openOpeningEditor(event)) return;
                  if (!pickingActive) return;
                  event.preventDefault();
                  event.stopPropagation();
                  if (suppressClick.current) { suppressClick.current = false; return; }
                  additivePick.current = event.shiftKey || event.ctrlKey || event.metaKey;
                  if (uiDoc && (event.shiftKey || event.ctrlKey || event.metaKey)) {
                    const id = uiIdAt(event.clientX, event.clientY);
                    if (id && toggleInSelection(id)) return;
                  }
                  if (uiDoc && !picking && !uiIdAt(event.clientX, event.clientY)) {
                    // Empty page: put the selection down. A click on the page
                    // itself (not the margin around it) asks for the page's own
                    // settings — its background — as clicking a slide's empty
                    // ground does; the panel was closed and that setting had
                    // no way in. Not if the creator closed the panel.
                    select(null);
                    setExtraIds([]);
                    const r = stageRef.current?.getBoundingClientRect();
                    if (r && !sidebarOpen && !panelClosedByUser.current
                      && event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom) {
                      setSheetUp(true);
                      setSidebarOpen(true);
                    }
                    return;
                  }
                  if (!picking && !inspector.hitTest(event.clientX, event.clientY)) {
                    // Off the card while holding a selection: put it down, the
                    // way clicking empty canvas does in any design tool.
                    select(null);
                    return;
                  }
                  inspector.onPick(event);
                }
              : undefined
          }
          // The press has to be swallowed too, or the card's own buttons act on
          // the gesture that was only meant to point at them.
          onPointerDownCapture={pickingActive || openingOnScreen ? (event) => {
            if (!(event.currentTarget as Node).contains(event.target as Node)) return; if (isInspectorOverlayTarget(event.target)) return;
            if (openingNodeFrom(event)) { event.preventDefault(); event.stopPropagation(); return; }
            if (!pickingActive) return;
            event.preventDefault();
            event.stopPropagation();
            // A press on nothing starts a marquee; on a part, a pick that can
            // turn into a drag.
            if (uiDoc && event.button === 0) {
              const id = uiIdAt(event.clientX, event.clientY);
              if (!id) startMarquee(event);
              else if (!(event.shiftKey || event.ctrlKey || event.metaKey)) startPressDrag(event, id);
            }
          } : undefined}
          onDoubleClickCapture={uiDoc && pickingActive ? (event) => {
            if (!(event.currentTarget as Node).contains(event.target as Node)) return; if (isInspectorOverlayTarget(event.target)) return;
            event.preventDefault();
            event.stopPropagation();
            const id = uiIdAt(event.clientX, event.clientY);
            if (id && id === selectedUiElementId) beginTextEdit();
          } : undefined}
          onMouseDownCapture={pickingActive ? (event) => { if (!(event.currentTarget as Node).contains(event.target as Node)) return; if (isInspectorOverlayTarget(event.target)) return; event.preventDefault(); event.stopPropagation(); } : undefined}
        >
          {/* The measuring frame. Everything drawn over the card (outlines,
              handles, guides, the marquee) is positioned from THIS box, which
              scrolls together with the card — measuring from the scrolling
              box would put every outline out by however far it had scrolled. */}
          <div ref={stageRef} data-testid="ui-stage-frame" className="relative mx-auto h-full shrink-0"
            style={zoomScale !== null ? { height: Math.round(designH * zoomScale), width: Math.round(designW * zoomScale) }
              : phoneFit ? { height: phoneFit.height, width: phoneFit.width }
              // Fitted, a designed desktop page takes its own shape, centred:
              // left at the full height, the card centred its 1024x640 inside
              // a taller frame, and the bands above and below read as page.
              : desktopFit ? { height: desktopFit.h, width: desktopFit.w, marginTop: desktopFit.top }
              : undefined}
            onContextMenu={uiDoc ? (event) => {
              if (!(event.currentTarget as Node).contains(event.target as Node)) return;
              const id = uiIdAt(event.clientX, event.clientY);
              if (!id && !partClipboard.items?.length) return;
              event.preventDefault();
              if (id && !selectionIds.includes(id)) selectIds([id]);
              setPartMenu({ x: event.clientX, y: event.clientY });
            } : undefined}>
          <div
            ref={previewRef}
            className={cn(
              "mx-auto h-full overflow-hidden",
              immersive ? "rounded-2xl ring-1 ring-white/[0.07]" : "rounded-lg ring-1 ring-white/10",
            )}
            style={{
              ...(width ? { maxWidth: width } : {}),
              // Weight. Without it the card's edge and the stage's ground are
              // the same plane, and a phone-width preview in particular looks
              // like a hole cut in the page rather than a device on a desk.
              boxShadow: "0 24px 60px rgba(0,0,0,0.55), 0 2px 8px rgba(0,0,0,0.4)",
            }}
          >
            <LiveFrontendPreview inspect play={uiDoc ? !editOn : !pickingActive} />
          </div>
          {partMenu && createPortal(
            <>
              <div className="fixed inset-0 z-[90]" onPointerDown={() => setPartMenu(null)} onContextMenu={(e) => { e.preventDefault(); setPartMenu(null); }} />
              <div role="menu" className="fixed z-[91] min-w-[160px] rounded-lg border border-white/10 bg-[#17181c] py-1 text-[13px] shadow-2xl"
                style={{ left: Math.min(partMenu.x, window.innerWidth - 180), top: Math.min(partMenu.y, window.innerHeight - 300) }}
                onKeyDown={(e) => { if (e.key === "Escape") setPartMenu(null); }}>
                {([
                  ...(selectionIds.length ? [
                    { label: t("studio.canvasEdit.menu.cut"), hint: "Ctrl+X", run: () => runCommand("x") },
                    { label: t("studio.canvasEdit.menu.copy"), hint: "Ctrl+C", run: () => runCommand("c") },
                  ] : []),
                  ...(partClipboard.items?.length ? [{ label: t("studio.canvasEdit.menu.paste"), hint: "Ctrl+V", run: () => runCommand("v") }] : []),
                  ...(selectionIds.length ? [
                    { label: t("studio.canvasEdit.menu.duplicate"), hint: "Ctrl+D", run: () => runCommand("d") },
                    { label: "-" },
                    { label: t("studio.canvasEdit.order.front"), hint: "Ctrl+Shift+]", run: () => runCommand("]", { code: "BracketRight", shift: true }) },
                    { label: t("studio.canvasEdit.order.forward"), hint: "Ctrl+]", run: () => runCommand("]", { code: "BracketRight" }) },
                    { label: t("studio.canvasEdit.order.backward"), hint: "Ctrl+[", run: () => runCommand("[", { code: "BracketLeft" }) },
                    { label: t("studio.canvasEdit.order.back"), hint: "Ctrl+Shift+[", run: () => runCommand("[", { code: "BracketLeft", shift: true }) },
                    { label: "-" },
                    { label: t("studio.canvasEdit.menu.delete"), hint: "Delete", run: () => runCommand("Delete", { mod: false }), danger: true },
                  ] : []),
                ] as Array<{ label: string; hint?: string; run?: () => void; danger?: boolean }>).map((item, i) => item.label === "-"
                  ? <div key={i} className="my-1 h-px bg-white/10" />
                  : (
                    <button key={i} type="button" role="menuitem" onClick={item.run}
                      className={cn("flex w-full items-center justify-between gap-6 px-3 py-1.5 text-left hover:bg-white/[0.06]", item.danger ? "text-rose-300" : "text-zinc-200")}>
                      <span>{item.label}</span><span className="text-[11px] text-zinc-500">{item.hint}</span>
                    </button>
                  ))}
              </div>
            </>,
            document.body,
          )}

          {openingHover && !openingEdit && <OpeningHoverRing rect={openingHover} />}
          {openingEdit && (
            <OpeningOnScreenEditor
              key={openingEdit.id}
              entryId={openingEdit.id}
              rect={openingEdit.rect}
              onDone={() => setOpeningEdit(null)}
            />
          )}

          {/* Highlights. Never interactive — the capture layer above owns the
              pointer while picking, and once a block is selected the card must
              go back to behaving like a card. */}
          <div {...{ [IGNORE_ATTR]: "" }} className="pointer-events-none absolute inset-0 z-10">
            {hoverUiRect && !marquee && (
              <div
                className={cn("absolute border border-sky-400", uiDoc ? "bg-sky-400/[0.06]" : "bg-sky-400/15")}
                style={hoverUiRect}
              />
            )}
            {guide?.vertical && (
              <div className="pointer-events-none absolute w-px bg-pink-400"
                style={{ left: guide.vertical.x, top: guide.vertical.from, height: Math.max(1, guide.vertical.to - guide.vertical.from) }} />
            )}
            {guide?.horizontal && (
              <div className="pointer-events-none absolute h-px bg-pink-400"
                style={{ top: guide.horizontal.y, left: guide.horizontal.from, width: Math.max(1, guide.horizontal.to - guide.horizontal.from) }} />
            )}
            {marquee && (
              <div className="absolute border border-primary bg-primary/10" style={marquee} />
            )}
            {extraRects.map((r, i) => (
              <div key={i} className="absolute border border-primary shadow-[0_0_0_1px_rgba(0,0,0,0.35)]" style={r} />
            ))}
            {selectedUiRect && uiDoc && selectedUiElementId && selectedDesignWidth > 0 && (
              <DragHandles
                rect={selectedUiRect}
                designWidth={selectedDesignWidth}
                onDrag={onDrag}
                onCommit={endDrag}
                onCancel={endDrag}
                onSnap={snapDrag}
                guide={null}
                onDoubleClick={editableLead ? beginTextEdit : () => choosePanel(true)}
                keepAspect={leadIsImage}
              />
            )}
            {editableLead && uiDoc && selectedUiRect && !dragging && extraRects.length === 0 && editingTextId !== editableLead.id && (() => {
              const pageId = findElementPage(uiDoc, editableLead.id);
              // The other parts, where the bar must not sit. Big grounds
              // (a backdrop, the transcript) are under everything and do not count.
              const stage = stageRef.current?.getBoundingClientRect();
              const root = previewRef.current ? findCardRoot(previewRef.current) : null;
              const own = new Set([...selectionIds, editableLead.id]);
              // The page is the scaled canvas inside the card's stage; on the
              // phone it is far narrower than the stage frame around it.
              const canvasEl = root?.querySelector?.<HTMLElement>("[data-ui-stage] div[style*='scale(']") ?? null;
              const pageRect = stage ? (canvasEl?.getBoundingClientRect() ?? stage) : null;
              const nodes = stage && root?.querySelectorAll ? [...root.querySelectorAll<HTMLElement>("[data-ui-el]")] : [];
              const toStage = (r: DOMRect) => ({ top: r.top - stage!.top, left: r.left - stage!.left, width: r.width, height: r.height });
              const others = nodes
                .filter((n) => !own.has(n.dataset.uiEl ?? ""))
                .map((n) => n.getBoundingClientRect())
                .filter((r) => r.width > 0 && r.height > 0 && r.width * r.height < stage!.width * stage!.height * 0.35)
                .map(toStage);
              // The whole part — a status bar's label, track and number — not
              // just the piece that leads it.
              const mine = nodes.filter((n) => own.has(n.dataset.uiEl ?? "")).map((n) => toStage(n.getBoundingClientRect())).filter((r) => r.width > 0);
              const anchor = mine.length ? (() => {
                const top = Math.min(...mine.map((r) => r.top)), left = Math.min(...mine.map((r) => r.left));
                return { top, left, width: Math.max(...mine.map((r) => r.left + r.width)) - left, height: Math.max(...mine.map((r) => r.top + r.height)) - top };
              })() : selectedUiRect;
              return pageId ? (
                <FloatingTextBar doc={uiDoc} lead={editableLead} pageId={pageId} canvas={canvas} rect={selectedUiRect} onDoc={setUiDoc}
                  others={others} anchor={anchor}
                  stage={pageRect ? { top: pageRect.top - stage!.top, left: pageRect.left - stage!.left, width: pageRect.width, height: pageRect.height } : undefined}
                  room={pageRect && scrollEl ? (() => { const c = scrollEl.getBoundingClientRect(); return { left: pageRect.left - c.left, right: c.right - pageRect.right }; })() : undefined}
                  onMore={sidebarOpen ? undefined : () => choosePanel(true)} />
              ) : null;
            })()}
            {editingTextId && editableLead && editableLead.id === editingTextId && selectedUiRect && selectedDesignWidth > 0 && (
              <InlineTextEditor
                key={editingTextId}
                el={editableLead}
                node={(selected?.getRootNode() as ParentNode | undefined)?.querySelector?.<HTMLElement>(`[data-ui-el="${CSS.escape(editingTextId)}"]`) ?? null}
                rect={selectedUiRect}
                scale={selectedUiRect.width / selectedDesignWidth}
                variables={variables}
                onCancel={() => setEditingTextId(null)}
                onCommit={(template) => {
                  setEditingTextId(null);
                  const pageId = uiDoc ? findElementPage(uiDoc, editingTextId) : null;
                  if (!uiDoc || !pageId) return;
                  const edited = updateElements(uiDoc, pageId, [editingTextId], (el) =>
                    el.type === "text" ? { ...el, text: { ...el.text, template } }
                    : el.type === "button" ? { ...el, label: { ...el.label, template } }
                    : el);
                  // The box follows the words it now holds, taller or shorter.
                  const before = uiDoc.pages.find((p) => p.id === pageId)?.elements.find((e) => e.id === editingTextId);
                  setUiDoc(before?.type === "text" ? {
                    ...edited,
                    pages: edited.pages.map((p) => (p.id === pageId ? fitTextOnPage(p, before.id, before, { hug: true }) : p)),
                  } : edited);
                }}
              />
            )}
            {(selectedUiRect ?? selectedRect) && (
              <div
                className="absolute border border-primary shadow-[0_0_0_1px_rgba(0,0,0,0.35)]"
                style={selectedUiRect ?? selectedRect!}
              >
                {inspector.selected && (
                  <span className="absolute -top-[18px] left-0 whitespace-nowrap rounded-sm bg-primary px-1.5 py-0.5 font-mono text-[10px] leading-none text-primary-foreground">
                    {uiElementLabel(inspector.selected) ?? describeElement(inspector.selected).label}
                  </span>
                )}
              </div>
            )}
          </div>
          </div>

        </div>

        {/* Breadcrumb — the way back up out of whatever leaf the click landed on. */}
        {chain.length > 0 && !uiDoc && (
          <div className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-t border-border/50 px-2 py-1">
            {chain.map((el, i) => {
              const isLast = i === chain.length - 1;
              return (
                <span key={i} className="flex shrink-0 items-center gap-0.5">
                  {i > 0 && <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/30" />}
                  <button
                    type="button"
                    onClick={() => select(el)}
                    className={cn(
                      "rounded px-1 py-0.5 font-mono text-[10px] transition-colors",
                      isLast
                        ? "bg-primary/20 text-primary"
                        : "text-muted-foreground/60 hover:bg-accent hover:text-foreground",
                    )}
                  >
                    {describeElement(el).label}
                  </button>
                </span>
              );
            })}
          </div>
        )}
        {screenFirst && (
          <div className={cn(immersive && sidebarOpen && "@[880px]:pr-[352px]")}>
            <StoryNotes readOnly={readOnly} />
          </div>
        )}
      </div>

      {sidebarOpen && <div
        id={sidebarId}
        data-inspect-sidebar=""
        className={cn(
          "flex shrink-0 flex-col overflow-hidden",
          immersive
            // A card that fills the screen should not lose a third of it to a
            // panel that is only in use while something is selected. It floats
            // over the card's own margin instead, and closing it gives the
            // width straight back.
            ? "absolute inset-x-3 bottom-3 z-30 max-h-[52%] rounded-2xl border border-white/10 @[880px]:inset-x-auto @[880px]:right-3 @[880px]:top-3 @[880px]:max-h-none @[880px]:w-[340px]"
            : cn(
                "w-full border-t border-border/60 @[880px]:h-full @[880px]:max-h-none @[880px]:w-80 @[880px]:border-l @[880px]:border-t-0",
                sheetOpen ? "h-[42%] max-h-[48%]" : "h-auto",
              ),
        )}
        style={{
          background: "linear-gradient(180deg, #17141f 0%, #110f17 100%)",
          boxShadow: immersive
            ? "0 24px 80px rgba(0,0,0,0.65), inset 0 1px 0 rgba(255,255,255,0.06)"
            : "inset 0 1px 0 rgba(255,255,255,0.05)",
        }}
      >
        <div
          data-inspect-sheet-head=""
          className={cn("relative flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2", !immersive && "@max-[880px]:touch-none")}
          // A swipe on the folded row opens the sheet, one on the open row
          // folds it; a tap does the same through the button below. Followed
          // on the window: the finger leaves a 38px row long before 24px.
          onPointerDown={immersive ? undefined : (event) => {
            const swipe = { y: event.clientY, moved: false };
            sheetSwipe.current = swipe;
            const move = (e: PointerEvent) => {
              if (swipe.moved || Math.abs(e.clientY - swipe.y) < 24) return;
              swipe.moved = true;
              setSheetUp(e.clientY < swipe.y);
            };
            const up = () => {
              window.removeEventListener("pointermove", move);
              window.removeEventListener("pointerup", up);
              window.removeEventListener("pointercancel", up);
              // The click that ends a swipe must not toggle it straight back.
              window.setTimeout(() => { if (sheetSwipe.current === swipe) sheetSwipe.current = null; }, 0);
            };
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", up);
            window.addEventListener("pointercancel", up);
          }}
        >
          {!immersive && <span aria-hidden className="absolute left-1/2 top-1 h-1 w-9 -translate-x-1/2 rounded-full bg-white/15 @[880px]:hidden" />}
          <PanelRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className={cn("min-w-0 flex-1 text-xs font-semibold", !immersive && "@max-[880px]:hidden")}>
            {panelTitle}
          </span>
          {!immersive && (
            <button
              type="button"
              data-testid="inspect-sheet-toggle"
              aria-expanded={sheetOpen}
              aria-controls={`${sidebarId}-body`}
              onClick={() => { if (sheetSwipe.current?.moved) return; setSheetUp((up) => !up); }}
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs @[880px]:hidden"
            >
              <span className="shrink-0 font-semibold">{panelTitle}</span>
              {sheetPart && <span className="min-w-0 truncate text-muted-foreground">· {sheetPart}</span>}
              <ChevronUp className={cn("ml-auto h-4 w-4 shrink-0 text-muted-foreground transition-transform", sheetOpen && "rotate-180")} />
            </button>
          )}
          <button
            type="button"
            onClick={() => choosePanel(false)}
            title={t("studio.inspect.hidePanel")}
            aria-label={t("studio.inspect.hidePanel")}
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <div id={`${sidebarId}-body`} className={cn("min-h-0 flex-1", !immersive && !sheetOpen && "@max-[880px]:hidden")}>
        {panelDoc ? <ElementPanel
          doc={panelDoc}
          selectedElementId={selectedUiElementId}
          selectionIds={selectionIds}
          variables={variables}
          canvas={viewport === "phone" ? "phone" : "desktop"}
          onAddVariable={addMeterVariable}
          editPageId={currentPageId ?? undefined}
          onEditPage={choosePage}
          greetings={greetingOptions}
          tracks={audioTracks ?? []}
          onAdded={(id) => {
            selectWhenDrawn(id);
            // New words are typed straight away, the way a new text box is in
            // Slides: it opens selected-all, so the first keystroke replaces
            // 「新文字」.
            editWhenSelected.current = id;
            // Placed on both canvases; say so about the one not in view.
            setPlacedHint(viewport === "phone" ? "desktop" : "phone");
          }}
          worldId={serverWorldId}
          onSelectPart={selectFromLayers}
          hiddenIds={hiddenIds}
          onToggleHidden={toggleHidden}
          onNewPage={() => setGalleryOpen(true)}
        />
        : <InspectSidebar
          selected={selected}
          chain={chain}
          boundary={previewRef.current}
          // Reached only when the card has no uiDoc, and knob groups live on
          // the document — so there are none to pass here.
          knobGroups={[]}
          attachedRef={attachedRef}
          exits={{
            onOpenCode: openCode,
            onSendToAgent: sendToAgent,
            onSetKnob: setKnob,
            onAskDecompose: askDecompose,
          }}
        />}
        </div>
      </div>}
      </div>
    </div>
  );
}

/** The shadow root the card renders into. */
function findCardRoot(root: ParentNode): ShadowRoot | null {
  for (const el of Array.from(root.querySelectorAll("*"))) {
    const shadow = (el as HTMLElement).shadowRoot;
    if (shadow && shadow.querySelector("[data-ui-stage]")) return shadow;
  }
  return null;
}

/** The compiled element with this id, looked for through the preview's shadow
 *  roots — `querySelector` alone stops at the first boundary. */
function findUiElementNode(root: ParentNode | null, elementId: string): Element | null {
  if (!root) return null;
  const selector = `[data-ui-el="${CSS.escape(elementId)}"]`;
  const direct = root.querySelector(selector);
  if (direct) return direct;
  for (const el of Array.from(root.querySelectorAll("*"))) {
    const shadow = (el as HTMLElement).shadowRoot;
    if (!shadow) continue;
    const inner = findUiElementNode(shadow, elementId);
    if (inner) return inner;
  }
  return null;
}
