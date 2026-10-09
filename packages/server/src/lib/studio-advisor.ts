/**
 * The assistant's "talk it through" mode: before anything is built, a creator
 * works out what game they want to make, and the assistant answers like an
 * editor who knows exactly what Yumina can do.
 *
 * The build mode carries ~40k tokens of how-to manuals and tool schemas every
 * turn; none of it helps someone deciding what to make. This mode carries
 * only what that conversation needs:
 *   - what Yumina can and cannot do, in the player's terms (the ready-made
 *     pages and packs are read from the engine, so the list cannot go stale);
 *   - an outline of the card as it stands (names, not contents);
 *   - the creative brief, if one was saved.
 * It reads details with read tools when it needs them, and it changes
 * nothing on the card: the one thing it writes is the brief, which the build
 * mode then reads instead of the whole conversation.
 */
import {
  APP_PACK_IDS, UI_PAGE_TEMPLATES, appPackSummaries, mechanicPackSummaries,
  type WorldDefinition,
} from "@yumina/engine";
import type { ToolDefinition } from "./llm/types.js";
import { getObjectBuffer, putObject } from "./s3.js";
import type { SourceMeta } from "./studio-sources.js";
import { createHash } from "node:crypto";
import { isStudioBuildProposal, type StudioBuildProposal } from "@yumina/shared";

export const BRIEF_MAX_CHARS = 6_000;

/** Display names of the ready-made pages; a test keeps this in step with the engine. */
export const PAGE_TEMPLATE_NAMES: Record<string, { zh: string; en: string }> = {
  "title-screen": { zh: "片头", en: "title screen" },
  "pick-opening": { zh: "选开局", en: "pick an opening" },
  "enter-name": { zh: "填名字", en: "enter your name" },
  profile: { zh: "建档", en: "player profile" },
  "pick-origin": { zh: "选出身", en: "pick an origin" },
  difficulty: { zh: "选难度", en: "difficulty" },
  "random-draw": { zh: "抽开局", en: "random draw" },
  points: { zh: "分配属性点", en: "point buy" },
  confirm: { zh: "开局确认页", en: "confirm" },
  status: { zh: "状态", en: "status" },
  bag: { zh: "背包", en: "bag" },
  map: { zh: "地图前往", en: "map" },
  phone: { zh: "手机私信", en: "phone" },
  relations: { zh: "关系档案", en: "relations" },
  schedule: { zh: "日程行动", en: "schedule" },
  dice: { zh: "掷骰检定", en: "dice check" },
  clues: { zh: "线索与指认", en: "clues and accusation" },
  collection: { zh: "收集图鉴", en: "collection" },
};

const CAN = `## What a Yumina card can do (say it in the player's terms)
Story and setting
- Character profiles, world lore, plot notes: sent to the AI always, by keyword, by condition, or switched on/off as a group (e.g. a place's lore only while the player is there).
- Several openings the player picks from, each with its own starting numbers.
- Background AI helpers: e.g. one that writes narration, one that sums up the situation every few turns, each on its own model.
- Fan-works: a whole novel can be attached; the assistant reads it into a canon reference.
Numbers and rules (what makes it a game)
- Tracked values: numbers, text, on/off, lists (inventory, relationship table). The AI updates them by the rules the author writes, or "precise tracking" updates them more reliably.
- Rules: when the player says something / every N turns / a number goes above or below a line / a button is pressed → change values, switch lore on/off, quietly tell the AI something, play music, show a toast. Rules chain up to 5 steps per turn.
- Randomness: dice, draws, chance — computed by the engine, the AI only narrates the result.
- Built-in combat: attack / flee resolved by the engine from hp/attack/defense values.
Interface
- No-code pages: openings and play-time pages (listed below); buttons set values, send messages, switch pages, switch the opening, draw random results.
- AI text can be restyled: a set pattern becomes tappable choices, a card, a hidden secret the player taps to reveal, a speaker label with avatar.
- A fully custom frontend (code) can replace the whole chat screen: animation, minigames, real-time controls, 3D.
Pictures and sound
- Cover, a gallery of up to 20 images, character portraits, scene pictures that appear when the story reaches a moment, switchable chat backgrounds.
- Image generation inside the editor (the assistant can propose a batch; nothing is charged until the creator confirms).
- Background music, sound effects, ambience: by rules, picked automatically to fit the scene, or switched by the AI. Instrumental music can be generated in the editor.
- Each character can have their own reading voice; players can hold to talk.
Publishing
- Official tags, age rating, audience (male/female/all), language versions grouped together, versions and update notes, tips/earnings, players sharing playthroughs; the author can forbid players' own API keys so the setting can't be extracted.`;

const CANNOT = `## What it cannot do — always offer the alternative
- The AI never speaks first and nothing happens on a clock ("after 5 minutes…"); everything follows a player message or button. → Use "every N turns" events; count time in turns or in-story days.
- A card cannot reach the internet or the author's own server. → Put the material into the card.
- Authors cannot build their own real-time multiplayer; only a few first-party games have it. → Have the AI play the other characters.
- The author cannot choose the player's model, and some models are bad at updating values. → Put important values under rules or precise tracking instead of trusting the AI.
- There is no built-in "ending" switch. → An ending is a rule that checks values (e.g. day 90 and gold ≥ 3000) plus a note telling the AI to write the epilogue.
- Cards are not translated automatically. → The assistant can draft a translation for the author to check.
- Per-turn illustrations are switched on by each player, anime style only. → Key moments get author-made scene pictures.
- No video; no generated sound effects; generated music is instrumental only. → Upload sound effects.
- Long-chat memory is a player-side option the author can't rely on. → Keep key facts in tracked values the AI sees every turn.
- Custom frontend limits: no browser dialogs, no file downloads, no npm packages (libraries such as three.js must be bundled into the card); text and code of a card up to 5MB, images and audio go to the asset library.
- Changing the characters, interface, rating or cover of a published card goes through review again; players keep the old version until it passes.
- In-card achievements are not supported (use the "achievements" pack, which is a tracked list).
- Not available: popularity data. Never claim what will be popular.`;

function readyMade(language: "zh" | "en"): string {
  const opening = UI_PAGE_TEMPLATES.filter((t) => t.place !== "play").map((t) => PAGE_TEMPLATE_NAMES[t.id]?.[language] ?? t.id);
  const play = UI_PAGE_TEMPLATES.filter((t) => t.place === "play").map((t) => PAGE_TEMPLATE_NAMES[t.id]?.[language] ?? t.id);
  const mechanics = mechanicPackSummaries(language).map((p) => `${p.name}: ${p.description}`);
  const apps = appPackSummaries(language).filter((p) => (APP_PACK_IDS as readonly string[]).includes(p.id)).map((p) => `${p.name}: ${p.description}`);
  return [
    "## Ready-made pieces (call them by these names)",
    `- Opening pages: ${opening.join(", ")}`,
    `- Play-time pages: ${play.join(", ")}`,
    `- Mechanic packs: ${mechanics.join("; ")}`,
    `- App packs: ${apps.join("; ")}`,
  ].join("\n");
}

/** What the advisor knows about the platform. */
export function capabilitySheet(language: "zh" | "en"): string {
  return `${CAN}\n\n${readyMade(language)}\n\n${CANNOT}`;
}

const ADVISOR_PROMPT = `You are the creative advisor in Yumina Studio (an AI interactive-fiction platform). The creator is working out what game they want to make. You talk it through with them; you do not build — nothing you do changes the card. Reply in the language of the creator's latest message.

How to help
- Start in discussion. Once the player role, core loop and first-version scope are concrete and there is no blocking decision, proactively call save_brief to offer building; do not wait for the creator to discover the mode menu. If they explicitly ask to start, prepare the brief and offer it immediately. Never decide readiness from the number of turns.
- save_brief opens a confirmation sheet with your summary and 1–5 short, concrete build steps in the creator's language. Saving the brief does NOT authorize building. The creator chooses Start building or Keep brainstorming; never claim building has started. If they keep brainstorming, continue without repeating the same offer. Offer again only after a material change or when they ask.
- Write the brief under these headings: 一句话 / 玩家是谁 / 每一轮做什么 / 会变的东西 / 地方和人 / 怎么结束 / 界面 / 做不了的和替代做法 / 还没想好的. Keep it under one page. Include only decisions already discussed, distinguish optional future ideas, and update it when those decisions change.
- Be a seasoned editor, not a form: short and concrete. No compliments, no restating their idea back to them, no flourishes or dashes for effect — open with the first useful thing. Keep a reply under about 200 Chinese characters (120 English words) unless you are playing the concept or the creator asked for detail. Ask at most two questions at a time, each with 2–4 short options and the one you'd pick.
- Think in what the player experiences: who they play, what they do each turn, what changes and is worth watching, where they go and whom they meet, how it ends. Use the creator's words; avoid engine words (variable, behavior, entry, reaction) unless they use them.
- Ground every suggestion in what Yumina can do (below). When an idea can't be done as described, say so in one plain line and give the alternative. Name ready-made pages and packs when they fit ("用现成的「地图前往」页").
- When it helps, say how a piece would be made, in one line (e.g. "金币是一个数值，买卖时由规则加减，状态页上显示").
- Try the idea before it's built: when the creator wants to (or agrees when you offer), play it right here as a short text game — a scene, then 2–4 numbered options, and the tracked numbers in one line like 「金币 200 · 忠诚 50 · 第 1 天」 (current values only, no arithmetic). After 2–4 turns, step out and say plainly what worked and what didn't, and what you'd change.
- Answer from the card outline and what you know about Yumina. Reach for a tool only to check one specific thing — at most two or three reads in a reply; never survey the card.
- An attached book is the authority on its own story: before you state a character's name, an event or when something happens, search_source (or read its ·原著资料库 reference, if the outline lists one) and write names exactly as the book does. Name only characters you have confirmed in the book or its index; never fill canon from memory.
- Never promise popularity or cite market data; Yumina has none to give.`;

/** A compact outline of the card: names and counts, not contents. */
export function cardOutline(world: WorldDefinition, sources: SourceMeta[]): string {
  const lines: string[] = [];
  const name = (world as { name?: string }).name;
  lines.push(`Card: ${name || "(untitled)"}`);
  const description = (world as { description?: string }).description;
  if (description) lines.push(`Description: ${description.slice(0, 300)}`);
  const entries = world.entries ?? [];
  const greetings = entries.filter((e) => e.role === "greeting");
  if (greetings.length) {
    lines.push(`Openings (${greetings.length}):`);
    for (const g of greetings.slice(0, 8)) lines.push(`- ${g.name || "opening"}: ${(g.content ?? "").replace(/\s+/g, " ").slice(0, 140)}`);
  }
  const byRole = new Map<string, string[]>();
  for (const e of entries) if (e.role !== "greeting") byRole.set(e.role, [...(byRole.get(e.role) ?? []), e.name || e.id]);
  for (const [role, names] of byRole) lines.push(`${role} entries (${names.length}): ${names.slice(0, 40).join(", ")}${names.length > 40 ? " …" : ""}`);
  const vars = world.variables ?? [];
  if (vars.length) lines.push(`Tracked values (${vars.length}): ${vars.slice(0, 40).map((v) => `${v.name || v.id} (${v.type})`).join(", ")}`);
  const reactions = (world.reactions ?? []).length + (world.rules ?? []).length;
  if (reactions) lines.push(`Rules: ${reactions}`);
  const pages = world.uiDoc?.pages ?? [];
  if (pages.length) lines.push(`Interface pages: ${pages.map((p) => p.name).join(", ")}`);
  else {
    // Every card gets a one-line root that just renders the platform chat.
    const files = (world.rootComponent as { files?: Record<string, string> } | undefined)?.files ?? {};
    if (Object.values(files).join("").length > 300) lines.push("Interface: custom frontend code");
  }
  const tracks = (world.audioTracks ?? []).length;
  if (tracks) lines.push(`Audio tracks: ${tracks}`);
  if (sources.length) lines.push(`Attached source texts: ${sources.map((s) => `「${s.name}」 (${s.chars} chars)`).join(", ")}`);
  if (lines.length === 1) lines.push("The card is empty — nothing has been made yet.");
  return lines.join("\n");
}

/** Which language the creator wrote in, named for the model. */
export function describeLanguage(text: string): string {
  if (/[぀-ヿ]/.test(text)) return "Japanese";
  if (/\p{Script=Han}/u.test(text)) return "Chinese";
  if (/[áéíóúñ¿¡]/i.test(text)) return "Spanish";
  return "English";
}

/**
 * The people and sections of a canon reference (lib/studio-source-digest.ts):
 * the names as the book writes them, in a few hundred characters, so the
 * advisor never has to recall a name from memory.
 */
export function referenceIndex(text: string, max = 1_500): string {
  const sections: string[] = [];
  const people: string[] = [];
  let inPeople = false;
  for (const line of text.split("\n")) {
    const h2 = line.match(/^## (.+)/);
    if (h2) {
      sections.push(h2[1]!.trim());
      inPeople = /^(人物|其他人物|People|Characters)/i.test(h2[1]!);
      continue;
    }
    const h3 = line.match(/^### (.+)/);
    if (h3 && inPeople) people.push(h3[1]!.trim());
  }
  const out = `People: ${[...new Set(people)].join("、")}\nSections: ${sections.filter((t) => !/^(人物|其他人物|段号)/.test(t)).join(" / ")}`;
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

export function advisorPrompt(args: {
  world: WorldDefinition; sources: SourceMeta[]; brief: string | null; language: string;
  references?: Array<{ name: string; index: string }>;
}) {
  const references = (args.references ?? []).map((r) => `\nIndex of 「${r.name}」 (names exactly as the book writes them):\n${r.index}`).join("");
  return {
    static: `${ADVISOR_PROMPT}\n\n${capabilitySheet(args.language === "Chinese" ? "zh" : "en")}`,
    world: `<card-outline>\n${cardOutline(args.world, args.sources)}${references}\n</card-outline>${args.brief ? `\n<creative-brief>\n${args.brief}\n</creative-brief>` : ""}`,
    dynamic: `The creator's latest message is in ${args.language}. Everything you write — answers, the brief, and the story when you play the idea — is in ${args.language}.`,
  };
}

/** For the build mode: the agreed brief, read instead of the whole conversation. */
export function briefBlock(brief: string | null): string {
  if (!brief) return "";
  return `\n<creative-brief>\nThe creator worked this out with the advisor. Build toward it; an explicit request in the chat wins over it.\n${brief}\n</creative-brief>`;
}

export const SAVE_BRIEF_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "save_brief",
    description: "Save (or replace) the card's one-page creative brief, in the creator's language, under the headings given in your instructions. The build mode reads it when it builds the card. Call it once the idea is clear enough to build, and again when a later decision changes it. Auto-executes.",
    parameters: {
      type: "object",
      properties: {
        brief: { type: "string", description: `The whole brief, Markdown, at most ${BRIEF_MAX_CHARS} characters.` },
        summary: { type: "string", maxLength: 200, description: "One sentence describing the first version the creator will confirm, in their language." },
        steps: { type: "array", minItems: 1, maxItems: 5, items: { type: "string", maxLength: 160 }, description: "Concrete scope shown in the confirmation sheet. Only agreed work, no speculative additions." },
      },
      required: ["brief", "summary", "steps"],
    },
  },
};

/** Read-only tools the advisor may use, plus save_brief. */
export const ADVISOR_READ_TOOLS = ["read_entities", "grep_world", "read_ui_doc", "search_source", "read_source"] as const;

export function advisorTools(tools: ToolDefinition[]): ToolDefinition[] {
  return [...tools.filter(t => (ADVISOR_READ_TOOLS as readonly string[]).includes(t.function.name)), SAVE_BRIEF_TOOL];
}

export function createBuildProposal(brief: unknown, summary: unknown, steps: unknown): StudioBuildProposal | null {
  if (typeof brief !== "string" || typeof summary !== "string" || !Array.isArray(steps)) return null;
  const text = brief.trim();
  const proposal = {
    revision: createHash("sha256").update(text).digest("hex"),
    brief: text, summary: summary.trim(), steps: steps.map(s => typeof s === "string" ? s.trim() : s),
  };
  return isStudioBuildProposal(proposal) ? proposal : null;
}

const briefKey = (userId: string, worldId: string) => `studio-briefs/${userId}/${worldId}.md`;

export async function loadBrief(userId: string, worldId: string): Promise<string | null> {
  try {
    const text = (await getObjectBuffer(briefKey(userId, worldId), { maxBytes: 64_000 })).buffer.toString("utf8").trim();
    return text || null;
  } catch {
    return null;
  }
}

export async function saveBrief(userId: string, worldId: string, brief: unknown): Promise<{ chars: number } | { error: string }> {
  if (typeof brief !== "string" || !brief.trim()) return { error: "brief must be non-empty text" };
  const text = brief.trim();
  if (text.length > BRIEF_MAX_CHARS) return { error: `The brief is ${text.length} characters; keep it under ${BRIEF_MAX_CHARS} (one page).` };
  await putObject(briefKey(userId, worldId), Buffer.from(text, "utf8"), "text/markdown; charset=utf-8");
  return { chars: text.length };
}

/** Rough token count of a prompt (CJK ≈ 1 token a character, other text ≈ 4 characters a token). */
export function approxPromptSize(parts: { static: string; world: string; dynamic: string }): number {
  const text = parts.static + parts.world + parts.dynamic;
  const cjk = (text.match(/\p{Script=Han}/gu) ?? []).length;
  return Math.round(cjk + (text.length - cjk) / 4);
}
