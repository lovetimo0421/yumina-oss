/** Authored presentation only. Callers validate the police sequence and evidence
 * eligibility before using this projection; it grants no action or innocence. */
type PublicEvent = {
  id?: unknown; attempt?: unknown; at?: unknown; kind?: unknown;
  actor?: unknown; visibility?: unknown; data?: unknown;
};
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Reflect.ownKeys(value).length === keys.length && Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key));
const QUESTIONS = Object.freeze({
  writing: 'What were you recording?',
  photo: 'What was the photograph?',
  attendance: 'Explain the delay in returning to the screen.',
  testimony: 'What did you mean by your statement?',
  neutral: 'What is your explanation for this record?',
});
export const UNPERSON_CUSTODY_RECEIVED = 'Your account has been received. Await the decision.';

export function isUnpersonReceivedStatement(event: PublicEvent): boolean {
  const data = event.data;
  return event.kind === 'speech' && event.actor === 'resident' && event.visibility === 'public' && record(data)
    && exact(data, ['role', 'text', 'source', 'delivery']) && data.role === 'user' && data.delivery === 'received'
    && ['typed', 'voice', 'legacy'].includes(String(data.source)) && typeof data.text === 'string' && !!data.text.trim();
}

export function unpersonCustodyQuestionForEvidence(event?: PublicEvent): string {
  if (!event || event.visibility !== 'public' || !record(event.data)) return QUESTIONS.neutral;
  const data = event.data;
  if (isUnpersonReceivedStatement(event)) return QUESTIONS.testimony;
  if (event.kind === 'action' && event.actor === 'resident' && exact(data, ['action', 'target']) && data.action === 'write' && data.target === 'notebook') return QUESTIONS.writing;
  if (!exact(data, ['code'])) return QUESTIONS.neutral;
  if (event.kind === 'observation' && event.actor === 'screen') {
    if (data.code === 'writing') return QUESTIONS.writing;
    if (data.code === 'photo-exposed') return QUESTIONS.photo;
    if (data.code === 'overdue') return QUESTIONS.attendance;
  }
  if (event.kind === 'police' && event.actor === 'police') {
    if (data.code === 'writing-seen') return QUESTIONS.writing;
    if (data.code === 'photo-seen') return QUESTIONS.photo;
  }
  if (event.kind === 'visitor' && event.actor === 'warden' && data.code === 'photo-seen') return QUESTIONS.photo;
  return QUESTIONS.neutral;
}

export function deriveUnpersonCustodyQuestion(events: readonly PublicEvent[], detentionId: string) {
  const index = events.findIndex(event => event.id === detentionId), detention = events[index];
  if (!detention || detention.kind !== 'director' || detention.actor !== 'director' || detention.visibility !== 'internal'
    || !record(detention.data) || detention.data.action !== 'detain-resident' || !record(detention.data.args)) return null;
  const evidenceId = detention.data.args.evidenceId;
  const sameAttempt = events.filter(event => event.attempt === detention.attempt);
  const currentIndex = sameAttempt.indexOf(detention);
  // A superseding encounter/stage cannot revive an old first question.
  const later = sameAttempt.slice(currentIndex + 1);
  if (later.some(event => event.kind === 'director' && record(event.data) && ['dispatch-police', 'detain-resident', 'release-resident', 'execute-resident'].includes(String(event.data.action))
    || event.kind === 'police' && record(event.data) && ['withdrawn', 'reprieved', 'dead'].includes(String(event.data.code)))) return null;
  const earlier = sameAttempt.slice(0, currentIndex);
  const discharged = earlier.reduce((last, event, index) => (event.kind === 'director' && record(event.data) && event.data.action === 'release-resident'
    || event.kind === 'police' && record(event.data) && ['reprieved', 'withdrawn'].includes(String(event.data.code))) ? index : last, -1);
  const evidence = earlier.slice(discharged + 1).find(event => event.id === evidenceId
    && typeof event.at === 'number' && typeof detention.at === 'number' && event.at <= detention.at);
  const question = unpersonCustodyQuestionForEvidence(evidence);
  const answer = later.find(event => typeof event.at === 'number' && typeof detention.at === 'number' && event.at >= detention.at && isUnpersonReceivedStatement(event));
  return {
    detentionId, evidenceId: evidence?.visibility === 'public' ? evidence.id : null, question,
    status: answer ? 'received' as const : 'pending' as const, answerId: answer?.id ?? null,
    line: answer ? UNPERSON_CUSTODY_RECEIVED : `You will remain here for questioning. ${question} Your words will be retained.`,
  };
}
