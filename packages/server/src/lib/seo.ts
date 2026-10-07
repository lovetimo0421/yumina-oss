import { worldAudienceCondition } from "./world-publication-access.js";
import { eq, or, and, isNull, desc } from "drizzle-orm";
import { getKrewPublicPath, KREW_PREVIEW_IMAGE, parseProfileAddress, parseWorldAddress, profileAddressPath } from "@yumina/shared";
import { readPublic } from "../db/index.js";
import { PUBLIC_ORIGIN } from "./env.js";
import { resolveImageCdn } from "./cdn-url.js";
import { summarizeText, stripLeadingTitle } from "./seo-text.js";
import { listBlogPosts } from "./blog.js";
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
} from "./world-address.js";
import { worlds, user, threads, forums, bundles, communityEvents } from "../db/schema.js";

const SITE_URL = PUBLIC_ORIGIN;

// Titles and descriptions for the site pages were written by the owner
// (2026-09-30). They are quoted here as given; do not rewrite them.
// Rule: the home page is titled "Yumina", every other page is just its own
// name. Google shows the site name on its own line and the tab shows the
// icon, so the brand is never appended.
const DEFAULT_TITLE = "Yumina";
const DEFAULT_DESCRIPTION =
  "Open-source world engine and community turning entertainment interactive.";
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
  /** HTTP status the shell should answer with (404 for an address that resolves to nothing). */
  status?: number;
  /** Structured data emitted as a JSON-LD script in <head>. */
  jsonLd?: Record<string, unknown>;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LANG_RE = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/;

const STATIC_META: Record<string, PageMeta> = {
  "/": {
    title: DEFAULT_TITLE,
    description: DEFAULT_DESCRIPTION,
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
function buildWorldMeta(world: AddressedWorld, path: string): PageMeta {
  // Limitless (non-all-ages) cards must never leak their real name,
  // description, or cover into crawler-visible HTML — payment-network
  // content monitors (and ad-platform crawlers) fetch these pages
  // logged-out. Serve the generic site meta + noindex instead.
  if ((world.ageRating ?? "all") !== "all") return hiddenMeta(path);

  const canonicalPath = canonicalWorldPath(world) ?? `/app/hub/${world.id}`;
  const url = absolute(canonicalPath);
  let description = summarizeText(stripLeadingTitle(world.description, world.name));
  const byline = world.creatorName ? `By ${world.creatorName}.` : "";
  if (!description) description = byline || DEFAULT_DESCRIPTION;
  else if (description.length < 60 && byline) description = `${description} ${byline}`;

  const image = resolveImageCdn(world.thumbnailUrl) ?? undefined;
  const lang = pageLang(world.language);
  const tags = Array.isArray(world.tags)
    ? (world.tags as unknown[]).filter((t): t is string => typeof t === "string" && t.trim().length > 0)
    : [];

  return {
    title: world.name,
    description,
    url,
    image,
    imageAlt: image ? `${world.name} cover` : undefined,
    lang,
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "CreativeWork",
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
  };
}

/** A community thread: its title, the opening of the post, its first image. */
async function threadMeta(path: string, threadId: string): Promise<PageMeta | null> {
  const [thread] = await readPublic()
    .select({
      title: threads.title,
      content: threads.content,
      images: threads.images,
      lang: threads.lang,
      ageRating: threads.ageRating,
    })
    .from(threads)
    .where(eq(threads.id, threadId))
    .limit(1);
  if (!thread) return null;
  if ((thread.ageRating ?? "all") !== "all") return hiddenMeta(path);

  const firstImage = Array.isArray(thread.images)
    ? thread.images.find((i) => i && typeof i.url === "string")?.url
    : undefined;
  const image = resolveImageCdn(firstImage) ?? undefined;
  const description = summarizeText(stripLeadingTitle(thread.content, thread.title)) || thread.title;
  return {
    title: thread.title,
    description,
    url: `${SITE_URL}${path}`,
    image,
    imageAlt: image ? thread.title : undefined,
    lang: pageLang(thread.lang),
  };
}

/** A forum board: its name and its own description. */
async function forumMeta(path: string, slug: string): Promise<PageMeta | null> {
  const [forum] = await readPublic()
    .select({ name: forums.name, description: forums.description })
    .from(forums)
    .where(eq(forums.slug, slug))
    .limit(1);
  if (!forum) return null;
  return {
    title: forum.name,
    description: summarizeText(forum.description) || `${forum.name} threads on the Yumina community.`,
    url: `${SITE_URL}${path}`,
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
      language: bundles.language,
      creatorName: user.name,
    })
    .from(bundles)
    .leftJoin(user, eq(bundles.userId, user.id))
    .where(eq(bundles.id, bundleId))
    .limit(1);
  if (!bundle) return null;
  if (!bundle.isPublic) return hiddenMeta(path);

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
async function eventMeta(path: string, eventId: string): Promise<PageMeta | null> {
  const [event] = await readPublic()
    .select({
      title: communityEvents.title,
      introduction: communityEvents.introduction,
      posterImageUrl: communityEvents.posterImageUrl,
      bannerImageUrl: communityEvents.bannerImageUrl,
      status: communityEvents.status,
      lang: communityEvents.lang,
    })
    .from(communityEvents)
    .where(eq(communityEvents.id, eventId))
    .limit(1);
  if (!event) return null;
  if (event.status === "draft") return hiddenMeta(path);

  const image = resolveImageCdn(event.posterImageUrl || event.bannerImageUrl) ?? undefined;
  return {
    title: event.title,
    description: summarizeText(stripLeadingTitle(event.introduction, event.title)) || event.title,
    url: `${SITE_URL}/app/community/events/${eventId}`,
    image,
    imageAlt: image ? event.title : undefined,
    lang: pageLang(event.lang),
  };
}

export async function getMetaForPath(rawPath: string): Promise<PageMeta> {
  // "/krew/" and "/krew" are one page: strip trailing slashes so both get the
  // same canonical URL and the same static entry.
  const path = rawPath.length > 1 ? rawPath.replace(/\/+$/, "") || "/" : rawPath;
  const staticMeta = STATIC_META[path];
  if (staticMeta) return staticMeta;

  if (NOINDEX_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return hiddenMeta(path);
  }

  try {
    // World address: /@username/world-name-<publicId>. Resolves by the id;
    // an address that resolves to nothing is a real 404 for crawlers.
    const worldAddress = parseWorldAddress(path);
    if (worldAddress) {
      const world = await findWorldByPublicId(worldAddress.publicId);
      if (!world || !isPublishedWorld(world) || !isPubliclyVisible(world)) return hiddenMeta(path, 404);
      return buildWorldMeta(world, path);
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
      if (!world || !isPublishedWorld(world) || !isPubliclyVisible(world)) return defaultMeta(path);
      return buildWorldMeta(world, path);
    }

    // Community thread: /app/community/thread/:threadId
    const threadMatch = path.match(/^\/app\/community\/thread\/([^/]+)$/);
    if (threadMatch && UUID_RE.test(threadMatch[1]!)) {
      return (await threadMeta(path, threadMatch[1]!)) ?? defaultMeta(path);
    }

    // Community event: /app/community/events/:eventId(/submit)
    const eventMatch = path.match(/^\/app\/community\/events\/([^/]+)(?:\/.*)?$/);
    if (eventMatch && UUID_RE.test(eventMatch[1]!)) {
      return (await eventMeta(path, eventMatch[1]!)) ?? defaultMeta(path);
    }

    // Community forum: /app/community/:forumSlug (not new/tag/events/thread)
    const forumMatch = path.match(/^\/app\/community\/([a-z0-9-]+)$/);
    if (forumMatch && !["new", "tag", "events", "thread"].includes(forumMatch[1]!)) {
      return (await forumMeta(path, forumMatch[1]!)) ?? { ...STATIC_META["/app/community"]!, url: `${SITE_URL}${path}` };
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

  html = html.replace(
    /(<link rel="canonical" href=")[^"]*(" \/>)/,
    `$1${meta.url}$2`,
  );

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
      `    <meta name="robots" content="noindex, nofollow" />\n  </head>`,
    );
  }

  if (meta.jsonLd) {
    // "<" escaped so a "</script>" inside a string can never close the tag.
    const json = JSON.stringify(meta.jsonLd).replace(/</g, "<");
    html = html.replace("</head>", `    <script type="application/ld+json">${json}</script>
  </head>`);
  }

  return html;
}

// Sitemap generation — returns XML string, cached for 1 hour
let cachedSitemap: string | null = null;
let cacheTime = 0;
const CACHE_TTL = 60 * 60 * 1000;

export async function generateSitemap(): Promise<string> {
  const now = Date.now();
  if (cachedSitemap && now - cacheTime < CACHE_TTL) return cachedSitemap;

  const staticPages = [
    { url: "/", changefreq: "daily", priority: "1.0" },
    { url: "/app/community", changefreq: "daily", priority: "0.7" },
    { url: "/app/bundles", changefreq: "weekly", priority: "0.6" },
    { url: "/app/worlds", changefreq: "weekly", priority: "0.5" },
    { url: "/krew", changefreq: "weekly", priority: "0.8" },
    { url: "/register", changefreq: "monthly", priority: "0.3" },
  ];

  let worldRows: { id: string; publicId: string | null; name: string; creatorUsername: string | null; updatedAt: Date | null }[] = [];
  try {
    worldRows = await readPublic()
      .select({
        id: worlds.id,
        publicId: worlds.publicId,
        name: worlds.name,
        creatorUsername: user.username,
        updatedAt: worlds.updatedAt,
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
      .limit(49000);
  } catch {
    // DB unavailable — static-only sitemap
  }

  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;

  for (const page of staticPages) {
    xml += `  <url>\n    <loc>${SITE_URL}${page.url}</loc>\n    <changefreq>${page.changefreq}</changefreq>\n    <priority>${page.priority}</priority>\n  </url>\n`;
  }

  // Blog: the index and every post, with the post's last change as lastmod.
  const posts = listBlogPosts();
  if (posts.length) {
    xml += `  <url>\n    <loc>${SITE_URL}/blog</loc>\n    <changefreq>weekly</changefreq>\n    <priority>0.6</priority>\n  </url>\n`;
    for (const post of posts) {
      xml += `  <url>\n    <loc>${SITE_URL}/blog/${post.slug}</loc>\n    <lastmod>${post.updated ?? post.date}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.7</priority>\n  </url>\n`;
    }
  }

  // Creator pages: one per creator with at least one public world. They are
  // the pages that link to the worlds, which is how crawlers reach them.
  const creators = new Set<string>();
  for (const w of worldRows) {
    if (w.creatorUsername) creators.add(w.creatorUsername.toLowerCase());
  }
  for (const username of creators) {
    xml += `  <url>\n    <loc>${escapeXml(absolute(`/@${username}`))}</loc>\n    <changefreq>weekly</changefreq>\n    <priority>0.5</priority>\n  </url>\n`;
  }

  for (const w of worldRows) {
    const lastmod = w.updatedAt
      ? new Date(w.updatedAt).toISOString().split("T")[0]
      : undefined;
    const path = canonicalWorldPath(w) ?? `/app/hub/${w.id}`;
    xml += `  <url>\n    <loc>${escapeXml(absolute(path))}</loc>\n${lastmod ? `    <lastmod>${lastmod}</lastmod>\n` : ""}    <changefreq>weekly</changefreq>\n    <priority>0.6</priority>\n  </url>\n`;
  }

  xml += `</urlset>`;

  cachedSitemap = xml;
  cacheTime = now;
  return xml;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
