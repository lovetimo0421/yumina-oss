import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

test("one tutorial: three required lessons stage the canvas a block at a time, then the rest unlock; writing and progress are preserved", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const values: Record<string, unknown> = { window: dom.window, location: dom.window.location, document: dom.window.document, navigator: dom.window.navigator,
    localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage, IS_REACT_ACT_ENVIRONMENT: true,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout };
  for (const name of ["HTMLElement", "HTMLInputElement", "Element", "Node", "NodeFilter", "Event", "CustomEvent", "MutationObserver"]) values[name] = Reflect.get(dom.window, name);
  const original = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const appRoot = fileURLToPath(new URL("../../../..", import.meta.url));
  const captured: Record<string, unknown>[] = [];
  Reflect.set(dom.window, "__learningEvents", captured);
  const vite = await createServer({ root: appRoot, configFile: false, envFile: false, appType: "custom", logLevel: "silent",
    ssr: { noExternal: ["posthog-js"] },
    plugins: [{ name: "learning-analytics-test", enforce: "pre", resolveId(id) { if (id === "posthog-js") return "\0learning-posthog"; },
      load(id) { if (id === "\0learning-posthog") return 'export default { capture(name, props) { if (name === "creator_learning") window.__learningEvents.push(props); } };'; } }],
    server: { middlewareMode: true, watch: null }, esbuild: { jsx: "automatic" },
    resolve: { alias: { "@": `${appRoot}/src`, "@yumina/engine": `${appRoot}/../engine/src/index.ts` } } });
  const root = createRoot(document.getElementById("root")!);
  try {
    const { default: i18n } = await vite.ssrLoadModule("/src/lib/i18n.ts");
    await i18n.changeLanguage("en"); await i18n.loadNamespaces(["learning", "common"]);
    const { useEditorStore: store } = await vite.ssrLoadModule("/src/stores/editor.ts") as typeof import("@/stores/editor");
    const { useUserProfileStore: profile } = await vite.ssrLoadModule("/src/stores/user-profile.ts") as typeof import("@/stores/user-profile");
    const { StudioLearningCenter } = await vite.ssrLoadModule("/src/features/studio/learn/studio-learning.tsx");
    const { readLearningProgress, writeLearningProgress } = await vite.ssrLoadModule("/src/features/studio/learn/learning-catalog.ts");
    profile.setState({ profile: { id: "learner" } as never });
    store.setState({ serverWorldId: "existing", guestMode: false, readOnlyInspect: false, isDirty: true, layoutDirty: false });
    store.setState({ worldDraft: { ...store.getState().worldDraft, name: "Existing story", entries: [] } });
    const before = JSON.stringify(store.getState().worldDraft);
    const { LearningWorkspaceProvider, useLearningWorkspace } = await vite.ssrLoadModule("/src/features/studio/learn/learning-workspace.tsx");
    const seen = { stage: null as readonly string[] | null, focus: null as readonly string[] | null };
    const routed: { panelId: string; canvasTarget?: string }[] = [];
    window.addEventListener("yumina:studio-learn-panel", event => routed.push((event as CustomEvent).detail));
    function RightWorkspace() {
      const { stage, focus } = useLearningWorkspace();
      seen.stage = stage; seen.focus = focus;
      return createElement("aside", { "data-studio-companion": "ai" });
    }
    await act(async () => root.render(createElement(LearningWorkspaceProvider, null, createElement(RightWorkspace), createElement(StudioLearningCenter))));
    const click = async (text: string) => {
      const button = [...document.querySelectorAll("button")].find(b => b.textContent?.includes(text) || b.getAttribute("aria-label") === text);
      assert.ok(button, `button: ${text}`); await act(async () => button.click());
    };
    const step = () => document.querySelector("[data-onboarding-step]")?.getAttribute("data-onboarding-step");
    const open = async () => act(async () => window.dispatchEvent(new Event("yumina:studio-learn-open")));

    const next = async () => { const button = document.querySelector('[data-learning="next"]') as HTMLButtonElement | null; assert.ok(button, "next"); await act(async () => button.click()); };
    const lessonCard = (id: string) => document.querySelector(`[data-learning-lesson="${id}"]`) as HTMLButtonElement | null;
    const state = (id: string) => lessonCard(id)?.getAttribute("data-learning-state");
    const catalogOpen = () => Boolean(document.querySelector('[data-learning="list"], [data-learning="start"]'));
    const listOpen = () => Boolean(document.querySelector('[data-learning="list"]'));
    const start = async () => act(async () => (document.querySelector('[data-learning="start"]') as HTMLButtonElement).click());

    // ── A first visit goes straight into lesson 1, with no list of what is locked ──
    assert.equal(catalogOpen(), false, "no catalog before the first three");
    assert.equal(JSON.stringify(store.getState().worldDraft), before, "nothing happens to the card before the lesson starts");
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 600)); });
    assert.equal(step(), "opening", "the first lesson starts by itself");
    assert.deepEqual(seen.stage, ["opening"], "the first lesson leaves only the opening on the canvas");
    assert.deepEqual(seen.focus, ["opening"], "and the camera frames it");
    const shown: { objectId: string; mode: string }[] = [];
    window.addEventListener("yumina:studio-learn-show", event => shown.push((event as CustomEvent).detail));
    assert.deepEqual(routed.at(-1), { panelId: "blueprint" }, "a staged lesson stays on the board and selects nothing");
    assert.equal(document.querySelector('[data-studio-companion] [data-learning="coach"]'), null, "the guide is not a column");
    assert.ok(document.querySelector('body > [data-learning="coach"]'));
    assert.ok(document.body.textContent?.includes("Tutorial · Lesson 1 of 3"));
    assert.ok(document.querySelector('[data-learning="strip"]')?.textContent?.includes("the other lessons open up"), "the card says the rest opens after these three");

    // ── The hello world: a blank opening gets its line; writing is never overwritten ──
    const greeting = store.getState().worldDraft.entries.find(e => e.role === "greeting")!;
    assert.equal(greeting.content, "Hello, Yumina!", "a blank opening gets the hello world");
    await act(async () => store.getState().updateEntry(greeting.id, { content: "Mine." }));
    await next();
    assert.equal(step(), "opening:add", "the opening lesson then points at its + (the rest dimmed)");
    assert.deepEqual(seen.stage, ["opening"], "a pointer beat keeps the lesson's canvas");
    await next();
    assert.equal(step(), "setting", "the required lessons run straight on");
    assert.deepEqual(seen.stage, ["opening", "lore"], "each lesson brings one block onto the canvas");
    assert.deepEqual(seen.focus, ["lore"]);
    await click("Previous step");
    assert.equal(step(), "opening:add", "stepping back lands on the previous lesson's last beat");
    await next();
    assert.equal(store.getState().worldDraft.entries.find(e => e.role === "greeting")?.content, "Mine.", "returning to the opening never overwrites writing");
    const sample = store.getState().worldDraft.entries.find(e => e.role !== "greeting" && !e.presetId)!;
    assert.ok(sample && sample.alwaysSend && sample.content.includes("mushroom"), "a card with no entry of its own gets the sample, sent every turn");
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)); });
    assert.deepEqual(shown.at(-1), { objectId: `entry:${sample.id}`, mode: "row" }, "the sample entry opens on its row");
    const writing = JSON.stringify(store.getState().worldDraft.entries);
    await next();
    assert.equal(step(), "setting:add");
    await next();
    assert.equal(step(), "interface");
    assert.deepEqual(seen.stage, ["opening", "lore", "frontend"]);
    assert.deepEqual(seen.focus, ["frontend"]);
    await next();
    assert.equal(step(), "interface:pages", "the interface lesson points at the block's one button, 编辑界面");
    // The learner does what the lit button asks. What it opened must not
    // stay in the dark under a card still asking for the click.
    const dimmed = () => (document.querySelector("[data-onboarding-highlight]")?.getAttribute("style") ?? "").includes("9999px");
    assert.ok(dimmed(), "a pointer beat dims the rest");
    const lit = document.createElement("button");
    lit.setAttribute("data-testid", "edit-interface");
    lit.addEventListener("click", event => event.stopPropagation());
    document.body.appendChild(lit);
    const routedBefore = routed.length;
    await act(async () => lit.click());
    assert.equal(step(), "interface:pages:strip", "clicking the lit button follows the learner to what it opened");
    assert.ok(document.body.textContent?.includes("All your card's pages"), "with words about that place");
    assert.equal(routed.length, routedBefore, "without dragging them back to the canvas");
    await click("Previous step");
    assert.equal(step(), "interface:pages", "back returns to the button");
    await act(async () => lit.click());
    // Through the player-screen page: its pages, the screen, the way out.
    for (const beat of ["interface:pages:stage", "interface:pages:exit"]) { await next(); assert.equal(step(), beat); }
    lit.remove();
    assert.equal(document.querySelector('[data-learning="next"]')?.textContent, "Done", "the last step of the third lesson finishes it");
    await next();

    // ── The first three end in the guide card itself, on what to take next ──
    assert.equal(step(), "end", "no dialog: the same card says what is next");
    assert.deepEqual(seen.stage, ["opening", "lore", "frontend"], "the end keeps the lesson's board: nothing unhides, the camera stays");
    assert.ok(document.body.textContent?.includes("First 3 done"));
    assert.ok(document.querySelector('[data-learning="start"]')?.textContent?.includes("Variables"), "one button: the next lesson");
    assert.equal(listOpen(), false, "no list of lessons unless asked for");
    await click("All lessons");
    assert.ok(listOpen());
    assert.equal(state("state"), "next", "the next lesson is marked");
    assert.equal(state("ship"), "todo", "and every other one is open");
    assert.equal(lessonCard("ship")?.disabled, false);
    assert.equal(state("opening"), "done");
    assert.equal(readLearningProgress("learner").current, "state");
    await act(async () => lessonCard("state")!.click());
    assert.equal(step(), "state");
    assert.deepEqual(seen.stage, ["opening", "lore", "frontend", "state"], "a later lesson brings its block onto the three");
    assert.deepEqual(seen.focus, ["state"]);
    assert.ok(document.body.textContent?.includes("Tutorial · Variables"));
    assert.ok(document.querySelector('[data-learning="strip"]')?.textContent?.includes("Behaviours"), "the card names the lesson after this one");
    const variable = store.getState().worldDraft.variables[0]!;
    assert.equal(variable.name, "Affection");
    assert.equal(variable.precise, true, "the sample is a whole variable: tracked by the judge");
    assert.deepEqual([variable.defaultValue, variable.min, variable.max, variable.deltaDown, variable.deltaUp], [30, 0, 100, 10, 10], "starts at 30 (just met), moves at most 10 a turn");
    assert.ok(variable.behaviorRules?.includes("Yumina"), "with a line saying when it changes");
    assert.equal(store.getState().worldDraft.reactions?.length ?? 0, 0, "the variables lesson makes no behaviour");
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)); });
    assert.deepEqual(shown.at(-1), { objectId: `var:${variable.id}`, mode: "inspect" }, "the sample variable opens in the column");
    for (const beat of ["state:range", "state:precise", "state:rules", "state:add"]) { await next(); assert.equal(step(), beat); }
    await click("Done");
    assert.ok(document.body.textContent?.includes("Variables: done"));
    assert.ok(document.querySelector('[data-learning="start"]')?.textContent?.includes("Behaviours"));
    await start();
    assert.equal(step(), "behavior");
    assert.deepEqual(seen.stage, ["opening", "lore", "frontend", "state", "behavior"]);
    const reaction = store.getState().worldDraft.reactions![0]!;
    assert.deepEqual(reaction.conditions, [{ variableId: variable.id, operator: "gte", value: 80 }]);
    const heart = store.getState().worldDraft.entries.find(e => e.name === "Yumina's feelings")!;
    assert.ok(heart && heart.enabled === false, "the sample behaviour's setting starts switched off");
    assert.deepEqual(reaction.then, [{ type: "set", path: `@prompt.entry.${heart.id}`, value: true, operation: "set" }], "affection at 80 switches it on");
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)); });
    assert.deepEqual(shown.at(-1), { objectId: `reaction:${reaction.id}`, mode: "inspect" }, "the sample behaviour opens in the column");
    for (const beat of ["behavior:add"]) { await next(); assert.equal(step(), beat); }
    await click("Previous step");
    assert.equal(store.getState().worldDraft.reactions!.length, 1, "revisiting adds nothing twice");
    assert.equal(JSON.stringify(store.getState().worldDraft.entries.filter(e => e.name !== "Yumina's feelings")), writing, "the tour never touches writing on its own");

    // ── Pause, resume, and any lesson from the catalog ──
    await click("Pause the guide");
    assert.equal(step(), undefined);
    assert.equal(readLearningProgress("learner").current, "behavior");
    await open();
    assert.ok(listOpen(), "after the first three, 新手引导 opens the list");
    assert.equal(state("behavior"), "next", "with the unfinished lesson marked next");
    await open();
    await act(async () => lessonCard("canvas")!.click());
    assert.equal(step(), "canvas", "after the first three, any lesson can be taken");
    assert.equal(seen.stage, null, "a lesson about the whole board keeps the whole board");
    const walked: string[] = [];
    for (let i = 0; i < 20 && document.querySelector('[data-learning="next"]')?.textContent !== "Done"; i++) { await next(); walked.push(step() ?? ""); }
    for (const beat of ["canvas:fit", "canvas:search", "canvas:surface"]) assert.ok(walked.includes(beat), `the canvas lesson walks ${beat}`);
    await click("Done");
    assert.equal(step(), "end");
    await click("Back to my card");
    assert.equal(document.querySelector('[role="dialog"]'), null);

    // ── Phone: panels instead of a staged canvas ──
    Object.defineProperty(window, "innerWidth", { value: 375, configurable: true });
    await act(async () => store.setState({ worldDraft: { ...store.getState().worldDraft, id: "phone-draft" } }));
    await open();
    await act(async () => lessonCard("opening")!.click());
    assert.equal(step(), "opening");
    assert.equal(seen.stage, null, "a phone has no canvas to stage");
    assert.deepEqual(routed.at(-1), { panelId: "first-message", canvasTarget: "opening" }, "the phone opens the matching panel");
    const writingField = document.createElement("textarea"); document.body.append(writingField);
    await act(async () => writingField.dispatchEvent(new Event("focusin", { bubbles: true })));
    assert.equal(document.getElementById("creator-tour-body")?.hidden, true, "phone typing folds the guide");
    await click("Show instructions");
    assert.equal(document.getElementById("creator-tour-body")?.hidden, false);
    writingField.remove();
    await next();
    assert.deepEqual(routed.at(-1), { panelId: "lorebook", canvasTarget: "setting" });
    Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });

    // ── Cards, accounts, returning authors, read-only ──
    await act(async () => store.setState({ worldDraft: { ...store.getState().worldDraft, id: "different-draft" } }));
    assert.equal(step(), undefined, "switching cards pauses the guide");
    await act(async () => profile.setState({ profile: { id: "other-learner" } as never }));
    assert.equal(readLearningProgress("other-learner").completed.state, undefined);
    writeLearningProgress("returning-learner", { seenRelease: "blueprint-tour-5", current: "setting", completed: { name: 2, opening: 5 } });
    await act(async () => profile.setState({ profile: { id: "returning-learner" } as never }));
    assert.equal(step(), undefined, "a teaching update does not force returning creators into the guide");
    assert.equal(document.querySelector('[role="dialog"]'), null, "the prior release dismissal stays respected");
    await open();
    assert.equal(catalogOpen(), false, "before the first three are done, 新手引导 carries on with them");
    assert.equal(step(), "setting", "progress from the previous release resumes at its lesson (an older revision of the opening still counts)");
    assert.deepEqual(readLearningProgress("returning-learner").completed, { opening: 5 }, "resuming neither resets prior progress nor claims the revised lesson was completed");
    await click("Pause the guide");
    await act(async () => store.setState({ readOnlyInspect: true }));
    await open();
    assert.equal(document.querySelector('[data-learning="start"]'), null, "read-only help offers reading, not editing actions");
    assert.ok(lessonCard("opening")?.disabled && lessonCard("ship"), "read-only help lists every lesson");

    // ── The first lesson starts once, and never over a card started from a starter ──
    await act(async () => store.setState({ readOnlyInspect: false }));
    const guided = () => step() !== undefined;
    sessionStorage.setItem("yumina-studio-quiet-tour", "1");
    await act(async () => profile.setState({ profile: { id: "starter-learner" } as never }));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 600)); });
    assert.equal(guided(), false, "a starter's first visit opens on its screen, not under the guide");
    assert.ok(readLearningProgress("starter-learner").seenRelease, "held back counts as offered");
    await act(async () => profile.setState({ profile: { id: "someone-else" } as never }));
    await act(async () => profile.setState({ profile: { id: "starter-learner" } as never }));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 600)); });
    assert.equal(guided(), false, "a remount (简单 → 画布) does not bring it back over the same card");
    await act(async () => profile.setState({ profile: { id: "fresh-learner" } as never }));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 600)); });
    assert.equal(step(), "opening", "a first visit of one's own starts the first lesson");
    assert.ok(readLearningProgress("fresh-learner").seenRelease, "…and that start is the only one, whatever ends it");
    await act(async () => store.setState({ worldDraft: { ...store.getState().worldDraft, id: "loaded-after-mount" } }));
    assert.equal(guided(), false, "a card arriving after mount pauses it");
    await act(async () => profile.setState({ profile: { id: "someone-else-2" } as never }));
    await act(async () => profile.setState({ profile: { id: "fresh-learner" } as never }));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 600)); });
    assert.equal(guided(), false, "not started a second time");
    await open();
    assert.equal(step(), "opening", "帮助 still brings it back");
    await click("Pause the guide");

    // ── Analytics ──
    assert.ok(captured.some(e => e.step === "catalog" && e.action === "start"));
    assert.ok(captured.some(e => e.step === "interface" && e.action === "complete"));
    assert.ok(captured.some(e => e.step === "behavior" && e.action === "pause"));
    assert.ok(captured.some(e => e.action === "resume"));
    assert.equal(captured.filter(e => e.step === "interface" && e.action === "view" && e.flow_id === captured[0].flow_id).length, 1, "draft rerenders do not inflate step views");
    assert.equal(captured.filter(e => e.step === "opening" && e.action === "view" && e.flow_id === captured[0].flow_id).length, 2, "going back to a lesson is a second view of it");
    for (const event of captured) assert.ok(Object.keys(event).every(key => ["release", "flow_id", "step", "action", "reason", "outcome", "environment", "app_release"].includes(key)));
    assert.ok(!JSON.stringify(captured).includes("mushroom"), "story contents never enter the analytics payload");
  } finally {
    await act(async () => root.unmount());
    // Radix restores focus on the next task. Drain that cleanup while DOM
    // globals still belong to this window, before restoring Node's Event.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    await vite.close(); dom.window.close();
    for (const [key, descriptor] of original) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
