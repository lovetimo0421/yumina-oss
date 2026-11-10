import { deriveUnpersonCustodyQuestion } from "../../../../shared/src/unperson-custody-question";
import { UNPERSON_POLICE_ACTIONS, UNPERSON_POLICE_LINES, UNPERSON_POLICE_TIMING, UNPERSON_POLICE_PROGRESS } from "../../../../shared/src/unperson-police";
import { UNPERSON_ROOM_TIMING } from "../../../../shared/src/unperson-room-timing";
import { isVoiceSceneReaction, type VoiceSceneReaction } from "../../../sandbox/voice-types";
import { validWorkEvent, workState, workAcknowledgement, workReplyReceived } from "../../../../shared/src/unperson-work";

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const parseRecord = (value: unknown): Record<string, unknown> | null => {
  if (typeof value === "string" && value.length <= 1_048_576) { try { value = JSON.parse(value); } catch { return null; } }
  return record(value) ? value : null;
};
const receivedSpeech = (event: Record<string, unknown>) => event.kind === "speech" && event.actor === "resident" && event.visibility === "public" && record(event.data) && event.data.role === "user" && event.data.delivery === "received";
const LEGACY_SIMPLE_NOTICES = new Set(["return", "seen", "overdue", "writing", "caught"]);
const VISITOR_OBSERVATIONS: Record<string, string> = {
  admitted: "The resident answered the door. The block warden is checking from the doorway. He has other households to visit; keep hands visible so this voluntary check can be brief.",
  entered: "The attendance warning elapsed. The door opened for the block warden's threshold check.",
  "photo-seen": "The doorway witness saw a small exposed photograph. Its subjects and provenance are unknown.",
  "page-seen": "The doorway witness saw an open notebook. Its contents remain unknown. The warden is waiting for the book to close or leave view.",
  left: "The block warden withdrew. The door closed. This was a sightline check, not a search of concealed places.",
};

const exact = (value: Record<string, unknown>, keys: string[]) => Reflect.ownKeys(value).length === keys.length && Reflect.ownKeys(value).every(key => typeof key === "string" && keys.includes(key));
// Object identity never crosses the sandbox bridge. Only successful hydration
// can mark a police notice, without extending the public SDK payload.
const policeAuthorities = new WeakMap<object, () => boolean>();
export function policeSceneAuthority(notice: object): (() => boolean) | undefined { return policeAuthorities.get(notice); }
const workAuthorities = new WeakMap<object, () => boolean>();
export function workSceneAuthority(notice: object): (() => boolean) | undefined { return workAuthorities.get(notice); }
const sceneAuthorities = new WeakMap<object, (performing?: boolean) => boolean>();
export function voiceSceneAuthority(notice: object): ((performing?: boolean) => boolean) | undefined { return sceneAuthorities.get(notice); }
const replyAuthorities = new WeakMap<object, () => boolean>();
export function voiceReplyAuthority(result: object): (() => boolean) | undefined { return replyAuthorities.get(result); }
const voicePerformance = (event: unknown) => record(event) && event.kind === 'speech' && event.actor === 'screen' && record(event.data) && event.data.role === 'assistant' && event.data.source === 'voice';

/** Public authority from confirmed host state only. No private inventory/pages,
 * arbitrary state metadata, clock ticks or internal work drafts enter this key.
 * Room events are immutable; a new public event changes the answer's basis. */
function publicReplyKey(variables: Record<string, unknown>, worldVersion?: unknown): string | null {
  const room = parseRecord(variables['unperson-room']), game = parseRecord(variables['unperson-state']);
  if (!room || !game || typeof room.attempt !== 'string' || !ACTIVE_PHASES.includes(String(game.phase)) || !Array.isArray(room.events) || room.events.length > 4096 || typeof room.clock !== 'number' || !Number.isFinite(room.clock)) return null;
  const events = room.events.filter((event): event is Record<string, unknown> => record(event) && event.attempt === room.attempt);
  const director = (event: Record<string, unknown>) => event.kind === 'director' && event.actor === 'director' && event.visibility === 'internal' && record(event.data);
  // A performance's own caption can be saved before avatar playback begins.
  // It is output bookkeeping, not new testimony or physical evidence.
  const publicEvents = events.filter(event => !voicePerformance(event) && (event.visibility === 'public' && ['speech', 'observation', 'action', 'visitor', 'police', 'work'].includes(String(event.kind))
    || director(event) && (event.data as Record<string, unknown>).action !== 'wait'));
  if (publicEvents.some(event => typeof event.id !== 'string')) return null;
  const recent = events.slice().reverse();
  const cut = recent.find(event => director(event) && (event.data as Record<string, unknown>).action === 'power-cut');
  const grant = recent.find(event => director(event) && (event.data as Record<string, unknown>).action === 'grant-interval');
  const cutArgs = cut && record(cut.data) && record(cut.data.args) ? cut.data.args : null;
  const major = typeof worldVersion === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(worldVersion) ? Number(worldVersion.split('.')[0]) : 0;
  const duration = major >= 29 ? UNPERSON_ROOM_TIMING.concession : UNPERSON_ROOM_TIMING.legacyConcession;
  const powerOff = !!cut && typeof cut.at === 'number' && typeof cutArgs?.seconds === 'number' && room.clock < cut.at + cutArgs.seconds;
  const permission = !!grant && record(grant.data) && grant.data.phase === game.phase && typeof grant.at === 'number' && room.clock < grant.at + duration;
  return JSON.stringify([room.attempt, game.phase, variables['unperson-work-enabled'] === true, powerOff, permission, publicEvents.map(event => event.id)]);
}

/** Bind the existing result object without extending the iframe's data contract.
 * Only the host can attach this closure; caller-supplied metadata is not authority. */
export function bindVoiceReplyAuthority(result: unknown, variables: Record<string, unknown>, currentVariables: () => Record<string, unknown>, worldVersion?: unknown): unknown {
  if (!record(result) || !exact(result, ['text']) || typeof result.text !== 'string' || !Object.hasOwn(variables, 'unperson-room')) return result;
  const value = { text: result.text }, key = publicReplyKey(variables, worldVersion);
  replyAuthorities.set(value, () => {
    try { return key !== null && publicReplyKey(currentVariables(), worldVersion) === key; } catch { return false; }
  });
  return value;
}
type SceneEntries = ReadonlyArray<{ id: string; content: string; enabled?: boolean; tags?: string[] }>;
const ACTIVE_PHASES = ["find", "conceal", "inspection", "retrieve", "escape"];
const generatedSpeech = (event: Record<string, unknown>) => event.kind === "speech" && event.actor === "screen" && event.visibility === "public" && record(event.data) && event.data.role === "assistant" && event.data.delivery === "generated";
const screenPhoto = (event: Record<string, unknown>) => event.kind === 'observation' && event.actor === 'screen' && event.visibility === 'public' && record(event.data) && exact(event.data, ['code']) && event.data.code === 'photo-exposed';
function policeIntervention(events: Record<string, unknown>[]): boolean {
  let phase = "none";
  const orders: Record<string, string> = { "dispatch-police": "approaching", "detain-resident": "detained", "execute-resident": "executing", "release-resident": "released" };
  for (const event of events) {
    if (!record(event.data)) continue;
    if (event.kind === "director" && event.actor === "director" && event.visibility === "internal" && typeof event.data.action === "string" && Object.hasOwn(orders, event.data.action)) phase = orders[event.data.action]!;
    if (event.kind === "police" && event.actor === "police" && event.visibility === "public") {
      if (["entering", "searching", "dead"].includes(String(event.data.code))) phase = String(event.data.code);
      if (event.data.code === "withdrawn") phase = "none";
      if (event.data.code === "reprieved") phase = "released";
    }
  }
  return !["none", "released", "dead"].includes(phase);
}

/** Recheck the public police sequence before turning a saved reference into
 * speech. This grants no game action and never reads private page contents. */
function policeBulletin(events: Record<string, unknown>[], referenceId: string, clock: number, calm: boolean, custodyQuestions: boolean, currentWithdrawal: number): string | null {
  let phase = "none", began = 0, lastAt = 0, latestId = "", line: string | null = null, overdue = 0, progress = 0;
  const ids = new Set<string>(), physical = new Set<string>(), dispatch = new Set<string>();
  for (const event of events) {
    if (typeof event.id !== "string" || ids.has(event.id) || typeof event.at !== "number" || !Number.isFinite(event.at) || event.at < lastAt || event.at > clock || !record(event.data)) return null;
    ids.add(event.id); lastAt = event.at; const data = event.data;
    const transition = (next: string, text: string) => { phase = next; began = event.at as number; latestId = event.id as string; line = text; if (next === "approaching") progress = 0; };
    if (event.kind === "director" && typeof data.action === "string" && UNPERSON_POLICE_ACTIONS.includes(data.action)) {
      if (event.actor !== "director" || event.visibility !== "internal" || !record(data.args) || !exact(data, ["action", "args", "phase", "edition", "nextDelay", "reason"]) || !["find", "conceal", "inspection", "retrieve", "escape"].includes(String(data.phase)) || !["ai", "authored-fallback"].includes(String(data.edition)) || typeof data.nextDelay !== "number" || !Number.isFinite(data.nextDelay) || data.nextDelay < 5 || data.nextDelay > 60 || typeof data.reason !== "string" || !data.reason.trim() || data.reason.length > 240) return null;
      const args = data.args, action = data.action;
      if (action === "release-resident") {
        if (!exact(args, []) || !["searching", "detained"].includes(phase)) return null;
        transition("released", UNPERSON_POLICE_LINES.released); physical.clear(); dispatch.clear(); overdue = 0;
      } else {
        if (!exact(args, ["evidenceId"]) || typeof args.evidenceId !== "string" || !dispatch.has(args.evidenceId)) return null;
        if (action === "dispatch-police") { if (phase !== "none") return null; transition("approaching", UNPERSON_POLICE_LINES.approaching); }
        if (action === "detain-resident") { if (phase !== "searching") return null; transition("detained", UNPERSON_POLICE_LINES.detained); }
        if (action === "execute-resident") { if (phase !== "detained" || event.at - began < UNPERSON_POLICE_TIMING.custody || data.edition !== "ai" || !physical.has(args.evidenceId)) return null; transition("executing", UNPERSON_POLICE_LINES.executing); }
      }
    } else if (event.kind === "police") {
      if (event.actor !== "police" || event.visibility !== "public" || !exact(data, ["code"])) return null;
      if (UNPERSON_POLICE_PROGRESS.some(step => step.code === data.code)) {
        const next = UNPERSON_POLICE_PROGRESS[progress];
        if (phase !== "searching" || !next || next.code !== data.code || event.at - began < next.at) return null;
        progress++; latestId = event.id; line = UNPERSON_POLICE_LINES[data.code as keyof typeof UNPERSON_POLICE_LINES];
      } else if (["writing-seen", "photo-seen"].includes(String(data.code))) {
        if (!["entering", "searching", "detained"].includes(phase)) return null;
        physical.add(event.id); dispatch.add(event.id);
      } else if (data.code === "entering" && phase === "approaching" && event.at - began >= UNPERSON_POLICE_TIMING.approaching) transition("entering", UNPERSON_POLICE_LINES.entering);
      else if (data.code === "searching" && phase === "entering" && event.at - began >= UNPERSON_POLICE_TIMING.entering) transition("searching", UNPERSON_POLICE_LINES.searching);
      else if (data.code === "dead" && phase === "executing" && event.at - began >= UNPERSON_POLICE_TIMING.executing) transition("dead", UNPERSON_POLICE_LINES.dead);
      else if (data.code === "withdrawn" && phase === "released" && event.at - began >= (event.id === referenceId ? currentWithdrawal : UNPERSON_POLICE_TIMING.legacyReleased)) transition("none", UNPERSON_POLICE_LINES.withdrawn);
      else if (data.code === "reprieved" && phase === "executing") { transition("released", UNPERSON_POLICE_LINES.reprieved); physical.clear(); dispatch.clear(); overdue = 0; }
      else return null;
    } else if (event.visibility === "public") {
      if (event.kind === "speech" && event.actor === "resident" && data.role === "user" && data.delivery === "received" && ["voice", "typed", "legacy"].includes(String(data.source)) && typeof data.text === "string" && data.text.trim()) dispatch.add(event.id);
      if (event.kind === "observation" && event.actor === "screen" && exact(data, ["code"])) {
        if (["writing", "photo-exposed"].includes(String(data.code))) { physical.add(event.id); dispatch.add(event.id); }
        if (data.code === "overdue") { overdue++; if (overdue >= 2) dispatch.add(event.id); }
        if (data.code === "acknowledged") { overdue = 0; for (const id of dispatch) if (!physical.has(id) && events.some(e => e.id === id && e.kind === "observation" && record(e.data) && e.data.code === "overdue")) dispatch.delete(id); }
      }
      if (event.kind === "action" && event.actor === "resident" && exact(data, ["action", "target"]) && data.action === "write" && data.target === "notebook" || event.kind === "visitor" && event.actor === "warden" && exact(data, ["code"]) && data.code === "photo-seen") { physical.add(event.id); dispatch.add(event.id); }
    }
  }
  if (custodyQuestions && phase === "detained") line = deriveUnpersonCustodyQuestion(events, latestId)?.line ?? null;
  return latestId === referenceId && phase !== "dead" && !(phase === "executing" && calm) ? line : null;
}

/** The card sends only a reference. Hydrate the room's allowlisted event schema
 * from host-confirmed variables, never freeform text supplied by the iframe. */
/** Live-agent cards keep one saved record per attempt (`unperson-run`) instead
 * of the room ledger. They may ask the official to speak a line they already
 * saved: an event of the current attempt whose `data.say` holds the wording.
 * The iframe still sends only id and kind; the wording comes from confirmed
 * host state, and it expires once the record has moved on. */
const RUN_LINE_MAX = 600, RUN_LINE_AGE = 25;
function savedRunLine(variables: Record<string, unknown>, id: string): { attempt: string; text: string } | null {
  if (Object.hasOwn(variables, 'unperson-room')) return null;
  const run = parseRecord(variables['unperson-run']);
  if (!run || run.version !== 1 || typeof run.attempt !== 'string' || !Array.isArray(run.events) || run.events.length > 4096 || typeof run.clock !== 'number' || !Number.isFinite(run.clock)) return null;
  const event = run.events.find((item): item is Record<string, unknown> => record(item) && item.attempt === run.attempt && item.id === id);
  if (!event || !record(event.data) || typeof event.data.say !== 'string' || typeof event.at !== 'number' || !Number.isFinite(event.at)) return null;
  const text = event.data.say.trim();
  if (!text || text.length > RUN_LINE_MAX || run.clock - event.at > RUN_LINE_AGE) return null;
  return { attempt: run.attempt, text };
}
function hydrateRunLine(request: unknown, variables: Record<string, unknown>, currentVariables?: () => Record<string, unknown>): VoiceSceneReaction | null {
  if (!record(request) || !exact(request, ['id', 'kind']) || request.kind !== 'reply' || typeof request.id !== 'string' || !/^[\w:-]{1,160}$/.test(request.id)) return null;
  const id = request.id, line = savedRunLine(variables, id);
  if (!line) return null;
  const notice = { id, kind: 'reply' as const, text: line.text };
  if (!isVoiceSceneReaction(notice)) return null;
  sceneAuthorities.set(notice, () => {
    if (!currentVariables) return true;
    try { const now = savedRunLine(currentVariables(), id); return now !== null && now.attempt === line.attempt && now.text === line.text; } catch { return false; }
  });
  return notice;
}

export function hydrateVoiceSceneNotice(request: unknown, variables: Record<string, unknown>, entries: SceneEntries = [], worldVersion?: unknown, currentVariables?: () => Record<string, unknown>): VoiceSceneReaction | null {
  if (!Object.hasOwn(variables, 'unperson-room') && Object.hasOwn(variables, 'unperson-run')) return hydrateRunLine(request, variables, currentVariables);
  const notice = hydrateSceneReference(request, variables, entries, worldVersion);
  if (!notice) return null;
  const attempt = parseRecord(variables["unperson-room"])?.attempt;
  const phase = parseRecord(variables["unperson-state"])?.phase;
  const reference = { id: notice.id, kind: notice.kind };
  const semantics = JSON.stringify(notice);
  const replyKey = notice.kind === 'reply' ? publicReplyKey(variables, worldVersion) : undefined;
  const authorized = (performing = false) => {
    if (!currentVariables) return true;
    try {
      const current = currentVariables();
      if (parseRecord(current["unperson-room"])?.attempt !== attempt || parseRecord(current["unperson-state"])?.phase !== phase) return false;
      if (replyKey !== undefined && (replyKey === null || publicReplyKey(current, worldVersion) !== replyKey)) return false;
      // Once a notice was handed to the speaker, its own output caption may
      // arrive before sound. It cannot invalidate itself. Before that handoff,
      // newer dialogue still supersedes queued observation/follow-up cues.
      const room = parseRecord(current['unperson-room']);
      const checked = performing && room && Array.isArray(room.events)
        ? { ...current, 'unperson-room': { ...room, events: room.events.filter(event => !voicePerformance(event)) } } : current;
      const hydrated = hydrateSceneReference(reference, checked, entries, worldVersion);
      return hydrated !== null && JSON.stringify(hydrated) === semantics;
    } catch { return false; }
  };
  sceneAuthorities.set(notice, authorized);
  // Keep existing realtime consumers on the same validation as GPT-Live.
  if (policeAuthorities.has(notice)) policeAuthorities.set(notice, authorized);
  if (workAuthorities.has(notice)) workAuthorities.set(notice, authorized);
  return notice;
}

function hydrateSceneReference(request: unknown, variables: Record<string, unknown>, entries: SceneEntries, worldVersion?: unknown): VoiceSceneReaction | null {
  if (!record(request) || Reflect.ownKeys(request).length !== 2 || typeof request.id !== "string" || request.id.length > 160 || !/^[\w:-]+$/.test(request.id) || typeof request.kind !== "string") return null;
  // Existing cards can still issue the five fixed, text-free observations.
  // A card using the room contract must satisfy its stricter evidence checks.
  if (!Object.hasOwn(variables, "unperson-room")) return LEGACY_SIMPLE_NOTICES.has(request.kind) && isVoiceSceneReaction(request) ? request : null;
  const room = parseRecord(variables["unperson-room"]);
  if (!room || room.version !== 1 || typeof room.attempt !== "string" || !Array.isArray(room.events) || room.events.length > 4096 || typeof room.clock !== "number" || !Number.isFinite(room.clock)) return null;
  const events = room.events.filter((event): event is Record<string, unknown> => record(event) && event.attempt === room.attempt);
  let notice: unknown = null;
  if (["return", "seen", "overdue", "writing", "caught"].includes(request.kind)) {
    // Watcher legacy IDs encode only the saved observation revision. Read no
    // notebook entries, page text, or arbitrary line from the private snapshot.
    const watcher = parseRecord(variables["unperson-private-life"]);
    if (watcher && Number.isSafeInteger(watcher.rev) && record(watcher.notice) && Number.isSafeInteger(watcher.notice.id) && watcher.notice.kind === request.kind && request.id === `watch-${room.attempt}-${watcher.rev}-${watcher.notice.id}`) notice = request;
  } else {
    const index = events.findIndex(event => event.id === request.id);
    const event = events[index];
    if (!event || !record(event.data)) return null;
    const data = event.data;
    const later = events.slice(index + 1);
    const laterAction = (actions: string[]) => later.some(candidate => candidate.kind === "director" && candidate.actor === "director" && candidate.visibility === "internal" && record(candidate.data) && actions.includes(String(candidate.data.action)));
    if (request.kind === 'bulletin' && screenPhoto(event)) {
      const game = parseRecord(variables['unperson-state']);
      const previous = events.slice(0, index).reverse().find(screenPhoto);
      if (!game || !ACTIVE_PHASES.includes(String(game.phase)) || typeof event.at !== 'number' || !Number.isFinite(event.at) || event.at < 0 || event.at > room.clock
        || room.clock - event.at >= UNPERSON_ROOM_TIMING.observationReaction
        || previous && (typeof previous.at !== 'number' || event.at - previous.at < UNPERSON_ROOM_TIMING.observationReaction)
        || later.some(candidate => receivedSpeech(candidate) || generatedSpeech(candidate) || screenPhoto(candidate)) || policeIntervention(events)) return null;
      // This demand follows a saved sighting. It reveals no subject, current
      // location or private possession and queues behind an existing answer.
      return { id: request.id, kind: 'bulletin', text: '6079. Show me that photograph.' };
    }
    if (request.kind === "reply") {
      const game = parseRecord(variables["unperson-state"]);
      const statement = events.slice(0, index).reverse().find(receivedSpeech);
      if (!game || !ACTIVE_PHASES.includes(String(game.phase))
        || event.kind !== "speech" || event.actor !== "screen" || event.visibility !== "public"
        || !exact(data, ["role", "text", "source", "delivery"]) || data.role !== "assistant" || data.source !== "generated" || data.delivery !== "generated"
        || typeof data.text !== "string" || !data.text.trim() || data.text.length > 1200 || /[<>\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(data.text)
        || typeof event.at !== "number" || !Number.isFinite(event.at) || event.at < 0 || event.at > room.clock
        || !statement || typeof statement.at !== "number" || statement.at > event.at) return null;
      // A reference can itself arrive after new evidence or a permission/power
      // deadline. Do not give an already-stale saved answer a fresh authority.
      const savedKey = publicReplyKey({ ...variables, 'unperson-room': { ...room, clock: event.at, events: events.slice(0, index + 1) } }, worldVersion);
      if (savedKey === null || savedKey !== publicReplyKey(variables, worldVersion)) return null;
      const reply = { ...request, text: data.text };
      return isVoiceSceneReaction(reply) ? reply : null;
    }
    if(event.kind === 'work' && request.kind === 'bulletin'){
      const game=parseRecord(variables['unperson-state']);
      if(variables['unperson-work-enabled'] !== true || !game || !['find','conceal','inspection','retrieve','escape'].includes(String(game.phase))
        || !validWorkEvent(event) || data.action !== 'submit' || typeof event.at !== 'number' || !Number.isFinite(event.at) || event.at > room.clock || event.at < 0) return null;
      try {
        const sheet=workState({attempt:room.attempt,events,clock:room.clock});
        if(sheet.submissionId !== request.id || !sheet.submitted) return null;
        const notice: VoiceSceneReaction={id:request.id,kind:'bulletin',text:workAcknowledgement(sheet.submitted,workReplyReceived({attempt:room.attempt,events}))};
        workAuthorities.set(notice,()=>true);
        return notice;
      } catch { return null; }
    }
    if (request.kind === "bulletin" && (event.kind === "police" || event.kind === "director" && typeof data.action === "string" && UNPERSON_POLICE_ACTIONS.includes(data.action))) {
      const game = parseRecord(variables["unperson-state"]);
      if (!game || typeof game.calm !== "boolean" || !["find", "conceal", "inspection", "retrieve", "escape"].includes(String(game.phase))) return null;
      const major = typeof worldVersion === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(worldVersion) ? Number(worldVersion.split(".")[0]) : 0;
      const text = policeBulletin(events, request.id, room.clock, game.calm, Number.isSafeInteger(major) && major >= 37, Number.isSafeInteger(major) && major >= 48 ? UNPERSON_POLICE_TIMING.released : UNPERSON_POLICE_TIMING.legacyReleased);
      if (!text) return null;
      const notice: VoiceSceneReaction = { id: request.id, kind: "bulletin", text };
      policeAuthorities.set(notice, () => true);
      return notice;
    }
    if (event.kind === "observation" && event.actor === "screen" && event.visibility === "public" && data.code === "power-restored" && request.kind === "power-restored") {
      if (laterAction(["power-cut"])) return null;
      notice = request;
    }
    if (event.kind === "visitor" && event.actor === "warden" && event.visibility === "public" && request.kind === "bulletin" && typeof data.code === "string" && Object.hasOwn(VISITOR_OBSERVATIONS, data.code)) {
      if (events.slice(index + 1).some(candidate => candidate.kind === "visitor" && candidate.actor === "warden" && candidate.visibility === "public"
        || candidate.kind === "director" && record(candidate.data) && candidate.data.action === "dispatch-visitor")) return null;
      notice = { ...request, text: VISITOR_OBSERVATIONS[data.code] };
    }
    if (event.kind === "director" && event.actor === "director" && event.visibility === "internal" && record(data.args)) {
      const args = data.args;
      if (data.action === "grant-interval" && request.kind === "bulletin") {
        const game = parseRecord(variables["unperson-state"]);
        const prior = events.slice(0, index);
        const evidence = prior.reverse().find(receivedSpeech);
        // The host supplies the loaded card edition, never the iframe notice.
        // Old saved card copies still run their original twelve-second timer.
        const major = typeof worldVersion === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(worldVersion) ? Number(worldVersion.split(".")[0]) : 0;
        const duration = Number.isSafeInteger(major) && major >= 29 ? UNPERSON_ROOM_TIMING.concession : UNPERSON_ROOM_TIMING.legacyConcession;
        if (!game || !["conceal", "inspection"].includes(String(game.phase)) || data.phase !== game.phase || typeof event.at !== "number" || !Number.isFinite(event.at) || event.at > room.clock || room.clock >= event.at + duration || !evidence || evidence.id !== args.evidenceId || typeof evidence.at !== "number" || event.at < evidence.at || event.at >= evidence.at + UNPERSON_ROOM_TIMING.concessionEvidence || events.some(candidate => candidate.id !== event.id && candidate.kind === "director" && record(candidate.data) && candidate.data.action === "grant-interval")) return null;
        notice = { ...request, text: "Permission granted. Put the room in order, then return to your place." };
      }
      if (data.action === "dispatch-visitor" && request.kind === "bulletin") {
        if (events.slice(index + 1).some(candidate => candidate.kind === "visitor" && candidate.actor === "warden" && candidate.visibility === "public"
          || candidate.kind === "director" && record(candidate.data) && candidate.data.action === "dispatch-visitor")) return null;
        notice = { ...request, text: "Resident 6079. Your attendance remains unconfirmed. The block warden is coming to your door. Answer it yourself and the check will be brief." };
      }
      if (data.action === request.kind) {
        switch (request.kind) {
          case "knock":
            if (laterAction(["knock"])) return null;
            notice = request; break;
          case "clearance":
            if (policeIntervention(events)) return null;
            notice = request; break;
          case "power-cut":
            if (typeof event.at !== "number" || typeof args.seconds !== "number" || event.at > room.clock || room.clock >= event.at + args.seconds || laterAction(["power-cut"])) return null;
            notice = { ...request, seconds: args.seconds }; break;
          case "begin-inspection":
            if (laterAction(["begin-inspection", "search", "clearance"])) return null;
            // Old records may retain a generated draft. Preserve their validity
            // checks, but never promote the draft's assertions to scene facts.
            if ("line" in args && !isVoiceSceneReaction({ ...request, focus: args.focus, line: args.line })) return null;
            notice = { ...request, focus: args.focus, line: "Resident 6079. Remain where I can see you." };
            break;
          case "search":
            if (laterAction(["begin-inspection", "search", "clearance"])) return null;
            notice = { ...request, focus: args.focus }; break;
          case "bulletin": {
            if (laterAction(["bulletin"])) return null;
            const entry = entries.find(candidate => candidate.id === args.entryId && candidate.enabled !== false && candidate.tags?.includes("actor:bulletin"));
            if (entry) notice = { ...request, text: entry.content };
            break;
          }
          case "follow-up": {
            const game = parseRecord(variables["unperson-state"]);
            if (!game || !["find", "conceal", "inspection"].includes(String(game.phase)) || data.phase !== game.phase || typeof event.at !== "number" || event.at > room.clock || room.clock >= event.at + 45) return null;
            const evidence = events.slice(0, index).find(candidate => candidate.id === args.evidenceId && receivedSpeech(candidate));
            if (!evidence || later.some(candidate => receivedSpeech(candidate) || generatedSpeech(candidate))) return null;
            notice = { ...request, evidenceId: args.evidenceId, line: args.line };
            break;
          }
        }
      }
    }
  }
  return isVoiceSceneReaction(notice) ? notice : null;
}
