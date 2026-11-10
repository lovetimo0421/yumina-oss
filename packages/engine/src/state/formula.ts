/**
 * Formula variables (公式数值): a number the engine works out from others —
 * 攻击力 = 基础攻击 + 武器.攻击 × (1 + 等级 × 0.1), 存活 = min(存活上限, 40 − len(死者)).
 *
 * Cards on the platform wrote these as `calcAttack()` functions in their
 * interface code, so the AI and the rules never saw the same number the
 * player did. A small parser, never `eval`: numbers, variable names (by name
 * or id, dot paths into JSON), + − × ÷ % ^, comparisons and a few functions.
 * Anything it cannot read makes the formula leave its value alone.
 */

type Tok = { k: "num"; v: number } | { k: "id"; v: string } | { k: "op"; v: string } | { k: "str"; v: string };

const FUNCS: Record<string, (args: unknown[]) => number> = {
  min: (a) => Math.min(...a.map(Number)),
  max: (a) => Math.max(...a.map(Number)),
  floor: (a) => Math.floor(Number(a[0])),
  ceil: (a) => Math.ceil(Number(a[0])),
  round: (a) => Math.round(Number(a[0])),
  abs: (a) => Math.abs(Number(a[0])),
  len: (a) => (Array.isArray(a[0]) ? a[0].length : typeof a[0] === "string" ? (a[0] as string).split(/[,，|]/).filter((s) => s.trim()).length : 0),
  sum: (a) => (Array.isArray(a[0]) ? a[0].reduce((s: number, x) => s + (Number(x) || 0), 0) : Number(a[0]) || 0),
  clamp: (a) => Math.min(Number(a[2]), Math.max(Number(a[1]), Number(a[0]))),
  if: (a) => (a[0] ? Number(a[1]) : Number(a[2])),
};

function tokenize(src: string): Tok[] | null {
  const out: Tok[] = [];
  const s = src.replace(/×/g, "*").replace(/÷/g, "/").replace(/−/g, "-").replace(/（/g, "(").replace(/）/g, ")").replace(/，/g, ",");
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j]!)) j++;
      const n = Number(s.slice(i, j));
      if (!Number.isFinite(n)) return null;
      out.push({ k: "num", v: n });
      i = j;
      continue;
    }
    if (c === '"' || c === "'" || c === "「") {
      const close = c === "「" ? "」" : c;
      const j = s.indexOf(close, i + 1);
      if (j < 0) return null;
      out.push({ k: "str", v: s.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    // {名字} names a variable whose name has symbols in it (dead-names).
    if (c === "{") {
      const j = s.indexOf("}", i + 1);
      if (j < 0) return null;
      out.push({ k: "id", v: s.slice(i + 1, j).trim() });
      i = j + 1;
      continue;
    }
    const two = s.slice(i, i + 2);
    if ([">=", "<=", "==", "!=", "&&", "||"].includes(two)) { out.push({ k: "op", v: two }); i += 2; continue; }
    if ("+-*/%^()<>,!".includes(c)) { out.push({ k: "op", v: c }); i++; continue; }
    // A name: anything up to an operator or space (Chinese names, dots, ids).
    let j = i;
    while (j < s.length && !/[\s+\-*/%^()<>,=!&|]/.test(s[j]!)) j++;
    if (j === i) return null;
    out.push({ k: "id", v: s.slice(i, j) });
    i = j;
  }
  return out;
}

export function evaluateFormula(formula: string, lookup: (name: string) => unknown): number | null {
  const toks = tokenize(formula);
  if (!toks || toks.length === 0) return null;
  let p = 0;
  const peek = () => toks[p];
  const eat = (v?: string) => { const t = toks[p]; if (!t || (v !== undefined && !(t.k === "op" && t.v === v))) throw new Error("parse"); p++; return t; };
  const isOp = (v: string) => { const t = peek(); return !!t && t.k === "op" && t.v === v; };

  const num = (x: unknown) => (typeof x === "boolean" ? (x ? 1 : 0) : typeof x === "number" ? x : Number(x));
  function primary(): unknown {
    const t = peek();
    if (!t) throw new Error("end");
    if (t.k === "num" || t.k === "str") { p++; return t.v; }
    if (t.k === "op" && t.v === "(") { p++; const v = or(); eat(")"); return v; }
    if (t.k === "op" && t.v === "-") { p++; return -num(unary()); }
    if (t.k === "op" && t.v === "!") { p++; return !num(unary()) ? 1 : 0; }
    if (t.k === "id") {
      p++;
      if (isOp("(")) {
        const fn = FUNCS[t.v.toLowerCase()];
        if (!fn) throw new Error("fn");
        p++;
        const args: unknown[] = [];
        if (!isOp(")")) { args.push(or()); while (isOp(",")) { p++; args.push(or()); } }
        eat(")");
        return fn(args);
      }
      const v = lookup(t.v);
      if (v === undefined) throw new Error("unknown");
      return v;
    }
    throw new Error("token");
  }
  function unary(): unknown { return primary(); }
  function power(): unknown { let a = unary(); while (isOp("^")) { p++; a = Math.pow(num(a), num(unary())); } return a; }
  function term(): unknown {
    let a = power();
    while (isOp("*") || isOp("/") || isOp("%")) {
      const op = (eat() as { v: string }).v;
      const b = num(power());
      a = op === "*" ? num(a) * b : op === "/" ? (b === 0 ? 0 : num(a) / b) : num(a) % b;
    }
    return a;
  }
  function sum(): unknown {
    let a = term();
    while (isOp("+") || isOp("-")) { const op = (eat() as { v: string }).v; const b = num(term()); a = op === "+" ? num(a) + b : num(a) - b; }
    return a;
  }
  function cmp(): unknown {
    let a = sum();
    while (isOp(">") || isOp("<") || isOp(">=") || isOp("<=") || isOp("==") || isOp("!=")) {
      const op = (eat() as { v: string }).v;
      const b = sum();
      a = op === ">" ? num(a) > num(b) : op === "<" ? num(a) < num(b) : op === ">=" ? num(a) >= num(b) : op === "<=" ? num(a) <= num(b) : op === "==" ? a == b : a != b; // eslint-disable-line eqeqeq
      a = a ? 1 : 0;
    }
    return a;
  }
  function and(): unknown { let a = cmp(); while (isOp("&&")) { p++; const b = cmp(); a = num(a) && num(b) ? 1 : 0; } return a; }
  function or(): unknown { let a = and(); while (isOp("||")) { p++; const b = and(); a = num(a) || num(b) ? 1 : 0; } return a; }

  try {
    const v = num(or());
    if (p !== toks.length || !Number.isFinite(v)) return null;
    return v;
  } catch {
    return null;
  }
}
