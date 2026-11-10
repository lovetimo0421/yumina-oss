import assert from 'node:assert/strict';
import test, { before } from 'node:test';
import { Hono } from 'hono';
import { migrateWorldDefinition, type WorldDefinition } from '@yumina/engine';
import { db } from '../db/index.js';
import { apiKeys, playSessions, user, worlds } from '../db/schema.js';
import { encryptApiKey } from '../lib/crypto.js';
import { OpenRouterProvider } from '../lib/llm/openrouter.js';
import type { GenerateParams, StreamChunk } from '../lib/llm/types.js';
import type { AppEnv } from '../lib/types.js';
import { completionRoutes } from './completions.js';

before(async () => { await import(new URL('../../scripts/test-local-schema.mjs', import.meta.url).href); });

test('side completions preserve opt-in JSON format through the real route and leave ordinary calls unchanged', async t => {
  const userId = crypto.randomUUID();
  await db.insert(user).values({ id:userId, name:'Format test', email:`${userId}@test.local`, preferences:{preferredProvider:'private'} });
  const key = encryptApiKey('synthetic-format-test-key');
  await db.insert(apiKeys).values({userId,provider:'openrouter',encryptedKey:key.encrypted,keyIv:key.iv,keyTag:key.tag});
  const worldId = crypto.randomUUID();
  const schema = migrateWorldDefinition({id:worldId,version:'1.0.0',name:'Format test',description:'',author:'test',entries:[],variables:[],rules:[],reactions:[],components:[],audioTracks:[],customUI:[],settings:{maxTokens:2000,temperature:1}} as unknown as WorldDefinition);
  await db.insert(worlds).values({id:worldId,creatorId:userId,name:schema.name,status:'draft',schema:schema as unknown as Record<string,unknown>});
  const [session] = await db.insert(playSessions).values({userId,worldId}).returning();
  const observed:GenerateParams[]=[];
  t.mock.method(OpenRouterProvider.prototype,'generateStream',async function* (params:GenerateParams):AsyncGenerator<StreamChunk> {
    observed.push(params);
    yield {type:'text',content:'{"actions":[],"line":""}'};
    yield {type:'done',content:'',usage:{promptTokens:20,completionTokens:10,totalTokens:30}};
  });
  const app=new Hono<AppEnv>();
  app.use('*',async(c,next)=>{c.set('user',{id:userId} as AppEnv['Variables']['user']);await next();});
  // Exercise the actual route handlers with a synthetic authenticated account.
  const route='/sessions/:sessionId/completions';
  for(const {handler} of completionRoutes.routes.filter(item=>item.method==='POST'&&item.path===route)) app.post(route,handler);
  const request=(extra:Record<string,unknown>)=>app.request(`/sessions/${session!.id}/completions`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:[{role:'user',content:'Return a JSON object.'}],model:'anthropic/claude-sonnet-4.6',...extra})});
  const json=await request({responseFormat:{type:'json_object'}});
  assert.equal(json.status,200);assert.match(await json.text(),/event: done/);
  assert.deepEqual(observed[0]?.responseFormat,{type:'json_object'});
  const plain=await request({});assert.equal(plain.status,200);await plain.text();
  assert.equal(observed[1]?.responseFormat,undefined);
  for(const responseFormat of [null,[],true,{type:'text'},{type:'json_object',schema:{}}]) {
    const invalid=await request({responseFormat});
    assert.equal(invalid.status,400,JSON.stringify(responseFormat));await invalid.text();
  }
  assert.equal(observed.length,2,'Invalid formats must never reach inference');
});
