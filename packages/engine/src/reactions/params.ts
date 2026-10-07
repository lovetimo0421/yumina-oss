import type { GameEvent, Reaction, ReactionEffect } from "../events/types.js";
import type { Condition } from "../types/index.js";

/**
 * What a button passes into a behaviour — 「购买」 with 商品 and 价格.
 *
 * Shops, crafting and combat were the biggest block of logic cards wrote by
 * hand in their interface code, because a behaviour could not be told WHICH
 * item or HOW MUCH. A button now sends `params` with its action; anywhere in
 * the behaviour, `{参数.价格}` (or `{param.price}`) reads it: in a condition's
 * value, in an effect's value, in a notice. A value that is only the token
 * keeps the parameter's own type, so `{参数.价格}` stays a number.
 */

const TOKEN = /\{(?:参数|param)\.([^}]+)\}/g;
const WHOLE = /^\{(?:参数|param)\.([^}]+)\}$/;

type Params = Record<string, unknown>;

function bindValue<T>(value: T, params: Params): T {
  if (typeof value !== "string") return value;
  const whole = WHOLE.exec(value.trim());
  if (whole) {
    const v = params[whole[1]!.trim()];
    if (v === undefined) return "" as T;
    if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v) as T;
    return v as T;
  }
  if (!value.includes("{")) return value;
  return value.replace(TOKEN, (_, key: string) => {
    const v = params[key.trim()];
    return v === undefined || v === null ? "" : String(v);
  }) as T;
}

function bindRef(ref: string | undefined): { key: string } | null {
  if (!ref) return null;
  const m = /^(?:参数|param)\.(.+)$/.exec(ref.trim());
  return m ? { key: m[1]!.trim() } : null;
}

function bindCondition(c: Condition, params: Params): Condition {
  const ref = bindRef(c.valueRef);
  if (ref) {
    const { valueRef: _drop, ...rest } = c;
    return { ...rest, value: bindValue(`{参数.${ref.key}}`, params) as Condition["value"] };
  }
  return { ...c, value: bindValue(c.value, params) };
}

function bindEffect(e: ReactionEffect, params: Params): ReactionEffect {
  if (e.type === "set") {
    const ref = bindRef(e.valueRef);
    if (ref) {
      const { valueRef: _drop, ...rest } = e;
      return { ...rest, value: bindValue(`{参数.${ref.key}}`, params) as typeof e.value };
    }
    return { ...e, value: bindValue(e.value, params) };
  }
  const event = Object.fromEntries(Object.entries(e.event).map(([k, v]) => [k, bindValue(v, params)])) as GameEvent;
  return { ...e, event };
}

/** The behaviour with what the event carried filled in; the same object when
 *  the event carried nothing. */
export function bindEventParams(reaction: Reaction, event: GameEvent): Reaction {
  const params = event.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) return reaction;
  const p = params as Params;
  return {
    ...reaction,
    conditions: reaction.conditions.map((c) => bindCondition(c, p)),
    then: reaction.then.map((e) => bindEffect(e, p)),
    ...(reaction.elseMessage ? { elseMessage: bindValue(reaction.elseMessage, p) } : {}),
  };
}
