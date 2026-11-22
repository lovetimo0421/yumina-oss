/**
 * Localize the player-visible text of a card's TSX interface without touching its logic.
 *
 * The model rewrites a whole file; we accept the result only if, after removing every
 * string / template / JSX-text token (and `+`, since "day " + n may become "第" + n + "天"),
 * the token stream is identical, and every literal in a logic position (comparison,
 * case, import, key-like property, className, index) survives unchanged.
 */
import { parse } from "@babel/parser";

export type LiteralRole = "compare" | "import" | "key" | "display" | "other";
export interface TsxLiteral {
  text: string; role: LiteralRole; start: number; end: number; nodeType: string; inCode: boolean;
  /** Set for a value inside a string table: the table's name, and the language key it sits under in a per-language table. */
  table?: { name: string; lang?: string };
}

// ---------------------------------------------------------------------------
// String tables: `const STR = { ui: { begin: "Begin", ... }, ... }` or `const T = { en: {...}, zh: {...} }`,
// where a card keeps every player-visible text and reads it as STR.ui.begin / T[LANG].begin. Their values sit
// under keys like `name` that elsewhere mark lookups, so they were frozen as keys and the table stayed English.

const TABLE_NAME = /^(?:STR|STRS|STRINGS?|TEXTS?|TXT|I18N|L10N|LOCALES?|MESSAGES|MSGS?|COPY|LABELS|DICT|DICTIONARY|TRANSLATIONS?|UI_?(?:TEXT|STR|STRINGS)\w*|[A-Z]{2}_(?:STR|TEXTS?|STRINGS)|EN|ZH|ES|KO|ID|RU|JA)$/i;
const LANG_KEY = /^(?:en|zh|es|ko|id|ru|ja|fr|de|pt|it|vi|th|cn|zh[-_](?:cn|tw|hans|hant)|en[-_](?:us|gb)|pt[-_]br)$/i;
/** Fields inside a string table that still hold ids, not text. (`name` is text in a table.) */
const TABLE_KEY_PROPS = /^(k|key|id|value|type|kind|state|mode|variant|slot|tone|icon|cls|class|className|ref|tag|href|src|as|lang|locale|font|fonts|color|img|image|asset|url)$/i;
const LANG_CONST = /^(?:LANG|LANGUAGE|LOCALE|CARD_LANG|UI_LANG)$/;

const unwrapTs = (n: any): any => (n && (n.type === "TSAsExpression" || n.type === "TSSatisfiesExpression" || n.type === "TSTypeAssertion" || n.type === "TSNonNullExpression") ? unwrapTs(n.expression) : n);

/** Only literals all the way down (no functions, identifiers, spreads or computed keys); counts its strings. */
function pureData(n: any, count: { strings: number }): boolean {
  n = unwrapTs(n);
  if (!n) return false;
  switch (n.type) {
    case "StringLiteral": count.strings++; return true;
    case "NumericLiteral": case "BooleanLiteral": case "NullLiteral": return true;
    case "TemplateLiteral": if (n.expressions.length) return false; count.strings++; return true;
    case "UnaryExpression": return n.operator === "-" && n.argument?.type === "NumericLiteral";
    case "ArrayExpression": return n.elements.every((e: any) => e && pureData(e, count));
    case "ObjectExpression": return n.properties.every((p: any) => p.type === "ObjectProperty" && !p.computed && pureData(p.value, count));
    default: return false;
  }
}

const propKey = (p: any): string | null => p?.key?.type === "Identifier" ? p.key.name : p?.key?.type === "StringLiteral" ? p.key.value : null;

export interface StringTable { name: string; start: number; end: number; /** Top-level language keys when the table holds one sub-table per language. */ langs: string[] }

/** String tables declared in a parsed program. */
export function stringTables(program: any): StringTable[] {
  const out: StringTable[] = [];
  const visit = (node: any) => {
    if (!node || typeof node.type !== "string") return;
    if (node.type === "VariableDeclarator" && node.id?.type === "Identifier") {
      const init = unwrapTs(node.init);
      const count = { strings: 0 };
      if (init?.type === "ObjectExpression" && pureData(init, count) && count.strings >= 6) {
        const keys = init.properties.map(propKey).filter((k: string | null): k is string => !!k);
        const langKeyed = keys.length >= 2 && keys.every((k: string) => LANG_KEY.test(k)) && init.properties.every((p: any) => unwrapTs(p.value)?.type === "ObjectExpression");
        // Named as a string table, or one sub-table per language. A data table (characters, places) is not one:
        // its `name` fields are what the code looks things up by.
        if (langKeyed || TABLE_NAME.test(node.id.name)) {
          out.push({ name: node.id.name, start: init.start, end: init.end, langs: langKeyed ? keys : [] });
          return;
        }
      }
    }
    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "start" || key === "end" || key === "extra" || key === "tokens" || key === "comments") continue;
      const v = node[key];
      if (Array.isArray(v)) v.forEach(visit); else if (v && typeof v === "object" && typeof v.type === "string") visit(v);
    }
  };
  visit(program);
  return out;
}

// ---------------------------------------------------------------------------
// Class names. `className={"dmm-pin" + (isHere ? " here" : "")}` holds " here", a modifier the stylesheet
// matches, not a word: the string pass saw a leading space and a word and translated it (DanMachi, Russian,
// 2026-11-21: 31 modifiers, " here" -> " здесь", so map pins, floor states, the rite overlay and settings lost
// their styles). A literal is a class name when the value it flows into is one: a className / class / style
// attribute, a className or cls field, a variable named like a class list or later used as one
// (`var cls = "dm-fl" + (f === here ? " here" : ""); ... className={cls}`), clsx/cn arguments, classList calls,
// CSS selectors (querySelector, closest), and a helper whose result is used as a className.

const CLASS_ATTRS = /^(className|class|style)$/;
const CLASS_FIELDS = /^(className|class|cls|classes|classList)$/;
const CLASS_VAR = /^(cls|cx|klass|classes|className|classNames|classList|\w*(?:Cls|Class|ClassName|Classes|ClassList))$/;
const CLASS_FNS = new Set(["clsx", "cn", "cx", "classNames", "classnames", "twMerge", "twJoin"]);
const CLASSLIST_METHODS = new Set(["add", "remove", "toggle", "replace", "contains"]);
const SELECTOR_METHODS = new Set(["querySelector", "querySelectorAll", "closest", "matches", "getElementsByClassName"]);
/** Methods a class list passes through on its way into className: ["a", on && "b"].filter(Boolean).join(" "). */
const CHAIN_METHODS = new Set(["join", "filter", "concat", "trim", "toLowerCase", "replace"]);

/** Start offsets of every string / template piece that ends up in a class name, a style value or a CSS selector. */
export function classLiteralStarts(program: any): Set<number> {
  const out = new Set<number>();
  const idents = new Set<string>(), fns = new Set<string>();
  const roots: Array<{ node: any; style: boolean }> = [];
  const nameOf = (n: any): string | null => n?.type === "Identifier" ? n.name : n?.type === "JSXIdentifier" ? n.name : null;
  // Follow a value down to the literals it is made of; identifiers and helper calls it uses are class values too.
  const take = (n: any, style: boolean): void => {
    n = unwrapTs(n);
    if (!n) return;
    switch (n.type) {
      case "StringLiteral": out.add(n.start); return;
      case "TemplateLiteral": n.quasis.forEach((q: any) => out.add(q.start)); n.expressions.forEach((e: any) => take(e, style)); return;
      case "BinaryExpression": if (n.operator === "+") { take(n.left, style); take(n.right, style); } return;
      case "ConditionalExpression": take(n.consequent, style); take(n.alternate, style); return;
      case "LogicalExpression": if (n.operator !== "&&") take(n.left, style); take(n.right, style); return;
      case "ParenthesizedExpression": case "JSXExpressionContainer": take(n.expression, style); return;
      case "ArrayExpression": n.elements.forEach((e: any) => take(e, style)); return;
      case "ObjectExpression": if (style) n.properties.forEach((p: any) => p.type === "ObjectProperty" && take(p.value, style)); return;
      case "Identifier": idents.add(n.name); return;
      case "CallExpression": {
        const c = n.callee;
        if (c?.type === "Identifier") { if (CLASS_FNS.has(c.name)) n.arguments.forEach((a: any) => take(a, false)); else fns.add(c.name); return; }
        if (c?.type === "MemberExpression" && CHAIN_METHODS.has(c.property?.name)) { take(c.object, style); n.arguments.forEach((a: any) => take(a, style)); }
        return;
      }
      default: return;
    }
  };
  const findRoots = (node: any, parent: any) => {
    if (!node || typeof node.type !== "string") return;
    switch (node.type) {
      case "JSXAttribute": { const a = nameOf(node.name); if (a && CLASS_ATTRS.test(a) && node.value) roots.push({ node: node.value, style: a === "style" }); break; }
      case "ObjectProperty": { const k = propKey(node); if (!node.computed && k && CLASS_FIELDS.test(k)) roots.push({ node: node.value, style: false }); break; }
      case "VariableDeclarator": if (node.id?.type === "Identifier" && node.init && (CLASS_VAR.test(node.id.name) || idents.has(node.id.name))) roots.push({ node: node.init, style: false }); break;
      case "AssignmentExpression": {
        const l = node.left;
        if ((l?.type === "Identifier" && (CLASS_VAR.test(l.name) || idents.has(l.name))) || (l?.type === "MemberExpression" && /^(className|cssText)$/.test(l.property?.name ?? ""))) roots.push({ node: node.right, style: false });
        break;
      }
      case "CallExpression": {
        const c = node.callee;
        if (c?.type === "Identifier" && CLASS_FNS.has(c.name)) node.arguments.forEach((a: any) => roots.push({ node: a, style: false }));
        else if (c?.type === "MemberExpression" && CLASSLIST_METHODS.has(c.property?.name) && c.object?.type === "MemberExpression" && c.object.property?.name === "classList") (c.property.name === "toggle" ? node.arguments.slice(0, 1) : node.arguments).forEach((a: any) => roots.push({ node: a, style: false }));
        else if (c?.type === "MemberExpression" && SELECTOR_METHODS.has(c.property?.name) && node.arguments[0]) roots.push({ node: node.arguments[0], style: false });
        break;
      }
      case "FunctionDeclaration": case "FunctionExpression": case "ArrowFunctionExpression": {
        const name = node.id?.name ?? (parent?.type === "VariableDeclarator" && parent.id?.type === "Identifier" ? parent.id.name : null);
        if (name && (CLASS_VAR.test(name) || fns.has(name))) {
          if (node.body?.type !== "BlockStatement") roots.push({ node: node.body, style: false });
          else { const ret = (n: any): void => { if (!n || typeof n.type !== "string" || (n !== node.body && /Function/.test(n.type))) return; if (n.type === "ReturnStatement" && n.argument) roots.push({ node: n.argument, style: false }); for (const k of Object.keys(n)) { if (k === "loc" || k === "start" || k === "end" || k === "extra") continue; const v = n[k]; if (Array.isArray(v)) v.forEach(ret); else if (v && typeof v === "object" && typeof v.type === "string") ret(v); } }; ret(node.body); }
        }
        break;
      }
    }
    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "start" || key === "end" || key === "extra" || key === "tokens" || key === "comments") continue;
      const v = node[key];
      if (Array.isArray(v)) v.forEach((c) => findRoots(c, node)); else if (v && typeof v === "object" && typeof v.type === "string") findRoots(v, node);
    }
  };
  // A variable or helper is known to be a class list only once a className has used it: repeat until nothing new.
  for (let round = 0; round < 4; round++) {
    const before = idents.size + fns.size;
    roots.length = 0;
    findRoots(program, null);
    for (const r of roots) take(r.node, r.style);
    if (idents.size + fns.size === before) break;
  }
  return out;
}

/** CSS rules in a string (`.dm-x { color: red }`, `@keyframes`): style code, not text. */
const looksLikeCss = (text: string) => /[.#@]?[\w-]+[^{}\n]*\{[^{}]*:[^{}]*\}/.test(text) || /^\s*@(?:keyframes|media|font-face|import)\b/.test(text);

const KEY_PROPS = /^(k|key|id|value|type|kind|state|mode|variant|slot|tone|icon|cls|class|className|ref|name|tag|href|src|as)$/i;
const SCAN_METHODS = new Set(["includes", "startsWith", "endsWith", "indexOf", "lastIndexOf", "has"]);
const KEY_ATTRS = /^(className|class|id|key|style|href|src|d|viewBox|fill|stroke|type|role|name|ref|data-.*|xmlns.*|points|transform|for|htmlFor)$/;

function parseTsx(code: string) {
  return parse(code, { sourceType: "module", plugins: ["jsx", "typescript"], tokens: true, errorRecovery: false });
}

/** Token labels for everything except literal text and `+`. */
export function codeSkeleton(code: string): string[] {
  const ast = parseTsx(code) as unknown as { tokens: Array<{ type: { label: string } | string; value?: unknown }> };
  const out: string[] = [];
  for (const t of ast.tokens) {
    const label = typeof t.type === "string" ? t.type : t.type.label;
    if (label === "string" || label === "template" || label === "jsxText" || label === "+/-" && t.value === "+") continue;
    if (label === "CommentLine" || label === "CommentBlock") continue;
    out.push(t.value != null && typeof t.value !== "object" ? `${label}:${String(t.value)}` : label);
  }
  return out;
}

/** Every literal with the role its position gives it. */
export function tsxLiterals(code: string): TsxLiteral[] {
  const ast = parseTsx(code);
  const out: TsxLiteral[] = [];
  const tables = stringTables(ast.program);
  const classes = classLiteralStarts(ast.program);
  // table: the string table this node sits in; lang: the per-language key above it; field: the nearest property name.
  type Ctx = { table?: StringTable; lang?: string; field?: string };
  const visit = (node: any, parent: any, grand: any, ctx: Ctx) => {
    if (!node || typeof node.type !== "string") return;
    if (!ctx.table) { const t = tables.find((x) => x.start === node.start && x.end === node.end); if (t) ctx = { table: t }; }
    if (node.type === "StringLiteral" || node.type === "TemplateElement" || node.type === "JSXText") {
      const text = node.type === "TemplateElement" ? node.value.cooked ?? node.value.raw : node.type === "JSXText" ? node.value.trim() : node.value;
      if (node.type === "JSXText" && !text) return;
      let role = roleOf(node, parent, grand);
      // In a string table every value is text the player reads, except id-like fields; keys stay keys.
      if (ctx.table && !(parent?.type === "ObjectProperty" && parent.key === node)) role = ctx.field && TABLE_KEY_PROPS.test(ctx.field) ? "key" : "display";
      // A class name, style value or selector is matched by the stylesheet, wherever it sits.
      if (classes.has(node.start) || (node.type !== "JSXText" && looksLikeCss(text))) role = "key";
      // inCode: a string sitting inside a JS expression (data the code may look up); JSX text never is.
      out.push({ text, role, start: node.start, end: node.end, nodeType: node.type, inCode: node.type !== "JSXText", ...(ctx.table ? { table: { name: ctx.table.name, ...(ctx.lang ? { lang: ctx.lang } : {}) } } : {}) });
      return;
    }
    let next = ctx;
    if (ctx.table && node.type === "ObjectProperty") {
      const k = propKey(node) ?? undefined;
      const top = ctx.table.langs.length && !ctx.lang && parent && parent.start === ctx.table.start && parent.end === ctx.table.end;
      next = { ...ctx, ...(top ? { lang: k } : {}), field: k };
    }
    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "start" || key === "end" || key === "extra" || key === "tokens" || key === "comments") continue;
      const v = node[key];
      if (Array.isArray(v)) v.forEach((c) => visit(c, node, parent, next));
      else if (v && typeof v === "object" && typeof v.type === "string") visit(v, node, parent, next);
    }
  };
  visit(ast.program, null, null, {});
  return out;
}

function roleOf(node: any, parent: any, grand: any): LiteralRole {
  if (node.type === "JSXText") return "display";
  if (!parent) return "other";
  if (parent.type === "BinaryExpression" && ["===", "!==", "==", "!="].includes(parent.operator)) return "compare";
  if (parent.type === "SwitchCase") return "compare";
  // scene.indexOf("Bath"), recent.includes("Critical"), set.has("Lobby"): a scan for a value is a comparison too.
  if (parent.type === "CallExpression" && parent.callee?.type === "MemberExpression" && SCAN_METHODS.has(parent.callee.property?.name) && parent.arguments?.[0] === node) return "compare";
  if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration", "ImportExpression"].includes(parent.type)) return "import";
  if (parent.type === "CallExpression" && parent.callee?.type === "Import") return "import";
  if ((parent.type === "ObjectProperty" || parent.type === "TSPropertySignature") && parent.key === node) return "key";
  if (parent.type === "ObjectProperty" && parent.value === node) {
    const name = parent.key?.name ?? parent.key?.value ?? "";
    return KEY_PROPS.test(String(name)) ? "key" : "display";
  }
  if (parent.type === "MemberExpression" && parent.property === node) return "key";
  if (parent.type === "TSLiteralType") return "key";
  const attr = parent.type === "JSXAttribute" ? parent : parent.type === "JSXExpressionContainer" && grand?.type === "JSXAttribute" ? grand : null;
  if (attr) {
    const name = attr.name?.name?.name ?? attr.name?.name ?? "";
    return KEY_ATTRS.test(String(name)) ? "key" : "display";
  }
  if (parent.type === "TemplateLiteral" && grand?.type === "TaggedTemplateExpression") return "key"; // css`` etc.
  if (parent.type === "TemplateLiteral" && grand?.type === "JSXExpressionContainer") {
    return "other";
  }
  return "other";
}

/** Does this file show the player any prose? Only those files are sent to the model. */
export function hasVisibleProse(code: string, sourceLang: "en" | "zh" | "es" | "ko" | "id" | "ru"): boolean {
  let lits: TsxLiteral[];
  try { lits = tsxLiterals(code); } catch { return false; }
  return lits.some((l) => (l.role === "display" || l.role === "other") && isProse(l.text, sourceLang));
}

function isProse(text: string, lang: "en" | "zh" | "es" | "ko" | "id" | "ru"): boolean {
  if (lang === "zh") return /[一-鿿]{2,}/.test(text);
  if (lang === "ko") return /[가-힣]{2,}/.test(text);
  if (lang === "ru") return /[Ѐ-ӿ]{2,}/.test(text);
  if (/^[a-z0-9]+(-[a-z0-9]+)*( [a-z0-9]+(-[a-z0-9]+)*)*$/.test(text) && /-/.test(text)) return false; // class lists
  if (/^[#./@:]|^https?:|^\w+\.\w+$/.test(text)) return false;
  if (looksLikeCss(text)) return false;
  return /[A-Za-zÀ-ÿ]{3,}/.test(text) && (/\s/.test(text) || /^[A-Z][a-zà-ÿ]+[.!?…]?$/.test(text));
}

/**
 * Validate a model rewrite of `before`. Returns problems; empty means safe to use.
 * `logicValues` are state values the engine/TSX compares; they must never change.
 */
export function checkTsxRewrite(before: string, after: string, logicValues: ReadonlySet<string>): string[] {
  let a: string[], b: string[];
  try { a = codeSkeleton(before); } catch { return ["source does not parse"]; }
  try { b = codeSkeleton(after); } catch (e) { return [`rewrite does not parse: ${(e as Error).message.slice(0, 80)}`]; }
  if (a.join("\u0000") !== b.join("\u0000")) {
    const at = a.findIndex((t, i) => t !== b[i]);
    return [`code changed near ${a.slice(Math.max(0, at - 3), at + 3).join(" ")}`];
  }
  const la = tsxLiterals(before), lb = tsxLiterals(after);
  const tally = (ls: TsxLiteral[]) => {
    const m = new Map<string, number>();
    for (const l of ls) if (l.role === "compare" || l.role === "import" || l.role === "key") m.set(`${l.role}\u0000${l.text}`, (m.get(`${l.role}\u0000${l.text}`) ?? 0) + 1);
    return m;
  };
  const problems: string[] = [];
  // The token skeleton only sees that a regex is there, not what it matches: /^【Bella】/ rewritten as
  // /^【벨라】/ passed. Regexes are code; they must come back unchanged.
  const ra = regexLiterals(before), rb = regexLiterals(after);
  ra.forEach((r, i) => { if (rb[i] !== r) problems.push(`regex changed: ${r.slice(0, 60)}`); });
  const ta = tally(la), tb = tally(lb);
  for (const [k, n] of ta) if ((tb.get(k) ?? 0) !== n) problems.push(`${k.split("\u0000")[0]} literal changed: ${k.split("\u0000")[1]}`);
  const afterTexts = new Set(lb.map((l) => l.text));
  for (const l of la) {
    if (afterTexts.has(l.text)) continue;
    if (logicValues.has(l.text)) problems.push(`state value changed: ${l.text}`);
    else if (l.role === "other" && /^[a-z0-9]+(-[a-z0-9]+)+( [a-z0-9]+(-[a-z0-9]+)*)*$/.test(l.text)) problems.push(`class-like literal changed: ${l.text}`);
  }
  return problems.slice(0, 5);
}

/** Every regex literal in source order, as /pattern/flags. */
export function regexLiterals(code: string): string[] {
  const out: string[] = [];
  const visit = (node: any) => {
    if (!node || typeof node.type !== "string") return;
    if (node.type === "RegExpLiteral") out.push(`/${node.pattern}/${node.flags}`);
    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "start" || key === "end" || key === "extra" || key === "tokens" || key === "comments") continue;
      const v = node[key];
      if (Array.isArray(v)) v.forEach(visit); else if (v && typeof v === "object" && typeof v.type === "string") visit(v);
    }
  };
  try { visit(parseTsx(code).program); } catch { /* unparsable code is reported by the skeleton check */ }
  return out;
}

/** String values the TSX compares against (=== 'flat', case 'loud'): they are game state, not prose. */
export function comparedValues(code: string): string[] {
  try {
    return tsxLiterals(code).filter((l) => l.role === "compare").map((l) => l.text).filter((t) => t.length > 0 && t.length <= 40);
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// Fallback when the model keeps touching logic in a whole-file rewrite: we pick out the display
// strings ourselves, the model translates only those, and we put them back by position. The model
// never sees or returns code, so logic literals cannot change.

export interface DisplayString { id: string; text: string; start: number; end: number; nodeType: string }

export function extractDisplayStrings(code: string, sourceLang: "en" | "zh" | "es" | "ko" | "id" | "ru", logicValues: ReadonlySet<string>): DisplayString[] {
  let lits: TsxLiteral[];
  try { lits = tsxLiterals(code); } catch { return []; }
  // A value used anywhere as a key or comparison stays put everywhere it appears.
  const logicTexts = new Set(lits.filter((l) => l.role === "compare" || l.role === "key" || l.role === "import").map((l) => l.text));
  return lits
    // A per-language table ({ en: {...}, zh: {...} }): only the source language's texts are translated, in place,
    // so whichever way the card picks its language, the branch that showed the source now shows the target.
    .filter((l) => !l.table?.lang || sameLang(l.table.lang, sourceLang))
    .filter((l) => (l.role === "display" || l.role === "other") && isProse(l.text, sourceLang) && !logicValues.has(l.text) && !logicTexts.has(l.text))
    .map((l, i) => ({ id: `s${i}`, text: l.text, start: l.start, end: l.end, nodeType: l.nodeType }));
}

const sameLang = (key: string, lang: string) => { const k = key.toLowerCase().replace("_", "-"); return k === lang || k.startsWith(lang + "-") || (lang === "zh" && k === "cn"); };

/**
 * A file with a one-language string table and `const LANG = "en"` (the card swaps both per language it ships):
 * after its texts are translated, LANG (and the table's own "lang" field) name the target language. Left alone
 * when LANG picks a sub-table (`T[LANG]`), since that table has no target-language branch to pick.
 */
export function retargetLang(code: string, sourceLang: string, targetLang: string): string {
  let ast: any;
  try { ast = parseTsx(code); } catch { return code; }
  const tables = stringTables(ast.program);
  if (!tables.length || tables.some((t) => t.langs.length)) return code;
  const edits: Array<{ start: number; end: number }> = [];
  let indexed = false;
  const visit = (node: any) => {
    if (!node || typeof node.type !== "string") return;
    if (node.type === "VariableDeclarator" && node.id?.type === "Identifier" && LANG_CONST.test(node.id.name) && node.init?.type === "StringLiteral" && node.init.value.toLowerCase() === sourceLang) edits.push(node.init);
    if (node.type === "MemberExpression" && node.computed && node.property?.type === "Identifier" && LANG_CONST.test(node.property.name)) indexed = true;
    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "start" || key === "end" || key === "extra" || key === "tokens" || key === "comments") continue;
      const v = node[key];
      if (Array.isArray(v)) v.forEach(visit); else if (v && typeof v === "object" && typeof v.type === "string") visit(v);
    }
  };
  visit(ast.program);
  if (indexed || !edits.length) return code;
  // The table's own top-level "lang" field, when it names the source language.
  const findTop = (node: any) => {
    if (!node || typeof node.type !== "string") return;
    if (node.type === "ObjectExpression" && tables.some((t) => t.start === node.start && t.end === node.end)) {
      for (const p of node.properties) if (/^(lang|locale)$/.test(propKey(p) ?? "") && p.value?.type === "StringLiteral" && p.value.value.toLowerCase() === sourceLang) edits.push(p.value);
      return;
    }
    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "start" || key === "end" || key === "extra" || key === "tokens" || key === "comments") continue;
      const v = node[key];
      if (Array.isArray(v)) v.forEach(findTop); else if (v && typeof v === "object" && typeof v.type === "string") findTop(v);
    }
  };
  findTop(ast.program);
  let out = code;
  for (const e of edits.sort((a, b) => b.start - a.start)) {
    const q = code[e.start] === "'" ? "'" : '"';
    out = out.slice(0, e.start) + q + targetLang + q + out.slice(e.end);
  }
  return out;
}

export function applyDisplayStrings(code: string, items: DisplayString[], translated: Record<string, string>): string {
  let out = code;
  for (const it of [...items].sort((a, b) => b.start - a.start)) {
    const next = translated[it.id];
    if (typeof next !== "string" || !next.trim()) continue;
    const original = code.slice(it.start, it.end);
    let replacement: string;
    if (it.nodeType === "StringLiteral") {
      const q = original[0] === "'" ? "'" : '"';
      replacement = q + next.replace(/\\/g, "\\\\").replace(new RegExp(q, "g"), "\\" + q).replace(/\n/g, "\\n") + q;
    } else if (it.nodeType === "TemplateElement") {
      replacement = next.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
    } else {
      // JSX text: keep the surrounding whitespace, and escape what JSX would read as markup.
      const lead = original.match(/^\s*/)![0], trail = original.match(/\s*$/)![0];
      replacement = lead + next.replace(/[{}<>]/g, (c) => ({ "{": "&#123;", "}": "&#125;", "<": "&lt;", ">": "&gt;" })[c]!) + trail;
    }
    out = out.slice(0, it.start) + replacement + out.slice(it.end);
  }
  return out;
}
