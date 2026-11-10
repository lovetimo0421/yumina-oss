import { describe, expect, it } from "vitest";
import { firstMatchIn, frontendManifest, interfaceSendsChat } from "./frontend-manifest";

describe("what an interface does on its own", () => {
  it("finds a live voice, the scene it is told, timers and scene events", () => {
    const files = {
      "room.tsx": "const voice = api.realtimeVoice;\nvoice.updateContext(snapshot());\nsetTimeout(next, 500);",
      "stage.tsx": "api.setScene({ room }, { events: [{ name: \"send the police\", when: \"the player hides\" }] });",
    };
    const m = frontendManifest(files);
    expect(m.uses).toEqual(expect.arrayContaining(["liveVoice", "scene", "timer"]));
    expect(m.sceneEvents).toEqual(["send the police"]);
    expect(firstMatchIn(files, /\brealtimeVoice\b/)).toEqual({ file: "room.tsx", line: 1 });
  });
  it("knows an interface that sends into the chat, and one that does not", () => {
    expect(interfaceSendsChat({ "a.tsx": "api.sendMessage(text)" })).toBe(true);
    expect(interfaceSendsChat({ "a.tsx": "<ChatCanvas />" })).toBe(true);
    expect(interfaceSendsChat({ "a.tsx": "api.ai.complete({ messages })" })).toBe(false);
  });
});
