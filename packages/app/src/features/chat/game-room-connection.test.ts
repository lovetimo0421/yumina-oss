import test from "node:test";
import assert from "node:assert/strict";
import { GameRoomConnection } from "./game-room-connection";
import { activeReloadHolds } from "../../lib/reload-safety";

class Socket {
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: {data: string}) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  send(s: string) { this.sent.push(s); }
  close() { this.readyState = 3; this.onclose?.(); }
  frame(f: unknown) { this.onmessage?.({ data: JSON.stringify(f) }); }
}
const wait = () => new Promise(r => setImmediate(r));
const assignment = () => Response.json({ticket:"opaque",url:"wss://assigned.example/ws"});
test("failed or indefinitely slow ticket requests release reload holds", async () => {
  const failed = new GameRoomConnection(() => {}, {fetch: async () => new Response(null,{status:503})});
  assert.equal((await failed.join("pong-1")).reason,"unavailable");
  assert.deepEqual(activeReloadHolds(),[]);
  let signal: AbortSignal | null | undefined;
  const slow = new GameRoomConnection(() => {}, {joinTimeoutMs:10,fetch: async (_u,init) => {signal=init?.signal;return new Promise(()=>{});}});
  assert.equal((await slow.join("pong-1")).reason,"timeout");
  assert.equal(signal?.aborted,true);assert.deepEqual(activeReloadHolds(),[]);
});
test("cancelled joins cannot open a late socket", async () => {
  let finish!: (r: Response) => void,opened=0;
  const c=new GameRoomConnection(()=>{},{fetch:()=>new Promise(r=>{finish=r;}),socket:()=>{opened++;return new Socket() as unknown as WebSocket;}});
  const joining=c.join("pong-1");c.destroy();finish(assignment());
  assert.equal((await joining).reason,"cancelled");await wait();assert.equal(opened,0);assert.deepEqual(activeReloadHolds(),[]);
});
test("guest game uses shared identity and the assigned endpoint", async () => {
  const requests:Array<{url:string;body:any}>=[],s=new Socket();let endpoint="";
  const c=new GameRoomConnection(()=>{}, {
    fetch:async(u,init)=>{requests.push({url:String(u),body:JSON.parse(String(init?.body))});return requests.length===1?new Response(null,{status:401}):assignment();},
    guest:async()=>({guestId:"guest:abc",guestToken:"signed-guest",expiresAt:Date.now()+10000}),
    socket:url=>{endpoint=url;return s as unknown as WebSocket;},
  });
  const joining=c.join("pong-1");await wait();s.onopen?.();s.frame({t:"welcome",roomId:"pong-1",seatId:"p1",snap:{}});
  assert.equal((await joining).ok,true);assert.equal(endpoint,"wss://assigned.example/ws");
  assert.equal(requests[1]!.body.guestToken,"signed-guest");assert.match(requests[1]!.url,/guest-ticket$/);
  assert.equal(s.sent[0],JSON.stringify({t:"hello",ticket:"opaque"}));c.destroy();
});
test("close resolves pending commands and stale close cannot destroy replacement", async()=>{
  const sockets:Socket[]=[],frames:unknown[]=[];
  const c=new GameRoomConnection(f=>frames.push(f),{fetch:async()=>assignment(),socket:()=>{const s=new Socket();sockets.push(s);return s as unknown as WebSocket;}});
  let joining=c.join("pong-1");await wait();const old=sockets[0]!;old.frame({t:"welcome"});await joining;
  const staleClose=old.onclose,command=c.sendCommand("do");
  joining=c.join("pong-1");assert.equal((await command).ok,false);await wait();
  const next=sockets[1]!;next.frame({t:"welcome"});assert.equal((await joining).ok,true);
  staleClose?.();const nextCommand=c.sendCommand("do");assert.equal(next.sent.length,1);
  next.close();assert.equal((await nextCommand).ok,false);assert.deepEqual(activeReloadHolds(),[]);
  assert.deepEqual(frames.at(-1),{t:"status",state:"closed"});c.destroy();
});
test("unacknowledged command memory is bounded",async()=>{
  const s=new Socket(),c=new GameRoomConnection(()=>{},{fetch:async()=>assignment(),socket:()=>s as unknown as WebSocket});
  const joining=c.join("pong-1");await wait();s.frame({t:"welcome"});await joining;
  const pending=Array.from({length:64},()=>c.sendCommand("do"));
  assert.deepEqual(await c.sendCommand("do"),{ok:false,body:{reason:"busy"}});
  c.destroy();assert.equal((await Promise.all(pending)).every(r=>!r.ok),true);
});
