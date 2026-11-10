import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import ts from "typescript";

test("test starts recover from list failures and ignore old-card mutations", async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const old = { window:globalThis.window, document:globalThis.document, fetch:globalThis.fetch };
  Object.assign(globalThis, {window:dom.window, document:dom.window.document, IS_REACT_ACT_ENVIRONMENT:true});
  const {createRoot} = await import("react-dom/client");
  const require = createRequire(import.meta.url);
  const source = readFileSync(new URL("./playtest-starts.tsx", import.meta.url), "utf8").replace("import.meta.env.VITE_API_URL", '""');
  const js = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const module = {exports:{} as {PlaytestStarts: React.ComponentType<any>}};
  const chat = {session:{id:"session-a",state:{}},gameState:{},isStreaming:false};
  const useChatStore = Object.assign((select: (s:typeof chat) => unknown) => select(chat), {getState:() => chat});
  new Function("require", "module", "exports", js)((id:string) => id === "@/stores/chat" ? {useChatStore} :
    id === "@/lib/session-state-queue" ? {whenSessionStateSettled:async () => {}} :
    id === "@/components/ui/two-tap-delete-button" ? {TwoTapDeleteButton:({onConfirm,children,armedTitle:_,...props}:any) => <button {...props} onClick={onConfirm}>{children}</button>} :
    id === "react-i18next" ? {useTranslation:() => ({t:(key:string) => key})} : require(id), module, module.exports);
  const requests: Array<{url:string;method:string;resolve:(response:Response)=>void}> = [];
  globalThis.fetch = async (url,init) => new Promise<Response>(resolve => requests.push({url:String(url),method:init?.method ?? "GET",resolve}));
  const selected:string[] = [];
  const root = createRoot(document.getElementById("root")!);
  const render = async (worldId:string, selectedId="", sessionId=`session-${worldId}`) => act(async () => root.render(<module.exports.PlaytestStarts
    worldId={worldId} sessionId={sessionId} selectedId={selectedId} onSelect={(id:string) => selected.push(id)} onRun={async () => {}} busy={false} />));
  const reply = (id:string) => Response.json({data:[{id,name:`Start ${id}`,messageCount:2,createdAt:"2026-09-07T00:00:00Z"}]});
  const click = async (label:string) => {
    const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"],button[title="${label}"]`);
    assert.ok(button, `available action: ${label}`);
    await act(async () => button.click());
  };
  try {
    await render("a", "a-start");
    await act(async () => requests[0]!.resolve(Response.json({error:"private server details"},{status:503})));
    assert.ok(document.querySelector('[role="alert"]'));
    assert.doesNotMatch(document.body.textContent!, /private server details/);
    await click("studio.testStarts.retry");
    await act(async () => requests[1]!.resolve(reply("a-start")));
    assert.match(document.body.textContent!, /Start a-start/);
    assert.equal(document.querySelector('[role="alert"]'),null);
    await click("studio.testStarts.delete");
    assert.equal(requests[2]!.method,"DELETE");
    await render("b", "b-start");
    await act(async () => requests[3]!.resolve(reply("b-start")));
    await act(async () => requests[2]!.resolve(Response.json({})));
    assert.deepEqual(selected,[],"old delete must not clear the new card's selection");
    assert.match(document.body.textContent!, /Start b-start/);
    assert.doesNotMatch(document.body.textContent!, /Start a-start/);
    await render("c");
    await act(async () => requests[4]!.resolve(Response.json({data:{invalid:true}})));
    assert.ok(document.querySelector('[role="alert"]'),"malformed list is recoverable instead of crashing");
    await click("studio.testStarts.retry");
    await act(async () => requests[5]!.resolve(Response.json({data:[]})));
    assert.equal(document.querySelector('[role="alert"]'),null);
    chat.session.id = "session-c";
    await click("studio.testStarts.saveCurrent");
    const input = document.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,"value")!.set!.call(input,"Saved C");
      input.dispatchEvent(new dom.window.Event("input",{bubbles:true}));
    });
    await act(async () => document.querySelector("form")!.dispatchEvent(new dom.window.Event("submit",{bubbles:true,cancelable:true})));
    assert.equal(requests[6]!.method,"POST");
    await render("d");
    await act(async () => requests[7]!.resolve(reply("d-start")));
    await act(async () => requests[6]!.resolve(Response.json({data:{id:"c-saved",name:"Late saved C",messageCount:3,createdAt:null}})));
    assert.deepEqual(selected,[],"old save cannot select a start in the new card");
    assert.match(document.body.textContent!,/Start d-start/);
    assert.doesNotMatch(document.body.textContent!,/Late saved C/);
    chat.session.id = "session-d";
    await click("studio.testStarts.saveCurrent");
    const nextInput = document.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,"value")!.set!.call(nextInput,"Saved D");
      nextInput.dispatchEvent(new dom.window.Event("input",{bubbles:true}));
    });
    await act(async () => {
      const form = document.querySelector("form")!;
      form.dispatchEvent(new dom.window.Event("submit",{bubbles:true,cancelable:true}));
      form.dispatchEvent(new dom.window.Event("submit",{bubbles:true,cancelable:true}));
    });
    assert.equal(requests.length,9,"rapid submits issue only one save");
    await render("d","","session-d-restarted");
    await act(async () => requests[8]!.resolve(Response.json({data:{id:"d-saved",name:"Saved before restart",messageCount:3,createdAt:null}})));
    assert.deepEqual(selected,["d-saved"],"same-card restart must retain the confirmed saved start");
    assert.match(document.body.textContent!,/Saved before restart/);
    await render("d","d-saved","session-d-restarted");
    await click("studio.testStarts.delete");
    assert.equal(requests[9]!.method,"DELETE");
    await render("d","d-saved","session-d-again");
    await act(async () => requests[9]!.resolve(Response.json({})));
    assert.deepEqual(selected,["d-saved",""],"same-card restart must reconcile a confirmed deletion");
    assert.doesNotMatch(document.body.textContent!,/Saved before restart/);
    await render("d","d-start","session-d-again");
    await click("studio.testStarts.delete");
    await act(async () => requests[10]!.resolve(Response.json({},{status:503})));
    assert.match(document.body.textContent!,/Start d-start/,"failed deletion retains the known option");
    await click("studio.testStarts.retry");
    await act(async () => requests[11]!.resolve(Response.json({data:[]})));
    assert.deepEqual(selected,["d-saved","",""],"reload clears selection if the uncertain deletion actually committed");
    assert.doesNotMatch(document.body.textContent!,/Start d-start/);
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    Object.assign(globalThis,{...old,IS_REACT_ACT_ENVIRONMENT:false});
  }
});
