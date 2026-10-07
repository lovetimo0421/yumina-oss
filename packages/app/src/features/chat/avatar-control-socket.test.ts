import assert from 'node:assert/strict';
import test from 'node:test';
import { AvatarControlSocket } from './avatar-control-socket';

function fixture() {
  const sockets: any[] = [], errors: string[] = [], events: unknown[] = [];
  const control = new AvatarControlSocket('wss://avatar.invalid/session', {
    create: () => { const s = { readyState: 1, bufferedAmount: 0, sent: [] as string[], send(v: string) { this.sent.push(v); }, close() { this.readyState = 3; } }; sockets.push(s); return s as unknown as WebSocket; },
    ready: () => events.push('ready'), event: v => events.push(v), fail: v => errors.push(v),
  }, { retryMs: 5, recoveryMs: 35 });
  control.start();
  const connected = () => sockets.at(-1).onmessage({ data: JSON.stringify({ type: 'session.state_updated', state: 'connected' }) });
  return { control, sockets, errors, events, connected };
}
test('same-session reconnect retains unsent audio and never replays sent audio', async t => {
  const f = fixture(); t.after(() => f.control.close()); f.connected();
  f.control.send({ type: 'agent.speak', audio: 'first' });
  f.sockets[0].onclose({ code: 1006 });
  f.control.send({ type: 'agent.speak', audio: 'second' });
  f.control.send({ type: 'agent.speak_end' });
  await new Promise(r => setTimeout(r, 10)); f.connected();
  assert.equal(f.sockets.length, 2);
  assert.deepEqual(f.sockets[1].sent.map((s: string) => JSON.parse(s)), [{ type: 'agent.speak', audio: 'second' }, { type: 'agent.speak_end' }]);
  assert.deepEqual(f.errors, []);
});
test('recovery is bounded and provider reason text never leaks to UI', async t => {
  const f = fixture(); t.after(() => f.control.close()); f.connected();
  f.sockets[0].onclose({ code: 1006, reason: 'secret-token' });
  await new Promise(r => setTimeout(r, 55));
  assert.equal(f.errors.length, 1); assert.match(f.errors[0], /1006/); assert.doesNotMatch(f.errors[0], /secret/);
});
test('stop cancels recovery; late callbacks cannot restart or emit events', async () => {
  const f = fixture(); f.connected(); const late = f.sockets[0].onmessage;
  f.sockets[0].onclose({ code: 1006 }); f.control.close();
  late({ data: JSON.stringify({ type: 'agent.speak_started' }) });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(f.sockets.length, 1); assert.deepEqual(f.events, ['ready']); assert.deepEqual(f.errors, []);
});
test('explicit interruption discards only unsent speech from the broken socket', async t => {
  const f = fixture(); t.after(() => f.control.close()); f.connected();
  f.sockets[0].onclose({ code: 1006 });
  f.control.send({ type: 'agent.speak', audio: 'abandoned' });
  f.control.send({ type: 'agent.speak_end' }); f.control.send({ type: 'agent.interrupt' });
  await new Promise(r => setTimeout(r, 10)); f.connected();
  assert.deepEqual(f.sockets[1].sent.map((s: string) => JSON.parse(s).type), ['agent.interrupt']);
});

test('ten seconds of held audio drains under the socket watermark in order', async t => {
  const f=fixture();t.after(()=>f.control.close());f.connected();const socket=f.sockets[0];
  socket.send=function(value:string){this.sent.push(value);this.bufferedAmount+=value.length;};
  for(let i=0;i<50;i++)f.control.send({type:'agent.speak',audio:'A'.repeat(12800),index:i});
  assert.deepEqual(f.errors,[]);assert.ok(socket.sent.length<50);
  for(let n=0;n<3;n++){socket.bufferedAmount=0;await new Promise(r=>setTimeout(r,35));}
  assert.deepEqual(socket.sent.map((s:string)=>JSON.parse(s).index),Array.from({length:50},(_,i)=>i));
  assert.deepEqual(f.errors,[]);
});

test('interrupt during backpressure abandons queued audio before the next drain', async t => {
  const f=fixture();t.after(()=>f.control.close());f.connected();const socket=f.sockets[0];
  socket.bufferedAmount=300*1024;
  f.control.send({type:'agent.speak',audio:'abandoned'});f.control.send({type:'agent.speak_end'});
  f.control.send({type:'agent.interrupt'});
  socket.bufferedAmount=0;await new Promise(r=>setTimeout(r,35));
  assert.deepEqual(socket.sent.map((s:string)=>JSON.parse(s).type),['agent.interrupt']);
  assert.deepEqual(f.errors,[]);
});
