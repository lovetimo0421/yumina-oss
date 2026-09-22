import { eq, or, and, isNull, desc } from "drizzle-orm";
import { readPublic } from "../db/index.js";
import { PUBLIC_ORIGIN } from "./env.js";
import { worlds } from "../db/schema.js";
import { user } from "../db/schema.js";

const SITE_URL = PUBLIC_ORIGIN;
const DEFAULT_DESCRIPTION =
  "Play and create AI-powered interactive worlds on Yumina. Open-source platform for AI-native games, interactive fiction, and roleplay. Browse thousands of worlds or build your own with Studio AI.";
const DEFAULT_TITLE = "Yumina - AI Interactive Fiction Platform";
// krew.io (the pirate .io game) redirects permanently to /krew, so this page is
// what search engines index for the game. Keep its identity, not Yumina's.
const KREW_DESCRIPTION =
  "Krew.io is a free online 3D pirate game: crew up, sail the seas, fire cannons, sink other players' ships and rule the leaderboard. Play instantly in your browser on Yumina.";

export interface PageMeta {
  title: string;
  description: string;
  url: string;
  image?: string;
  type?: string;
  noindex?: boolean;
  /** Structured data emitted as a JSON-LD script in <head>. */
  jsonLd?: Record<string, unknown>;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STATIC_META: Record<string, PageMeta> = {
  "/": {
    title: DEFAULT_TITLE,
    description: DEFAULT_DESCRIPTION,
    url: SITE_URL,
  },
  "/app/hub": {
    title: "Yumina - Browse AI Worlds",
    description:
      "Discover thousands of AI-powered interactive worlds. RPGs, visual novels, horror, romance, strategy games and more — play for free or build your own.",
    url: `${SITE_URL}/app/hub`,
  },
  "/app/community": {
    title: "Community - Yumina",
    description:
      "Join the Yumina community. Share your creations, get feedback, discuss AI interactive fiction, and connect with creators and players.",
    url: `${SITE_URL}/app/community`,
  },
  "/app/bundles": {
    title: "World Bundles - Yumina",
    description:
      "Browse curated bundles of AI interactive worlds on Yumina. Themed collections assembled by creators and the community.",
    url: `${SITE_URL}/app/bundles`,
  },
  "/app/worlds": {
    title: "Create a World - Yumina",
    description:
      "Build AI-powered interactive worlds with Yumina Studio. No coding required — Studio AI writes the code for you. Earn 80% revenue share as a creator.",
    url: `${SITE_URL}/app/worlds`,
  },
  "/krew": {
    title: "Krew.io - The Pirate .IO Game",
    description: KREW_DESCRIPTION,
    url: `${SITE_URL}/krew`,
    image: `${SITE_URL}/krew-og.png`,
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "VideoGame",
      name: "Krew.io",
      alternateName: "Krew2.io",
      url: `${SITE_URL}/krew`,
      image: `${SITE_URL}/krew-og.png`,
      description: KREW_DESCRIPTION,
      genre: ["Action", "Multiplayer", ".io game"],
      gamePlatform: "Web browser",
      applicationCategory: "Game",
      operatingSystem: "Any",
      playMode: "MultiPlayer",
      isAccessibleForFree: true,
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      publisher: { "@type": "Organization", name: "Yumina", url: SITE_URL },
    },
  },
  "/login": {
    title: "Sign In - Yumina",
    description:
      "Sign in to Yumina to play, create, and share AI interactive worlds.",
    url: `${SITE_URL}/login`,
  },
  "/register": {
    title: "Create Account - Yumina",
    description:
      "Join Yumina — the open-source AI interactive fiction platform. Play worlds, build worlds, earn revenue from your creations.",
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
];

export async function getMetaForPath(rawPath: string): Promise<PageMeta> {
  // "/krew/" and "/krew" are one page: strip trailing slashes so both get the
  // same canonical URL and the same static entry.
  const path = rawPath.length > 1 ? rawPath.replace(/\/+$/, "") || "/" : rawPath;
  const staticMeta = STATIC_META[path];
  if (staticMeta) return staticMeta;

  if (NOINDEX_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return {
      title: "Yumina",
      description: DEFAULT_DESCRIPTION,
      url: `${SITE_URL}${path}`,
      noindex: true,
    };
  }

  // World detail: /app/hub/:worldId
  const worldMatch = path.match(/^\/app\/hub\/([^/]+)$/);
  if (worldMatch && UUID_RE.test(worldMatch[1]!)) {
    try {
      const [world] = await readPublic()
        .select({
          name: worlds.name,
          description: worlds.description,
          thumbnailUrl: worlds.thumbnailUrl,
          isPublished: worlds.isPublished,
          status: worlds.status,
          ageRating: worlds.ageRating,
          visibility: worlds.visibility,
          creatorName: user.name,
        })
        .from(worlds)
        .leftJoin(user, eq(worlds.creatorId, user.id))
        .where(eq(worlds.id, worldMatch[1]!))
        .limit(1);

      // Limitless (non-all-ages) cards must never leak their real name,
      // description, or cover into crawler-visible HTML — payment-network
      // content monitors (and ad-platform crawlers) fetch these pages
      // logged-out. Serve the generic site meta + noindex instead.
      if (
        world &&
        (world.status === "published" || world.isPublished) &&
        (world.ageRating ?? "all") !== "all"
      ) {
        return {
          title: DEFAULT_TITLE,
          description: DEFAULT_DESCRIPTION,
          url: `${SITE_URL}/app/hub/${worldMatch[1]}`,
          noindex: true,
        };
      }

      if (
        world &&
        (world.status === "published" || world.isPublished) &&
        world.visibility === "public"
      ) {
        const desc = world.description
          ? world.description.slice(0, 155).replace(/[\n\r]+/g, " ").trim() +
            (world.description.length > 155 ? "..." : "")
          : DEFAULT_DESCRIPTION;
        return {
          title: `${world.name}${world.creatorName ? ` by ${world.creatorName}` : ""} - Yumina`,
          description: desc,
          url: `${SITE_URL}/app/hub/${worldMatch[1]}`,
          image: world.thumbnailUrl || undefined,
        };
      }
    } catch {
      // DB error — fall through to default
    }
  }

  // Community thread: /app/community/thread/:threadId
  if (path.startsWith("/app/community/thread/")) {
    return {
      title: "Community Discussion - Yumina",
      description:
        "Read and join the conversation in the Yumina community. Discuss AI interactive fiction, share tips, and connect with other players and creators.",
      url: `${SITE_URL}${path}`,
    };
  }

  // Community forum: /app/community/:forumSlug
  if (path.startsWith("/app/community/")) {
    return {
      title: "Community - Yumina",
      description:
        "Browse discussions in the Yumina community. Share your creations, get feedback, and connect with creators and players.",
      url: `${SITE_URL}${path}`,
    };
  }

  // User profile: /app/users/:userId
  if (path.startsWith("/app/users/")) {
    return {
      title: "Creator Profile - Yumina",
      description:
        "View this creator's profile and published worlds on Yumina, the open-source AI interactive fiction platform.",
      url: `${SITE_URL}${path}`,
    };
  }

  return {
    title: DEFAULT_TITLE,
    description: DEFAULT_DESCRIPTION,
    url: `${SITE_URL}${path}`,
  };
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

  // Browser tabs use the brand consistently; route-specific titles belong to
  // the social/link-preview metadata below.
  html = html.replace(/<title>[^<]*<\/title>/, "<title>Yumina</title>");

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
    html = html.replace(
      /(<meta property="og:image" content=")[^"]*(" \/>)/,
      `$1${meta.image}$2`,
    );
    html = html.replace(
      /(<meta name="twitter:image" content=")[^"]*(" \/>)/,
      `$1${meta.image}$2`,
    );
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
    const json = JSON.stringify(meta.jsonLd).replace(/</g, "\u003c");
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
    { url: "/app/hub", changefreq: "daily", priority: "1.0" },
    { url: "/app/community", changefreq: "daily", priority: "0.7" },
    { url: "/app/bundles", changefreq: "weekly", priority: "0.6" },
    { url: "/app/worlds", changefreq: "weekly", priority: "0.5" },
    { url: "/krew", changefreq: "weekly", priority: "0.8" },
    { url: "/register", changefreq: "monthly", priority: "0.3" },
  ];

  let worldRows: { id: string; updatedAt: Date | null }[] = [];
  try {
    worldRows = await readPublic()
      .select({ id: worlds.id, updatedAt: worlds.updatedAt })
      .from(worlds)
      .where(
        and(
          or(
            eq(worlds.status, "published"),
            and(isNull(worlds.status), eq(worlds.isPublished, true)),
          ),
          // Never hand crawlers the URL list of Limitless cards — the sitemap
          // is the first thing payment-network content monitors fetch.
          eq(worlds.ageRating, "all"),
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

  for (const w of worldRows) {
    const lastmod = w.updatedAt
      ? new Date(w.updatedAt).toISOString().split("T")[0]
      : undefined;
    xml += `  <url>\n    <loc>${SITE_URL}/app/hub/${w.id}</loc>\n${lastmod ? `    <lastmod>${lastmod}</lastmod>\n` : ""}    <changefreq>weekly</changefreq>\n    <priority>0.6</priority>\n  </url>\n`;
  }

  xml += `</urlset>`;

  cachedSitemap = xml;
  cacheTime = now;
  return xml;
}
