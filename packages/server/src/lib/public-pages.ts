/**
 * What the public pages are made of: the rows behind a tag page, a world
 * page's extra blocks, and the community's forums, threads and events.
 *
 * Both the page's meta tags (lib/seo.ts) and its crawlable HTML
 * (lib/prerender.ts) read from here, so one request costs one set of queries
 * and a crawler walking the site cannot hammer the database: every loader is
 * cached for a minute or more, by key.
 *
 * Rules that hold for everything in this file:
 *  - only what a logged-out visitor can already read. Worlds are published,
 *    public and all-ages; threads are all-ages (the only wall the community
 *    has: there is no adult forum, the rating is per thread); events are live
 *    or closed. Direct messages and drafts are never read here.
 *  - reads go to the replica (readPublic): this is public browse.
 *  - loaders run with no viewer, so a cached row never carries what an owner
 *    or admin could see.
 */
import { and, asc, desc, eq, isNull, or, sql } from "drizzle-orm";
import { findTagBySlug, findTagEntry, tagSlug, tagSpellings, type TagEntry } from "@yumina/shared";
import { readPublic } from "../db/index.js";
import { communityEvents, forums, posts, threads, threadWorlds, user, userMutes, worlds } from "../db/schema.js";
import { cleanMarkdown } from "./seo-text.js";
import { runWithWorldViewer, worldAudienceCondition } from "./world-publication-access.js";
import { findLanguageSiblings, type AddressedWorld, type WorldVariant } from "./world-address.js";

// ── thresholds (stated in the PR that added them) ────────────────────────────

/** A tag page is listed in the sitemap once this many public all-ages worlds carry the tag. */
export const TAG_SITEMAP_MIN_WORLDS = 5;
/** Worlds listed on a tag page. */
export const TAG_PAGE_WORLDS = 48;
const TAG_PAGE_RELATED = 12;
const SIMILAR_WORLDS = 8;
/** Replies on one page of a thread, oldest first. */
export const THREAD_REPLIES_PER_PAGE = 20;
const FORUM_THREADS = 50;
const COMMUNITY_RECENT_THREADS = 30;
// The indexing rule for an ordinary member's thread (threadIndexable below).
/** The author's account must be at least this old. */
export const THREAD_MIN_ACCOUNT_AGE_DAYS = 7;
/** Replies from someone other than the author that make a post a discussion. */
export const THREAD_MIN_OTHER_REPLIES = 1;
/** Without such a reply, the post itself must be this long (characters as stored). */
export const THREAD_MIN_BODY_CHARS = 300;
const SITEMAP_THREAD_LIMIT = 40_000;
const OPENING_MAX_CHARS = 1500;

// Vocabulary tags that name sexual content. An all-ages world can still carry
// one (creators tag loosely), but the site does not publish a page or a link
// titled with it: those pages are what content monitors and ad crawlers read.
const NO_PAGE_TAGS = new Set(
  [
    "NSFW", "榨精", "色诱", "抖m", "榨死", "femdom", "master and slave roleplay", "堕落", "Smut", "巨乳", "足控", "色情",
    "BDSM", "petplay", "等级吸取", "Sadistic", "submissive", "giantess", "童颜巨乳", "vore", "生命力榨取", "足交",
    "Amigos con derecho", "体香", "下流", "Amor rudo", "关押", "催眠", "乳交", "网黄", "支配", "丰满", "不洁", "性冷淡",
    "爆乳", "榨取", "逆ntr", "SFW <-> NSFW", "Incest", "Dominante", "改造", "Loli Face Big Tits",
  ].map((t) => t.toLowerCase()),
);

/** The vocabulary entry behind a tag when the tag may have a public page. */
export function pageTagEntry(tag: string): TagEntry | undefined {
  const entry = findTagEntry(tag);
  if (!entry || NO_PAGE_TAGS.has(entry.canonical.toLowerCase())) return undefined;
  return tagSlug(entry.canonical) ? entry : undefined;
}

// ── cache ────────────────────────────────────────────────────────────────────

const cache = new Map<string, { until: number; value: Promise<unknown> }>();
const CACHE_MAX = 1000;
const TTL_PAGE_MS = 60 * 1000;
const TTL_LIST_MS = 5 * 60 * 1000;
const TTL_CATALOG_MS = 10 * 60 * 1000;

/** One load per key per TTL, shared by concurrent callers; a failed load is not kept. */
function cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.value as Promise<T>;
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  const value = runWithWorldViewer(undefined, load);
  cache.set(key, { until: Date.now() + ttl, value });
  value.catch(() => {
    if (cache.get(key)?.value === value) cache.delete(key);
  });
  return value;
}

/** For tests. */
export function clearPublicPageCache(): void {
  cache.clear();
}

/**
 * Drop what is cached about one thread and the lists it appears in, so a
 * delete, a move or a re-rating shows on the next request instead of a
 * minute later. This process only; other instances catch up when their
 * entries expire.
 */
export function forgetThread(threadId: string): void {
  for (const key of [...cache.keys()]) {
    if (key.startsWith(`thread:${threadId}:`) || key === "community" || key.startsWith("forum:")) cache.delete(key);
  }
}

// ── worlds ───────────────────────────────────────────────────────────────────

export interface WorldCard {
  id: string;
  publicId: string | null;
  name: string;
  thumbnailUrl: string | null;
  creatorName: string | null;
  creatorUsername: string | null;
}

export const CARD_COLUMNS = {
  id: worlds.id,
  publicId: worlds.publicId,
  name: worlds.name,
  thumbnailUrl: worlds.thumbnailUrl,
  creatorName: user.name,
  creatorUsername: user.username,
};

/** Published, all-ages and public: the only worlds any public page lists. */
export const publicWorldFilter = and(
  or(eq(worlds.status, "published"), and(isNull(worlds.status), eq(worlds.isPublished, true))),
  eq(worlds.ageRating, "all"),
  eq(worlds.visibility, "public"),
);

function stringTags(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((t): t is string => typeof t === "string" && t.trim().length > 0) : [];
}

const lowerList = (values: string[]) => sql.join(values.map((v) => sql`${v}`), sql`, `);

// ── tag pages ────────────────────────────────────────────────────────────────

export interface TagInfo {
  /** Stored value of the tag. */
  canonical: string;
  slug: string;
  /** English label, the one the page is titled with. */
  label: string;
  /** Public all-ages worlds carrying the tag (any spelling). */
  count: number;
}

export interface TagWorld extends WorldCard {
  description: string | null;
}

export interface TagPage {
  tag: TagInfo;
  worlds: TagWorld[];
  related: TagInfo[];
}

/** Fold raw (tag, count) rows onto vocabulary tags that may have a page. Pure. */
export function foldTagCounts(rows: Array<{ tag: string; count: number }>): Map<string, TagInfo> {
  const bySlug = new Map<string, TagInfo>();
  for (const row of rows) {
    const entry = pageTagEntry(row.tag);
    if (!entry) continue;
    const slug = tagSlug(entry.canonical)!;
    const info = bySlug.get(slug) ?? { canonical: entry.canonical, slug, label: entry.labels.en, count: 0 };
    info.count += Number(row.count) || 0;
    bySlug.set(slug, info);
  }
  return bySlug;
}

/** Every tag that has a page right now, by slug, with its world count. */
export function loadTagCatalog(): Promise<Map<string, TagInfo>> {
  return cached("tags", TTL_CATALOG_MS, async () => {
    const result = await readPublic().execute(sql`
      SELECT tag.value AS tag, COUNT(DISTINCT ${worlds.id})::int AS count
      FROM ${worlds} CROSS JOIN LATERAL jsonb_array_elements_text(${worlds.tags}) AS tag(value)
      WHERE ${and(publicWorldFilter, worldAudienceCondition(worlds.creatorId))}
      GROUP BY tag.value`);
    return foldTagCounts(result.rows as Array<{ tag: string; count: number }>);
  });
}

/** The tags most often found next to this one among the listed worlds. Pure. */
export function relatedTags(self: TagInfo, worldTags: unknown[], catalog: Map<string, TagInfo>, limit = TAG_PAGE_RELATED): TagInfo[] {
  const seen = new Map<string, number>();
  for (const tags of worldTags) {
    const slugs = new Set<string>();
    for (const tag of stringTags(tags)) {
      const entry = pageTagEntry(tag);
      const slug = entry ? tagSlug(entry.canonical) : null;
      if (slug && slug !== self.slug && catalog.has(slug)) slugs.add(slug);
    }
    for (const slug of slugs) seen.set(slug, (seen.get(slug) ?? 0) + 1);
  }
  return [...seen.entries()]
    .sort((a, b) => b[1] - a[1] || catalog.get(b[0])!.count - catalog.get(a[0])!.count || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([slug]) => catalog.get(slug)!);
}

/** A tag page's content, or null when the slug names no tag or the tag has no public world. */
export function loadTagPage(rawSlug: string): Promise<TagPage | null> {
  const entry = findTagBySlug(rawSlug);
  if (!entry || !pageTagEntry(entry.canonical)) return Promise.resolve(null);
  const slug = tagSlug(entry.canonical)!;
  return cached(`tag:${slug}`, TTL_LIST_MS, async () => {
    const catalog = await loadTagCatalog();
    const info = catalog.get(slug);
    if (!info || info.count < 1) return null;
    const rows = await readPublic()
      .select({ ...CARD_COLUMNS, description: worlds.description, tags: worlds.tags })
      .from(worlds)
      .leftJoin(user, eq(worlds.creatorId, user.id))
      .where(and(
        publicWorldFilter,
        worldAudienceCondition(worlds.creatorId),
        sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(${worlds.tags}) AS t(value) WHERE lower(t.value) IN (${lowerList(tagSpellings(entry))}))`,
      ))
      .orderBy(desc(worlds.downloadCount), desc(worlds.updatedAt))
      .limit(TAG_PAGE_WORLDS);
    if (!rows.length) return null;
    return {
      tag: info,
      worlds: rows.map(({ tags: _tags, ...world }) => world),
      related: relatedTags(info, rows.map((r) => r.tags), catalog),
    };
  });
}

/** What a genre page (/ai-rpg and the rest, lib/landing-public.ts) lists. */
export interface LandingData {
  worlds: TagWorld[];
  /** The page's own tags that have a tag page right now, most used first. */
  tags: TagInfo[];
}

/**
 * The most played public all-ages worlds carrying any of the given vocabulary
 * tags, in any spelling. The same filter, audience rule, order and size as a
 * tag page; a tag that gets no page (NO_PAGE_TAGS) is ignored.
 */
export function loadLandingData(key: string, tags: readonly string[]): Promise<LandingData> {
  const entries = [...new Set(tags.flatMap((tag) => pageTagEntry(tag) ?? []))];
  if (!entries.length) return Promise.resolve({ worlds: [], tags: [] });
  const spellings = [...new Set(entries.flatMap(tagSpellings))];
  return cached(`landing:${key}`, TTL_LIST_MS, async () => {
    const catalog = await loadTagCatalog();
    const worldRows = await readPublic()
      .select({ ...CARD_COLUMNS, description: worlds.description })
      .from(worlds)
      .leftJoin(user, eq(worlds.creatorId, user.id))
      .where(and(
        publicWorldFilter,
        worldAudienceCondition(worlds.creatorId),
        sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(${worlds.tags}) AS t(value) WHERE lower(t.value) IN (${lowerList(spellings)}))`,
      ))
      .orderBy(desc(worlds.downloadCount), desc(worlds.updatedAt))
      .limit(TAG_PAGE_WORLDS);
    const withPage = entries
      .flatMap((entry) => catalog.get(tagSlug(entry.canonical)!) ?? [])
      .filter((info) => info.count > 0)
      .sort((a, b) => b.count - a.count || a.slug.localeCompare(b.slug));
    return { worlds: worldRows, tags: withPage };
  });
}

// ── world page extras ────────────────────────────────────────────────────────

export interface WorldExtras {
  /** The opening scene every player is shown first, as plain text. */
  opening: string | null;
  /** The creator's note shown on the world's page. */
  announcement: string | null;
  /** Other public worlds sharing tags with this one, by other creators. */
  similar: WorldCard[];
  /** The same world in other languages. */
  siblings: WorldVariant[];
}

/**
 * A stored opening as readable text: the markup, macros and state directives
 * the engine consumes are removed, the words stay the creator's.
 */
export function cleanOpening(raw: string | null | undefined, worldName?: string | null): string {
  if (!raw) return "";
  let s = raw.replace(/\r\n?/g, "\n");
  s = s.replace(/<(style|script)\b[\s\S]*?<\/\1\s*>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/\{\{\s*user\s*\}\}/gi, "you");
  s = s.replace(/\{\{\s*char\s*\}\}/gi, worldName?.trim() || "they");
  s = s.replace(/\{\{[\s\S]*?\}\}/g, " ");
  // Engine state directives: [hp: add 5], [mood: set "calm"].
  s = s.replace(/\[[\w.\-一-鿿 ]{1,40}:\s*(?:set|add|subtract|multiply|toggle|append|merge|push|delete)\b[^\]\n]*\]/gi, " ");
  const paragraphs = s
    .split(/\n{2,}/)
    .map((block) => cleanMarkdown(block))
    .filter(Boolean);
  let out = "";
  for (const p of paragraphs) {
    const next = out ? `${out}\n\n${p}` : p;
    if (next.length > OPENING_MAX_CHARS) {
      if (!out) out = `${p.slice(0, OPENING_MAX_CHARS).replace(/\s+\S*$/, "")}…`;
      break;
    }
    out = next;
  }
  return out;
}

/** Lowercased spellings of every tag a world carries, for matching other worlds. */
export function worldTagSpellings(tags: unknown): string[] {
  const out = new Set<string>();
  for (const tag of stringTags(tags)) {
    const entry = findTagEntry(tag);
    if (entry) for (const s of tagSpellings(entry)) out.add(s);
    else out.add(tag.trim().toLowerCase());
  }
  return [...out].slice(0, 200);
}

async function similarWorlds(world: AddressedWorld): Promise<WorldCard[]> {
  const spellings = worldTagSpellings(world.tags);
  if (!spellings.length) return [];
  const shared = sql<number>`(SELECT count(*) FROM jsonb_array_elements_text(${worlds.tags}) AS t(value) WHERE lower(t.value) IN (${lowerList(spellings)}))`;
  const rows = await readPublic()
    .select(CARD_COLUMNS)
    .from(worlds)
    .leftJoin(user, eq(worlds.creatorId, user.id))
    .where(and(
      publicWorldFilter,
      worldAudienceCondition(worlds.creatorId),
      sql`${worlds.id} <> ${world.id}`,
      // The creator's own worlds already have their block on the page.
      sql`${worlds.creatorId} <> ${world.creatorId}`,
      // Another language of this same world is linked as a language, not as a neighbour.
      world.languageGroupId ? sql`${worlds.languageGroupId} IS DISTINCT FROM ${world.languageGroupId}` : undefined,
      sql`${shared} > 0`,
    ))
    .orderBy(
      desc(shared),
      world.language ? sql`(${worlds.language} = ${world.language}) DESC NULLS LAST` : sql`1`,
      desc(worlds.downloadCount),
    )
    .limit(SIMILAR_WORLDS);
  return rows;
}

async function openingAndNote(worldId: string): Promise<{ opening: string | null; announcement: string | null }> {
  // Only the first opening is read out of the (large) schema, in the database.
  // An opening is what every player is shown first, so it is never one of the
  // entries an author keeps to themselves (lib/sealed-entries.ts); one copied
  // from a card whose author sealed it is skipped all the same.
  const result = await readPublic().execute(sql`
    SELECT ${worlds.announcement} AS announcement, (
      SELECT g.value->>'content'
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(${worlds.schema}->'entries') = 'array' THEN ${worlds.schema}->'entries' ELSE '[]'::jsonb END
      ) WITH ORDINALITY AS g(value, ord)
      WHERE g.value->>'role' = 'greeting'
        AND COALESCE(g.value->>'enabled', 'true') <> 'false'
        AND (g.value->'sealed') IS NULL
        AND length(COALESCE(g.value->>'content', '')) > 0
      ORDER BY g.ord
      LIMIT 1
    ) AS opening
    FROM ${worlds}
    WHERE ${worlds.id} = ${worldId}
    LIMIT 1`);
  const row = (result.rows as Array<{ announcement: string | null; opening: string | null }>)[0];
  return { opening: row?.opening ?? null, announcement: row?.announcement ?? null };
}

const NO_EXTRAS: WorldExtras = { opening: null, announcement: null, similar: [], siblings: [] };

/**
 * The extra blocks of a world's public page. Callers pass only a world that is
 * published, public and all-ages; anything else gets nothing.
 */
export function loadWorldExtras(world: AddressedWorld): Promise<WorldExtras> {
  if ((world.ageRating ?? "all") !== "all" || world.visibility !== "public") return Promise.resolve(NO_EXTRAS);
  return cached(`world:${world.id}`, TTL_PAGE_MS, async () => {
    const [text, similar, siblings] = await Promise.all([
      openingAndNote(world.id).catch(() => ({ opening: null, announcement: null })),
      similarWorlds(world).catch(() => [] as WorldCard[]),
      findLanguageSiblings(world).catch(() => [] as WorldVariant[]),
    ]);
    return {
      opening: cleanOpening(text.opening, world.name) || null,
      announcement: text.announcement?.trim() || null,
      similar,
      siblings,
    };
  });
}

// ── community ────────────────────────────────────────────────────────────────

export interface ForumInfo {
  id: string;
  name: string;
  slug: string;
  description: string;
}

export interface ThreadListItem {
  id: string;
  title: string;
  createdAt: Date | null;
  lastReplyAt: Date | null;
  replyCount: number;
  authorName: string | null;
  forumSlug: string;
  forumName: string;
}

/** What decides whether a thread may be indexed. */
export interface ThreadSignals {
  ageRating: string | null;
  isPinned: boolean;
  isOfficial: boolean;
  authorRole: string | null;
  /** Banned or suspended. */
  authorBlocked: boolean;
  /** Under a community mute right now. */
  authorMuted: boolean;
  authorCreatedAt: Date | string | null;
  /** Characters of the post as stored (markdown included). */
  bodyLength: number;
  /** Replies written by someone other than the author. */
  otherReplyCount: number;
}

export interface PublicThread extends ThreadSignals {
  id: string;
  title: string;
  content: string;
  lang: string | null;
  replyCount: number;
  likeCount: number;
  createdAt: Date | null;
  updatedAt: Date | null;
  lastReplyAt: Date | null;
  images: unknown;
  authorId: string;
  authorName: string | null;
  authorUsername: string | null;
  forumSlug: string;
  forumName: string;
}

export interface PublicReply {
  id: string;
  content: string;
  floor: number;
  createdAt: Date | null;
  authorId: string;
  authorName: string | null;
  authorUsername: string | null;
  authorRole: string | null;
}

/** Worlds a thread shares, shown on its first page. */
const THREAD_SHARED_WORLDS = 12;

export interface ThreadPage {
  thread: PublicThread;
  /** The worlds the post shares: public, all-ages ones only, in the author's order. */
  worlds: WorldCard[];
  /** The replies on this page. */
  replies: PublicReply[];
  /** 1-based. */
  page: number;
  pageCount: number;
  /** Replies shown across all pages. */
  replyTotal: number;
}

export interface PublicEvent {
  id: string;
  title: string;
  introduction: string;
  rewardDescription: string | null;
  lang: string | null;
  status: string;
  posterImageUrl: string | null;
  bannerImageUrl: string | null;
  registrationOpensAt: Date | null;
  registrationClosesAt: Date | null;
  updatedAt: Date | null;
}

/** Accounts whose posts the public pages do not carry. */
const authorInGoodStanding = and(eq(user.isBanned, false), eq(user.isSuspended, false));
/** What a logged-out visitor may open: the community's only wall is the thread's rating. */
const guestReadableThread = eq(threads.ageRating, "all");
/** What the public event route serves to a visitor (routes/community/events.ts). */
const guestReadableEvent = and(
  eq(communityEvents.isCached, false),
  or(eq(communityEvents.status, "live"), eq(communityEvents.status, "closed")),
);

const THREAD_LIST_COLUMNS = {
  id: threads.id,
  title: threads.title,
  createdAt: threads.createdAt,
  lastReplyAt: threads.lastReplyAt,
  replyCount: threads.replyCount,
  authorName: user.name,
  forumSlug: forums.slug,
  forumName: forums.name,
};

const EVENT_COLUMNS = {
  id: communityEvents.id,
  title: communityEvents.title,
  introduction: communityEvents.introduction,
  rewardDescription: communityEvents.rewardDescription,
  lang: communityEvents.lang,
  status: communityEvents.status,
  posterImageUrl: communityEvents.posterImageUrl,
  bannerImageUrl: communityEvents.bannerImageUrl,
  registrationOpensAt: communityEvents.registrationOpensAt,
  registrationClosesAt: communityEvents.registrationClosesAt,
  updatedAt: communityEvents.updatedAt,
};

const threadActivity = sql`COALESCE(${threads.lastReplyAt}, ${threads.createdAt})`;

function listForums(): Promise<ForumInfo[]> {
  return cached("forums", TTL_LIST_MS, () =>
    readPublic()
      .select({ id: forums.id, name: forums.name, slug: forums.slug, description: forums.description })
      .from(forums)
      .orderBy(asc(forums.sortOrder)),
  );
}

function listThreads(forumId: string | null, limit: number): Promise<ThreadListItem[]> {
  return readPublic()
    .select(THREAD_LIST_COLUMNS)
    .from(threads)
    .innerJoin(user, eq(threads.authorId, user.id))
    .innerJoin(forums, eq(threads.forumId, forums.id))
    .where(and(guestReadableThread, authorInGoodStanding, forumId ? eq(threads.forumId, forumId) : undefined))
    .orderBy(desc(threads.isPinned), desc(threadActivity))
    .limit(limit);
}

export interface CommunityIndex {
  forums: ForumInfo[];
  threads: ThreadListItem[];
  events: PublicEvent[];
}

/** The community's front page: its boards, the latest threads, the running events. */
export function loadCommunityIndex(): Promise<CommunityIndex> {
  return cached("community", TTL_LIST_MS, async () => {
    const [forumRows, threadRows, eventRows] = await Promise.all([
      listForums(),
      listThreads(null, COMMUNITY_RECENT_THREADS),
      readPublic()
        .select(EVENT_COLUMNS)
        .from(communityEvents)
        .where(and(eq(communityEvents.isCached, false), eq(communityEvents.status, "live")))
        .orderBy(desc(communityEvents.updatedAt))
        .limit(10),
    ]);
    return { forums: forumRows, threads: threadRows, events: eventRows };
  });
}

export interface ForumPage {
  forum: ForumInfo;
  threads: ThreadListItem[];
}

/** A board and its latest threads, or null when no board has that slug. */
export function loadForumPage(slug: string): Promise<ForumPage | null> {
  const key = slug.toLowerCase();
  return cached(`forum:${key}`, TTL_LIST_MS, async () => {
    const forum = (await listForums()).find((f) => f.slug === key);
    if (!forum) return null;
    return { forum, threads: await listThreads(forum.id, FORUM_THREADS) };
  });
}

/** SQL for the signals; the same expressions feed the thread page and the sitemap. */
const authorMutedSql = sql<boolean>`(
  (${user.isMuted} AND (${user.mutedUntil} IS NULL OR ${user.mutedUntil} > now()))
  OR EXISTS (SELECT 1 FROM ${userMutes} WHERE ${userMutes.userId} = ${user.id} AND ${userMutes.revokedAt} IS NULL AND ${userMutes.expiresAt} > now())
)`;
const SIGNAL_COLUMNS = {
  ageRating: threads.ageRating,
  isPinned: threads.isPinned,
  isOfficial: threads.isOfficial,
  authorRole: user.role,
  authorBlocked: sql<boolean>`(${user.isBanned} OR ${user.isSuspended})`,
  authorMuted: authorMutedSql,
  authorCreatedAt: user.createdAt,
  bodyLength: sql<number>`char_length(${threads.content})::int`,
  otherReplyCount: sql<number>`(SELECT count(*)::int FROM posts p WHERE p.thread_id = ${threads.id} AND p.author_id <> ${threads.authorId})`,
};

/** A thread whose text may appear in crawlable HTML: all-ages, author not banned or suspended. */
export function isPublicThread(thread: Pick<ThreadSignals, "ageRating" | "authorBlocked">): boolean {
  return (thread.ageRating ?? "all") === "all" && !thread.authorBlocked;
}

/** Staff, as the schema knows it: user.role = "admin". */
export function isStaffRole(role: string | null | undefined): boolean {
  return role === "admin";
}

/**
 * Whether a thread may be indexed: listed in the sitemap and served without
 * noindex. Not every post is.
 *  1. Never a thread a visitor cannot open (not all-ages) or one whose author
 *     is banned or suspended.
 *  2. Always a post marked official (threads.is_official), a pinned post
 *     (threads.is_pinned) or one written by staff (user.role = "admin").
 *  3. Any other post only when its author is in good standing (not muted, and
 *     the account is at least THREAD_MIN_ACCOUNT_AGE_DAYS old) AND it has
 *     THREAD_MIN_OTHER_REPLIES reply from another member or
 *     THREAD_MIN_BODY_CHARS characters of its own.
 * A thread that fails 3 today passes by itself once it qualifies.
 */
export function threadIndexable(t: ThreadSignals, now: Date = new Date()): boolean {
  if (!isPublicThread(t)) return false;
  if (t.isOfficial || t.isPinned || isStaffRole(t.authorRole)) return true;
  if (t.authorMuted) return false;
  const created = t.authorCreatedAt ? new Date(t.authorCreatedAt).getTime() : NaN;
  if (!(now.getTime() - created >= THREAD_MIN_ACCOUNT_AGE_DAYS * 86_400_000)) return false;
  return t.otherReplyCount >= THREAD_MIN_OTHER_REPLIES || t.bodyLength >= THREAD_MIN_BODY_CHARS;
}

/** The page number a `?page=` value asks for; anything that is not a whole number above 1 is page 1. */
export function parsePageParam(raw: string | null | undefined): number {
  if (!raw || !/^[1-9]\d{0,5}$/.test(raw)) return 1;
  return Number(raw);
}

/**
 * One page of a thread: the post and THREAD_REPLIES_PER_PAGE replies, oldest
 * first. Null when there is no such thread or no such page. A thread a
 * visitor cannot open comes back with no text and no replies, so the caller
 * can keep it out of search without calling it missing.
 */
export function loadThreadPage(threadId: string, page = 1): Promise<ThreadPage | null> {
  return cached(`thread:${threadId}:${page}`, TTL_PAGE_MS, async () => {
    const [thread] = await readPublic()
      .select({
        id: threads.id,
        title: threads.title,
        content: threads.content,
        lang: threads.lang,
        replyCount: threads.replyCount,
        likeCount: threads.likeCount,
        createdAt: threads.createdAt,
        updatedAt: threads.updatedAt,
        lastReplyAt: threads.lastReplyAt,
        images: threads.images,
        authorId: threads.authorId,
        authorName: user.name,
        authorUsername: user.username,
        forumSlug: forums.slug,
        forumName: forums.name,
        ...SIGNAL_COLUMNS,
      })
      .from(threads)
      .innerJoin(user, eq(threads.authorId, user.id))
      .innerJoin(forums, eq(threads.forumId, forums.id))
      .where(eq(threads.id, threadId))
      .limit(1);
    if (!thread) return null;
    if (!isPublicThread(thread)) {
      return page === 1 ? { thread: { ...thread, content: "", images: [] }, worlds: [], replies: [], page: 1, pageCount: 1, replyTotal: 0 } : null;
    }
    const visibleReply = and(eq(posts.threadId, threadId), authorInGoodStanding);
    const [counted] = await readPublic()
      .select({ total: sql<number>`count(*)::int` })
      .from(posts)
      .innerJoin(user, eq(posts.authorId, user.id))
      .where(visibleReply);
    const replyTotal = Number(counted?.total ?? 0);
    const pageCount = Math.max(1, Math.ceil(replyTotal / THREAD_REPLIES_PER_PAGE));
    if (page > pageCount) return null;
    const replies = await readPublic()
      .select({
        id: posts.id,
        content: posts.content,
        floor: posts.floor,
        createdAt: posts.createdAt,
        authorId: posts.authorId,
        authorName: user.name,
        authorUsername: user.username,
        authorRole: user.role,
      })
      .from(posts)
      .innerJoin(user, eq(posts.authorId, user.id))
      .where(visibleReply)
      .orderBy(asc(posts.floor))
      .limit(THREAD_REPLIES_PER_PAGE)
      .offset((page - 1) * THREAD_REPLIES_PER_PAGE);
    // A shared world is a link only when its own page is public: the same
    // filter every other list of worlds uses.
    const shared = await readPublic()
      .select(CARD_COLUMNS)
      .from(threadWorlds)
      .innerJoin(worlds, eq(threadWorlds.worldId, worlds.id))
      .leftJoin(user, eq(worlds.creatorId, user.id))
      .where(and(eq(threadWorlds.threadId, threadId), publicWorldFilter, worldAudienceCondition(worlds.creatorId)))
      .orderBy(asc(threadWorlds.sortOrder))
      .limit(THREAD_SHARED_WORLDS);
    return { thread, worlds: shared, replies, page, pageCount, replyTotal };
  });
}

/** A live or closed event, or null (missing, draft, or withdrawn). */
export function loadEventPage(eventId: string): Promise<PublicEvent | null> {
  return cached(`event:${eventId}`, TTL_PAGE_MS, async () => {
    const [event] = await readPublic()
      .select(EVENT_COLUMNS)
      .from(communityEvents)
      .where(and(eq(communityEvents.id, eventId), guestReadableEvent))
      .limit(1);
    return event ?? null;
  });
}

// ── community sitemap ────────────────────────────────────────────────────────

export interface SitemapThreadRow extends ThreadSignals {
  id: string;
  forumId: string;
  updatedAt: Date | null;
  lastReplyAt: Date | null;
}

export interface CommunitySitemapRows {
  /** Every board, dated by the newest activity among its all-ages threads. */
  forums: Array<ForumInfo & { lastActivityAt?: Date | null }>;
  /** Only threads that pass threadIndexable. */
  threads: SitemapThreadRow[];
  events: Array<{ id: string; updatedAt: Date | null }>;
}

/** Everything the community sitemap lists. Not cached here: the sitemap build is cached for an hour. */
export async function loadCommunitySitemapRows(): Promise<CommunitySitemapRows> {
  return runWithWorldViewer(undefined, async () => {
    const [forumRows, threadRows, eventRows] = await Promise.all([
      listForums(),
      readPublic()
        .select({
          id: threads.id,
          forumId: threads.forumId,
          updatedAt: threads.updatedAt,
          lastReplyAt: threads.lastReplyAt,
          ...SIGNAL_COLUMNS,
        })
        .from(threads)
        .innerJoin(user, eq(threads.authorId, user.id))
        .where(and(guestReadableThread, authorInGoodStanding))
        .orderBy(desc(threadActivity))
        .limit(SITEMAP_THREAD_LIMIT),
      readPublic()
        .select({ id: communityEvents.id, updatedAt: communityEvents.updatedAt })
        .from(communityEvents)
        .where(guestReadableEvent)
        .orderBy(desc(communityEvents.updatedAt))
        .limit(1000),
    ]);
    const newest = new Map<string, Date>();
    for (const t of threadRows) {
      const at = t.lastReplyAt ?? t.updatedAt;
      if (at && (!newest.has(t.forumId) || at > newest.get(t.forumId)!)) newest.set(t.forumId, at);
    }
    const now = new Date();
    return {
      forums: forumRows.map((f) => ({ ...f, lastActivityAt: newest.get(f.id) ?? null })),
      threads: threadRows.filter((t) => threadIndexable(t, now)),
      events: eventRows,
    };
  });
}
