/**
 * The genre pages: yumina.io/ai-rpg, /ai-roleplay, /ai-text-adventure,
 * /ai-games, /ai-chat, /multiplayer-ai-games, /ai-visual-novel,
 * /ai-story-games and /ai-dungeon-master. Each address opens Discover for one
 * kind of play.
 *
 * This is the short copy the server and the app both show: the server writes
 * it into the HTML for search engines (server lib/landing-public.ts, which
 * adds the steps and the questions), and the app puts it in Discover's hero
 * (app lib/discover-genre.ts). The facts follow the help pages named in
 * landing-public.ts. Change a fact there first, then here.
 */
export interface GenrePage {
  /** The address without its slash: "ai-rpg" is yumina.io/ai-rpg. */
  slug: string;
  /** The search phrase, as it is written in a sentence, in links and in the hero. */
  phrase: string;
  /** The browser tab and search result title. */
  title: string;
  description: string;
  h1: string;
  /** Two or three sentences under the headline, one paragraph each. The first is the hero's line. */
  intro: string[];
  /** The tag Discover opens with (a canonical value from tags.ts), or null to list every world. */
  discoverTag: string | null;
  /**
   * The world whose art the hero shows and whose play button it offers: the
   * short id that ends the world's address (/@creator/name-<id>). Without it,
   * or when that world is gone, private or has no cover to show, the hero uses
   * the genre's most played world.
   */
  heroWorld?: string;
}

export const GENRE_PAGES: readonly GenrePage[] = [
  {
    slug: "ai-rpg",
    phrase: "AI RPG",
    title: "AI RPG Games - Play Free Online",
    description:
      "Play an AI RPG free in your browser. The AI is the game master, and the game engine keeps your health, money and inventory. Pick a world and start.",
    h1: "Play an AI RPG",
    intro: [
      "An AI RPG is a role-playing game with an AI as the game master. You type what your character does and the AI tells you what happens.",
      "On Yumina the game engine keeps your health, money and inventory, not the model that writes the story.",
      "Playing is free. Every account has a free AI model with no message limit.",
    ],
    discoverTag: "RPG",
    // Oncin: Universal Simulator.
    heroWorld: "712b2702",
  },
  {
    slug: "ai-roleplay",
    phrase: "AI roleplay",
    title: "AI Roleplay - Free Roleplay With AI Characters",
    description:
      "AI roleplay with characters written by creators. They answer in their own voice and remember what you said hundreds of messages later. Free to play.",
    h1: "AI roleplay",
    intro: [
      "AI roleplay is a story you play with a character that a person wrote and an AI voices. You write your side, and the character answers in its own voice.",
      "It remembers what you said hundreds of messages later.",
      "Playing is free. Every account has a free AI model with no message limit.",
    ],
    discoverTag: "Roleplay",
  },
  {
    slug: "ai-text-adventure",
    phrase: "AI text adventure",
    title: "AI Text Adventure Games - Play Free Online",
    description:
      "Play an AI text adventure free in your browser. Type what you do and the AI answers inside a world a creator wrote. No command list, no fixed choices.",
    h1: "AI text adventures",
    intro: [
      "An AI text adventure is a story game you play by typing what you do. There is no command list and no fixed set of choices.",
      "The AI answers any action, inside a world a creator wrote.",
      "Playing is free. Every account has a free AI model with no message limit.",
    ],
    discoverTag: "Adventure",
  },
  {
    slug: "ai-games",
    phrase: "AI games",
    title: "AI Games - Play Free in Your Browser",
    description:
      "AI games where the AI runs the game while you play: it speaks for the characters and follows the creator's rules. Free to play in your browser.",
    h1: "AI games",
    intro: [
      "The AI runs these games while you play. It speaks for every character, tells you what happens and follows the rules the creator wrote.",
      "The game engine keeps the numbers, such as health and money.",
      "Playing is free. Every account has a free AI model with no message limit.",
    ],
    discoverTag: null,
  },
  {
    slug: "ai-chat",
    phrase: "AI chat",
    title: "AI Chat - Talk to AI Characters Free",
    description:
      "AI chat with characters written by creators. Each one answers in its own voice and remembers what you said hundreds of messages later. Free to use.",
    h1: "AI chat with characters",
    intro: [
      "AI chat on Yumina is a conversation with a character a creator wrote. You send a message and it answers in its own voice.",
      "It remembers what you said hundreds of messages later.",
      "Chatting is free. Every account has a free AI model with no message limit.",
    ],
    discoverTag: "角色卡",
  },
  {
    slug: "multiplayer-ai-games",
    phrase: "Multiplayer AI games",
    title: "Multiplayer AI Games - Play Free With Friends",
    description:
      "Multiplayer AI games you play with friends in your browser. Invite them from inside the game. In some games AI players take seats too. Free to play.",
    h1: "Multiplayer AI games",
    intro: [
      "A multiplayer AI game is a live game for several players where an AI can take a seat too. You invite friends from inside the game.",
      "In Avalon the host picks which seats are AI players, and each one gets a secret role and follows the same rules as the people.",
      "Playing is free. Every account has a free AI model with no message limit.",
    ],
    discoverTag: "联机",
  },
  {
    slug: "ai-visual-novel",
    phrase: "AI visual novel",
    title: "AI Visual Novel Games - Play Free Online",
    description:
      "Play an AI visual novel free in your browser. Type your own lines instead of picking from a list, and the AI writes what the characters say back.",
    h1: "AI visual novels",
    intro: [
      "In an AI visual novel you type your own lines instead of picking from a list. The AI writes what the characters say back.",
      "A creator wrote the characters and the setting, and the AI keeps to them.",
      "Playing is free. Every account has a free AI model with no message limit.",
    ],
    discoverTag: "Visual Novel",
  },
  {
    slug: "ai-story-games",
    phrase: "AI story games",
    title: "AI Story Games - Play Free Online",
    description:
      "Play AI story games free in your browser. You write what you do and the AI writes what happens next, inside a world a creator wrote.",
    h1: "AI story games",
    intro: [
      "An AI story game is a story you play. You write what you do, and the AI writes what happens next.",
      "Each story runs inside a world a creator wrote, with its own people, places and rules.",
      "Playing is free. Every account has a free AI model with no message limit.",
    ],
    discoverTag: "Scenario",
  },
  {
    slug: "ai-dungeon-master",
    phrase: "AI dungeon master",
    title: "AI Dungeon Master - Play Tabletop RPGs Free Online",
    description:
      "Play a tabletop-style game with an AI dungeon master, free in your browser. The AI tells the story, and the game engine keeps hit points and gold.",
    h1: "Play with an AI dungeon master",
    intro: [
      "An AI dungeon master runs a tabletop-style game for you. It sets the scene, plays every other character and answers what you try.",
      "The game engine keeps hit points, gold and inventory, not the model that tells the story.",
      "Playing is free. Every account has a free AI model with no message limit.",
    ],
    discoverTag: "DND",
  },
];

/** The title of a tag page (/app/tag/<slug>), from the tag's English label. */
export function tagPageTitle(label: string): string {
  return `${label} AI Games & Roleplay`;
}
