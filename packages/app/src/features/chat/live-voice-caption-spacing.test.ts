import test from "node:test";
import assert from "node:assert/strict";
import { LiveVoiceSession } from "./live-voice-session";

function captions(deltas: string[]) {
  const events: any[] = [];
  const session = new LiveVoiceSession({ send() {}, emit: e => events.push(e), input() {}, interruptAudio() {}, fail: assert.fail }, "Official", "", "automatic");
  try {
    session.receive({ type: "session.started" });
    session.sourceActivity(true);
    for (const delta of deltas) session.receive({ type: "session.output_transcript.delta", delta });
    return events.filter(e => e.type === "transcript" && e.role === "assistant").at(-1)?.text;
  } finally { session.close(); }
}

test("a sentence that arrives without its leading space is separated", () => {
  assert.equal(captions(["Someone at your door just now?", "They pushed something under."]), "Someone at your door just now? They pushed something under.");
  assert.equal(captions(["6079.", "Officers are on their way."]), "6079. Officers are on their way.");
  assert.equal(captions(["No more questions", "Your candour has been noted."]), "No more questions Your candour has been noted.");
  assert.equal(captions(["Nothing otherwise.", "6079, sit."]), "Nothing otherwise. 6079, sit.");
});

test("ordinary deltas and numbers are left alone", () => {
  assert.equal(captions(["Correction ", "fourteen."]), "Correction fourteen.");
  assert.equal(captions(["It is 3.", "5 degrees."]), "It is 3.5 degrees.");
});
