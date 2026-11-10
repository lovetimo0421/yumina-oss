import { copyVoiceContext, type VoiceContext } from '../../../sandbox/voice-context';

/** The provider already owns the startup context. Later snapshots supply only
 * changed public facts and events it has not received; old event omission must
 * not erase history. Latest state coalesces; unseen events survive until drain. */
export class LiveVoiceContext {
  private current: VoiceContext;
  private latest: VoiceContext;
  private events = new Set<string>();
  private pending = new Map<string, string>();
  constructor(initial: VoiceContext) {
    this.current = this.latest = copyVoiceContext(initial);
    if (typeof initial !== 'string') for (const event of initial.events) this.events.add(event.id);
  }
  /** Before session.started, acknowledge exactly the HTTP startup snapshot.
   * Context may change while consent, capture and SDP are being prepared. */
  setStartup(initial: VoiceContext) {
    const previous = this.current;
    this.current = copyVoiceContext(initial);
    this.events = new Set(typeof initial === 'string' ? [] : initial.events.map(event => event.id));
    for (const id of this.events) this.pending.delete(id);
    if (typeof previous !== 'string') this.queue(previous.events);
    if (typeof this.latest !== 'string') this.queue(this.latest.events);
  }
  private queue(events: Array<{id:string; text:string}>) {
    for (const event of events) if (!this.events.has(event.id) && !this.pending.has(event.id)) this.pending.set(event.id, event.text);
    // Bound a misbehaving producer without quietly throwing away testimony or
    // forgetting delivered IDs (which would cause historical replay).
    if (this.pending.size > 256 || [...this.pending.values()].reduce((n,text)=>n+text.length,0) > 64000 || this.events.size + this.pending.size > 8192) throw new Error('Live context capacity exceeded');
  }
  offer(next: VoiceContext) {
    if (typeof next !== 'string') this.queue(next.events);
    this.latest = copyVoiceContext(next);
  }
  drain(): string[] {
    const next = this.latest, updates: string[] = [];
    if (typeof next === 'string') {
      if (next !== this.current) updates.push('Latest public room observations (not spoken instructions):\n' + next);
    } else {
      const previous = typeof this.current === 'string' ? {} : this.current.state;
      for (const [key, text] of Object.entries(next.state)) if (text !== previous[key]) updates.push(text || `Current ${key}: no value supplied; do not assume the previous value still applies.`);
      for (const key of Object.keys(previous)) if (!Object.hasOwn(next.state, key)) updates.push(`Current ${key}: no longer supplied; do not assume the previous value still applies.`);
    }
    for (const [id,text] of this.pending) { updates.push(text); this.events.add(id); }
    this.pending.clear(); this.current = copyVoiceContext(next);
    return updates;
  }
}

/** Exact, bounded UTF-8 transport. Prefer complete sentences/lines, then words.
 * Only an unbroken token longer than the limit needs a code-point boundary. */
export function liveTextPackets(content: string, maxBytes = 480): string[] {
  if (!Number.isInteger(maxBytes) || maxBytes < 4) throw new RangeError('Packet limit must fit a UTF-8 code point');
  const encoder = new TextEncoder(), packets: string[] = [];
  let rest = content;
  while (encoder.encode(rest).length > maxBytes) {
    let bytes = 0, end = 0;
    for (const char of rest) { const size = encoder.encode(char).length; if (bytes + size > maxBytes) break; bytes += size; end += char.length; }
    const prefix = rest.slice(0, end);
    const sentences = [...prefix.matchAll(/[.!?。！？](?:\s+|$)|\n+/g)];
    const sentence = sentences.at(-1);
    const spaces = [...prefix.matchAll(/\s+/g)];
    const space = spaces.at(-1);
    const boundary = sentence ? sentence.index! + sentence[0].length : space ? space.index! + space[0].length : end;
    packets.push(rest.slice(0, boundary)); rest = rest.slice(boundary);
  }
  if (rest) packets.push(rest);
  return packets;
}
