import { describe, expect, it } from "vitest";
import { applySocialAction, initialSocialState, socialJobContext, type SocialState, type SocialJob } from "../social/simulator.js";
import { socialThreadRoot } from "../social/character-memory.js";

const config = { profiles: ["a", "b", "c"].map(id => ({ id, name: id, handle: id, avatar: "", loreEntryId: id })) };
const now = "2026-09-08T00:00:00Z";
const act = (s: SocialState, a: unknown) => applySocialAction(s, a, config, now);
function fixture() {
  let s = initialSocialState(config);
  for (const [id, members, channel] of [["dm-a", ["a"], false], ["dm-b", ["b"], false], ["group", ["a", "b"], true]] as const) {
    s = act(s, { type: "conversation", id, members: [...members], channel, name: id });
    s = act(s, { type: "message", id: `${id}-first`, conversationId: id, text: `MEMORY_${id}` });
    s.jobs.at(-1)!.status = "done";
  }
  s = act(s, { type: "post", id: "public", text: "PUBLIC_EVENT" });
  s.jobs.at(-1)!.status = "done";
  return s;
}
function memories(s: SocialState, job: SocialJob) {
  return socialJobContext(s, job).characterMemories as Array<{ characterId: string; events: unknown[] }>;
}

describe("character continuity across social surfaces", () => {
  it.each(["post", "refresh", "message"] as const)("%s receives the same character's private, group and public records after reload", kind => {
    let s = fixture();
    if (kind === "message") s = act(s, { type: "conversation", id: "new-dm", members: ["a"], channel: false, name: "A again" });
    s = act(s, kind === "message" ? { type: kind, id: "trigger", conversationId: "new-dm", text: "Remember?" } : kind === "post" ? { type: kind, id: "trigger", text: "New public question" } : { type: kind, id: "trigger" });
    const saved = JSON.parse(JSON.stringify(s));
    const job = { ...saved.jobs.at(-1)!, members: ["a"] };
    const own = JSON.stringify(memories(saved, job));
    expect(own).toContain("MEMORY_dm-a");
    expect(own).toContain("MEMORY_group");
    expect(own).toContain("PUBLIC_EVENT");
    expect(own).not.toContain("MEMORY_dm-b");
    expect(saved).toEqual(s);
  });

  it("labels each speaker's memory separately and never turns private history into feed posts", () => {
    let s = act(fixture(), { type: "refresh", id: "refresh" });
    const context = socialJobContext(s, s.jobs.at(-1)!);
    const all = memories(s, s.jobs.at(-1)!);
    expect(JSON.stringify(all.find(m => m.characterId === "a"))).not.toContain("MEMORY_dm-b");
    expect(JSON.stringify(all.find(m => m.characterId === "b"))).not.toContain("MEMORY_dm-a");
    expect(JSON.stringify(all.find(m => m.characterId === "c"))).not.toContain("MEMORY_");
    expect(JSON.stringify(context.posts)).not.toContain("MEMORY_");
    expect(s.posts).toHaveLength(1);
    expect(JSON.stringify(socialJobContext(act(initialSocialState(config), { type: "refresh", id: "r" }), { ...s.jobs.at(-1)!, id: "r" }))).not.toContain("MEMORY_");
  });

  it("keeps memories from before leaving a group but does not grant a new member its old messages", () => {
    let s = fixture();
    s = act(s, { type: "members", id: "membership", conversationId: "group", members: ["b", "c"] });
    s = act(s, { type: "message", id: "after-join", conversationId: "group", text: "NEW_GROUP_EVENT" });
    s = act(s, { type: "refresh", id: "refresh" });
    const all = memories(s, s.jobs.at(-1)!);
    const a = JSON.stringify(all.find(m => m.characterId === "a"));
    const c = JSON.stringify(all.find(m => m.characterId === "c"));
    expect(a).toContain("MEMORY_group");
    expect(a).not.toContain("NEW_GROUP_EVENT");
    expect(c).not.toContain("MEMORY_group");
    expect(c).toContain("NEW_GROUP_EVENT");
  });

  it("does not import a later send-ahead action from another conversation", () => {
    let s = act(fixture(), { type: "post", id: "trigger", text: "Original post" });
    const job = s.jobs.at(-1)!;
    s = act(s, { type: "message", id: "future", conversationId: "dm-a", text: "FUTURE_SECRET" });
    expect(JSON.stringify(socialJobContext(s, job))).not.toContain("FUTURE_SECRET");
  });

  it("filters the active group history for newly joined speakers while retaining old participants' personal memory", () => {
    let s = fixture();
    // An old save has no audience snapshots until the first membership change.
    for (const c of s.conversations) for (const m of c.messages) delete m.audience;
    s = act(s, { type: "members", id: "join", conversationId: "group", members: ["b", "c"] });
    s = act(s, { type: "message", id: "current", conversationId: "group", text: "Hello new member" });
    const job = s.jobs.at(-1)!;
    expect(JSON.stringify(socialJobContext(s, { ...job, members: ["c"] }))).not.toContain("MEMORY_group");
    const mixed = socialJobContext(s, job);
    expect(JSON.stringify(mixed.messages)).not.toContain("MEMORY_group");
    expect(JSON.stringify(memories(s, job).find(m => m.characterId === "b"))).toContain("MEMORY_group");
    expect(JSON.stringify(memories(s, job).find(m => m.characterId === "c"))).not.toContain("MEMORY_group");
  });

  it("separates standalone posts, comments, one-to-one DMs and multi-person chats", () => {
    let s = fixture();
    s = act(s, { type: "conversation", id: "multi-dm", members: ["a", "b"], channel: false, name: "Group DM" });
    s = act(s, { type: "message", id: "m", conversationId: "multi-dm", text: "Hello" });
    expect(socialJobContext(s, s.jobs.at(-1)!).kind).toBe("group-message");
    s = act(s, { type: "post", id: "comment", parentId: "public", text: "A comment" });
    s = act(s, { type: "post", id: "nested", parentId: "comment", text: "Nested comment" });
    const context = socialJobContext(s, s.jobs.at(-1)!);
    expect(context.kind).toBe("public-reply");
    expect((context.post as { id: string }).id).toBe("public");
    expect((context.latest as { id: string }).id).toBe("nested");
  });

  it("varies timeline assignments across refreshes while retries keep the same directions", () => {
    let s = fixture();
    const plans = [];
    for (let i = 0; i < 8; i++) {
      s = act(s, { type: "refresh", id: `r${i}` });
      const job = s.jobs.at(-1)!;
      const context = socialJobContext(s, job);
      expect(context.timelinePlan).toBeDefined();
      expect(context.timelinePlan).toEqual(socialJobContext(JSON.parse(JSON.stringify(s)), job).timelinePlan);
      plans.push(JSON.stringify(context.timelinePlan));
      s.jobs.at(-1)!.status = "done";
    }
    expect(new Set(plans).size).toBeGreaterThan(4);
  });

  it("caches deep thread ancestry and terminates on malformed old cycles", () => {
    const posts = Array.from({ length: 5000 }, (_, i) => ({ id: `p${i}`, parentId: i ? `p${i - 1}` : undefined, authorId: "a", text: "Comment", createdAt: now, likes: [], reposts: [] }));
    const byId = new Map(posts.map(p => [p.id, p]));
    const cache = new Map();
    for (const p of posts) expect(socialThreadRoot(p, byId, cache).id).toBe("p0");
    expect(cache.size).toBe(5000);
    posts[0]!.parentId = "p2";
    expect(socialThreadRoot(posts[2]!, byId).id).toBe("p2");
  });

  it("keeps timeline directions aligned for later batches of a thirteen-member saved job", () => {
    const members = Array.from({ length: 13 }, (_, i) => `member-${i}`);
    const s = initialSocialState(config, "batch-epoch");
    const job: SocialJob = { id: "refresh-all", kind: "refresh", targetId: "timeline", members, status: "running" };
    s.jobs.push(job);
    const full = socialJobContext(s, job).timelinePlan as Array<{ characterId: string }>;
    for (const offset of [0, 6, 12]) {
      const batch = { ...job, members: members.slice(offset, offset + 6), completedCount: offset };
      expect(socialJobContext(JSON.parse(JSON.stringify(s)), batch).timelinePlan).toEqual(full.slice(offset, offset + 6));
    }
  });

  it("bounds all memory plus current context without dropping the latest complete escaped trigger", () => {
    let s = fixture();
    for (const c of s.conversations) for (let i = 0; i < 60; i++) c.messages.push({ id: `${c.id}-${i}`, authorId: "you", text: "\u0001".repeat(2000), createdAt: now });
    s = act(s, { type: "post", id: "trigger", text: "Latest public request" });
    const publicContext = socialJobContext(s, s.jobs.at(-1)!);
    expect(JSON.stringify(publicContext).length).toBeLessThanOrEqual(25000);
    expect(JSON.stringify(publicContext)).toContain("Latest public request");
    s = act(s, { type: "message", id: "escaped", conversationId: "dm-a", text: "\u0001".repeat(2000) });
    const privateContext = socialJobContext(s, s.jobs.at(-1)!);
    expect(JSON.stringify(privateContext).length).toBeLessThanOrEqual(25000);
    expect(privateContext.messages).toContainEqual({ authorId: "you", text: "\u0001".repeat(2000) });
  });
});
