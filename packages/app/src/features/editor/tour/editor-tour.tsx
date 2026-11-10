import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useEditorStore, type EditorSection } from "@/stores/editor";

import { markEditorTourDone, type EditorTourVariant } from "./tour-state";

/* ─── Step model ─── */

type EditorStoreState = ReturnType<typeof useEditorStore.getState>;

type TourAdvance =
  | { kind: "next" }
  | { kind: "when"; when: (s: EditorStoreState) => boolean }
  /** Advance when a DOM element appears (for UI state the store can't see,
   *  e.g. the mobile section dropdown gaining Radix's data-state="open") */
  | { kind: "element"; selector: string }
  /** Advance when a store-derived count grows past its value at step entry
   *  (e.g. "add a variable" — works no matter how many already exist) */
  | { kind: "delta"; get: (s: EditorStoreState) => number }
  /** Advance when a store-derived string differs from its value at step entry
   *  AND is non-empty (e.g. "give your character a name" — the template
   *  default counts as unchanged, so the user has to actually type). */
  | { kind: "changed"; get: (s: EditorStoreState) => string };

interface TourStep {
  /** i18n key suffix: editor:tour.steps.<id>.title / .body */
  id: string;
  /** CSS selector to spotlight; null = centered card (welcome / finish) */
  target: string | null;
  /** Switch to this section when the step mounts (guided auto-navigation) */
  section?: EditorSection;
  advance: TourAdvance;
  /** Skip the step entirely when this returns true at mount time */
  skipIf?: (s: EditorStoreState) => boolean;
  /** Runs once as the step is shown, before its target is looked for — for a
   *  step whose target only exists once there is something to point at (a
   *  blank card has no character, so 「给角色起名」 makes one first). */
  prepare?: () => void;
  /** When the target vanishes/never appears: default skips forward; "back"
   *  returns to the previous step (e.g. a menu item whose menu got closed) */
  onMissing?: "back";
  placement?: "top" | "bottom" | "left" | "right";
  mushie?: "stand" | "sit";
  spotlightPadding?: number;
  /** Layout gating for step lists shared between desktop and mobile (the
   *  simple editor is one scroll page on both, only the header differs). */
  desktopOnly?: boolean;
  mobileOnly?: boolean;
  /** When the target is taller than the viewport, scroll so its TOP is visible
   *  instead of centering — the fields the card talks about (name, keywords)
   *  live at the top of tall detail panels and "center" pushes them offscreen. */
  scrollTo?: "start";
}

const hasGreeting = (s: EditorStoreState) =>
  s.worldDraft.entries.some((e) => e.role === "greeting");

const firstGreetingContent = (s: EditorStoreState) =>
  s.worldDraft.entries.find((e) => e.role === "greeting")?.content ?? "";

const hasGreetingText = (s: EditorStoreState) => firstGreetingContent(s).trim().length > 0;

// 副 (non-primary same-language variants) hide the Overview section entirely —
// tour steps that live there must skip instead of dead-blocking on a target
// that can never appear.
const isNonPrimaryVariant = (s: EditorStoreState) => {
  const current = s.variants?.find((v) => v.id === s.serverWorldId);
  return !!current && current.isPrimaryVariant === false;
};

const nonGreetingEntryCount = (s: EditorStoreState) =>
  s.worldDraft.entries.filter((e) => e.role !== "greeting").length;

const STEPS: TourStep[] = [
  { id: "welcome", target: null, mushie: "sit", advance: { kind: "next" } },
  { id: "nav", target: ".editor-shell-nav", placement: "right", advance: { kind: "next" } },
  {
    id: "goFirstMessage",
    target: '[data-tour-section="first-message"]',
    placement: "right",
    advance: { kind: "when", when: (s) => s.activeSection === "first-message" },
  },
  {
    // section is set even though the previous step navigates here: if the user
    // per-step-skips the navigation step, this one still lands in the right
    // place instead of dead-waiting on an absent target. Same pattern below.
    id: "createGreeting",
    target: '[data-tour="fm-empty-cta"]',
    section: "first-message",
    placement: "bottom",
    skipIf: hasGreeting,
    advance: { kind: "when", when: hasGreeting },
  },
  {
    id: "greetingContent",
    target: '[data-tour="fm-content"]',
    placement: "top",
    advance: { kind: "next" },
  },
  {
    // Hands-on: the template ships the greeting EMPTY (its guidance is a
    // placeholder now), so the first thing a newcomer writes is the opening.
    id: "greetingWrite",
    target: '[data-tour="fm-content"]',
    placement: "top",
    skipIf: hasGreetingText,
    advance: { kind: "when", when: hasGreetingText },
  },
  {
    id: "goLorebook",
    target: '[data-tour-section="entries"]',
    placement: "right",
    advance: { kind: "when", when: (s) => s.activeSection === "entries" },
  },
  {
    // Modules are mentioned, not exercised — newcomers only need the shared
    // lorebook. The step points at the nav item, which is there whether or
    // not the card has any.
    id: "kbBooks",
    target: '[data-tour-section="modules"]',
    section: "entries",
    placement: "right",
    advance: { kind: "next" },
  },
  {
    id: "entriesAdd",
    target: '[data-tour="entries-add"]',
    placement: "bottom",
    advance: { kind: "delta", get: nonGreetingEntryCount },
  },
  {
    id: "entryContent",
    target: '[data-tour="entries-detail"]',
    placement: "left",
    scrollTo: "start",
    advance: { kind: "next" },
  },
  {
    id: "goVariables",
    target: '[data-tour-section="variables"]',
    placement: "right",
    advance: { kind: "when", when: (s) => s.activeSection === "variables" },
  },
  {
    id: "varsAdd",
    target: '[data-tour="vars-add"]',
    section: "variables",
    placement: "bottom",
    advance: { kind: "delta", get: (s) => s.worldDraft.variables.length },
  },
  {
    id: "varsFields",
    target: '[data-tour="vars-form"]',
    placement: "left",
    scrollTo: "start",
    advance: { kind: "next" },
  },
  {
    id: "goBehaviors",
    target: '[data-tour-section="rules"]',
    placement: "right",
    advance: { kind: "when", when: (s) => s.activeSection === "rules" },
  },
  {
    id: "behaviorsAdd",
    target: '[data-tour="behaviors-add"]',
    section: "rules",
    placement: "bottom",
    advance: { kind: "delta", get: (s) => (s.worldDraft.reactions ?? []).length },
  },
  {
    id: "behaviorsDetail",
    target: '[data-tour="behaviors-detail"]',
    placement: "left",
    scrollTo: "start",
    advance: { kind: "next" },
  },
  {
    id: "presentationSkip",
    target: '[data-tour-group="presentation"]',
    placement: "right",
    advance: { kind: "next" },
  },
  {
    id: "overviewTitle",
    target: '[data-tour="overview-title-card"]',
    section: "overview",
    placement: "bottom",
    skipIf: isNonPrimaryVariant,
    advance: { kind: "next" },
  },
  {
    id: "overviewDescription",
    target: '[data-tour="overview-description"]',
    placement: "top",
    skipIf: isNonPrimaryVariant,
    advance: { kind: "next" },
  },
  {
    id: "publish",
    target: '[data-tour="publish-control"]',
    placement: "bottom",
    advance: { kind: "next" },
  },
  { id: "save", target: '[data-tour="save"]', placement: "bottom", advance: { kind: "next" } },
  { id: "studio", target: '[data-tour="studio"]', placement: "bottom", advance: { kind: "next" } },
  { id: "finish", target: null, mushie: "sit", advance: { kind: "next" } },
];

// Mobile variant: same hands-on core (create greeting / entry / variable /
// behavior), but section switching is tour-driven — the mobile section picker
// is a Radix dropdown in a body portal, and forcing users to fight it under a
// spotlight overlay is worse than just teaching the menu once and navigating
// for them. The card renders as a bottom dialog (see render).
const STEPS_MOBILE: TourStep[] = [
  { id: "welcome", target: null, mushie: "sit", advance: { kind: "next" } },
  {
    // Hands-on: open the section menu (Radix marks the trigger data-state=open)
    id: "menuOpen",
    target: '[data-tour="m-section-menu"]',
    advance: { kind: "element", selector: '[data-tour="m-section-menu"][data-state="open"]' },
  },
  {
    // Hands-on: pick 开场白 from the opened menu. Tapping outside closes the
    // Radix menu → the item vanishes → fall BACK to menuOpen instead of
    // skipping forward.
    id: "menuPick",
    target: '[data-tour-section-m="first-message"]',
    onMissing: "back",
    advance: { kind: "when", when: (s) => s.activeSection === "first-message" },
  },
  {
    id: "createGreeting",
    target: '[data-tour="fm-empty-cta"]',
    section: "first-message",
    skipIf: hasGreeting,
    advance: { kind: "when", when: hasGreeting },
  },
  { id: "greetingContent", target: '[data-tour="fm-content"]', advance: { kind: "next" } },
  {
    id: "greetingWrite",
    target: '[data-tour="fm-content"]',
    skipIf: hasGreetingText,
    advance: { kind: "when", when: hasGreetingText },
  },
  { id: "kbBooksM", target: '[data-tour-section-m="modules"]', section: "entries", advance: { kind: "next" } },
  {
    id: "entriesAdd",
    target: '[data-tour="entries-add"]',
    advance: { kind: "delta", get: nonGreetingEntryCount },
  },
  { id: "entryContent", target: '[data-tour="entries-detail"]', scrollTo: "start", advance: { kind: "next" } },
  {
    id: "varsAdd",
    target: '[data-tour="vars-add"]',
    section: "variables",
    advance: { kind: "delta", get: (s) => s.worldDraft.variables.length },
  },
  { id: "varsFields", target: '[data-tour="vars-form"]', scrollTo: "start", advance: { kind: "next" } },
  {
    id: "behaviorsAdd",
    target: '[data-tour="behaviors-add"]',
    section: "rules",
    advance: { kind: "delta", get: (s) => (s.worldDraft.reactions ?? []).length },
  },
  { id: "behaviorsDetail", target: '[data-tour="behaviors-detail"]', scrollTo: "start", advance: { kind: "next" } },
  { id: "menuAdvanced", target: '[data-tour="m-section-menu"]', advance: { kind: "next" } },
  { id: "overviewTitle", target: '[data-tour="overview-title-card"]', section: "overview", skipIf: isNonPrimaryVariant, advance: { kind: "next" } },
  { id: "overviewDescription", target: '[data-tour="overview-description"]', skipIf: isNonPrimaryVariant, advance: { kind: "next" } },
  { id: "publishM", target: '[data-tour="publish-control"]', advance: { kind: "next" } },
  { id: "saveM", target: '[data-tour="m-save"]', advance: { kind: "next" } },
  { id: "finish", target: null, mushie: "sit", advance: { kind: "next" } },
];

// Simple (quick-create) editor: one scroll page of numbered cards, identical on
// desktop and mobile except the header — so a single list, with the header
// steps gated per layout. The anchors live in quick-create-editor.tsx.
const TAG_WORLDVIEW = "chat:worldview";
const TAG_DIALOGUE_STYLE = "chat:dialogue-style";
const lacksTaggedEntry = (tag: string) => (s: EditorStoreState) =>
  !s.worldDraft.entries.some((e) => e.tags?.includes(tag));
const firstCharacterName = (s: EditorStoreState) =>
  s.worldDraft.entries.find((e) => e.role === "character")?.name ?? "";

/** A blank card has no character, so the name step would spotlight nothing
 *  and leave only 「跳过」. Give it one — the same empty character the
 *  section's 「添加角色」 button makes — and the section opens it. */
const ensureCharacterForTour = () => {
  const store = useEditorStore.getState();
  if (store.worldDraft.entries.some((e) => !e.presetId && e.role === "character")) return;
  store.addEntry("character", "system-presets");
  const entries = useEditorStore.getState().worldDraft.entries;
  const created = entries[entries.length - 1];
  if (created) {
    store.updateEntry(created.id, { name: "", role: "character", alwaysSend: true, enabled: true, tags: ["Character"] });
  }
};

const STEPS_SIMPLE: TourStep[] = [
  { id: "sWelcome", target: null, mushie: "sit", advance: { kind: "next" } },
  { id: "sCards", target: '[data-tour="qc-cover"]', placement: "bottom", advance: { kind: "next" } },
  {
    // Hands-on: the template names the character "Character" — typing a real
    // name is the first thing every card needs.
    id: "sCharName",
    target: '[data-tour="qc-char-name"]',
    placement: "bottom",
    prepare: ensureCharacterForTour,
    advance: { kind: "changed", get: firstCharacterName },
  },
  { id: "sPersona", target: '[data-tour="qc-persona"]', placement: "top", advance: { kind: "next" } },
  {
    id: "sWorldview",
    target: '[data-tour="qc-worldview"]',
    placement: "top",
    skipIf: lacksTaggedEntry(TAG_WORLDVIEW),
    advance: { kind: "next" },
  },
  {
    id: "sStyle",
    target: '[data-tour="qc-style"]',
    placement: "top",
    skipIf: lacksTaggedEntry(TAG_DIALOGUE_STYLE),
    advance: { kind: "next" },
  },
  { id: "sSettings", target: '[data-tour="qc-settings"]', placement: "top", advance: { kind: "next" } },
  {
    // Hands-on: write the opening line. The template ships the greeting empty
    // (guidance is a placeholder), so this is a real first sentence.
    id: "sGreeting",
    target: '[data-tour="qc-greeting-text"]',
    placement: "top",
    skipIf: hasGreetingText,
    advance: { kind: "when", when: hasGreetingText },
  },
  { id: "sAbout", target: '[data-tour="qc-about"]', placement: "top", advance: { kind: "next" } },
  { id: "sSave", target: '[data-tour="qc-save"]', placement: "bottom", advance: { kind: "next" } },
  { id: "sPlay", target: '[data-tour="qc-play"]', placement: "top", desktopOnly: true, advance: { kind: "next" } },
  { id: "sPublish", target: '[data-tour="publish-control"]', placement: "bottom", advance: { kind: "next" } },
  {
    id: "sAdvanced",
    target: '[data-tour="qc-mode-toggle"]',
    placement: "bottom",
    desktopOnly: true,
    advance: { kind: "next" },
  },
  {
    id: "sAdvancedM",
    target: '[data-tour="qc-advanced-promo"]',
    mobileOnly: true,
    advance: { kind: "next" },
  },
  { id: "sFinish", target: null, mushie: "sit", advance: { kind: "next" } },
];

/* ─── Geometry helpers ─── */

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

const CARD_WIDTH = 380;
const CARD_EST_HEIGHT = 190;
const GAP = 14;
const EDGE = 12;

function clamp(v: number, min: number, max: number) {
  return Math.min(Math.max(v, min), max);
}

function placeCard(rect: Box, preferred: TourStep["placement"]): { top: number; left: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.min(CARD_WIDTH, vw - EDGE * 2);
  const h = CARD_EST_HEIGHT;

  const candidates: ("bottom" | "top" | "right" | "left")[] = preferred
    ? [preferred, "bottom", "top", "right", "left"]
    : ["bottom", "top", "right", "left"];

  for (const side of candidates) {
    if (side === "bottom" && rect.top + rect.height + GAP + h <= vh - EDGE) {
      return {
        top: rect.top + rect.height + GAP,
        left: clamp(rect.left + rect.width / 2 - w / 2, EDGE, vw - w - EDGE),
      };
    }
    if (side === "top" && rect.top - GAP - h >= EDGE) {
      return {
        top: rect.top - GAP - h,
        left: clamp(rect.left + rect.width / 2 - w / 2, EDGE, vw - w - EDGE),
      };
    }
    if (side === "right" && rect.left + rect.width + GAP + w <= vw - EDGE) {
      return {
        top: clamp(rect.top + rect.height / 2 - h / 2, EDGE, vh - h - EDGE),
        left: rect.left + rect.width + GAP,
      };
    }
    if (side === "left" && rect.left - GAP - w >= EDGE) {
      return {
        top: clamp(rect.top + rect.height / 2 - h / 2, EDGE, vh - h - EDGE),
        left: rect.left - GAP - w,
      };
    }
  }
  // Nothing fits cleanly — pin to bottom center of the viewport.
  return { top: vh - h - EDGE, left: clamp(vw / 2 - w / 2, EDGE, vw - w - EDGE) };
}

/** Final safety: never let the card leave the viewport, even when the target
 *  rect itself is (partially) offscreen. */
function clampCard(pos: { top: number; left: number }): { top: number; left: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.min(CARD_WIDTH, vw - EDGE * 2);
  return {
    top: clamp(pos.top, EDGE, Math.max(EDGE, vh - CARD_EST_HEIGHT - EDGE)),
    left: clamp(pos.left, EDGE, Math.max(EDGE, vw - w - EDGE)),
  };
}

/* ─── Component ─── */

/** Target elements can appear a beat after a section switch; if one never
 *  shows up (hidden section, conditional control) the step self-skips. */
const TARGET_TIMEOUT_MS = 2500;
const POLL_MS = 200;
/** Delay before moving the spotlight after an interactive step completes, so
 *  the app's own transition (section switch, list re-render) settles first. */
const ADVANCE_SETTLE_MS = 350;
/** Slightly longer beat when a step's condition is already true at mount. */
const ALREADY_SATISFIED_MS = 400;

export function EditorTour({
  onClose,
  mobile = false,
  variant = "advanced",
}: {
  onClose: () => void;
  mobile?: boolean;
  variant?: EditorTourVariant;
}) {
  const { t } = useTranslation("editor");
  // Stable identity is load-bearing: `steps` feeds goNext's deps which feed the
  // advance effect's deps — a fresh array per render would remount that effect
  // on every render, clearing pending advance timers and re-capturing delta
  // baselines (swallowing the very increment the step is waiting for).
  const steps = useMemo(() => {
    if (variant === "simple") {
      return STEPS_SIMPLE.filter((s) => (mobile ? !s.desktopOnly : !s.mobileOnly));
    }
    return mobile ? STEPS_MOBILE : STEPS;
  }, [mobile, variant]);
  // i18n bodies mention the {{user}} / {{char}} macros. i18next would treat
  // those as interpolation slots, so the copy writes {{userMacro}} and we hand
  // the literal braces in as values.
  const tourVars = useMemo(() => ({ userMacro: "{{user}}", charMacro: "{{char}}" }), []);
  const [stepIdx, setStepIdx] = useState(0);
  const [rect, setRect] = useState<Box | null>(null);
  const [targetMissing, setTargetMissing] = useState(false);

  // Resolve skipIf at entry time — recomputed whenever stepIdx changes.
  const step = useMemo(() => {
    let idx = stepIdx;
    const state = useEditorStore.getState();
    while (idx < steps.length && steps[idx].skipIf?.(state)) idx++;
    return idx < steps.length ? { ...steps[idx], _idx: idx } : null;
  }, [stepIdx, steps]);

  // Advance is always relative to the step actually being displayed — never
  // re-resolve skipIf here: a "when" advance can flip its own skipIf true at
  // the same instant (e.g. createGreeting), which would double-skip.
  const displayedIdxRef = useRef(0);
  if (step) displayedIdxRef.current = step._idx;
  // Every step index that has actually been rendered this run — feeds the
  // progress counter (see render).
  const displayedRef = useRef<Set<number>>(new Set());

  // Hold onClose in a ref so finish/goNext keep a STABLE identity even when
  // the parent passes an inline closure. This matters: the advance effect
  // depends on goNext, and an identity change remounts it — clearing the
  // pending advance timer and re-capturing delta baselines at the exact moment
  // the user completed the step (the store change that fulfilled the step also
  // re-renders the shell, which re-creates an inline onClose).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const finish = useCallback(() => {
    markEditorTourDone(variant);
    onCloseRef.current();
  }, [variant]);

  const goNext = useCallback(() => {
    const next = displayedIdxRef.current + 1;
    if (next >= steps.length) {
      finish();
    } else {
      setStepIdx(next);
    }
  }, [finish, steps]);

  // A step that needs something to point at makes it first.
  useEffect(() => {
    step?.prepare?.();
  }, [step?._idx, step?.prepare]);

  // Auto-switch section for guided steps
  useEffect(() => {
    if (step?.section) {
      useEditorStore.getState().setActiveSection(step.section);
    }
  }, [step?.section, step?._idx]);

  // Track the target element's rect (poll + resize/scroll for snappy updates).
  useEffect(() => {
    if (!step) return;
    setTargetMissing(false);
    // Clear the previous step's rect so the spotlight never lingers on the old
    // element while the new target is still being located.
    setRect(null);
    if (!step.target) {
      return;
    }
    const selector = step.target;
    const startedAt = Date.now();
    let found = false;
    let cancelled = false;
    let scrolledIntoView = false;

    const measure = () => {
      if (cancelled) return;
      const el = document.querySelector(selector);
      if (!el && found) {
        // Target vanished after being located (e.g. a menu closed) — trigger
        // the missing handler right away instead of pointing at empty space.
        cancelled = true;
        setTargetMissing(true);
        return;
      }
      if (el) {
        found = true;
        const r = el.getBoundingClientRect();
        // Target below/above the fold (e.g. the Overview description card) —
        // bring it into view once so the spotlight lands on something visible.
        // Panels taller than the viewport (entry detail, variable form) can't
        // be centered: "center" scrolls their top half — the name field the
        // card talks about — above the fold. Align their top instead.
        if (!scrolledIntoView) {
          scrolledIntoView = true;
          const tall = r.height > window.innerHeight * 0.7;
          if (r.top < 0 || r.bottom > window.innerHeight || (tall && step.scrollTo === "start")) {
            el.scrollIntoView({
              block: step.scrollTo === "start" || tall ? "start" : "center",
              behavior: "smooth",
            });
          }
        }
        setRect((prev) => {
          if (
            prev &&
            Math.abs(prev.top - r.top) < 1 &&
            Math.abs(prev.left - r.left) < 1 &&
            Math.abs(prev.width - r.width) < 1 &&
            Math.abs(prev.height - r.height) < 1
          ) {
            return prev;
          }
          return { top: r.top, left: r.left, width: r.width, height: r.height };
        });
      } else if (!found && Date.now() - startedAt > TARGET_TIMEOUT_MS) {
        // Target never appeared (conditional UI) — skip this step.
        cancelled = true;
        setTargetMissing(true);
      }
    };

    measure();
    const interval = window.setInterval(measure, POLL_MS);
    // rAF-throttle the scroll/resize path — capture-phase scroll fires for
    // every nested scroller and unthrottled measure() would re-layout per event.
    let rafId = 0;
    const onScrollOrResize = () => {
      if (rafId) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = 0;
        measure();
      });
    };
    window.addEventListener("resize", onScrollOrResize);
    window.addEventListener("scroll", onScrollOrResize, true);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      if (rafId) window.cancelAnimationFrame(rafId);
      window.removeEventListener("resize", onScrollOrResize);
      window.removeEventListener("scroll", onScrollOrResize, true);
    };
  }, [step?._idx, step?.target]);

  // Target missing → skip forward, or fall back a step when the step asks
  // (menu items whose menu closed need the "open the menu" step again).
  useEffect(() => {
    if (!targetMissing) return;
    // Consume the flag immediately — this effect's deps include the step, so
    // after stepping back/forward it re-runs with the NEW step while the flag
    // is still true, and without the reset it would double-fire (back → then
    // goNext again) and ping-pong forever.
    setTargetMissing(false);
    // Vanish often races the advance itself: completing an interactive step is
    // what removes its target (picking a menu item closes the menu, creating a
    // greeting replaces the empty-state CTA). If the step's condition is
    // already met, the user DID the thing — go forward, never back.
    const adv = step?.advance;
    if (adv?.kind === "when" && adv.when(useEditorStore.getState())) {
      goNext();
      return;
    }
    if (step?.onMissing === "back") {
      setStepIdx(Math.max(0, displayedIdxRef.current - 1));
    } else {
      goNext();
    }
  }, [targetMissing, step?.advance, step?.onMissing, goNext]);

  // Interactive advance: store condition / count delta / element appearance.
  // Every scheduled goNext is cleared on cleanup — a stale timer surviving a
  // step change would fire against the NEW displayed step and double-skip
  // (e.g. vanish-detection and the when-subscription both advancing
  // createGreeting would blow straight through greetingContent).
  useEffect(() => {
    if (!step) return;
    const adv = step.advance;
    let timer: number | undefined;
    const schedule = (delay: number) => {
      timer = window.setTimeout(goNext, delay);
    };

    if (adv.kind === "when") {
      if (adv.when(useEditorStore.getState())) {
        // Condition already true (e.g. user already on that section) — move on.
        schedule(ALREADY_SATISFIED_MS);
        return () => window.clearTimeout(timer);
      }
      const unsub = useEditorStore.subscribe((state) => {
        if (adv.when(state)) {
          unsub();
          schedule(ADVANCE_SETTLE_MS);
        }
      });
      return () => {
        unsub();
        window.clearTimeout(timer);
      };
    }

    if (adv.kind === "delta") {
      const baseline = adv.get(useEditorStore.getState());
      const unsub = useEditorStore.subscribe((state) => {
        if (adv.get(state) > baseline) {
          unsub();
          schedule(ADVANCE_SETTLE_MS);
        }
      });
      return () => {
        unsub();
        window.clearTimeout(timer);
      };
    }

    if (adv.kind === "changed") {
      const baseline = adv.get(useEditorStore.getState());
      const unsub = useEditorStore.subscribe((state) => {
        const now = adv.get(state);
        if (now !== baseline && now.trim().length > 0) {
          unsub();
          schedule(ADVANCE_SETTLE_MS);
        }
      });
      return () => {
        unsub();
        window.clearTimeout(timer);
      };
    }

    if (adv.kind === "element") {
      if (document.querySelector(adv.selector)) {
        // Already satisfied (e.g. menu already open on a replay) — move on.
        schedule(ALREADY_SATISFIED_MS);
        return () => window.clearTimeout(timer);
      }
      const interval = window.setInterval(() => {
        if (document.querySelector(adv.selector)) {
          window.clearInterval(interval);
          schedule(ADVANCE_SETTLE_MS);
        }
      }, 150);
      return () => {
        window.clearInterval(interval);
        window.clearTimeout(timer);
      };
    }
  }, [step?._idx, step?.advance, goNext]);

  // Escape closes (counts as skip). Ignore Escapes that belong to something
  // else: IME composition cancels (CJK typing) and keys a Radix layer already
  // consumed to close a menu — both would otherwise kill the tour for good.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (e.isComposing || e.keyCode === 229 || e.defaultPrevented) return;
      finish();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [finish]);

  if (!step) return null;

  const interactive = step.advance.kind !== "next";
  /** Take the user to the thing the card is pointing at.
   *
   *  The hint used to be inert, which made it the one gold shape in the tour
   *  that did nothing when clicked. Clicking it is the right instinct — so it
   *  scrolls the target into view and puts the caret in it, and the step's own
   *  advance condition still decides when to move on. */
  const revealTarget = () => {
    if (!step.target) return;
    const el = document.querySelector<HTMLElement>(step.target);
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    const field = el.matches("input, textarea, select, [contenteditable]")
      ? el
      : el.querySelector<HTMLElement>("input, textarea, select, [contenteditable]");
    (field ?? el).focus?.({ preventScroll: true });
  };
  const pad = step.spotlightPadding ?? 8;
  // Clamp the hole to the viewport: a panel that extends above the fold would
  // otherwise "spotlight" whatever sits over its offscreen part (the header
  // bar), and the card would be placed relative to invisible geometry.
  const hole: Box | null = rect
    ? (() => {
        const top = Math.max(EDGE, rect.top - pad);
        const left = Math.max(EDGE, rect.left - pad);
        const bottom = Math.min(window.innerHeight - EDGE, rect.top + rect.height + pad);
        const right = Math.min(window.innerWidth - EDGE, rect.left + rect.width + pad);
        return { top, left, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
      })()
    : null;
  const centered = !step.target;
  // While a targeted step is still locating its element, the dim layer shows —
  // but the card must stay visible (bottom-center fallback) so Skip is always
  // reachable even if the target never appears.
  const locating = !!step.target && !hole;

  const cardPos = hole
    ? clampCard(placeCard(hole, step.placement))
    : step.target
      ? clampCard({
          top: window.innerHeight,
          left: window.innerWidth / 2 - Math.min(CARD_WIDTH, window.innerWidth - EDGE * 2) / 2,
        })
      : null;
  // Progress counts only steps this run actually shows: a step whose skipIf is
  // true never appears, so counting it made the counter jump (3/22 → 5/22).
  // Past steps are counted from what was really displayed (a hands-on step
  // that just got completed would otherwise flip its own skipIf and vanish
  // from the count); future steps from their skipIf against current state.
  displayedRef.current.add(step._idx);
  const storeState = useEditorStore.getState();
  const stepNumber = [...displayedRef.current].filter((i) => i <= step._idx).length;
  const shownTotal =
    stepNumber + steps.filter((s, idx) => idx > step._idx && !s.skipIf?.(storeState)).length;
  const mushieSrc = step.mushie === "sit" ? "/mushie-sit.png" : "/mushie-stand.png";

  return createPortal(
    // pointer-events-none on the root: the page must stay clickable through the
    // spotlight hole. Blockers and cards individually re-enable pointer events.
    <div className="pointer-events-none fixed inset-0 z-[100]" data-editor-tour>
      <style>{`
        @keyframes tourMushieBob {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-6px); }
        }
        @keyframes tourPulse {
          0% { box-shadow: 0 0 0 0 rgba(201, 162, 94, 0.55); }
          70% { box-shadow: 0 0 0 10px rgba(201, 162, 94, 0); }
          100% { box-shadow: 0 0 0 0 rgba(201, 162, 94, 0); }
        }
        @keyframes tourCardIn {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      {/* Dim layer. Centered steps (welcome/finish) dim the whole screen; for
          targeted steps the spotlight div below carries the dim via box-shadow. */}
      {(centered || locating) && (
        <div className="absolute inset-0 bg-black/60 transition-opacity" />
      )}

      {/* Spotlight hole — box-shadow paints the dim around it */}
      {hole && (
        <div
          className="absolute rounded-xl transition-all duration-300 ease-out"
          style={{
            top: hole.top,
            left: hole.left,
            width: hole.width,
            height: hole.height,
            boxShadow: "0 0 0 200vmax rgba(0, 0, 0, 0.6)",
            pointerEvents: "none",
          }}
        />
      )}

      {/* Pulse ring on interactive targets */}
      {hole && interactive && (
        <div
          className="absolute rounded-xl border-2 border-gold"
          style={{
            top: hole.top,
            left: hole.left,
            width: hole.width,
            height: hole.height,
            animation: "tourPulse 1.6s ease-out infinite",
            pointerEvents: "none",
          }}
        />
      )}

      {/* Click blockers: 4 rects around the hole. Interactive steps leave the
          hole itself clickable; explain steps cover it with a 5th blocker. */}
      {hole ? (
        <>
          <div className="pointer-events-auto absolute" style={{ top: 0, left: 0, right: 0, height: Math.max(0, hole.top) }} />
          <div
            className="pointer-events-auto absolute"
            style={{ top: hole.top, left: 0, width: Math.max(0, hole.left), height: hole.height }}
          />
          <div
            className="pointer-events-auto absolute"
            style={{ top: hole.top, left: hole.left + hole.width, right: 0, height: hole.height }}
          />
          <div className="pointer-events-auto absolute" style={{ top: hole.top + hole.height, left: 0, right: 0, bottom: 0 }} />
          {!interactive && (
            <div
              className="pointer-events-auto absolute"
              style={{ top: hole.top, left: hole.left, width: hole.width, height: hole.height }}
            />
          )}
        </>
      ) : (
        <div className="pointer-events-auto absolute inset-0" />
      )}

      {/* ── Card ── */}
      {centered ? (
        <div className="absolute inset-0 flex items-center justify-center p-4" style={{ pointerEvents: "none" }}>
          <div
            className="pointer-events-auto flex w-full max-w-md flex-col items-center rounded-2xl border border-gold/30 bg-popover p-6 text-center shadow-2xl"
            style={{ animation: "tourCardIn 0.35s ease-out both" }}
          >
            <img
              src={mushieSrc}
              alt=""
              className="mb-3 h-28 w-auto select-none"
              style={{ animation: "tourMushieBob 2.4s ease-in-out infinite" }}
              draggable={false}
            />
            <h2 className="mb-2 text-lg font-bold text-foreground">
              {t(`tour.steps.${step.id}.title` as any)}
            </h2>
            <p className="mb-5 whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
              {t(`tour.steps.${step.id}.body` as any, tourVars as any)}
            </p>
            {/* "Skip the tour" belongs to the card that opens it, not the one
                that closes it: on the final card the tour is already over, and
                offering to skip it reads as a second, worse way to finish. */}
            <div className={cn("flex w-full items-center", stepNumber === 1 ? "justify-between" : "justify-end")}>
              {stepNumber === 1 && (
                <button
                  onClick={finish}
                  className="whitespace-nowrap text-xs text-muted-foreground/70 transition-colors hover:text-muted-foreground"
                >
                  {t("tour.skip")}
                </button>
              )}
              <button
                onClick={goNext}
                className="rounded-lg bg-gold px-5 py-2 text-sm font-bold text-black transition-all hover:brightness-110"
              >
                {stepNumber === 1 ? t("tour.start") : t("tour.done")}
              </button>
            </div>
          </div>
        </div>
      ) : (
        (() => {
          const bubble = (
            <div
              key={step._idx}
              className="pointer-events-auto flex items-end gap-2"
              style={{ animation: "tourCardIn 0.3s ease-out both" }}
            >
              <img
                src={mushieSrc}
                alt=""
                className={cn("w-auto shrink-0 select-none drop-shadow-[0_4px_10px_rgba(0,0,0,0.45)]", mobile ? "h-16" : "h-20")}
                style={{ animation: "tourMushieBob 2.4s ease-in-out infinite" }}
                draggable={false}
              />
              <div className="max-h-[70vh] min-w-0 flex-1 overflow-y-auto rounded-2xl rounded-bl-sm border border-gold/30 bg-popover p-4 shadow-2xl">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <h3 className="text-sm font-bold text-foreground">
                    {t(`tour.steps.${step.id}.title` as any)}
                  </h3>
                  <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/50">
                    {stepNumber} / {shownTotal}
                  </span>
                </div>
                <p className="mb-3 whitespace-pre-line text-xs leading-relaxed text-muted-foreground">
                  {t(`tour.steps.${step.id}.body` as any, tourVars as any)}
                </p>
                <div className="flex items-center justify-between gap-2">
                  <button
                    onClick={finish}
                    className="whitespace-nowrap text-[11px] text-muted-foreground/70 transition-colors hover:text-muted-foreground"
                  >
                    {t("tour.skip")}
                  </button>
                  {interactive ? (
                    <span className="flex min-w-0 items-center gap-2">
                      {/* Per-step escape hatch: hands-on steps must never force
                          the user to create content (or abandon the whole tour)
                          to move forward. */}
                      <button
                        onClick={goNext}
                        className="shrink-0 whitespace-nowrap text-[11px] text-muted-foreground/70 transition-colors hover:text-muted-foreground"
                      >
                        {t("tour.skipStep")}
                      </button>
                      <button
                        type="button"
                        onClick={revealTarget}
                        className={cn(
                          "inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-gold/40 bg-gold/10 px-3 py-1.5 text-[11px] font-semibold text-gold",
                          "cursor-pointer transition-colors hover:bg-gold/20"
                        )}
                      >
                        👆 {t("tour.clickHint")}
                      </button>
                    </span>
                  ) : (
                    <button
                      onClick={goNext}
                      className="rounded-lg bg-gold px-4 py-1.5 text-xs font-bold text-black transition-all hover:brightness-110"
                    >
                      {t("tour.next")}
                    </button>
                  )}
                </div>
              </div>
            </div>
          );

          if (mobile) {
            // Bottom-pinned dialog (game-style) — small screens have no room
            // for smart side placement, and a fixed home keeps thumbs happy.
            return (
              <div
                className="absolute inset-x-2"
                style={{ bottom: "calc(env(safe-area-inset-bottom) + 8px)", pointerEvents: "none" }}
              >
                {bubble}
              </div>
            );
          }

          return (
            cardPos && (
              <div
                className="absolute"
                style={{
                  top: cardPos.top,
                  left: cardPos.left,
                  width: Math.min(CARD_WIDTH, window.innerWidth - EDGE * 2),
                  pointerEvents: "none",
                }}
              >
                {bubble}
              </div>
            )
          );
        })()
      )}
    </div>,
    document.body
  );
}
