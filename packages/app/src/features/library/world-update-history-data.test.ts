import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createWorldUpdate,
  fetchWorldUpdatePage,
  normalizeWorldUpdate,
  saveWorldUpdate,
  subscribeToPublishedWorldUpdates,
} from "./world-update-history-data.js";

const publishedAt = "2026-09-06T02:22:00.000Z";

function update(overrides: Record<string, unknown> = {}) {
  return {
    id: "update-one",
    worldId: "source-world",
    title: "Chapter 3",
    content: "Added a new ending.",
    isMajor: true,
    createdAt: publishedAt,
    creatorName: "Mia",
    ...overrides,
  };
}

function responseFetcher(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
}

test("aggregated history retains the source world of each entry", async () => {
  const page = await fetchWorldUpdatePage({
    worldId: "viewed-world",
    offset: 0,
    fetcher: responseFetcher({
      data: [
        update(),
        update({ id: "sibling-update", worldId: "sibling-world" }),
        update({ id: "legacy-update", worldId: undefined }),
      ],
    }),
  });

  assert.deepEqual(page.items.map(({ id, worldId }) => ({ id, worldId })), [
    { id: "update-one", worldId: "source-world" },
    { id: "sibling-update", worldId: "sibling-world" },
    { id: "legacy-update", worldId: null },
  ]);
});

test("invalid or missing source world IDs remain unknown", () => {
  for (const worldId of [undefined, null, "", "   ", 42]) {
    assert.equal(normalizeWorldUpdate(update({ worldId }))?.worldId, null);
  }
});

test("history grants editing only for an explicit true permission", async () => {
  const page = await fetchWorldUpdatePage({
    worldId: "source-world",
    offset: 0,
    fetcher: responseFetcher({ data: [update()], canEdit: true }),
  });

  assert.equal(page.canEdit, true);
  assert.equal(page.items.length, 1);
});

test("legacy and non-boolean history permissions remain read-only", async () => {
  for (const canEdit of [undefined, false, null, "true", "false", 1, 0, {}, []]) {
    const page = await fetchWorldUpdatePage({
      worldId: "source-world",
      offset: 0,
      fetcher: responseFetcher({ data: [update()], canEdit }),
    });

    assert.equal(page.canEdit, false);
    assert.deepEqual(page.items, [update()]);
  }
});

test("creation and notification permissions require independent explicit true values", async () => {
  for (const [canCreate, canNotify] of [[true, true], [true, false], [false, true]]) {
    const page = await fetchWorldUpdatePage({
      worldId: "source-world",
      offset: 0,
      fetcher: responseFetcher({ data: [], canCreate, canNotify }),
    });

    assert.equal(page.canCreate, canCreate);
    assert.equal(page.canNotify, canNotify);
    assert.equal(page.canEdit, false);
  }
});

test("missing or malformed creation and notification permissions default to false", async () => {
  for (const permission of [undefined, false, null, "true", "false", 1, 0, {}, []]) {
    const page = await fetchWorldUpdatePage({
      worldId: "source-world",
      offset: 0,
      fetcher: responseFetcher({ data: [update()], canCreate: permission, canNotify: permission }),
    });

    assert.equal(page.canCreate, false);
    assert.equal(page.canNotify, false);
    assert.deepEqual(page.items, [update()]);
  }
});

test("creating sends explicit notification choices and returns normalized records without publishing an event", async (t) => {
  let notifications = 0;
  t.after(subscribeToPublishedWorldUpdates(() => { notifications += 1; }));

  for (const notifyPlayers of [false, true]) {
    const controller = new AbortController();
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;
    const created = await createWorldUpdate({
      worldId: "source / world",
      title: "New chapter",
      content: "New details",
      isMajor: true,
      notifyPlayers,
      baseUrl: "https://api.example",
      signal: controller.signal,
      fetcher: (async (input: URL | RequestInfo, init?: RequestInit) => {
        requestedUrl = String(input);
        requestedInit = init;
        return new Response(JSON.stringify({ data: update({
          worldId: "source / world",
          title: "  New chapter  ",
          content: "  New details  ",
          creatorName: undefined,
        }) }), { status: 201 });
      }) as typeof fetch,
    });

    assert.equal(requestedUrl, "https://api.example/api/worlds/source%20%2F%20world/updates");
    assert.equal(requestedInit?.method, "POST");
    assert.equal(requestedInit?.credentials, "include");
    assert.equal(requestedInit?.signal, controller.signal);
    assert.equal(new Headers(requestedInit?.headers).get("Content-Type"), "application/json");
    assert.deepEqual(JSON.parse(String(requestedInit?.body)), {
      title: "New chapter",
      content: "New details",
      isMajor: true,
      notifyPlayers,
    });
    assert.deepEqual(created, update({
      worldId: "source / world",
      title: "New chapter",
      content: "New details",
      creatorName: null,
    }));
  }
  assert.equal(notifications, 0);
});

test("creating requires a boolean notification choice before sending a request", async () => {
  let requests = 0;
  for (const notifyPlayers of [undefined, null, "true", "false", 1, 0, {}, []]) {
    await assert.rejects(createWorldUpdate({
      worldId: "source-world",
      title: "New chapter",
      content: null,
      isMajor: false,
      notifyPlayers: notifyPlayers as boolean,
      fetcher: (async () => {
        requests += 1;
        return new Response(JSON.stringify({ data: update() }), { status: 201 });
      }) as typeof fetch,
    }), /notifyPlayers must be a boolean/);
  }
  assert.equal(requests, 0);
});

test("creating rejects missing, malformed, or mismatched response records", async () => {
  const invalidBodies = [
    null,
    [],
    {},
    { data: null },
    { data: update({ id: undefined }) },
    { data: update({ id: "" }) },
    { data: update({ id: "   " }) },
    { data: update({ title: undefined }) },
    { data: update({ title: "   " }) },
    { data: update({ createdAt: undefined }) },
    { data: update({ worldId: "another-world" }) },
    { data: update({ worldId: undefined }) },
  ];
  for (const body of invalidBodies) {
    await assert.rejects(createWorldUpdate({
      worldId: "source-world",
      title: "New chapter",
      content: null,
      isMajor: false,
      notifyPlayers: false,
      fetcher: responseFetcher(body, 201),
    }), /Invalid update creation response/);
  }
});

test("creating surfaces HTTP, network, aborted, and non-JSON response failures", async () => {
  const options = {
    worldId: "source-world",
    title: "New chapter",
    content: null,
    isMajor: false,
    notifyPlayers: false,
  };
  for (const status of [400, 401, 403, 404, 409, 429, 500]) {
    await assert.rejects(createWorldUpdate({
      ...options,
      fetcher: responseFetcher({ data: update() }, status),
    }), new RegExp(`Update creation request failed: ${status}`));
  }
  for (const error of [new TypeError("Network unavailable"), new DOMException("Aborted", "AbortError")]) {
    await assert.rejects(createWorldUpdate({
      ...options,
      fetcher: (async () => { throw error; }) as typeof fetch,
    }), (actual) => actual === error);
  }
  await assert.rejects(createWorldUpdate({
    ...options,
    fetcher: (async () => new Response("<html>Unavailable</html>", { status: 200 })) as typeof fetch,
  }), SyntaxError);
});

test("saving uses the encoded source world and update IDs with only editable fields", async () => {
  const controller = new AbortController();
  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    requestedUrl = String(input);
    requestedInit = init;
    return new Response(JSON.stringify({ data: update({
      id: "update / one",
      worldId: "source / world",
      title: "  Corrected title  ",
      content: "  Corrected details  ",
      creatorName: "  Mia  ",
    }) }), { status: 200 });
  }) as typeof fetch;

  const saved = await saveWorldUpdate({
    worldId: "source / world",
    updateId: "update / one",
    title: "Corrected title",
    content: "Corrected details",
    baseUrl: "https://api.example",
    signal: controller.signal,
    fetcher,
  });

  assert.equal(requestedUrl, "https://api.example/api/worlds/source%20%2F%20world/updates/update%20%2F%20one");
  assert.equal(requestedInit?.method, "PATCH");
  assert.equal(requestedInit?.credentials, "include");
  assert.equal(requestedInit?.signal, controller.signal);
  assert.equal(new Headers(requestedInit?.headers).get("Content-Type"), "application/json");
  assert.deepEqual(JSON.parse(String(requestedInit?.body)), {
    title: "Corrected title",
    content: "Corrected details",
  });
  assert.deepEqual(saved, update({
    id: "update / one",
    worldId: "source / world",
    title: "Corrected title",
    content: "Corrected details",
  }));
});

test("saving can clear the details while preserving publication metadata", async () => {
  let sentBody: unknown;
  const fetcher = (async (_input: URL | RequestInfo, init?: RequestInit) => {
    sentBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ data: update({ content: null }) }), { status: 200 });
  }) as typeof fetch;
  const saved = await saveWorldUpdate({
    worldId: "source-world",
    updateId: "update-one",
    title: "Chapter 3",
    content: null,
    fetcher,
  });

  assert.deepEqual(sentBody, { title: "Chapter 3", content: null });
  assert.equal(saved.content, null);
  assert.equal(saved.createdAt, publishedAt);
  assert.equal(saved.isMajor, true);
});

test("save rejects malformed or mismatched successful responses", async () => {
  const invalidBodies = [
    null,
    [],
    {},
    { data: null },
    { data: update({ title: "   " }) },
    { data: update({ createdAt: undefined }) },
    { data: update({ id: "another-update" }) },
    { data: update({ worldId: "viewed-world" }) },
    { data: update({ worldId: undefined }) },
  ];
  for (const body of invalidBodies) {
    await assert.rejects(saveWorldUpdate({
      worldId: "source-world",
      updateId: "update-one",
      title: "Correction",
      content: null,
      fetcher: responseFetcher(body),
    }), /Invalid update save response/);
  }
});

test("save surfaces HTTP failures instead of accepting a response row", async () => {
  for (const status of [400, 401, 404, 429, 500]) {
    await assert.rejects(saveWorldUpdate({
      worldId: "source-world",
      updateId: "update-one",
      title: "Correction",
      content: null,
      fetcher: responseFetcher({ data: update() }, status),
    }), new RegExp(`Update save request failed: ${status}`));
  }
});

test("save propagates network failures and aborted requests", async () => {
  for (const error of [new TypeError("Network unavailable"), new DOMException("Aborted", "AbortError")]) {
    await assert.rejects(saveWorldUpdate({
      worldId: "source-world",
      updateId: "update-one",
      title: "Correction",
      content: null,
      fetcher: (async () => { throw error; }) as typeof fetch,
    }), (actual) => actual === error);
  }
});

test("save rejects non-JSON successful responses", async () => {
  await assert.rejects(saveWorldUpdate({
    worldId: "source-world",
    updateId: "update-one",
    title: "Correction",
    content: null,
    fetcher: (async () => new Response("<html>Unavailable</html>", { status: 200 })) as typeof fetch,
  }), SyntaxError);
});
