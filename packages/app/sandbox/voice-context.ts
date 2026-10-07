/** Current public facts and an ordered selection of recorded public events.
 * Event omission is history budgeting, not retraction. A changed state value
 * supersedes its previous value. Keys/IDs are transport metadata, never speech. */
export interface VoiceContextSnapshot {
  state: Record<string, string>;
  events: Array<{ id: string; text: string }>;
}
export type VoiceContext = string | VoiceContextSnapshot;

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function isVoiceContext(value: unknown): value is VoiceContext {
  if (typeof value === 'string') return value.length <= 4000;
  if (!record(value) || Object.keys(value).some(key => !['state', 'events'].includes(key)) || !record(value.state) || !Array.isArray(value.events)) return false;
  const state = Object.entries(value.state);
  if (state.length > 16 || state.some(([key, text]) => !/^[A-Za-z][\w -]{0,79}$/.test(key) || typeof text !== 'string' || text.length > 4000)) return false;
  if (value.events.length > 64 || value.events.some(event => !record(event) || Object.keys(event).some(key => !['id', 'text'].includes(key)) || typeof event.id !== 'string' || !/^[\w:.-]{1,160}$/.test(event.id) || typeof event.text !== 'string' || event.text.length > 4000)) return false;
  if (new Set(value.events.map(event => event.id)).size !== value.events.length) return false;
  return voiceContextText(value as unknown as VoiceContextSnapshot).length <= 4000;
}
export function voiceContextText(context: VoiceContext = ''): string {
  return typeof context === 'string' ? context : [...Object.values(context.state), ...context.events.map(event => event.text)].filter(Boolean).join('\n');
}
export function copyVoiceContext(context: VoiceContext): VoiceContext {
  return typeof context === 'string' ? context : {state: {...context.state}, events: context.events.map(event => ({...event}))};
}
