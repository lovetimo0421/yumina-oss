import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { create } from "zustand";
import { JSDOM } from "jsdom";
import ts from "typescript";

test("activity distinguishes errors, retries, preserves known results and discards late responses after switching cards", async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const originalFetch = globalThis.fetch;
  for (const [key, value] of Object.entries({window:dom.window, document:dom.window.document, navigator:dom.window.navigator, IS_REACT_ACT_ENVIRONMENT:true})) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {value, configurable:true});
  }
  const store = create(() => ({serverWorldId: "a"}));
  const require = createRequire(import.meta.url);
  const source = readFileSync(new URL("./station-activity.tsx", import.meta.url), "utf8").replace("import.meta.env.VITE_API_URL", '""');
  const js = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const module = {exports:{} as {StationActivity: React.FC<{bookId:string;kind:"narrator"}>}};
  new Function("require", "module", "exports", js)((id:string) => id === "@/stores/editor" ? {useEditorStore:store} :
    id === "react-i18next" ? {useTranslation:() => ({t:(key:string) => key, i18n:{language:"en"}})} : require(id), module, module.exports);
  const requests: Array<{url:string;resolve:(response:Response)=>void;reject:(error:Error)=>void}> = [];
  globalThis.fetch = async url => new Promise<Response>((resolve,reject) => requests.push({url:String(url),resolve,reject}));
  const root = createRoot(document.getElementById("root")!);
  const reply = (text:string) => Response.json({data:{at:"2026-09-07T00:00:00Z",runs:text ? [{bookId:"b",runIndex:1,closedAt:"2026-09-07T00:00:00Z",summaryStatus:"ready",summary:text}] : [],workers:[]}});
  const refresh = async () => act(async () => document.querySelector<HTMLButtonElement>("button")!.click());
  try {
    await act(async () => root.render(<module.exports.StationActivity bookId="b" kind="narrator" />));
    await act(async () => requests[0]!.resolve(Response.json({error:"failed"},{status:503})));
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /activity.error/);
    assert.doesNotMatch(document.body.textContent!, /activityEmpty/);
    await refresh(); await act(async () => requests[1]!.resolve(reply("Known A")));
    assert.equal(document.querySelector('[role="alert"]'), null);
    assert.match(document.body.textContent!, /Known A/);
    await refresh(); await act(async () => requests[2]!.reject(new Error("offline")));
    assert.ok(document.querySelector('[role="alert"]'));
    assert.match(document.body.textContent!, /Known A/);
    await refresh();
    await act(async () => store.setState({serverWorldId:"new-card"}));
    assert.equal(requests[4]!.url, "/api/studio/new-card/station-activity");
    assert.doesNotMatch(document.body.textContent!, /Known A/);
    await act(async () => requests[4]!.resolve(reply("Known B")));
    await act(async () => requests[3]!.resolve(reply("Late A")));
    assert.match(document.body.textContent!, /Known B/);
    assert.doesNotMatch(document.body.textContent!, /Late A/);
    await refresh(); await act(async () => requests[5]!.resolve(reply("")));
    assert.match(document.body.textContent!, /activityEmpty/);
    assert.equal(document.querySelector('[role="alert"]'), null);
  } finally {
    await act(async () => root.unmount()); dom.window.close(); globalThis.fetch = originalFetch;
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis,key,descriptor); else Reflect.deleteProperty(globalThis,key); }
  }
});

test("a run the module has not closed yet is shown as open, not as nothing", async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const originalFetch = globalThis.fetch;
  for (const [key, value] of Object.entries({window:dom.window, document:dom.window.document, navigator:dom.window.navigator, IS_REACT_ACT_ENVIRONMENT:true})) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {value, configurable:true});
  }
  const store = create(() => ({serverWorldId: "a"}));
  const require = createRequire(import.meta.url);
  const source = readFileSync(new URL("./station-activity.tsx", import.meta.url), "utf8").replace("import.meta.env.VITE_API_URL", '""');
  const js = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const module = {exports:{} as {StationActivity: React.FC<{bookId:string;kind:"narrator"}>}};
  new Function("require", "module", "exports", js)((id:string) => id === "@/stores/editor" ? {useEditorStore:store} :
    id === "react-i18next" ? {useTranslation:() => ({t:(key:string) => key, i18n:{language:"en"}})} : require(id), module, module.exports);
  const requests: Array<{url:string;resolve:(response:Response)=>void}> = [];
  globalThis.fetch = async url => new Promise<Response>(resolve => requests.push({url:String(url),resolve}));
  const root = createRoot(document.getElementById("root")!);
  const refresh = async () => act(async () => document.querySelector<HTMLButtonElement>("button")!.click());
  try {
    await act(async () => root.render(<module.exports.StationActivity bookId="b" kind="narrator" />));
    // A keyword module holds the floor: it narrated, and nothing closed it.
    await act(async () => requests[0]!.resolve(Response.json({data:{at:"2026-09-13T00:00:00Z",
      open:[{bookId:"b",runIndex:1,fromAt:"2026-09-13T00:00:00Z"}],runs:[],workers:[]}})));
    assert.doesNotMatch(document.body.textContent!, /activityEmpty/);
    assert.match(document.body.textContent!, /activityStatus\.open/);
    assert.match(document.body.textContent!, /#1/);
    // Another module's open run is somebody else's business.
    await refresh();
    await act(async () => requests[1]!.resolve(Response.json({data:{at:"2026-09-13T00:00:00Z",
      open:[{bookId:"other",runIndex:3,fromAt:"2026-09-13T00:00:00Z"}],runs:[],workers:[]}})));
    assert.match(document.body.textContent!, /activityEmpty/);
    // A server that predates open runs costs the row, not the panel.
    await refresh();
    await act(async () => requests[2]!.resolve(Response.json({data:{at:"2026-09-13T00:00:00Z",
      runs:[{bookId:"b",runIndex:1,fromAt:"2026-09-12T00:00:00Z",closedAt:"2026-09-13T00:00:00Z",summaryStatus:"ready",summary:"Closed one"}],workers:[]}})));
    assert.equal(document.querySelector('[role="alert"]'), null);
    assert.match(document.body.textContent!, /Closed one/);
    // A closed run carries fromAt too. Reading one field would have called it open.
    assert.doesNotMatch(document.body.textContent!, /activityStatus\.open/);
    assert.match(document.body.textContent!, /activityStatus\.ready/);
  } finally {
    await act(async () => root.unmount()); dom.window.close(); globalThis.fetch = originalFetch;
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis,key,descriptor); else Reflect.deleteProperty(globalThis,key); }
  }
});
