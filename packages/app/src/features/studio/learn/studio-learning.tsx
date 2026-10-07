import { consumeQuietTour, quietTourRequested } from "@/lib/studio-entry";
import { isScreenFirst } from "@/lib/editor-surface";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, LocateFixed } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useEditorStore } from "@/stores/editor";
import { useUserProfileStore } from "@/stores/user-profile";
import { createLearningTracker } from "./learning-analytics";
import { useLearningWorkspace } from "./learning-workspace";
import { TourSpotlight, visibleTourElement } from "./tour-spotlight";
import { isStarterOpening } from "@/lib/world-templates";
import { LEARNING_CANCEL_EVENT, LEARNING_LESSONS, LEARNING_OPEN_EVENT, LEARNING_PANEL_EVENT, LEARNING_RELEASE, LEARNING_REVEAL_EVENT, LEARNING_SHOW_EVENT, LEARNING_STEP_EVENT,
  lessonById, lessonFocus, lessonStage, lessonTaken, lessonUnlocked, lessonsOf, nextLesson, readLearningProgress, requiredDone, writeLearningProgress,
  type LearningLesson, type LearningProgress, type LearningStepId } from "./learning-catalog";

export { StudioLearningButton } from "./learning-button";

export function StudioLearningCenter() {
  const account = useUserProfileStore(s => s.profile?.id ?? "guest");
  return <BlueprintTour key={account} account={account} />;
}

/** Everything happens in the one guide card, docked where it always is:
 *  a lesson ("step"), the end of one ("end": what to take next), or the
 *  list of all lessons ("list", what 新手引导 opens once the required three
 *  are done). No dialog, and no grid of lessons still to come. */
type Screen = "step" | "end" | "list" | null;
const noTarget = () => null;
const REQUIRED = lessonsOf("required");
const MORE = lessonsOf("more");
/** The one control each lesson points at, first match wins — except where
 *  the lesson is about two blocks standing side by side (`PAIRED`), which
 *  are highlighted as one. Nothing on this screen → the card floats without
 *  a highlight, which is right for a lesson about something the card does
 *  not have yet. */
const DESKTOP_TARGETS: Record<LearningStepId, string[]> = {
  opening: ['[data-canvas-writing-node="opening"]'],
  setting: ['[data-canvas-writing-node="setting"]'],
  interface: ['[data-onboarding="player-interface"]', '[data-onboarding="scene"]'],
  state: ['[data-onboarding="variables"]'],
  behavior: ['[data-onboarding="behaviors"]'],
  atmosphere: ['[data-onboarding="audio"]', '[data-onboarding="scene-images"]'],
  assistant: ['[data-onboarding="assistant"]'],
  card: ['[data-onboarding="card-face"]'],
  knowledge: ['[data-canvas-writing-node="setting"]'],
  looks: ['[data-onboarding="player-interface"]', '[data-onboarding="scene"]'],
  modules: ['[data-onboarding="memory"]', '[data-onboarding="add-content"]'],
  ais: ['.react-flow__node[data-id="block:ais"]', '[data-onboarding="add-content"]'],
  canvas: ['[data-onboarding="zoom"]', '[data-onboarding="blueprint"]'],
  ship: ['[data-onboarding="playtest"]', '[data-onboarding="playtest-switch"]', '[data-onboarding="save"]'],
};
const PAIRED: ReadonlySet<LearningStepId> = new Set(["atmosphere"]);
/** After a lesson has shown its block, it points at one thing at a time
 *  with the rest of the screen dimmed, so there is no hunting for it: a
 *  field worth reading, or the control the block is worked with — the 「+」
 *  that adds another, 「新建」. Each beat is a pause in the same lesson, with
 *  its own words; the card stays where it is and only the light moves.
 *  Wide screens only: a phone has no canvas to point into.
 *
 *  A beat that `asks` for its control to be clicked expects the learner to
 *  do it — the light all but invites it. The click opens something (the
 *  new opening in the column, the screen editor), so the lesson follows
 *  them there: `after` is what it shows next, one pointed step at a time,
 *  and 下一步 from the last of them brings the canvas back. */
type Beat = { id: string; target: string[]; asks?: true; after?: ReadonlyArray<{ id: string; target: string[] }> };
/** The block's ＋ puts a new variable or behaviour straight on the board and
 *  opens its settings in the column: the lesson follows it there. An opening
 *  is written in its own row. */
const NEW_VARIABLE = '[data-learn="var-basics"]';
const NEW_BEHAVIOR = '[data-learn="rx-when"]';
const OPEN_ROW = '[data-canvas-writing-editor]';
const BEATS: Partial<Record<LearningStepId, ReadonlyArray<Beat>>> = {
  opening: [{ id: "add", asks: true, target: ['[data-writing-add="opening"]'], after: [{ id: "added", target: [OPEN_ROW] }] }],
  setting: [{ id: "add", asks: true, target: ['[data-writing-add="setting"]'], after: [{ id: "added", target: [] }] }],
  interface: [
    // The block's one button opens the player-screen page (on a card with
    // no pages yet, straight into the template gallery, which tells its own
    // part); the lesson follows the learner through it.
    { id: "pages", asks: true, target: ['[data-testid="edit-interface"]'], after: [
      { id: "strip", target: ['[data-testid="page-strip"]'] },
      { id: "stage", target: ['[data-testid="ui-stage-frame"]'] },
      { id: "exit", target: ['[data-testid="ui-exit"]'] },
    ] },
  ],
  // The sample variable is open beside its row: its fields, one at a time.
  state: [
    { id: "range", target: ['[data-learn="var-basics"]'] },
    { id: "precise", target: ['[data-learn="var-precise"]'] },
    { id: "rules", target: ['[data-learn="var-rules"]'] },
    { id: "add", asks: true, target: ['[data-block-add="state"]'], after: [{ id: "added", target: [NEW_VARIABLE] }] },
  ],
  behavior: [{ id: "add", asks: true, target: ['[data-block-add="behavior"]'], after: [{ id: "added", target: [NEW_BEHAVIOR] }] }],
  atmosphere: [{ id: "image", target: ['[data-onboarding="scene-images"]'] }],
  card: [
    { id: "cover", asks: true, target: ['[data-learn="card-cover"]'], after: [
      { id: "variants", target: ['[data-learn="card-variants"]'] },
      { id: "cover", target: ['[data-learn="ov-cover"]'] },
      { id: "gallery", target: ['[data-learn="ov-gallery"]'] },
      { id: "language", target: ['[data-learn="ov-language"]'] },
    ] },
  ],
  knowledge: [
    { id: "delivery", asks: true, target: ['[data-learn="entry-delivery"]'], after: [{ id: "modes", target: ['[data-learn="entry-delivery"]'] }] },
  ],
  looks: [
    { id: "new", target: ['[data-testid="edit-interface"]'] },
    { id: "code", target: ['[data-onboarding="editors"]'] },
  ],
  modules: [
    { id: "add", asks: true, target: ['[data-onboarding="add-content"]'], after: [{ id: "module", target: ['[data-learn="add-module"]'] }] },
  ],
  ais: [
    // Added from 加东西, an AI lands in the 「AI」 block of the place in view.
    { id: "add", asks: true, target: ['[data-onboarding="add-content"]'], after: [{ id: "ai", target: ['[data-learn="add-ai"]'] }] },
  ],
  canvas: [
    { id: "fit", target: ['[data-learn="fit"]'] },
    { id: "search", target: ['[data-learn="search"]'] },
    { id: "surface", target: ['[data-visual-surface-switch]'] },
  ],
  ship: [
    { id: "save", target: ['[data-onboarding="save"]'] },
    { id: "playtest", target: ['[data-onboarding="playtest-switch"]'] },
    { id: "publish", target: ['[data-learn="publish"] > *'] },
  ],
};
/** A lesson that needs something of another lesson's kind to point at
 *  borrows that lesson's sample. Writing that exists is never touched. */
const SAMPLE: Partial<Record<LearningStepId, LearningStepId>> = { knowledge: "setting" };
/** What a clicked beat shows when it names nothing to follow. */
const DONE: ReadonlyArray<{ id: string; target: string[] }> = [{ id: "done", target: [] }];
const PHONE_TARGETS: Partial<Record<LearningStepId, string[]>> = {
  opening: ['[data-tour="fm-content"] textarea', '[data-tour="fm-empty-cta"]'],
  setting: ['[data-tour="entries-detail"] textarea', '[data-tour="entries-add"]'],
  knowledge: ['[data-tour="entries-detail"] textarea', '[data-tour="entries-add"]'],
  state: ['[data-tour="vars-list"]', '[data-tour="vars-form"]', '[data-tour="vars-add"]'],
  behavior: ['[data-tour="behaviors-list"]', '[data-tour="behaviors-add"]'],
  atmosphere: ['[data-tour="audio-list"]', '[data-tour="audio-add"]'],
  assistant: ['[data-onboarding="assistant"]', '[data-ai-composer]'],
  ship: ['[data-onboarding="playtest"]', '[data-onboarding="save"]'],
};

/** A beat's control can sit inside a row that opened in place and scrolls
 *  within itself (a variable's 每次最多加/减 is below that row's fold). The
 *  light framed the empty top of the row; scroll the row, not the board, so
 *  the control is in it. */
function bringIntoRow(element: HTMLElement) {
  const row = element.closest<HTMLElement>("[data-row-editor], [data-canvas-writing-editor]");
  if (!row || row === element || row.scrollHeight <= row.clientHeight) return;
  const r = row.getBoundingClientRect(), e = element.getBoundingClientRect();
  if (e.top >= r.top && e.bottom <= r.bottom) return;
  row.scrollTop += e.top - r.top - 12;
}

function BlueprintTour({ account }: { account: string }) {
  const { t } = useTranslation("learning");
  // The blueprint is content panels on a phone: no canvas, no staged reveal.
  // Every lesson carries a phone body that points at the panel instead.
  const phone = window.innerWidth < 768;
  const { setStep: setWorkspaceStep, setStage, setTeaching } = useLearningWorkspace();
  const draft = useEditorStore(s => s.worldDraft);
  const readOnly = useEditorStore(s => s.readOnlyInspect || s.guestMode);
  const [progress, setProgress] = useState(() => readLearningProgress(account));
  // Returning authors are not forced through the replacement tour. The old
  // progress remains a dismissal signal, never a claim of new completion.
  // The welcome is offered once per account. A card started from a starter
  // or a template opens quietly, and that counts as the offer: holding it for
  // "the next visit" meant it covered the same card on the next remount — a
  // switch from 简单 back to 画布, the shell reloading the card. Shown, or
  // held back, it is marked seen at once (below); 帮助 still opens it.
  // The note is only READ here: a render can be thrown away before it
  // commits, and one that took the note with it left the mount that did
  // commit to greet over the starter.
  const [greet] = useState(() => account !== "guest" && !readOnly && !progress.seenRelease);
  // A first visit goes straight into the first lesson: no list of what is
  // still ahead. The catalog is for after the required three.
  // The screen-first prototype opens on the player's screen; this tour teaches the board.
  const [autoStart] = useState(() => greet && !quietTourRequested() && !isScreenFirst());
  const [screen, setScreen] = useState<Screen>(null);
  /** The lesson just finished, when the catalog is where it landed. */
  const [finished, setFinished] = useState<LearningStepId | null>(null);
  const [stepId, setStepId] = useState<LearningStepId>("opening");
  /** 0 is the lesson itself; 1… are its BEATS. */
  const [beat, setBeat] = useState(0);
  /** 0 until the learner clicks what an `asks` beat lights; then 1… walk
   *  the beat's `after` steps, where the click took them. Left on the beat,
   *  the thing just opened sat in the dark under a card still asking for
   *  the click. */
  const [after, setAfter] = useState(0);
  useEffect(() => { setAfter(0); }, [stepId, beat, screen]);
  const step = lessonById(stepId)!;
  const required = step.part === "required";
  const requiredIndex = REQUIRED.indexOf(step);
  useLayoutEffect(() => {
    const active = screen === "step" && !readOnly;
    setWorkspaceStep(active ? stepId : null);
    // The end of a lesson keeps its board as it was: nothing unhides and
    // the camera does not move until the next lesson says where to go.
    const staged = (active || (screen === "end" && !readOnly)) && !phone;
    setStage(staged ? lessonStage(step) : null, lessonFocus(step));
    return () => { setWorkspaceStep(null); setStage(null); };
  }, [screen, stepId, step, readOnly, phone, setWorkspaceStep, setStage]);
  useLayoutEffect(() => {
    setTeaching(screen !== null);
    return () => setTeaching(false);
  }, [screen, setTeaching]);
  const [compact, setCompact] = useState(false);
  const tracker = useRef<ReturnType<typeof createLearningTracker> | null>(null);
  if (!tracker.current) tracker.current = createLearningTracker();
  const screenRef = useRef(screen); screenRef.current = screen;
  const stepRef = useRef(stepId); stepRef.current = stepId;
  const documentId = useRef(draft.id);
  const persist = useCallback((next: LearningProgress) => { writeLearningProgress(account, next); setProgress(next); }, [account]);
  useEffect(() => {
    if (!greet) return;
    consumeQuietTour();
    const saved = readLearningProgress(account);
    if (!saved.seenRelease) persist({ ...saved, seenRelease: LEARNING_RELEASE });
  }, [greet, account, persist]);

  const pause = useCallback(() => {
    if (screenRef.current) tracker.current!.track({ release: LEARNING_RELEASE, step: screenRef.current === "step" ? stepRef.current : screenRef.current, action: screenRef.current === "step" ? "pause" : "dismiss" });
    screenRef.current = null;
    setScreen(null);
    window.dispatchEvent(new Event(LEARNING_CANCEL_EVENT));
  }, []);

  // 新手引导 before the required three are done carries on with them;
  // after, it opens the catalog. Read-only help is the catalog to read.
  const resumeRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    const open = () => {
      pause(); tracker.current!.reset(); setFinished(null);
      if (resumeRef.current) resumeRef.current(); else setScreen("list");
    };
    window.addEventListener(LEARNING_OPEN_EVENT, open);
    return () => { window.removeEventListener(LEARNING_OPEN_EVENT, open); window.dispatchEvent(new Event(LEARNING_CANCEL_EVENT)); };
  }, [pause]);
  useEffect(() => {
    if (documentId.current !== draft.id) { documentId.current = draft.id; pause(); }
    if (readOnly) pause();
  }, [draft.id, readOnly, pause]);
  useEffect(() => {
    if (screen !== "step") return;
    const focus = (event: FocusEvent) => {
      if (window.innerWidth < 768 && event.target instanceof HTMLElement && event.target.matches('input,textarea,[contenteditable="true"]') && !event.target.closest('[data-learning="coach"]')) setCompact(true);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && !Array.from(document.querySelectorAll('[role="dialog"][data-state="open"]')).some(visibleTourElement)) pause();
    };
    window.addEventListener("focusin", focus); window.addEventListener("keydown", key);
    return () => { window.removeEventListener("focusin", focus); window.removeEventListener("keydown", key); };
  }, [screen, pause]);

  const prepareLesson = useCallback((lesson: LearningLesson) => {
    if (readOnly) return;
    const sample = SAMPLE[lesson.id] ?? lesson.id;
    const store = useEditorStore.getState();
    const draft = store.worldDraft;
    const show = (objectId: string, mode: "row" | "inspect") => {
      if (!phone) window.setTimeout(() => window.dispatchEvent(new CustomEvent(LEARNING_SHOW_EVENT, { detail: { objectId, mode } })), 200);
    };
    /** The sample variable: the one the variables lesson shows and the one
     *  the behaviour lesson's rule reads, made by whichever comes first. A
     *  whole variable, not a name and a zero: it has a range, a line saying
     *  when it changes, and the judge tracking it ten a turn — so the row
     *  wears its chips and the column has something on every line. */
    const sampleVariable = () => {
      // A NUMBER, because the behaviour lesson compares it (≥ 80) and sets it
      // (= 100). Taking whatever variable came first turned a card's text
      // "location" into "location ≥ 80 → set location = 100". A card with no
      // number gets the sample one — under a free name, since
      // ensureVariableByName would otherwise hand back a same-named variable
      // of another type.
      const existing = draft.variables.find(item => item.type === "number");
      if (existing) return existing;
      const taken = new Set(draft.variables.map(item => item.name.trim()));
      const base = t("sample.variableName");
      let name = base;
      for (let n = 2; taken.has(name); n++) name = `${base} ${n}`;
      const id = store.ensureVariableByName(name, "number", 0);
      const index = useEditorStore.getState().worldDraft.variables.findIndex(item => item.id === id);
      // Starts at 30 (just met), and the rules say what each band means —
      // the lesson walks these fields one at a time.
      if (index >= 0) store.updateVariableAt(index, { defaultValue: 30, min: 0, max: 100, behaviorRules: t("sample.variableRules"), precise: true, deltaDown: 10, deltaUp: 10 });
      return useEditorStore.getState().worldDraft.variables.find(item => item.id === id);
    };
    if (sample === "opening") {
      let opening = draft.entries.find(entry => entry.role === "greeting");
      if (!opening) {
        const before = new Set(draft.entries.map(item => item.id));
        store.addEntry("greeting", "system-presets");
        opening = useEditorStore.getState().worldDraft.entries.find(item => !before.has(item.id));
      }
      if (opening && isStarterOpening(opening.content)) store.updateEntry(opening.id, { content: t("hello") });
    } else if (sample === "setting") {
      let entry = draft.entries.find(item => item.role !== "greeting" && !item.presetId);
      if (!entry) {
        const before = new Set(draft.entries.map(item => item.id));
        store.addEntry("custom", "system-presets");
        entry = useEditorStore.getState().worldDraft.entries.find(item => !before.has(item.id));
        if (entry) store.updateEntry(entry.id, { name: t("sample.entryName"), content: t("sample.entryContent"), alwaysSend: true });
      }
      if (entry) show(`entry:${entry.id}`, "row");
    } else if (sample === "state") {
      const variable = sampleVariable();
      if (variable) show(`var:${variable.id}`, "inspect");
    } else if (sample === "behavior") {
      const variable = sampleVariable();
      // A behaviour is a reaction — the shape the board's own "+" makes and
      // the column can edit. The sample is one a card would really have:
      // affection reaches 80 and a setting the AI could not see until now
      // switches on, so Yumina starts to care. (Setting the number to 100
      // at 80 taught nothing a creator would want.)
      let reaction = (draft.reactions ?? []).at(0);
      if (!reaction && variable) {
        const beforeEntries = new Set(useEditorStore.getState().worldDraft.entries.map(item => item.id));
        store.addEntry("custom", "system-presets");
        const heart = useEditorStore.getState().worldDraft.entries.find(item => !beforeEntries.has(item.id));
        if (heart) store.updateEntry(heart.id, { name: t("sample.heartName"), content: t("sample.heartContent"), alwaysSend: true, enabled: false });
        const before = new Set((draft.reactions ?? []).map(item => item.id));
        store.addReaction();
        reaction = (useEditorStore.getState().worldDraft.reactions ?? []).find(item => !before.has(item.id));
        if (reaction) store.updateReaction(reaction.id, { name: t("sample.behaviorName"), conditions: [{ variableId: variable.id, operator: "gte", value: 80 }],
          // What the behaviour editor's 「打开一条设定」 writes.
          then: heart ? [{ type: "set", path: `@prompt.entry.${heart.id}`, value: true, operation: "set" }] : [] });
      }
      if (reaction) show(`reaction:${reaction.id}`, "inspect");
    } else if (sample === "atmosphere") {
      // A scene image that shows itself the first time it is tried: Yumina,
      // pleased, when the player says something nice to her.
      if (!(draft.sceneImages ?? []).length) {
        store.addSceneImage();
        const image = (useEditorStore.getState().worldDraft.sceneImages ?? []).at(-1);
        if (image) store.updateSceneImage(image.id, { name: t("sample.imageName"), url: `${window.location.origin}/create/learn/yumina-happy.webp`, scene: t("sample.imageScene") });
      }
    }
  }, [readOnly, phone, t]);

  /** Route the workspace to where the lesson happens. On the canvas a lesson
   *  is the board itself — staged or whole — and the assistant or playtest
   *  when that is what it teaches; the phone opens the matching panel. The
   *  canvas resolves its own target; nothing here selects or creates. */
  const locate = useCallback((lesson: LearningLesson) => {
    const onCanvas = lesson.panel === "ai-chat" || lesson.panel === "playtest" ? lesson.panel : "blueprint";
    window.dispatchEvent(new CustomEvent(LEARNING_PANEL_EVENT, { detail: { panelId: phone ? lesson.panel : onCanvas,
      ...(phone && "canvasTarget" in lesson ? { canvasTarget: lesson.canvasTarget } : {}) } }));
  }, [phone]);

  const beatsOf = (id: LearningStepId) => phone ? [] : BEATS[id] ?? [];
  const beatDef = beat > 0 ? beatsOf(stepId)[beat - 1] : undefined;
  const afterSteps = beatDef?.after ?? DONE;
  const afterDef = after > 0 ? afterSteps[after - 1] : undefined;
  useEffect(() => {
    if (screen !== "step" || !beatDef?.asks || after > 0) return;
    const targets = beatDef.target;
    // Capture: the lit controls stop their own clicks from bubbling.
    const click = (event: MouseEvent) => {
      const hit = event.target;
      if (hit instanceof Element && targets.some(selector => hit.closest(selector))) { setAfter(1); setCompact(false); }
    };
    document.addEventListener("click", click, true);
    return () => document.removeEventListener("click", click, true);
  }, [screen, beatDef, after]);
  const enter = (id: LearningStepId, atBeat = 0) => {
    const lesson = lessonById(id)!;
    setStepId(id); setBeat(atBeat); setCompact(false); setFinished(null); setScreen("step");
    persist({ ...progress, seenRelease: LEARNING_RELEASE, current: id });
    prepareLesson(lesson);
    locate(lesson);
  };
  const begin = (id: LearningStepId) => {
    const current = progress.current === id;
    tracker.current!.track({ release: LEARNING_RELEASE, step: "catalog", action: current ? "resume" : lessonTaken(progress, lessonById(id)!) ? "restart" : "start" });
    enter(id);
  };
  resumeRef.current = !readOnly && !requiredDone(progress) ? () => {
    const saved = lessonById(progress.current ?? "");
    begin(saved?.part === "required" && lessonUnlocked(progress, saved) ? saved.id : nextLesson(progress)!.id);
  } : null;
  const beginRef = useRef(begin); beginRef.current = begin;
  useEffect(() => {
    if (!autoStart) return;
    // After the studio has mounted the board the lesson stages.
    const timer = window.setTimeout(() => beginRef.current(REQUIRED[0].id), 500);
    return () => window.clearTimeout(timer);
  }, [autoStart]);
  // The first lesson says it wrote 「你好！Yumina」 — only true when it did. A
  // card that came with its own opening (imported, written already) hears
  // the same lesson without the claim.
  const ownOpening = stepId === "opening" && !!draft.entries.find(entry => entry.role === "greeting")?.content?.trim()
    && draft.entries.find(entry => entry.role === "greeting")?.content !== t("hello");
  const lessonBody = `${ownOpening ? "bodyOwn" : "body"}${phone ? "Mobile" : ""}`;
  const next = () => {
    if (afterDef && after < afterSteps.length) { setAfter(after + 1); setCompact(false); return; }
    if (beat < beatsOf(stepId).length) { if (afterDef) locate(step); setBeat(beat + 1); setCompact(false); return; }
    tracker.current!.track({ release: LEARNING_RELEASE, step: stepId, action: "complete" });
    window.dispatchEvent(new Event(LEARNING_CANCEL_EVENT));
    const done = { ...progress, completed: { ...progress.completed, [stepId]: step.revision } };
    // The required three run straight on into each other; after the third,
    // and after any other lesson, the catalog opens on what is next.
    const following = required ? REQUIRED[requiredIndex + 1] : undefined;
    persist({ ...done, seenRelease: LEARNING_RELEASE, current: following?.id ?? nextLesson(done)?.id });
    if (following) { setStepId(following.id); setBeat(0); setCompact(false); setScreen("step"); prepareLesson(following); locate(following); }
    else {
      // Back to the board: the 玩家界面 lesson ends inside the screen editor
      // (its last step promises 「我带你回去」) and 保存、试玩、发布 inside a
      // playtest — both were left open behind the end card.
      if (!phone) window.dispatchEvent(new CustomEvent(LEARNING_PANEL_EVENT, { detail: { panelId: "blueprint" } }));
      setFinished(stepId); setScreen("end");
    }
  };
  const back = () => {
    if (after > 1) { setAfter(after - 1); return; }
    if (after === 1) { setAfter(0); locate(step); return; }
    if (beat > 0) { setBeat(beat - 1); setCompact(false); return; }
    if (required && requiredIndex > 0) enter(REQUIRED[requiredIndex - 1].id, beatsOf(REQUIRED[requiredIndex - 1].id).length);
  };

  const getTarget = useCallback((): HTMLElement | HTMLElement[] | null => {
    const visible = (selector: string) => Array.from(document.querySelectorAll(selector)).find(visibleTourElement) as HTMLElement | undefined;
    const pointed = afterDef ?? beatDef;
    if (pointed) {
      for (const selector of pointed.target) {
        const found = visible(selector);
        if (found) { bringIntoRow(found); return found; }
      }
      return null;
    }
    const selectors = phone ? PHONE_TARGETS[stepId] ?? DESKTOP_TARGETS[stepId] : DESKTOP_TARGETS[stepId];
    if (!phone && PAIRED.has(stepId)) {
      const all = selectors.map(visible).filter((found): found is HTMLElement => Boolean(found));
      return all.length ? all : null;
    }
    for (const selector of selectors) { const found = visible(selector); if (found) return found; }
    return null;
  }, [phone, stepId, beatDef, afterDef]);
  /** The camera moves to the lesson's block: a staged lesson frames the
   *  kinds it is about, a whole-board lesson the one node its control sits
   *  on. A control off the board (a toolbar button, the column) moves
   *  nothing. `always` is the lesson itself and 再指给我看; a beat moves the
   *  camera only when its control is not already in view, so the board
   *  holds still while the light walks the block. */
  const revealTarget = useCallback((always = true) => {
    const kinds = lessonFocus(step);
    if (kinds && always) { window.dispatchEvent(new CustomEvent(LEARNING_REVEAL_EVENT, { detail: { kinds } })); return; }
    // A beat inside a staged lesson still has to be seen: the opening the
    // learner just added opens in a block that grew, and its editor hung off
    // the left edge. Below, the camera moves only when it is out of view.
    const found = getTarget();
    const element = Array.isArray(found) ? found[0] : found;
    const node = element?.closest(".react-flow__node");
    const nodeId = node?.getAttribute("data-id");
    if (!nodeId || !element) return;
    if (!always) {
      const board = element.closest('[data-onboarding="blueprint"]')?.getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      if (board && rect.left >= board.left && rect.right <= board.right && rect.top >= board.top && rect.bottom <= board.bottom) return;
    }
    window.dispatchEvent(new CustomEvent(LEARNING_REVEAL_EVENT, { detail: { nodeId } }));
  }, [getTarget, step]);
  useEffect(() => {
    // A staged lesson's camera is the stage's own: the board frames the
    // lesson's kinds as it draws them (see the blueprint's stage effect).
    if (screen !== "step" || phone || (lessonStage(step) && beat === 0 && after === 0)) return;
    // After the workspace has routed and the board has settled its own fit.
    const timer = window.setTimeout(() => revealTarget(beat === 0 && after === 0), beat > 0 && after === 0 ? 200 : 450);
    return () => window.clearTimeout(timer);
  }, [screen, stepId, step, phone, revealTarget, beat, after]);

  useEffect(() => {
    if (screen && !readOnly) tracker.current!.view({ release: LEARNING_RELEASE, step: screen === "step" ? stepId : screen,
      ...(screen === "end" && !nextLesson(progress) && { outcome: "walkthrough" as const }) });
  }, [screen, stepId, readOnly, finished, progress]);
  const closeGuide = () => { persist({ ...progress, seenRelease: LEARNING_RELEASE }); pause(); };
  const beatId = beatDef?.id;
  const beatKey = beatId ? `${stepId}:${beatId}${afterDef ? `:${afterDef.id}` : ""}` : stepId;
  // Not on the click into a beat's follow-ups: that click is what opened
  // the menu the follow-up points into.
  useEffect(() => {
    if (screen === "step") window.dispatchEvent(new Event(LEARNING_STEP_EVENT));
  }, [stepId, beat, screen]);
  // A learner who wandered off the canvas on their own (into the screen
  // editor through 编辑界面 before the lesson asked) comes back to it when
  // the next beat points at something that is only there.
  useEffect(() => {
    if (screen !== "step" || phone || beat === 0) return;
    const timer = window.setTimeout(() => {
      const onCanvas = Array.from(document.querySelectorAll('[data-onboarding="blueprint"]')).some(visibleTourElement);
      if (!onCanvas && !getTarget()) locate(step);
    }, 500);
    return () => window.clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepId, beat, screen]);
  useEffect(() => {
    if (screen !== "step" || phone) return;
    // A field the beat names may sit below the fold of the column (the
    // card's gallery and language, a behaviour's effects): bring it up.
    // The canvas has its own camera for what sits on a block.
    const timer = window.setTimeout(() => {
      const found = getTarget();
      const element = Array.isArray(found) ? found[0] : found;
      if (!element || element.closest(".react-flow__node")) return;
      const rect = element.getBoundingClientRect();
      if (rect.top < 60 || rect.bottom > window.innerHeight - 20) element.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 320);
    return () => window.clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beatKey, screen]);
  const beatText = (part: "title" | "body") => afterDef
    ? afterDef.id === "done" ? t((part === "title" ? `lessons.${stepId}.beats.${beatId}.title` : "beatDone") as never)
      : t(`lessons.${stepId}.beats.${beatId}.after.${afterDef.id}.${part}` as never)
    : t(`lessons.${stepId}.beats.${beatId}.${part}` as never);
  const title = (lesson: LearningLesson) => t(`lessons.${lesson.id}.title` as never);
  const lastScreen = beat >= beatsOf(stepId).length && (!afterDef || after >= afterSteps.length);
  /** The last screen of a lesson that ends in the catalog, not the next
   *  required one. */
  const finishing = lastScreen && !(required && requiredIndex + 1 < REQUIRED.length);
  const eyebrow = required ? t("eyebrowRequired", { number: requiredIndex + 1, total: REQUIRED.length }) : t("eyebrowMore", { title: title(step) });
  const upcoming = nextLesson({ ...progress, completed: { ...progress.completed, [stepId]: step.revision } });
  const taken = LEARNING_LESSONS.filter(lesson => lessonTaken(progress, lesson)).length;

  /** Under the buttons: where this lesson sits. The three required ones
   *  as a three-part bar with the rest shown locked; a later lesson names
   *  the one after it. */
  const strip = required ? <div className="space-y-1.5" data-learning="strip">
    <div className="grid grid-cols-3 gap-1.5">
      {REQUIRED.map((lesson, i) => {
        const state = i < requiredIndex || (i !== requiredIndex && lessonTaken(progress, lesson)) ? "done" : i === requiredIndex ? "now" : "todo";
        return <div key={lesson.id} className={`min-w-0 text-[11px] leading-tight ${state === "done" ? "text-emerald-400" : state === "now" ? "font-semibold text-[#f0c674]" : "text-muted-foreground"}`}>
          <div className={`mb-1 h-1 rounded-full ${state === "done" ? "bg-emerald-400/80" : state === "now" ? "bg-[#f0c674] shadow-[0_0_8px_rgba(240,198,116,0.6)]" : "bg-white/12"}`} />
          <span className="block truncate">{state === "done" && <Check className="mr-0.5 inline h-3 w-3" />}{i + 1}. {title(lesson)}</span>
        </div>;
      })}
    </div>
    {!requiredDone(progress) && <p className="text-[11px] text-muted-foreground">{t("stripLocked")}</p>}
  </div> : <div className="flex items-center gap-2 text-xs text-muted-foreground" data-learning="strip">
    <span className="min-w-0 truncate">{upcoming ? <>{t("nextUp")}<span className="font-semibold text-[#f0c674]">{title(upcoming)}</span></> : t("progressCount", { done: taken, total: LEARNING_LESSONS.length })}</span>
    <span className="flex-1" />
    <button type="button" data-learning="all" onClick={() => { window.dispatchEvent(new Event(LEARNING_CANCEL_EVENT)); setScreen("list"); }} className="shrink-0 underline-offset-2 hover:text-foreground hover:underline">{t("allLessons")}</button>
  </div>;

  // ── The end of a lesson, and the list of them all ──
  const suggested = nextLesson(progress);
  const endedRequired = finished !== null && lessonById(finished)?.part === "required";
  const endCopy = !suggested ? { title: t("end.all.title"), body: t("end.all.body") }
    : endedRequired ? { title: t("end.required.title"), body: t("end.required.body") }
    : { title: t("end.lesson.title", { title: finished ? title(lessonById(finished)!) : "" }), body: "" };
  const linkClass = "px-1 py-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline";
  const endView = <>
    {endCopy.body && <p className="text-[15px] leading-relaxed text-foreground/90">{endCopy.body}</p>}
    <div className="mt-3 flex flex-col gap-1.5">
      {suggested && <button type="button" data-learning="start" onClick={() => begin(suggested.id)} className="studio-button-lit inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold">
        {t("nextLesson", { title: title(suggested) })}<ArrowRight className="h-4 w-4" />
      </button>}
      <div className="flex items-center justify-center gap-3">
        <button type="button" data-learning="all" onClick={() => setScreen("list")} className={linkClass}>{t("allLessons")}</button>
        <button type="button" onClick={closeGuide} className={linkClass}>{t("notNow")}</button>
      </div>
    </div>
  </>;
  /** One row per lesson: a tick when taken, its name, and 下一课 on the one
   *  suggested. Nothing locked is ever listed: before the required three are
   *  done, 新手引导 carries on with them instead of opening this. */
  const row = (lesson: LearningLesson) => {
    const done = lessonTaken(progress, lesson);
    const isNext = lesson.id === suggested?.id;
    const open = !readOnly && lessonUnlocked(progress, lesson);
    return <li key={lesson.id}>
      <button type="button" data-learning-lesson={lesson.id} data-learning-state={isNext ? "next" : done ? "done" : "todo"} disabled={!open} onClick={() => begin(lesson.id)}
        className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13.5px] transition-colors ${open ? "hover:bg-white/[0.06]" : "cursor-default"} ${isNext ? "bg-[rgba(240,198,116,0.08)]" : ""}`}>
        <span className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${done ? "border-emerald-400/60 bg-emerald-400/15 text-emerald-400" : isNext ? "border-[#f0c674]" : "border-white/20"}`}>{done && <Check className="h-2.5 w-2.5" />}</span>
        <span className={`min-w-0 flex-1 truncate ${done && !isNext ? "text-muted-foreground" : "text-foreground"}`}>{title(lesson)}</span>
        {isNext && <span className="shrink-0 text-[11px] font-semibold text-[#f0c674]">{t("tagNext")}</span>}
      </button>
    </li>;
  };
  const listView = <ul className="-mx-1 space-y-0.5" data-learning="list">
    {REQUIRED.map(row)}
    <li aria-hidden className="mx-2 my-1.5 border-t border-white/[0.07]" />
    {MORE.map(row)}
  </ul>;

  return <>
    {screen === "step" && !readOnly && <TourSpotlight id={beatKey} motionKey={stepId} title={beatId ? beatText("title") : title(step)} eyebrow={eyebrow} big
      dim={beatId ? !(afterDef && afterDef.target.length === 0) : true} getTarget={getTarget} compact={compact} onCompact={setCompact} onClose={pause} footer={strip}>
      <p className="text-[15px] leading-relaxed text-foreground/90">{beatId ? beatText("body") : t(`lessons.${stepId}.${lessonBody}` as never)}</p>
      <div className="mt-3 flex items-center gap-2">
        {((required && requiredIndex > 0) || beat > 0 || after > 0) && <button type="button" onClick={back} aria-label={t("back")} className="studio-control inline-flex h-10 w-9 shrink-0 items-center justify-center rounded-lg border text-foreground/70 hover:text-foreground"><ArrowLeft className="h-4 w-4" /></button>}
        <button type="button" onClick={() => {
          // Inside a beat the light is on something the learner just made or
          // opened (a new opening's editor): re-aiming the lesson re-selected
          // its first object and shut that editor. Only the lesson's own
          // opening screen goes back to its object; a beat just looks again.
          if (beat === 0 && after === 0) locate(step);
          setCompact(false); window.setTimeout(() => revealTarget(true), 300);
        }} title={t("locate")} aria-label={t("locate")} className="studio-control inline-flex h-10 w-9 shrink-0 items-center justify-center rounded-lg border text-foreground/70 hover:text-foreground"><LocateFixed className="h-4 w-4" /></button>
        <button type="button" data-learning="next" onClick={next}
          className="studio-button-lit inline-flex min-h-10 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold">
          {t(finishing ? "finishTour" : "next")}{!finishing && <ArrowRight className="h-4 w-4" />}
        </button>
      </div>
    </TourSpotlight>}
    {screen === "end" && !readOnly && <TourSpotlight id="end" motionKey="end" title={endCopy.title} eyebrow={t("title")} big dim={false} getTarget={noTarget} compact={false} onCompact={() => {}} onClose={closeGuide}>
      {endView}
    </TourSpotlight>}
    {screen === "list" && <TourSpotlight id="list" motionKey="list" title={t("allLessons")} eyebrow={t("progressCount", { done: taken, total: LEARNING_LESSONS.length })} dim={false} getTarget={noTarget} compact={false} onCompact={() => {}} onClose={closeGuide}>
      {listView}
    </TourSpotlight>}
  </>;
}
