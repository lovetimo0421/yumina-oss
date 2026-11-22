import type { Variable, WorldDefinition, YuminaBundle } from "@yumina/engine";

/**
 * Fitting an interface pack to a card without the assistant.
 *
 * Shared interfaces keep what they show (the people on a relationship board,
 * the contacts in a phone, the items in a bag) in one of their own json
 * variables, and the code only draws it. So the pack's sample people can be
 * swapped for the card's own characters, and its other samples emptied, by
 * rewriting those variables' starting values before the pack goes in. No
 * model call: the same pack on the same card always comes out the same.
 */

/** A character of the card, as a pack's list of people wants it. */
export interface CardCharacter {
  /** Stable key for map-shaped lists (`npcs.aqua`). */
  key: string;
  name: string;
  /** One or two sentences, for a bio line. */
  description: string;
  /** `@asset:` ref or URL, when the card gave the character a portrait. */
  portrait?: string;
}

/** A list of samples inside one of the pack's variables. */
export interface PackCollection {
  /** `variableId` or `variableId.field` (one level deep). */
  key: string;
  variableId: string;
  /** The field of the variable's value holding the list, when not the value itself. */
  field?: string;
  /** Shown to the author: the variable's name (and the field). */
  label: string;
  shape: "map" | "array" | "slots";
  /** Its items are people: it can take the card's characters. */
  people: boolean;
  /** Sample names, for the row's preview. */
  sampleNames: string[];
  count: number;
  /** Keys of a people list whose entries this list refers to (sample
   *  messages from `aria`): it is emptied when those people are replaced. */
  dependsOn?: string;
}

/** What happens to one list: the card's characters, the pack's samples, or nothing. */
export type CollectionChoice = "characters" | "keep" | "clear";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

const PEOPLE_NAME = /npc|char|contact|cast|friend|relation|people|person|member|crew|party|companion|heroine|lover|girl|boy|角色|人物|联系人|好友|成员|攻略|キャラ|人物|友達/i;
// A list named for things is not people even when its name also says whose
// they are (`cast_items`, `npc_bag`), unless its items carry a person's fields.
const THING_NAME = /item|inventory|bag|equip|gear|loot|shop|quest|skill|spell|place|location|map|物品|背包|道具|装备|任务|技能|地点|地图|アイテム|持ち物/i;
const PEOPLE_FIELD = /^(bio|affinity|affection|trust|favor|favour|love|relationship|signature|mood|avatar|portrait|好感|信赖|关系)$/i;
const DESC_FIELD = /^(bio|desc|description|intro|introduction|summary|profile|about|简介|介绍)$/i;
const IMAGE_FIELD = /^(avatar|portrait|image|img|photo|picture|icon|face|头像|立绘)$/i;
const NAME_FIELD = /^(name|displayName|title|名字|名前)$/;

function itemsOf(value: unknown): { shape: PackCollection["shape"]; items: Obj[] } | null {
  if (Array.isArray(value)) {
    if (value.length === 0 || !value.every((x) => isObj(x) && Object.keys(x).length > 0)) return null;
    return { shape: "array", items: value as Obj[] };
  }
  if (isObj(value)) {
    const vals = Object.values(value);
    if (vals.length === 0) return null;
    if (vals.every((x) => isObj(x) && Object.keys(x).length > 0)) return { shape: "map", items: vals as Obj[] };
    // Equipment-style slots: some filled, some empty.
    if (vals.every((v) => v === null || isObj(v)) && vals.some((x) => isObj(x) && Object.keys(x).length > 0)) {
      return { shape: "slots", items: vals.filter(isObj) as Obj[] };
    }
  }
  return null;
}

const nameOf = (item: Obj): string | undefined => {
  for (const [k, v] of Object.entries(item)) if (NAME_FIELD.test(k) && typeof v === "string" && v.trim()) return v.trim();
  return undefined;
};

/** Every list of samples the pack's variables start with. */
export function findPackCollections(bundle: Pick<YuminaBundle, "variables">): PackCollection[] {
  const found: PackCollection[] = [];
  for (const v of bundle.variables) {
    if (v.type !== "json") continue;
    const candidates: Array<{ field?: string; value: unknown }> = [{ value: v.defaultValue }];
    if (isObj(v.defaultValue) && !itemsOf(v.defaultValue)) {
      for (const [field, value] of Object.entries(v.defaultValue)) candidates.push({ field, value });
    }
    for (const { field, value } of candidates) {
      const got = itemsOf(value);
      if (!got) continue;
      const names = got.items.map(nameOf).filter((n): n is string => !!n);
      const named = names.length === got.items.length;
      const fields = new Set(got.items.flatMap((i) => Object.keys(i)));
      const label = `${v.id} ${v.name} ${field ?? ""}`;
      const people = got.shape !== "slots" && named
        && ([...fields].some((f) => PEOPLE_FIELD.test(f)) || (PEOPLE_NAME.test(label) && !THING_NAME.test(label)));
      found.push({
        key: field ? `${v.id}.${field}` : v.id,
        variableId: v.id,
        ...(field ? { field } : {}),
        label: field ? `${v.name} · ${field}` : v.name,
        shape: got.shape,
        people,
        sampleNames: names.slice(0, 4),
        count: got.items.length,
      });
    }
  }
  // A list whose items point at a people list's keys (`npcId: "aria"`) is
  // that list's sample history: it goes when those people go.
  for (const c of found) {
    if (c.people) continue;
    const owner = found.find((p) => p.people && p.shape === "map" && refersTo(collectionValue(bundle, c), collectionValue(bundle, p)));
    if (owner) c.dependsOn = owner.key;
  }
  return found;
}

/** Whether installing the pack can put the card's own characters in it:
 *  shown on the market so people know before they pick one. */
export function packTakesCharacters(content: unknown): boolean {
  const variables = (content as { variables?: unknown } | null | undefined)?.variables;
  if (!Array.isArray(variables)) return false;
  return findPackCollections({ variables: variables as YuminaBundle["variables"] }).some((c) => c.people);
}

function collectionValue(bundle: Pick<YuminaBundle, "variables">, c: PackCollection): unknown {
  const v = bundle.variables.find((x) => x.id === c.variableId);
  if (!v) return undefined;
  return c.field && isObj(v.defaultValue) ? v.defaultValue[c.field] : v.defaultValue;
}

function refersTo(list: unknown, people: unknown): boolean {
  if (!isObj(people)) return false;
  const keys = new Set(Object.keys(people));
  let hit = false;
  const walk = (x: unknown) => {
    if (hit) return;
    if (typeof x === "string") { if (keys.has(x)) hit = true; return; }
    if (Array.isArray(x)) x.forEach(walk);
    else if (isObj(x)) Object.values(x).forEach(walk);
  };
  walk(list);
  return hit;
}

// ── The card's characters ──────────────────────────────────────────

const PLACEHOLDER = /\{\{\s*(user|char)\s*\}\}/i;
/** Tags an author puts on the entries that are people. */
const PERSON_TAG = /^(角色|主角|配角|人物|女主|男主|攻略对象|角色卡|character|characters|char|npc|npcs|protagonist|heroine|キャラ|キャラクター|登場人物|人物|personaje|personajes)$/i;
/** Names and tags of entries that are about the story, not a person in it
 *  (many imported cards file everything under "character"). */
const NOT_A_PERSON = /世界|设定|設定|文风|文風|风格|輸出|输出|指引|指南|示例|范例|格式|规则|規則|提醒|控制|系统|系統|world|lore|setting|style|format|example|guide|rule|prompt|system|instruction|output/i;
const PREFERRED_LABEL = /^(身份|简介|簡介|介绍|介紹|人设|概要|identity|role|bio|summary|description|overview|personality|性格|プロフィール|紹介)$/i;

const cleanLine = (l: string) => l.replace(/^[>\s]+/, "").replace(/[*_`]/g, "").trim();
const isHeading = (l: string) => /^\s*#/.test(l);
const isListItem = (l: string) => /^\s*([-*+•]|\d+[.)])\s/.test(l);
/** "**Height**: 172 cm" / "外貌：…": a short label, then a value. */
const LABELLED = /^([^:：，,。.!?！？]{1,12})[:：]\s*(.*)$/;

function firstSentence(line: string): string {
  const end = /[。！？!?]|\.(\s|$)/.exec(line);
  if (end && end.index + 1 <= 120) return line.slice(0, end.index + 1).trim();
  return line.length > 100 ? `${line.slice(0, 100).trim()}…` : line;
}

/** A short bio from a character entry: the first sentence of its prose, or
 *  of a "Personality:"-like line, or else the first line that says
 *  anything. Headings, stat lines, lists and lines about the player are
 *  passed over. */
export function shortDescription(content: string, name: string): string {
  const raw = content.replace(/\r/g, "").split("\n").filter((l) => l.trim());
  const usable = raw.filter((l) => !isHeading(l) && !PLACEHOLDER.test(l)).map((l) => ({ list: isListItem(l), text: cleanLine(l.replace(/^\s*([-*+•]|\d+[.)])\s/, "")) }));
  // 1. Prose: a sentence of its own, not "Label: value".
  for (const { list, text } of usable) {
    if (list || LABELLED.test(text) || text.length < 12 || text === name) continue;
    return firstSentence(text);
  }
  // 2. A labelled line that describes the person.
  for (const { text } of usable) {
    const m = LABELLED.exec(text);
    if (m && PREFERRED_LABEL.test(m[1]!.trim()) && m[2]!.trim().length >= 6) return firstSentence(m[2]!.trim());
  }
  // 3. Anything with words in it, but never just the name.
  for (const { text } of usable) {
    const m = LABELLED.exec(text);
    if (m && /^\[?(name|名字|姓名|名前|nombre)\]?$/i.test(m[1]!.trim())) continue;
    const line = (m ? m[2]! : text).trim();
    if (line.length < 6 || line === name || /^\[.*\]$/.test(line)) continue;
    return firstSentence(line);
  }
  return "";
}

/** "蒙奇·D·路飞 — 草帽船长" → "蒙奇·D·路飞"; "Aqua（星野愛久愛海）" → "Aqua". */
export function displayName(entryName: string): string {
  const name = entryName.trim();
  const cut = name.split(/\s+[—–-]\s+|[（(【[]/)[0]!.trim();
  return cut.length > 0 ? cut : name;
}

/** The card's own characters: enabled character entries the card wrote
 *  (not ones a pack brought), in the order the card keeps them. When the
 *  author tagged their people, only those; otherwise the ones whose name and
 *  tags don't say they are setting, style or instructions. */
export function cardCharacters(world: Pick<WorldDefinition, "entries">): CardCharacter[] {
  const pool = world.entries.filter((e) =>
    e.role === "character" && e.enabled !== false && !e.bundleInstallId && e.name?.trim() && !PLACEHOLDER.test(e.name) && e.section !== "post-history");
  const tagged = pool.filter((e) => (e.tags ?? []).some((t) => PERSON_TAG.test(t.trim())));
  const people = tagged.length > 0
    ? tagged
    : pool.filter((e) => !NOT_A_PERSON.test(e.name) && !(e.tags ?? []).some((t) => NOT_A_PERSON.test(t)));
  const taken = new Set<string>();
  const out: CardCharacter[] = [];
  for (const e of [...people].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))) {
    const name = displayName(e.name);
    if (out.some((c) => c.name === name)) continue;
    out.push({
      key: uniqueKey(name, out.length, taken),
      name,
      description: shortDescription(e.content ?? "", name),
      ...(e.portrait ? { portrait: e.portrait } : {}),
    });
  }
  return out;
}

function uniqueKey(name: string, index: number, taken: Set<string>): string {
  const ascii = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const base = ascii.length >= 2 ? ascii : `char_${index + 1}`;
  let key = base;
  for (let i = 2; taken.has(key); i++) key = `${base}_${i}`;
  taken.add(key);
  return key;
}

// ── Rewriting the samples ─────────────────────────────────────────

const firstLetter = (name: string) => Array.from(name)[0] ?? "?";

/** One of the card's characters, in the shape of the pack's sample person:
 *  name, bio and picture are the character's; a sample's history, tags and
 *  sentences go; numbers, colours and one-word states (`mood: "happy"`)
 *  stay as the pack set them, so its code still finds what it expects. */
function personFrom(template: Obj, ch: CardCharacter): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(template)) {
    if (NAME_FIELD.test(k)) out[k] = ch.name;
    else if (k === "id") out[k] = ch.key;
    else if (DESC_FIELD.test(k)) out[k] = ch.description;
    // Shared interfaces draw a picture when the value is an asset or a link
    // and a letter otherwise: the character's portrait, else their initial.
    else if (IMAGE_FIELD.test(k) && (typeof v === "string" || v == null)) out[k] = ch.portrait ?? (typeof v === "string" && v.length > 0 && v.length <= 2 ? firstLetter(ch.name) : "");
    else if (Array.isArray(v)) out[k] = [];
    else if (typeof v === "string") out[k] = /^[\w#.-]{1,24}$/.test(v) ? v : "";
    // A sample's own moment (`lastInteraction: { time, scene }`) has no
    // counterpart yet. Interfaces the AI fills at play already cope with a
    // person who lacks one.
    else if (isObj(v)) out[k] = null;
    else out[k] = v;
  }
  return out;
}

function fillPeople(value: unknown, characters: readonly CardCharacter[]): unknown {
  const got = itemsOf(value);
  if (!got) return value;
  const people = characters.map((ch, i) => personFrom(got.items[i % got.items.length]!, ch));
  if (got.shape === "array") return people;
  return Object.fromEntries(people.map((p, i) => [characters[i]!.key, p]));
}

function emptied(value: unknown, shape: PackCollection["shape"]): unknown {
  if (shape === "array") return [];
  if (shape === "slots" && isObj(value)) return Object.fromEntries(Object.keys(value).map((k) => [k, null]));
  return {};
}

/** What each list does by default: people become the card's characters when
 *  it has any; a sample history follows its people; the rest stays. */
export function defaultCollectionChoices(collections: readonly PackCollection[], characters: readonly CardCharacter[]): Record<string, CollectionChoice> {
  const out: Record<string, CollectionChoice> = {};
  for (const c of collections) if (c.people) out[c.key] = characters.length > 0 ? "characters" : "keep";
  for (const c of collections) {
    if (c.people) continue;
    out[c.key] = c.dependsOn && out[c.dependsOn] === "characters" ? "clear" : "keep";
  }
  return out;
}

/** A list that follows its people is emptied exactly when they are replaced. */
export function resolveCollectionChoices(collections: readonly PackCollection[], choices: Record<string, CollectionChoice>): Record<string, CollectionChoice> {
  const out = { ...choices };
  for (const c of collections) {
    if (c.dependsOn) out[c.key] = out[c.dependsOn] === "characters" ? "clear" : "keep";
  }
  return out;
}

/**
 * The pack with its samples fitted to the card: the chosen people lists hold
 * the card's characters, the emptied lists start empty. Nothing else of the
 * pack changes. Returns the same object when there is nothing to do.
 */
export function fitPackToCard(
  bundle: YuminaBundle,
  collections: readonly PackCollection[],
  choices: Record<string, CollectionChoice>,
  characters: readonly CardCharacter[],
): YuminaBundle {
  // No characters to put in (all left out): the people stay, and so does
  // what follows them.
  const given = characters.length > 0
    ? choices
    : Object.fromEntries(Object.entries(choices).map(([k, c]) => [k, c === "characters" ? "keep" : c])) as Record<string, CollectionChoice>;
  const resolved = resolveCollectionChoices(collections, given);
  const todo = collections.filter((c) => (resolved[c.key] === "characters" && c.people) || resolved[c.key] === "clear");
  if (todo.length === 0) return bundle;
  const variables: Variable[] = bundle.variables.map((v) => {
    const mine = todo.filter((c) => c.variableId === v.id);
    if (mine.length === 0) return v;
    let value: unknown = v.defaultValue;
    for (const c of mine) {
      const current = c.field && isObj(value) ? value[c.field] : value;
      const next = resolved[c.key] === "clear" ? emptied(current, c.shape) : fillPeople(current, characters);
      value = c.field && isObj(value) ? { ...value, [c.field]: next } : next;
    }
    return { ...v, defaultValue: value as Variable["defaultValue"] };
  });
  return { ...bundle, variables: zeroCounts(variables, todo.filter((c) => resolved[c.key] === "clear")) };
}

/** Counters of emptied lists start at zero too: `phone_unread: { sms: 1 }`
 *  after `phone_sms` was emptied would show a message that is not there. */
function zeroCounts(variables: Variable[], cleared: readonly PackCollection[]): Variable[] {
  if (cleared.length === 0) return variables;
  const names = new Set(cleared.flatMap((c) => {
    const id = c.field ?? c.variableId;
    return [id.toLowerCase(), id.toLowerCase().split(/[_.-]/).pop()!];
  }));
  return variables.map((v) => {
    if (v.type !== "json" || !isObj(v.defaultValue)) return v;
    const value = v.defaultValue;
    const entries = Object.entries(value);
    if (entries.length === 0 || !entries.every(([, x]) => typeof x === "number")) return v;
    if (!entries.some(([k]) => names.has(k.toLowerCase()))) return v;
    return { ...v, defaultValue: Object.fromEntries(entries.map(([k, x]) => [k, names.has(k.toLowerCase()) ? 0 : x])) as Variable["defaultValue"] };
  });
}

// ── Linking a pack's single values to the card's ─────────────────────

/** The pack's own single values (a number, a word, a switch) the author can
 *  point at one of the card's instead of adding a new one. */
export function linkableVariables(bundle: Pick<YuminaBundle, "variables">, world: Pick<WorldDefinition, "variables">): Array<{ packVar: Variable; candidates: Variable[] }> {
  const ids = new Set(world.variables.map((v) => v.id));
  const names = new Set(world.variables.map((v) => v.name.toLowerCase()));
  return bundle.variables
    .filter((v) => v.type !== "json" && !ids.has(v.id) && !names.has(v.name.toLowerCase()))
    .map((packVar) => ({ packVar, candidates: world.variables.filter((v) => v.type === packVar.type) }))
    .filter((x) => x.candidates.length > 0);
}
