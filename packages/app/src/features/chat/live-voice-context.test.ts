import test from 'node:test';
import assert from 'node:assert/strict';
import { copyVoiceContext, isVoiceContext, voiceContextText } from '../../../sandbox/voice-context';
import { composeVoiceInstructions, voiceStartContextError } from '../../../sandbox/voice-types';
import { LiveVoiceContext, liveTextPackets } from './live-voice-context';

test('public snapshot validation keeps bounded text and stable unique IDs', () => {
  const context={state:{sight:'Resident visible.'},events:[{id:'event:1',text:'Paper was seen.'}]};
  assert.equal(isVoiceContext(context),true);
  assert.equal(voiceContextText(context),'Resident visible.\nPaper was seen.');
  assert.match(composeVoiceInstructions('Official.',context),/Resident visible\.\nPaper was seen\./);
  assert.equal(voiceStartContextError('x'.repeat(12000),context)?.includes('Combined'),true);
  for(const invalid of [null,[],{}, {state:[],events:[]}, {...context,private:'secret'},
    {...context,state:{sight:7}}, {...context,events:[...context.events,...context.events]},
    {...context,events:[{id:'bad id',text:'x'}]}, {...context,events:[{id:'a',text:'x',extra:true}]},
    {state:{sight:'x'.repeat(4000)},events:[{id:'a',text:'y'}]},
    {state:Object.fromEntries(Array.from({length:17},(_,i)=>['a'+i,'x'])),events:[]},
    {state:{},events:Array.from({length:65},(_,i)=>({id:'a'+i,text:'x'}))}
  ]) assert.equal(isVoiceContext(invalid),false,JSON.stringify(invalid).slice(0,100));
  const copy=copyVoiceContext(context);context.state.sight='Changed';context.events[0].text='Changed';
  assert.equal(voiceContextText(copy),'Resident visible.\nPaper was seen.');
});

test('deleted state is explicitly withdrawn while omitted history remains remembered',()=>{
  const ledger=new LiveVoiceContext({state:{sight:'In view.',clearance:'Cleared.'},events:[{id:'old',text:'Old testimony.'}]});
  ledger.offer({state:{sight:'In view.'},events:[]});
  assert.deepEqual(ledger.drain(),['Current clearance: no longer supplied; do not assume the previous value still applies.']);
  ledger.offer({state:{sight:'In view.'},events:[{id:'old',text:'Cited old testimony.'}]});
  assert.deepEqual(ledger.drain(),[]);
});

test('startup baseline preserves events seen during connection but omitted from its final budget',()=>{
  const ledger=new LiveVoiceContext({state:{sight:'A'},events:[{id:'initial',text:'Initial event.'}]});
  ledger.offer({state:{sight:'B'},events:[{id:'pending',text:'Pending event.'}]});
  ledger.setStartup({state:{sight:'B'},events:[]});
  ledger.offer({state:{sight:'A'},events:[]});
  assert.deepEqual(new Set(ledger.drain()),new Set(['A','Initial event.','Pending event.']));
  assert.deepEqual(ledger.drain(),[]);
});

test('a producer overflow fails explicitly instead of forgetting undelivered observations',()=>{
  const ledger=new LiveVoiceContext({state:{},events:[]});
  for(let i=0;i<256;i++)ledger.offer({state:{},events:[{id:String(i),text:'Observed.'}]});
  assert.throws(()=>ledger.offer({state:{},events:[{id:'overflow',text:'Observed.'}]}),/capacity/);
});

test('UTF-8 packet limits remain exact for unbroken tokens and invalid caps reject',()=>{
  const input='😀'.repeat(250)+'a'.repeat(1000);
  const chunks=liveTextPackets(input);
  assert.equal(chunks.join(''),input);
  for(const chunk of chunks)assert.ok(new TextEncoder().encode(chunk).length<=480);
  for(const cap of [0,1,3,4.5,Infinity])assert.throws(()=>liveTextPackets('a',cap),RangeError);
});
