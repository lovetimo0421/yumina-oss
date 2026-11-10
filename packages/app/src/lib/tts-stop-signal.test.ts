import test from "node:test";
import assert from "node:assert/strict";
import * as stop from "./tts-stop-signal";
test("stop invalidates a voice request waiting for its first module import", async () => {
  const load = (
    stop as typeof stop & {
      loadTtsUnlessHalted?: <T>(loader: () => Promise<T>) => Promise<T | null>;
    }
  ).loadTtsUnlessHalted;
  assert.equal(typeof load, "function");
  let resolve!: (value: string) => void;
  const pending = load!(
    () =>
      new Promise<string>((r) => {
        resolve = r;
      }),
  );
  stop.haltTts();
  resolve("obsolete module");
  assert.equal(await pending, null);
  assert.equal(
    await load!(() => Promise.resolve("new request")),
    "new request",
  );
});
