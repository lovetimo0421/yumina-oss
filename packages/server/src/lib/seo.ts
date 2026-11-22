import { worldAudienceCondition } from "./world-publication-access.js";
import { eq, or, and, isNull, desc } from "drizzle-orm";
import { getKrewPublicPath, KREW_PREVIEW_IMAGE, parseProfileAddress, parseWorldAddress, profileAddressPath, TAG_PAGE_PREFIX, tagPageTitle } from "@yumina/shared";
import { readPublic } from "../db/index.js";
import { PUBLIC_ORIGIN } from "./env.js";
import { resolveImageCdn } from "./cdn-url.js";
import { cleanMarkdown, summarizeText, stripLeadingTitle } from "./seo-text.js";
import { isAppRoute } from "./app-routes.js";
import {
  isPublicThread,
  isStaffRole,
  loadCommunitySitemapRows,
  loadEventPage,
  loadForumPage,
  loadLandingData,
  loadTagCatalog,
  loadTagPage,
  loadThreadPage,
  loadWorldExtras,
  parsePageParam,
  TAG_SITEMAP_MIN_WORLDS,
  threadIndexable,
  type CommunitySitemapRows,
  type TagInfo,
  type TagPage,
  type ThreadPage,
} from "./public-pages.js";
import { listBlogPosts, type BlogPost } from "./blog.js";
import {
  listPublicUpdateEntries,
  loadUpdatePage,
  newestPublicUpdateDate,
  parseUpdatePath,
  updateDescription,
  updateLanguages,
  updatePath,
  UPDATES_DESCRIPTION,
  UPDATES_TITLE,
  type UpdatePage,
} from "./updates-public.js";
import { edition } from "../edition/index.js";
import { ATELIER_APP_PATH, ATELIER_PATH, atelierMeta, atelierPage, atelierPaths } from "./atelier-public.js";
import { looksLikeContactHandle } from "./handle-privacy.js";
import { findLandingPage, landingMeta, landingPaths } from "./landing-public.js";
import { PRICING_PATH, pricingMeta } from "./pricing-public.js";
import { breadcrumbLd } from "./public-page-parts.js";
import {
  canonicalProfilePath,
  canonicalWorldPath,
  findUserByHandle,
  findUserById,
  findWorldById,
  findWorldByPublicId,
  isPubliclyVisible,
  type AddressedUser,
  type AddressedWorld,
  type WorldVariant,
} from "./world-address.js";
import { worlds, user, bundles } from "../db/schema.js";

const SITE_URL = PUBLIC_ORIGIN;

// Titles and descriptions for the site pages were written by the owner
// (2026-09-30). They are quoted here as given; do not rewrite them.
// Rule: the home page is titled "Yumina", every other page is just its own
// name. Google shows the site name on its own line and the tab shows the
// icon, so the brand is never appended.
const DEFAULT_TITLE = "Yumina";
const DEFAULT_DESCRIPTION =
  "Open-source world engine and community turning entertainment interactive.";
// The home page (owner, 2026-11-04): the title says what you can do here in
// the words people search; the description names the kinds of worlds and the
// engine. Every other page keeps its own bare name; DEFAULT_TITLE stays the
// fallback for pages kept out of search.
const HOME_TITLE = "Yumina: Play Free AI Games & AI Roleplay - Sign Up to Play!";
const HOME_DESCRIPTION =
  "Play and create AI driven games, visual novels, anime characters and simulators. Built on open-source AI game engine. Free to play.";
// krew.io (the pirate .io game) redirects permanently to /krew, so this page is
// what search engines index for the game. Keep its identity, not Yumina's.
const KREW_TITLE = "Krew.io";
const KREW_DESCRIPTION =
  "Krew.io is a free online 3D pirate game. Captain a ship or join a krew, fire cannons, fish, trade and sink rivals to rule the seven seas. Play now, no download.";
// The same real game scene is visible in the public About section.
const KREW_IMAGE = `${SITE_URL}${KREW_PREVIEW_IMAGE.path}`;

export interface PageMeta {
  title: string;
  description: string;
  url: string;
  image?: string;
  /** Alt text for the social image (og:image:alt / twitter:image:alt). */
  imageAlt?: string;
  imageWidth?: number;
  imageHeight?: number;
  type?: string;
  /** BCP-47 language of the page's main content, written to <html lang>. */
  lang?: string;
  noindex?: boolean;
  /** With noindex: links on the page may still be followed ("noindex", not "noindex, nofollow"). */
  follow?: boolean;
  /** HTTP status the shell should answer with (404 for an address that resolves to nothing). */
  status?: number;
  /** Structured data emitted as a JSON-LD script in <head>. */
  jsonLd?: Record<string, unknown>;
  /** The same page in other languages (hreflang). Must include the page itself. */
  alternates?: Array<{ lang: string; url: string }>;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LANG_RE = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/;

const STATIC_META: Record<string, PageMeta> = {
  "/": {
    title: HOME_TITLE,
    description: HOME_DESCRIPTION,
    url: SITE_URL,
  },
  // Discover lives at the home address; this entry only serves a request that
  // reached the shell without being forwarded, so it points at the root.
  "/app/hub": {
    title: "Discover",
    description: "Find your favorite stories and become part of what happens.",
    url: SITE_URL,
  },
  "/app/community": {
    title: "Community",
    description: "Make friends here and share whatever you want.",
    url: `${SITE_URL}/app/community`,
  },
  "/app/bundles": {
    title: "Bundles",
    description:
      "Download or share community made resource packs to help you build your worlds easier!",
    url: `${SITE_URL}/app/bundles`,
  },
  "/app/worlds": {
    title: "Create",
    description: "Turn your story into a playable world, and invite us in.",
    url: `${SITE_URL}/app/worlds`,
  },
  "/krew": {
    title: KREW_TITLE,
    description: KREW_DESCRIPTION,
    url: `${SITE_URL}/krew`,
    image: KREW_IMAGE,
    imageAlt: KREW_PREVIEW_IMAGE.alt,
    imageWidth: KREW_PREVIEW_IMAGE.width,
    imageHeight: KREW_PREVIEW_IMAGE.height,
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "VideoGame",
      "@id": `${SITE_URL}/krew#game`,
      name: "Krew.io",
      alternateName: ["Krew IO", "Krew2.io", "Krew"],
      url: `${SITE_URL}/krew`,
      mainEntityOfPage: {
        "@type": "WebPage",
        "@id": `${SITE_URL}/krew`,
        primaryImageOfPage: {
          "@type": "ImageObject",
          url: KREW_IMAGE,
          width: KREW_PREVIEW_IMAGE.width,
          height: KREW_PREVIEW_IMAGE.height,
        },
      },
      sameAs: ["https://krew.io", "https://play.krew.io"],
      image: KREW_IMAGE,
      description: KREW_DESCRIPTION,
      keywords: "krew.io, krew, pirate game, .io game, multiplayer, ship battle, browser game, free online game",
      genre: ["Action", "Multiplayer", ".io game", "Pirate"],
      gamePlatform: ["Web browser", "Mobile web"],
      applicationCategory: "Game",
      operatingSystem: "Any",
      playMode: "MultiPlayer",
      inLanguage: "en",
      isAccessibleForFree: true,
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD", availability: "https://schema.org/InStock" },
      publisher: { "@type": "Organization", name: "Yumina", url: SITE_URL },
    },
  },
  // The update log. /updates is the address people share and the one
  // crawlers get the entries in (lib/updates-public.ts); the app forwards it
  // to /app/updates, which points back so search engines count one page.
  "/updates": {
    title: UPDATES_TITLE,
    description: UPDATES_DESCRIPTION,
    url: `${SITE_URL}/updates`,
  },
  "/app/updates": {
    title: UPDATES_TITLE,
    description: UPDATES_DESCRIPTION,
    url: `${SITE_URL}/updates`,
  },
  "/login": {
    title: "Sign in",
    description: "Welcome back to Yumina - hope to make you happy today.",
    url: `${SITE_URL}/login`,
  },
  "/register": {
    title: "Create account",
    description:
      "Join Yumina and find a world you feel at home in, or make the one you've been looking for.",
    url: `${SITE_URL}/register`,
  },
};

const NOINDEX_PREFIXES = [
  "/app/chat/",
  "/app/studio/",
  "/app/settings",
  "/app/profile",
  "/app/admin",
  "/app/messages",
  "/app/configs",
  "/app/plans",
  "/app/onboarding",
  "/app/preview/",
  "/app/prompts",
];

function hiddenMeta(path: string, status?: number): PageMeta {
  return {
    title: DEFAULT_TITLE,
    description: DEFAULT_DESCRIPTION,
    url: `${SITE_URL}${path}`,
    noindex: true,
    ...(status ? { status } : {}),
  };
}

function defaultMeta(path: string): PageMeta {
  return {
    title: DEFAULT_TITLE,
    description: DEFAULT_DESCRIPTION,
    url: `${SITE_URL}${path}`,
  };
}

function pageLang(lang: string | null | undefined): string | undefined {
  if (!lang) return undefined;
  const trimmed = lang.trim();
  return LANG_RE.test(trimmed) ? trimmed : undefined;
}

function isPublishedWorld(world: { status: string | null; isPublished: boolean | null }): boolean {
  return world.status === "published" || Boolean(world.isPublished);
}

/** Absolute URL for a site path, with non-ASCII (CJK names) percent-encoded. */
function absolute(path: string): string {
  return `${SITE_URL}${encodeURI(path)}`;
}

/**
 * A world card's page: its own name, the creator's own words, its cover.
 * `path` is the address being served; the canonical URL is the world's
 * current address when it has one, so old and stale links consolidate.
 */
/**
 * The sentence a search result shows under a world's name. The creator's
 * description when there is one; when it is missing or only a few words, the
 * opening scene carries it; a world with neither is described by what is
 * known about it (its tags and creator), never by the creator's name alone.
 */
export function worldDescription(
  world: Pick<AddressedWorld, "name" | "description" | "creatorName" | "tags">,
  opening?: string | null,
): string {
  const own = summarizeText(stripLeadingTitle(world.description, world.name));
  if (own.length >= 60) return own;
  const scene = summarizeText(opening, { max: own ? 155 - own.length - 1 : 155, min: own ? 40 : 90 });
  if (own && scene) return `${own} ${scene}`;
  if (scene) return scene;
  const byline = world.creatorName ? `By ${world.creatorName}.` : "";
  if (own) return byline ? `${own} ${byline}` : own;
  const tags = Array.isArray(world.tags)
    ? (world.tags as unknown[]).filter((t): t is string => typeof t === "string" && t.trim().length > 0).slice(0, 5)
    : [];
  const by = world.creatorName ? ` by ${world.creatorName}` : "";
  if (tags.length) return `${world.name}: an AI roleplay world${by} on Yumina. Tags: ${tags.join(", ")}.`;
  return world.creatorName ? `${world.name}: an AI roleplay world${by} on Yumina.` : DEFAULT_DESCRIPTION;
}

function buildWorldMeta(world: AddressedWorld, path: string, siblings: WorldVariant[] = [], opening?: string | null): PageMeta {
  // Limitless (non-all-ages) cards must never leak their real name,
  // description, or cover into crawler-visible HTML — payment-network
  // content monitors (and ad-platform crawlers) fetch these pages
  // logged-out. Serve the generic site meta + noindex instead.
  if ((world.ageRating ?? "all") !== "all") return hiddenMeta(path);

  const canonicalPath = canonicalWorldPath(world) ?? `/app/hub/${world.id}`;
  const url = absolute(canonicalPath);
  const description = worldDescription(world, opening);

  const image = resolveImageCdn(world.thumbnailUrl) ?? undefined;
  const lang = pageLang(world.language);
  const tags = Array.isArray(world.tags)
    ? (world.tags as unknown[]).filter((t): t is string => typeof t === "string" && t.trim().length > 0)
    : [];

  // Every public language of this world, this one included.
  const alternates = lang && siblings.length
    ? [
        { lang, url },
        ...siblings.flatMap((v) => {
          const p = canonicalWorldPath({ publicId: v.publicId, name: v.name, creatorUsername: v.creatorUsername });
          const l = pageLang(v.language);
          return p && l ? [{ lang: l, url: absolute(p) }] : [];
        }),
      ]
    : undefined;
  const isGame = Boolean(world.gamePath);
  const plays = Number(world.downloadCount ?? 0);
  const reviews = Number(world.reviewCount ?? 0);
  const rating = Number(world.averageRating ?? 0);

  return {
    title: world.name,
    description,
    url,
    image,
    imageAlt: image ? `${world.name} cover` : undefined,
    lang,
    ...(alternates ? { alternates } : {}),
    jsonLd: {
      "@context": "https://schema.org",
      // A playable world is a game to search engines; a story world is a work.
      ...(isGame
        ? { "@type": ["VideoGame", "SoftwareApplication"], applicationCategory: "GameApplication", operatingSystem: "Web browser",
            offers: { "@type": "Offer", price: 0, priceCurrency: "USD", availability: "https://schema.org/InStock" } }
        : { "@type": "CreativeWork" }),
      ...(tags.length ? { genre: tags.slice(0, 8) } : {}),
      isPartOf: { "@type": "WebSite", name: "Yumina", url: SITE_URL },
      ...(plays > 0 ? { interactionStatistic: { "@type": "InteractionCounter", interactionType: "https://schema.org/PlayAction", userInteractionCount: plays } } : {}),
      // Only real ratings, and only once there are enough to mean something.
      ...(reviews >= 3 && rating > 0 ? { aggregateRating: { "@type": "AggregateRating", ratingValue: Math.round(rating * 10) / 10, bestRating: 5, worstRating: 1, ratingCount: reviews } } : {}),
      ...(world.updatedAt ? { dateModified: new Date(world.updatedAt).toISOString() } : {}),
      // The listing has its own address; it describes the same game people
      // reach through its Play link. Keep that relationship explicit.
      ...(getKrewPublicPath(world.gamePath) ? {
        about: { "@type": "VideoGame", "@id": `${SITE_URL}/krew#game`, name: "Krew.io", url: `${SITE_URL}/krew` },
      } : {}),
      name: world.name,
      url,
      ...(image ? { image } : {}),
      description,
      ...(lang ? { inLanguage: lang } : {}),
      ...(tags.length ? { keywords: tags.join(", ") } : {}),
      ...(world.creatorName
        ? {
            author: {
              "@type": "Person",
              name: world.creatorName,
              ...(profileAddressPath(world.creatorUsername)
                ? { url: absolute(profileAddressPath(world.creatorUsername)!) }
                : {}),
            },
          }
        : {}),
      publisher: { "@type": "Organization", name: "Yumina", url: SITE_URL },
    },
  };
}

/** A member's public page: their name, their bio, their banner or avatar. */
function buildProfileMeta(person: AddressedUser, fallbackPath: string): PageMeta {
  if (person.isBanned || person.isSuspended) return hiddenMeta(fallbackPath);
  const name = person.name?.trim() || "Yumina member";
  const image = resolveImageCdn(person.banner || person.image) ?? undefined;
  const canonicalPath = canonicalProfilePath(person) ?? `/app/users/${person.id}`;
  return {
    title: name,
    description: summarizeText(person.bio) || `${name}'s worlds, reviews and followers.`,
    url: absolute(canonicalPath),
    image,
    imageAlt: image ? name : undefined,
    // A handle that is an email address or a phone number stays out of
    // search; the links to the member's worlds may still be followed.
    ...(looksLikeContactHandle(person.username) ? { noindex: true, follow: true } : {}),
  };
}

/** World meta with what the page itself shows: other languages and, for the description, the opening. */
async function worldMeta(world: AddressedWorld, path: string): Promise<PageMeta> {
  if ((world.ageRating ?? "all") !== "all") return hiddenMeta(path);
  const extras = await loadWorldExtras(world);
  return buildWorldMeta(world, path, extras.siblings, extras.opening);
}

/** A tag page: the tag's name, how many worlds carry it, and the list itself as structured data. */
export function buildTagMeta(page: TagPage): PageMeta {
  const { tag } = page;
  const url = `${SITE_URL}${TAG_PAGE_PREFIX}${tag.slug}`;
  const title = tagPageTitle(tag.label);
  const names = page.worlds.slice(0, 3).map((w) => w.name);
  const examples = names.length ? ` Including ${names.join(", ")}.` : "";
  const description = summarizeText(
    `${tag.count.toLocaleString("en-US")} ${tag.label} AI ${tag.count === 1 ? "world" : "worlds"} to play free on Yumina: games, roleplay and interactive stories tagged ${tag.label}.${examples}`,
    { max: 200 },
  );
  return {
    title,
    description,
    url,
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: title,
      url,
      description,
      isPartOf: { "@type": "WebSite", name: "Yumina", url: SITE_URL },
      about: { "@type": "DefinedTerm", name: tag.label },
      mainEntity: {
        "@type": "ItemList",
        numberOfItems: page.worlds.length,
        itemListElement: page.worlds.map((w, i) => ({
          "@type": "ListItem",
          position: i + 1,
          name: w.name,
          url: absolute(canonicalWorldPath(w) ?? `/app/hub/${w.id}`),
        })),
      },
    },
  };
}

function personLd(name: string | null, username: string | null, id: string, role?: string | null): Record<string, unknown> {
  const profile = profileAddressPath(username);
  return {
    "@type": "Person",
    name: name?.trim() || "Yumina member",
    url: absolute(profile ?? `/app/users/${id}`),
    // Staff are marked in the markup as well as on the page.
    ...(isStaffRole(role) ? { jobTitle: "Yumina staff", affiliation: { "@type": "Organization", name: "Yumina", url: SITE_URL } } : {}),
  };
}

function iso(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** A thread's address: the plain one for page 1, `?page=N` after it. Sorted, filtered and tracked views all point here. */
export function threadPageUrl(threadId: string, page = 1): string {
  return `${SITE_URL}/app/community/thread/${threadId}${page > 1 ? `?page=${page}` : ""}`;
}

/**
 * A community thread page.
 *  - A thread a visitor cannot open (not all-ages), or one whose author is
 *    banned or suspended, keeps the generic meta and stays out of search.
 *  - A thread that is public but does not pass the indexing rule
 *    (public-pages.ts threadIndexable) keeps its own title and description
 *    and carries noindex; it becomes indexable by itself once it passes.
 *  - An indexable thread carries DiscussionForumPosting + BreadcrumbList.
 * Each page of a long thread is its own canonical address with "Page N" in
 * the title; a reply has no address of its own.
 */
export function buildThreadMeta(page: ThreadPage, path: string, now: Date = new Date()): PageMeta {
  const { thread, replies } = page;
  if (!isPublicThread(thread)) return hiddenMeta(path);

  const first = threadPageUrl(thread.id);
  const url = threadPageUrl(thread.id, page.page);
  const firstImage = Array.isArray(thread.images)
    ? ((thread.images as Array<{ url?: unknown }>).find((i) => i && typeof i.url === "string")?.url as string | undefined)
    : undefined;
  const image = resolveImageCdn(firstImage) ?? undefined;
  const body = stripLeadingTitle(thread.content, thread.title);
  const text = cleanMarkdown(body);
  const lang = pageLang(thread.lang);
  const base: PageMeta = {
    title: `${thread.title}${page.page > 1 ? ` - Page ${page.page}` : ""} - ${thread.forumName} - Yumina Community`,
    // The opening of the first post, cut near 200 characters at a word boundary.
    description: summarizeText(body, { max: 200, min: 120 }) || thread.title,
    url,
    image,
    imageAlt: image ? thread.title : undefined,
    lang,
  };
  if (!threadIndexable(thread, now)) return { ...base, noindex: true, follow: true };

  const published = iso(thread.createdAt);
  const modified = iso(thread.updatedAt) ?? published;
  const forumUrl = `${SITE_URL}/app/community/${thread.forumSlug}`;
  const posting = {
    "@type": "DiscussionForumPosting",
    // One discussion, however many pages: every page names the first as the thread's address.
    "@id": first,
    url: first,
    mainEntityOfPage: url,
    headline: thread.title.slice(0, 110),
    text: (text || thread.title).slice(0, 5000),
    ...(published ? { datePublished: published } : {}),
    ...(modified ? { dateModified: modified } : {}),
    ...(lang ? { inLanguage: lang } : {}),
    ...(image ? { image } : {}),
    author: personLd(thread.authorName, thread.authorUsername, thread.authorId, thread.authorRole),
    // The world the post shares, as the thing the discussion is about.
    ...(page.worlds[0]
      ? { sharedContent: { "@type": "WebPage", name: page.worlds[0].name, url: absolute(canonicalWorldPath(page.worlds[0]) ?? `/app/hub/${page.worlds[0].id}`) } }
      : {}),
    isPartOf: { "@type": "CollectionPage", name: thread.forumName, url: forumUrl },
    commentCount: page.replyTotal,
    interactionStatistic: { "@type": "InteractionCounter", interactionType: "https://schema.org/LikeAction", userInteractionCount: thread.likeCount },
    // The replies on this page, the same ones the HTML shows.
    comment: replies.flatMap((r) => {
      const replyText = cleanMarkdown(r.content).slice(0, 2000);
      const at = iso(r.createdAt);
      if (!replyText) return [];
      return [{
        "@type": "Comment",
        text: replyText,
        ...(at ? { datePublished: at } : {}),
        author: personLd(r.authorName, r.authorUsername, r.authorId, r.authorRole),
      }];
    }),
  };
  const breadcrumb = {
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Community", item: `${SITE_URL}/app/community` },
      { "@type": "ListItem", position: 2, name: thread.forumName, item: forumUrl },
      { "@type": "ListItem", position: 3, name: thread.title, item: first },
    ],
  };
  return { ...base, jsonLd: { "@context": "https://schema.org", "@graph": [posting, breadcrumb] } };
}

/** A forum board: its name and its own description. */
async function forumMeta(slug: string): Promise<PageMeta | null> {
  const page = await loadForumPage(slug);
  if (!page) return null;
  const { forum } = page;
  return {
    title: forum.name,
    description: summarizeText(forum.description) || `${forum.name} threads on the Yumina community.`,
    url: `${SITE_URL}/app/community/${forum.slug}`,
  };
}

/** A resource pack: its name, the author's words, its cover. */
async function bundleMeta(path: string, bundleId: string): Promise<PageMeta | null> {
  const [bundle] = await readPublic()
    .select({
      name: bundles.name,
      description: bundles.description,
      coverImage: bundles.coverImage,
      isPublic: bundles.isPublic,
      reviewStatus: bundles.reviewStatus,
      language: bundles.language,
      creatorName: user.name,
    })
    .from(bundles)
    .leftJoin(user, eq(bundles.userId, user.id))
    .where(eq(bundles.id, bundleId))
    .limit(1);
  if (!bundle) return null;
  if (!bundle.isPublic || bundle.reviewStatus !== "approved") return hiddenMeta(path);

  const image = resolveImageCdn(bundle.coverImage) ?? undefined;
  const fallback = bundle.creatorName
    ? `A resource pack by ${bundle.creatorName}.`
    : "A resource pack on Yumina.";
  return {
    title: bundle.name,
    description: summarizeText(stripLeadingTitle(bundle.description, bundle.name)) || fallback,
    url: `${SITE_URL}${path}`,
    image,
    imageAlt: image ? `${bundle.name} cover` : undefined,
    lang: pageLang(bundle.language),
  };
}

/** A community event: its title, its introduction, its poster. */
async function eventMeta(eventId: string): Promise<PageMeta | null> {
  const event = await loadEventPage(eventId);
  // Missing, a draft, or withdrawn: nothing a visitor can open.
  if (!event) return null;

  const image = resolveImageCdn(event.posterImageUrl || event.bannerImageUrl) ?? undefined;
  const url = `${SITE_URL}/app/community/events/${eventId}`;
  const description = summarizeText(stripLeadingTitle(event.introduction, event.title)) || event.title;
  const lang = pageLang(event.lang);
  const starts = iso(event.registrationOpensAt);
  const ends = iso(event.registrationClosesAt);
  return {
    title: event.title,
    description,
    url,
    image,
    imageAlt: image ? event.title : undefined,
    lang,
    // schema.org requires a start date for an Event; without one the page keeps its plain meta.
    ...(starts
      ? {
          jsonLd: {
            "@context": "https://schema.org",
            "@type": "Event",
            name: event.title,
            url,
            description,
            startDate: starts,
            ...(ends ? { endDate: ends } : {}),
            ...(image ? { image } : {}),
            ...(lang ? { inLanguage: lang } : {}),
            eventAttendanceMode: "https://schema.org/OnlineEventAttendanceMode",
            eventStatus: "https://schema.org/EventScheduled",
            location: { "@type": "VirtualLocation", url },
            organizer: { "@type": "Organization", name: "Yumina", url: SITE_URL },
          },
        }
      : {}),
  };
}

/** Whether this edition has the plans page (hosted) and so a public pricing page. */
export const hasPricingPage = () => edition.info().features.billing;
/** Whether this edition has the Atelier (hosted image generation) and so its public pages. */
export const hasAtelierPages = () => edition.info().features.imageGeneration;
/** Whether this edition has Discover (hosted) and so the genre pages such as /ai-rpg. */
export const hasLandingPages = () => edition.info().features.hub;

/** One update-log entry's page: its own title and words, its other languages, Article data. */
export function buildUpdateMeta(page: UpdatePage): PageMeta {
  const url = `${SITE_URL}${updatePath(page.id, page.lang)}`;
  const description = updateDescription(page.html) || page.title;
  return {
    title: page.title,
    description,
    url,
    lang: page.lang,
    // Each language of an entry is its own address; English is the default.
    ...(page.languages.length > 1
      ? { alternates: page.languages.map((lang) => ({ lang, url: `${SITE_URL}${updatePath(page.id, lang)}` })) }
      : {}),
    jsonLd: {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "Article",
          "@id": url,
          url,
          mainEntityOfPage: url,
          headline: page.title.slice(0, 110),
          description,
          datePublished: page.date,
          dateModified: page.date,
          inLanguage: page.lang,
          ...(page.areas.length ? { articleSection: [...page.areas] } : {}),
          author: { "@type": "Organization", name: "Yumina", url: SITE_URL },
          publisher: { "@type": "Organization", name: "Yumina", url: SITE_URL },
          isPartOf: { "@type": "WebPage", name: UPDATES_TITLE, url: `${SITE_URL}/updates` },
        },
        breadcrumbLd([{ name: "Yumina", path: "/" }, { name: UPDATES_TITLE, path: "/updates" }, { name: page.title, path: updatePath(page.id, page.lang) }]),
      ],
    },
  };
}

/** The parts of a request's query string that change what a page is. Everything else is ignored. */
export interface PageQuery {
  /** `?page=`: the page of a long thread. */
  page?: string | null;
  /** The request carries a search term (`?search=` or `?q=`). */
  search?: boolean;
}

/**
 * Meta for a request. Sorted, filtered and tracking-parameter views get the
 * same meta as the plain address (the canonical URL never carries them); a
 * community search view is kept out of search.
 */
export async function getMetaForPath(rawPath: string, query: PageQuery = {}): Promise<PageMeta> {
  const meta = await resolveMeta(rawPath, query);
  if (query.search && rawPath.startsWith("/app/community") && !meta.noindex && !meta.status) {
    return { ...meta, noindex: true, follow: true, jsonLd: undefined };
  }
  return meta;
}

async function resolveMeta(rawPath: string, query: PageQuery): Promise<PageMeta> {
  // "/krew/" and "/krew" are one page: strip trailing slashes so both get the
  // same canonical URL and the same static entry.
  const path = rawPath.length > 1 ? rawPath.replace(/\/+$/, "") || "/" : rawPath;
  const staticMeta = STATIC_META[path];
  if (staticMeta) return staticMeta;

  // The public intro pages: pricing, the Atelier and its model and style
  // pages, and one page per update-log entry. Each is built from the same
  // lists the app reads, and an address that names nothing is a 404.
  // These addresses are lowercase; any other casing is the same page and points at the lowercase one.
  const lower = path.toLowerCase();
  if (lower === PRICING_PATH) return hasPricingPage() ? pricingMeta() : hiddenMeta(path, 404);
  if (lower === ATELIER_PATH || lower.startsWith(`${ATELIER_PATH}/`)) {
    const page = hasAtelierPages() ? atelierPage(lower) : null;
    return page ? page.meta : hiddenMeta(path, 404);
  }
  // The genre pages (/ai-rpg and the rest): the page's own words, and the
  // worlds it lists right now as structured data.
  const landing = findLandingPage(lower);
  if (landing) {
    if (!hasLandingPages()) return hiddenMeta(path, 404);
    try {
      return landingMeta(landing, await loadLandingData(landing.slug, landing.tags));
    } catch {
      return defaultMeta(path);
    }
  }
  // The tool itself is one click from the introduction and has nothing a
  // crawler can read, so it points at /atelier.
  if (path === ATELIER_APP_PATH && hasAtelierPages()) {
    const intro = atelierMeta();
    return { title: "Atelier", description: intro.description, url: intro.url };
  }
  if (parseUpdatePath(path)) {
    try {
      const page = await loadUpdatePage(path);
      return page ? buildUpdateMeta(page) : hiddenMeta(path, 404);
    } catch {
      return defaultMeta(path);
    }
  }

  // An address the app's router has no route for is not a page: a real 404,
  // so "/pricing" or a typo is never filed by search engines as an empty one.
  // The shell still goes out with it and the app shows its not-found screen.
  if (!isAppRoute(path)) return hiddenMeta(path, 404);

  if (NOINDEX_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return hiddenMeta(path);
  }

  try {
    // World address: /@username/world-name-<publicId>. Resolves by the id;
    // an address that resolves to nothing is a real 404 for crawlers.
    const worldAddress = parseWorldAddress(path);
    if (worldAddress) {
      const world = await findWorldByPublicId(worldAddress.publicId);
      if (!world || !isPublishedWorld(world)) return hiddenMeta(path, 404);
      if (world.visibility === "unlisted" || world.visibility === "followers") return hiddenMeta(path);
      if (!isPubliclyVisible(world)) return hiddenMeta(path, 404);
      return worldMeta(world, path);
    }

    // Creator address: /@username
    const handle = parseProfileAddress(path);
    if (handle) {
      const person = await findUserByHandle(handle);
      if (!person) return hiddenMeta(path, 404);
      return buildProfileMeta(person, path);
    }

    // Resource pack: /app/hub/bundles/:bundleId
    const bundleMatch = path.match(/^\/app\/hub\/bundles\/([^/]+)$/);
    if (bundleMatch && UUID_RE.test(bundleMatch[1]!)) {
      return (await bundleMeta(path, bundleMatch[1]!)) ?? defaultMeta(path);
    }

    // Old world link: /app/hub/:worldId (normally forwarded before reaching here)
    const worldMatch = path.match(/^\/app\/hub\/([^/]+)$/);
    if (worldMatch && UUID_RE.test(worldMatch[1]!)) {
      const world = await findWorldById(worldMatch[1]!);
      if (world?.visibility === "unlisted" || world?.visibility === "followers") return hiddenMeta(path);
      if (!world || !isPublishedWorld(world) || !isPubliclyVisible(world)) return defaultMeta(path);
      return worldMeta(world, path);
    }

    // World tag page: /app/tag/:slug. A slug that names no tag, or a tag no
    // public world carries, is a 404.
    if (path.startsWith(TAG_PAGE_PREFIX)) {
      const page = await loadTagPage(path.slice(TAG_PAGE_PREFIX.length));
      return page ? buildTagMeta(page) : hiddenMeta(path, 404);
    }

    // Community thread: /app/community/thread/:threadId(?page=N). No such
    // thread, or no such page of it, is a 404.
    const threadMatch = path.match(/^\/app\/community\/thread\/([^/]+)$/);
    if (threadMatch) {
      const page = UUID_RE.test(threadMatch[1]!) ? await loadThreadPage(threadMatch[1]!, parsePageParam(query.page)) : null;
      return page ? buildThreadMeta(page, path) : hiddenMeta(path, 404);
    }

    // Community event: /app/community/events/:eventId(/submit). The submit
    // form belongs to the same event and points at the event's own address.
    const eventMatch = path.match(/^\/app\/community\/events\/([^/]+)(\/.*)?$/);
    if (eventMatch) {
      const meta = UUID_RE.test(eventMatch[1]!) ? await eventMeta(eventMatch[1]!) : null;
      if (!meta) return hiddenMeta(path, 404);
      return eventMatch[2] ? { ...meta, jsonLd: undefined } : meta;
    }

    // Community forum: /app/community/:forumSlug (not new/tag/events/thread).
    // A slug no board has is a 404.
    const forumMatch = path.match(/^\/app\/community\/([^/]+)$/);
    if (forumMatch && !["new", "tag", "events", "thread"].includes(forumMatch[1]!)) {
      return (await forumMeta(forumMatch[1]!.toLowerCase())) ?? hiddenMeta(path, 404);
    }

    // Old profile link: /app/users/:userId(/followers|/following|/reviews|/achievements)
    const userMatch = path.match(/^\/app\/users\/([^/]+)(?:\/.*)?$/);
    if (userMatch) {
      const person = await findUserById(userMatch[1]!);
      return person ? buildProfileMeta(person, path) : defaultMeta(path);
    }
  } catch {
    // DB error — fall through to default
  }

  if (path.startsWith("/app/community/")) {
    return { ...STATIC_META["/app/community"]!, url: `${SITE_URL}${path}` };
  }

  return defaultMeta(path);
}

/** Put a page's real content into the otherwise empty app root. */
export function injectContent(baseHtml: string, fragment: string | null | undefined): string {
  if (!fragment) return baseHtml;
  return baseHtml.replace('<div id="root"></div>', `<div id="root">${fragment}</div>`);
}

function escapeText(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "&gt;");
}

/** The robots value of a page kept out of search; also sent as the X-Robots-Tag header. */
export function robotsValue(meta: Pick<PageMeta, "follow">): string {
  return meta.follow ? "noindex" : "noindex, nofollow";
}

export function injectMeta(baseHtml: string, meta: PageMeta): string {
  let html = baseHtml;

  // Every page is titled with its own name; the home page is "Yumina".
  html = html.replace(/<title>[^<]*<\/title>/, `<title>${escapeText(meta.title)}</title>`);

  if (meta.lang) {
    html = html.replace(/<html lang="[^"]*"/, `<html lang="${meta.lang}"`);
  }

  html = html.replace(
    /(<meta name="description" content=")[^"]*(" \/>)/,
    `$1${escapeAttr(meta.description)}$2`,
  );

  // A page that is not there has no canonical address: pointing one at
  // itself would tell search engines the missing address is the real one.
  html = meta.status === 404
    ? html.replace(/[ \t]*<link rel="canonical" href="[^"]*" \/>\r?\n?/, "")
    : html.replace(/(<link rel="canonical" href=")[^"]*(" \/>)/, `$1${meta.url}$2`);

  html = html.replace(
    /(<meta property="og:title" content=")[^"]*(" \/>)/,
    `$1${escapeAttr(meta.title)}$2`,
  );
  html = html.replace(
    /(<meta property="og:description" content=")[^"]*(" \/>)/,
    `$1${escapeAttr(meta.description)}$2`,
  );
  html = html.replace(
    /(<meta property="og:url" content=")[^"]*(" \/>)/,
    `$1${meta.url}$2`,
  );

  if (meta.image) {
    for (const [dimension, value] of [["width", meta.imageWidth], ["height", meta.imageHeight]] as const) {
      if (value !== undefined) {
        html = html.replace(
          new RegExp(`(<meta property="og:image:${dimension}" content=")[^"]*(" \\/>)`),
          (_match, before: string, after: string) => `${before}${value}${after}`,
        );
      }
    }
    html = html.replace(
      /(<meta property="og:image" content=")[^"]*(" \/>)/,
      `$1${escapeAttr(meta.image)}$2`,
    );
    html = html.replace(
      /(<meta name="twitter:image" content=")[^"]*(" \/>)/,
      `$1${escapeAttr(meta.image)}$2`,
    );
    if (meta.imageAlt) {
      html = html.replace(
        /(<meta property="og:image:alt" content=")[^"]*(" \/>)/,
        `$1${escapeAttr(meta.imageAlt)}$2`,
      );
      html = html.replace(
        /(<meta name="twitter:image:alt" content=")[^"]*(" \/>)/,
        `$1${escapeAttr(meta.imageAlt)}$2`,
      );
    }
  }

  html = html.replace(
    /(<meta name="twitter:title" content=")[^"]*(" \/>)/,
    `$1${escapeAttr(meta.title)}$2`,
  );
  html = html.replace(
    /(<meta name="twitter:description" content=")[^"]*(" \/>)/,
    `$1${escapeAttr(meta.description)}$2`,
  );

  if (meta.noindex) {
    html = html.replace(
      "</head>",
      `    <meta name="robots" content="${robotsValue(meta)}" />\n  </head>`,
    );
  }

  // One world, several languages: each version lists every version plus an
  // x-default (the English one when there is one), so search engines treat
  // them as translations, not as competing pages.
  if (meta.alternates && meta.alternates.length > 1) {
    const xDefault = meta.alternates.find((a) => /^en(-|$)/i.test(a.lang)) ?? meta.alternates[0]!;
    const links = [...meta.alternates.map((a) => `    <link rel="alternate" hreflang="${escapeAttr(a.lang)}" href="${escapeAttr(a.url)}" />`),
      `    <link rel="alternate" hreflang="x-default" href="${escapeAttr(xDefault.url)}" />`].join("\n");
    html = html.replace("</head>", `${links}\n  </head>`);
  }

  if (meta.jsonLd) {
    // "<" escaped so a "</script>" inside a string can never close the tag.
    const json = JSON.stringify(meta.jsonLd).replace(/</g, "\\u003c");
    html = html.replace("</head>", `    <script type="application/ld+json">${json}</script>
  </head>`);
  }

  return html;
}

// ── Sitemaps ─────────────────────────────────────────────────────────────────
// /sitemap.xml is an index of child sitemaps on this host: the site's own
// pages (home, public pages, the blog, /updates, creator and tag pages), the
// world addresses, and the community (boards, events, threads worth listing). A child never holds more than SITEMAP_URLS_PER_FILE entries; past
// that it splits into -1, -2, … on its own. docs.yumina.io keeps its own
// sitemap (robots.txt lists both): an index may not point at another host.
// One build, cached for 1 hour.

export const SITEMAP_URLS_PER_FILE = 40_000;
// Far above today's ~2k; bounds the hourly query if the catalogue grows.
const SITEMAP_WORLD_LIMIT = 200_000;

export interface SitemapUrl {
  /** The complete `<url>…</url>` block, exactly as it appeared in the old single sitemap. */
  xml: string;
  /** YYYY-MM-DD when the entry carries one; the child's lastmod in the index derives from it. */
  lastmod?: string;
}

export interface SitemapFiles {
  /** The index served at /sitemap.xml. */
  index: string;
  /** Child sitemaps by file name: sitemap-pages.xml, sitemap-worlds.xml or sitemap-worlds-1.xml, … */
  children: Map<string, string>;
}

const URLSET_OPEN = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n`;

function urlBlock(loc: string, body: string): string {
  return `  <url>\n    <loc>${loc}</loc>\n${body}  </url>\n`;
}

function newestLastmod(urls: SitemapUrl[]): string | undefined {
  let newest: string | undefined;
  for (const u of urls) if (u.lastmod && (!newest || u.lastmod > newest)) newest = u.lastmod;
  return newest;
}

/** `name.xml` when the list fits in one file; `name-1.xml`, `name-2.xml`, … when it does not. */
function splitSitemap(name: string, urls: SitemapUrl[], perFile: number): Array<{ file: string; urls: SitemapUrl[] }> {
  if (urls.length <= perFile) return [{ file: `${name}.xml`, urls }];
  const parts: Array<{ file: string; urls: SitemapUrl[] }> = [];
  for (let i = 0; i < urls.length; i += perFile) {
    parts.push({ file: `${name}-${parts.length + 1}.xml`, urls: urls.slice(i, i + perFile) });
  }
  return parts;
}

/**
 * Index + children from the two URL lists. Pure, so the split is testable
 * without a database; `perFile` is only lowered by tests.
 */
export function assembleSitemaps(
  lists: { pages: SitemapUrl[]; worlds: SitemapUrl[]; community?: SitemapUrl[] },
  perFile = SITEMAP_URLS_PER_FILE,
): SitemapFiles {
  const children = new Map<string, string>();
  let index = `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;
  const groups: Array<[string, SitemapUrl[]]> = [["sitemap-pages", lists.pages], ["sitemap-worlds", lists.worlds]];
  // The community child exists only when it has something to list.
  if (lists.community?.length) groups.push(["sitemap-community", lists.community]);
  for (const [name, urls] of groups) {
    for (const part of splitSitemap(name, urls, perFile)) {
      children.set(part.file, `${URLSET_OPEN}${part.urls.map((u) => u.xml).join("")}</urlset>`);
      const lastmod = newestLastmod(part.urls);
      index += `  <sitemap>\n    <loc>${SITE_URL}/${part.file}</loc>\n${lastmod ? `    <lastmod>${lastmod}</lastmod>\n` : ""}  </sitemap>\n`;
    }
  }
  index += `</sitemapindex>`;
  return { index, children };
}

let cachedSitemaps: SitemapFiles | null = null;
let cacheTime = 0;

/** Rebuild the sitemaps on the next request (a thread was removed or its standing changed). This process only. */
export function invalidateSitemaps(): void {
  cachedSitemaps = null;
  cacheTime = 0;
}
const CACHE_TTL = 60 * 60 * 1000;

export async function generateSitemaps(): Promise<SitemapFiles> {
  const now = Date.now();
  if (cachedSitemaps && now - cacheTime < CACHE_TTL) return cachedSitemaps;

  const staticPages = [
    { url: "/", changefreq: "daily", priority: "1.0" },
    { url: "/app/community", changefreq: "daily", priority: "0.7" },
    { url: "/app/bundles", changefreq: "weekly", priority: "0.6" },
    // /app/worlds is the signed-in "Create" page: it has nothing public to
    // show a crawler, so it is not listed.
    { url: "/krew", changefreq: "weekly", priority: "0.8" },
    { url: "/register", changefreq: "monthly", priority: "0.3" },
  ];

  let worldRows: { id: string; publicId: string | null; name: string; creatorUsername: string | null; updatedAt: Date | null; language: string | null; languageGroupId: string | null }[] = [];
  try {
    worldRows = await readPublic()
      .select({
        id: worlds.id,
        publicId: worlds.publicId,
        name: worlds.name,
        creatorUsername: user.username,
        updatedAt: worlds.updatedAt,
        language: worlds.language,
        languageGroupId: worlds.languageGroupId,
      })
      .from(worlds)
      .leftJoin(user, eq(worlds.creatorId, user.id))
      .where(
        and(
          or(
            eq(worlds.status, "published"),
            and(isNull(worlds.status), eq(worlds.isPublished, true)),
          ),
          // Never hand crawlers the URL list of Limitless cards — the sitemap
          // is the first thing payment-network content monitors fetch.
          eq(worlds.ageRating, "all"),
          worldAudienceCondition(worlds.creatorId),
          eq(worlds.visibility, "public"),
        ),
      )
      .orderBy(desc(worlds.updatedAt))
      .limit(SITEMAP_WORLD_LIMIT);
  } catch {
    // DB unavailable — static-only sitemap
  }

  const pages: SitemapUrl[] = [];
  const worldUrls: SitemapUrl[] = [];

  // The languages of each world, keyed by group, for hreflang entries.
  const groups = new Map<string, { lang: string; path: string }[]>();
  for (const w of worldRows) {
    if (!w.languageGroupId || !w.language) continue;
    const path = canonicalWorldPath(w) ?? `/app/hub/${w.id}`;
    const list = groups.get(w.languageGroupId) ?? [];
    list.push({ lang: w.language, path });
    groups.set(w.languageGroupId, list);
  }

  for (const page of staticPages) {
    pages.push({ xml: urlBlock(`${SITE_URL}${page.url}`, `    <changefreq>${page.changefreq}</changefreq>\n    <priority>${page.priority}</priority>\n`) });
  }

  // Blog: every post dated by its last change (`updated` when the front
  // matter has it, else `date`); the index and each category page dated by
  // the newest change among their posts, so a touched post shows from the top.
  const posts = listBlogPosts();
  if (posts.length) {
    const lastChange = (post: BlogPost) => post.updated ?? post.date;
    const newestChange = (list: BlogPost[]) => list.map(lastChange).sort().at(-1)!;
    const blogLastmod = newestChange(posts);
    pages.push({ xml: urlBlock(`${SITE_URL}/blog`, `    <lastmod>${blogLastmod}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.6</priority>\n`), lastmod: blogLastmod });
    for (const category of new Set(posts.map((p) => p.category))) {
      const lastmod = newestChange(posts.filter((p) => p.category === category));
      pages.push({ xml: urlBlock(`${SITE_URL}/blog/${category}`, `    <lastmod>${lastmod}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.5</priority>\n`), lastmod });
    }
    for (const topic of new Set(posts.map((p) => p.topic).filter((t): t is NonNullable<typeof t> => Boolean(t)))) {
      const lastmod = newestChange(posts.filter((p) => p.topic === topic));
      pages.push({ xml: urlBlock(`${SITE_URL}/blog/topic/${topic}`, `    <lastmod>${lastmod}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.6</priority>\n`), lastmod });
    }
    for (const post of posts) {
      const lastmod = lastChange(post);
      pages.push({ xml: urlBlock(`${SITE_URL}/blog/${post.slug}`, `    <lastmod>${lastmod}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.7</priority>\n`), lastmod });
    }
  }

  // The update log, dated by its newest public entry.
  const updated = await newestPublicUpdateDate();
  pages.push({
    xml: urlBlock(`${SITE_URL}/updates`, `${updated ? `    <lastmod>${updated}</lastmod>\n` : ""}    <changefreq>weekly</changefreq>\n    <priority>0.6</priority>\n`),
    ...(updated ? { lastmod: updated } : {}),
  });

  // Creator pages: one per creator with at least one public world. They are
  // the pages that link to the worlds, which is how crawlers reach them.
  const creators = new Set<string>();
  for (const w of worldRows) {
    if (w.creatorUsername) creators.add(w.creatorUsername.toLowerCase());
  }
  for (const username of creatorSitemapHandles(creators)) {
    pages.push({ xml: urlBlock(escapeXml(absolute(`/@${username}`)), `    <changefreq>weekly</changefreq>\n    <priority>0.5</priority>\n`) });
  }

  for (const w of worldRows) {
    const lastmod = w.updatedAt
      ? new Date(w.updatedAt).toISOString().split("T")[0]
      : undefined;
    const path = canonicalWorldPath(w) ?? `/app/hub/${w.id}`;
    const variants = w.languageGroupId ? groups.get(w.languageGroupId) ?? [] : [];
    const alternates = variants.length > 1
      ? variants.map((v) => `    <xhtml:link rel="alternate" hreflang="${escapeXml(v.lang)}" href="${escapeXml(absolute(v.path))}" />\n`).join("")
      : "";
    worldUrls.push({
      xml: urlBlock(escapeXml(absolute(path)), `${lastmod ? `    <lastmod>${lastmod}</lastmod>\n` : ""}${alternates}    <changefreq>weekly</changefreq>\n    <priority>0.6</priority>\n`),
      ...(lastmod ? { lastmod } : {}),
    });
  }

  // The public intro pages.
  const introPaths = [...(hasPricingPage() ? [PRICING_PATH] : []), ...(hasAtelierPages() ? atelierPaths() : [])];
  for (const introPath of introPaths) {
    pages.push({ xml: urlBlock(`${SITE_URL}${introPath}`, `    <changefreq>weekly</changefreq>\n    <priority>${introPath === PRICING_PATH || introPath === ATELIER_PATH ? "0.8" : "0.5"}</priority>\n`) });
  }

  // The genre pages. Their lists follow what is played, so they change daily.
  if (hasLandingPages()) pages.push(...landingSitemapUrls());

  // One page per public update-log entry, dated by the entry, with its languages.
  try {
    pages.push(...updateSitemapUrls(await listPublicUpdateEntries()));
  } catch {
    // The changelog could not be read: no entry pages this hour
  }

  // Tag pages: one per tag with enough public worlds to be a page worth
  // finding. A tag below the bar still has its page; it is just not listed.
  try {
    pages.push(...tagSitemapUrls([...(await loadTagCatalog()).values()]));
  } catch {
    // DB unavailable — no tag pages this hour
  }

  let community: SitemapUrl[] = [];
  try {
    community = communitySitemapUrls(await loadCommunitySitemapRows());
  } catch {
    // DB unavailable — no community child this hour
  }

  const files = assembleSitemaps({ pages, worlds: worldUrls, community });
  cachedSitemaps = files;
  cacheTime = now;
  return files;
}

/** Sitemap entries for the genre pages (/ai-rpg and the rest). Pure. */
export function landingSitemapUrls(): SitemapUrl[] {
  return landingPaths().map((path) => ({ xml: urlBlock(`${SITE_URL}${path}`, `    <changefreq>daily</changefreq>\n    <priority>0.8</priority>\n`) }));
}

/** The creator handles the sitemap lists: every one except those that are an email address or a phone number. Pure. */
export function creatorSitemapHandles(handles: Iterable<string>): string[] {
  return [...handles].filter((handle) => !looksLikeContactHandle(handle));
}

/** Sitemap entries for the update-log entry pages: every language of every public entry, each listing the others. Pure. */
export function updateSitemapUrls(entries: Array<{ id: string; date: string; title: Record<string, string | undefined>; html: Record<string, string | undefined> }>): SitemapUrl[] {
  const out: SitemapUrl[] = [];
  for (const entry of entries) {
    const languages = updateLanguages(entry);
    const alternates = languages.length > 1
      ? languages.map((lang) => `    <xhtml:link rel="alternate" hreflang="${escapeXml(lang)}" href="${escapeXml(`${SITE_URL}${updatePath(entry.id, lang)}`)}" />\n`).join("")
      : "";
    for (const lang of languages) {
      out.push({
        xml: urlBlock(escapeXml(`${SITE_URL}${updatePath(entry.id, lang)}`), `    <lastmod>${entry.date}</lastmod>\n${alternates}    <changefreq>monthly</changefreq>\n    <priority>0.5</priority>\n`),
        lastmod: entry.date,
      });
    }
  }
  return out;
}

/** Sitemap entries for the tag pages that pass TAG_SITEMAP_MIN_WORLDS. Pure. */
export function tagSitemapUrls(tags: TagInfo[]): SitemapUrl[] {
  return tags
    .filter((t) => t.count >= TAG_SITEMAP_MIN_WORLDS)
    .sort((a, b) => b.count - a.count || a.slug.localeCompare(b.slug))
    .map((t) => ({
      xml: urlBlock(escapeXml(absolute(`${TAG_PAGE_PREFIX}${t.slug}`)), `    <changefreq>weekly</changefreq>\n    <priority>0.5</priority>\n`),
    }));
}

/**
 * Sitemap entries for the community: every board, every live or closed event
 * and the threads that may be indexed (public-pages.ts threadIndexable; the
 * rows arrive already filtered). Only a thread's own address is listed: no
 * later pages, no reply links, no sorted views. Pure.
 */
export function communitySitemapUrls(rows: CommunitySitemapRows): SitemapUrl[] {
  const day = (value: Date | null | undefined) => (value ? new Date(value).toISOString().split("T")[0] : undefined);
  const out: SitemapUrl[] = [];
  for (const forum of rows.forums) {
    const lastmod = day(forum.lastActivityAt);
    out.push({
      xml: urlBlock(escapeXml(absolute(`/app/community/${forum.slug}`)), `${lastmod ? `    <lastmod>${lastmod}</lastmod>\n` : ""}    <changefreq>daily</changefreq>\n    <priority>0.5</priority>\n`),
      ...(lastmod ? { lastmod } : {}),
    });
  }
  for (const event of rows.events) {
    const lastmod = day(event.updatedAt);
    out.push({
      xml: urlBlock(`${SITE_URL}/app/community/events/${event.id}`, `${lastmod ? `    <lastmod>${lastmod}</lastmod>\n` : ""}    <changefreq>weekly</changefreq>\n    <priority>0.5</priority>\n`),
      ...(lastmod ? { lastmod } : {}),
    });
  }
  for (const thread of rows.threads) {
    const updated = day(thread.updatedAt);
    const replied = day(thread.lastReplyAt);
    const lastmod = updated && replied ? (updated > replied ? updated : replied) : updated ?? replied;
    out.push({
      xml: urlBlock(`${SITE_URL}/app/community/thread/${thread.id}`, `${lastmod ? `    <lastmod>${lastmod}</lastmod>\n` : ""}    <changefreq>weekly</changefreq>\n    <priority>0.4</priority>\n`),
      ...(lastmod ? { lastmod } : {}),
    });
  }
  return out;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
