import { describe, it, expect } from "vitest";
import { initialSocialState, renewSocialEpoch, applySocialAction, claimSocialJob, finishSocialJob, socialJobContext, socialConfigSchema, type SocialState } from "../social/simulator.js";
const config = { profiles: ['a','b','c'].map(id => ({ id, name: id, handle: id, avatar: '', loreEntryId: id })) };
const now = '2026-09-05T00:00:00Z';
const apply = (s: SocialState, a: unknown) => applySocialAction(s, a, config, now);
describe('social simulation persistent event model', () => {
  it('renews restored social checkpoints without altering their saved history or ordinary card state', () => {
    const ordinary={metadata:{keep:'same'},variables:{hp:3}};
    expect(renewSocialEpoch(ordinary,'new')).toBe(ordinary);
    let social=apply(initialSocialState(config,'old'),{type:'post',id:'p',text:'Saved post'});
    social=claimSocialJob(social,{jobId:'p',attempt:'running'},1000).state;
    const checkpoint={...ordinary,metadata:{...ordinary.metadata,social}};
    const restored=renewSocialEpoch(checkpoint,'new');
    expect(restored.metadata.social.epoch).toBe('new');
    expect(restored.metadata.social.posts).toEqual(checkpoint.metadata.social.posts);
    expect(restored.metadata.keep).toBe('same');expect(restored.variables.hp).toBe(3);
    expect(restored.metadata.social.jobs[0]!.status).toBe('cancelled');
    expect(checkpoint.metadata.social.jobs[0]!.status).toBe('running');
    expect(finishSocialJob(restored.metadata.social,'p','running',{messages:[{authorId:'a',text:'Late old reply'}]},now)).toBe(restored.metadata.social);
  });
  it('budgets long private history by serialized size, retaining the latest complete trigger and newest messages', () => {
    let s=apply(initialSocialState(config),{type:'conversation',id:'dm',members:['a'],name:'A',channel:false});
    for(let i=0;i<30;i++) {
      s=apply(s,{type:'message',id:`m${i}`,conversationId:'dm',text:`${i}:`+'x'.repeat(1997)});
      s.jobs.at(-1)!.status='done';
    }
    const context=socialJobContext(s,s.jobs.at(-1)!);
    const messages=context.messages as Array<{authorId:string;text:string}>;
    expect(JSON.stringify(context).length).toBeLessThanOrEqual(25000);
    expect(messages.length).toBeGreaterThan(1);
    expect(messages.length).toBeLessThan(30);
    expect(messages.at(-1)!.text).toBe(s.conversations[0]!.messages.at(-1)!.text);
    expect(messages[0]!.text).toBe(s.conversations[0]!.messages.at(-messages.length)!.text);
    // Escaped JSON control characters consume more request space than raw text.
    s.conversations[0]!.messages.forEach(m=>{m.text='a'+'\u0001'.repeat(1999);});
    const escaped=socialJobContext(s,s.jobs.at(-1)!);
    expect(JSON.stringify(escaped).length).toBeLessThanOrEqual(25000);
    expect((escaped.messages as Array<{text:string}>).at(-1)!.text).toBe(s.conversations[0]!.messages.at(-1)!.text);
    expect(s.conversations[0]!.messages).toHaveLength(30);
  });
  it('claims one attempt, permits explicit stale recovery, and discards late or cancelled responses', () => {
    const start=apply(initialSocialState(config),{type:'post',id:'p',text:'Hello'});
    const one=claimSocialJob(start,{jobId:'p',attempt:'one'},1000);
    expect(one.claimed).toBe(true);
    expect(claimSocialJob(one.state,{jobId:'p',attempt:'one'},999999).claimed).toBe(false);
    expect(claimSocialJob(one.state,{jobId:'p',attempt:'two'},2000).claimed).toBe(false);
    const two=claimSocialJob(one.state,{jobId:'p',attempt:'two'},241001);
    expect(two.claimed).toBe(true);
    expect(finishSocialJob(two.state,'p','one',{messages:[{authorId:'a',text:'Late'}]},now)).toBe(two.state);
    const cancelled=claimSocialJob(two.state,{jobId:'p',attempt:'two',cancel:true},241002);
    expect(cancelled.claimed).toBe(false);
    expect(finishSocialJob(cancelled.state,'p','two',{messages:[{authorId:'a',text:'Cancelled'}]},now)).toBe(cancelled.state);
  });
  it('keeps send-ahead DM replies in order and includes earlier replies in subsequent context', () => {
    let s=apply(initialSocialState(config),{type:'conversation',id:'dm',members:['a'],name:'A',channel:false});
    s=apply(s,{type:'message',id:'m1',conversationId:'dm',text:'First'});
    s=apply(s,{type:'message',id:'m2',conversationId:'dm',text:'Second'});
    s.jobs[0]!.status='running';s.jobs[0]!.attempt='one';
    s=finishSocialJob(s,'m1','one',{messages:[{authorId:'a',text:'First reply'}]},now);
    expect(s.conversations[0]!.messages.map(m=>m.text)).toEqual(['First','First reply','Second']);
    expect(JSON.stringify(socialJobContext(s,s.jobs[1]!))).toContain('First reply');
  });
  it('rotates the responding cast instead of excluding members after the first three', () => {
    const large={profiles:Array.from({length:13},(_,i)=>({id:String(i),name:String(i),handle:String(i),avatar:'',loreEntryId:String(i)}))};
    let s=initialSocialState(large);
    for(let i=0;i<5;i++)s=applySocialAction(s,{type:'refresh',id:String(i)},large,now);
    expect(new Set(s.jobs.flatMap(j=>j.members)).size).toBe(13);
  });
  it('keeps posts, replies, likes, reposts and notifications through JSON reload without duplication', () => {
    let s = apply(initialSocialState(config), { type:'post', id:'p', text:'Hello' });
    s = apply(s, { type:'like', id:'l', postId:'p', value:true });
    s = apply(s, { type:'repost', id:'r', postId:'p', value:true });
    s.jobs[0]!.status='running'; s.jobs[0]!.attempt='one';
    s = finishSocialJob(s,'p','one',{messages:[{authorId:'a',text:'Hi'},{authorId:'b',text:'Welcome'},{authorId:'c',text:'Hello'}]},now);
    const reloaded = JSON.parse(JSON.stringify(s));
    expect(reloaded.posts).toHaveLength(4); expect(reloaded.notifications).toHaveLength(3);
    expect(reloaded.posts[0].likes).toEqual(['you']); expect(reloaded.posts[0].reposts).toEqual(['you']);
    expect(apply(reloaded,{type:'post',id:'p',text:'Hello'})).toEqual(reloaded);
    expect(finishSocialJob(reloaded,'p','one',{messages:[{authorId:'a',text:'Hi'}]},now)).toEqual(reloaded);
  });
  it('recalls saved public interactions in a DM without copying other private conversations', () => {
    let s=apply(initialSocialState(config),{type:'post',id:'cookies',text:'柠檬饼干叫小月亮'});
    s=claimSocialJob(s,{jobId:'cookies',attempt:'one'},1000).state;
    s=finishSocialJob(s,'cookies','one',{messages:s.jobs[0]!.members.map(authorId=>({authorId,text:authorId==='a'?'刚做完瑜伽，正在喝柠檬水。':'饼干很好吃。'}))},now);
    s=apply(s,{type:'conversation',id:'other-dm',members:['b'],name:'B',channel:false});
    s=apply(s,{type:'message',id:'secret',conversationId:'other-dm',text:'PRIVATE_OTHER_SECRET'});
    s=apply(s,{type:'conversation',id:'dm',members:['a'],name:'A',channel:false});
    s=apply(s,{type:'message',id:'recall',conversationId:'dm',text:'还记得我给饼干起的名字和你当时在做什么吗？'});
    const saved=JSON.parse(JSON.stringify(s));
    const context=JSON.stringify(socialJobContext(saved,saved.jobs.at(-1)!));
    expect(context).toContain('小月亮');
    expect(context).toContain('瑜伽');
    expect(context).toContain('柠檬水');
    expect(context).not.toContain('PRIVATE_OTHER_SECRET');
    expect(socialJobContext(saved,saved.jobs.at(-1)!).kind).toBe('private-message');
    expect(saved).toEqual(s);
  });
  it('keeps private continuity scoped to its character and separate from published posts', () => {
    let s=apply(initialSocialState(config),{type:'conversation',id:'dm1',members:['a'],name:'A',channel:false});
    s=apply(s,{type:'conversation',id:'dm2',members:['b'],name:'B',channel:false});
    s=apply(s,{type:'message',id:'m1',conversationId:'dm1',text:'PRIVATE_ONE'});
    s=apply(s,{type:'message',id:'m2',conversationId:'dm2',text:'PRIVATE_TWO'});
    s=apply(s,{type:'post',id:'post',text:'PUBLIC'});
    expect(JSON.stringify(socialJobContext(s,s.jobs[0]!))).not.toContain('PRIVATE_TWO');
    const context = socialJobContext(s,s.jobs[2]!);
    const memories = context.characterMemories as Array<{characterId:string;events:unknown[]}>;
    expect(JSON.stringify(memories.find(m => m.characterId === 'a'))).toContain('PRIVATE_ONE');
    expect(JSON.stringify(memories.find(m => m.characterId === 'a'))).not.toContain('PRIVATE_TWO');
    expect(JSON.stringify(context.post)).not.toContain('PRIVATE_');
    expect(s.posts).toHaveLength(1);
    expect(() => apply(s,{type:'message',id:'bad',conversationId:'missing',text:'x'})).toThrow();
  });
  it('rejects unauthorized AI speakers and cancels work when channel membership changes', () => {
    let s=apply(initialSocialState(config),{type:'conversation',id:'ch',members:['a'],name:'Channel',channel:true});
    s=apply(s,{type:'message',id:'m',conversationId:'ch',text:'Hi'});
    s.jobs[0]!.status='running';s.jobs[0]!.attempt='one';
    expect(() => finishSocialJob(s,'m','one',{messages:[{authorId:'b',text:'Spoof'}]},now)).toThrow();
    s=apply(s,{type:'members',id:'edit',conversationId:'ch',members:['b']});
    expect(s.jobs[0]!.status).toBe('cancelled');
    expect(finishSocialJob(s,'m','one',{messages:[{authorId:'a',text:'Late'}]},now)).toEqual(s);
  });
  it('does not overwrite input, mix sessions, mutate original state or accept invalid targets', () => {
    const first=initialSocialState(config), second=initialSocialState(config);
    const next=apply(first,{type:'post',id:'p',text:'Hi'});
    expect(first.posts).toEqual([]);expect(second.posts).toEqual([]);expect(next.posts).toHaveLength(1);
    expect(() => apply(first,{type:'post',id:'x',text:'x'.repeat(281)})).toThrow();
    expect(() => apply(first,{type:'conversation',id:'x',name:'Bad',members:['other'],channel:true})).toThrow();
    expect(() => apply(first,{type:'post',id:'x',parentId:'missing',text:'hi'})).toThrow();
  });
});

describe('social reply counts and saved-session compatibility', () => {
  const cast = { profiles: Array.from({ length: 8 }, (_, i) => ({ id: `member-${i}`, name: `Member ${i}`, handle: `member${i}`, avatar: '', loreEntryId: `lore-${i}` })) };
  const members = cast.profiles.map(p => p.id);
  const replies = (ids: string[]) => ({ messages: ids.map(authorId => ({ authorId, text: `Reply from ${authorId}` })) });

  it('preserves all optional reply counts when parsing a card and validates each count', () => {
    const replyCounts = { publicPost: 6, privateMessage: 1, channel: 5, timeline: 3 };
    expect(socialConfigSchema.parse({ ...cast, replyCounts })).toEqual({ ...cast, replyCounts });
    expect(socialConfigSchema.parse(cast)).toEqual(cast);
    for (const key of Object.keys(replyCounts)) {
      expect(socialConfigSchema.parse({ ...cast, replyCounts: { [key]: 2 } })).toEqual({ ...cast, replyCounts: { [key]: 2 } });
      for (const count of [0, -1, 1.5, '6', Number.MAX_SAFE_INTEGER + 1]) {
        expect(socialConfigSchema.safeParse({ ...cast, replyCounts: { [key]: count } }).success).toBe(false);
      }
    }
  });

  it('defaults new posts and group messages to six distinct speakers while timeline refreshes stay at three', () => {
    let s = applySocialAction(initialSocialState(cast), { type: 'post', id: 'p', text: 'Hello everyone' }, cast, now);
    s = applySocialAction(s, { type: 'conversation', id: 'group', members, name: 'Group', channel: true }, cast, now);
    s = applySocialAction(s, { type: 'message', id: 'm', conversationId: 'group', text: 'Hello group' }, cast, now);
    s = applySocialAction(s, { type: 'refresh', id: 'r' }, cast, now);
    expect(s.jobs.map(j => j.members.length)).toEqual([6, 6, 3]);
    for (const job of s.jobs) expect(new Set(job.members).size).toBe(job.members.length);
  });

  it('uses the corresponding card count for posts, private messages, channels and timeline', () => {
    const configured = { ...cast, replyCounts: { publicPost: 4, privateMessage: 2, channel: 5, timeline: 1 } };
    let s = applySocialAction(initialSocialState(configured), { type: 'post', id: 'p', text: 'Hello' }, configured, now);
    for (const channel of [false, true]) {
      const conversationId = channel ? 'group' : 'private';
      s = applySocialAction(s, { type: 'conversation', id: conversationId, members, name: conversationId, channel }, configured, now);
      s = applySocialAction(s, { type: 'message', id: `${conversationId}-m`, conversationId, text: 'Hello' }, configured, now);
    }
    s = applySocialAction(s, { type: 'refresh', id: 'r' }, configured, now);
    expect(s.jobs.map(j => j.members.length)).toEqual([4, 2, 5, 1]);
  });

  it('caps replies at selected or conversation members and keeps replies to a character directed to that character', () => {
    let s = applySocialAction(initialSocialState(cast), { type: 'setup', id: 'setup', members: members.slice(0, 2) }, cast, now);
    s = applySocialAction(s, { type: 'post', id: 'p', text: 'Hello two' }, cast, now);
    expect(new Set(s.jobs[0]!.members)).toEqual(new Set(members.slice(0, 2)));
    s = claimSocialJob(s, { jobId: 'p', attempt: 'one' }, 1000).state;
    s = finishSocialJob(s, 'p', 'one', replies(s.jobs[0]!.members), now);
    s = applySocialAction(s, { type: 'post', id: 'followup', parentId: 'p:ai:0', text: 'A reply just to you' }, cast, now);
    expect(s.jobs.at(-1)!.members).toEqual([s.posts.find(p => p.id === 'p:ai:0')!.authorId]);
    s = applySocialAction(s, { type: 'conversation', id: 'dm', members: [members[0]!], name: 'Direct', channel: false }, cast, now);
    s = applySocialAction(s, { type: 'message', id: 'dm-m', conversationId: 'dm', text: 'Hello one' }, cast, now);
    expect(s.jobs.at(-1)!.members).toEqual([members[0]]);
  });

  it('lets requested members stay silent on replies and comments, but not on a timeline refresh', () => {
    let s = applySocialAction(initialSocialState(cast), { type: 'post', id: 'p', text: 'Hello' }, cast, now);
    s = claimSocialJob(s, { jobId: 'p', attempt: 'one' }, 1000).state;
    const requested = s.jobs[0]!.members;
    // A comment thread where only two of six had something to say.
    const partial = finishSocialJob(s, 'p', 'one', replies(requested.slice(0, 2)), now);
    expect(partial.jobs[0]!.status).toBe('done');
    expect(partial.jobs[0]!.completedCount).toBe(6);
    expect(partial.jobs[0]!.persistedCount).toBe(2);
    expect(partial.posts.filter(p => p.parentId === 'p').map(p => p.authorId)).toEqual(requested.slice(0, 2));
    // Silence in a group chat keeps the reply anchored right after the trigger.
    let g = applySocialAction(partial, { type: 'conversation', id: 'g', members: members.slice(0, 3), name: 'Group', channel: false }, cast, now);
    g = applySocialAction(g, { type: 'message', id: 'm1', conversationId: 'g', text: 'Only asking one of you' }, cast, now);
    g = claimSocialJob(g, { jobId: 'm1', attempt: 'one' }, 1000).state;
    const speaker = g.jobs.at(-1)!.members[1]!;
    g = finishSocialJob(g, 'm1', 'one', replies([speaker]), now);
    expect(g.jobs.at(-1)!.status).toBe('done');
    expect(g.conversations[0]!.messages.map(m => m.authorId)).toEqual(['you', speaker]);
    // A timeline refresh still expects a post from everyone it asked.
    let r = applySocialAction(g, { type: 'refresh', id: 'r' }, cast, now);
    r = claimSocialJob(r, { jobId: 'r', attempt: 'one' }, 1000).state;
    const posters = r.jobs.at(-1)!.members;
    expect(posters.length).toBeGreaterThan(1);
    expect(() => finishSocialJob(r, 'r', 'one', replies(posters.slice(0, 1)), now)).toThrow();
    expect(finishSocialJob(r, 'r', 'one', replies(posters), now).jobs.at(-1)!.status).toBe('done');
  });

  it('rejects duplicate or empty speakers atomically and saves every reply the cast chose to give', () => {
    let s = applySocialAction(initialSocialState(cast), { type: 'post', id: 'p', text: 'Hello' }, cast, now);
    s = claimSocialJob(s, { jobId: 'p', attempt: 'one' }, 1000).state;
    const requested = s.jobs[0]!.members;
    expect(requested).toHaveLength(6);
    const before = structuredClone(s);
    expect(() => finishSocialJob(s, 'p', 'one', replies([...requested.slice(0, 5), requested[0]!]), now)).toThrow();
    expect(() => finishSocialJob(s, 'p', 'one', { messages: [] }, now)).toThrow();
    expect(s).toEqual(before);
    const finished = finishSocialJob(s, 'p', 'one', replies([...requested].reverse()), now);
    expect(finished.jobs[0]!.status).toBe('done');
    expect(finished.posts.filter(p => p.parentId === 'p')).toHaveLength(6);
    expect(new Set(finished.notifications.map(n => n.authorId))).toEqual(new Set(requested));
    expect(finishSocialJob(finished, 'p', 'one', replies(requested), now)).toBe(finished);
  });

  it.each(['queued', 'error', 'running'] as const)('keeps a stored three-person %s job intact while new actions use updated card counts', status => {
    const oldConfig = { ...cast, replyCounts: { publicPost: 3 } };
    let saved = applySocialAction(initialSocialState(oldConfig), { type: 'post', id: 'old', text: 'Before update' }, oldConfig, now);
    saved.jobs[0]!.status = status;
    if (status !== 'queued') {
      saved.jobs[0]!.attempt = 'old-attempt';
      saved.jobs[0]!.startedAt = 1000;
    }
    if (status === 'error') saved.jobs[0]!.error = 'Temporary provider error';
    saved = JSON.parse(JSON.stringify(saved));
    const history = structuredClone(saved.posts);
    const oldJob = structuredClone(saved.jobs[0]!);
    const updated = { ...cast, replyCounts: { publicPost: 6 } };
    const next = applySocialAction(saved, { type: 'post', id: 'new', text: 'After update in the same session' }, updated, now);
    expect(next.jobs[0]).toEqual(oldJob);
    expect(next.jobs[1]!.members).toHaveLength(6);
    expect(next.posts.slice(0, history.length)).toEqual(history);
    const claim = claimSocialJob(next, { jobId: 'old', attempt: 'retry' }, 241001);
    expect(claim.claimed).toBe(true);
    const finished = finishSocialJob(claim.state, 'old', 'retry', replies(oldJob.members), now);
    expect(finished.posts.filter(p => p.parentId === 'old')).toHaveLength(3);
    expect(finished.posts.slice(0, history.length)).toEqual(history);
    expect(finished.jobs[0]!.members).toEqual(oldJob.members);
    expect(finished.jobs[1]).toEqual(next.jobs[1]);
    expect(saved.posts).toEqual(history);
  });

  it('preserves completed three-reply history after a JSON reload and uses six for the next post', () => {
    const oldConfig = { ...cast, replyCounts: { publicPost: 3 } };
    let saved = applySocialAction(initialSocialState(oldConfig, 'saved-epoch'), { type: 'post', id: 'old', text: 'Already played' }, oldConfig, now);
    saved = claimSocialJob(saved, { jobId: 'old', attempt: 'one' }, 1000).state;
    saved = finishSocialJob(saved, 'old', 'one', replies(saved.jobs[0]!.members), now);
    saved = applySocialAction(saved, { type: 'read', id: 'read' }, oldConfig, now);
    saved = JSON.parse(JSON.stringify(saved));
    const next = applySocialAction(saved, { type: 'post', id: 'new', text: 'Continue playing' }, cast, now);
    expect(next.epoch).toBe('saved-epoch');
    expect(next.jobs[0]).toEqual(saved.jobs[0]);
    expect(next.posts.slice(0, saved.posts.length)).toEqual(saved.posts);
    expect(next.notifications).toEqual(saved.notifications);
    expect(next.posts.filter(p => p.parentId === 'old')).toHaveLength(3);
    expect(next.jobs[1]!.members).toHaveLength(6);
  });
});
