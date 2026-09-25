import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { parseTokenCount } from "./token-number-input";

test("token counts parse grouping for the user's locale without truncating invalid text", () => {
  for (const locale of ["en-US", "nl-NL", "de-DE", "fr-FR", "zh-CN", "hi-IN"]) {
    assert.equal(parseTokenCount((32000).toLocaleString(locale), locale), 32000);
    assert.equal(parseTokenCount((200000).toLocaleString(locale), locale), 200000);
    assert.equal(parseTokenCount("16000", locale), 16000);
  }
  for (const invalid of ["", " ", "16abc", "1e4", "16.5", "16,5", "Infinity", "-50", "9007199254740992"]) {
    assert.equal(parseTokenCount(invalid, "en-US"), null, invalid);
  }
  assert.equal(parseTokenCount("16.5", "nl-NL"), null);
});

test("profile and settings fields allow clearing and retyping without saving intermediate numbers", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
  const originals = new Map(Object.keys(globals).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  const { act, createElement, useState } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { TokenNumberInput } = await import("./token-number-input");
  const { NumberInput } = await import("./number-input");
  const root = createRoot(dom.window.document.getElementById("root")!);
  const commits: number[] = [];
  function Harness({ compact }: { compact: boolean }) {
    const [value, setValue] = useState(32000);
    const change = (next: number | "") => {
      const clamped = Math.max(2048, Math.min(64000, Number(next) || 16000));
      commits.push(clamped); setValue(clamped);
    };
    return compact
      ? createElement(TokenNumberInput, { value, onCommit: change, min:2048, max:64000, formatted:true })
      : createElement(NumberInput, { value, onChange: change, min:2048, max:64000, commitOnBlur:true });
  }
  const field = () => dom.window.document.querySelector("input")!;
  const type = async (value: string) => act(async()=>{
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,"value")!.set!.call(field(),value);
    field().dispatchEvent(new dom.window.Event("input",{bubbles:true}));
  });
  const focus = async () => act(async()=>field().focus());
  const blur = async () => act(async()=>field().blur());
  const key = async (key: string) => act(async()=>field().dispatchEvent(new dom.window.KeyboardEvent("keydown",{key,bubbles:true,cancelable:true})));
  try {
    for (const compact of [true,false]) {
      commits.length = 0;
      await act(async()=>root.render(createElement(Harness,{compact,key:String(compact)})));
      await focus(); await blur();
      assert.deepEqual(commits, [], "focus alone must not persist an inherited default");
      await focus();
      for (const raw of ["3200","320","32","3","","1","16","160","1600","16000"]) {
        await type(raw);
        assert.equal(field().value,raw,"typing must not clamp or reformat the draft");
        assert.deepEqual(commits, [],"partial edits must not be persisted");
      }
      await key("Enter");
      assert.deepEqual(commits,[16000]);
      await focus(); await type(""); await blur();
      assert.equal(Number(field().value.replace(/,/g,"")),16000);
      assert.deepEqual(commits,[16000],"empty blur restores last saved value");
      await focus(); await type("9999"); await key("Escape");
      assert.deepEqual(commits,[16000],"Escape cancels without committing through blur");
      await focus(); await type("16abc"); await blur();
      assert.deepEqual(commits,[16000],"malformed input must never truncate to 16");
      await focus(); await type("100");
      assert.equal(field().value,"100"); await blur();
      assert.deepEqual(commits,[16000,2048]);
      await focus(); await type("999999"); await blur();
      assert.deepEqual(commits,[16000,2048,64000]);
    }
    commits.length = 0;
    const renderDirect = async (value: number, max: number) => act(async()=>root.render(createElement(TokenNumberInput, {
      value, min:2048, max, onCommit:(next:number)=>commits.push(next),
    })));
    await renderDirect(32000,64000);
    await focus(); await type("45000");
    await renderDirect(32000,16000);
    assert.equal(field().value,"45000","a cap update must not interrupt typing");
    await blur();
    assert.deepEqual(commits,[16000],"commit must use the latest plan cap");
    commits.length = 0;
    await renderDirect(32000,64000);
    await focus(); await type("8000");
    await renderDirect(64000,64000);
    assert.equal(field().value,"64000","a preset/server change replaces the old draft");
    await blur();
    assert.deepEqual(commits,[],"a stale draft must not overwrite a new preset");
  } finally {
    await act(async()=>root.unmount()); dom.window.close();
    for (const [key,descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis,key,descriptor); else Reflect.deleteProperty(globalThis,key);
    }
  }
});
