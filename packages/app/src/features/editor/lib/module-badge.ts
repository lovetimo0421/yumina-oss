import type { Condition, Worldbook } from "@yumina/engine";

/** How a module turns on, compressed to a chip. Pure: the caller translates
 *  the kind, and the detail is the creator's own data (names, words). */
export type ModuleBadge = {
  kind: "disabled" | "always" | "manual" | "greeting" | "keywords" | "conditions";
  detail?: string;
  count?: number;
};

const OPS: Record<Condition["operator"], string> = {
  eq: "=", neq: "≠", gt: ">", gte: "≥", lt: "<", lte: "≤", contains: "∋",
};

export function moduleActivationBadge(wb: Worldbook, varName: (id: string) => string): ModuleBadge {
  if (wb.enabled === false) return { kind: "disabled" };
  const a = wb.activation;
  if (a.mode === "always") return { kind: "always" };
  if (a.mode === "manual") return { kind: "manual" };
  if (a.mode === "greeting") return { kind: "greeting", count: a.greetingIds.length };
  if (a.mode === "keywords") {
    const words = a.keywords ?? [];
    return words.length ? { kind: "keywords", detail: words.slice(0, 3).join(" · ") } : { kind: "keywords" };
  }
  const cs = a.conditions;
  if (!cs.length) return { kind: "conditions" };
  return {
    kind: "conditions",
    detail: cs.map((c) => `${varName(c.variableId)} ${OPS[c.operator]} ${String(c.value)}`).join(" · "),
  };
}
