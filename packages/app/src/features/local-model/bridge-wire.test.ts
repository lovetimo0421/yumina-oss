import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';

const vite=await createServer({configFile:false,root:fileURLToPath(new URL('../../..',import.meta.url)),appType:'custom',logLevel:'silent',
 resolve:{alias:{'@':fileURLToPath(new URL('../..',import.meta.url))}},server:{middlewareMode:true},
 plugins:[{name:'isolated-i18n',enforce:'pre',load(id){if(id.replaceAll('\\','/').endsWith('/lib/i18n.ts'))return `export default {t:key=>key};`;}}]});
const {LocalBridge}=await vite.ssrLoadModule('/src/features/local-model/bridge.ts');
after(()=>vite.close());

test('native and compatible computer requests preserve JSON mode, terminal reason and ordered reports',async()=>{
 const originalFetch=globalThis.fetch,eventSource=Object.getOwnPropertyDescriptor(globalThis,'EventSource');
 class Source extends EventTarget {static current:Source;onerror=null;constructor(){super();Source.current=this;}close(){}}
 Object.defineProperty(globalThis,'EventSource',{configurable:true,value:Source});
 try{for(const native of [true,false])for(const structured of [true,false]){
  const reports:any[]=[],runtimeBodies:any[]=[];let done!:()=>void;
  const finished=new Promise<void>(r=>{done=r;});
  globalThis.fetch=async(url,init)=>{
   const body=JSON.parse(String(init?.body||'{}'));
   if(String(url).endsWith('/announce'))return Response.json({ok:true});
   if(String(url).endsWith('/report')){reports.push(body);if(body.kind==='done'||body.kind==='error')done();return Response.json({ok:true});}
   assert.equal(String(url),native?'http://127.0.0.1:11434/api/chat':'http://127.0.0.1:1234/v1/chat/completions');runtimeBodies.push(body);
   const stream=native?JSON.stringify({message:{content:'{"text":"Hi"}'},done:true,done_reason:'length',prompt_eval_count:7,eval_count:4})+'\n':
    'data: '+JSON.stringify({choices:[{delta:{content:'{"text":"Hi"}'},finish_reason:'length'}],usage:{prompt_tokens:7,completion_tokens:4}})+'\n\ndata: [DONE]\n\n';
   return new Response(stream,{headers:{'content-type':native?'application/x-ndjson':'text/event-stream'}});
  };
  const bridge=new LocalBridge({runtime:{kind:native?'ollama':'lmstudio',label:'Test',origin:native?'http://127.0.0.1:11434':'http://127.0.0.1:1234',native},models:[{id:'test'}]});
  try{
   await bridge.start();Source.current.dispatchEvent(new MessageEvent('job',{data:JSON.stringify({requestId:'job',payload:{model:'test',messages:[{role:'user',content:'Hi'}],num_ctx:32768,...(structured?{response_format:{type:'json_object'}}:{})}})}));
   await finished;
   assert.equal(runtimeBodies.length,1);
   assert.deepEqual(native?runtimeBodies[0].format:runtimeBodies[0].response_format,structured?(native?'json':{type:'json_object'}):undefined);
   assert.deepEqual(reports.map(r=>r.kind),['chunk','done']);assert.equal(reports[1].stopReason,'length');assert.deepEqual(reports[1].usage,{promptTokens:7,completionTokens:4});
  }finally{bridge.stop();}
 }}finally{globalThis.fetch=originalFetch;if(eventSource)Object.defineProperty(globalThis,'EventSource',eventSource);else Reflect.deleteProperty(globalThis,'EventSource');}
});

test('a healthy computer refreshes its advertised models so long games do not lose the model after five minutes',async t=>{
 const originalFetch=globalThis.fetch,eventSource=Object.getOwnPropertyDescriptor(globalThis,'EventSource');let announcements=0;
 Object.defineProperty(globalThis,'EventSource',{configurable:true,value:class extends EventTarget{close(){}}});
 t.mock.timers.enable({apis:['setInterval','Date'],now:1_000_000});
 globalThis.fetch=async url=>{if(String(url).endsWith('/announce'))announcements++;return Response.json({ok:true});};
 const bridge=new LocalBridge({runtime:{kind:'ollama',label:'Test',origin:'http://127.0.0.1:11434',native:true},models:[{id:'test'}]});
 try{await bridge.start();assert.equal(announcements,1);t.mock.timers.tick(60000);await new Promise(r=>setImmediate(r));assert.equal(announcements,2);}
 finally{bridge.stop();t.mock.timers.reset();globalThis.fetch=originalFetch;if(eventSource)Object.defineProperty(globalThis,'EventSource',eventSource);else Reflect.deleteProperty(globalThis,'EventSource');}
});
