import type { SocialJob, SocialPost, SocialState } from "./simulator.js";

interface MemoryEvent {
    source: "public-post" | "public-comment" | "private-message" | "group-message" | "channel";
    authorId: string;
    text: string;
    createdAt: string;
    conversationId?: string;
    replyTo?: { authorId: string; text: string };
    truncated?: boolean;
}
const snippet = (text: string) => Array.from(text).slice(0, 360).join("");

/** The root post, even for replies to replies. Tolerate malformed legacy cycles. */
export function socialThreadRoot(post: SocialPost, byId: Map<string, SocialPost>, cache = new Map<string, SocialPost>()) {
    const visited = new Set<string>();
    let root = post;
    while (root.parentId && !visited.has(root.id)) {
        const cached = cache.get(root.id);
        if (cached) { root = cached; break; }
        visited.add(root.id);
        const parent = byId.get(root.parentId);
        if (!parent) break;
        root = parent;
    }
    for (const id of visited) cache.set(id, root);
    cache.set(root.id, root);
    return root;
}

/** Pure retrieval from this session only. Each bucket belongs to one character. */
export function socialCharacterMemories(s: SocialState, job: SocialJob, maxChars: number) {
    const result: Array<{ characterId: string; events: MemoryEvent[] }> = [];
    const perCharacter = Math.floor((maxChars - 2) / Math.max(1, job.members.length)) - 1;
    const byId = new Map(s.posts.map(p => [p.id, p]));
    const actionOrder = new Map(s.applied.map((id, index) => [id, index]));
    const cutoff = actionOrder.get(job.id) ?? Infinity;
    const visibleAtTrigger = (id: string) => {
        const origin = id.replace(/:ai:\d+$/, "");
        return (actionOrder.get(origin) ?? -1) <= cutoff;
    };
    for (const characterId of job.members) {
        const events: MemoryEvent[] = [];
        for (const p of s.posts) {
            if (!visibleAtTrigger(p.id) || (p.authorId !== characterId && p.authorId !== "you")) continue;
            const parent = p.parentId ? byId.get(p.parentId) : undefined;
            // A public conversation is readable, but its speakers remain explicit.
            events.push({ source: p.parentId ? "public-comment" : "public-post", authorId: p.authorId, text: p.text, createdAt: p.createdAt,
                ...(parent ? { replyTo: { authorId: parent.authorId, text: parent.text } } : {}) });
        }
        for (const c of s.conversations) {
            for (const m of c.messages) {
                const audience = m.audience ?? c.members;
                if (!visibleAtTrigger(m.id) || !audience.includes(characterId)) continue;
                // Shared current history is sent once. A returning member's older
                // experience stays personal if another replying member joined later.
                if (job.kind === "message" && c.id === job.targetId && job.members.every(id => audience.includes(id))) continue;
                events.push({ source: c.channel ? "channel" : c.members.length > 1 ? "group-message" : "private-message",
                    conversationId: c.id, authorId: m.authorId, text: snippet(m.text), createdAt: m.createdAt,
                    ...(Array.from(m.text).length > 360 ? { truncated: true } : {}) });
            }
        }
        // Keep several surfaces represented; one busy group must not erase DMs.
        const recent = events.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).reverse();
        const seen = new Set<string>();
        const representatives = recent.filter(e => {
            const key = e.source === "public-comment" ? "public-post" : e.source;
            if (seen.has(key)) return false;
            seen.add(key); return true;
        });
        const bucket = { characterId, events: [] as MemoryEvent[] };
        for (const event of [...representatives, ...recent.filter(e => !representatives.includes(e))]) {
            if (bucket.events.length >= 18) break;
            bucket.events.push(event);
            if (JSON.stringify(bucket).length > perCharacter) bucket.events.pop();
        }
        bucket.events.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        if (JSON.stringify([...result, bucket]).length <= maxChars) result.push(bucket);
    }
    return result;
}

const timelineAngles = [
    "a small everyday observation or sensory detail",
    "a personal hobby, practice session or work-in-progress",
    "food, music, a place or something just discovered",
    "a low-key photo-caption-style moment; do not invent an attached image",
    "a small plan, anticipation or change of routine",
    "a candid mood or thought without forced profundity",
    "a light question for the public, unrelated to the latest thread",
    "a small mishap, success or ordinary slice of life",
];

/** New action IDs vary the brief; retries and saved batches keep it stable. */
export function socialTimelinePlan(s: SocialState, job: SocialJob) {
    let seed = 2166136261;
    for (const ch of `${s.epoch}:${job.id}`) seed = Math.imul(seed ^ ch.charCodeAt(0), 16777619) >>> 0;
    const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
    const angles = [...timelineAngles];
    for (let i = angles.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [angles[i], angles[j]] = [angles[j]!, angles[i]!];
    }
    const fullCast = s.jobs.find(j => j.id === job.id)?.members ?? job.members;
    const continuityIndex = Math.floor(random() * 4); // Most posts get an independent topic.
    return job.members.map(characterId => {
        const index = Math.max(0, fullCast.indexOf(characterId));
        return { characterId, angle: angles[index % angles.length],
            continuity: index % 4 === continuityIndex
                ? "An optional subtle connection to this character's own memory; express a new development without revealing private details."
                : "Start an independent topic that fits this character's life. Memory informs personality and mood, not a reply to old posts." };
    });
}
