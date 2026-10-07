import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";
import type { ReplyRule, ReplyRuleRoute } from "@yumina/engine";
import { useEditorStore } from "@/stores/editor";
import { cn } from "@/lib/utils";
import { Check, Group } from "./controls";

/**
 * 回复处理: what the card takes out of the AI's reply, and where it goes —
 * a status block into variables, options to the interface, a forum update
 * into a list. Plus one switch: a reply split into a bubble per speaker.
 */
const small = "rounded-md border border-white/10 bg-background px-1.5 py-1 text-[11px] outline-none focus:border-sky-400/60";

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
        return (
          <div key={rule.id} className="space-y-1 rounded-md border border-white/[0.06] p-2" data-reply-rule={rule.id}>
            <div className="flex items-center gap-1">
              <select value={isTag ? "tag" : "pattern"} onChange={(e) => setRule(i, { match: e.target.value === "tag" ? { tag: "状态" } : { pattern: "【(.+?)】" } })} className={small}>
                <option value="tag">{t("blueprint.replyRules.byTag")}</option>
                <option value="pattern">{t("blueprint.replyRules.byPattern")}</option>
              </select>
              <input
                value={"tag" in rule.match ? rule.match.tag : rule.match.pattern}
                onChange={(e) => setRule(i, { match: isTag ? { tag: e.target.value } : { pattern: e.target.value } })}
                className={cn(small, "min-w-0 flex-1 font-mono")}
              />
              <button type="button" aria-label={t("blueprint.insp.delete")} onClick={() => write(rules.filter((_, j) => j !== i))} className="text-muted-foreground hover:text-foreground"><X className="h-3.5 w-3.5" /></button>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-[11px] text-muted-foreground">→</span>
              <select
                value={routeValue(route)}
                onChange={(e) => {
                  const v = e.target.value;
                  const next: ReplyRuleRoute | null = v === "" ? null : v === "fields" ? { kind: "fields" } : v === "event" ? { kind: "event" } : v === "channel" ? { kind: "channel", channel: "tag" in rule.match ? rule.match.tag : "channel" } : { kind: "variable", variableId: v.slice(4) };
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
