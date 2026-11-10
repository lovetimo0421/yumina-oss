/**
 * The update log (更新日志). One markdown file per entry in `changelog/` at
 * the repo root (see changelog/README.md for the format and the rules), read
 * at startup, validated, rendered to HTML once per language and kept in
 * memory. No database: git is the archive and shipping the code ships the
 * words.
 *
 * Internal entries (`audience: internal`) live in the same folder. They never
 * enter the app bundle (the app only fetches the API) and the route hands them
 * to admins only — `changelogFor()` is the single place that decides.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Marked, type Tokens } from "marked";
import {
  CHANGELOG_LANGS,
  CHANGELOG_REQUIRED_LANGS,
  changelogAreaSlug,
  clampChangelogLang,
  type ChangelogArea,
  type ChangelogAudience,
  type ChangelogEntryView,
  type ChangelogKind,
  type ChangelogLang,
} from "@yumina/shared";

export interface ChangelogEntry {
  id: string;
  date: string;
  audience: ChangelogAudience;
  areas: ChangelogArea[];
  title: Partial<Record<ChangelogLang, string>>;
  /** Markdown per language, as written. */
  body: Partial<Record<ChangelogLang, string>>;
  /** Rendered body per language. */
  html: Partial<Record<ChangelogLang, string>>;
  highlight: boolean;
  kind: ChangelogKind;
}

export class ChangelogFormatError extends Error {
  /** The reason alone, without the file/entry prefix (what the web editor shows). */
  readonly problem: string;
  /** The field it is about when known: date, audience, areas, title.zh, body.en, id. */
  readonly field?: string;
  constructor(source: string, problem: string, field?: string) {
    // A file is named by its path in the repo; a web entry by its id.
    super(`${source.endsWith(".md") ? `changelog/${source}` : source}: ${problem}`);
    this.name = "ChangelogFormatError";
    this.problem = problem;
    this.field = field;
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Dev: packages/server/src/lib → repo root. Prod: the bundle runs from
// packages/server/dist and the Dockerfile copies the folder to /app/changelog.
// Then the two cwd shapes (packages/server, repo root) as a last resort.
function candidateDirs(): string[] {
  return [
    process.env.YUMINA_CHANGELOG_DIR,
    path.resolve(__dirname, "../../../../changelog"),
    path.resolve(__dirname, "../../../changelog"),
    path.resolve(process.cwd(), "../../changelog"),
    path.resolve(process.cwd(), "changelog"),
  ].filter((dir): dir is string => Boolean(dir));
}

export function changelogDir(): string | null {
  for (const dir of candidateDirs()) {
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return dir;
  }
  return null;
}

const FILE_RE = /^(\d{4}-\d{2}-\d{2})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;
/** An entry id: the file name without `.md`, also the page anchor and the DB key. */
export const CHANGELOG_ID_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const KEYS = new Set(["date", "audience", "areas", "title", "highlight", "kind"]);

function langKey(value: string): ChangelogLang | null {
  const lower = value.trim().toLowerCase();
  return CHANGELOG_LANGS.find((lang) => lang.toLowerCase() === lower) ?? null;
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      return JSON.parse(v) as string;
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

/** `audience: public   # or internal` → `public`. Only for plain scalars, never titles. */
function stripComment(value: string): string {
  return value.replace(/\s+#.*$/, "").trim();
}

function isRealDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function safeHref(href: string): string | null {
  const v = href.trim();
  if (v.startsWith("//")) return null;
  return /^(https?:\/\/|mailto:|\/|#)/i.test(v) ? v : null;
}

// Entries are trusted repo files, but render them as if they weren't: raw HTML
// is shown as text, links and images keep only safe schemes.
const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    html({ text }: Tokens.HTML | Tokens.Tag): string {
      return escapeHtml(text);
    },
    link(this: { parser: { parseInline(tokens: Tokens.Generic[]): string } }, { href, title, tokens }: Tokens.Link): string {
      const label = this.parser.parseInline(tokens);
      const safe = safeHref(href);
      if (!safe) return label;
      const external = /^https?:\/\//i.test(safe);
      return `<a href="${escapeHtml(safe)}"${title ? ` title="${escapeHtml(title)}"` : ""}${external ? ' target="_blank" rel="noopener noreferrer"' : ""}>${label}</a>`;
    },
    image({ href, text }: Tokens.Image): string {
      const safe = safeHref(href);
      if (!safe || safe.startsWith("mailto:") || safe.startsWith("#")) return escapeHtml(text);
      return `<img src="${escapeHtml(safe)}" alt="${escapeHtml(text)}" loading="lazy" />`;
    },
  },
});

/** Entry markdown → HTML. `· item` / `• item` lines are list items, like `- item`. */
export function renderChangelogMarkdown(markdown: string): string {
  const normalized = markdown.replace(/^(\s*)[·•]\s+/gm, "$1- ");
  return (marked.parse(normalized, { async: false }) as string).trim();
}

interface FrontMatter {
  date?: string;
  audience?: string;
  areas?: string[];
  title?: Partial<Record<ChangelogLang, string>>;
  highlight?: string;
  kind?: string;
}

function parseFrontMatter(fileName: string, block: string): FrontMatter {
  const fail = (problem: string): never => {
    throw new ChangelogFormatError(fileName, problem);
  };
  const meta: FrontMatter = {};
  const seen = new Set<string>();
  let current: string | null = null;
  for (const line of block.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indented = /^\s/.test(line);
    if (!indented) {
      const match = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
      if (!match) fail(`can't read front matter line "${line}"`);
      const key = match![1]!;
      const value = match![2]!;
      if (!KEYS.has(key)) fail(`unknown front matter key "${key}" (allowed: ${[...KEYS].join(", ")})`);
      if (seen.has(key)) fail(`"${key}" appears twice`);
      seen.add(key);
      current = key;
      if (key === "date") meta.date = unquote(stripComment(value));
      else if (key === "audience") meta.audience = unquote(stripComment(value));
      else if (key === "areas") {
        const v = stripComment(value);
        const inner = v.startsWith("[") ? (v.endsWith("]") ? v.slice(1, -1) : fail("areas: missing closing ]")) : v;
        meta.areas = String(inner).split(/[,，、]/).map(unquote).map((s) => s.trim()).filter(Boolean);
      } else if (key === "title") {
        if (value.trim()) fail('title must be a list of languages on the lines below ("  zh: …", "  en: …")');
        meta.title = {};
      } else if (key === "highlight") meta.highlight = unquote(stripComment(value));
      else if (key === "kind") meta.kind = unquote(stripComment(value));
      continue;
    }
    const content = line.trim();
    if (current === "areas") {
      const item = content.match(/^-\s*(.+)$/);
      if (!item) fail(`areas: can't read "${content}"`);
      meta.areas = [...(meta.areas ?? []), unquote(stripComment(item![1]!))];
    } else if (current === "title") {
      const map = meta.title!;
      const match = content.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
      if (!match) fail(`${current}: can't read "${content}" (expected "zh: …")`);
      const lang = langKey(match![1]!);
      if (!lang) fail(`${current}: unknown language "${match![1]}" (allowed: ${CHANGELOG_LANGS.join(", ")})`);
      if (map[lang!] !== undefined) fail(`${current}.${lang} appears twice`);
      const text = unquote(match![2]!);
      if (!text) fail(`${current}.${lang} is empty`);
      map[lang!] = text;
    } else {
      fail(`unexpected indented line "${content}"`);
    }
  }
  return meta;
}

function parseBody(fileName: string, body: string): Partial<Record<ChangelogLang, string>> {
  const sections: Partial<Record<ChangelogLang, string[]>> = {};
  let current: ChangelogLang | null = null;
  for (const line of body.split("\n")) {
    const heading = line.match(/^##\s+(\S+)\s*$/);
    if (heading) {
      const lang = langKey(heading[1]!);
      if (!lang) {
        throw new ChangelogFormatError(
          fileName,
          `"## ${heading[1]}" is not a language section (allowed: ${CHANGELOG_LANGS.join(", ")}); use ### or **bold** for headings inside a section`,
        );
      }
      if (sections[lang]) throw new ChangelogFormatError(fileName, `"## ${lang}" appears twice`);
      sections[lang] = [];
      current = lang;
      continue;
    }
    if (!current) {
      if (line.trim()) throw new ChangelogFormatError(fileName, `text before the first "## zh" / "## en" section: "${line.trim()}"`);
      continue;
    }
    sections[current]!.push(line);
  }
  const out: Partial<Record<ChangelogLang, string>> = {};
  for (const lang of CHANGELOG_LANGS) {
    const lines = sections[lang];
    if (!lines) continue;
    const text = lines.join("\n").trim();
    if (!text) throw new ChangelogFormatError(fileName, `"## ${lang}" section is empty`);
    out[lang] = text;
  }
  return out;
}

/** Parse and validate one entry file. Throws ChangelogFormatError with a readable reason. */
export function parseChangelogEntry(fileName: string, raw: string): ChangelogEntry {
  const name = FILE_RE.exec(fileName);
  if (!name) throw new ChangelogFormatError(fileName, "file name must be YYYY-MM-DD-slug.md (lowercase letters, digits, dashes)");
  const text = raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const match = text.match(/^---\n([\s\S]*?)\n---[ \t]*(?:\n([\s\S]*))?$/);
  if (!match) throw new ChangelogFormatError(fileName, "must start with a --- front matter block closed by ---");
  const meta = parseFrontMatter(fileName, match[1]!);

  const body = parseBody(fileName, match[2] ?? "");
  return {
    id: fileName.slice(0, -3),
    ...validateChangelogFields(
      fileName,
      { date: meta.date, audience: meta.audience, areas: meta.areas, title: meta.title ?? {}, body, highlight: meta.highlight, kind: meta.kind },
      { fileDate: name[1]! },
    ),
  };
}

export interface ChangelogFields {
  date?: string | null;
  audience?: string | null;
  areas?: readonly string[] | null;
  title?: Partial<Record<string, string | null | undefined>> | null;
  body?: Partial<Record<string, string | null | undefined>> | null;
  /** true / "true" — a slightly larger title, and announced once on Discover. */
  highlight?: boolean | string | null;
  /** "standard" (default) or "roundup" (many small fixes, shown compact). */
  kind?: string | null;
}

const MAX_TITLE = 200;
const MAX_BODY = 20_000;

/**
 * The one set of rules every entry obeys, whether it comes from a file or the
 * web editor: a real date, public/internal, known areas, zh + en, and every
 * language that has a title has a body (and back). Returns the normalized
 * entry (areas as slugs, empty languages dropped, bodies rendered).
 */
export function validateChangelogFields(
  source: string,
  input: ChangelogFields,
  options: { fileDate?: string } = {},
): Omit<ChangelogEntry, "id"> {
  const fail = (problem: string, field?: string): never => {
    throw new ChangelogFormatError(source, problem, field);
  };
  const date = (input.date ?? "").trim();
  if (!date) fail("missing date", "date");
  if (!isRealDate(date)) fail(`date "${date}" is not a real YYYY-MM-DD date`, "date");
  if (options.fileDate && date !== options.fileDate) fail(`date ${date} doesn't match the file name's ${options.fileDate}`, "date");

  const audience = input.audience;
  if (audience !== "public" && audience !== "internal" && audience !== "unrestricted") {
    fail(`audience must be "public", "internal" or "unrestricted" (got ${audience ? `"${audience}"` : "nothing"})`, "audience");
  }

  if (!input.areas?.length) fail("areas must list at least one area", "areas");
  const areas: ChangelogArea[] = [];
  for (const value of input.areas!) {
    const slug = changelogAreaSlug(String(value));
    if (!slug) fail(`unknown area "${value}" (see the list in changelog/README.md)`, "areas");
    if (!areas.includes(slug!)) areas.push(slug!);
  }

  const title: Partial<Record<ChangelogLang, string>> = {};
  const body: Partial<Record<ChangelogLang, string>> = {};
  for (const key of Object.keys(input.title ?? {})) if (!langKey(key)) fail(`title: unknown language "${key}"`, "title");
  for (const key of Object.keys(input.body ?? {})) if (!langKey(key)) fail(`body: unknown language "${key}"`, "body");
  for (const lang of CHANGELOG_LANGS) {
    const t = String(input.title?.[lang] ?? "").trim();
    const b = String(input.body?.[lang] ?? "").replace(/\r\n?/g, "\n").trim();
    if (t.length > MAX_TITLE) fail(`title.${lang} is longer than ${MAX_TITLE} characters`, `title.${lang}`);
    if (b.length > MAX_BODY) fail(`"## ${lang}" is longer than ${MAX_BODY} characters`, `body.${lang}`);
    if (t) title[lang] = t;
    if (b) body[lang] = b;
  }
  for (const lang of CHANGELOG_REQUIRED_LANGS) {
    if (!title[lang]) fail(`missing title.${lang}`, `title.${lang}`);
    if (!body[lang]) fail(`missing "## ${lang}" section`, `body.${lang}`);
  }
  for (const lang of CHANGELOG_LANGS) {
    if (Boolean(title[lang]) !== Boolean(body[lang])) {
      if (title[lang]) fail(`has title.${lang} but no "## ${lang}" section`, `body.${lang}`);
      fail(`has a "## ${lang}" section but no title.${lang}`, `title.${lang}`);
    }
  }

  let highlight = false;
  if (input.highlight !== undefined && input.highlight !== null && input.highlight !== "") {
    if (input.highlight === true || input.highlight === "true") highlight = true;
    else if (input.highlight !== false && input.highlight !== "false") fail(`highlight must be true or false (got "${input.highlight}")`, "highlight");
  }

  const kind = input.kind ? String(input.kind).trim() : "standard";
  if (kind !== "standard" && kind !== "roundup") fail(`kind must be "standard" or "roundup" (got "${kind}")`, "kind");

  const html: Partial<Record<ChangelogLang, string>> = {};
  for (const lang of CHANGELOG_LANGS) {
    if (body[lang]) html[lang] = renderChangelogMarkdown(body[lang]!);
  }
  return {
    date, audience: audience as ChangelogAudience, areas, title, body, html,
    highlight, kind: kind as ChangelogKind,
  };
}

/** Newest first; on the same day a highlight leads, then by id. */
export function compareEntries(a: Pick<ChangelogEntry, "date" | "id" | "highlight">, b: Pick<ChangelogEntry, "date" | "id" | "highlight">): number {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  if (a.highlight !== b.highlight) return a.highlight ? -1 : 1;
  return b.id.localeCompare(a.id);
}

export interface ChangelogLoad {
  entries: ChangelogEntry[];
  errors: ChangelogFormatError[];
  dir: string | null;
}

/** Read every entry in a folder, newest first. README.md is documentation; any other .md must be an entry. */
export function loadChangelog(dir: string | null = changelogDir()): ChangelogLoad {
  const entries: ChangelogEntry[] = [];
  const errors: ChangelogFormatError[] = [];
  if (dir) {
    for (const file of fs.readdirSync(dir).sort()) {
      if (!file.endsWith(".md") || file.toLowerCase() === "readme.md") continue;
      try {
        entries.push(parseChangelogEntry(file, fs.readFileSync(path.join(dir, file), "utf8")));
      } catch (error) {
        errors.push(error instanceof ChangelogFormatError ? error : new ChangelogFormatError(file, String(error)));
      }
    }
  }
  entries.sort(compareEntries);
  return { entries, errors, dir };
}

let cache: ChangelogEntry[] | null = null;

/**
 * The parsed entries. Production reads the folder once (the files ship with
 * the image, so they can't change underneath it); dev re-reads on every call
 * so an edited entry shows on refresh. A malformed file is logged and left
 * out — the changelog test is what stops it from merging.
 */
export function getChangelogEntries(): ChangelogEntry[] {
  if (cache && process.env.NODE_ENV === "production") return cache;
  const { entries, errors, dir } = loadChangelog();
  for (const error of errors) console.error(`[changelog] ${error.message}`);
  if (!dir && process.env.NODE_ENV === "production") console.warn("[changelog] no changelog/ folder found; the update log is empty");
  cache = entries;
  return entries;
}

function fallbackOrder(lang: ChangelogLang): ChangelogLang[] {
  // A Traditional Chinese reader is better served by Simplified than by English.
  const chain: ChangelogLang[] = lang === "zh-Hant" ? ["zh-Hant", "zh", "en"] : [lang, "en", "zh"];
  return [...new Set(chain)];
}

export function entryView(entry: ChangelogEntry, requested: string | null | undefined): ChangelogEntryView {
  const want = clampChangelogLang(requested);
  const lang = fallbackOrder(want).find((l) => entry.title[l] && entry.html[l]) ?? "en";
  return {
    id: entry.id,
    date: entry.date,
    audience: entry.audience,
    areas: entry.areas,
    lang,
    title: entry.title[lang] ?? "",
    html: entry.html[lang] ?? "",
    highlight: entry.highlight,
    kind: entry.kind,
  };
}

/** What one viewer may see: public entries for everyone, internal ones only for an admin. */
export function changelogFor(entries: ChangelogEntry[], viewer: { isAdmin: boolean; unrestricted?: boolean }, lang: string | null | undefined): ChangelogEntryView[] {
  return entries.filter((e) => e.audience === "public" || (e.audience === "unrestricted" && viewer.unrestricted) || viewer.isAdmin).map((e) => entryView(e, lang));
}
