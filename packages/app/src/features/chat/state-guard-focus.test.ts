import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { activeGuardElement, focusGuardDialog, installGuardFocusScope } from "../../../sandbox/extensions/state-update-guard/focus";

test("guard traps real shadow-root keyboard focus, nests the picker, and restores the opener", () => {
  const dom = new JSDOM('<button id="opener">Open guard</button><button id="outside">Story</button><div id="overlay"></div>');
  const doc = dom.window.document;
  const opener = doc.getElementById("opener") as HTMLButtonElement;
  const outside = doc.getElementById("outside") as HTMLButtonElement;
  const host = doc.getElementById("overlay")!;
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = '<div role="dialog"><button id="close">Close</button><button id="toggle">Off</button><button id="model">Model</button><button disabled>Saving</button><button hidden>Hidden</button></div>';
  const guard = shadow.querySelector<HTMLElement>('[role="dialog"]')!;
  const close = shadow.getElementById("close") as HTMLButtonElement;
  const model = shadow.getElementById("model") as HTMLButtonElement;
  let activeDialog = guard;
  let guardClosed = false;
  opener.focus();
  const cleanup = installGuardFocusScope(doc, () => activeDialog, () => {
    if (activeDialog !== guard) {
      activeDialog.remove(); activeDialog = guard; focusGuardDialog(guard, model);
    } else guardClosed = true;
  });
  const key = (value: string, shiftKey = false) => {
    const event = new dom.window.KeyboardEvent("keydown", { key: value, shiftKey, bubbles: true, composed: true, cancelable: true });
    activeGuardElement(doc)!.dispatchEvent(event);
    return event;
  };
  try {
    focusGuardDialog(guard);
    assert.equal(doc.activeElement, host, "the document sees the host, not Close");
    assert.equal(activeGuardElement(doc), close);
    assert.equal(key("Tab", true).defaultPrevented, true);
    assert.equal(activeGuardElement(doc), model, "Shift+Tab skips disabled and hidden controls");
    assert.equal(key("Tab").defaultPrevented, true);
    assert.equal(activeGuardElement(doc), close);
    assert.equal(key("Tab").defaultPrevented, false, "normal interior tab order remains native");
    outside.focus();
    assert.equal(activeGuardElement(doc), close, "focus cannot move behind the dialog");

    model.focus();
    const picker = doc.createElement("div"); picker.setAttribute("role", "dialog");
    picker.innerHTML = '<button>Close picker</button><input placeholder="Search"><button>Choose model</button>';
    shadow.append(picker); activeDialog = picker; focusGuardDialog(picker);
    const pickerFirst = picker.querySelector<HTMLButtonElement>("button")!;
    const pickerLast = picker.querySelector<HTMLButtonElement>("button:last-child")!;
    assert.equal(activeGuardElement(doc), pickerFirst, "official picker takes focus without its own autofocus");
    key("Tab", true); assert.equal(activeGuardElement(doc), pickerLast);
    key("Tab"); assert.equal(activeGuardElement(doc), pickerFirst);
    picker.querySelector<HTMLInputElement>("input")!.focus();
    key("Escape");
    assert.equal(guardClosed, false, "Escape dismisses only the nested picker");
    assert.equal(activeGuardElement(doc), model, "removed BYOK search returns focus to the model trigger");
    key("Escape"); assert.equal(guardClosed, true);
  } finally {
    cleanup();
    assert.equal(doc.activeElement, opener, "closing the whole guard restores the play-page opener");
    outside.focus(); assert.equal(doc.activeElement, outside, "cleanup removes focus containment");
    dom.window.close();
  }
});
