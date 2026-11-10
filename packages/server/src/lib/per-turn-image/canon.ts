// A character from a published work, drawn by its danbooru name. Anima and
// Illustrious learned these names from danbooru, so "makima (chainsaw man)"
// brings back her braid, eyes and suit where the tagger's own look tags drew
// a generic pink-haired woman (bench on 16 IP characters, 2026-10-13).
//
// The tagger proposes the names; danbooru confirms them. Taggers write
// western name order ("satoru gojo" for gojou_satoru) and retired spellings
// whose tag has no posts; a name the model never saw is worse than none. So a
// name is used only once danbooru knows it as a character (or copyright) tag
// with real posts, directly, through an active alias, or with the two words
// of the name swapped. Anything else draws from the look tags, as before.

import { redis } from "../redis.js";

const API = "https://danbooru.donmai.us";
const HEADERS = { "User-Agent": "Yumina/1.0 (+https://yumina.io)" };
/** Fewer posts than this and the models barely know the name. */
const MIN_POSTS = 30;
const CHARACTER = 4;
const COPYRIGHT = 3;
const REQUEST_TIMEOUT_MS = 2_500;
const TTL_S = 30 * 86_400;
const MAX_MEMO = 5_000;
const memo = new Map<string, Promise<string>>();

interface Tag { name: string; post_count: number; category: number }

// Danbooru rate-limits bursts (a run of ~90 names in a row came back 429
// halfway): two requests at a time per server. A picture that would wait past
// canonTags()'s timeout goes without the name; the lookup still finishes and
// is cached for the next one.
const MAX_IN_FLIGHT = 2;
let inFlight = 0;
const waiting: (() => void)[] = [];

async function getJson<T>(path: string): Promise<T> {
  if (inFlight >= MAX_IN_FLIGHT) await new Promise<void>((resolve) => waiting.push(resolve));
  inFlight++;
  try {
    const res = await fetch(`${API}${path}`, { headers: HEADERS, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`danbooru ${res.status}`);
    return await (res.json() as Promise<T>);
  } finally {
    inFlight--;
    waiting.shift()?.();
  }
}

async function tag(name: string): Promise<Tag | undefined> {
  const rows = await getJson<Tag[]>(`/tags.json?search[name]=${encodeURIComponent(name)}&only=name,post_count,category`);
  return rows[0];
}

async function alias(name: string): Promise<string | undefined> {
  const rows = await getJson<{ consequent_name: string }[]>(
    `/tag_aliases.json?search[antecedent_name]=${encodeURIComponent(name)}&search[status]=active&only=consequent_name`);
  return rows[0]?.consequent_name;
}

/** "satoru gojo" → "gojo satoru"; "kazuma satou (konosuba)" → "satou kazuma (konosuba)". */
function swapped(name: string): string | undefined {
  const m = name.match(/^([^_()]+)_([^_()]+)(_\(.+\))?$/);
  return m ? `${m[2]}_${m[1]}${m[3] ?? ""}` : undefined;
}

/** Danbooru's own name for `raw` in that category, or "" when it has none.
 *  `work` (a confirmed copyright) also tries the qualified form taggers drop:
 *  "makima" is makima_(chainsaw_man), "nami" nami_(one_piece). A copyright
 *  also tries "_(series)" (naruto_(series)). Throws when danbooru can't be reached. */
async function confirm(raw: string, category: number, work = ""): Promise<string> {
  const name = raw.trim().toLowerCase().replace(/\\/g, "").replace(/\s+/g, "_");
  if (!name || name.length > 80) return "";
  const base = name.replace(/_\(.+\)$/, "");
  const flipped = swapped(base);
  const candidates = [name, swapped(name),
    ...(work ? [`${base}_(${work})`, flipped && `${flipped}_(${work})`] : []),
    ...(category === COPYRIGHT ? [`${name}_(series)`] : [])];
  for (const candidate of new Set(candidates)) {
    if (!candidate) continue;
    // A live tag of another kind ("naruto" is the character) means try the next form.
    const direct = await tag(candidate);
    if (direct && direct.post_count >= MIN_POSTS) {
      if (direct.category === category) return direct.name;
      continue;
    }
    const target = await alias(candidate);
    const aliased = target ? await tag(target) : undefined;
    if (aliased && aliased.post_count >= MIN_POSTS && aliased.category === category) return aliased.name;
  }
  return "";
}

/** Cached per name: in memory, then Redis. Unreachable danbooru is not cached. */
function confirmed(raw: string, category: number, work = ""): Promise<string> {
  const key = `${category}:${raw.trim().toLowerCase()}:${work}`;
  let hit = memo.get(key);
  if (!hit) {
    hit = (async () => {
      const saved = await redis?.get(`turnimg:canon:${key}`).catch(() => null);
      if (typeof saved === "string") return saved;
      const name = await confirm(raw, category, work);
      void redis?.set(`turnimg:canon:${key}`, name, "EX", TTL_S).catch(() => { /* memory copy still holds it */ });
      return name;
    })();
    hit.catch(() => memo.delete(key));
    if (memo.size >= MAX_MEMO) memo.delete(memo.keys().next().value!);
    memo.set(key, hit);
  }
  return hit;
}

/** As the text encoder reads it: spaces, and brackets escaped so they aren't weights. */
const promptTag = (name: string) => name.replace(/_/g, " ").replace(/([()])/g, "\\$1");

/** The prompt tags for a tagger's "character, copyright" pair: both, the
 *  character alone, or "" when danbooru doesn't know the character. Never
 *  throws; a slow or unreachable danbooru gives "" for this picture. */
export async function canonTags(raw: string | undefined, timeoutMs = 3_000): Promise<string> {
  const [character, copyright] = (raw ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  if (!character) return "";
  const work = (async () => {
    const from = copyright ? await confirmed(copyright, COPYRIGHT) : "";
    const who = await confirmed(character, CHARACTER, from);
    return who ? [who, from].filter(Boolean).map(promptTag).join(", ") : "";
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<string>((resolve) => { timer = setTimeout(() => resolve(""), timeoutMs); });
  try {
    return await Promise.race([work.catch(() => ""), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Puts the canon tags right after the head count (and "adult"), where the models expect a name. */
export function withCanon(look: string, canon: string): string {
  if (!canon) return look;
  const tags = look.split(",").map((t) => t.trim()).filter(Boolean);
  let at = tags.length && /^\d+(girl|boy|other)s?$/i.test(tags[0]!) ? 1 : 0;
  if (/^adult$/i.test(tags[at] ?? "")) at++;
  tags.splice(at, 0, canon);
  return tags.join(", ");
}
