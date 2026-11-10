import assert from "node:assert/strict";
import test from "node:test";
import { hydrateVoiceSceneNotice } from "./voice-scene-notice";
import * as sceneAuthority from "./voice-scene-notice";
import { formatVoiceSceneReaction } from "../../../sandbox/voice-types";

const speech = { id: "speech:1", attempt: "attempt-1", at: 2, kind: "speech", actor: "resident", visibility: "public", data: { role: "user", text: "I knew his name.", delivery: "received", source: "voice" } };
const follow = { id: "follow:1", attempt: "attempt-1", at: 5, kind: "director", actor: "director", visibility: "internal", data: { action: "follow-up", args: { evidenceId: "speech:1", line: "Who told you that name?" }, phase: "conceal" } };
const variables = (events: unknown[] = [speech, follow]) => ({ "unperson-room": { version: 1, attempt: "attempt-1", clock: 6, events }, "unperson-state": { phase: "conceal" } });
const request = { id: "follow:1", kind: "follow-up" };

test('a fresh photographed object produces one short host-owned cue without exposing private data', () => {
  const photo = { id: 'photo:1', attempt: 'attempt-1', at: 5, kind: 'observation', actor: 'screen', visibility: 'public', data: { code: 'photo-exposed' } };
  const reference = { id: photo.id, kind: 'bulletin' };
  const current = { ...variables([photo]), 'unperson-private-life': { entries: ['PRIVATE_DIARY'], notebook: 'held' }, 'unperson-state': { phase: 'conceal', photo: 'vent' } };
  const notice = hydrateVoiceSceneNotice(reference, current);
  assert.deepEqual(notice, { ...reference, text: '6079. Show me that photograph.' });
  assert.doesNotMatch(JSON.stringify(notice), /PRIVATE_DIARY|vent|held/);
  for (const patch of [{ visibility: 'internal' }, { actor: 'resident' }, { data: { code: 'photo-exposed', text: 'PRIVATE_DIARY' } }, { at: 7 }, { at: -1 }]) assert.equal(hydrateVoiceSceneNotice(reference, variables([{ ...photo, ...patch }])), null);
  assert.equal(hydrateVoiceSceneNotice({ ...reference, text: 'Invented demand.' }, current), null);
});

test('photo cues expire, defer to newer dialogue and police, and have a twelve-second sighting cooldown', () => {
  const photo = { id: 'photo:1', attempt: 'attempt-1', at: 5, kind: 'observation', actor: 'screen', visibility: 'public', data: { code: 'photo-exposed' } };
  const reference = { id: photo.id, kind: 'bulletin' };
  let current = variables([photo]);
  const notice = hydrateVoiceSceneNotice(reference, current, [], undefined, () => current); assert.ok(notice);
  const authorized = sceneAuthority.voiceSceneAuthority(notice); assert.equal(authorized?.(), true);
  current = variables([photo, { ...speech, id: 'own-caption', at: 6, actor: 'screen', data: { role: 'assistant', text: '6079. Show me that photograph.', source: 'voice', delivery: 'generated' } }]);
  assert.equal(authorized?.(), false, 'Newer dialogue still supersedes a queued cue');
  assert.equal(authorized?.(true), true, 'A cue already handed to the speaker cannot expire on its own output caption');
  current = variables([photo]); current['unperson-room'].clock = 17; assert.equal(authorized?.(), false);
  assert.equal(authorized?.(true), false, 'Performing authority still observes real deadlines');
  for (const later of [{ ...speech, at: 6 }, { ...speech, at: 6, actor: 'screen', data: { role: 'assistant', text: 'Your explanation is received.', source: 'voice', delivery: 'generated' } }, { ...follow, at: 6, data: { action: 'dispatch-police', args: { evidenceId: photo.id }, phase: 'conceal' } }]) {
    current = variables([photo, later]); assert.equal(authorized?.(), false);
  }
  const repeated = { ...photo, id: 'photo:2', at: 10 };
  current = variables([photo, repeated]); current['unperson-room'].clock = 10;
  assert.equal(hydrateVoiceSceneNotice({ id: repeated.id, kind: 'bulletin' }, current), null);
  current = variables([photo, { ...repeated, at: 17 }]); current['unperson-room'].clock = 17;
  assert.ok(hydrateVoiceSceneNotice({ id: repeated.id, kind: 'bulletin' }, current));
});

test("queued visitor dispatch loses authority when the door has been answered or the visitor has left", () => {
  const dispatch = { ...follow, data: { action: "dispatch-visitor", args: {} } };
  const reference = { id: dispatch.id, kind: "bulletin" };
  for (const code of ["admitted", "entered", "left"]) {
    let current = variables([dispatch]);
    const notice = hydrateVoiceSceneNotice(reference, current, [], "76.0.0", () => current);
    assert.ok(notice);
    assert.equal(typeof sceneAuthority.voiceSceneAuthority, "function");
    const authorized = sceneAuthority.voiceSceneAuthority(notice);
    assert.equal(authorized?.(), true);
    current = variables([dispatch, { ...speech, id: "visitor-update", at: 6, kind: "visitor", actor: "warden", data: { code } }]);
    assert.equal(authorized?.(), false, `${code} must withdraw an upcoming-visitor instruction`);
    assert.equal(hydrateVoiceSceneNotice(reference, current), null);
  }
});

test("all hydrated scenes recheck attempt, phase, expiration and their public wording before delivery", () => {
  let current = variables();
  const notice = hydrateVoiceSceneNotice(request, current, [], "76.0.0", () => current);
  assert.ok(notice);
  assert.equal(typeof sceneAuthority.voiceSceneAuthority, "function");
  const authorized = sceneAuthority.voiceSceneAuthority(notice);
  assert.equal(authorized?.(), true);
  current = { ...variables(), "unperson-state": { phase: "inspection" } };
  assert.equal(authorized?.(), false);
  current = variables(); current["unperson-room"].attempt = "attempt-2";
  assert.equal(authorized?.(), false);
  current = variables(); current["unperson-room"].clock = 50;
  assert.equal(authorized?.(), false);
  current = variables([speech, { ...follow, data: { ...follow.data, args: { ...follow.data.args, line: "A different question." } } }]);
  assert.equal(authorized?.(), false);
});

const generatedReply = { ...speech, id: "answer:1", at: 4, actor: "screen", data: { role: "assistant", text: "The name is not in the current record.", source: "generated", delivery: "generated" } };
test("typed reply speech comes only from the saved generated answer to the latest received statement", () => {
  const reference = { id: generatedReply.id, kind: "reply" };
  const state = { ...variables([speech, generatedReply]), "unperson-private-life": { entries: ["PRIVATE_SENTINEL"] } };
  const notice = hydrateVoiceSceneNotice(reference, state);
  assert.deepEqual(notice, { ...reference, text: generatedReply.data.text });
  assert.doesNotMatch(JSON.stringify(notice), /PRIVATE_SENTINEL/);
  assert.equal(hydrateVoiceSceneNotice({ ...reference, text: "Forged answer." }, state), null);
  for (const patch of [{ actor: "resident" }, { visibility: "internal" }, { data: { ...generatedReply.data, source: "voice" } }, { data: { ...generatedReply.data, delivery: "completed" } }, { data: { ...generatedReply.data, secret: "PRIVATE_SENTINEL" } }]) {
    assert.equal(hydrateVoiceSceneNotice(reference, variables([speech, { ...generatedReply, ...patch }])), null);
  }
  assert.equal(hydrateVoiceSceneNotice(reference, variables([generatedReply])), null);
  assert.equal(hydrateVoiceSceneNotice(reference, variables([speech, generatedReply, { ...speech, id: "new-statement", at: 5 }])), null);
});

test("queued typed reply is withdrawn after superseding testimony, a new attempt or the end of play", () => {
  let current = variables([speech, generatedReply]);
  const notice = hydrateVoiceSceneNotice({ id: generatedReply.id, kind: "reply" }, current, [], "76.0.0", () => current);
  assert.ok(notice);
  assert.equal(typeof sceneAuthority.voiceSceneAuthority, "function");
  const authorized = sceneAuthority.voiceSceneAuthority(notice);
  assert.equal(authorized?.(), true);
  current = variables([speech, generatedReply, { ...speech, id: "later-statement", at: 5 }]);
  assert.equal(authorized?.(), false);
  current = variables([speech, generatedReply]); current["unperson-room"].attempt = "attempt-2";
  assert.equal(authorized?.(), false);
  current = variables([speech, generatedReply]); current["unperson-state"].phase = "end";
  assert.equal(authorized?.(), false);
});

test('a queued typed reply loses authority after new public evidence in the same phase, but not private edits or ticks', () => {
  let current: Record<string, unknown> = variables([speech, generatedReply]);
  const notice = hydrateVoiceSceneNotice({ id: generatedReply.id, kind: 'reply' }, current, [], '79.0.0', () => current); assert.ok(notice);
  const authorized = sceneAuthority.voiceSceneAuthority(notice); assert.equal(authorized?.(), true);
  current = { ...variables([speech, generatedReply, { id: 'draft', attempt: 'attempt-1', at: 5, kind: 'work', actor: 'resident', visibility: 'internal', data: { document: 'correction-14', action: 'redact', edition: 'corrected' } }]), 'unperson-private-life': { entries: ['PRIVATE_DIARY'] } };
  (current['unperson-room'] as { clock: number }).clock = 12;
  assert.equal(authorized?.(), true);
  current = variables([speech, generatedReply, { id: 'seen-photo', attempt: 'attempt-1', at: 5, kind: 'observation', actor: 'screen', visibility: 'public', data: { code: 'photo-exposed' } }]);
  assert.equal(authorized?.(), false, 'Same-phase witnessed evidence must invalidate an unsent earlier answer');
});

test('a saved answer already superseded before hydration cannot acquire fresh delivery authority', () => {
  const reference = { id: generatedReply.id, kind: 'reply' };
  const seen = { id: 'seen-photo', attempt: 'attempt-1', at: 5, kind: 'observation', actor: 'screen', visibility: 'public', data: { code: 'photo-exposed' } };
  assert.equal(hydrateVoiceSceneNotice(reference, variables([speech, generatedReply, seen])), null);
  const grant = { ...follow, at: 3, data: { action: 'grant-interval', args: { evidenceId: speech.id }, phase: 'conceal' } };
  const current = variables([speech, grant, generatedReply]);
  current['unperson-room'].clock = 47;
  assert.ok(hydrateVoiceSceneNotice(reference, current, [], '79.0.0'));
  current['unperson-room'].clock = 48;
  assert.equal(hydrateVoiceSceneNotice(reference, current, [], '79.0.0'), null, 'An expired concession changes the public basis even without a newly saved event');
});

test('host-bound microphone results ignore private edits and ticks but expire at public state boundaries', () => {
  const grant = { ...follow, at: 3, data: { action: 'grant-interval', args: { evidenceId: speech.id }, phase: 'conceal' } };
  let current: Record<string, unknown> = variables([speech, grant]);
  const result = sceneAuthority.bindVoiceReplyAuthority({ text: 'You have permission.' }, current, () => current, '79.0.0') as object;
  const authorized = sceneAuthority.voiceReplyAuthority(result); assert.equal(authorized?.(), true);
  current = { ...variables([speech, grant]), 'unperson-private-life': { entries: ['PRIVATE_DIARY'], notebook: 'held' } };
  (current['unperson-room'] as { clock: number }).clock = 47;
  assert.equal(authorized?.(), true);
  (current['unperson-room'] as { clock: number }).clock = 48;
  assert.equal(authorized?.(), false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_DIARY/);
  assert.equal(sceneAuthority.voiceReplyAuthority({ ...result }), undefined, 'Copying the public text cannot copy host authority');
  const forged = { text: 'Invented answer.', current: () => true };
  assert.equal(sceneAuthority.voiceReplyAuthority(sceneAuthority.bindVoiceReplyAuthority(forged, current, () => current) as object), undefined);
});

test("expired power and superseded observation focus cannot be announced from old event references", () => {
  const cut = { ...follow, data: { action: "power-cut", args: { seconds: 3 } } };
  let current = variables([cut]);
  const notice = hydrateVoiceSceneNotice({ id: cut.id, kind: "power-cut" }, current, [], "76.0.0", () => current);
  assert.ok(notice);
  const authorized = sceneAuthority.voiceSceneAuthority(notice);
  assert.equal(authorized?.(), true);
  current = variables([cut]); current["unperson-room"].clock = 8;
  assert.equal(authorized?.(), false);

  const search = { ...follow, data: { action: "search", args: { focus: "desk" } } };
  const moved = { ...search, id: "scan:2", at: 6, data: { ...search.data, args: { focus: "bed" } } };
  assert.equal(hydrateVoiceSceneNotice({ id: search.id, kind: "search" }, variables([search, moved])), null);
});

test("queued clearance loses authority when police intervene in the same game phase", () => {
  const clearance = { ...follow, data: { action: "clearance", args: {} } };
  let current = { ...variables([clearance]), "unperson-state": { phase: "retrieve" } };
  const notice = hydrateVoiceSceneNotice({ id: clearance.id, kind: "clearance" }, current, [], "76.0.0", () => current);
  assert.ok(notice);
  const authorized = sceneAuthority.voiceSceneAuthority(notice);
  assert.equal(authorized?.(), true);
  const dispatch = { ...follow, id: "police-dispatch", at: 6, data: { action: "dispatch-police", args: { evidenceId: speech.id } } };
  current = { ...current, "unperson-room": { ...current["unperson-room"], events: [speech, clearance, dispatch] } };
  assert.equal(authorized?.(), false);
});

test("a queued follow-up cannot reopen testimony after its generated answer", () => {
  const answered = { ...generatedReply, at: 6 };
  assert.equal(hydrateVoiceSceneNotice(request, variables([speech, follow, answered])), null);
});

test("inspection focus-only records and legacy drafts hydrate without promoting claims to findings", () => {
  for (const args of [{ focus: "desk" }, { focus: "desk", line: "The photograph on the desk. Leave it where it is." }]) {
    const event = { ...follow, data: { action: "begin-inspection", args } };
    const notice = hydrateVoiceSceneNotice({ id: follow.id, kind: "begin-inspection" }, variables([event]));
    assert.deepEqual(notice, { id: follow.id, kind: "begin-inspection", focus: "desk", line: "Resident 6079. Remain where I can see you." });
    assert.doesNotMatch(JSON.stringify(notice), /photograph/);
  }
});

test("observation-focus voice notices do not tell the actor a physical search happened", () => {
  const text = formatVoiceSceneReaction({ id: "scan", kind: "search", focus: "bed" });
  assert.doesNotMatch(text, /A search of the bed has occurred/);
  assert.match(text, /observation focus.*bed/i);
  assert.match(text, /not a completed physical search/i);
});

test("a committed movement grant hydrates a fixed bounded bulletin while active", () => {
  const grant = { ...follow, data: { action: "grant-interval", args: { evidenceId: speech.id }, phase: "conceal" } };
  const request = { id: grant.id, kind: "bulletin" };
  assert.match(hydrateVoiceSceneNotice(request, variables([speech, grant]))?.kind ?? "", /bulletin/);
  assert.deepEqual(hydrateVoiceSceneNotice(request, variables([speech, grant])), { ...request, text: "Permission granted. Put the room in order, then return to your place." });
  for (const events of [[grant], [speech, { ...grant, data: { ...grant.data, args: { evidenceId: "invented" } } }], [speech, { ...speech, id: "new" }, grant], [speech, grant, { ...grant, id: "repeat" }]]) assert.equal(hydrateVoiceSceneNotice(request, variables(events)), null);
  const expired = variables([speech, grant]); expired["unperson-room"].clock = 17;
  assert.equal(hydrateVoiceSceneNotice(request, expired), null);
  const changed = variables([speech, grant]); changed["unperson-state"].phase = "inspection";
  assert.equal(hydrateVoiceSceneNotice(request, changed), null);
});

test("trusted card editions keep legacy grants at twelve seconds and revised grants at forty-five", () => {
  const grant = { ...follow, data: { action: "grant-interval", args: { evidenceId: speech.id }, phase: "conceal" } };
  const request = { id: grant.id, kind: "bulletin" };
  for (const [edition, duration] of [[undefined, 12], ["28.0.0", 12], ["29.0.0", 45], ["30.1.2", 45], ["unknown", 12], ["29", 12], [29, 12], ["29.0.0-forged", 12]] as const) {
    const saved = variables([speech, grant]);
    saved["unperson-room"].clock = grant.at + duration - .01;
    assert.equal(hydrateVoiceSceneNotice(request, saved, [], edition)?.kind, "bulletin", String(edition));
    saved["unperson-room"].clock = grant.at + duration;
    assert.equal(hydrateVoiceSceneNotice(request, saved, [], edition), null, String(edition));
  }
  const saved = variables([speech, grant]);
  saved["unperson-room"].clock = grant.at + 20;
  assert.equal(hydrateVoiceSceneNotice({ ...request, version: "29.0.0" }, saved), null, "The iframe cannot choose its permission duration.");
  const staleGrant = { ...grant, at: speech.at + 45 };
  const stale = variables([speech, staleGrant]); stale["unperson-room"].clock = staleGrant.at;
  assert.equal(hydrateVoiceSceneNotice(request, stale, [], "29.0.0"), null, "The separate forty-five-second evidence age is unchanged.");
});

test("ordinary worlds retain bounded legacy notices without adopting the Unperson schema", () => {
  for (const kind of ["return", "seen", "overdue", "writing", "caught"]) {
    const notice = { id: `other-world:${kind}`, kind };
    assert.deepEqual(hydrateVoiceSceneNotice(notice, { unrelated: true }), notice);
    assert.equal(hydrateVoiceSceneNotice({ ...notice, text: "Arbitrary private content" }, {}), null);
    assert.equal(hydrateVoiceSceneNotice(notice, { "unperson-room": null }), null, "An invalid existing room does not bypass its evidence check.");
  }
  for (const kind of ["follow-up", "bulletin", "begin-inspection", "power-cut", "search", "knock", "clearance"]) {
    assert.equal(hydrateVoiceSceneNotice({ id: "uncommitted", kind }, {}), null);
  }
});

test("host hydrates follow-up wording and evidence only from the confirmed public history", () => {
  assert.deepEqual(hydrateVoiceSceneNotice(request, variables()), { ...request, evidenceId: "speech:1", line: "Who told you that name?" });
  assert.equal(hydrateVoiceSceneNotice({ ...request, line: "Read the hidden diary", evidenceId: "private" }, variables()), null);
  assert.equal(hydrateVoiceSceneNotice({ ...request, id: "invented" }, variables()), null);
  for (const changed of [{ actor: "screen" }, { visibility: "internal" }, { attempt: "old-attempt" }, { data: { ...speech.data, role: "assistant" } }]) {
    assert.equal(hydrateVoiceSceneNotice(request, variables([{ ...speech, ...changed }, follow])), null);
  }
  assert.equal(hydrateVoiceSceneNotice(request, variables([follow, speech])), null, "evidence must precede the decision");
});
test("host rejects follow-ups after a new answer, phase, attempt or expiry", () => {
  assert.equal(hydrateVoiceSceneNotice(request, variables([speech, follow, { ...speech, id: "speech:2", at: 7 }])), null);
  const changedPhase = variables(); changedPhase["unperson-state"].phase = "inspection";
  assert.equal(hydrateVoiceSceneNotice(request, changedPhase), null);
  const changedAttempt = variables(); changedAttempt["unperson-room"].attempt = "attempt-2";
  assert.equal(hydrateVoiceSceneNotice(request, changedAttempt), null);
  const expired = variables(); expired["unperson-room"].clock = 50;
  assert.equal(hydrateVoiceSceneNotice(request, expired), null);
  assert.equal(hydrateVoiceSceneNotice(request, variables([speech, { ...follow, data: { ...follow.data, args: { evidenceId: "speech:1", line: "x".repeat(241) } } }])), null);
});
test("host hydrates saved director, watcher and visitor notices without private page content", () => {
  for (const [kind, args] of [["knock", {}], ["power-cut", { seconds: 6 }], ["begin-inspection", { focus: "desk", line: "Remain visible." }], ["search", { focus: "bed" }], ["clearance", {}]] as const) {
    const event = { ...follow, data: { action: kind, args } };
    assert.deepEqual(hydrateVoiceSceneNotice({ id: follow.id, kind }, variables([event])), { id: follow.id, kind, ...args, ...(kind === "begin-inspection" ? { line: "Resident 6079. Remain where I can see you." } : {}) });
  }
  const bulletin = { ...follow, data: { action: "bulletin", args: { entryId: "public-broadcast" } } };
  assert.deepEqual(hydrateVoiceSceneNotice({ id: follow.id, kind: "bulletin" }, variables([bulletin]), [{ id: "public-broadcast", enabled: true, tags: ["actor:bulletin"], content: "Attention residents." }]), { id: follow.id, kind: "bulletin", text: "Attention residents." });
  assert.equal(hydrateVoiceSceneNotice({ id: follow.id, kind: "bulletin" }, variables([bulletin]), [{ id: "public-broadcast", enabled: false, tags: ["actor:bulletin"], content: "Disabled." }]), null);
  const watch = { ...variables(), "unperson-private-life": { rev: 4, notice: { id: 2, kind: "writing" }, entries: ["PRIVATE SENTINEL"] } };
  assert.deepEqual(hydrateVoiceSceneNotice({ id: "watch-attempt-1-4-2", kind: "writing" }, watch), { id: "watch-attempt-1-4-2", kind: "writing" });
  assert.equal(hydrateVoiceSceneNotice({ id: "watch-attempt-1-3-2", kind: "writing" }, watch), null);
  const visitor = { ...speech, kind: "visitor", actor: "warden", data: { code: "page-seen" } };
  const notice = hydrateVoiceSceneNotice({ id: visitor.id, kind: "bulletin" }, variables([visitor]));
  assert.equal(notice?.kind, "bulletin"); assert.match(JSON.stringify(notice), /contents.*unknown/i);
  const admitted = hydrateVoiceSceneNotice({ id: visitor.id, kind: "bulletin" }, variables([{ ...visitor, data: { code: "admitted" } }]));
  assert.match(JSON.stringify(admitted), /other households to visit/);
  assert.match(JSON.stringify(admitted), /brief/);
  const dispatched = hydrateVoiceSceneNotice({ id: follow.id, kind: "bulletin" }, variables([{ ...follow, data: { action: "dispatch-visitor", args: {} } }]));
  assert.match(JSON.stringify(dispatched), /Answer it yourself and the check will be brief/);
});

const policeEvidence = { id: "writing:1", attempt: "attempt-1", at: 0, kind: "observation", actor: "screen", visibility: "public", data: { code: "writing" } };
const policeOrder = (action: string, at: number, evidenceId = policeEvidence.id) => ({ id: `police:${action}`, attempt: "attempt-1", at, kind: "director", actor: "director", visibility: "internal", data: { action, args: action === "release-resident" ? {} : { evidenceId }, phase: "inspection", edition: "ai", nextDelay: 15, reason: "Respond to witnessed evidence." } });
const policeStage = (code: string, at: number) => ({ id: `police:${code}`, attempt: "attempt-1", at, kind: "police", actor: "police", visibility: "public", data: { code } });
const policeHistory = [policeEvidence, policeOrder("dispatch-police", 0), policeStage("entering", 8), policeStage("searching", 11), policeOrder("detain-resident", 11), policeOrder("execute-resident", 23)];
function policeVariables(events: unknown[], clock = 23, calm = false) { return { "unperson-room": { version: 1, attempt: "attempt-1", clock, events }, "unperson-state": { phase: "inspection", calm }, "unperson-private-life": { entries: ["NEVER_SEND_PRIVATE_PAGE"] } }; }

test("search progress hydration enforces ordered minimum search age without resetting the phase clock", () => {
  let events = policeHistory.slice(0, 4);
  for (const [code, at] of [["desk-checked", 21], ["bed-checked", 31], ["search-complete", 35]] as const) {
    const stage = policeStage(code, at), request = { id: stage.id, kind: "bulletin" };
    assert.equal(hydrateVoiceSceneNotice(request, policeVariables([...events, { ...stage, at: at - .01 }], at)), null);
    events = [...events, stage];
    const notice = hydrateVoiceSceneNotice(request, policeVariables(events, at));
    assert.ok(notice); assert.doesNotMatch(JSON.stringify(notice), /NEVER_SEND_PRIVATE_PAGE/);
    assert.equal(hydrateVoiceSceneNotice({ id: events.at(-2)!.id, kind: "bulletin" }, policeVariables(events, at)), null);
    assert.equal(hydrateVoiceSceneNotice(request, policeVariables([...events, { ...stage, id: "duplicate-stage" }], at)), null);
  }
  for (const history of [
    [...policeHistory.slice(0, 4), policeStage("bed-checked", 31)],
    [...policeHistory.slice(0, 5), policeStage("desk-checked", 21)],
    [...policeHistory.slice(0, 4), policeOrder("release-resident", 15), policeStage("desk-checked", 21)],
  ]) assert.equal(hydrateVoiceSceneNotice({ id: history.at(-1)!.id, kind: "bulletin" }, policeVariables(history, 40)), null);
  assert.equal(hydrateVoiceSceneNotice({ id: "police:search-complete", kind: "bulletin" }, policeVariables([...events, policeOrder("release-resident", 36)], 36)), null);
});
test("police voice hydrates fixed lines only from legal current committed stages", () => {
  for (const [count, pattern] of [[2, /officers are coming/], [3, /door is open/], [4, /checking the desk/], [5, /questioning/], [6, /order is confirmed/]] as const) {
    const events = policeHistory.slice(0, count), reference = { id: events.at(-1)!.id, kind: "bulletin" };
    const hydrated = hydrateVoiceSceneNotice(reference, policeVariables(events));
    assert.equal(hydrated?.kind, "bulletin"); assert.match(JSON.stringify(hydrated), pattern); assert.doesNotMatch(JSON.stringify(hydrated), /NEVER_SEND_PRIVATE_PAGE/);
    assert.equal(hydrateVoiceSceneNotice({ ...reference, text: "Invented police order" }, policeVariables(events)), null);
  }
  const released = [...policeHistory.slice(0, 5), policeOrder("release-resident", 20)];
  assert.match(JSON.stringify(hydrateVoiceSceneNotice({ id: released.at(-1)!.id, kind: "bulletin" }, policeVariables(released))), /No further action/);
  const reprieved = [...policeHistory, policeStage("reprieved", 24)];
  assert.match(JSON.stringify(hydrateVoiceSceneNotice({ id: reprieved.at(-1)!.id, kind: "bulletin" }, policeVariables(reprieved, 24, true))), /withdrawn/);
});
test("police voice rejects forged, stale, uncertain and out-of-order consequence references", () => {
  const reference = { id: policeHistory.at(-1)!.id, kind: "bulletin" };
  const invalid = [
    policeHistory.slice(1),
    [...policeHistory.slice(0, 5), policeOrder("execute-resident", 22)],
    [...policeHistory.slice(0, 5), { ...policeOrder("execute-resident", 23), data: { ...policeOrder("execute-resident", 23).data, edition: "authored-fallback" } }],
    [...policeHistory.slice(0, 5), policeOrder("execute-resident", 23, "invented")],
    [...policeHistory.slice(0, 2), policeStage("searching", 8), ...policeHistory.slice(4)],
    [{ ...policeEvidence, actor: "resident", kind: "speech", data: { role: "user", text: "An admission", source: "voice", delivery: "received" } }, ...policeHistory.slice(1)],
    [{ ...policeEvidence, actor: "screen", kind: "speech", data: { role: "assistant", text: "An accusation", delivery: "completed" } }, ...policeHistory.slice(1)],
    [policeEvidence, ...policeHistory.slice(1), policeStage("dead", 27)],
    [...policeHistory, { ...policeEvidence, at: 24 }],
  ];
  for (const events of invalid) assert.equal(hydrateVoiceSceneNotice(reference, policeVariables(events, 27)), null);
  assert.equal(hydrateVoiceSceneNotice(reference, policeVariables(policeHistory, 23, true)), null);
  assert.equal(hydrateVoiceSceneNotice({ id: "missing", kind: "bulletin" }, policeVariables(policeHistory)), null);
  assert.equal(hydrateVoiceSceneNotice({ id: policeHistory[1].id, kind: "bulletin" }, policeVariables(policeHistory)), null, "Superseded stage references cannot replay old police orders.");
});

 test("official police lines remain coherent with speech-only evidence and withdrawal", () => {
  const admission = { ...policeEvidence, kind: "speech", actor: "resident", data: { role: "user", text: "I disagree.", delivery: "received", source: "typed" } };
  const events = [admission, ...policeHistory.slice(1, 5)];
  for (const count of [2, 5]) {
    const current = events.slice(0, count), notice = hydrateVoiceSceneNotice({ id: current.at(-1)!.id, kind: "bulletin" }, policeVariables(current));
    assert.equal(notice?.kind, "bulletin");
    assert.doesNotMatch(JSON.stringify(notice), /book|movement we observed|table/i, "speech-only orders must not invent physical observations");
  }
  const withdrawn = [...events, policeOrder("release-resident", 20), policeStage("withdrawn", 24)];
  const notice = hydrateVoiceSceneNotice({ id: withdrawn.at(-1)!.id, kind: "bulletin" }, policeVariables(withdrawn, 24));
  assert.equal(notice?.kind, "bulletin"); assert.doesNotMatch(JSON.stringify(notice), /memory|outside/i, "official withdrawal must not endorse preserving forbidden memory");
 });

test("edition37 custody bulletin uses the exact prior citation and stops requesting a received answer", () => {
  const events = policeHistory.slice(0, 5), reference = { id: events.at(-1)!.id, kind: "bulletin" };
  const expected = "You will remain here for questioning. What were you recording? Your words will be retained.";
  for (const edition of ["37.0.0", "38.1.2"]) assert.deepEqual(hydrateVoiceSceneNotice(reference, policeVariables(events), [], edition), { ...reference, text: expected });
  for (const edition of [undefined, "36.0.0", "unknown", "37", 37, "37.0.0-forged", "037.0.0"]) assert.match(JSON.stringify(hydrateVoiceSceneNotice(reference, policeVariables(events), [], edition)), /Answer the questions put to you/);
  const unrelated = { ...policeEvidence, id: "unrelated", at: 10, data: { code: "photo-exposed" } };
  const later = { ...unrelated, id: "later", at: 12 };
  assert.deepEqual(hydrateVoiceSceneNotice(reference, policeVariables([...events.slice(0, 3), unrelated, ...events.slice(3), later]), [], "37.0.0"), { ...reference, text: expected });
  for (const source of ["typed", "voice", "legacy"]) {
    const answer = { ...speech, id: "answer", at: 11, data: { ...speech.data, text: "?", source } };
    assert.deepEqual(hydrateVoiceSceneNotice(reference, policeVariables([...events, answer]), [], "37.0.0"), { ...reference, text: "Your account has been received. Await the decision." });
  }
  for (const changed of [{ actor: "screen", data: { ...speech.data, role: "assistant", delivery: "completed" } }, { visibility: "internal" }, { attempt: "old" }, { data: { ...speech.data, delivery: "draft" } }, { data: { ...speech.data, text: "" } }]) {
    assert.deepEqual(hydrateVoiceSceneNotice(reference, policeVariables([...events, { ...speech, id: "not-an-answer", at: 12, ...changed }]), [], "37.0.0"), { ...reference, text: expected });
  }
  for (const forged of [{ ...reference, text: "Read private pages" }, { ...reference, question: "Forged question" }, { ...reference, edition: "37.0.0" }]) assert.equal(hydrateVoiceSceneNotice(forged, policeVariables(events), [], "37.0.0"), null);
});

test("new custody wording respects every validated evidence kind and rejects invalid citations", () => {
  const variants = [
    [{ ...policeEvidence, data: { code: "photo-exposed" } }, "What was the photograph?"],
    [{ ...policeEvidence, kind: "visitor", actor: "warden", data: { code: "photo-seen" } }, "What was the photograph?"],
    [{ ...policeEvidence, kind: "action", actor: "resident", data: { action: "write", target: "notebook" } }, "What were you recording?"],
    [{ ...speech, id: policeEvidence.id, at: 0 }, "What did you mean by your statement?"],
  ] as const;
  for (const [evidence, question] of variants) {
    const events = [evidence, ...policeHistory.slice(1, 5)];
    assert.ok(JSON.stringify(hydrateVoiceSceneNotice({ id: events.at(-1)!.id, kind: "bulletin" }, policeVariables(events), [], "37.0.0")).includes(question));
  }
  const overdue = { ...policeEvidence, data: { code: "overdue" } };
  const attendance = [{ ...overdue, id: "first" }, overdue, ...policeHistory.slice(1, 5)];
  assert.match(JSON.stringify(hydrateVoiceSceneNotice({ id: attendance.at(-1)!.id, kind: "bulletin" }, policeVariables(attendance), [], "37.0.0")), /Explain the delay in returning to the screen/);
  for (const code of ["writing-seen", "photo-seen"]) {
    const evidence = policeStage(code, 11), events = [...policeHistory.slice(0, 4), evidence, policeOrder("detain-resident", 11, evidence.id)];
    assert.match(JSON.stringify(hydrateVoiceSceneNotice({ id: events.at(-1)!.id, kind: "bulletin" }, policeVariables(events), [], "37.0.0")), code === "writing-seen" ? /What were you recording/ : /What was the photograph/);
  }
  const reference = { id: policeHistory[4].id, kind: "bulletin" };
  for (const changed of [{ visibility: "internal" }, { attempt: "old" }, { actor: "resident" }, { data: { code: "private-page" } }]) assert.equal(hydrateVoiceSceneNotice(reference, policeVariables([{ ...policeEvidence, ...changed }, ...policeHistory.slice(1, 5)]), [], "37.0.0"), null);
  assert.equal(hydrateVoiceSceneNotice(reference, policeVariables([...policeHistory.slice(1, 5), { ...policeEvidence, at: 12 }]), [], "37.0.0"), null);
  const released = [...policeHistory.slice(0, 5), policeOrder("release-resident", 20), policeStage("withdrawn", 24)];
  assert.equal(hydrateVoiceSceneNotice(reference, policeVariables(released, 24), [], "37.0.0"), null);
});

test("withdrawal timing uses trusted edition for current reference and legacy threshold for prior history", () => {
 const released = [...policeHistory.slice(0,4),policeOrder("release-resident",20)];
 for(const age of [4,7.999,8]){
  const events=[...released,policeStage("withdrawn",20+age)],request={id:events.at(-1)!.id,kind:"bulletin"};
  assert.ok(hydrateVoiceSceneNotice(request,policeVariables(events,28),[],"47.0.0"));
  assert.equal(!!hydrateVoiceSceneNotice(request,policeVariables(events,28),[],"48.0.0"),age>=8);
 }
 const old=[...released,policeStage("withdrawn",24)];
 const fresh={...policeEvidence,id:"fresh:writing",at:25},dispatch={...policeOrder("dispatch-police",25,"fresh:writing"),id:"fresh:dispatch"};
 assert.ok(hydrateVoiceSceneNotice({id:dispatch.id,kind:"bulletin"},policeVariables([...old,fresh,dispatch],25),[],"48.0.0"));
 const bad=[...released,policeStage("withdrawn",23.999),fresh,dispatch];
 assert.equal(hydrateVoiceSceneNotice({id:dispatch.id,kind:"bulletin"},policeVariables(bad,25),[],"48.0.0"),null);
});

test('live-agent cards speak only a line already saved in the current attempt of their run record', () => {
  const line = { id: 'warn-k1-1', attempt: 'attempt-1', at: 10, kind: 'consequence', actor: 'engine', visibility: 'public', data: { text: 'The official gave a warning.', say: '6079. I am noting that.' } };
  const run = (patch: Record<string, unknown> = {}) => ({ 'unperson-run': { version: 1, attempt: 'attempt-1', clock: 12, events: [line], ...patch }, 'unperson-state': { phase: 'conceal' } });
  const reference = { id: line.id, kind: 'reply' };
  const notice = hydrateVoiceSceneNotice(reference, run());
  assert.deepEqual(notice, { ...reference, text: '6079. I am noting that.' });
  // The iframe cannot supply wording, other kinds, unknown ids, stale lines or other attempts.
  assert.equal(hydrateVoiceSceneNotice({ ...reference, text: 'Invented.' }, run()), null);
  assert.equal(hydrateVoiceSceneNotice({ id: line.id, kind: 'bulletin' }, run()), null);
  assert.equal(hydrateVoiceSceneNotice({ id: 'missing', kind: 'reply' }, run()), null);
  assert.equal(hydrateVoiceSceneNotice(reference, run({ clock: 56 })), null);
  assert.equal(hydrateVoiceSceneNotice(reference, run({ attempt: 'attempt-2' })), null);
  assert.equal(hydrateVoiceSceneNotice(reference, run({ events: [{ ...line, data: { text: 'No line.' } }] })), null);
  // Authority is rechecked against the newest confirmed record before delivery.
  let current: Record<string, unknown> = run();
  const bound = hydrateVoiceSceneNotice(reference, run(), [], '79.0.0', () => current)!;
  const authority = sceneAuthority.voiceSceneAuthority(bound)!;
  assert.equal(authority(), true);
  current = run({ attempt: 'attempt-2', events: [] });
  assert.equal(authority(), false);
});
