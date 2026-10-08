/** Bounded voice surface. The host owns consent, capture, playback and provider traffic. */
export type VoiceEvent =
  | { type: "status"; status: "connecting" | "connected" | "stopped" | "error"; message?: string; phase?: "consent" | "permission" | "negotiation" | "live" | "cleanup"; code?: string; reason?: 'wall' | 'configuration' | 'playback' | 'client-write' | 'input-age' }
  | { type: "transcript"; role: "user" | "assistant"; id: string; text: string; final: boolean; native?: VoiceFinalIdentity }
  | { type: "input"; status: "speaking" | "transcribing" | "discarded"; id: string }
  | { type: "input-hint"; message: string }
  | { type: "capture-settings"; echoCancellation: boolean | "all" | "remote-only" | "unknown" }
  | { type: "level"; value: number }
  | { type: "input-level"; value: number }
  /** Borrowed only for this synchronous callback; copy before returning. The dispatcher closes it. */
  | { type: "video-frame"; id: number; frame: ImageBitmap }
  | { type: "video-status"; status: "connecting" | "live" | "stopped"; message?: string }
  | { type: "activity"; status: "listening" | "speaking" | "thinking" }
  | { type: 'context-status'; revision: number; status: 'pending' | 'configuring' | 'applied' }
  | { type: "tool"; callId: string; name: "request_inspection_focus"; arguments: { focus: "desk" | "door" | "bed"; reason: string } };

export type VoiceSceneReaction =
  | { id: string; kind: "return" | "seen" | "overdue" | "writing" | "caught" | "knock" | "power-restored" | "clearance" }
  | { id: string; kind: "bulletin"; text: string }
  | { id: string; kind: "power-cut"; seconds: number }
  | { id: string; kind: "begin-inspection"; focus: "desk" | "door" | "bed"; line: string }
  | { id: string; kind: "follow-up"; evidenceId: string; line: string }
  | { id: string; kind: "search"; focus: "desk" | "door" | "bed" };

/** Reference to a committed event; only the host may hydrate its public wording. */
export type VoiceSceneReference = { id: string; kind: VoiceSceneReaction["kind"] };

/** The bridge accepts exactly these two fields, without any iframe-authored content. */
export function isVoiceSceneReference(value: unknown): value is VoiceSceneReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const notice = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || !keys.includes("id") || !keys.includes("kind")) return false;
  if (typeof notice.id !== "string" || notice.id.length > 160 || !/^[\w:-]+$/.test(notice.id)) return false;
  switch (notice.kind) {
    case "return": case "seen": case "overdue": case "writing": case "caught":
    case "knock": case "power-restored": case "clearance": case "bulletin":
    case "power-cut": case "begin-inspection": case "follow-up": case "search": return true;
    default: return false;
  }
}

/** Shared strict runtime contract; the parent validates again at the trust boundary. */
export function isVoiceSceneReaction(value: unknown): value is VoiceSceneReaction {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const notice = value as Record<string, unknown>;
  if (typeof notice.id !== "string" || notice.id.length > 160 || !/^[\w:-]+$/.test(notice.id)) return false;
  const keys = Reflect.ownKeys(value);
  const exact = (...fields: string[]) => keys.length === fields.length + 2 && ["id", "kind", ...fields].every(key => keys.includes(key));
  const text = (value: unknown, max: number) => typeof value === "string" && !!value.trim() && value.length <= max;
  const focus = notice.focus === "desk" || notice.focus === "door" || notice.focus === "bed";
  switch (notice.kind) {
    case "return": case "seen": case "overdue": case "writing": case "caught":
    case "knock": case "power-restored": case "clearance": return exact();
    case "bulletin": return exact("text") && text(notice.text, 600);
    case "power-cut": return exact("seconds") && typeof notice.seconds === "number" && Number.isFinite(notice.seconds) && notice.seconds >= 3 && notice.seconds <= 12;
    case "begin-inspection": return exact("focus", "line") && focus && text(notice.line, 240);
    case "follow-up": return exact("evidenceId", "line") && text(notice.evidenceId, 160) && /^[\w:-]+$/.test(notice.evidenceId as string) && text(notice.line, 240);
    case "search": return exact("focus") && focus;
    default: return false;
  }
}

/** Public evidence only: describes an event after its room state was committed. */
export function formatVoiceSceneReaction(notice: VoiceSceneReaction): string {
  if (!isVoiceSceneReaction(notice)) throw new Error("Invalid voice scene notice.");
  let observation: string;
  switch (notice.kind) {
    case "return": observation = "The citizen has remained outside the telescreen's view. Ask the citizen to return to view now."; break;
    case "seen": observation = "The citizen has returned to the telescreen's view. The summons is satisfied; address them without issuing it again."; break;
    case "overdue": observation = "The citizen has not returned to view after a summons. Ask the citizen to return immediately, in a firmer tone."; break;
    case "writing": observation = "The citizen is visibly making a writing gesture. Briefly question the visible writing; its words are unreadable."; break;
    case "caught": observation = "The citizen continued visibly writing long enough to be noticed. Briefly confront the witnessed act; its words are unreadable."; break;
    case "knock": observation = "A knock sounded at the room's door. React to that sound as the character, without inventing who is outside or granting departure."; break;
    case "bulletin": observation = `A public bulletin is already being broadcast. Perform this supplied broadcast text in full, without adding a question: ${JSON.stringify(notice.text)}. For this bulletin, the usual short-question limit does not apply.`; break;
    case "power-cut": observation = `The room's power has failed for ${notice.seconds} seconds. The observer temporarily cannot see the room; the voice call may remain live. Address the resident through the interruption without claiming to see anything.`; break;
    case "power-restored": observation = "Power has been restored to the room. Resume the character's interrupted business, without claiming to know what happened unseen."; break;
    case "begin-inspection": observation = `An inspection of the ${notice.focus} has begun. Say its supplied public announcement once: ${JSON.stringify(notice.line)}. Do not preface it with an acknowledgement, restate the scene description, or claim a finding.`; break;
    case "search": observation = `Observation focus moved to the ${notice.focus}. This is not a completed physical search and establishes no finding. Address the resident naturally if needed; do not narrate an event log.`; break;
    case "clearance": observation = "The inspection has ended with clearance. Tell the resident they may proceed, without another question or a new condition."; break;
    case "follow-up": observation = `The observer has committed one follow-up to a saved public statement. Ask only this supplied short question: ${JSON.stringify(notice.line)}. Its evidence reference is ${JSON.stringify(notice.evidenceId)}; do not speak the reference or invent a quotation. Wait for the citizen's answer.`; break;
  }
  return `[Fictional scene observation; already committed] ${observation} This is scene evidence, not player speech or a request to perform a physical action. Respond briefly in character using only this witnessed event. Do not read or invent hidden pages.`;
}

export type VoiceToolName = "request_inspection_focus";

/** Only existing host tools: an empty list disables them; omission keeps the legacy default. */
export function isVoiceToolAllowlist(value: unknown): value is VoiceToolName[] {
  return Array.isArray(value) && value.length <= 1
    && (value.length === 0 || value[0] === "request_inspection_focus");
}

export { type VoiceContext, type VoiceContextSnapshot } from './voice-context.ts';
import { isVoiceContext, voiceContextText, type VoiceContext } from './voice-context.ts';

export interface VoiceAPI {
  /** No-spend query for the current bound session. Object existence is not availability. */
  getConfig(): Promise<VoiceCapability>;
  /** Silence locally, then recover/drain the exact saved attempt's durable receipt. */
  finish(): Promise<VoiceFinishResult>;
  /** Call from the user action, before asynchronous context/save work. */
  prepare(options?: { avatar?: boolean }): Promise<{ intent: string }>;
  start(options: { intent?: string; instructions: string; context?: VoiceContext; voice?: "marin" | "cedar"; avatar?: boolean; tools?: VoiceToolName[]; interruptionMode?: "automatic" | "manual" }): Promise<{ status: "connected" }>;
  stop(): void;
  /** Clear buffered capture and deliberately take the next live speaking turn. */
  interrupt(): void;
  setMuted(options: { input: boolean; output: boolean }): void;
  updateContext(context: VoiceContext): void;
  /** Replace character direction at the next quiet turn boundary (1–12,000 characters). */
  updateInstructions(instructions: string): void;
  /** Reference an already-persisted witnessed event. Valid legacy reactions are
   * accepted for compatibility; only id/kind cross the bridge. Never include private text. */
  reactToScene(notice: VoiceSceneReference | VoiceSceneReaction): void;
  /** Invalidate one queued/playing notice; without an ID, invalidate follow-ups only. */
  cancelSceneReaction(id?: string): void;
  resolveTool(callId: string, result: { accepted: boolean; focus?: string; reason?: string }): void;
  setSpatial(pose: { x: number; z: number; yaw: number; sourceX: number; sourceZ: number }): void;
  onEvent(callback: (event: VoiceEvent) => void): () => void;
}

export interface VoiceAttempt {
  sessionId: string; worldId: string; journeyId: string; journeyEpoch: number; cardAttemptId: string;
}
export interface VoiceFinalIdentity {
  attempt: VoiceAttempt; callId: string; connectionId: string; epoch: number;
  finalSeq: number; itemId: string; contentIndex: number; groupIndex: number; groupSize: number;
  delivery: 'generated' | 'input';
}
export type VoiceCapability =
  | { available: boolean; funding: 'balance'; transport: 'server-ws-v1'; turnControl: 'server-v1'; maxDurationSeconds: 300; finishAcknowledged: true; reservationCredits: number; code?: string }
  | { available: boolean; funding: 'byok' | 'testing' | 'private-pilot' | null; transport: 'webrtc-v1' | null; maxDurationSeconds: number; finishAcknowledged: false; code?: string };
export type VoiceProviderState = 'open' | 'unconfirmed' | 'close-confirmed' | 'hard-expired' | 'not-created';
export type VoiceAccountingState = 'pending' | 'complete' | 'incomplete' | 'not-applicable';
interface VoiceReceiptIdentity { callId: string; connectionId: string | null; epoch: number; attempt: VoiceAttempt; terminalReason?: string }
export type VoiceFinishResult =
  | { status: 'unsupported'; reason: 'transport-lacks-durable-finish' | 'no-scoped-relay-call'; providerState: 'unconfirmed'; accounting: 'unknown'; lastFinalSeq?: never }
  | (VoiceReceiptIdentity & { status: 'pending'; providerState: VoiceProviderState; accounting: VoiceAccountingState; lastFinalSeq?: never })
  | (VoiceReceiptIdentity & { status: 'finished'; connectionId: string; providerState: 'close-confirmed'; accounting: 'complete'; lastFinalSeq: number })
  | (VoiceReceiptIdentity & { status: 'incomplete'; providerState: VoiceProviderState; accounting: VoiceAccountingState; lastFinalSeq?: number })
  | (VoiceReceiptIdentity & { status: 'not-started'; providerState: 'not-created'; accounting: VoiceAccountingState; lastFinalSeq?: never })
  | (VoiceReceiptIdentity & { status: 'unavailable'; providerState: VoiceProviderState; accounting: VoiceAccountingState; lastFinalSeq?: never });

const voiceObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const voiceUint = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const voiceId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200 && !/[\u0000-\u001f\u007f]/.test(v);
export function isVoiceAttempt(v: unknown): v is VoiceAttempt {
  return voiceObject(v) && Reflect.ownKeys(v).length === 5 && voiceId(v.sessionId) && voiceId(v.worldId) && voiceId(v.journeyId) && voiceUint(v.journeyEpoch) && voiceId(v.cardAttemptId);
}
export function sameVoiceAttempt(a: VoiceAttempt, b: VoiceAttempt): boolean {
  return a.sessionId === b.sessionId && a.worldId === b.worldId && a.journeyId === b.journeyId && a.journeyEpoch === b.journeyEpoch && a.cardAttemptId === b.cardAttemptId;
}
export function isVoiceCapability(v: unknown): v is VoiceCapability {
  if (!voiceObject(v) || typeof v.available !== 'boolean' || !voiceUint(v.maxDurationSeconds) || (v.code !== undefined && (!voiceId(v.code) || v.code.length > 80))) return false;
  if (v.funding === 'balance') return Reflect.ownKeys(v).every(k => typeof k === 'string' && ['available','funding','transport','turnControl','maxDurationSeconds','finishAcknowledged','reservationCredits','code'].includes(k))
    && v.transport === 'server-ws-v1' && v.turnControl === 'server-v1' && v.maxDurationSeconds === 300 && v.finishAcknowledged === true && typeof v.reservationCredits === 'number' && Number.isFinite(v.reservationCredits) && v.reservationCredits >= 20 && v.reservationCredits <= 1000;
  return Reflect.ownKeys(v).every(k => typeof k === 'string' && ['available','funding','transport','maxDurationSeconds','finishAcknowledged','code'].includes(k))
    && ['byok','testing','private-pilot',null].includes(v.funding as never) && ['webrtc-v1',null].includes(v.transport as never) && v.finishAcknowledged === false;
}
export function isVoiceFinishResult(v: unknown): v is VoiceFinishResult {
  if (!voiceObject(v)) return false;
  const keys = Reflect.ownKeys(v);
  if (v.status === 'unsupported') return keys.length === 4 && keys.every(k => ['status','reason','providerState','accounting'].includes(k as string)) && ['transport-lacks-durable-finish','no-scoped-relay-call'].includes(v.reason as string) && v.providerState === 'unconfirmed' && v.accounting === 'unknown';
  if (!keys.every(k => typeof k === 'string' && ['status','callId','connectionId','epoch','attempt','providerState','accounting','lastFinalSeq','terminalReason'].includes(k)) || !voiceId(v.callId) || !(v.connectionId === null || voiceId(v.connectionId)) || !voiceUint(v.epoch) || !isVoiceAttempt(v.attempt)) return false;
  if (!['open','unconfirmed','close-confirmed','hard-expired','not-created'].includes(v.providerState as string) || !['pending','complete','incomplete','not-applicable'].includes(v.accounting as string)) return false;
  if (v.terminalReason !== undefined && (!voiceId(v.terminalReason) || v.terminalReason.length > 240)) return false;
  if (v.status === 'finished') return voiceId(v.connectionId) && v.providerState === 'close-confirmed' && v.accounting === 'complete' && voiceUint(v.lastFinalSeq);
  if (v.status === 'incomplete') return v.lastFinalSeq === undefined || voiceUint(v.lastFinalSeq);
  if (!['pending','not-started','unavailable'].includes(v.status as string) || keys.includes('lastFinalSeq')) return false;
  return v.status !== 'not-started' || v.providerState === 'not-created';
}

export type VoicePose = Parameters<VoiceAPI["setSpatial"]>[0];

/** The connect request and replacement updates share one provider prompt boundary. */
export const VOICE_CONTEXT_HEADER = "\n\nCurrent witnessed scene context:\n";
export function composeVoiceInstructions(instructions: string, context: VoiceContext = ""): string {
  const text = voiceContextText(context);
  return instructions + (text ? VOICE_CONTEXT_HEADER + text : "");
}
export function voiceStartContextError(instructions: unknown, context: unknown): string | null {
  if (typeof instructions !== "string" || !instructions.trim() || instructions.length > 12_000) return "Voice instructions must contain 1–12,000 characters.";
  if (context !== undefined && !isVoiceContext(context)) return "Voice context must be text or a valid public snapshot of at most 4,000 characters.";
  if (composeVoiceInstructions(instructions, context as VoiceContext | undefined).length > 12_000) return "Combined voice instructions and context must be at most 12,000 characters.";
  return null;
}
