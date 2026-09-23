import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {OpenRouterProvider} from './openrouter.js';
import {FREE_ROUTER_MODEL,FREE_ROUTER_FALLBACK_MODEL,FREE_ROUTER_LAST_RESORT_MODEL,getOfficialProviderFallbackModels} from './fallback-models.js';
import type {GenerateParams,StreamChunk} from './types.js';

const exhausted=()=>Response.json({error:{code:429,message:'Rate limit exceeded: free-models-per-day-high-balance.'}},{status:429});
const temporary=()=>Response.json({error:{code:429,message:'Temporarily rate limited upstream.'}},{status:429});
const reply=(stream:boolean)=>stream?new Response('data: '+JSON.stringify({choices:[{delta:{content:'Still here.'},finish_reason:'stop'}],usage:{prompt_tokens:12,completion_tokens:4,total_tokens:16}})+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}}):Response.json({choices:[{message:{content:'Still here.'},finish_reason:'stop'}],usage:{prompt_tokens:12,completion_tokens:4,total_tokens:16}});
const params=(stream=true):GenerateParams=>({model:FREE_ROUTER_MODEL,messages:[{role:'user',content:'Are you there?'}],stream,singleAttempt:true,fallbackModels:getOfficialProviderFallbackModels(FREE_ROUTER_MODEL,false),fallbackOnTransientErrors:true});
async function collect(key:string,request=params()){
 const chunks:StreamChunk[]=[];
 for await(const chunk of new OpenRouterProvider(key).generateStream(request))chunks.push(chunk);
 return chunks;
}
function mockFetch(responses:Array<()=>Response>){
 const original=globalThis.fetch,models:string[]=[],bodies:any[]=[];
 globalThis.fetch=(async(_input,init)=>{
  const body=JSON.parse(String(init?.body));models.push(body.model);bodies.push(body);
  assert.ok(models.length<=responses.length,'unexpected extra upstream request');
  return responses[models.length-1]!();
 }) as typeof fetch;
 return {models,bodies,restore:()=>{globalThis.fetch=original;}};
}

for(const stream of [true,false])test(`a confirmed daily cap skips one doomed call on the next ${stream?'streaming':'non-streaming'} turn`,async()=>{
 const key=randomUUID(),request=params(stream),before=structuredClone(request);
 const mocked=mockFetch([exhausted,()=>reply(stream),()=>reply(stream)]);
 try{
  await collect(key,request);
  const second=await collect(key,request);
  assert.deepEqual(mocked.models,[FREE_ROUTER_MODEL,FREE_ROUTER_FALLBACK_MODEL,FREE_ROUTER_FALLBACK_MODEL]);
  assert.equal(second.find(c=>c.model)?.model,FREE_ROUTER_FALLBACK_MODEL);
  assert.equal(second.find(c=>c.type==='text')?.content,'Still here.');
  assert.equal(second.find(c=>c.usage)?.usage?.totalTokens,16);
  assert.deepEqual(request,before,'request ownership, format and fallback policy are unchanged');
 }finally{mocked.restore();}
});

test('cooldown is credential-scoped and cannot switch a private or paid selection',async()=>{
 const key=randomUUID(),mocked=mockFetch([exhausted,()=>reply(true),()=>reply(true),exhausted,()=>reply(true)]);
 try{
  await collect(key);
  await collect(randomUUID());
  const privateReply=await collect(key,{...params(),fallbackModels:undefined});
  assert.ok(privateReply.some(c=>c.type==='error'));
  await collect(key,{...params(),model:'chosen-paid-model',fallbackModels:undefined});
  assert.deepEqual(mocked.models,[FREE_ROUTER_MODEL,FREE_ROUTER_FALLBACK_MODEL,FREE_ROUTER_MODEL,FREE_ROUTER_MODEL,'chosen-paid-model']);
 }finally{mocked.restore();}
});

test('temporary throttling still probes the free pool on the following turn',async()=>{
 const key=randomUUID(),mocked=mockFetch([temporary,()=>reply(true),()=>reply(true)]);
 try{
  await collect(key);await collect(key);
  assert.deepEqual(mocked.models,[FREE_ROUTER_MODEL,FREE_ROUTER_FALLBACK_MODEL,FREE_ROUTER_MODEL]);
 }finally{mocked.restore();}
});

test('a cached daily cap still uses this request\'s vision fallback and preserves cancellation',async()=>{
 const key=randomUUID(),vision=getOfficialProviderFallbackModels(FREE_ROUTER_MODEL,false,true)!,mocked=mockFetch([exhausted,()=>reply(true),()=>reply(true)]);
 try{
  await collect(key);
  await collect(key,{...params(),fallbackModels:vision});
  const controller=new AbortController();controller.abort();
  assert.deepEqual(await collect(key,{...params(),signal:controller.signal}),[]);
  assert.deepEqual(mocked.models,[FREE_ROUTER_MODEL,FREE_ROUTER_FALLBACK_MODEL,vision[0]]);
 }finally{mocked.restore();}
});

test('a cached daily cap preserves the last fallback when the first fallback is down',async()=>{
 const key=randomUUID(),mocked=mockFetch([exhausted,()=>reply(true),temporary,()=>reply(true)]);
 try{
  await collect(key);const chunks=await collect(key);
  assert.deepEqual(mocked.models,[FREE_ROUTER_MODEL,FREE_ROUTER_FALLBACK_MODEL,FREE_ROUTER_FALLBACK_MODEL,FREE_ROUTER_LAST_RESORT_MODEL]);
  assert.equal(chunks.find(c=>c.model)?.model,FREE_ROUTER_LAST_RESORT_MODEL);
 }finally{mocked.restore();}
});

test('the short cooldown expires and allows the recovered free pool to answer',async t=>{
 t.mock.timers.enable({apis:['Date'],now:1_000_000});
 const key=randomUUID(),mocked=mockFetch([exhausted,()=>reply(true),()=>reply(true)]);
 try{
  await collect(key);t.mock.timers.tick(60_001);await collect(key);
  assert.deepEqual(mocked.models,[FREE_ROUTER_MODEL,FREE_ROUTER_FALLBACK_MODEL,FREE_ROUTER_MODEL]);
 }finally{mocked.restore();t.mock.timers.reset();}
});
