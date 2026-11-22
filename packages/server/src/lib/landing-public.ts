/**
 * The genre pages: yumina.io/ai-rpg, /ai-roleplay, /ai-text-adventure,
 * /ai-games, /ai-chat, /multiplayer-ai-games, /ai-visual-novel,
 * /ai-story-games and /ai-dungeon-master.
 *
 * Each is a browse page for one kind of play. It lists the most played
 * public, all-ages worlds carrying any of the page's tags (the same filter as
 * a tag page, public-pages.ts loadLandingData), with a few true sentences
 * around the list: what this kind of play is, how a session goes, and the
 * questions people ask about it.
 *
 * A page's title, headline and intro are in GENRE_PAGES (@yumina/shared),
 * because Discover's hero in the app shows them too. The rest of its words are
 * in LANDING_PAGES below. A new page is a new entry in both plus a route file
 * in the app (packages/app/src/routes/ai-rpg.tsx is the pattern), then
 * `node scripts/gen-app-routes.mjs`.
 *
 * The facts follow docs/help/is-yumina-free.md,
 * docs/help/does-yumina-remember-my-story.md,
 * docs/help/how-do-i-play-with-friends.md,
 * docs/help/what-are-the-content-rules.md,
 * docs/help/do-i-need-to-know-how-to-code-to-make-a-world.md,
 * docs/help/which-ai-models-can-i-use.md, docs/guide/choosing-an-ai-model.md,
 * docs/guide/playing-a-world.md, docs/creator/variables.md,
 * docs/vision/index.md and, for AI players, the blog post
 * src/blog-content/multiplayer-ai-games.md. Change a fact there
 * first, then here.
 */
import { GENRE_PAGES, TAG_PAGE_PREFIX, type GenrePage } from "@yumina/shared";
import { listBlogPosts } from "./blog.js";
import { PUBLIC_ORIGIN } from "./env.js";
import { breadcrumbHtml, breadcrumbLd, esc, faqHtml, faqLd, worldHref, worldListHtml, type Faq, type ListedWorld } from "./public-page-parts.js";

/** A genre page: the copy the app shares (GenrePage) plus what only the HTML shows. */
export interface LandingPage extends GenrePage {
  /** The heading over the list of worlds. */
  listHeading: string;
  /** Vocabulary tags (canonical values, packages/shared/src/constants/tags.ts). A world carrying any of them is listed. */
  tags: string[];
  steps: string[];
  faq: Faq[];
  /** Slugs of posts in src/blog-content. One that does not exist is skipped. */
  blog: string[];
}

export interface LandingLink {
  path: string;
  label: string;
}

/** The worlds a page lists and the tag pages it links to (public-pages.ts LandingData). */
export interface LandingContent {
  worlds: ListedWorld[];
  tags: Array<{ slug: string; label: string }>;
}

// ── answers several pages share, each from the help page it names ────────────

// docs/help/is-yumina-free.md, docs/guide/choosing-an-ai-model.md
const FREE =
  "Yes. Every account has a free AI model with no message limit. With your own key from a provider such as OpenRouter or OpenAI you pay them directly, and Yumina adds nothing.";
// docs/help/does-yumina-remember-my-story.md, docs/guide/choosing-an-ai-model.md
const MEMORY: Faq = {
  q: "Does the AI remember my story?",
  a: "Yes. The free plan keeps about 64,000 tokens of memory, roughly a 200-page novel of your story, and older scenes are folded into a recap. With your own key there is no cap beyond what the model can hold.",
};
// docs/help/how-do-i-play-with-friends.md
const FRIENDS: Faq = {
  q: "Can I play with friends?",
  a: "Some worlds are live games built for several players, and they show a Live badge. Open one and choose Invite friends inside the game. Your friends get a notification and join you.",
};
// docs/help/which-ai-models-can-i-use.md
const MODELS: Faq = {
  q: "Which AI models can I use?",
  a: "For the story, every model on OpenRouter, from Claude and Gemini to DeepSeek, Grok and GLM, plus the free model. You can also use your own key, or a model running on your own computer.",
};
// docs/help/can-i-play-on-my-phone.md
const DOWNLOAD: Faq = {
  q: "Do I need to download anything?",
  a: "No. Yumina runs in the browser on a computer or a phone.",
};
// docs/help/do-i-need-to-know-how-to-code-to-make-a-world.md
const NO_CODE =
  "Yes. Most creators build on the canvas, and status panels, inventories and maps come from templates with no code. A playable world needs three things: a character, an opening and a name.";
// docs/creator/variables.md
const NUMBERS =
  "The game engine holds the numbers, not the model that writes the story. The creator writes in plain words when each one changes. The engine applies the change and keeps the number inside its range, so health never reads -30.";

// docs/guide/playing-a-world.md
const BRANCH =
  "Yes. The arrows under a reply make another version of it. Branch from here on any message starts a new save from that point, with everything before it kept.";
// docs/vision/index.md (Privacy & Security)
const PRIVATE: Faq = {
  q: "Is my chat private?",
  a: "Private chat is never used for advertising, data sales or model training.",
};

/** The page's shared copy, by its address. */
function genre(slug: string): GenrePage {
  const page = GENRE_PAGES.find((p) => p.slug === slug);
  if (!page) throw new Error(`No genre page "${slug}" in @yumina/shared`);
  return page;
}

export const LANDING_PAGES: readonly LandingPage[] = [
  {
    ...genre("ai-rpg"),
    listHeading: "Most played AI RPG worlds",
    tags: ["RPG", "DND", "5E", "战斗", "Dungeon", "Roguelite", "Dice", "生存", "Strategy"],
    steps: [
      "Pick a world from the list and open it. There is nothing to install.",
      "Type what your character does in plain words, such as \"I search the cellar\" or \"I draw my sword\".",
      "The AI describes what happens. The engine changes your stats by the rules the creator wrote.",
      "Leave when you like. Your story and your stats are saved to your account.",
    ],
    faq: [
      { q: "What is an AI RPG?", a: "A role-playing game where an AI plays the game master. It describes the world, speaks for the characters and answers anything you type, so you are not picking from a menu of choices." },
      { q: "Is it free to play an AI RPG on Yumina?", a: FREE },
      { q: "How does an AI RPG keep track of health and inventory?", a: NUMBERS },
      MEMORY,
      FRIENDS,
      { q: "Can I make my own AI RPG without coding?", a: NO_CODE },
      DOWNLOAD,
    ],
    blog: ["ai-rpg-with-stats", "ai-dungeon-master", "multiplayer-ai-games"],
  },
  {
    ...genre("ai-roleplay"),
    listHeading: "Most played AI roleplay worlds",
    tags: ["Roleplay", "角色卡", "canon character RP", "Original Character", "角色聊天", "Companion"],
    steps: [
      "Pick a character or a world from the list and open it.",
      "Read the opening scene, then write what you say or do.",
      "The character answers. The arrows under a reply make another version of it.",
      "Change the AI model from the chat box at any time.",
    ],
    faq: [
      { q: "What is AI roleplay?", a: "A story you write together with an AI character. A creator writes who the character is and how it speaks, and the AI plays that character while you play yourself or a character of your own." },
      { q: "Is AI roleplay free?", a: FREE },
      MEMORY,
      MODELS,
      {
        // docs/help/what-are-the-content-rules.md, docs/vision/index.md (Privacy & Security)
        q: "Is AI roleplay safe?",
        a: "On Yumina every world has an age rating, and you only see worlds made for everyone until you turn adult worlds on in your settings. Every world has a report button, and a person reads each report. Private chat is never used for advertising, data sales or model training.",
      },
      { q: "Can I make my own AI character?", a: NO_CODE },
      DOWNLOAD,
    ],
    blog: ["best-ai-roleplay-apps", "can-ai-remember-a-long-roleplay", "how-to-make-an-ai-character"],
  },
  {
    ...genre("ai-text-adventure"),
    listHeading: "Most played AI text adventures",
    tags: ["Adventure", "Scenario", "Storybook", "Visual Novel", "小说", "推理", "Detective", "isekai", "逃生"],
    steps: [
      "Pick an adventure from the list and read its opening.",
      "Type what you do, such as \"open the door\" or \"ask the innkeeper about the map\".",
      "The AI tells you what happens next. The places, people and rules the creator wrote stay in force the whole way through.",
      "Leave when you like. The story is saved, and Branch from here on any message starts a second save from that point.",
    ],
    faq: [
      { q: "What is an AI text adventure?", a: "A text game where an AI writes the story in answer to what you type. Older text adventures understood a fixed list of commands. An AI text adventure takes any sentence." },
      { q: "Is there a free AI text adventure?", a: FREE },
      MEMORY,
      { q: "Can I make my own AI text adventure without coding?", a: NO_CODE },
      MODELS,
      DOWNLOAD,
    ],
    blog: ["how-to-make-an-ai-text-adventure", "ai-dungeon-alternatives", "can-ai-remember-a-long-roleplay"],
  },
  {
    ...genre("ai-games"),
    listHeading: "Most played AI games",
    tags: ["游戏", "模拟器", "RPG", "Strategy", "Sandbox", "Roguelite", "TCG", "arcade", "Life Sim", "联机"],
    steps: [
      "Pick a game from the list and open it. There is nothing to install.",
      "Play by typing, or with the game's own buttons and panels where the creator built them.",
      "The AI answers each move, and the engine updates the numbers by the creator's rules.",
      "For a game with other people, pick one with a Live badge and choose Invite friends inside it.",
    ],
    faq: [
      { q: "What is an AI game?", a: "Here it means a game the AI runs during play: it speaks for the characters and decides what happens after each move. A game whose code was written with AI help is a different thing." },
      { q: "Are AI games free?", a: FREE },
      FRIENDS,
      { q: "Can I make my own AI game without coding?", a: NO_CODE },
      { q: "How do the games keep score?", a: NUMBERS },
      MODELS,
      {
        // docs/vision/index.md (Open Source)
        q: "Is Yumina open source?",
        a: "Yes, from the game engine to the frontend. You can run it on your own computer with your own API key, without logging in.",
      },
    ],
    blog: ["multiplayer-ai-games", "ai-game-design-human-nature", "ai-rpg-with-stats"],
  },
  {
    ...genre("ai-chat"),
    listHeading: "Most played AI characters",
    tags: ["角色卡", "角色聊天", "Companion", "messenger", "ai chat"],
    steps: [
      "Pick a character from the list and open it.",
      "Read its first message, then write yours.",
      "The character answers. The arrows under a reply make another version of it.",
      "Change the AI model from the chat box at any time.",
    ],
    faq: [
      { q: "What is AI chat with characters?", a: "A conversation with a character instead of a general assistant. A creator writes who the character is and how it speaks, and the AI answers as that character." },
      { q: "Is AI chat free?", a: FREE },
      { q: "Is there a message limit?", a: "No. The free AI model has no message limit." },
      MEMORY,
      MODELS,
      PRIVATE,
      { q: "Can I make my own AI character?", a: NO_CODE },
    ],
    blog: ["character-ai-alternatives", "ai-roleplay-no-message-limit", "how-to-make-an-ai-character"],
  },
  {
    ...genre("multiplayer-ai-games"),
    listHeading: "Most played multiplayer AI games",
    tags: ["联机", "pvp"],
    steps: [
      "Pick a game from the list. Each one shows a Live badge with how many people are in it right now.",
      "Open it and choose Invite friends inside the game.",
      "Your friends get a notification and come straight into your game.",
      "In Avalon, the first person at the table is the host and picks which seats are AI players.",
    ],
    faq: [
      { q: "What is a multiplayer AI game?", a: "A game several people play at once, with an AI in it. The AI can run the game, or sit in a seat as one of the players under the same rules as the people." },
      { q: "Are multiplayer AI games free?", a: FREE },
      { q: "How do I invite my friends?", a: "Open a world with a Live badge and choose Invite friends inside the game. Your friends get a notification and come straight into your game." },
      { q: "Can an AI play as one of the players?", a: "Yes, in games built for it. In Avalon the host picks which seats are AI players, and each one gets a secret role and follows the same rules as the people." },
      { q: "Can each AI player use a different model?", a: "Yes. A different model can sit in each seat, so one table can have four models and three people." },
      { q: "Can anyone else see my secret role?", a: "No. In Avalon the server sends your role to your seat and to no one else." },
      DOWNLOAD,
    ],
    blog: ["multiplayer-ai-games", "ai-game-design-human-nature", "ai-crazy-dave-plants-vs-zombies"],
  },
  {
    ...genre("ai-visual-novel"),
    listHeading: "Most played AI visual novels",
    tags: ["Visual Novel", "Storybook"],
    steps: [
      "Pick a visual novel from the list and read its opening scene.",
      "Type what you say or do. No list of choices limits you.",
      "The AI writes the next scene in the characters' voices.",
      "For another route, use Branch from here on any message. It starts a new save from that point.",
    ],
    faq: [
      { q: "What is an AI visual novel?", a: "A visual novel where an AI writes the story as you play. A classic visual novel has a fixed script with a few branches. Here you type anything and the characters answer." },
      { q: "Is there a free AI visual novel?", a: FREE },
      MEMORY,
      { q: "Can I go back and try another route?", a: BRANCH },
      { q: "Can I make my own AI visual novel without coding?", a: NO_CODE },
      DOWNLOAD,
    ],
    blog: ["what-is-ai-roleplay", "how-to-make-an-ai-character", "can-ai-remember-a-long-roleplay"],
  },
  {
    ...genre("ai-story-games"),
    listHeading: "Most played AI story games",
    tags: ["Scenario", "小说", "Drama", "Storybook", "推理", "悬疑"],
    steps: [
      "Pick a story from the list and read its opening.",
      "Write what you do or say in plain words.",
      "The AI writes what happens next. The arrows under a reply make another version of it.",
      "Leave when you like. The story is saved to your account.",
    ],
    faq: [
      { q: "What is an AI story game?", a: "A story where you play the main character and an AI writes the rest. Nothing is scripted ahead, so the story follows what you write." },
      { q: "Are AI story games free?", a: FREE },
      MEMORY,
      { q: "Can I change how the story goes?", a: BRANCH },
      { q: "Can I make my own AI story game without coding?", a: NO_CODE },
      MODELS,
      DOWNLOAD,
    ],
    blog: ["best-ai-story-games", "roleplay-ideas", "can-ai-remember-a-long-roleplay"],
  },
  {
    ...genre("ai-dungeon-master"),
    listHeading: "Most played games with an AI dungeon master",
    tags: ["DND", "5E", "Dice", "Dungeon"],
    steps: [
      "Pick a game from the list and open it. There is nothing to install.",
      "Say what your character does, such as \"I check the door for traps\".",
      "The AI describes the result. The engine changes hit points and gold by the rules the creator wrote.",
      "Leave when you like. Your story and your stats are saved to your account.",
    ],
    faq: [
      { q: "What is an AI dungeon master?", a: "An AI that does the game master's job in a tabletop-style game. It narrates, plays every non-player character and answers any action you type." },
      { q: "Is the AI dungeon master free?", a: FREE },
      { q: "Does it follow D&D 5e rules?", a: "Yumina has no ruleset built in. Each world uses the stats, dice and rules its creator set." },
      { q: "How does an AI dungeon master keep track of hit points?", a: NUMBERS },
      MEMORY,
      FRIENDS,
      { q: "Can I make my own campaign without coding?", a: NO_CODE },
    ],
    blog: ["ai-dungeon-master", "ai-rpg-with-stats", "ai-dungeon-alternatives"],
  },
];

const BY_PATH = new Map(LANDING_PAGES.map((page) => [`/${page.slug}`, page]));

export const landingPath = (page: Pick<LandingPage, "slug">) => `/${page.slug}`;

/** The page at this address (lowercase, no trailing slash), if it is one of the genre pages. */
export function findLandingPage(path: string): LandingPage | undefined {
  return BY_PATH.get(path);
}

/** Every genre page's address. */
export function landingPaths(): string[] {
  return LANDING_PAGES.map(landingPath);
}

/** The genre pages as links, for the home page and the blog footer. */
export function landingLinks(except?: LandingPage): LandingLink[] {
  return LANDING_PAGES.filter((page) => page !== except).map((page) => ({ path: landingPath(page), label: page.phrase }));
}

/** The page's blog posts that exist, with the short form of each title. */
function blogLinks(page: LandingPage): LandingLink[] {
  const bySlug = new Map(listBlogPosts().map((post) => [post.slug, post]));
  return page.blog.flatMap((slug) => {
    const post = bySlug.get(slug);
    return post ? [{ path: `/blog/${post.slug}`, label: post.title.split(/[:(]/)[0]!.trim() }] : [];
  });
}

const linkItems = (links: LandingLink[]) => links.map((l) => `<li><a href="${esc(l.path)}">${esc(l.label)}</a></li>`).join("");

/** The #root fragment for a genre page. */
export function renderLanding(page: LandingPage, content: LandingContent): string {
  const trail = [{ name: "Yumina", path: "/" }, { name: page.phrase, path: landingPath(page) }];
  const list = content.worlds.length
    ? `<section class="pre-more"><h2 class="pre-h2">${esc(page.listHeading)}</h2>${worldListHtml(content.worlds)}</section>`
    : "";
  const tags = content.tags.length
    ? `<section class="pre-more"><h2 class="pre-h2">Browse by tag</h2><ul class="pre-tags">${linkItems(content.tags.map((t) => ({ path: `${TAG_PAGE_PREFIX}${t.slug}`, label: t.label })))}</ul></section>`
    : "";
  const posts = blogLinks(page);
  const reading = posts.length ? `<section class="pre-more"><h2 class="pre-h2">From the blog</h2><ul class="pre-list">${linkItems(posts)}</ul></section>` : "";
  return (
    `<main class="pre pre-landing">${breadcrumbHtml(trail)}<h1 class="pre-h1">${esc(page.h1)}</h1>` +
    `<div class="pre-text">${page.intro.map((p) => `<p>${esc(p)}</p>`).join("")}</div>` +
    list +
    `<section class="pre-more"><h2 class="pre-h2">How it works</h2><ol class="pre-list">${page.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol></section>` +
    `<section class="pre-more"><h2 class="pre-h2">Questions</h2>${faqHtml(page.faq)}</section>` +
    `<section class="pre-more"><h2 class="pre-h2">More to play</h2><ul class="pre-tags">${linkItems(landingLinks(page))}</ul></section>` +
    tags +
    reading +
    `</main>`
  );
}

/** Title, description and structured data for a genre page. */
export function landingMeta(page: LandingPage, content: LandingContent) {
  const url = `${PUBLIC_ORIGIN}${landingPath(page)}`;
  return {
    title: page.title,
    description: page.description,
    url,
    jsonLd: {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "CollectionPage",
          "@id": url,
          url,
          name: page.title,
          description: page.description,
          isPartOf: { "@type": "WebSite", name: "Yumina", url: PUBLIC_ORIGIN },
          about: { "@type": "DefinedTerm", name: page.phrase },
          ...(content.worlds.length
            ? {
                mainEntity: {
                  "@type": "ItemList",
                  numberOfItems: content.worlds.length,
                  itemListElement: content.worlds.map((w, i) => ({
                    "@type": "ListItem",
                    position: i + 1,
                    name: w.name,
                    url: `${PUBLIC_ORIGIN}${worldHref(w)}`,
                  })),
                },
              }
            : {}),
        },
        breadcrumbLd([{ name: "Yumina", path: "/" }, { name: page.phrase, path: landingPath(page) }]),
        faqLd(page.faq),
      ],
    },
  };
}
