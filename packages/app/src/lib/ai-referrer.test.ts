import assert from "node:assert/strict";
import test from "node:test";
import { aiReferrerFromHost, detectAiReferrer, forgetAiReferrer, rememberAiReferrer } from "./ai-referrer";

test("each assistant's host maps to its name; subdomains count, anything else is absent", () => {
  assert.equal(aiReferrerFromHost("chatgpt.com"), "chatgpt");
  assert.equal(aiReferrerFromHost("chat.openai.com"), "chatgpt");
  assert.equal(aiReferrerFromHost("claude.ai"), "claude");
  assert.equal(aiReferrerFromHost("perplexity.ai"), "perplexity");
  assert.equal(aiReferrerFromHost("gemini.google.com"), "gemini");
  assert.equal(aiReferrerFromHost("copilot.microsoft.com"), "copilot");
  assert.equal(aiReferrerFromHost("www.perplexity.ai"), "perplexity");
  assert.equal(aiReferrerFromHost("CHATGPT.COM"), "chatgpt");
  assert.equal(aiReferrerFromHost("google.com"), null, "the search engine is not the assistant");
  assert.equal(aiReferrerFromHost("openai.com"), null);
  assert.equal(aiReferrerFromHost("notchatgpt.com"), null, "a suffix match needs the dot");
  assert.equal(aiReferrerFromHost(""), null);
  assert.equal(aiReferrerFromHost(null), null);
});

test("the referrer decides first; utm_source covers links the assistant tagged; a bad referrer is ignored", () => {
  assert.equal(detectAiReferrer({ referrer: "https://chatgpt.com/", search: "" }), "chatgpt");
  assert.equal(detectAiReferrer({ referrer: "https://www.google.com/", search: "?utm_source=chatgpt.com" }), "chatgpt", "utm wins when the referrer is not an assistant");
  assert.equal(detectAiReferrer({ referrer: "", search: "?utm_source=perplexity" }), "perplexity");
  assert.equal(detectAiReferrer({ referrer: "", search: "?utm_source=Claude.ai&utm_medium=x" }), "claude");
  assert.equal(detectAiReferrer({ referrer: "not a url", search: "?utm_source=gemini" }), "gemini");
  assert.equal(detectAiReferrer({ referrer: "https://reddit.com/", search: "?utm_source=reddit" }), null);
  assert.equal(detectAiReferrer({ referrer: "", search: "" }), null);
  assert.equal(detectAiReferrer({ referrer: null, search: null }), null);
});

test("the first value of the session is kept, stored, and preferred over a later page", () => {
  const stored = new Map<string, string>();
  const storage = { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v) };
  forgetAiReferrer();
  assert.equal(rememberAiReferrer({ referrer: "https://claude.ai/chat/1", search: "", storage }), "claude");
  assert.deepEqual([...stored.values()], ["claude"]);
  // Same tab, later navigation: the remembered value, not the new referrer.
  assert.equal(rememberAiReferrer({ referrer: "https://chatgpt.com/", search: "", storage }), "claude");
  // A reload in the same session reads it back from storage.
  forgetAiReferrer();
  assert.equal(rememberAiReferrer({ referrer: "", search: "", storage }), "claude");
  // No assistant anywhere: nothing stored, nothing reported.
  forgetAiReferrer();
  const empty = new Map<string, string>();
  const none = { getItem: (k: string) => empty.get(k) ?? null, setItem: (k: string, v: string) => void empty.set(k, v) };
  assert.equal(rememberAiReferrer({ referrer: "https://x.test/", search: "", storage: none }), null);
  assert.equal(empty.size, 0);
  // Storage that throws (private mode) still answers for this tab.
  forgetAiReferrer();
  const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  assert.equal(rememberAiReferrer({ referrer: "https://copilot.microsoft.com/", search: "", storage: broken }), "copilot");
  forgetAiReferrer();
});
