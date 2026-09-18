import { describe, expect, it } from "vitest";
import { applySocialAction, claimSocialJob, finishSocialJob, initialSocialState, socialJobContext, socialReplyBatch, type SocialPost } from "../social/simulator.js";

const config = {
  profiles: Array.from({ length: 8 }, (_, i) => ({ id: `member-${i}`, name: `Member ${i}`, handle: `${i}`, avatar: "", loreEntryId: `${i}` })),
  replyCounts: { channel: "all" as const },
};
const now = "2026-09-07T00:00:00Z";
const post = (id: string, authorId: string, text: string, parentId?: string): SocialPost => ({ id, authorId, text, parentId, createdAt: now, likes: [], reposts: [] });

describe("recorded public memory in social conversations", () => {
  it("remembers the player's public reply and source even when the queued character response was cancelled", () => {
    let state = initialSocialState(config);
    state.posts = [post("character-post", "member-0", "Which constellation should we watch tonight?")];
    state = applySocialAction(state, { type: "post", id: "player-reply", parentId: "character-post", text: "Let's watch Orion from the old observatory." }, config, now);
    state = claimSocialJob(state, { jobId: "player-reply", attempt: "cancel", cancel: true }, 1000).state;
    expect(state.jobs[0]!.status).toBe("cancelled");
    expect(state.posts).toHaveLength(2);
    state = applySocialAction(state, { type: "conversation", id: "dm", name: "Direct", members: ["member-0"], channel: false }, config, now);
    state = applySocialAction(state, { type: "message", id: "recall", conversationId: "dm", text: "What did I suggest under your post?" }, config, now);
    const restored = JSON.parse(JSON.stringify(state));
    expect(socialJobContext(restored, restored.jobs.at(-1)!).publicActivity).toContainEqual({
      post: { authorId: "member-0", text: "Which constellation should we watch tonight?" },
      reply: { authorId: "you", text: "Let's watch Orion from the old observatory." },
    });
  });

  it.each([false, true])("recalls a member's original public words in a channel=%s conversation without importing other conversations", channel => {
    let state = initialSocialState(config);
    state.posts = [
      post("source", "you", "I named the cookies little moons."),
      post("reply", "member-0", "I was drinking lemon water after yoga.", "source"),
      post("outsider", "member-7", "UNRELATED_PUBLIC_REPLY", "source"),
    ];
    for (const otherChannel of [false, true]) {
      const id = otherChannel ? "other-channel" : "other-dm";
      state = applySocialAction(state, { type: "conversation", id, name: id, members: ["member-7"], channel: otherChannel }, config, now);
      state = applySocialAction(state, { type: "message", id: `${id}-message`, conversationId: id, text: `SECRET_${id}` }, config, now);
    }
    state = applySocialAction(state, { type: "conversation", id: "target", name: "Target", members: ["member-0"], channel }, config, now);
    state = applySocialAction(state, { type: "message", id: "recall", conversationId: "target", text: "What were the cookies called and what were you doing?" }, config, now);
    const restored = JSON.parse(JSON.stringify(state));
    const context = socialJobContext(restored, restored.jobs.at(-1)!);
    expect(context.kind).toBe(channel ? "channel" : "private-message");
    expect(context.publicActivity).toContainEqual({
      post: { authorId: "you", text: "I named the cookies little moons." },
      reply: { authorId: "member-0", text: "I was drinking lemon water after yoga." },
    });
    expect(JSON.stringify(context)).not.toMatch(/SECRET_|UNRELATED_PUBLIC_REPLY/);
    expect(restored).toEqual(state);

    state = applySocialAction(state, { type: "post", id: "new-public", text: "Public question" }, config, now);
    state = applySocialAction(state, { type: "refresh", id: "refresh" }, config, now);
    for (const job of state.jobs.slice(-2)) {
      const context = socialJobContext(state, { ...job, members: ["member-0"] });
      expect(JSON.stringify(context)).not.toMatch(/SECRET_/);
      const { characterMemories, ...publicSurface } = context;
      expect(JSON.stringify(publicSurface)).not.toContain("What were the cookies");
      expect(JSON.stringify(characterMemories)).toContain("What were the cookies");
    }
  });

  it("keeps complete public source/reply pairs within the serialized budget beside an escaped 2000-character trigger", () => {
    let state = initialSocialState(config);
    state.posts = Array.from({ length: 30 }, (_, i) => [
      post(`source-${i}`, "you", `Public original ${i}:` + "x".repeat(250)),
      post(`reply-${i}`, "member-0", `Public reply ${i}:` + "\u0001".repeat(250), `source-${i}`),
    ]).flat();
    state = applySocialAction(state, { type: "conversation", id: "target", name: "Target", members: ["member-0"], channel: false }, config, now);
    state.conversations[0]!.messages = Array.from({ length: 30 }, (_, i) => ({ id: `old-${i}`, authorId: "you", text: "\u0001".repeat(2000), createdAt: now }));
    for (const trigger of ["x".repeat(2000), "\u0001".repeat(2000)]) {
      const withTrigger = applySocialAction(state, { type: "message", id: "trigger", conversationId: "target", text: trigger }, config, now);
      const context = socialJobContext(withTrigger, withTrigger.jobs.at(-1)!);
      expect(JSON.stringify(context).length).toBeLessThanOrEqual(25000);
      expect(context.latest).toEqual({ authorId: "you", text: trigger });
      expect(context.messages).toContainEqual({ authorId: "you", text: trigger });
      const activity = context.publicActivity as Array<{ post: { text: string }; reply?: { text: string } }>;
      expect(activity.length).toBeLessThan(30);
      if (trigger.startsWith("x")) expect(activity.some(item => item.reply)).toBe(true);
      for (const item of activity) {
        expect(item.post.text).toMatch(/^Public original \d+:x{250}$/);
        if (item.reply) expect(item.reply.text).toMatch(/^Public reply \d+:\u0001{250}$/);
      }
    }
  });

  it("anchors later batches to the original trigger, includes persisted batch replies and omits a send-ahead message", () => {
    let state = initialSocialState(config);
    state.posts = [post("public-source", "you", "A remembered public event"), post("public-reply", "member-6", "My recorded response", "public-source")];
    state = applySocialAction(state, { type: "conversation", id: "group", name: "Group", members: config.profiles.map(p => p.id), channel: true }, config, now);
    state = applySocialAction(state, { type: "message", id: "first", conversationId: "group", text: "Original trigger" }, config, now);
    state = applySocialAction(state, { type: "message", id: "second", conversationId: "group", text: "FUTURE_SEND_AHEAD" }, config, now);
    state = claimSocialJob(state, { jobId: "first", attempt: "attempt" }, 1000).state;
    const firstBatch = socialReplyBatch(state.jobs[0]!);
    state = finishSocialJob(state, "first", "attempt", { messages: firstBatch.members.map(authorId => ({ authorId, text: `First batch from ${authorId}` })) }, now);
    const nextBatch = socialReplyBatch(state.jobs[0]!);
    expect(nextBatch.members).toEqual(["member-6", "member-7"]);
    const context = socialJobContext(state, nextBatch);
    expect(context.latest).toEqual({ authorId: "you", text: "Original trigger" });
    expect(context.messages).toHaveLength(7);
    for (const member of firstBatch.members) expect(JSON.stringify(context)).toContain(`First batch from ${member}`);
    expect(JSON.stringify(context)).toContain("My recorded response");
    expect(JSON.stringify(context)).not.toContain("FUTURE_SEND_AHEAD");
  });
});
