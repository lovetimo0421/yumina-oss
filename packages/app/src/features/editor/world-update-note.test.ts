import assert from "node:assert/strict";
import { test } from "node:test";
import { postWorldUpdateNote } from "./world-update-note.js";

test("live update notes use the public update endpoint and normalized payload", async () => {
  let url = "";
  let init: RequestInit | undefined;
  const fetcher = (async (input: URL | RequestInfo, requestInit?: RequestInit) => {
    url = String(input);
    init = requestInit;
    return new Response("{}", { status: 201 });
  }) as typeof fetch;

  await postWorldUpdateNote({
    worldId: "world / one",
    title: "  Added chapter 3  ",
    content: "  New ending  ",
    isMajor: true,
    held: false,
    apiBase: "https://api.example",
    fetcher,
  });

  assert.equal(url, "https://api.example/api/worlds/world%20%2F%20one/updates");
  assert.equal(init?.credentials, "include");
  assert.deepEqual(JSON.parse(String(init?.body)), {
    title: "Added chapter 3",
    content: "New ending",
    isMajor: true,
  });
});

test("held update notes stay attached to the moderation workflow", async () => {
  let url = "";
  const fetcher = (async (input: URL | RequestInfo) => {
    url = String(input);
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  await postWorldUpdateNote({
    worldId: "world-a",
    title: "Fix",
    content: "   ",
    isMajor: false,
    held: true,
    fetcher,
  });

  assert.equal(url, "/api/worlds/world-a/pending/update-note");
});

test("failed responses reject so the dialog can preserve the author's text", async () => {
  const fetcher = (async () => new Response("{}", { status: 409 })) as typeof fetch;
  await assert.rejects(
    postWorldUpdateNote({
      worldId: "world-a",
      title: "Fix",
      content: "Details",
      isMajor: false,
      held: false,
      fetcher,
    }),
    /409/,
  );
});

test("blank titles are rejected before a request is sent", async () => {
  let called = false;
  const fetcher = (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  await assert.rejects(
    postWorldUpdateNote({
      worldId: "world-a",
      title: "   ",
      content: "",
      isMajor: false,
      held: false,
      fetcher,
    }),
    /required/,
  );
  assert.equal(called, false);
});
