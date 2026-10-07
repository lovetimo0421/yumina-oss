/**
 * 代码行为: a behaviour's own code, run in the card's sandbox when it fires.
 *
 * The escape hatch for logic the behaviour editor cannot say — parse a kill
 * broadcast, settle a hand of cards, decide who leaves. It is the creator's
 * code (written by them or their assistant at edit time, never by the AI at
 * play time), it runs here in the sandbox iframe like the card's own
 * interface code, and only while the game is open. It gets `ctx`:
 *
 *   ctx.vars            current values, by variable id
 *   ctx.get(name)       one value, by name or id
 *   ctx.set(name, v)    write a value (saved with the session)
 *   ctx.add(name, n)    add to a number
 *   ctx.push(name, x)   add to a list
 *   ctx.toast(text)     a notice to the player
 *   ctx.callAi(ai, in)  call one of the card's AIs; resolves with its answer
 *   ctx.say(text)       send a line as the player
 *   ctx.random(a, b)    a whole number from a to b
 */

export interface BehaviorCodeApi {
  variables: Record<string, unknown>;
  setVariable: (id: string, value: never) => void;
  patchVariables: (values: Record<string, unknown>) => Promise<void>;
  showToast: (message: string, type?: "success" | "error" | "info") => void;
  sendMessage: (text: string) => void;
  callAi: (ai: string, input?: unknown) => Promise<unknown>;
}

export function runBehaviorCode(
  source: string,
  api: BehaviorCodeApi,
  names: Record<string, string>,
  event: Record<string, unknown> = {},
): Promise<void> {
  const vars = { ...api.variables };
  const id = (name: string) => (name in vars ? name : names[name] ?? name);
  const pending: Record<string, unknown> = {};
  const flush = () => {
    const values = { ...pending };
    for (const k of Object.keys(pending)) delete pending[k];
    return Object.keys(values).length ? api.patchVariables(values).catch(() => {}) : Promise.resolve();
  };
  const ctx = {
    vars,
    event,
    get: (name: string) => vars[id(name)],
    set: (name: string, value: unknown) => { const k = id(name); vars[k] = value; pending[k] = value; },
    add: (name: string, n: number) => { const k = id(name); const v = (Number(vars[k]) || 0) + Number(n); vars[k] = v; pending[k] = v; },
    push: (name: string, item: unknown) => { const k = id(name); const list = Array.isArray(vars[k]) ? [...(vars[k] as unknown[]), item] : [item]; vars[k] = list; pending[k] = list; },
    toast: (text: string) => api.showToast(String(text), "info"),
    say: (text: string) => api.sendMessage(String(text)),
    callAi: (ai: string, input?: unknown) => api.callAi(ai, input),
    random: (a: number, b: number) => Math.floor(Math.min(a, b) + Math.random() * (Math.abs(b - a) + 1)),
  };
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function("ctx", `"use strict"; return (async () => {\n${source}\n})();`) as (c: typeof ctx) => Promise<unknown>;
    return Promise.resolve(fn(ctx)).catch((e) => console.warn("[behaviour code]", e)).then(flush);
  } catch (e) {
    console.warn("[behaviour code]", e);
    return Promise.resolve();
  }
}
