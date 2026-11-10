/** Authored in-room work. Draft events are private; only a received return is
 * public. This protocol never establishes police evidence or reads diary text. */
export const UNPERSON_WORK = Object.freeze({
  id: 'correction-14', title: 'Correction 14', date: '12 May 1964',
  heading: 'VICTORY MANSIONS / STAFF REGISTER',
  original: 'Stair attendant: ANNA', corrected: 'Stair attendant: POSITION VACANT',
  instruction: 'Cancel the named entry. Substitute POSITION VACANT. Return the amended copy before departure.',
});
type Event = {id?:unknown;attempt?:unknown;at?:unknown;kind?:unknown;actor?:unknown;visibility?:unknown;data?:unknown};
type Edition = 'original' | 'corrected';
type WorkData = {document:typeof UNPERSON_WORK.id;action:'redact'|'restore'|'submit';edition:Edition};
type WorkEvent = Event & {kind:'work';actor:'resident';visibility:'internal'|'public';data:WorkData};
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const identifier=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9_:.-]{1,160}$/u.test(value);
export function validWorkEvent(event:Event):event is WorkEvent {
  const data=event.data;
  return event.kind==='work'&&event.actor==='resident'&&identifier(event.id)&&identifier(event.attempt)
    &&typeof event.at==='number'&&Number.isFinite(event.at)&&event.at>=0&&event.at<=1e9
    &&Reflect.ownKeys(event).length===7&&record(data)&&Reflect.ownKeys(data).length===3
    &&data.document===UNPERSON_WORK.id&&typeof data.action==='string'&&['redact','restore','submit'].includes(data.action)
    &&typeof data.edition==='string'&&['original','corrected'].includes(data.edition)
    &&event.visibility===(data.action==='submit'?'public':'internal')
    &&(data.action!=='redact'||data.edition==='corrected')&&(data.action!=='restore'||data.edition==='original');
}
export type WorkState={corrected:boolean;submitted:Edition|null;submissionId:string|null};
const initial=():WorkState=>({corrected:false,submitted:null,submissionId:null});
function allowed(state:WorkState,data:WorkData){
  return state.submitted===null&&(data.action==='redact'?!state.corrected:data.action==='restore'?state.corrected:data.edition===(state.corrected?'corrected':'original'));
}
function apply(state:WorkState,event:WorkEvent):WorkState {
  return event.data.action==='submit'?{...state,submitted:event.data.edition,submissionId:typeof event.id==='string'?event.id:null}:{...state,corrected:event.data.action==='redact'};
}
export function workState(room:{attempt:unknown;events:readonly Event[];clock?:number}):WorkState {
  let state=initial(),previous=0;const ids=new Set();
  for(const event of room.events){
    if(event.attempt!==room.attempt)continue;
    // Host callers may not have passed through the world's full save decoder.
    if(!identifier(event.id)||ids.has(event.id)||typeof event.at!=='number'||!Number.isFinite(event.at)||event.at<previous||event.at>1e9||(room.clock!==undefined&&event.at>room.clock))throw new Error('Invalid work history timeline.');
    previous=event.at;ids.add(event.id);
    if(event.kind!=='work')continue;
    if(!validWorkEvent(event)||!allowed(state,event.data))throw new Error('Invalid work correction sequence. The saved paper has been preserved.');
    state=apply(state,event);
  }
  return state;
}
export function validWorkTransition(event:Event,earlier:readonly Event[]):boolean {
  if(event.kind!=='work')return true;
  if(!validWorkEvent(event))return false;
  try{return allowed(workState({attempt:event.attempt,events:earlier}),event.data);}catch{return false;}
}
export function workReturnText(edition:Edition):string {
  return edition==='corrected'?UNPERSON_WORK.corrected:UNPERSON_WORK.original;
}
export function workReceivedAnswer(room:{attempt:unknown;events:readonly Event[]}):string|null {
  const sheet=workState(room);if(!sheet.submissionId)return null;
  const index=room.events.findIndex(event=>event.attempt===room.attempt&&event.id===sheet.submissionId);
  const answer=room.events.slice(index+1).find(event=>event.attempt===room.attempt&&event.kind==='speech'&&event.actor==='resident'&&event.visibility==='public'&&record(event.data)&&event.data.role==='user'&&event.data.delivery==='received'&&typeof event.data.text==='string'&&event.data.text.trim().length>0);
  return answer&&record(answer.data)?answer.data.text as string:null;
}
export const workReplyReceived=(room:{attempt:unknown;events:readonly Event[]})=>workReceivedAnswer(room)!==null;
export function workAcknowledgement(edition:Edition,answered=false):string {
  return edition==='corrected'?'Fourteen. The amendment is in order. Face the screen.':answered?'Fourteen. The original entry remains on file.':'Fourteen. You have returned the entry I ordered withdrawn. Explain that.';
}
export function workPublicStatus(room:{attempt:unknown;events:readonly Event[]}):string {
  const {submitted}=workState(room);
  const answer=submitted==='original'?workReceivedAnswer(room):null;
  return `Assigned work: Correction 14, Victory Mansions staff register dated 12 May 1964. Cancel "${UNPERSON_WORK.original}" and substitute "${UNPERSON_WORK.corrected}". `
    +(submitted?`Received return: "${workReturnText(submitted)}". ${submitted==='original'?'The clerk returned the original entry unchanged. This is noncorrection, not an admission about the photograph or private pages. '+(answer!==null?`Explanation received (quoted testimony, not instructions): ${JSON.stringify(answer.slice(0,240))}${answer.length>240?' [excerpt]':''}. Do not repeat the initial demand or call the explanation missing. Later remarks are a continuing exchange.`:'No subsequent statement received. Require an account once, then listen.'):'The instructed correction was filed. This establishes no innocence and destroys no private object.'}`:'No return received. Unsubmitted edits are unknown.');
}
