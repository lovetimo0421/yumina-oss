import test from "node:test";
import assert from "node:assert/strict";
import { recoverSummaryEpisode, StorySummaryTruncatedError, type EpisodeCheckpoint } from "./summary-episode-recovery.js";
import { finalizeStorySummaryOutput, summarizeStoryEpisodeTranscripts } from "./session-compaction-core.js";

function cache() {
  const values = new Map<string, EpisodeCheckpoint>();
  return { values, load: async (text: string) => values.get(text) ?? null,
    save: async (text: string, result: EpisodeCheckpoint) => { values.set(text, result); } };
}
const result = (text: string): EpisodeCheckpoint => ({ text, refusalFallbackUsed: false });

test("truncated provider output splits into two Unicode-safe halves once", async () => {
  const stored = cache();
  const calls: string[] = [];
  const output = await recoverSummaryEpisode({ ...stored, transcript: "甲😀乙丙", generate: async text => {
    calls.push(text);
    if (calls.length === 1) return { text: await finalizeStorySummaryOutput({ text: "partial", stopReason: "max_tokens" }), refusalFallbackUsed: false };
    return result(text);
  } });
  assert.deepEqual(calls, ["甲😀乙丙", "甲😀", "乙丙"]);
  assert.equal(output.map(item => item.text).join(""), "甲😀乙丙");
  assert.deepEqual(stored.values.get("甲😀乙丙"), { text: "", refusalFallbackUsed: false, split: true }, "only the split decision is cached, never truncated output");
});

test("a truncated half stops without recursive retries", async () => {
  let calls = 0;
  await assert.rejects(recoverSummaryEpisode({ ...cache(), transcript: "abcd", generate: async () => {
    calls++;
    throw new StorySummaryTruncatedError();
  } }), StorySummaryTruncatedError);
  assert.equal(calls, 2);
});

test("recovery halves request compact output and reuse only their matching prompt mode", async () => {
  const values = new Map<string, EpisodeCheckpoint>([["full:ab", result("full-output-for-ab")]]);
  const calls: Array<[string, boolean]> = [];
  const key = (text: string, recovery: boolean) => `${recovery ? "compact" : "full"}:${text}`;
  let failSecondHalf = true;
  const args = {
    transcript: "abcd",
    load: async (text: string, recovery: boolean) => values.get(key(text, recovery)) ?? null,
    save: async (text: string, output: EpisodeCheckpoint, recovery: boolean) => { values.set(key(text, recovery), output); },
    generate: async (text: string, recovery: boolean) => {
      calls.push([text, recovery]);
      if (!recovery) throw new StorySummaryTruncatedError();
      if (text === "cd" && failSecondHalf) throw new Error("temporary provider failure");
      return result(`compact-output-for-${text}`);
    },
  };
  await assert.rejects(recoverSummaryEpisode(args), /temporary provider failure/);
  failSecondHalf = false;
  const output = await recoverSummaryEpisode(args);
  assert.deepEqual(calls, [["abcd", false], ["ab", true], ["cd", true], ["cd", true]]);
  assert.deepEqual(output.map(item => item.text), ["compact-output-for-ab", "compact-output-for-cd"]);
  assert.equal(values.get("full:ab")?.text, "full-output-for-ab");
});

test("provider refusals are surfaced without split retries", async () => {
  let calls = 0;
  await assert.rejects(recoverSummaryEpisode({ ...cache(), transcript: "abcd", generate: async () => {
    calls++; throw new Error("content filter");
  } }), /content filter/);
  assert.equal(calls, 1);
});

test("later attempt reuses successful halves and preserves fallback metadata", async () => {
  const stored = cache();
  const calls: string[] = [];
  let failing = true;
  const generate = async (text: string) => {
    calls.push(text);
    if (text === "abcd") throw new StorySummaryTruncatedError();
    if (text === "cd" && failing) throw new Error("provider unavailable");
    return { text, refusalFallbackUsed: text === "ab" };
  };
  await assert.rejects(recoverSummaryEpisode({ ...stored, transcript: "abcd", generate }), /provider unavailable/);
  failing = false;
  const output = await recoverSummaryEpisode({ ...stored, transcript: "abcd", generate });
  await recoverSummaryEpisode({ ...stored, transcript: "abcd", generate });
  assert.deepEqual(calls, ["abcd", "ab", "cd", "cd"], "completed recovery is reused without another parent or half call");
  assert.equal(output[0]!.refusalFallbackUsed, true);
});

test("batch waits for successful siblings and reuses them after a failed attempt", async () => {
  const stored = cache();
  const calls: string[] = [];
  let failing = true;
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const generate = async (text: string) => {
    calls.push(text);
    if (text === "bad" && failing) throw new Error("provider unavailable");
    if (text === "good") await waiting;
    return result(text);
  };
  const run = () => summarizeStoryEpisodeTranscripts({ transcripts: ["bad", "good"], concurrency: 4, probeFirst: false,
    summarize: transcript => recoverSummaryEpisode({ ...stored, transcript, generate }) });
  let settled = false;
  const first = run();
  void first.catch(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, "must not release job while siblings are billing/checkpointing");
  release();
  await assert.rejects(first, /provider unavailable/);
  failing = false;
  await run();
  assert.deepEqual(calls, ["bad", "good", "bad"]);
});
