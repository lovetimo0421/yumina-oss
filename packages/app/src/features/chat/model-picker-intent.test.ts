import assert from "node:assert/strict";
import test from "node:test";
import {buildAPI} from "../../../sandbox/sandbox-context";
import {unwrapMessage, type ApiCallMessage} from "../../../sandbox/protocol";

test("SDK distinguishes side completions while ordinary embedded chat keeps its trial", async t => {
  const before=Object.getOwnPropertyDescriptor(globalThis,"window");
  const calls: ApiCallMessage[]=[];
  Object.defineProperty(globalThis,"window",{configurable:true,value:{parent:{postMessage(data:unknown){calls.push(unwrapMessage<ApiCallMessage>(data)!);}}}});
  t.after(()=>{if(before)Object.defineProperty(globalThis,"window",before);else Reflect.deleteProperty(globalThis,"window");});
  const api=buildAPI({variables:{},globalVariables:{},messages:[],mode:"session",sessionId:"test"} as unknown as Parameters<typeof buildAPI>[0]);
  api.openModelPicker({purpose:"side-completion"});
  api.openModelPicker();
  assert.deepEqual(calls.map(c=>({method:c.method,args:c.args})),[
    {method:"openModelPicker",args:[{purpose:"side-completion"}]},
    {method:"openModelPicker",args:[]},
  ]);
});
