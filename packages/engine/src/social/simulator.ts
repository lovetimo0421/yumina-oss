import { z } from "zod";
import { socialCharacterMemories, socialThreadRoot, socialTimelinePlan } from "./character-memory.js";
const id = z.string().min(1).max(100);
const body = z.string().trim().min(1).refine(text => Array.from(text).length <= 280, "Maximum 280 characters");
/** Execution budget per model call, never a cap on the requested cast. */
export const SOCIAL_REPLY_BATCH_SIZE = 6;
export const socialReplyCountSchema = z.union([z.number().int().positive().safe(), z.literal("all")]);
export const socialReplyCountsSchema = z.object({
    publicPost: socialReplyCountSchema.optional(),
    privateMessage: socialReplyCountSchema.optional(),
    channel: socialReplyCountSchema.optional(),
    timeline: socialReplyCountSchema.optional(),
});
export const socialConfigSchema = z.object({ profiles: z.array(z.object({
        id, name: z.string().min(1).max(80), handle: z.string().max(80), avatar: z.string().max(300), loreEntryId: id,
    })).min(1).max(50).refine(profiles => new Set(profiles.map(p => p.id)).size === profiles.length, "Duplicate profile IDs"),
    replyCounts: socialReplyCountsSchema.optional(),
});
export type SocialConfig = z.infer<typeof socialConfigSchema>;
export const socialActionSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("setup"), id, members: z.array(id).min(1).max(50) }),
    z.object({ type: z.literal("post"), id, text: body, parentId: id.optional() }),
    z.object({ type: z.literal("like"), id, postId: id, value: z.boolean() }),
    z.object({ type: z.literal("repost"), id, postId: id, value: z.boolean() }),
    z.object({ type: z.literal("follow"), id, profileId: id, value: z.boolean() }),
    z.object({ type: z.literal("conversation"), id, members: z.array(id).min(1).max(50), name: z.string().trim().min(1).max(80), channel: z.boolean() }),
    z.object({ type: z.literal("members"), id, conversationId: id, members: z.array(id).min(1).max(50) }),
    z.object({ type: z.literal("message"), id, conversationId: id, text: z.string().trim().min(1).max(2000) }),
    z.object({ type: z.literal("read"), id }),
    z.object({ type: z.literal("refresh"), id }),
]);
export type SocialAction = z.infer<typeof socialActionSchema>;
export interface SocialPost {
    id: string;
    authorId: string;
    text: string;
    parentId?: string;
    createdAt: string;
    likes: string[];
    reposts: string[];
}
export interface SocialMessage {
    id: string;
    authorId: string;
    text: string;
    createdAt: string;
    /** Character IDs who could hear this message. Optional on old saves. */
    audience?: string[];
}
export interface SocialConversation {
    id: string;
    name: string;
    members: string[];
    channel: boolean;
    messages: SocialMessage[];
}
export interface SocialJob {
    id: string;
    kind: "post" | "message" | "refresh";
    targetId: string;
    members: string[];
    status: "queued" | "running" | "done" | "error" | "cancelled";
    attempt?: string;
    startedAt?: number;
    error?: string;
    /** Number of requested speakers already consumed, in member order. Absent on older saved jobs. */
    completedCount?: number;
    /** Replies actually persisted; lower than completedCount when requested
     *  speakers stayed silent. Absent on older saved jobs. */
    persistedCount?: number;
}
export function socialReplyBatch(job: SocialJob): SocialJob {
    const offset = job.completedCount ?? 0;
    return { ...job, members: job.members.slice(offset, offset + SOCIAL_REPLY_BATCH_SIZE) };
}
/** Run under the session lock. Retries cannot duplicate a running batch; saved batches may advance. */
export function claimSocialJob(previous: SocialState, input: { jobId: string; attempt: string; cancel?: boolean }, now: number) {
    const index = previous.jobs.findIndex(j => j.id === input.jobId);
    const job = previous.jobs[index];
    if (!job) throw new Error("Reply request not found");
    const unchanged = { state: previous, claimed: false };
    if (job.status === "done" || job.status === "cancelled") return unchanged;
    if (!input.cancel) {
        const nextBatch = job.status === "queued" && (job.completedCount ?? 0) > 0;
        if ((job.attempt === input.attempt && !nextBatch) || (job.status === "running" && now - (job.startedAt ?? 0) < 240000)) return unchanged;
        if (job.kind === "message" && previous.jobs.slice(0, index).some(j => j.targetId === job.targetId && (j.status === "queued" || j.status === "running" || (j.status === "error" && (j.completedCount ?? 0) > 0)))) return unchanged;
    }
    const state = structuredClone(previous), next = state.jobs[index]!;
    if (input.cancel) next.status = "cancelled";
    else {
        next.status = "running"; next.attempt = input.attempt; next.startedAt = now; delete next.error;
    }
    state.revision++;
    return { state, claimed: !input.cancel };
}
export interface SocialState {
    version: 1;
    epoch: string;
    revision: number;
    selected: string[];
    following: string[];
    posts: SocialPost[];
    conversations: SocialConversation[];
    notifications: Array<{
        id: string;
        authorId: string;
        kind: "reply" | "message" | "mention";
        targetId: string;
        conversationId?: string;
        read: boolean;
        createdAt: string;
    }>;
    jobs: SocialJob[];
    applied: string[];
}
export function initialSocialState(config: SocialConfig, epoch = "initial"): SocialState {
    return { version: 1, epoch, revision: 0, selected: config.profiles.map(p => p.id), following: [], posts: [], conversations: [], notifications: [], jobs: [], applied: [] };
}
/** A restored timeline must not accept completions from its previous incarnation. */
export function renewSocialEpoch<T extends { metadata?: Record<string, unknown> }>(state: T, epoch: string): T {
    const social = state.metadata?.social as SocialState | undefined;
    if (!social || social.version !== 1) return state;
    return { ...state, metadata: { ...state.metadata, social: {
        ...social, epoch,
        jobs: social.jobs.map(job => job.status === "queued" || job.status === "running" ? { ...job, status: "cancelled" as const } : job),
    } } };
}
function requireMember(config: SocialConfig, members: string[]) {
    if (new Set(members).size !== members.length || members.some(m => !config.profiles.some(p => p.id === m)))
        throw new Error("Unknown or duplicate member");
}
function touch(s: SocialState) { s.revision++; return s; }
/** Pure, immutable reducer; caller persists under a session row lock. No AI code execution. */
export function applySocialAction(previous: SocialState, input: unknown, config: SocialConfig, now: string): SocialState {
    const a = socialActionSchema.parse(input);
    if (previous.applied.includes(a.id))
        return previous;
    if (previous.applied.length >= 20000)
        throw new Error("This session is full. Start a new session to continue.");
    const s: SocialState = structuredClone(previous);
    const queue = (kind: SocialJob["kind"], targetId: string, members: string[], requestedCount: number | "all") => {
        const pending = s.jobs.filter(j => j.status === "queued" || j.status === "running");
        if (pending.length >= 10)
            throw new Error("Please finish or cancel pending replies first");
        const count = requestedCount === "all" ? members.length : Math.min(requestedCount, members.length);
        const offset = (s.jobs.length * count) % members.length;
        const speakers = [...members.slice(offset), ...members.slice(0, offset)].slice(0, count);
        s.jobs.push({ id: a.id, kind, targetId, members: speakers, status: "queued" });
    };
    switch (a.type) {
        case "setup":
            requireMember(config, a.members);
            s.selected = a.members;
            break;
        case "post": {
            const parent = a.parentId ? s.posts.find(p => p.id === a.parentId) : undefined;
            if (a.parentId && !parent)
                throw new Error("Post not found");
            s.posts.push({ id: a.id, authorId: "you", text: a.text, parentId: a.parentId, createdAt: now, likes: [], reposts: [] });
            queue("post", a.id, parent && parent.authorId !== "you" ? [parent.authorId] : s.selected, parent ? 1 : (config.replyCounts?.publicPost ?? 6));
            break;
        }
        case "like":
        case "repost": {
            const p = s.posts.find(p => p.id === a.postId);
            if (!p)
                throw new Error("Post not found");
            const key = a.type === "like" ? "likes" : "reposts";
            p[key] = a.value ? [...new Set([...p[key], "you"])] : p[key].filter(u => u !== "you");
            break;
        }
        case "follow":
            requireMember(config, [a.profileId]);
            s.following = a.value ? [...new Set([...s.following, a.profileId])] : s.following.filter(m => m !== a.profileId);
            break;
        case "conversation":
            requireMember(config, a.members);
            s.conversations.push({ id: a.id, members: a.members, name: a.name, channel: a.channel, messages: [] });
            break;
        case "members": {
            requireMember(config, a.members);
            const c = s.conversations.find(c => c.id === a.conversationId);
            if (!c || !c.channel)
                throw new Error("Channel not found");
            // Preserve who heard legacy messages before the first membership edit.
            for (const message of c.messages) message.audience ??= [...c.members];
            c.members = a.members;
            // A removed member must not finish a previously queued channel response.
            for (const j of s.jobs)
                if (j.targetId === c.id && (j.status === "queued" || j.status === "running" || j.status === "error"))
                    j.status = "cancelled";
            break;
        }
        case "message": {
            const c = s.conversations.find(c => c.id === a.conversationId);
            if (!c)
                throw new Error("Conversation not found");
            c.messages.push({ id: a.id, authorId: "you", text: a.text, createdAt: now, audience: [...c.members] });
            queue("message", c.id, c.members, c.channel ? (config.replyCounts?.channel ?? 6) : (config.replyCounts?.privateMessage ?? 6));
            break;
        }
        case "read":
            s.notifications.forEach(n => { n.read = true; });
            break;
        case "refresh":
            queue("refresh", "timeline", s.selected, config.replyCounts?.timeline ?? 3);
            break;
    }
    s.applied.push(a.id);
    return touch(s);
}
// Leaves room for the bounded character lore entries and protocol prompt
// inside the completion endpoint's 50,000-character request limit. Count JSON
// characters, including escapes, rather than unencoded message lengths.
const SOCIAL_CONTEXT_MAX_CHARS = 25000;
function budgetHistory<T, K extends string>(base: Record<string, unknown>, key: K, items: T[], maxChars = SOCIAL_CONTEXT_MAX_CHARS): Record<string, unknown> & Record<K, T[]> {
    const context = { ...base, [key]: [] } as Record<string, unknown> & Record<K, T[]>;
    for (let i = items.length - 1; i >= 0; i--) {
        context[key].unshift(items[i]!);
        if (JSON.stringify(context).length > maxChars) {
            context[key].shift();
            break;
        }
    }
    return context;
}
/** Current surface stays separate from character-specific background memory. */
function currentSocialContext(s: SocialState, job: SocialJob) {
    if (job.kind === "message") {
        const c = s.conversations.find(c => c.id === job.targetId);
        if (!c)
            throw new Error("Conversation not found");
        const anchor = c.messages.findIndex(m => m.id === job.id);
        const latest = c.messages[anchor];
        const base = { kind: c.channel ? "channel" : c.members.length > 1 ? "group-message" : "private-message", name: c.name, latest: latest && { authorId: latest.authorId, text: latest.text } };
        // Recorded public events remain authoritative, with source and reply together.
        const byId = new Map(s.posts.map(p => [p.id, p]));
        const publicActivity = s.posts.filter(p => job.members.includes(p.authorId) || p.authorId === "you").slice(-30).map(p => {
            const source = p.parentId ? byId.get(p.parentId) : undefined;
            return {
                post: source ? { authorId: source.authorId, text: source.text } : { authorId: p.authorId, text: p.text },
                ...(source ? { reply: { authorId: p.authorId, text: p.text } } : {}),
            };
        });
        // Reserve the trigger even when it contains many JSON escape sequences.
        const publicBudget = Math.min(7000, Math.max(0, SOCIAL_CONTEXT_MAX_CHARS - JSON.stringify({ ...base, messages: [base.latest] }).length - 64));
        const publicContext = budgetHistory({}, "publicActivity", publicActivity, publicBudget);
        const contextBase = { ...base, ...publicContext };
        const essentialSize = JSON.stringify({ ...contextBase, messages: [base.latest] }).length;
        return budgetHistory(contextBase, "messages", c.messages.slice(Math.max(0, anchor - 29), anchor + 1 + (job.persistedCount ?? job.completedCount ?? 0))
            .filter(m => job.members.every(id => (m.audience ?? c.members).includes(id)))
            .map(m => ({ authorId: m.authorId, text: m.text })), Math.max(17000, essentialSize));
    }
    if (job.kind === "refresh")
        return budgetHistory({ kind: "public-timeline", timelinePlan: socialTimelinePlan(s, job) }, "posts", s.posts.filter(p => !p.parentId).slice(-15).map(p => ({ authorId: p.authorId, text: p.text })), 17000);
    const p = s.posts.find(p => p.id === job.targetId);
    if (!p)
        throw new Error("Post not found");
    const byId = new Map(s.posts.map(post => [post.id, post]));
    const roots = new Map<string, SocialPost>();
    const root = socialThreadRoot(p, byId, roots);
    const textPost = (post: SocialPost) => ({ id: post.id, authorId: post.authorId, text: post.text, parentId: post.parentId });
    return budgetHistory({ kind: "public-reply", post: textPost(root), latest: textPost(p) }, "replies", s.posts.filter(t => t.parentId && socialThreadRoot(t, byId, roots).id === root.id).slice(-20).map(textPost), 17000);
}
export function socialJobContext(s: SocialState, job: SocialJob) {
    const context = currentSocialContext(s, job);
    if (job.kind === "refresh") context.currentTask = "现在发布全新的独立公开动态。以上旧帖子用于避免重复，个人记忆只作背景；不回复历史问题、不列举回忆、不@玩家。Follow timelinePlan with distinct topics.";
    const remaining = SOCIAL_CONTEXT_MAX_CHARS - JSON.stringify({ ...context, characterMemories: [] }).length;
    if (remaining < 100) return context;
    return { ...context, characterMemories: socialCharacterMemories(s, job, Math.min(8000, remaining)) };
}
export const socialResponseSchema = z.object({ messages: z.array(z.object({ authorId: id, text: body })).min(1).max(SOCIAL_REPLY_BATCH_SIZE * 3) });
/** A speaker list is a cast, not a roll call. For replies and comments the model
 *  may leave requested members silent — an unaddressed member of a group chat has
 *  no obligation to chime in, and forcing one line from everyone is what produced
 *  the lockstep chorus players read as "robotic". A timeline refresh still posts
 *  for every member. Chats accept up to three short messages per speaker, like
 *  consecutive phone messages. Public posts/comments remain one per speaker.
 *  Unauthorized speakers, excessive fragments and empty replies fail atomically. */
export function finishSocialJob(previous: SocialState, jobId: string, attempt: string, response: unknown, now: string, expectedCompletedCount?: number): SocialState {
    const result = socialResponseSchema.parse(response);
    const job = previous.jobs.find(j => j.id === jobId);
    if (!job || job.status !== "running" || job.attempt !== attempt)
        return previous;
    const offset = job.completedCount ?? 0;
    if (expectedCompletedCount !== undefined && offset !== expectedCompletedCount) return previous;
    const batch = socialReplyBatch(job);
    if (result.messages.some(m => !batch.members.includes(m.authorId)))
        throw new Error("AI replied as an unauthorized member");
    const responseMembers = new Set(result.messages.map(m => m.authorId));
    if (job.kind !== "message" && responseMembers.size !== result.messages.length)
        throw new Error("AI returned more than one reply for the same member");
    if (batch.members.some(id => result.messages.filter(m => m.authorId === id).length > 3))
        throw new Error("AI returned too many messages for the same member");
    if (job.kind === "refresh" && responseMembers.size !== batch.members.length)
        throw new Error("AI did not return exactly one post for every requested member");
    const s = structuredClone(previous);
    // Older saves have no persistedCount; before this change every consumed
    // speaker produced exactly one persisted reply, so completedCount is exact.
    const persisted = job.persistedCount ?? offset;
    // Legacy partial batches used speaker offsets for IDs, leaving gaps when
    // someone stayed silent. Allocate after both those IDs and saved fragments.
    const priorItems = job.kind === "message" ? previous.conversations.find(c => c.id === job.targetId)!.messages : previous.posts;
    const prefix = `${job.id}:ai:`;
    let nextIndex = offset;
    for (const item of priorItems) {
        if (!item.id.startsWith(prefix)) continue;
        const suffix = item.id.slice(prefix.length);
        if (/^\d+$/.test(suffix)) nextIndex = Math.max(nextIndex, Number(suffix) + 1);
    }
    // Persist in requested speaker order, not model output order, so saves stay deterministic.
    const spoken = batch.members.flatMap(memberId => result.messages.filter(m => m.authorId === memberId));
    spoken.forEach((m, i) => {
        const mid = `${job.id}:ai:${nextIndex + i}`;
        if (job.kind === "message") {
            const c = s.conversations.find(c => c.id === job.targetId)!;
            if (!c.members.includes(m.authorId))
                throw new Error("Member is no longer in this conversation");
            const anchor = c.messages.findIndex(message => message.id === job.id);
            c.messages.splice(anchor + 1 + persisted + i, 0, { ...m, id: mid, createdAt: now, audience: [...c.members] });
            s.notifications.push({ id: mid, authorId: m.authorId, kind: "message", targetId: mid, conversationId: c.id, read: false, createdAt: now });
        }
        else {
            s.posts.push({ ...m, id: mid, parentId: job.kind === "post" ? job.targetId : undefined, createdAt: now, likes: [], reposts: [] });
            if (job.kind === "post")
                s.notifications.push({ id: mid, authorId: m.authorId, kind: "reply", targetId: job.targetId, read: false, createdAt: now });
            else if (/@you\b/i.test(m.text))
                s.notifications.push({ id: mid, authorId: m.authorId, kind: "mention", targetId: mid, read: false, createdAt: now });
        }
    });
    const nextJob = s.jobs.find(j => j.id === jobId)!;
    nextJob.completedCount = offset + batch.members.length;
    nextJob.persistedCount = persisted + result.messages.length;
    nextJob.status = nextJob.completedCount === job.members.length ? "done" : "queued";
    return touch(s);
}
