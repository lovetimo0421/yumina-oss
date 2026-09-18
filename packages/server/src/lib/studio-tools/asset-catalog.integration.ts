import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { loadAssetCatalog, formatAssetCatalog, descendantFolderIds } from "./asset-catalog.js";
import { mutateSocialSession } from "../social-simulator-state.js";
import { applySocialAction, claimSocialJob, initialSocialState, renewSocialEpoch, finishSocialJob } from "@yumina/engine";

// Dedicated in-memory PGlite process only; never modify a configured database.
before(async () => {
  assert.equal(process.env.DATABASE_URL, "");
  const setup = `
    CREATE TABLE worlds (id text primary key, creator_id text);
    CREATE TABLE asset_folders (id text primary key, user_id text, name text, parent_folder_id text);
    CREATE TABLE world_folder_bindings (world_id text, folder_id text);
    CREATE TABLE user_assets (id text primary key,user_id text,filename text,type text,folder_id text);
    CREATE TABLE play_sessions (id text primary key,user_id text,state jsonb,updated_at timestamp);
    INSERT INTO worlds VALUES ('database-world','author'),('other-world','other');
    INSERT INTO asset_folders VALUES ('svt','author','SEVENTEEN',null),('nested','author','Portraits','svt'),('large','author','Other',null),('private','other','Private',null);
    INSERT INTO world_folder_bindings VALUES ('database-world','svt');
    INSERT INTO user_assets SELECT 'other-'||i,'author','AAA-'||i,'image','large' FROM generate_series(1,250) i;
    INSERT INTO user_assets SELECT 'svt-'||i,'author','Member-'||i,'image',CASE WHEN i=14 THEN 'nested' ELSE 'svt' END FROM generate_series(1,14) i;
    INSERT INTO user_assets VALUES ('private-photo','other','Member-private','image','private');
    INSERT INTO play_sessions VALUES ('s','author','{"metadata":{"keep":"yes"},"variables":{"hp":3}}',now()),('s2','author','{}',now());
  `;
  for (const statement of setup.split(";").filter(s => s.trim())) await db.execute(sql.raw(statement));
});
after(async () => { await (db as unknown as { $client: { close: () => Promise<void> } }).$client.close(); });
test('bound library includes all 14 images behind 250 unrelated assets, including descendants', async () => {
  const result=await loadAssetCatalog('author','database-world');
  assert.equal(result.total,14);assert.equal(result.assets.length,14);assert.equal(result.scope,'bound');
  assert.ok(result.assets.some(a=>a.folder==='SEVENTEEN/Portraits'));assert.match(formatAssetCatalog(result),/loaded=14\/14/);
});
test('paging/search and unbound access stay within the author, with literal queries', async () => {
  const first=await loadAssetCatalog('author','database-world',{scope:'all',limit:100});
  const next=await loadAssetCatalog('author','database-world',{scope:'all',limit:100,offset:100});
  assert.equal(first.total,264);assert.equal(first.hasMore,true);assert.equal(first.nextOffset,100);
  assert.equal(first.assets.some(a=>next.assets.some(b=>b.id===a.id)),false);
  assert.equal((await loadAssetCatalog('author','database-world',{scope:'all',query:'Member-'})).total,14);
  assert.equal((await loadAssetCatalog('author','database-world',{scope:'all',query:'%'})).total,0);
  assert.equal((await loadAssetCatalog('author','database-world',{scope:'all',offset:999})).total,264);
  await assert.rejects(loadAssetCatalog('other','database-world'));
  await assert.rejects(loadAssetCatalog('author','database-world',{folderId:'private'}));
  await assert.rejects(loadAssetCatalog('author','imported-schema-id'));
});
test('no binding falls back to the entire owned library; explicit bound scope stays empty', async () => {
  const all=await loadAssetCatalog('other','other-world'); assert.equal(all.total,1);assert.equal(all.scope,'all');
  assert.equal((await loadAssetCatalog('other','other-world',{scope:'bound'})).total,0);
  assert.deepEqual(descendantFolderIds([{id:'a',parentFolderId:'b'},{id:'b',parentFolderId:'a'}],['a']),['a','b']);
});
test('transactional social actions survive concurrent writes, duplicate retries and session reload', async () => {
  const config={profiles:[{id:'a',name:'A',handle:'a',avatar:'',loreEntryId:'a'}]};
  const initial=initialSocialState(config);
  const apply=(id:string)=>mutateSocialSession('s','author',initial,s=>applySocialAction(s,{type:'post',id,text:id},config,new Date().toISOString()));
  await Promise.all([apply('first'),apply('second'),apply('first')]);
  const reloaded=await mutateSocialSession('s','author',initial,s=>s);assert.equal(reloaded.posts.length,2);
  let claims=0;
  const claim=()=>mutateSocialSession('s','author',initial,s=>{
    const result=claimSocialJob(s,{jobId:'first',attempt:'retry-id'},1000);
    if(result.claimed)claims++;return result.state;
  });
  await Promise.all([claim(),claim(),claim()]);assert.equal(claims,1);
  assert.equal((await mutateSocialSession('s2','author',initial,s=>s)).posts.length,0);
  await assert.rejects(mutateSocialSession('s','other',initial,s=>s));
  const result=await db.execute(sql`SELECT state FROM play_sessions WHERE id='s'`);
  const raw=result.rows[0] as {state:{metadata:{keep:string},variables:{hp:number}}};assert.equal(raw.state.metadata.keep,'yes');assert.equal(raw.state.variables.hp,3);
});

test('same-session reset persists a fresh epoch even on an identity read, without changing other metadata', async () => {
  const config={profiles:[{id:'a',name:'A',handle:'a',avatar:'',loreEntryId:'a'}]};
  const initial=initialSocialState(config);
  const before=await mutateSocialSession('s2','author',initial,s=>s);
  assert.match(before.epoch,/^[0-9a-f-]{36}$/);
  assert.equal((await mutateSocialSession('s2','author',initial,s=>s)).epoch,before.epoch);
  await db.execute(sql`UPDATE play_sessions SET state='{"metadata":{"keep":"reset"},"variables":{"hp":9}}'::jsonb WHERE id='s2'`);
  const reset=await mutateSocialSession('s2','author',initial,s=>s);
  assert.notEqual(reset.epoch,before.epoch);
  assert.equal(reset.revision,0);
  assert.equal((await mutateSocialSession('s2','author',initial,s=>s)).epoch,reset.epoch);
  const result=await db.execute(sql`SELECT state FROM play_sessions WHERE id='s2'`);
  const raw=result.rows[0] as {state:{metadata:{keep:string},variables:{hp:number}}};
  assert.equal(raw.state.metadata.keep,'reset');assert.equal(raw.state.variables.hp,9);
});

test('restoring a saved running job re-epochs it and cannot commit an old provider completion', async () => {
  const config={profiles:[{id:'a',name:'A',handle:'a',avatar:'',loreEntryId:'a'}]};
  const initial=initialSocialState(config);
  const claimed=await mutateSocialSession('s2','author',initial,s=>{
    const posted=applySocialAction(s,{type:'post',id:'saved-post',text:'Checkpoint post'},config,new Date().toISOString());
    return claimSocialJob(posted,{jobId:'saved-post',attempt:'old-attempt'},1000).state;
  });
  const checkpoint={metadata:{keep:'checkpoint',social:claimed},variables:{hp:12}};
  const restored=renewSocialEpoch(checkpoint,crypto.randomUUID());
  await db.execute(sql`UPDATE play_sessions SET state=${JSON.stringify(restored)}::jsonb WHERE id='s2'`);
  const late=await mutateSocialSession('s2','author',initial,s=>s.epoch===claimed.epoch
    ? finishSocialJob(s,'saved-post','old-attempt',{messages:[{authorId:'a',text:'Must not appear'}]},new Date().toISOString()) : s);
  assert.notEqual(late.epoch,claimed.epoch);
  assert.deepEqual(late.posts.map(p=>p.text),['Checkpoint post']);
  assert.equal(late.jobs[0]!.status,'cancelled');
  assert.equal(checkpoint.metadata.social.jobs[0]!.status,'running');
});
