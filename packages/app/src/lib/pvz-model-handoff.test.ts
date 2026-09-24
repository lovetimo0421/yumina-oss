import assert from "node:assert/strict";
import test from "node:test";
import { createPvzModelSelection, isPvzModelAcknowledgement, readPvzModelHandoff, isPvzModelConfigReady, savePvzModelSelection } from "./pvz-model-handoff";
import { parseSafeAuthReturnTo } from "./auth-return";

const channel = "e19d4e64-8c9a-4a83-9195-ef76623161d4";
const query = `?channel=${channel}&account=user-123&selected=custom%2Fmodel&lang=zh`;
test('model selection persists only the model under its original account before handoff',async()=>{
 let writes=0;
 const request:typeof fetch=async(url,init)=>{
  writes++;assert.equal(url,'/api/users/me/ai-config');assert.equal(init?.method,'PUT');assert.equal(init?.credentials,'include');
  assert.equal(new Headers(init?.headers).get('X-Yumina-Account-Id'),'alice');
  assert.deepEqual(JSON.parse(String(init?.body)),{selectedModel:'local/qwen-test'});
  return Response.json({data:{selectedModel:'local/qwen-test'}});
 };
 await savePvzModelSelection('alice','local/qwen-test',request);assert.equal(writes,1);
 await assert.rejects(savePvzModelSelection('alice','',request),/invalid_selection/);assert.equal(writes,1);
 for(const status of [401,409])await assert.rejects(savePvzModelSelection('alice','local/qwen-test',async()=>new Response('',{status})),/account_changed/);
 await assert.rejects(savePvzModelSelection('alice','local/qwen-test',async()=>Response.json({data:{selectedModel:'openai/test'}})),/selection_not_saved/);
 await assert.rejects(savePvzModelSelection('alice','local/qwen-test',async()=>new Response('',{status:503})),/selection_not_saved/);
});

test('both official and private accounts can use the fallback picker without setting up another key',()=>{
  assert.equal(isPvzModelConfigReady({enabled:true,ready:true,privateReady:false}),true);
  assert.equal(isPvzModelConfigReady({enabled:true,ready:true,privateReady:true}),true);
  assert.equal(isPvzModelConfigReady({enabled:true,privateReady:true}),true);
  assert.equal(isPvzModelConfigReady({enabled:true,ready:false,privateReady:true}),false);
  assert.equal(isPvzModelConfigReady({enabled:false,ready:true,privateReady:true}),false);
  assert.equal(isPvzModelConfigReady(null),false);
});

test("model handoff parses only bounded identifiers, preserving model strings", () => {
  assert.deepEqual(readPvzModelHandoff(query), { channel, accountId: "user-123", selectedModel: "custom/model", lang: "zh" });
  assert.equal(readPvzModelHandoff(query.replace("custom%2Fmodel", "123"))?.selectedModel, "123");
  assert.equal(readPvzModelHandoff(`?channel=${channel}&account=user-123`)?.selectedModel, "");
  for (const invalid of ["", query.replace(channel, "arbitrary"), query.replace("user-123", ""), query + "&channel=duplicate", query.replace("custom%2Fmodel", "a".repeat(257)), query.replace("user-123", "%0Auser")]) {
    assert.equal(readPvzModelHandoff(invalid), null, invalid);
  }
});

test("model selection is bound to the currently authenticated account", () => {
  const handoff = readPvzModelHandoff(query)!;
  const selection = createPvzModelSelection(handoff, "user-123", "custom/model");
  assert.deepEqual(selection, { type: "pvz-dave-model", channel, accountId: "user-123", model: "custom/model" });
  assert.equal(createPvzModelSelection(handoff, "other-account", "custom/model"), null);
  for (const invalid of ["", " ", "a".repeat(257), "model\n", null, { model: "x" }]) {
    assert.equal(createPvzModelSelection(handoff, "user-123", invalid), null);
  }
});

test("only the matching game acknowledgement can finish the selection", () => {
  const selection = createPvzModelSelection(readPvzModelHandoff(query)!, "user-123", "custom/model")!;
  const ack = { ...selection, type: "pvz-dave-model-ack" };
  assert.equal(isPvzModelAcknowledgement(ack, selection), true);
  for (const invalid of [null, selection, { ...ack, accountId: "another" }, { ...ack, channel: "another" }, { ...ack, model: "another" }]) {
    assert.equal(isPvzModelAcknowledgement(invalid, selection), false);
  }
});

test("login can return to a validated picker handoff but never another destination", () => {
  const destination = `/pvz-models${query}`;
  assert.equal(parseSafeAuthReturnTo(destination), destination);
  for (const invalid of ["/pvz-models", "/pvz-models?channel=bad", `//evil.test/pvz-models${query}`, `/pvz-models/evil${query}`, `/pvz-models${query}#evil`]) {
    assert.equal(parseSafeAuthReturnTo(invalid), undefined);
  }
});
