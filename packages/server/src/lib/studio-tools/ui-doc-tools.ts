/**
 * Studio assistant ↔ interface document (uiDoc).
 *
 * The visual editor and the assistant edit ONE document. The assistant's side
 * is two tools: read_ui_doc (a compact summary the model can plan against) and
 * edit_ui_doc (a list of structural operations, validated against the engine's
 * own schema and recompiled into rootComponent on the spot, so play sees the
 * change even if nobody ever opens the editor).
 *
 * The recompile mirrors the app's compileEditorUiDoc (packages/app/src/stores/
 * editor.ts) byte for byte — including the bundle-composer case — so the
 * editor's own save-time compile finds nothing to change afterwards.
 */

import type { RootComponent, UiDoc, UiElement, UiPage, WorldDefinition, Variable } from "@yumina/engine";
import { compileUiDoc, uiDocSchema, validateUiDoc, buildUiTheme, getUiThemePreset, UI_THEMES, UI_CHAT_STARTED, PromptBuilder, syncMessageRulesEntry, UI_RULES_ENTRY_ID, UI_LOOKS, applyUiLook, currentUiLook, getUiLook, uiLookPartOf, fitTextBox, pushBelowGrown, textStyleAffectsHeight, readableThemeTokens, USER_ROOT_PATH, COMPOSED_MARKER, BUNDLE_NS_RE, generateComposedIndex, syncGreetingActions } from "@yumina/engine";
import crypto from "crypto";
import { validateTsx, formatTsxIssue } from "./tsx-validate.js";
import { assertNoInlineDataUris } from "../asset-validation.js";

// ── Compile (mirror of the app's compileEditorUiDoc) ──


/** Compile `doc` into the rootComponent it produces, keeping every sibling file
 *  (the preserved base, bundles, helpers) and marking the result generated. */
export function compileUiDocInto(doc: UiDoc, previous: RootComponent | undefined): RootComponent {
  const built = compileUiDoc(doc);
  const files: Record<string, string> = { ...(previous?.files ?? {}), ...built.files };
  const folders = Object.keys(files).flatMap((name) => {
    const match = name.match(BUNDLE_NS_RE);
    return match ? [match[1]!] : [];
  }).sort();
  const baseFile = doc.base?.file;
  const baseComposes = baseFile && previous?.files[baseFile]?.startsWith(COMPOSED_MARKER);
  if (baseComposes) {
    files[baseFile] = generateComposedIndex(folders);
  } else if (
    previous?.files["index.tsx"]?.startsWith(COMPOSED_MARKER) ||
    (folders.length > 0 && previous?.files[USER_ROOT_PATH] !== undefined)
  ) {
    files[USER_ROOT_PATH] = built.files[built.entryFile]!;
    files["index.tsx"] = generateComposedIndex(folders);
  }
  const unchanged = previous?.entryFile === built.entryFile &&
    previous.generatedFrom === "uiDoc" &&
    Object.keys(previous.files).length === Object.keys(files).length &&
    Object.entries(files).every(([name, code]) => previous.files[name] === code);
  if (unchanged) return previous;
  const { compiled: _compiled, ...rest } = previous ?? ({} as Partial<RootComponent>);
  return {
    ...rest,
    id: previous?.id || crypto.randomUUID(),
    name: previous?.name || "Interface",
    entryFile: built.entryFile,
    files,
    updatedAt: new Date().toISOString(),
    generatedFrom: "uiDoc",
  } as RootComponent;
}

/**
 * The rootComponent files a card's document owns: anything written to them is
 * replaced the next time the doc compiles (every editor save compiles a card
 * that has a uiDoc). Empty for a card without a document.
 */
export function uiDocOwnedFiles(world: WorldDefinition): Set<string> {
  const owned = new Set<string>();
  const doc = world.uiDoc;
  if (!doc) return owned;
  const rc = world.rootComponent;
  owned.add("index.tsx");
  const baseFile = doc.base?.file;
  if (baseFile) owned.add("_knobs.tsx");
  if (baseFile && rc?.files[baseFile]?.startsWith(COMPOSED_MARKER)) owned.add(baseFile);
  if (rc?.files["index.tsx"]?.startsWith(COMPOSED_MARKER) || rc?.files[USER_ROOT_PATH] !== undefined) owned.add(USER_ROOT_PATH);
  return owned;
}

/** Why a code write to `file` would be lost, as an instruction the model can act on. */
export function uiDocOwnedFileError(world: WorldDefinition, file: string, verb: string): string | null {
  if (!uiDocOwnedFiles(world).has(file)) return null;
  const base = world.uiDoc?.base?.file;
  const baseHint = base && !uiDocOwnedFiles(world).has(base)
    ? ` The card's preserved hand-written layer is "${base}" — code edits THERE are kept (it renders underneath the parts).`
    : "";
  return `Refused to ${verb} "${file}": this card's interface is built in the visual editor (uiDoc), and "${file}" is compiled from that document — it is regenerated on every save, so a code edit here would be silently lost. Change the document instead with edit_ui_doc (load_skill "ui-doc" first; read_ui_doc shows the parts): restyle/move/relabel with update_part, set_theme for card-wide colours and fonts, add_part for new pieces. For something no part can express, add_part a { type: "custom", code } part — hand-written TSX that stays a movable part of the document.${baseHint} Only if the creator explicitly wants to leave the visual editor for good, edit_ui_doc [{ op: "detach_to_code" }] keeps the compiled code and hands the frontend over to code.`;
}

// ── Creating a document for a card that has none ──

const SHELL_MAX_CHARS = 800;
function rendersSomething(rc: RootComponent): boolean {
  const source = Object.values(rc.files ?? {}).join("");
  return /\.map\s*\(/.test(source) || /<img/i.test(source) || /onClick/.test(source) ||
    /api\.(variables|setVariable|sendMessage)/.test(source) || /React\.use(State|Effect|Memo)/.test(source);
}
/** Same line the app's takeover classification draws (ui-doc-takeover.ts). */
function isShell(rc: RootComponent | undefined): boolean {
  if (!rc) return true;
  const source = Object.values(rc.files ?? {}).join("");
  return source.replace(/\s+/g, "").length < SHELL_MAX_CHARS && !rendersSomething(rc);
}

/** Give a card a document without losing its frontend. A hand-written frontend
 *  becomes the document's preserved base layer (the builder's own adoption);
 *  an empty shell gives way to the platform chat underneath. */
function ensureUiDoc(draft: WorldDefinition): { note?: string; error?: string } {
  if (draft.uiDoc) return {};
  const rc = draft.rootComponent;
  if (rc?.generatedFrom === "uiDoc") {
    return { error: "Inconsistent card: a generated interface without its document. Ask the creator to open the interface builder once." };
  }
  const page: UiPage = { id: "page-1", name: "Main", height: 812, elements: [] };
  if (rc && !isShell(rc)) {
    const files = { ...rc.files };
    let baseFile = rc.entryFile || "index.tsx";
    if (baseFile === "index.tsx") {
      baseFile = "_base.tsx";
      for (let i = 2; baseFile in files; i++) baseFile = `_base-${i}.tsx`;
      files[baseFile] = files["index.tsx"]!;
    }
    delete files["index.tsx"];
    draft.uiDoc = { version: 1, entryPageId: page.id, pages: [page], base: { file: baseFile } };
    draft.rootComponent = { ...rc, files };
    return { note: `created the interface document; the existing hand-written frontend is kept as its base layer "${baseFile}"` };
  }
  if (rc) {
    const files = { ...rc.files };
    delete files["index.tsx"];
    draft.rootComponent = { ...rc, files };
  }
  draft.uiDoc = { version: 1, entryPageId: page.id, pages: [page], surface: "chat" };
  return { note: "created the interface document over the platform chat (surface: chat)" };
}

// ── Helpers ──

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const short = (text: string, max = 60) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** RFC 7386 merge patch: objects merge, null deletes, everything else replaces. */
function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isObj(patch)) return patch;
  const out: Json = isObj(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out;
}

function allElements(doc: UiDoc): Array<{ page: UiPage; el: UiElement }> {
  return doc.pages.flatMap((page) => page.elements.map((el) => ({ page, el })));
}

function mintId(prefix: string, taken: Set<string>): string {
  const stem = prefix.replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "") || "part";
  for (let i = 1; ; i++) {
    const id = `${stem}-${i}`;
    if (!taken.has(id)) return id;
  }
}

function takenIds(doc: UiDoc): Set<string> {
  return new Set([...doc.pages.map((p) => p.id), ...allElements(doc).map(({ el }) => el.id)]);
}

// ── Variable / track references ──

/** Tokens inside {{…}} that are not variables: row, popup and choice scopes,
 *  and the persona macros. */
const RESERVED_MACROS = /^(item|index|value|choice|char|user)(\.|$)/;

class RefResolver {
  readonly notes: string[] = [];
  constructor(private readonly world: WorldDefinition) {}

  variable(ref: string, where: string): string {
    if (ref === UI_CHAT_STARTED || ref.startsWith("$")) return ref;
    const vars = this.world.variables ?? [];
    if (vars.some((v) => v.id === ref)) return ref;
    const exact = vars.filter((v) => v.name === ref);
    const loose = exact.length ? exact : vars.filter((v) => v.name.trim().toLowerCase() === ref.trim().toLowerCase());
    if (loose.length === 1) {
      this.notes.push(`"${ref}" → variable id "${loose[0]!.id}"`);
      return loose[0]!.id;
    }
    if (loose.length > 1) {
      throw new Error(`${where}: variable name "${ref}" is ambiguous — use one of the ids ${loose.map((v) => `"${v.id}"`).join(", ")}.`);
    }
    const list = vars.slice(0, 40).map((v) => `${v.id} ("${v.name}", ${v.type})`).join("; ");
    throw new Error(`${where}: no variable "${ref}". Variables: ${list || "(none — create it first with write_variable, earlier in the same reply)"}.`);
  }

  track(ref: string, where: string): string {
    const tracks = this.world.audioTracks ?? [];
    if (tracks.some((t) => t.id === ref)) return ref;
    const byName = tracks.filter((t) => t.name === ref);
    if (byName.length === 1) return byName[0]!.id;
    throw new Error(`${where}: no audio track "${ref}". Tracks: ${tracks.map((t) => t.id).join(", ") || "(none)"}.`);
  }

  template(text: string): string {
    const vars = this.world.variables ?? [];
    return text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (whole, token: string) => {
      if (RESERVED_MACROS.test(token) || vars.some((v) => v.id === token)) return whole;
      const byName = vars.filter((v) => v.name === token);
      if (byName.length === 1) {
        this.notes.push(`{{${token}}} → {{${byName[0]!.id}}}`);
        return `{{${byName[0]!.id}}}`;
      }
      return whole;
    });
  }

  /** Walk a part (or a patch of one) resolving every variable-shaped field. */
  walk(value: unknown, where: string): unknown {
    if (Array.isArray(value)) return value.map((v, i) => this.walk(v, `${where}[${i}]`));
    if (!isObj(value)) return value;
    const out: Json = {};
    for (const [k, v] of Object.entries(value)) {
      const at = `${where}.${k}`;
      if (k === "variableId" && typeof v === "string" && v) out[k] = this.variable(v, at);
      else if (k === "requires" && Array.isArray(v)) out[k] = v.map((r, i) => (typeof r === "string" ? this.variable(r, `${at}[${i}]`) : r));
      else if (k === "trackId" && typeof v === "string" && v) out[k] = this.track(v, at);
      else if (k === "template" && typeof v === "string") out[k] = this.template(v);
      else out[k] = this.walk(v, at);
    }
    return out;
  }
}

// ── Validation messages the model can act on ──

interface ZodIssueLike {
  code: string;
  path: Array<string | number>;
  message: string;
  unionErrors?: Array<{ issues: ZodIssueLike[] }>;
}

/** Flatten zod issues, following into the union branch the data actually chose
 *  (the one whose `type` / `kind` literal matched) instead of "Invalid input". */
function flattenIssues(issues: ZodIssueLike[]): ZodIssueLike[] {
  const out: ZodIssueLike[] = [];
  for (const issue of issues) {
    if (issue.code === "invalid_union" && issue.unionErrors?.length) {
      const discriminated = issue.unionErrors.filter((u) =>
        !u.issues.some((i) => i.code === "invalid_literal" && ["type", "kind"].includes(String(i.path[i.path.length - 1]))));
      const pick = (discriminated.length ? discriminated : issue.unionErrors)
        .reduce((best, u) => (u.issues.length < best.issues.length ? u : best));
      if (discriminated.length === 0) {
        const kind = String(issue.path[issue.path.length - 1] ?? "");
        out.push({ ...issue, message: `unknown ${/elements/.test(issue.path.join(".")) || /^\d+$/.test(kind) ? "type/kind" : "value"} — no allowed shape matches` });
        continue;
      }
      out.push(...flattenIssues(pick.issues));
      continue;
    }
    out.push(issue);
  }
  return out;
}

function describePath(doc: UiDoc, path: Array<string | number>): string {
  if (path[0] === "pages" && typeof path[1] === "number") {
    const page = doc.pages[path[1]];
    if (path[2] === "elements" && typeof path[3] === "number" && page) {
      const el = page.elements[path[3]];
      const rest = path.slice(4).join(".");
      return `part "${el?.id ?? path[3]}" (${el?.type ?? "?"})${rest ? ` → ${rest}` : ""}`;
    }
    const rest = path.slice(2).join(".");
    return `page "${page?.id ?? path[1]}"${rest ? ` → ${rest}` : ""}`;
  }
  return path.join(".") || "(document)";
}

function schemaErrors(doc: UiDoc): string[] {
  const parsed = uiDocSchema.safeParse(doc);
  if (parsed.success) {
    const deep = validateUiDoc(doc);
    return deep.ok ? [] : deep.errors;
  }
  return flattenIssues(parsed.error.issues as unknown as ZodIssueLike[])
    .map((i) => `${describePath(doc, i.path)}: ${i.message}`);
}

/** Fields present in `raw` that the schema dropped — typos and invented props.
 *  The schema strips unknown keys silently; a restyle that set `colour` would
 *  otherwise "succeed" and change nothing. */
function droppedKeys(raw: unknown, parsed: unknown, path: string, out: string[]): void {
  if (Array.isArray(raw) && Array.isArray(parsed)) {
    raw.forEach((v, i) => droppedKeys(v, parsed[i], `${path}[${i}]`, out));
    return;
  }
  if (!isObj(raw) || !isObj(parsed)) return;
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined || v === null || v === "same") continue;
    const at = path ? `${path}.${k}` : k;
    if (!(k in parsed)) out.push(at);
    else droppedKeys(v, parsed[k], at, out);
  }
}

/** Checks the schema cannot make: that the things a touched part points at exist. */
function referenceErrors(doc: UiDoc, el: UiElement, world: WorldDefinition): string[] {
  const errors: string[] = [];
  const pageIds = new Set(doc.pages.map((p) => p.id));
  const greetings = new PromptBuilder().buildGreetingEntries(world).length;
  const visit = (value: unknown, at: string) => {
    if (Array.isArray(value)) { value.forEach((v, i) => visit(v, `${at}[${i}]`)); return; }
    if (!isObj(value)) return;
    if (value.kind === "go-page" && typeof value.pageId === "string" && !pageIds.has(value.pageId)) {
      errors.push(`part "${el.id}" → ${at}: go-page points at missing page "${value.pageId}" (pages: ${[...pageIds].join(", ")})`);
    }
    if (value.kind === "switch-greeting" && typeof value.index === "number" && value.index >= Math.max(1, greetings)) {
      errors.push(`part "${el.id}" → ${at}: switch-greeting index ${value.index} but the card has ${greetings} opening(s) (0-based; see read_ui_doc OPENINGS)`);
    }
    for (const [k, v] of Object.entries(value)) visit(v, at ? `${at}.${k}` : k);
  };
  visit(el, "");
  if (el.type === "custom") {
    const issues = validateTsx(`export default function __CustomPart() {\n${el.code}\n}`);
    if (issues.length) errors.push(`part "${el.id}" (custom) code does not compile (line numbers are +1): ${formatTsxIssue(issues[0]!)}`);
  }
  const blob = JSON.stringify(el);
  const dataUri = assertNoInlineDataUris(blob, `part "${el.id}"`);
  if (dataUri) errors.push(dataUri);
  return errors;
}

// ── Operations ──

export interface UiDocOp {
  op: string;
  [key: string]: unknown;
}

const OPS = ["add_page", "update_page", "rename_page", "remove_page", "set_entry_page", "add_part", "update_part", "remove_part", "reorder", "move_part", "set_theme", "apply_look", "detach_to_code"] as const;

function findPage(doc: UiDoc, ref: unknown): UiPage {
  if (ref === undefined || ref === null || ref === "") {
    return doc.pages.find((p) => p.id === doc.entryPageId) ?? doc.pages[0]!;
  }
  const key = String(ref);
  const page = doc.pages.find((p) => p.id === key) ?? doc.pages.filter((p) => p.name === key).at(0);
  if (!page) throw new Error(`no page "${key}". Pages: ${doc.pages.map((p) => `${p.id} ("${p.name}")`).join(", ")}`);
  return page;
}

function findPart(doc: UiDoc, id: unknown): { page: UiPage; index: number; el: UiElement } {
  const key = String(id ?? "");
  for (const page of doc.pages) {
    const index = page.elements.findIndex((e) => e.id === key);
    if (index !== -1) return { page, index, el: page.elements[index]! };
  }
  const byName = allElements(doc).filter(({ el }) => el.name === key);
  if (byName.length === 1) {
    const { page, el } = byName[0]!;
    return { page, index: page.elements.indexOf(el), el };
  }
  throw new Error(`no part "${key}"${byName.length > 1 ? " (several parts share that name — use the id)" : ""}. Call read_ui_doc for the part ids.`);
}

/** Model-friendly normalisations before validation. */
function normalizePart(part: Json): Json {
  const out = { ...part };
  if (out.type === "button" && !Array.isArray(out.actions) && isObj(out.action)) {
    out.actions = [out.action];
    delete out.action;
  }
  if (out.type === "choice" && Array.isArray(out.options)) {
    const taken = new Set<string>();
    out.options = (out.options as unknown[]).map((o, i) => {
      if (!isObj(o)) return o;
      let id = typeof o.id === "string" && o.id ? o.id : `opt-${i + 1}`;
      while (taken.has(id)) id = `${id}-${i + 1}`;
      taken.add(id);
      return { ...o, id };
    });
  }
  return out;
}

export interface UiDocEditOutcome {
  ok: boolean;
  error?: string;
  note?: string;
}

/**
 * Apply edit_ui_doc operations to `draft` in place (callers pass a clone).
 * All-or-nothing: on any error the caller discards the draft.
 */
export function applyUiDocOps(draft: WorldDefinition, rawOps: unknown): UiDocEditOutcome {
  if (!Array.isArray(rawOps) || rawOps.length === 0) {
    return { ok: false, error: "edit_ui_doc needs a non-empty 'ops' array." };
  }
  const ops = rawOps as UiDocOp[];

  if (ops.some((o) => isObj(o) && o.op === "detach_to_code")) {
    if (ops.length !== 1) return { ok: false, error: "detach_to_code must be the only op in its call." };
    if (!draft.uiDoc) return { ok: false, error: "This card has no interface document to detach." };
    const rc = draft.rootComponent;
    const baseFile = draft.uiDoc.base?.file;
    delete draft.uiDoc;
    if (rc) {
      const { generatedFrom: _g, ...rest } = rc;
      draft.rootComponent = { ...rest, updatedAt: new Date().toISOString() } as RootComponent;
    }
    return { ok: true, note: `detached: the interface is now plain code (the compiled files are kept${baseFile ? `, base layer "${baseFile}" still imported by index.tsx` : ""}); the visual editor no longer owns it. Edit it with edit_custom_ui.` };
  }

  const notes: string[] = [];
  const created = ensureUiDoc(draft);
  if (created.error) return { ok: false, error: created.error };
  if (created.note) notes.push(created.note);

  const doc = draft.uiDoc!;
  const before = clone(doc);
  const baseline = new Set(schemaErrors(before));
  const resolver = new RefResolver(draft);
  /** Parts this call wrote, with the fields the model sent — checked for typos. */
  const touched = new Map<string, Json>();

  for (let i = 0; i < ops.length; i++) {
    const o = ops[i];
    const label = `op ${i + 1}`;
    try {
      if (!isObj(o) || typeof o.op !== "string") throw new Error(`each op needs an "op" field (one of ${OPS.join(", ")})`);
      const at = `${label} (${o.op})`;
      switch (o.op) {
        case "add_page": {
          const taken = takenIds(doc);
          const id = typeof o.id === "string" && o.id && !taken.has(o.id) ? o.id : mintId("page", taken);
          const name = typeof o.name === "string" && o.name ? o.name : `Page ${doc.pages.length + 1}`;
          const template = o.copyFrom !== undefined ? findPage(doc, o.copyFrom) : undefined;
          const page: UiPage = {
            id, name,
            height: typeof o.height === "number" ? o.height : template?.height ?? 812,
            elements: [],
            ...(template?.desktopHeight ? { desktopHeight: template.desktopHeight } : {}),
            ...(template?.background ? { background: clone(template.background) } : {}),
          };
          if (isObj(o.background)) page.background = resolver.walk(o.background, `${at}.background`) as UiPage["background"];
          doc.pages.push(page);
          notes.push(`page "${id}" added`);
          break;
        }
        case "update_page":
        case "rename_page": {
          const page = findPage(doc, o.page ?? o.id);
          const patch: Json = o.op === "rename_page" ? { name: o.name } : isObj(o.patch) ? o.patch : {};
          for (const [k, v] of Object.entries(patch)) {
            if (k === "elements" || k === "id") throw new Error(`${at}: "${k}" cannot be patched — use the part ops`);
            if (k === "background") {
              if (v === null) delete page.background;
              else page.background = resolver.walk(v, `${at}.background`) as UiPage["background"];
            } else if (v === null) delete (page as unknown as Json)[k];
            else (page as unknown as Json)[k] = v;
          }
          notes.push(`page "${page.id}" updated`);
          break;
        }
        case "remove_page": {
          const page = findPage(doc, o.page ?? o.id);
          if (doc.pages.length === 1) throw new Error(`${at}: cannot remove the only page`);
          doc.pages = doc.pages.filter((p) => p !== page);
          if (doc.entryPageId === page.id) doc.entryPageId = doc.pages[0]!.id;
          for (const id of page.elements.map((e) => e.id)) touched.delete(id);
          notes.push(`page "${page.id}" removed (${page.elements.length} parts with it)`);
          break;
        }
        case "set_entry_page": {
          const before = doc.entryPageId;
          doc.entryPageId = findPage(doc, o.page ?? o.id).id;
          notes.push(`entry page → "${doc.entryPageId}"`);
          // The old first page keeps its own leaveWhen, but it now only fires
          // for a player a button brings there — say so, or the AI tells the
          // creator the old page still hands over to the chat on its own.
          const old = doc.pages.find((p) => p.id === before);
          if (old && old.id !== doc.entryPageId && old.leaveWhen) {
            notes.push(`page "${old.id}" is no longer the first page; its leaveWhen (→ "${old.leaveWhen.pageId}") only applies to a player who reaches it by a go-page button`);
          }
          break;
        }
        case "add_part": {
          if (!isObj(o.part) || typeof o.part.type !== "string") throw new Error(`${at}: "part" must be an object with a "type"`);
          const page = findPage(doc, o.page);
          const taken = takenIds(doc);
          const wanted = typeof o.part.id === "string" ? o.part.id : "";
          const id = wanted && !taken.has(wanted) ? wanted : mintId(o.part.type, taken);
          const input = normalizePart(resolver.walk({ ...o.part }, at) as Json);
          if (input.desktop === "same") delete input.desktop;
          const part = { x: 0, y: 0, w: 375, h: 60, ...input, id } as unknown as UiElement;
          if (typeof o.index === "number") page.elements.splice(Math.max(0, Math.min(page.elements.length, o.index)), 0, part);
          else page.elements.push(part);
          touched.set(id, { ...input, id });
          notes.push(`${part.type} "${id}" added to page "${page.id}"`);
          break;
        }
        case "update_part": {
          if (!isObj(o.patch)) throw new Error(`${at}: "patch" must be an object (JSON merge patch; null removes a field)`);
          const { page, index, el } = findPart(doc, o.id);
          if ("type" in o.patch && o.patch.type !== el.type) throw new Error(`${at}: a part's type cannot change (${el.type} → ${String(o.patch.type)}) — remove_part and add_part instead`);
          if ("id" in o.patch && o.patch.id !== el.id) throw new Error(`${at}: a part's id cannot change`);
          const patch = resolver.walk(o.patch, at) as Json;
          const desktop = patch.desktop;
          const { desktop: _d, ...rest } = patch;
          let next = mergePatch(el, rest) as Json;
          // desktop: null is meaningful (off the wide canvas); "same" = follow the phone box.
          if (desktop === null) next.desktop = null;
          else if (desktop === "same") delete next.desktop;
          else if (desktop !== undefined) next.desktop = mergePatch(isObj(el.desktop) ? el.desktop : { x: el.x, y: el.y, w: el.w, h: el.h }, desktop);
          next = normalizePart(next);
          // Bigger words need a taller box — a text part clips at its box, and
          // the AI cannot see the tops of the letters go. Grow it unless the
          // patch set the height itself.
          let grew = "";
          const unfitted = next;
          if (el.type === "text" && isObj(rest.style) && textStyleAffectsHeight(rest.style)) {
            // A one-line title that outgrew its row widens into free room or
            // wraps (see fitTextBox) — unless the patch set that itself.
            const fitted = fitTextBox(next as unknown as UiElement, page) as unknown as Json;
            next = { ...next };
            const fittedStyle = isObj(fitted.style) ? fitted.style : {};
            if (!("nowrap" in rest.style) && isObj(next.style) && next.style.nowrap === true && fittedStyle.nowrap === false) {
              next.style = { ...next.style, nowrap: false };
              grew = " (the title no longer fit on one line, so it wraps now)";
            }
            if (!("w" in rest) && !("x" in rest) && (fitted.w !== next.w || fitted.x !== next.x)) { next.x = fitted.x; next.w = fitted.w; }
            if (!("h" in rest) && fitted.h !== next.h) { next.h = fitted.h; grew ||= ` (box grew to h ${String(fitted.h)} to fit the text)`; }
            if (!(isObj(desktop) && ("h" in desktop || "w" in desktop)) && isObj(next.desktop) && isObj(fitted.desktop)
              && (fitted.desktop.h !== next.desktop.h || fitted.desktop.w !== next.desktop.w)) {
              next.desktop = fitted.desktop;
              grew ||= " (desktop box grew to fit the text)";
            }
          }
          page.elements[index] = next as unknown as UiElement;
          // The box grew, so what sits under it moves down by as much, on each
          // canvas — the AI would otherwise leave the bigger title on the
          // subtitle. A move the patch asked for itself is not a growth.
          if (next !== unfitted) {
            const settled = pushBelowGrown(page, unfitted as unknown as UiElement);
            if (settled !== page) {
              const movedIds = settled.elements
                .filter((e, i) => e.id !== el.id && e !== page.elements[i])
                .map((e) => e.id);
              page.elements = settled.elements;
              if (movedIds.length) grew += ` (moved down to make room: ${movedIds.join(", ")})`;
            }
          }
          const prior = touched.get(el.id);
          touched.set(el.id, prior ? (mergePatch(prior, patch) as Json) : { ...patch, type: el.type });
          notes.push(`"${el.id}" updated${grew}`);
          break;
        }
        case "remove_part": {
          const { page, el } = findPart(doc, o.id);
          page.elements = page.elements.filter((e) => e !== el);
          touched.delete(el.id);
          const siblings = el.group ? page.elements.filter((e) => e.group === el.group).map((e) => e.id) : [];
          notes.push(`"${el.id}" removed${siblings.length ? ` (same group "${el.group}" still has: ${siblings.join(", ")} — remove them too if they belong to it)` : ""}`);
          break;
        }
        case "move_part": {
          const { page, el } = findPart(doc, o.id);
          const target = findPage(doc, o.to_page ?? o.page);
          if (target !== page) {
            page.elements = page.elements.filter((e) => e !== el);
            target.elements.push(el);
          }
          notes.push(`"${el.id}" → page "${target.id}"`);
          break;
        }
        case "reorder": {
          const { page, el } = findPart(doc, o.id);
          const zs = page.elements.map((e) => e.z ?? 0);
          const to = o.to;
          let z: number;
          if (typeof o.z === "number") z = o.z;
          else if (to === "front") z = Math.max(...zs) + 1;
          else if (to === "back") z = Math.min(...zs) - 1;
          else if (to === "forward") z = (el.z ?? 0) + 1;
          else if (to === "backward") z = (el.z ?? 0) - 1;
          else throw new Error(`${at}: give "z" (number) or "to": "front" | "back" | "forward" | "backward"`);
          el.z = z;
          notes.push(`"${el.id}" z=${z}`);
          break;
        }
        case "apply_look": {
          const { page, index, el } = findPart(doc, o.id);
          const look = getUiLook(String(o.look ?? ""));
          const part = uiLookPartOf(el as UiElement & { card?: unknown });
          if (!part) throw new Error(`${at}: "${el.id}" is a ${el.type}${el.type === "list" ? " without card rows" : ""} — looks exist for choice, field, popup, button and card lists`);
          const offered = UI_LOOKS.filter((l) => l.part === part).map((l) => l.id);
          if (!look || look.part !== part) throw new Error(`${at}: no ${part} look "${String(o.look)}". Looks for ${part}: ${offered.join(", ")}`);
          page.elements[index] = applyUiLook(el, look.id);
          notes.push(`"${el.id}" → look ${look.id}`);
          break;
        }
        case "set_theme": {
          const current = doc.theme ?? {};
          let theme: Json = clone(current) as Json;
          if (o.preset !== undefined) {
            if (o.preset === null) {
              theme = {};
            } else {
              const choice = isObj(o.preset) ? o.preset : { id: o.preset };
              if (!getUiThemePreset(String(choice.id))) {
                throw new Error(`${at}: no theme preset "${String(choice.id)}". Presets: ${UI_THEMES.map((t) => `${t.id} (accents ${t.accents.join(" ")})`).join("; ")}`);
              }
              const built = buildUiTheme(choice as unknown as Parameters<typeof buildUiTheme>[0]);
              theme = { ...(built as unknown as Json) };
            }
            // Fonts and free CSS belong to the card, not to whichever preset is on it.
            if (current.fonts) theme.fonts = current.fonts;
            if (current.css) theme.css = current.css;
          }
          if (isObj(o.tokens)) {
            const tokens: Json = { ...(isObj(theme.tokens) ? theme.tokens : {}) };
            for (const [k, v] of Object.entries(o.tokens)) {
              const key = k.startsWith("--") ? k : `--${k}`;
              if (v === null) delete tokens[key];
              else tokens[key] = String(v);
            }
            theme.tokens = tokens;
          }
          if (o.fonts !== undefined) theme.fonts = o.fonts === null ? undefined : o.fonts;
          if (o.css !== undefined) theme.css = o.css === null ? undefined : o.css;
          for (const k of Object.keys(theme)) if (theme[k] === undefined) delete theme[k];
          if (Object.keys(theme).length) doc.theme = theme as UiDoc["theme"];
          else delete doc.theme;
          notes.push("theme updated");
          // Say which inks would not read on their surfaces: the compiler
          // fixes them on draw, but the assistant should send real pairs.
          const set = isObj(theme.tokens) ? (theme.tokens as Record<string, string>) : undefined;
          const preset = isObj(theme.preset) ? (theme.preset as unknown as Parameters<typeof buildUiTheme>[0]) : undefined;
          const drawn = readableThemeTokens(set, preset ? buildUiTheme(preset)?.tokens : undefined);
          if (set && drawn && drawn !== set) {
            const fixed = Object.keys(drawn).filter((k) => drawn[k] !== set[k]).map((k) => `${k} ${set[k] ?? "(unset)"}→${drawn[k]}`);
            notes.push(`contrast: ${fixed.join(", ")} — those inks were below 4.5:1 on their surfaces and are drawn darker/lighter. Send the full palette (each surface with its ink) so it looks designed.`);
          }
          break;
        }
        default:
          throw new Error(`${label}: unknown op "${String(o.op)}". Ops: ${OPS.join(", ")}`);
      }
    } catch (e) {
      return { ok: false, error: `${label}: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  // Schema: only errors this call introduced (a doc the editor saved with an
  // old quirk must not block every future edit).
  const errors = schemaErrors(doc).filter((e) => !baseline.has(e));
  // Typos: keys the model sent on a touched part that the schema would drop.
  const parsed = uiDocSchema.safeParse(doc);
  if (parsed.success) {
    for (const [id, sent] of touched) {
      const hit = allElements(parsed.data as unknown as UiDoc).find(({ el }) => el.id === id);
      if (!hit) continue;
      const dropped: string[] = [];
      droppedKeys(sent, hit.el, "", dropped);
      if (dropped.length) errors.push(`part "${id}" (${hit.el.type}): unknown field(s) ${dropped.map((d) => `"${d}"`).join(", ")} — not part of the ${hit.el.type} shape (see the ui-doc skill)`);
    }
  }
  for (const id of touched.keys()) {
    const hit = allElements(doc).find(({ el }) => el.id === id);
    if (hit) errors.push(...referenceErrors(doc, hit.el, draft));
  }
  if (errors.length) {
    return { ok: false, error: `The interface document would be invalid — nothing was applied. Fix and resend the whole call:\n- ${errors.slice(0, 12).join("\n- ")}` };
  }

  try {
    // Opening steps that name their opening are recounted against the card's
    // current openings, the same as the editor does on every change.
    const synced = syncGreetingActions(doc, new PromptBuilder().buildGreetingEntries(draft).map((e) => e.id));
    if (synced !== doc) draft.uiDoc = synced;
    draft.rootComponent = compileUiDocInto(synced, draft.rootComponent);
  } catch (e) {
    return { ok: false, error: `The document is valid but failed to compile: ${e instanceof Error ? e.message : "unknown error"}` };
  }
  // Message rules are also instructions to the AI: the 「界面约定」 lorebook
  // entry follows them, exactly as it does when the creator edits them.
  const entries = syncMessageRulesEntry(draft.entries ?? [], doc, draft.language);
  if (entries !== draft.entries) {
    const isRules = (e: { id: string; tags?: string[] }) => e.id === UI_RULES_ENTRY_ID || !!e.tags?.includes("ui-rules");
    const had = (draft.entries ?? []).some(isRules);
    const has = entries.some(isRules);
    draft.entries = entries;
    notes.push(!had && has ? "lorebook entry 界面约定 created (teaches the AI the message rules)" : has ? "界面约定 entry updated" : "界面约定 entry removed (no rules left)");
  }
  if (resolver.notes.length) notes.push(`resolved ${[...new Set(resolver.notes)].join(", ")}`);
  return { ok: true, note: notes.join("; ") };
}

// ── read_ui_doc ──

function boxText(el: UiElement): string {
  const phone = `(${el.x},${el.y} ${el.w}×${el.h})`;
  const desk = el.desktop === null ? " desktop:hidden"
    : el.desktop ? ` desktop(${el.desktop.x},${el.desktop.y} ${el.desktop.w}×${el.desktop.h})` : "";
  return `${phone}${desk}${el.z !== undefined ? ` z${el.z}` : ""}`;
}

function actionsText(actions: unknown): string {
  if (!Array.isArray(actions) || actions.length === 0) return "";
  return actions.map((a) => {
    if (!isObj(a)) return "?";
    switch (a.kind) {
      case "set-variable": return `set ${a.variableId} ${a.op}${a.value !== undefined ? ` ${JSON.stringify(a.value)}` : ""}`;
      case "send-message": return `send "${short(String((a.text as Json | undefined)?.template ?? ""), 30)}"`;
      case "go-page": return `go ${a.pageId}`;
      case "switch-greeting": return `opening #${a.index}`;
      case "random": return Array.isArray(a.from) && a.from.length
        ? `random ${a.variableId} from ${a.from.length}`
        : `random ${a.variableId} ${a.min ?? 1}..${a.max ?? 20}`;
      case "play-audio": return `play ${a.trackId}`;
      case "toast": return `toast "${short(String((a.text as Json | undefined)?.template ?? ""), 20)}"`;
      case "run-behavior": return `behavior ${a.actionId}`;
      default: return String(a.kind);
    }
  }).join(" → ");
}

function srcText(src: unknown): string {
  if (!isObj(src)) return "";
  return src.kind === "variable" ? `var:${src.variableId}` : String(src.ref || "(unbound)");
}

function partSummary(el: UiElement): string {
  const e = el as unknown as Json;
  const bits: string[] = [];
  const tpl = (v: unknown) => `"${short(String((v as Json | undefined)?.template ?? ""))}"`;
  switch (el.type) {
    case "text": bits.push(tpl(e.text)); break;
    case "image": bits.push(srcText(e.src)); break;
    case "meter": {
      const num = (v: unknown) => (isObj(v) ? (v.kind === "variable" ? `var:${v.variableId}` : String(v.value)) : "?");
      bits.push(`${num(e.value)} in [${num(e.min)}, ${num(e.max)}]`);
      break;
    }
    case "button":
      bits.push(tpl(e.label));
      if (e.actions) bits.push(`does: ${actionsText(e.actions)}`);
      if (Array.isArray(e.requires) && e.requires.length) bits.push(`requires: ${e.requires.join(", ")}`);
      break;
    case "choice": {
      const opts = Array.isArray(e.options) ? (e.options as Json[]) : [];
      bits.push(`${e.layout}${e.multi ? " multi" : ""}${e.variableId ? ` → var:${e.variableId}` : ""}${e.confirm ? " +confirm" : ""}`);
      bits.push(`options: ${opts.slice(0, 8).map((o) => `${o.id}="${short(String(o.title ?? ""), 20)}"${o.actions ? ` [${actionsText(o.actions)}]` : ""}`).join(", ")}${opts.length > 8 ? ` +${opts.length - 8}` : ""}`);
      break;
    }
    case "field": bits.push(`${e.kind} → var:${e.variableId}${e.label ? ` label ${tpl(e.label)}` : ""}`); break;
    case "popup": bits.push(`while var:${e.variableId}${e.title ? ` title ${tpl(e.title)}` : ""}`); break;
    case "list": {
      const src = e.source as Json | undefined;
      bits.push(src?.kind === "variable" ? `rows from var:${src.variableId}`
        : src?.kind === "entries" ? `rows from the card's entries (${src.folderId ? `folder ${src.folderId}` : `role ${src.role ?? "character"}`}; item.title/body/image)`
        : `${Array.isArray(src?.items) ? src!.items.length : 0} static rows`);
      bits.push(`item ${tpl(e.item)}`);
      const card = e.card as Json | undefined;
      if (card) bits.push(`card${isObj(card.lockedUnless) ? ` locked-unless var:${card.lockedUnless.variableId}.${card.lockedUnless.field}` : ""}`);
      if (e.rowActions) bits.push(`row does: ${actionsText(e.rowActions)}`);
      break;
    }
    case "custom": bits.push(`TSX ${String(e.code ?? "").length} chars`); break;
    case "chat":
    case "messages": {
      if (isObj(e.messageStyle)) bits.push(`messageStyle{${Object.keys(e.messageStyle).join(",")}}`);
      const rules = Array.isArray(e.rules) ? (e.rules as Json[]) : [];
      if (rules.length) {
        bits.push(`rules: ${rules.map((r) => {
          const m: Json = isObj(r.match) ? r.match : {};
          const how = m.kind === "wrap" ? `${m.open}…${m.close}` : m.kind === "line-prefix" ? `line ${m.prefix}…` : m.kind === "contains" ? `"${m.text}"` : `/${short(String(m.pattern ?? ""), 24)}/`;
          return `${r.id}="${short(String(r.name ?? ""), 16)}" ${how}→${r.show}${r.enabled === false ? " (off)" : ""}`;
        }).join(", ")}`);
      }
      break;
    }
    default: break;
  }
  const styleKeys = ["style", "itemStyle", "textStyle"].flatMap((k) => (isObj(e[k]) ? [`${k}{${Object.keys(e[k] as Json).join(",")}}`] : []));
  if (styleKeys.length) bits.push(styleKeys.join(" "));
  if (isObj(e.visibleWhen)) bits.push(`only when ${e.visibleWhen.variableId} ${e.visibleWhen.operator} ${JSON.stringify(e.visibleWhen.value)}`);
  const look = currentUiLook(el);
  if (look) bits.push(`look ${look}`);
  if (e.css) bits.push(`css ${String(e.css).length} chars`);
  if (e.group) bits.push(`group ${e.group}`);
  return bits.join(" · ");
}

function variableLine(v: Variable): string {
  const def = v.defaultValue === undefined ? "" : ` = ${short(JSON.stringify(v.defaultValue), 30)}`;
  return `  ${v.id} "${v.name}" ${v.type}${def}`;
}

export function executeReadUiDoc(world: WorldDefinition, args: { page?: unknown; parts?: unknown }): Record<string, unknown> {
  const lines: string[] = [];
  const doc = world.uiDoc;
  if (!doc) {
    const handwritten = world.rootComponent && !isShell(world.rootComponent);
    lines.push(`NO INTERFACE DOCUMENT YET. edit_ui_doc creates one on first use: ${handwritten
      ? "this card's hand-written frontend will be kept as the document's base layer (parts overlay it)."
      : "the platform chat stays underneath (surface: chat) and parts overlay it."}`);
  } else {
    lines.push(`INTERFACE DOCUMENT — entry page: ${doc.entryPageId}${doc.surface ? `; underneath: platform chat` : ""}${doc.base ? `; base layer: ${doc.base.file}${doc.base.groups?.length ? " (knobs: set_ui_knobs)" : ""}` : ""}`);
    const theme = doc.theme;
    if (theme) {
      const p = theme.preset;
      lines.push(`THEME: ${p ? `preset ${p.id} accent ${p.accent} font ${p.font} radius ${p.radius}; ` : ""}${Object.keys(theme.tokens ?? {}).length} tokens${theme.fonts?.length ? `; fonts ${theme.fonts.map((f) => f.family).join(", ")}` : ""}${theme.css ? `; css ${theme.css.length} chars` : ""}`);
    }
    const onlyPage = typeof args.page === "string" && args.page ? args.page : null;
    for (const page of doc.pages) {
      if (onlyPage && page.id !== onlyPage && page.name !== onlyPage) continue;
      const bg = page.background ? (page.background.kind === "color" ? ` bg ${page.background.color}` : ` bg image ${srcText(page.background.src)}`) : "";
      lines.push(`PAGE ${page.id} "${page.name}" 375×${page.height}${page.desktopHeight ? ` desktop 1024×${page.desktopHeight}` : ""}${bg} — ${page.elements.length} parts`);
      for (const el of page.elements) {
        lines.push(`  ${el.id} [${el.type}]${el.name ? ` "${el.name}"` : ""} ${boxText(el)} · ${partSummary(el)}`);
      }
    }
  }
  const vars = world.variables ?? [];
  lines.push(`VARIABLES (${vars.length}) — parts reference variables by id:`);
  for (const v of vars.slice(0, 80)) lines.push(variableLine(v));
  if (vars.length > 80) lines.push(`  … +${vars.length - 80} more`);
  const greetings = new PromptBuilder().buildGreetingEntries(world);
  lines.push(`OPENINGS (switch-greeting index): ${greetings.length ? greetings.map((g, i) => `#${i} "${short(g.name || g.content, 30)}"`).join(", ") : "(none)"}`);
  if ((world.audioTracks ?? []).length) lines.push(`AUDIO (play-audio trackId): ${world.audioTracks.map((t) => `${t.id} "${t.name}"`).join(", ")}`);
  // A button sets off a behaviour by the actionId the behaviour listens for.
  const buttonBehaviors = (world.reactions ?? []).flatMap((r) => {
    const id = r.when?.eventType === "action:fired" ? r.when.match?.actionId?.value : undefined;
    return typeof id === "string" && id ? [`${id} "${r.name}"`] : [];
  });
  lines.push(`BUTTON BEHAVIORS (run-behavior actionId): ${buttonBehaviors.length ? buttonBehaviors.join(", ") : "(none: write a behavior with when action:fired + match.actionId first)"}`);
  lines.push(`THEME PRESETS: ${UI_THEMES.map((t) => `${t.id} (accents ${t.accents.join(" ")})`).join("; ")}`);
  lines.push(`LOOKS (apply_look): ${(["choice", "field", "popup", "list", "button"] as const).map((part) => `${part}: ${UI_LOOKS.filter((l) => l.part === part).map((l) => `${l.id} "${l.name.zh}"`).join(", ")}`).join(" | ")}`);

  const result: Record<string, unknown> = { summary: lines.join("\n") };
  if (Array.isArray(args.parts) && args.parts.length && doc) {
    const full: Record<string, unknown> = {};
    for (const id of args.parts) {
      const hit = allElements(doc).find(({ el }) => el.id === id || el.name === id);
      full[String(id)] = hit ? { page: hit.page.id, ...hit.el } : null;
    }
    result.parts = full;
  }
  return result;
}
