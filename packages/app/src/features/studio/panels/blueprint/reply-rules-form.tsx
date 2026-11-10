import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";
import { replyRouteOps, type ReplyRule, type ReplyRuleRoute, type Variable } from "@yumina/engine";
import { useEditorStore } from "@/stores/editor";
import { cn } from "@/lib/utils";
import { Check, DraftInput, Group } from "./controls";

/**
 * 回复处理: what the card takes out of the AI's reply, and where it goes —
 * a status block into variables, options to the interface, a forum update
 * into a list. Plus one switch: a reply split into a bubble per speaker.
 */
const small = "rounded-md border border-white/10 bg-background px-1.5 py-1 text-[11px] outline-none focus:border-sky-400/60";

type VariableOp = NonNullable<Extract<ReplyRuleRoute, { kind: "variable" }>["op"]>;

/** Why a pattern catches nothing, if it does not. */
function patternProblem(pattern: string): "empty" | "invalid" | null {
  if (!pattern.trim()) return "empty";
  try {
    new RegExp(pattern, "g");
    return null;
  } catch {
    return "invalid";
  }
}

/** The label for an op on this variable: "set" on a list is the JSON-only
 *  replace, and says so. */
const opLabelKey = (op: VariableOp, type: Variable["type"] | undefined) =>
  `blueprint.replyRules.op.${op === "set" && type === "json" ? "replace" : op}` as const;

export function ReplyRulesForm() {
  const { t } = useTranslation("editor");
  const rules = useEditorStore((s) => s.worldDraft.replyRules) ?? [];
  const variables = useEditorStore((s) => s.worldDraft.variables);
  const speakerBubbles = useEditorStore((s) => s.worldDraft.settings?.speakerBubbles === true);
  const setField = useEditorStore((s) => s.setField);
  const setSettings = useEditorStore((s) => s.setSettings);
  const write = (next: ReplyRule[]) => setField("replyRules", next.length ? next : undefined);
  const setRule = (i: number, patch: Partial<ReplyRule>) => write(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const routeValue = (route: ReplyRuleRoute | undefined) =>
    !route ? "" : route.kind === "fields" ? "fields" : route.kind === "event" ? "event" : route.kind === "channel" ? "channel" : `var:${route.variableId}`;

  return (
    <Group
      title={t("blueprint.replyRules.title")}
      right={<button type="button" data-reply-rule-add="" onClick={() => write([...rules, { id: `rule-${Date.now().toString(36)}`, match: { tag: "状态" }, hide: true, to: [{ kind: "fields" }] }])} className="text-muted-foreground hover:text-foreground"><Plus className="h-3.5 w-3.5" /></button>}
    >
      <Check label={t("blueprint.replyRules.speakerBubbles")} checked={speakerBubbles} onChange={(on) => setSettings("speakerBubbles", on || undefined)} />
      {rules.map((rule, i) => {
        const isTag = "tag" in rule.match;
        const route = rule.to?.[0];
        const problem = "pattern" in rule.match ? patternProblem(rule.match.pattern) : null;
        const routeVar = route?.kind === "variable" ? variables.find((v) => v.id === route.variableId || v.name === route.variableId) : undefined;
        const ops = routeVar ? replyRouteOps(routeVar.type) : [];
        return (
          <div key={rule.id} className="space-y-1 rounded-md border border-white/[0.06] p-2" data-reply-rule={rule.id}>
            <div className="flex items-center gap-1">
              <select value={isTag ? "tag" : "pattern"} onChange={(e) => setRule(i, { match: e.target.value === "tag" ? { tag: "状态" } : { pattern: "【(.+?)】" } })} className={small}>
                <option value="tag">{t("blueprint.replyRules.byTag")}</option>
                <option value="pattern">{t("blueprint.replyRules.byPattern")}</option>
              </select>
              {/* Kept while typing, saved when let go of. An empty pattern
                  is never saved: it matched between every two characters,
                  and a reply routed to a channel came out as a message per
                  character. Cleared, the field goes back to what it was. */}
              <DraftInput
                value={"tag" in rule.match ? rule.match.tag : rule.match.pattern}
                onCommit={(raw) => {
                  if (isTag) setRule(i, { match: { tag: raw } });
                  else if (patternProblem(raw) !== "empty") setRule(i, { match: { pattern: raw } });
                }}
                className={cn(small, "min-w-0 flex-1 font-mono", problem && "border-destructive/60")}
              />
              <button type="button" aria-label={t("blueprint.insp.delete")} onClick={() => write(rules.filter((_, j) => j !== i))} className="text-muted-foreground hover:text-foreground"><X className="h-3.5 w-3.5" /></button>
            </div>
            {problem && <p className="text-[11px] text-destructive">{t("blueprint.replyRules.badPattern")}</p>}
            <div className="flex items-center gap-1">
              <span className="text-[11px] text-muted-foreground">→</span>
              <select
                value={routeValue(route)}
                onChange={(e) => {
                  const v = e.target.value;
                  // Into a variable, the first thing its type can take: a
                  // number is set to the number in the block, a list gets
                  // the block as one more item, never a string over it.
                  const variable = v.startsWith("var:") ? variables.find((x) => x.id === v.slice(4)) : undefined;
                  const next: ReplyRuleRoute | null = v === "" ? null : v === "fields" ? { kind: "fields" } : v === "event" ? { kind: "event" } : v === "channel" ? { kind: "channel", channel: "tag" in rule.match ? rule.match.tag : "channel" } : { kind: "variable", variableId: v.slice(4), op: variable ? replyRouteOps(variable.type)[0] : "set" };
                  setRule(i, { to: next ? [next] : undefined });
                }}
                className={cn(small, "min-w-0 flex-1")}
              >
                <option value="">{t("blueprint.replyRules.toNothing")}</option>
                <option value="fields">{t("blueprint.replyRules.toFields")}</option>
                <option value="channel">{t("blueprint.replyRules.toChannel")}</option>
                <option value="event">{t("blueprint.replyRules.toEvent")}</option>
                {variables.filter((v) => !v.internal).map((v) => <option key={v.id} value={`var:${v.id}`}>{t("blueprint.aiCustom.toVariable", { name: v.name })}</option>)}
              </select>
              {route?.kind === "variable" && ops.length > 1 && (
                <select
                  aria-label={t("blueprint.replyRules.opLabel")}
                  // As the engine reads it: an op the type cannot take is
                  // read as its nearest (a text's old "push" appends).
                  value={route.op && ops.includes(route.op) ? route.op : route.op === "push" && routeVar?.type === "string" ? "append" : ops[0]}
                  onChange={(e) => setRule(i, { to: [{ ...route, op: e.target.value as VariableOp }] })}
                  className={small}
                >
                  {ops.map((op) => <option key={op} value={op}>{t(opLabelKey(op, routeVar?.type))}</option>)}
                </select>
              )}
              {route?.kind === "channel" && (
                <input value={route.channel} onChange={(e) => setRule(i, { to: [{ kind: "channel", channel: e.target.value }] })} className={cn(small, "w-24")} />
              )}
              <label className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                <input type="checkbox" checked={!!rule.hide} onChange={(e) => setRule(i, { hide: e.target.checked || undefined })} />
                {t("blueprint.replyRules.hide")}
              </label>
            </div>
          </div>
        );
      })}
    </Group>
  );
}
