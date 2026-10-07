import { formatVoiceSceneReaction, type VoiceEvent, type VoiceSceneReaction } from "../../../sandbox/voice-types";
import { policeSceneAuthority } from "./voice-scene-notice";
import { type VoiceContext } from '../../../sandbox/voice-context';
import { LiveVoiceContext, liveTextPackets } from './live-voice-context';

interface Dependencies {
  send(event: Record<string, unknown>): void;
  emit(event: VoiceEvent): void;
  input(enabled: boolean): void;
  holdAudio?(held: boolean): void;
  interruptAudio(): void;
  fail(message: string): void;
}
type Caption = { id: string; text: string; end: number; timer?: ReturnType<typeof setTimeout> };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** GPT-Live has no response.create/done lifecycle. Audio protection follows
 * source and avatar playback; transcript grouping never clears the speaker. */
export class LiveVoiceSession {
  readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private started = false;
  private closed = false;
  private source = false;
  private pending = false;
  private queueManaged = false;
  private playing = false;
  private protected = false;
  private interrupted = false;
  private muted = { input: false, output: false };
  private seq = 0;
  private release?: ReturnType<typeof setTimeout>;
  private awaitingAudio?: ReturnType<typeof setTimeout>;
  private userQuiet?: ReturnType<typeof setTimeout>;
  private userDeadline?: ReturnType<typeof setTimeout>;
  private userSpeaking = false;
  private holding = false;
  private captions: Partial<Record<"user" | "assistant", Caption>> = {};
  private events = new Set<string>();
  private scenes = new Map<string, VoiceSceneReaction>();
  private sceneIds = new Set<string>();
  private contextDirty = false;
  private instructionsDirty = false;
  private sentInstructions: string;
  private contextLedger: LiveVoiceContext;
  constructor(private deps: Dependencies, private instructions: string, context: VoiceContext, private mode: "manual" | "automatic", pendingContext?: LiveVoiceContext) {
    this.sentInstructions = instructions;
    this.contextLedger = pendingContext ?? new LiveVoiceContext(context);
    this.ready = new Promise(resolve => { this.resolveReady = resolve; });
  }
  start() {
    if (this.closed || !this.started) return;
    this.append("instructions", "The session just started. The user is listening but has not spoken yet. Immediately speak first; do not wait for the user. Use the character's opening instruction, or continue the last unanswered point from saved history. Speak only the character's words, never plans, analysis or stage directions. Then pause and listen.");
    this.applyInput();
  }
  receive(event: Record<string, unknown>) {
    if (this.closed) return;
    if (typeof event.event_id === "string") {
      if (this.events.has(event.event_id)) return;
      this.events.add(event.event_id);
      if (this.events.size > 2048) this.events.delete(this.events.values().next().value!);
    }
    if (event.type === "session.started") {
      this.started = true; this.resolveReady(); return;
    }
    if (event.type === "session.closed") {
      this.deps.fail("The live conversation ended. Reconnect to continue from your saved room."); return;
    }
    if (event.type === "error") {
      if (!this.started) this.deps.fail("The live conversation could not start. Reconnect to continue.");
      else this.deps.emit({ type: "input-hint", message: "The telescreen could not process an update. The call is still connected." });
      // Rejected commands and non-closing moderation errors do not imply a
      // transport failure. Only session.closed owns session teardown.
      return;
    }
    if (event.type === "session.delegation.created") {
      const id = object(event.delegation) ? event.delegation.id : undefined;
      if (typeof id !== "string" || id.length > 160) return;
      // The room director remains the sole physical-action authority. Never
      // promise that a delegated request itself has enacted a world event.
      this.append("instructions", "Reply as the character using the latest supplied public observations and the resident's actual words. Speak only the reply; never voice planning or system notes. This request authorized no physical change, search, discovery or arrival. Do not invent one or promise to alter the register. Keep the reply brief, then listen.", id);
      return;
    }
    const role = event.type === "session.input_transcript.delta" ? "user" : event.type === "session.output_transcript.delta" ? "assistant" : null;
    if (!role || typeof event.delta !== "string" || !event.delta || event.delta.length > 8000) return;
    if (role === "user") {
      // Capture itself is gated during playback. Recognition can arrive late:
      // never discard real words merely because the reply has already begun.
      this.interrupted = false;
    } else {
      if (this.muted.output || this.interrupted) return;
      // Transcripts can precede the first remote PCM packet. Close capture
      // before the avatar can put that sound back into a sensitive microphone.
      this.protect();
      if (!this.source && !this.pending && !this.playing && !this.awaitingAudio) {
        this.awaitingAudio = setTimeout(() => {
          this.awaitingAudio = undefined;
          if (!this.closed && !this.source && !this.pending && !this.playing) this.releaseWhenQuiet();
        }, 8000);
      }
    }
    let caption = this.captions[role];
    const start = typeof event.start_ms === "number" && Number.isFinite(event.start_ms) ? event.start_ms : undefined;
    const end = typeof event.end_ms === "number" && Number.isFinite(event.end_ms) ? event.end_ms : start ?? 0;
    if (caption && (caption.text.length + event.delta.length > 12000 || start !== undefined && start - caption.end > 1500)) {
      this.finishCaption(role); caption = undefined;
    }
    if (!caption) {
      caption = { id: `live:${role}:${++this.seq}`, text: "", end };
      this.captions[role] = caption;
      if (role === "user") this.deps.emit({ type: "input", status: "speaking", id: caption.id });
    }
    caption.text += event.delta; caption.end = Math.max(caption.end, end);
    this.deps.emit({ type: "transcript", role, id: caption.id, text: caption.text, final: false });
    clearTimeout(caption.timer);
    // This is a durable transcript grouping boundary, not an audio-end signal.
    caption.timer = setTimeout(() => this.finishCaption(role), 1400);
  }
  private finishCaption(role: "user" | "assistant") {
    const caption = this.captions[role]; if (!caption) return;
    clearTimeout(caption.timer); delete this.captions[role];
    if (!caption.text.trim() || this.closed) return;
    if (role === "user") this.deps.emit({ type: "input", status: "transcribing", id: caption.id });
    this.deps.emit({ type: "transcript", role, id: caption.id, text: caption.text, final: true });
  }
  sourceActivity(active: boolean) {
    if (this.closed) return;
    this.source = active;
    if (active) { clearTimeout(this.awaitingAudio); this.awaitingAudio = undefined; this.protect(); }
    else this.releaseWhenQuiet();
  }
  avatarPending() { if (!this.closed) { this.pending = true; this.protect(); } }
  avatarQueue(count: number) {
    if (this.closed) return;
    this.queueManaged = true; this.pending = count > 0;
    if (this.pending) this.protect(); else this.releaseWhenQuiet();
  }
  playback(state: "started" | "stopped" | "cleared") {
    if (this.closed) return;
    if (!this.queueManaged) this.pending = false;
    this.playing = state === "started";
    if (this.playing) this.protect(); else this.releaseWhenQuiet();
    this.activity();
  }
  private protect() {
    if (this.muted.output) return;
    // A continuous model may begin a backchannel before the user finishes.
    // Hold its avatar packets, not the rest of the user's microphone sentence.
    if (!this.protected && this.userSpeaking && this.mode === 'manual' && this.deps.holdAudio) {
      this.holding = true; this.deps.holdAudio(true);
      this.userDeadline = setTimeout(() => {
        this.userDeadline = undefined;
        if (this.closed || !this.holding) return;
        // Bound speculative output without clipping a long resident sentence.
        // None of this held audio has reached the avatar speaker yet.
        this.deps.interruptAudio();
        this.source = false; this.pending = false; this.playing = false;
        clearTimeout(this.awaitingAudio); this.awaitingAudio = undefined;
        this.holding = false; this.protected = false;
        this.deps.holdAudio?.(false); this.applyInput();
        this.append('instructions', 'The resident is still speaking. Listen without interrupting. Wait for them to finish before replying.');
      }, 10000);
    }
    clearTimeout(this.release); this.release = undefined; this.protected = true;
    this.applyInput(); this.activity();
  }
  inputLevel(value: number) {
    if (this.closed || this.muted.input || this.protected && !this.holding || !Number.isFinite(value) || value < .025) return;
    this.userSpeaking = true; clearTimeout(this.userQuiet);
    // A sentence can contain an ordinary clause pause. Real microphone fixtures
    // include 950 ms pauses; the old 650 ms boundary clipped their next words.
    this.userQuiet = setTimeout(() => { this.userQuiet = undefined; this.finishUserFloor(); }, 1200);
  }
  private finishUserFloor() {
    this.userSpeaking = false; clearTimeout(this.userDeadline); this.userDeadline = undefined;
    if (!this.holding) return;
    this.holding = false;
    this.applyInput(); // Silence capture before a queued word can reach speakers.
    this.deps.holdAudio?.(false);
    this.releaseWhenQuiet();
  }
  private releaseWhenQuiet() {
    if (this.closed || this.holding || !this.muted.output && (this.source || this.pending || this.playing || this.awaitingAudio) || this.release) return;
    this.release = setTimeout(() => {
      this.release = undefined;
      if (this.closed || this.holding || !this.muted.output && (this.source || this.pending || this.playing || this.awaitingAudio)) return;
      this.protected = false; this.applyInput(); this.activity(); this.flush();
    }, 650);
  }
  private applyInput() { this.deps.input(!this.closed && !this.muted.input && !(this.mode === "manual" && this.protected && !this.holding)); }
  private activity() {
    this.deps.emit({ type: "activity", status: this.muted.output ? "listening" : this.playing ? "speaking" : this.protected ? "thinking" : "listening" });
  }
  interrupt() {
    if (this.closed || !this.started || this.muted.output) return;
    this.cancelPlayback();
    this.append("instructions", "Stop speaking now. The resident deliberately took the floor. Listen to their next words before replying. Do not finish the abandoned sentence.");
  }
  private cancelPlayback() {
    this.interrupted = true;
    this.finishCaption("assistant");
    clearTimeout(this.awaitingAudio); this.awaitingAudio = undefined;
    this.deps.interruptAudio(); this.source = false; this.pending = false; this.playing = false;
    this.finishUserFloor();
    this.releaseWhenQuiet();
  }
  setMuted(value: { input: boolean; output: boolean }) {
    if (this.closed) return;
    const resumed = this.muted.output && !value.output;
    const newlySilent = value.output && !this.muted.output;
    this.muted = value;
    // Muting is a playback preference, not testimony or a fictional action.
    // Only the explicit interrupt control may tell the actor who took the floor.
    if (newlySilent) this.cancelPlayback();
    if (resumed && (this.source || this.pending || this.playing)) {
      // Output may have continued inaudibly. Protect capture BEFORE the
      // controller reopens speakers, even if the user spoke while muted.
      this.finishUserFloor(); this.protect();
    }
    this.applyInput();
    if (value.input) this.finishUserFloor();
    if (resumed) this.interrupted = false;
    if (!value.output) this.flush();
  }
  updateContext(value: VoiceContext) {
    if (this.closed) return;
    try { this.contextLedger.offer(value); }
    catch { this.deps.fail('Too many room updates arrived during voice playback. Reconnect to continue from your saved room.'); return; }
    this.contextDirty = true; this.flush();
  }
  setStartupContext(value: VoiceContext) {
    if (this.closed || this.started) return;
    try { this.contextLedger.setStartup(value); }
    catch { this.deps.fail('Too many room updates arrived while connecting voice. Reconnect to continue from your saved room.'); return; }
    this.contextDirty = true;
  }
  updateInstructions(value: string) {
    if (value === this.instructions) return;
    this.instructions = value; this.instructionsDirty = true; this.flush();
  }
  setStartupInstructions(value: string) {
    if (this.closed || this.started) return;
    // The HTTP request may use newer direction than the constructor received
    // while permission/SDP was pending. This is the provider's actual baseline.
    this.sentInstructions = value;
    this.instructionsDirty = this.instructions !== value;
  }
  scene(notice: VoiceSceneReaction) {
    if (this.closed || this.sceneIds.has(notice.id) || this.sceneIds.size >= 128) return;
    this.sceneIds.add(notice.id); this.scenes.set(notice.id, notice); this.flush();
  }
  cancelScene(id?: string) {
    for (const [key, notice] of this.scenes) if (id === undefined ? notice.kind === "follow-up" : id === key) this.scenes.delete(key);
  }
  private flush() {
    if (!this.started || this.closed || this.protected || this.muted.output || this.interrupted) return;
    if (this.contextDirty) {
      this.contextDirty = false;
      for (const update of this.contextLedger.drain()) this.append('thinking', update);
    }
    if (this.instructionsDirty) {
      this.instructionsDirty = false;
      if (this.instructions !== this.sentInstructions) {
        // Appends enter the continuous model over time, not atomically. A new
        // complete lore paragraph need not replay all its unchanged direction.
        // Compare against sent content: intermediate queued snapshots were never
        // delivered. Rewrites/removals and inline edits retain the full update.
        const added = this.instructions.startsWith(this.sentInstructions)
          ? this.instructions.slice(this.sentInstructions.length) : '';
        this.append('instructions', /^(?:\r?\n){2}/.test(added) ? added : this.instructions);
        this.sentInstructions = this.instructions;
      }
    }
    for (const [id, notice] of this.scenes) {
      this.scenes.delete(id);
      const current = policeSceneAuthority(notice);
      if (current && !current()) continue;
      this.append("instructions", formatVoiceSceneReaction(notice));
      // One physical cue per quiet boundary; avoid competing queued prompts.
      this.protect();
      this.awaitingAudio = setTimeout(() => { this.awaitingAudio = undefined; this.releaseWhenQuiet(); }, 8000);
      break;
    }
  }
  private append(kind: "instructions" | "thinking" | "commentary", content: string, delegationId: string | null = null) {
    if (this.closed || !this.started) return;
    // The API bounds appends to 500 tokens. A UTF-8 byte ceiling below 500
    // remains conservative across scripts without a browser tokenizer.
    for (const chunk of liveTextPackets(content)) this.deps.send({ type: `session.${kind}.append`, event_id: `live-append-${++this.seq}`, delegation_id: delegationId, content: chunk });
  }
  close() {
    if (this.closed) return;
    this.finishCaption("user"); this.finishCaption("assistant");
    this.closed = true;
    if (this.started) this.deps.send({ type: "session.close", event_id: `live-close-${++this.seq}` });
    clearTimeout(this.release); clearTimeout(this.awaitingAudio);
    clearTimeout(this.userQuiet); clearTimeout(this.userDeadline);
    this.scenes.clear(); this.events.clear(); this.deps.input(false);
  }
}
