import test from 'node:test';
import assert from 'node:assert/strict';
import {Hono} from 'hono';
import type {AppEnv,SessionUser} from '../lib/types.js';
import {optionalAccountBinding} from './account-binding.js';

test('account-bound settings cannot write through a different login; existing unbound clients still work',async()=>{
 const app=new Hono<AppEnv>();let writes=0;
 app.use('*',async(c,next)=>{c.set('user',{id:'alice'} as SessionUser);await next();});
 app.put('/settings',optionalAccountBinding,c=>{writes++;return c.json({ok:true});});
 for(const expected of ['bob','']){
  const r=await app.request('/settings',{method:'PUT',headers:{'X-Yumina-Account-Id':expected}});
  assert.equal(r.status,409);assert.deepEqual(await r.json(),{error:'account_changed'});
 }
 assert.equal(writes,0);
 for(const headers of [new Headers(),new Headers({'X-Yumina-Account-Id':'alice'})])assert.equal((await app.request('/settings',{method:'PUT',headers})).status,200);
 assert.equal(writes,2);
});
