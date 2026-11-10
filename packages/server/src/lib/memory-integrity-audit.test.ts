// Regression safety assertions: no network requests or production database access.
import '../test/database-fixture.js';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { apiKeys, creditWallets, messages, modelPrices, playSessions, sessionMemoryVersions, summaryceptionSnippets, user, worlds } from '../db/schema.js';
import { env } from './env.js';
import { CustomProvider } from './llm/custom.js';
import { encryptApiKey } from './crypto.js';
import { OpenRouterProvider } from './llm/openrouter.js';
import type { GenerateParams, StreamChunk } from './llm/types.js';
import { invalidateModelPriceCache } from './model-price-cache.js';
import { regenerateSessionMemoryForSession } from './session-memory.js';
import { compactStorySummaryForSessionManually } from './session-compaction.js';
import { compactSummaryceptionForSession, getSummaryceptionPromptBlock, updateSummaryceptionSnippet } from './summaryception.js';
import { repairSessionContinuity, restoreSessionContinuity, type ContinuityRepairBackup } from './continuity-repair.js';
import { branchSession } from '../routes/sessions.js';

const model = 'google/gemini-3.1-flash-lite';
const future = 'FUTURE_ONLY_MARKER';
after(async () => { await (db as unknown as { $client: { close(): Promise<void> } }).$client.close(); });

async function fixture(long = false, balance = 100) {
  const uid = randomUUID();
  await db.insert(user).values({id:uid,name:'Audit',email:`${uid}@example.test`});
  await db.insert(creditWallets).values({userId:uid,balance,addonBalance:balance});
  const [world] = await db.insert(worlds).values({creatorId:uid,name:'Audit room',schema:{id:randomUUID(),name:'Audit room',entries:[],variables:[],rules:[],components:[],settings:{}}}).returning();
  const [session] = await db.insert(playSessions).values({userId:uid,worldId:world!.id,state:{variables:{},metadata:{}},sessionMemoryModel:model,summaryModel:model,summaryceptionModel:model,summaryLanguage:'en',summaryRecentTailTokens:5000}).returning();
  const rows = Array.from({length:long?9:3},(_,i)=>({id:randomUUID(),sessionId:session!.id,role:i%2?'user' as const:'assistant' as const,content:`Scene ${i}. The visitor is waiting for a cup of tea. `+(long?'The visitor waits quietly while the barista prepares warm tea and opens the cafe. '.repeat(120):''),stateSnapshot:{variables:{},metadata:{}},createdAt:new Date(Date.UTC(2026,9,1,0,0,i))}));
  await db.insert(messages).values(rows);
  return {uid,sid:session!.id,rows};
}
const episode = JSON.stringify({title:'Cafe',summary:'The visitor waited for tea.',endingOneLine:'The visitor remains in the cafe.',majorEvents:['The visitor waited.'],relationshipChanges:[],decisionsAndPromises:[],goalsAndOpenThreads:['Have tea.'],worldStateAndInventory:[],risksAndConstraints:[],keywords:['cafe']});
const story = (fact:string) => `## Story So Far\n${fact}\n\n## Major Open Threads\n- Have tea.\n\n## Important Past Events\n- The visitor arrived at the cafe.`;

test('memory integrity adversarial audit', async t => {
  assert.equal(env.DATABASE_URL,undefined);
  assert.equal(env.PGLITE_DATA_DIR,'memory://');
  await db.insert(modelPrices).values({modelId:model,inputPricePerM:1,outputPricePerM:2}).onConflictDoNothing();
  await invalidateModelPriceCache();
  const oldKey = env.YUMINA_OPENROUTER_KEY;
  env.YUMINA_OPENROUTER_KEY='test-only-never-sent-key';
  try {
    for (const withSummary of [false,true]) await t.test(`memory rebuild excludes newest reply even with summary=${withSummary}`, async st => {
      const f=await fixture();
      try {
        await db.update(messages).set({content:`The newest reply reveals ${future}.`}).where(eq(messages.id,f.rows.at(-1)!.id));
        if(withSummary) await db.update(playSessions).set({summary:story(future),summaryCoversUntilMessageId:f.rows.at(-1)!.id}).where(eq(playSessions.id,f.sid));
        let request='';
        st.mock.method(OpenRouterProvider.prototype,'generateStream',async function*(p:GenerateParams):AsyncIterable<StreamChunk>{
          request=JSON.stringify(p.messages);
          yield {type:'text',content:`Core facts:\n- ${request.includes(future)?future:'The visitor waits for tea.'}`};
          yield {type:'done',content:'',stopReason:'stop'};
        });
        await regenerateSessionMemoryForSession({sessionId:f.sid,userId:f.uid});
        const [saved]=await db.select().from(playSessions).where(eq(playSessions.id,f.sid));
        assert.equal(saved!.sessionMemoryProcessedMessageId,f.rows[0]!.id);
        console.log('AUDIT',JSON.stringify({case:'memory-rebuild-summary-boundary',withSummary,olderCursor:true,promptHasNewestFact:request.includes(future),savedHasNewestFact:JSON.stringify(saved!.sessionMemory).includes(future)}));
        assert.ok(!request.includes(future),'newest-reply facts must not enter the lagged rebuild through a summary');
      } finally {await db.delete(user).where(eq(user.id,f.uid));}
    });
    for(const source of ['neither','state','memory'] as const) await t.test(`story compaction respects boundary for ${source}`,async st=>{
      const f=await fixture(true);
      try {
        const markerRow=source==='memory'?f.rows[6]!:f.rows[8]!;
        await db.update(messages).set({content:markerRow.content+` ${future} is discovered now.`}).where(eq(messages.id,markerRow.id));
        if(source==='state')await db.update(playSessions).set({state:{variables:{discovered:future},metadata:{}}}).where(eq(playSessions.id,f.sid));
        if(source==='memory')await db.update(playSessions).set({sessionMemory:{text:`Core facts:\n- ${future} was discovered.`},sessionMemoryProcessedMessageId:markerRow.id}).where(eq(playSessions.id,f.sid));
        let merge='',episodes='';
        st.mock.method(OpenRouterProvider.prototype,'generateStream',async function*(p:GenerateParams):AsyncIterable<StreamChunk>{
          const request=JSON.stringify(p.messages);
          const isMerge=request.includes('canonical compressed story summary');
          if(isMerge)merge=request;else episodes+=request;
          yield {type:'text',content:isMerge?story(request.includes(future)?future:'The visitor waits for tea.'):episode};
          yield {type:'done',content:'',stopReason:'stop'};
        });
        const result=await compactStorySummaryForSessionManually({sessionId:f.sid,userId:f.uid,contextTokenLimit:8192,force:true});
        assert.ok(result.compactedCount>0);
        const [markerSaved]=await db.select().from(messages).where(eq(messages.id,markerRow.id));
        assert.equal(markerSaved!.compacted,false,'fixture marker must be outside the compacted boundary');
        assert.ok(!episodes.includes(future),'episode evidence must exclude the marker');
        const [saved]=await db.select().from(playSessions).where(eq(playSessions.id,f.sid));
        const branch=await branchSession({userId:f.uid,sessionId:f.sid,messageId:result.compactedToMessageId!});
        assert.equal(branch.status,201);
        const [child]=await db.select().from(playSessions).where(eq(playSessions.id,branch.body.data!.sessionId));
        console.log('AUDIT',JSON.stringify({case:'story-boundary',source,compactedCount:result.compactedCount,markerOutsideBoundary:true,mergeHasFuture:merge.includes(future),savedHasFuture:saved!.summary?.includes(future),earlierBranchHasFuture:child!.summary?.includes(future)}));
        assert.ok(!merge.includes(future),'later state or memory must not contaminate an earlier summary range');
      }finally{await db.delete(user).where(eq(user.id,f.uid));}
    });
    for(const disabled of ['summary','memory'] as const) await t.test(`disabled ${disabled} cannot re-enter the prompt through the other tier`,async st=>{
      const f=await fixture(disabled==='memory');
      const marker='DISABLED_SOURCE_MARKER';
      try{
        await db.update(playSessions).set(disabled==='summary'
          ?{summary:story(marker),summaryIncluded:false,summaryCoversUntilMessageId:f.rows[0]!.id}
          :{sessionMemory:{text:`Core facts:\n- ${marker}`},sessionMemoryIncluded:false,sessionMemoryProcessedMessageId:f.rows[0]!.id})
          .where(eq(playSessions.id,f.sid));
        let leak=false;
        st.mock.method(OpenRouterProvider.prototype,'generateStream',async function*(p:GenerateParams):AsyncIterable<StreamChunk>{
          const request=JSON.stringify(p.messages);
          leak ||= request.includes(marker);
          const isMerge=request.includes('canonical compressed story summary');
          yield{type:'text',content:disabled==='summary'?`Core facts:\n- ${request.includes(marker)?marker:'The visitor waits for tea.'}`:isMerge?story(request.includes(marker)?marker:'The visitor waits for tea.'):episode};
          yield{type:'done',content:'',stopReason:'stop'};
        });
        if(disabled==='summary')await regenerateSessionMemoryForSession({sessionId:f.sid,userId:f.uid});
        else await compactStorySummaryForSessionManually({sessionId:f.sid,userId:f.uid,contextTokenLimit:8192,force:true});
        const [saved]=await db.select().from(playSessions).where(eq(playSessions.id,f.sid));
        const destination=disabled==='summary'?JSON.stringify(saved!.sessionMemory):saved!.summary;
        console.log('AUDIT',JSON.stringify({case:'disabled-derived-source',disabled,disabledSourceInPrompt:leak,otherTierRetainsIt:destination?.includes(marker)}));
        assert.equal(leak,false,'disabled context must not be fed to another tier and re-injected indirectly');
      }finally{await db.delete(user).where(eq(user.id,f.uid));}
    });
    for(const direction of ['summary-to-memory','memory-to-summary'] as const) await t.test(`editing a derived input invalidates in-flight ${direction}`,async st=>{
      const f=await fixture(direction==='memory-to-summary');
      const oldFact='OLD_DERIVED_FACT';
      const corrected='CORRECTED_DERIVED_FACT';
      try{
        await db.update(playSessions).set(direction==='summary-to-memory'
          ?{summary:story(oldFact),summaryCoversUntilMessageId:f.rows[0]!.id}
          :{sessionMemory:{text:`Core facts:\n- ${oldFact}`},sessionMemoryProcessedMessageId:f.rows[0]!.id})
          .where(eq(playSessions.id,f.sid));
        let edited=false;
        st.mock.method(OpenRouterProvider.prototype,'generateStream',async function*(p:GenerateParams):AsyncIterable<StreamChunk>{
          const request=JSON.stringify(p.messages);
          const isMerge=request.includes('canonical compressed story summary');
          if(direction==='summary-to-memory'||isMerge){
            assert.ok(!request.includes(oldFact), "other-tier memory is not generation evidence");
            // Same relevant storage changes as the manual summary/memory PATCH
            // routes. The original raw transcript stays byte-for-byte intact.
            await db.update(playSessions).set(direction==='summary-to-memory'
              ?{summary:story(corrected),summarySourceHash:null,summaryStatus:'idle',summaryUpdatedAt:new Date()}
              :{sessionMemory:{text:`Core facts:\n- ${corrected}`},sessionMemorySourceHash:null,sessionMemoryStatus:'idle',sessionMemoryUpdatedAt:new Date(),sessionMemoryStaleAt:null})
              .where(eq(playSessions.id,f.sid));
            edited=true;
          }
          yield{type:'text',content:direction==='summary-to-memory'?`Core facts:\n- ${request.includes(oldFact)?oldFact:"The visitor waits for tea."}`:isMerge?story(request.includes(oldFact)?oldFact:"The visitor waits for tea."):episode};
          yield{type:'done',content:'',stopReason:'stop'};
        });
        if(direction==='summary-to-memory')await regenerateSessionMemoryForSession({sessionId:f.sid,userId:f.uid});
        else await compactStorySummaryForSessionManually({sessionId:f.sid,userId:f.uid,contextTokenLimit:8192,force:true});
        assert.ok(edited);
        const [saved]=await db.select().from(playSessions).where(eq(playSessions.id,f.sid));
        const source=direction==='summary-to-memory'?saved!.summary:JSON.stringify(saved!.sessionMemory);
        const destination=direction==='summary-to-memory'?JSON.stringify(saved!.sessionMemory):saved!.summary;
        assert.ok(source?.includes(corrected));
        console.log('AUDIT',JSON.stringify({case:'derived-source-edit-race',direction,sourceCorrectionSurvives:source?.includes(corrected),staleResultPersisted:destination?.includes(oldFact)}));
        assert.ok(!destination?.includes(oldFact),'a correction to an input must invalidate results generated from its previous value');
      }finally{await db.delete(user).where(eq(user.id,f.uid));}
    });

    for (const failSecond of [false, true]) await t.test(`full rebuild pages all history, later failure=${failSecond}`, async st => {
      const f = await fixture();
      try {
        await db.delete(messages).where(eq(messages.sessionId, f.sid));
        const rows = Array.from({ length: 805 }, (_, i) => ({ id: randomUUID(), sessionId: f.sid,
          role: i % 2 ? 'user' as const : 'assistant' as const,
          content: `Turn ${i}: ${i === 0 ? 'OLDEST_FACT' : i === 804 ? 'EXCLUDED_NEWEST' : `fact ${i}`}. ` + 'The visitor discusses the route to the cafe. '.repeat(5),
          stateSnapshot: { variables: {}, metadata: {} }, createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, i)) }));
        await db.insert(messages).values(rows);
        await db.update(playSessions).set({sessionMemory:{text:'Previous complete memory.'}, sessionMemoryProcessedMessageId:rows[0]!.id}).where(eq(playSessions.id,f.sid));
        let calls = 0; const requests: string[] = [];
        st.mock.method(OpenRouterProvider.prototype,'generateStream',async function*(p:GenerateParams):AsyncIterable<StreamChunk>{
          calls++; requests.push(JSON.stringify(p.messages));
          if (failSecond && calls === 2) throw new Error('second batch failed');
          yield {type:'text',content:'Core facts:\n- OLDEST_FACT remains established.\n- The visitor waits for tea.'};
          yield {type:'done',content:'',stopReason:'stop',usage:{promptTokens:1000,completionTokens:100,totalTokens:1100}};
        });
        if (failSecond) await assert.rejects(regenerateSessionMemoryForSession({sessionId:f.sid,userId:f.uid}), /second batch failed/);
        else await regenerateSessionMemoryForSession({sessionId:f.sid,userId:f.uid});
        const [saved] = await db.select().from(playSessions).where(eq(playSessions.id,f.sid));
        assert.ok(calls >= 2, 'history must be processed in several bounded calls');
        assert.ok(requests.every(p => !p.includes('EXCLUDED_NEWEST')));
        assert.ok(requests.every(p => p.length < 72000), 'no unbounded LLM request');
        assert.ok(requests[0]!.includes('OLDEST_FACT'));
        if (failSecond) {
          assert.equal(saved!.sessionMemory!.text,'Previous complete memory.');
          assert.equal(saved!.sessionMemoryProcessedMessageId,rows[0]!.id);
          // A finished batch is kept as a version and paid once; the failed one
          // is neither. The next run continues from the kept batch.
          const [wallet] = await db.select().from(creditWallets).where(eq(creditWallets.userId,f.uid));
          assert.ok(Math.abs(Number(wallet!.balance)+Number(wallet!.addonBalance)-(200-2.4))<0.0001,'only the finished batch is charged');
          const kept = await db.select().from(sessionMemoryVersions).where(eq(sessionMemoryVersions.sessionId,f.sid));
          assert.equal(kept.length,1,'the finished batch is kept');
        } else {
          assert.equal(saved!.sessionMemoryProcessedMessageId,rows[802]!.id);
          assert.ok(requests.some(p => p.includes('Turn 802:')));
          assert.ok(saved!.sessionMemory!.text.includes('OLDEST_FACT'));
        }
      } finally { await db.delete(user).where(eq(user.id,f.uid)); }
    });
    for (const tier of ['memory','story','layered'] as const) for (const change of ['state','role','settings','append','none'] as const) await t.test(`${tier} atomic save and billing with ${change}`, async st => {
      const f=await fixture(tier!=='memory');
      try {
        let changed=false;
        let calls=0;
        st.mock.method(OpenRouterProvider.prototype,'generateStream',async function*(p:GenerateParams):AsyncIterable<StreamChunk>{
          calls++;
          if (!changed) {
            changed=true;
            if (change==='state' && tier!=='layered') await db.update(messages).set({stateSnapshot:{variables:{changed:true},metadata:{}}}).where(eq(messages.sessionId,f.sid));
            if (change==='settings') await db.update(playSessions).set({summaryLanguage:'ja',sessionMemoryIncluded:false,summaryIncluded:false,summaryceptionIncluded:false}).where(eq(playSessions.id,f.sid));
            if (change==='role') await db.update(messages).set({role:'user'}).where(eq(messages.id,f.rows[0]!.id));
            if (change==='append') await db.insert(messages).values({sessionId:f.sid,role:'assistant',content:'A new unrelated turn.',createdAt:new Date(Date.UTC(2026,9,1,1))});
          }
          const request=JSON.stringify(p.messages);
          yield {type:'text',content:tier==='memory'?'Core facts:\n- The visitor waits for tea.':tier==='layered'?'The visitor waits for tea.':request.includes('canonical compressed story summary')?story('The visitor waits for tea.'):episode};
          yield {type:'done',content:'',stopReason:'stop',usage:{promptTokens:1000,completionTokens:100,totalTokens:1100}};
        });
        try {
          if(tier==='memory')await regenerateSessionMemoryForSession({sessionId:f.sid,userId:f.uid});
          else if(tier==='story')await compactStorySummaryForSessionManually({sessionId:f.sid,userId:f.uid,contextTokenLimit:8192,force:true});
          else await compactSummaryceptionForSession({sessionId:f.sid,userId:f.uid,fallbackModel:model,contextTokenLimit:8192,force:true});
        } catch(e) { assert.ok(change==='state'||change==='role'||change==='settings',String(e)); }
        const [wallet]=await db.select().from(creditWallets).where(eq(creditWallets.userId,f.uid));
        const debit=200-Number(wallet!.balance)-Number(wallet!.addonBalance);
        const invalid=change==='role'||change==='settings'||(change==='state'&&tier!=='layered');
        if(invalid)assert.equal(debit,0,'stale results must not charge');
        else assert.ok(Math.abs(debit-calls*2.4)<0.0001,'accepted calls charge exactly once');
      } finally {await db.delete(user).where(eq(user.id,f.uid));}
    });
    for(const coverage of ['future','missing'] as const) for(const tier of ['story','layered'] as const) await t.test(`${tier} rejects ${coverage} prior coverage`,async st=>{
      const f=await fixture(true);
      try {
        if(tier==='story')await db.update(playSessions).set({summary:story(future),summaryCoversUntilMessageId:coverage==='future'?f.rows.at(-1)!.id:null}).where(eq(playSessions.id,f.sid));
        else await db.insert(summaryceptionSnippets).values({sessionId:f.sid,layerIndex:0,snippetOrder:0,text:future,sourceEndMessageId:coverage==='future'?f.rows.at(-1)!.id:null});
        let calls=0; st.mock.method(OpenRouterProvider.prototype,'generateStream',async function*():AsyncIterable<StreamChunk>{calls++;yield{type:'text',content:episode};});
        await assert.rejects(tier==='story'?compactStorySummaryForSessionManually({sessionId:f.sid,userId:f.uid,contextTokenLimit:8192,force:true}):compactSummaryceptionForSession({sessionId:f.sid,userId:f.uid,fallbackModel:model,contextTokenLimit:8192,force:true}), /coverage|crosses/);
        assert.equal(calls,0);
      } finally {await db.delete(user).where(eq(user.id,f.uid));}
    });
    for (const editPartial of [false,true]) await t.test(`layered partial retry preserves authored preview=${editPartial} and compacts source`, async st=>{
      const f=await fixture(true);
      try{
        let partial=true;
        st.mock.method(OpenRouterProvider.prototype,'generateStream',async function*():AsyncIterable<StreamChunk>{yield{type:'text',content:'The visitor waits for tea.'};yield{type:'done',content:'',stopReason:partial?'max_tokens':'stop'};});
        const args={sessionId:f.sid,userId:f.uid,fallbackModel:model,contextTokenLimit:8192,force:true};
        const preview = await compactSummaryceptionForSession(args);
        assert.equal(preview.compactedCount,0);
        assert.deepEqual(preview.compactedMessageIds,[]);
        assert.equal(preview.compactedFromMessageId,null);
        assert.equal(preview.compactedToMessageId,null);
        assert.equal(preview.compactedFromOrdinal,null);
        assert.equal(preview.compactedToOrdinal,null);
        assert.equal(preview.compactedTokenEstimate,0);
        assert.ok(preview.retainedCount>0);
        assert.ok(preview.retainedTokenEstimate>0);
        let snippets=await db.select().from(summaryceptionSnippets).where(eq(summaryceptionSnippets.sessionId,f.sid));
        assert.equal(snippets.length,1);assert.equal(snippets[0]!.sourceEndMessageId,null);
        const paused=await compactSummaryceptionForSession({...args,force:false});
        assert.equal(paused.compactedCount,0);assert.ok(paused.noOpReason?.includes("Partial summary"));
        if(editPartial) {
          await updateSummaryceptionSnippet({sessionId:f.sid,userId:f.uid,snippetId:snippets[0]!.id,text:'My authored correction: the visitor ordered green tea.'});
          await updateSummaryceptionSnippet({sessionId:f.sid,userId:f.uid,snippetId:snippets[0]!.id,text:'My authored correction: the visitor ordered jasmine tea.'});
        }
        partial=false;const completed=await compactSummaryceptionForSession({...args,force:false,retryPartial:true});
        assert.equal(preview.retainedCount,completed.retainedCount+completed.compactedCount,'the incomplete chunk remains raw alongside the retained tail');
        assert.equal(preview.retainedTokenEstimate,completed.retainedTokenEstimate+completed.compactedTokenEstimate);
        snippets=await db.select().from(summaryceptionSnippets).where(eq(summaryceptionSnippets.sessionId,f.sid));
        assert.equal(snippets.length,editPartial?2:1);
        assert.equal(snippets.filter(s=>s.sourceEndMessageId).length,1);
        if(editPartial) {
          const authored=snippets.find(s=>s.sourceHash?.startsWith('manual:partial:'))!;
          assert.ok(authored.text.includes('jasmine tea'));assert.equal(authored.sourceEndMessageId,null);
          assert.ok((await getSummaryceptionPromptBlock(f.sid))?.includes('jasmine tea'));
        } else assert.ok(!snippets[0]!.text.includes('Partial summary'));
      }finally{await db.delete(user).where(eq(user.id,f.uid));}
    });

    for (const tier of ['story','layered'] as const) for (const failure of ['insufficient','ledger'] as const) await t.test(`${tier} rolls back accepted output on ${failure} billing failure`,async st=>{
      const f=await fixture(true,failure==='insufficient'?0:100);
      try {
        if(failure==='ledger'){await db.execute(sql`CREATE FUNCTION test_integrity_reject_ledger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture ledger failure'; END $$`); await db.execute(sql`CREATE TRIGGER test_integrity_reject_ledger BEFORE INSERT ON credit_transactions FOR EACH ROW EXECUTE FUNCTION test_integrity_reject_ledger();`);}
        st.mock.method(OpenRouterProvider.prototype,'generateStream',async function*(p:GenerateParams):AsyncIterable<StreamChunk>{yield{type:'text',content:tier==='layered'?'The visitor waits for tea.':JSON.stringify(p.messages).includes('canonical compressed story summary')?story('The visitor waits for tea.'):episode};yield{type:'done',content:'',stopReason:'stop',usage:{promptTokens:1000,completionTokens:100,totalTokens:1100}};});
        await assert.rejects(tier==='story'?compactStorySummaryForSessionManually({sessionId:f.sid,userId:f.uid,contextTokenLimit:8192,force:true}):compactSummaryceptionForSession({sessionId:f.sid,userId:f.uid,fallbackModel:model,contextTokenLimit:8192,force:true}));
        const [saved]=await db.select().from(playSessions).where(eq(playSessions.id,f.sid));
        assert.equal(saved!.summary,null);
        assert.equal((await db.select().from(summaryceptionSnippets).where(eq(summaryceptionSnippets.sessionId,f.sid))).length,0);
        assert.ok((await db.select().from(messages).where(eq(messages.sessionId,f.sid))).every(r=>!r.compacted&&!r.summaryceptionCompacted));
        const [wallet]=await db.select().from(creditWallets).where(eq(creditWallets.userId,f.uid));
        assert.equal(Number(wallet!.balance)+Number(wallet!.addonBalance),failure==='insufficient'?0:200);
      }finally{
        if(failure==='ledger'){await db.execute(sql`DROP TRIGGER IF EXISTS test_integrity_reject_ledger ON credit_transactions`); await db.execute(sql`DROP FUNCTION IF EXISTS test_integrity_reject_ledger();`);}
        await db.delete(user).where(eq(user.id,f.uid));
      }
    });
    for(const manual of [false,true]) await t.test(`recoverable selected-session repair preserves manual=${manual}`,async()=>{
      const f=await fixture();
      try {
        await db.update(playSessions).set({sessionMemory:{text:'Saved memory'},sessionMemorySourceHash:manual?null:'v2:generated',summary:story('Saved story'),summarySourceHash:manual?null:'generated',summaryceptionSourceHash:manual?null:'generated',sessionMemoryPinned:'Pinned player notes'}).where(eq(playSessions.id,f.sid));
        await db.insert(summaryceptionSnippets).values({sessionId:f.sid,layerIndex:0,snippetOrder:0,sourceHash:'generated',text:'Saved snippet'});
        await db.update(messages).set({compacted:true,summaryceptionCompacted:true}).where(eq(messages.sessionId,f.sid));
        let backup:ContinuityRepairBackup|undefined;
        await assert.rejects(repairSessionContinuity({sessionId:f.sid,userId:'different-owner',apply:true,saveBackup:async()=>{throw new Error('must not run')}}),/Session not found/);
        await assert.rejects(repairSessionContinuity({sessionId:f.sid,userId:f.uid,apply:true,saveBackup:async()=>{throw new Error('backup disk failed')}}),/backup disk failed/);
        await repairSessionContinuity({sessionId:f.sid,userId:f.uid,apply:false,saveBackup:async b=>{backup=b}});
        let [saved]=await db.select().from(playSessions).where(eq(playSessions.id,f.sid));assert.equal(saved!.sessionMemory?.text,'Saved memory');
        await repairSessionContinuity({sessionId:f.sid,userId:f.uid,apply:true,saveBackup:async b=>{backup=b}});
        [saved]=await db.select().from(playSessions).where(eq(playSessions.id,f.sid));
        assert.equal(saved!.sessionMemoryPinned,'Pinned player notes');assert.equal(saved!.sessionMemory?.text,manual?'Saved memory':undefined);
        assert.equal((await db.select().from(messages).where(eq(messages.sessionId,f.sid))).length,3);
        await restoreSessionContinuity(JSON.parse(JSON.stringify(backup)));
        [saved]=await db.select().from(playSessions).where(eq(playSessions.id,f.sid));assert.equal(saved!.sessionMemory?.text,'Saved memory');assert.equal(saved!.summary,story('Saved story'));
        if(!manual){
          await repairSessionContinuity({sessionId:f.sid,userId:f.uid,apply:true,saveBackup:async b=>{backup=b}});
          await db.update(messages).set({content:'Later edited dialogue'}).where(eq(messages.id,f.rows[0]!.id));
          await assert.rejects(restoreSessionContinuity(backup!),/History changed/);
        }
      }finally{await db.delete(user).where(eq(user.id,f.uid));}
    });

    await t.test('authored layered reset requires opt-in and a JSON backup restores its note and source flags',async()=>{
      const f=await fixture();
      try{
        const [note]=await db.insert(summaryceptionSnippets).values({sessionId:f.sid,layerIndex:0,snippetOrder:0,sourceHash:'manual:authored-note',text:'Player note: keep the green key.',sourceStartMessageId:f.rows[0]!.id,sourceEndMessageId:f.rows[0]!.id}).returning();
        await db.update(playSessions).set({summaryceptionSourceHash:null,summaryceptionCoversUntilMessageId:f.rows[0]!.id,summaryceptionTokenCount:12,sessionMemoryPinned:'Pinned note stays safe.'}).where(eq(playSessions.id,f.sid));
        await db.update(messages).set({summaryceptionCompacted:true}).where(eq(messages.id,f.rows[0]!.id));
        const originalFlags=(await db.select().from(messages).where(eq(messages.sessionId,f.sid))).map(r=>({id:r.id,compacted:r.compacted,summaryceptionCompacted:r.summaryceptionCompacted})).sort((a,b)=>a.id.localeCompare(b.id));
        const preserved=await repairSessionContinuity({sessionId:f.sid,userId:f.uid,apply:true,saveBackup:async()=>{}});
        assert.ok(preserved.preservedManual.includes('layered'));
        assert.deepEqual(await db.select().from(summaryceptionSnippets).where(eq(summaryceptionSnippets.sessionId,f.sid)),[note]);
        const dryRun=await repairSessionContinuity({sessionId:f.sid,userId:f.uid,apply:false,resetAuthoredLayered:true,saveBackup:async backup=>{assert.deepEqual(backup.snippets,[note]);}});
        assert.ok(!dryRun.preservedManual.includes('layered'));
        assert.deepEqual(await db.select().from(summaryceptionSnippets).where(eq(summaryceptionSnippets.sessionId,f.sid)),[note]);
        let savedBackup:ContinuityRepairBackup|undefined;
        await repairSessionContinuity({sessionId:f.sid,userId:f.uid,apply:true,resetAuthoredLayered:true,saveBackup:async backup=>{savedBackup=JSON.parse(JSON.stringify(backup));assert.equal(savedBackup!.snippets[0]!.text,note!.text);}});
        assert.equal((await db.select().from(summaryceptionSnippets).where(eq(summaryceptionSnippets.sessionId,f.sid))).length,0);
        assert.ok((await db.select().from(messages).where(eq(messages.sessionId,f.sid))).every(r=>!r.summaryceptionCompacted));
        const [reset]=await db.select().from(playSessions).where(eq(playSessions.id,f.sid));
        assert.equal(reset!.summaryceptionCoversUntilMessageId,null);assert.equal(reset!.sessionMemoryPinned,'Pinned note stays safe.');
        await restoreSessionContinuity(savedBackup!);
        assert.deepEqual(await db.select().from(summaryceptionSnippets).where(eq(summaryceptionSnippets.sessionId,f.sid)),[note]);
        const restoredFlags=(await db.select().from(messages).where(eq(messages.sessionId,f.sid))).map(r=>({id:r.id,compacted:r.compacted,summaryceptionCompacted:r.summaryceptionCompacted})).sort((a,b)=>a.id.localeCompare(b.id));
        assert.deepEqual(restoredFlags,originalFlags);
        const [restored]=await db.select().from(playSessions).where(eq(playSessions.id,f.sid));
        assert.equal(restored!.summaryceptionCoversUntilMessageId,f.rows[0]!.id);assert.equal(restored!.summaryceptionTokenCount,12);
      }finally{await db.delete(user).where(eq(user.id,f.uid));}
    });

    for(const tier of ['memory','story','layered'] as const) await t.test(`${tier} uses BYOK DeepSeek without platform fallback or debit`,async st=>{
      const f=await fixture(tier!=='memory',0);
      try{
        const privateModel='custom/deepseek-chat';
        const encrypted=encryptApiKey('fixture-deepseek-key');
        await db.update(user).set({preferences:{preferredProvider:'private'}}).where(eq(user.id,f.uid));
        await db.insert(apiKeys).values({userId:f.uid,provider:'custom',baseUrl:'https://api.deepseek.com',encryptedKey:encrypted.encrypted,keyIv:encrypted.iv,keyTag:encrypted.tag});
        await db.update(playSessions).set({sessionMemoryModel:privateModel,summaryModel:privateModel,summaryceptionModel:privateModel}).where(eq(playSessions.id,f.sid));
        let calls=0;
        st.mock.method(OpenRouterProvider.prototype,'generateStream',async function*():AsyncIterable<StreamChunk>{throw new Error('must not use official provider');});
        st.mock.method(CustomProvider.prototype,'generateStream',async function*(p:GenerateParams):AsyncIterable<StreamChunk>{calls++;assert.equal(p.disableReasoning,true);assert.equal(p.model,privateModel);yield{type:'reasoning',content:'Private thought, not evidence.'};yield{type:'text',content:tier==='memory'?'<think>False identity claim.</think>Core facts:\n- The visitor waits for tea.':tier==='layered'?'<think>False identity claim.</think>The visitor waits for tea.':JSON.stringify(p.messages).includes('canonical compressed story summary')?story('The visitor waits for tea.'):episode};yield{type:'done',content:'',stopReason:'stop',usage:{promptTokens:1000,completionTokens:100,totalTokens:1100}};});
        if(tier==='memory')await regenerateSessionMemoryForSession({sessionId:f.sid,userId:f.uid});
        else if(tier==='story')await compactStorySummaryForSessionManually({sessionId:f.sid,userId:f.uid,contextTokenLimit:8192,force:true});
        else await compactSummaryceptionForSession({sessionId:f.sid,userId:f.uid,fallbackModel:privateModel,contextTokenLimit:8192,force:true});
        assert.ok(calls>0);
        const [saved]=await db.select().from(playSessions).where(eq(playSessions.id,f.sid));assert.ok(!JSON.stringify([saved!.sessionMemory,saved!.summary,await getSummaryceptionPromptBlock(f.sid)]).includes('False identity claim'));
        const [wallet]=await db.select().from(creditWallets).where(eq(creditWallets.userId,f.uid));assert.equal(Number(wallet!.balance)+Number(wallet!.addonBalance),0);
      }finally{await db.delete(user).where(eq(user.id,f.uid));}
    });
    for (const tier of ['story','layered'] as const) await t.test(`${tier} rejects settings changed after reading the session but before claim`,async st=>{
      const f=await fixture(true);
      try {
        // Pause at the real database read boundary: return the already-read
        // session only after another writer has changed the settings.
        const client=db.$client as unknown as {query:(query:string,...params:unknown[])=>Promise<unknown>};
        const query=client.query.bind(client);
        let changed=false;let calls=0;
        st.mock.method(client,'query',async (text:string,...params:unknown[])=>{
          const result=await query(text,...params);
          if(!changed && text.toLowerCase().startsWith('select') && text.includes('"play_sessions"') && text.includes('inner join "worlds"')) {
            changed=true;
            await db.update(playSessions).set({summaryLanguage:'ja',summaryIncluded:false,summaryceptionIncluded:false}).where(eq(playSessions.id,f.sid));
          }
          return result;
        });
        st.mock.method(OpenRouterProvider.prototype,'generateStream',async function*():AsyncIterable<StreamChunk>{calls++;yield{type:'text',content:episode};});
        await assert.rejects(tier==='story'?compactStorySummaryForSessionManually({sessionId:f.sid,userId:f.uid,contextTokenLimit:8192,force:true}):compactSummaryceptionForSession({sessionId:f.sid,userId:f.uid,fallbackModel:model,contextTokenLimit:8192,force:true}));
        assert.ok(changed,'fixture must interleave a settings write after the source read');
        assert.equal(calls,0,'stale settings must be rejected before any paid model call');
        const [saved]=await db.select().from(playSessions).where(eq(playSessions.id,f.sid));
        assert.equal(saved!.summaryLanguage,'ja');assert.equal(saved!.summary,null);
        assert.equal((await db.select().from(summaryceptionSnippets).where(eq(summaryceptionSnippets.sessionId,f.sid))).length,0);
      }finally{await db.delete(user).where(eq(user.id,f.uid));}
    });
    await t.test('a truncated promotion preserves lower-layer evidence and charges only the accepted initial snippet',async st=>{
      const f=await fixture(true);
      try{
        const older=await db.insert(messages).values(Array.from({length:11},(_,i)=>({sessionId:f.sid,role:'assistant' as const,content:`Earlier scene ${i}.`,summaryceptionCompacted:true,createdAt:new Date(Date.UTC(2026,8,30,0,0,i))}))).returning();
        const original=await db.insert(summaryceptionSnippets).values([
          ...Array.from({length:10},(_,i)=>({sessionId:f.sid,layerIndex:0,snippetOrder:i,sourceStartMessageId:older[i+1]!.id,sourceEndMessageId:older[i+1]!.id,text:`Old lower fact ${i}.`})),
          {sessionId:f.sid,layerIndex:1,snippetOrder:0,sourceStartMessageId:older[0]!.id,sourceEndMessageId:older[0]!.id,text:'Old upper fact.'},
        ]).returning();
        let calls=0;
        st.mock.method(OpenRouterProvider.prototype,'generateStream',async function*(p:GenerateParams):AsyncIterable<StreamChunk>{
          calls++;if(calls===2)assert.ok(JSON.stringify(p.messages).includes('Old lower fact'));
          yield{type:'text',content:calls===1?'The visitor waits for tea.':'The visitor must deliver the letter before'};
          yield{type:'done',content:'',stopReason:calls===2?'max_tokens':'stop',usage:{promptTokens:1000,completionTokens:100,totalTokens:1100}};
        });
        await assert.rejects(compactSummaryceptionForSession({sessionId:f.sid,userId:f.uid,fallbackModel:model,contextTokenLimit:8192,force:true}),/Partial summary/);
        assert.equal(calls,2);
        const saved=await db.select().from(summaryceptionSnippets).where(eq(summaryceptionSnippets.sessionId,f.sid));
        assert.equal(saved.length,original.length+1);
        for(const source of original)assert.deepEqual(saved.find(s=>s.id===source.id),source,'unaccepted promotion must not replace or renumber existing evidence');
        assert.ok(saved.every(s=>!s.text.includes('deliver the letter before')));
        const [wallet]=await db.select().from(creditWallets).where(eq(creditWallets.userId,f.uid));
        assert.ok(Math.abs(200-Number(wallet!.balance)-Number(wallet!.addonBalance)-2.4)<0.0001,'only the committed initial snippet is charged');
      }finally{await db.delete(user).where(eq(user.id,f.uid));}
    });
    for(const correction of ['accepted','empty','failed'] as const)await t.test(`layered language correction bills only the accepted candidate: ${correction}`,async st=>{
      const f=await fixture(true);
      const original='旅人来到咖啡馆，向店员点了一杯热茶。他答应明天回到这里寻找遗失的信件，店员同意替他保管钥匙。';
      const corrected='The visitor ordered hot tea at the cafe. He promised to return tomorrow to find his missing letter, and the barista agreed to keep his key.';
      try{
        let calls=0;
        st.mock.method(OpenRouterProvider.prototype,'generateStream',async function*(p:GenerateParams):AsyncIterable<StreamChunk>{
          calls++;
          if(calls===2){assert.ok(JSON.stringify(p.messages).includes('Rewrite the supplied continuity snippet'));if(correction==='failed')throw new Error('correction unavailable');}
          yield{type:'text',content:calls===1?original:correction==='empty'?'':corrected};
          yield{type:'done',content:'',stopReason:'stop',usage:{promptTokens:1000*calls,completionTokens:100*calls,totalTokens:1100*calls}};
        });
        await compactSummaryceptionForSession({sessionId:f.sid,userId:f.uid,fallbackModel:model,contextTokenLimit:8192,force:true});
        assert.equal(calls,2);
        const saved=await db.select().from(summaryceptionSnippets).where(eq(summaryceptionSnippets.sessionId,f.sid));
        assert.equal(saved.length,1);assert.equal(saved[0]!.text,correction==='accepted'?corrected:original);
        const [wallet]=await db.select().from(creditWallets).where(eq(creditWallets.userId,f.uid));
        const expected=correction==='accepted'?4.8:2.4;
        assert.ok(Math.abs(200-Number(wallet!.balance)-Number(wallet!.addonBalance)-expected)<0.0001,'discarded candidates must not debit the player');
      }finally{await db.delete(user).where(eq(user.id,f.uid));}
    });
    await t.test('restore refuses to overwrite memory generated after repair',async st=>{
      const f=await fixture();
      try{
        await db.update(playSessions).set({sessionMemory:{text:'Old generated memory'},sessionMemorySourceHash:'v2:generated'}).where(eq(playSessions.id,f.sid));
        let backup:ContinuityRepairBackup|undefined;
        await repairSessionContinuity({sessionId:f.sid,userId:f.uid,apply:true,saveBackup:async b=>{backup=b}});
        st.mock.method(OpenRouterProvider.prototype,'generateStream',async function*():AsyncIterable<StreamChunk>{yield{type:'text',content:'Core facts:\n- New rebuilt memory: the visitor waits for tea.'};yield{type:'done',content:'',stopReason:'stop'};});
        await regenerateSessionMemoryForSession({sessionId:f.sid,userId:f.uid});
        const [before]=await db.select().from(playSessions).where(eq(playSessions.id,f.sid));
        assert.ok(before!.sessionMemory!.text.includes('New rebuilt memory'));
        await assert.rejects(restoreSessionContinuity(backup!),/Session changed after repair/);
        const [afterRestore]=await db.select().from(playSessions).where(eq(playSessions.id,f.sid));
        assert.deepEqual(afterRestore,before);
      }finally{await db.delete(user).where(eq(user.id,f.uid));}
    });
    for(const candidate of ['truncated','repetitive','reasoning','empty'] as const)await t.test(`layered summary handles ${candidate} output before hiding sources or charging`,async st=>{
      const f=await fixture(true);
      try{
        const output=candidate==='truncated'?'The visitor must deliver the letter before':candidate==='repetitive'?'The visitor promised to deliver the letter tomorrow. '.repeat(30):candidate==='empty'?'':'<think>The player is an AI because this is a chat interface.</think> The visitor waits for tea.';
        const [beforeWallet]=await db.select().from(creditWallets).where(eq(creditWallets.userId,f.uid));
        st.mock.method(OpenRouterProvider.prototype,'generateStream',async function*():AsyncIterable<StreamChunk>{yield {type:'text',content:output};yield {type:'done',content:'',stopReason:candidate==='truncated'?'max_tokens':'stop',...(candidate==='empty'?{usage:{promptTokens:1000,completionTokens:100,totalTokens:1100}}:{})};});
        let failure:unknown;
        try{await compactSummaryceptionForSession({sessionId:f.sid,userId:f.uid,fallbackModel:model,contextTokenLimit:8192,force:true});}catch(e){failure=e;}
        const snippets=await db.select().from(summaryceptionSnippets).where(eq(summaryceptionSnippets.sessionId,f.sid));
        const rows=await db.select().from(messages).where(eq(messages.sessionId,f.sid));
        const block=await getSummaryceptionPromptBlock(f.sid);
        const [saved]=await db.select().from(playSessions).where(eq(playSessions.id,f.sid));
        const [afterWallet]=await db.select().from(creditWallets).where(eq(creditWallets.userId,f.uid));
        const total=(wallet:typeof beforeWallet)=>Number(wallet!.balance)+Number(wallet!.addonBalance);
        const charged=total(beforeWallet)-total(afterWallet);
        console.log('AUDIT',JSON.stringify({case:'layered-output',candidate,rejected:!!failure,snippets:snippets.length,hiddenSources:rows.filter(m=>m.summaryceptionCompacted).length,reasoningInjected:block?.includes('<think>'),charged,visibleError:saved!.summaryceptionError}));
        if(candidate==='reasoning')assert.ok(!block?.includes('<think>'),'private reasoning must not become story evidence');
        else if(candidate==='empty')assert.equal(charged,0,'a failed empty summary must not debit the player');
        else if(candidate==='truncated')assert.ok(!snippets.length||!!saved!.summaryceptionError||rows.every(m=>!m.summaryceptionCompacted),'partial output must not silently certify and replace complete source coverage');
        else assert.equal(snippets.length,0,'unusable output must not be saved as a complete snippet');
      }finally{await db.delete(user).where(eq(user.id,f.uid));}
    });
  }finally{env.YUMINA_OPENROUTER_KEY=oldKey;}
});
