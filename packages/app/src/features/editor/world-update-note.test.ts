import assert from "node:assert/strict";
import { test } from "node:test";
import { subscribeToPublishedWorldUpdates } from "../library/world-update-history-data.js";
import { postWorldUpdateNote } from "./world-update-note.js";

test("live update notes use the public update endpoint and notify history after success", async (t) => {
  let url = "";
  let init: RequestInit | undefined;
  let notifications = 0;
  t.after(subscribeToPublishedWorldUpdates(() => { notifications += 1; }));
  const fetcher = (async (input: URL | RequestInfo, requestInit?: RequestInit) => {
    url = String(input);
    init = requestInit;
    assert.equal(notifications, 0);
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
  assert.equal(notifications, 1);
});

test("held update notes stay attached to moderation without refreshing public history", async (t) => {
  let url = "";
  let notifications = 0;
  t.after(subscribeToPublishedWorldUpdates(() => { notifications += 1; }));
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
  assert.equal(notifications, 0);
});

test("failed responses reject without notifying history", async (t) => {
  let notifications = 0;
  t.after(subscribeToPublishedWorldUpdates(() => { notifications += 1; }));
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
  assert.equal(notifications, 0);
});

test("blank titles are rejected before a request or history notification", async (t) => {
  let called = false;
  let notifications = 0;
  t.after(subscribeToPublishedWorldUpdates(() => { notifications += 1; }));
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
  assert.equal(notifications, 0);
});

test("unsubscribed history listeners are not called after a live update", async () => {
  let notifications = 0;
  const unsubscribe = subscribeToPublishedWorldUpdates(() => { notifications += 1; });
  unsubscribe();

  await postWorldUpdateNote({
    worldId: "world-a",
    title: "Fix",
    content: "Details",
    isMajor: false,
    held: false,
    fetcher: (async () => new Response("{}", { status: 201 })) as typeof fetch,
  });

  assert.equal(notifications, 0);
});

test("network failures do not notify history", async (t) => {
  let notifications = 0;
  t.after(subscribeToPublishedWorldUpdates(() => { notifications += 1; }));
  await assert.rejects(postWorldUpdateNote({
    worldId: "world-a",
    title: "Fix",
    content: "Details",
    isMajor: false,
    held: false,
    fetcher: (async () => { throw new TypeError("Network unavailable"); }) as typeof fetch,
  }), /Network unavailable/);

  assert.equal(notifications, 0);
});
