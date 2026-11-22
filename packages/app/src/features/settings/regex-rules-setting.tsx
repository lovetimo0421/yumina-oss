import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pencil, Plus, Trash2, Upload, X } from "lucide-react";
import {
  REGEX_FIND_MAX, REGEX_REPLACE_MAX, REGEX_RULES_MAX, applyRegexRules, compileRegexRule, makeTextRule,
  type RegexRule,
} from "@yumina/shared";
import { useConfigStore } from "@/stores/config";
import { InfoTip } from "@/components/ui/info-tip";
import { feedback } from "@/lib/feedback";
import { importRegexFiles, looksRunaway } from "./regex-import";

export { looksRunaway };

const chip = (active: boolean) => `rounded-lg border px-2.5 py-1 text-xs transition-colors ${
  active ? "border-gold/50 bg-gold/10 text-action-primary" : "border-white/[0.07] bg-white/[0.02] text-sub hover:bg-white/[0.05]"
}`;
const input = "w-full rounded-lg border border-white/[0.08] bg-black/20 px-3 py-2 text-sm text-main outline-none focus:border-gold/40";

function RuleEditor({ initial, onSave, onCancel }: { initial: RegexRule; onSave: (rule: RegexRule) => void; onCancel: () => void }) {
  const { t } = useTranslation("profile");
  const [rule, setRule] = useState<RegexRule>(initial);
  const [sample, setSample] = useState("");
  const set = (patch: Partial<RegexRule>) => setRule((r) => ({ ...r, ...patch }));
  const ignoreCase = (rule.flags ?? "").includes("i");
  const compiled = rule.find ? compileRegexRule(rule) : null;
  const problem = !rule.find ? null
    : !compiled ? t("config.regex.invalid")
      : rule.isRegex && looksRunaway(rule.find) ? t("config.regex.runaway")
        : !rule.ai && !rule.user ? t("config.regex.pickWho")
          : !rule.display && !rule.prompt ? t("config.regex.pickWhere") : null;
  const preview = useMemo(() => {
    if (!sample || !compiled || problem) return null;
    return applyRegexRules(sample, [{ ...rule, enabled: true, display: true, ai: true, user: true }], { role: "assistant", where: "display" });
  }, [sample, compiled, problem, rule]);

  return (
    <div className="space-y-3 rounded-xl border border-gold/20 bg-white/[0.02] p-4" data-regex-editor>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs text-sub">
          {t("config.regex.find")}
          <input className={`${input} mt-1 ${rule.isRegex ? "font-mono" : ""}`} value={rule.find} maxLength={REGEX_FIND_MAX}
            onChange={(e) => set({ find: e.target.value })} placeholder={rule.isRegex ? "<status>[\\s\\S]*?</status>" : "vanguard"} autoFocus />
        </label>
        <label className="block text-xs text-sub">
          {t("config.regex.replace")}
          <input className={`${input} mt-1 ${rule.isRegex ? "font-mono" : ""}`} value={rule.replace} maxLength={REGEX_REPLACE_MAX}
            onChange={(e) => set({ replace: e.target.value })} placeholder={t("config.regex.replaceEmpty")} />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-sub">
        <label className="inline-flex items-center gap-1.5">
          <input type="checkbox" className="accent-[#D6A94A]" checked={ignoreCase}
            onChange={(e) => set({ flags: (e.target.checked ? "i" : "") + (rule.flags ?? "").replace(/i/g, "") })} />
          {t("config.regex.ignoreCase")}
        </label>
        <label className="inline-flex items-center gap-1.5">
          <input type="checkbox" className="accent-[#D6A94A]" checked={rule.isRegex} onChange={(e) => set({ isRegex: e.target.checked })} />
          {t("config.regex.isRegex")}
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-sub">
        <span className="mr-1">{t("config.regex.who")}</span>
        <button type="button" className={chip(rule.ai)} aria-pressed={rule.ai} onClick={() => set({ ai: !rule.ai })}>{t("config.regex.ai")}</button>
        <button type="button" className={chip(rule.user)} aria-pressed={rule.user} onClick={() => set({ user: !rule.user })}>{t("config.regex.user")}</button>
        <span className="ml-3 mr-1">{t("config.regex.where")}</span>
        <button type="button" className={chip(rule.display)} aria-pressed={rule.display} onClick={() => set({ display: !rule.display })}>{t("config.regex.display")}</button>
        <button type="button" className={chip(rule.prompt)} aria-pressed={rule.prompt} onClick={() => set({ prompt: !rule.prompt })}>{t("config.regex.prompt")}</button>
        <InfoTip text={t("config.regex.promptTip")} />
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <textarea className={`${input} min-h-[64px] resize-y text-xs`} value={sample} onChange={(e) => setSample(e.target.value)} placeholder={t("config.regex.tryPlaceholder")} />
        <div className="min-h-[64px] whitespace-pre-wrap break-words rounded-lg border border-white/[0.05] bg-black/10 px-3 py-2 text-xs text-sub" aria-live="polite">
          {preview ?? <span className="opacity-50">{t("config.regex.tryResult")}</span>}
        </div>
      </div>
      {problem && <p className="text-xs text-rose-300/90">{problem}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-lg px-3 py-1.5 text-xs text-sub hover:bg-white/[0.05]">{t("config.regex.cancel")}</button>
        <button type="button" disabled={!rule.find || !!problem} onClick={() => onSave(rule)}
          className="rounded-lg bg-gold/90 px-3 py-1.5 text-xs font-semibold text-black disabled:opacity-40">{t("config.regex.save")}</button>
      </div>
    </div>
  );
}

/** "正则": the player's find-and-replace rules. Plain text by default; a real regular expression when asked;
 *  SillyTavern exports import as they are. Saved messages never change. */
export function RegexRulesSetting() {
  const { t } = useTranslation("profile");
  const rules = useConfigStore((s) => s.regexRules) ?? [];
  const setConfig = useConfigStore((s) => s.setConfig);
  const [editing, setEditing] = useState<RegexRule | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const save = (next: RegexRule[]) => setConfig("regexRules", next.slice(0, REGEX_RULES_MAX));

  const upsert = (rule: RegexRule) => {
    const exists = rules.some((r) => r.id === rule.id);
    save(exists ? rules.map((r) => (r.id === rule.id ? rule : r)) : [...rules, rule]);
    setEditing(null);
  };
  // Any number of files at once: SillyTavern exports (.json) and .zip folders of them (./regex-import.ts).
  const importFiles = async (files: File[]) => {
    const { added, skipped, failed } = await importRegexFiles(files, rules);
    if (failed) { feedback.error(t("config.regex.importFailed")); return; }
    save([...rules, ...added]);
    feedback.notice(skipped ? t("config.regex.importedSome", { n: added.length, skipped }) : t("config.regex.imported", { n: added.length }));
  };
  const summary = (r: RegexRule) => [
    r.isRegex ? t("config.regex.tagRegex") : null,
    r.ai && r.user ? t("config.regex.tagBoth") : r.user ? t("config.regex.user") : null,
    r.display && !r.prompt ? t("config.regex.tagDisplayOnly") : !r.display && r.prompt ? t("config.regex.tagPromptOnly") : null,
  ].filter(Boolean).join(" · ");

  return (
    <div className="border-b border-white/5 pb-6" id="settings-target-regex">
      <div className="mb-3 flex items-center justify-between gap-2">
        <label className="flex items-center gap-1.5 text-sm font-semibold text-main">
          {t("config.regex.title")}
          <InfoTip text={t("config.regex.desc")} />
        </label>
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={() => fileRef.current?.click()} className={`${chip(false)} inline-flex items-center gap-1`}>
            <Upload className="h-3 w-3" />{t("config.regex.importSt")}
          </button>
          <button type="button" disabled={rules.length >= REGEX_RULES_MAX} onClick={() => setEditing({ ...makeTextRule(""), find: "", flags: "i" })}
            className={`${chip(false)} inline-flex items-center gap-1 disabled:opacity-40`}>
            <Plus className="h-3 w-3" />{t("config.regex.add")}
          </button>
          <input ref={fileRef} type="file" accept=".json,application/json,.zip,application/zip" multiple className="hidden"
            onChange={(e) => { const fs = [...(e.target.files ?? [])]; e.target.value = ""; if (fs.length) void importFiles(fs); }} />
        </div>
      </div>
      {editing && !rules.some((r) => r.id === editing.id) && (
        <div className="mb-3"><RuleEditor initial={editing} onSave={upsert} onCancel={() => setEditing(null)} /></div>
      )}
      {rules.length === 0 && !editing ? (
        <p className="text-xs text-sub/70">{t("config.regex.empty")}</p>
      ) : (
        <ul className="space-y-1.5">
          {rules.map((r) => editing?.id === r.id ? (
            <li key={r.id}><RuleEditor initial={r} onSave={upsert} onCancel={() => setEditing(null)} /></li>
          ) : (
            <li key={r.id} className="flex items-center gap-2.5 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2" data-regex-rule>
              <input type="checkbox" className="accent-[#D6A94A]" checked={r.enabled} aria-label={t("config.regex.enabled")}
                onChange={(e) => save(rules.map((x) => (x.id === r.id ? { ...x, enabled: e.target.checked } : x)))} />
              <div className={`min-w-0 flex-1 ${r.enabled ? "" : "opacity-50"}`}>
                <div className="truncate text-xs text-main">
                  {r.name ? <span className="mr-2 font-semibold">{r.name}</span> : null}
                  <span className={r.isRegex ? "font-mono" : ""}>{r.find}</span>
                  <span className="mx-1.5 text-sub">→</span>
                  {r.replace ? <span className={r.isRegex ? "font-mono" : ""}>{r.replace}</span> : <span className="text-sub">{t("config.regex.removed")}</span>}
                </div>
                {summary(r) && <div className="mt-0.5 text-[10.5px] text-sub/70">{summary(r)}</div>}
              </div>
              <button type="button" onClick={() => setEditing(r)} className="rounded p-1 text-sub/60 hover:text-main" aria-label={t("config.regex.edit")}><Pencil className="h-3.5 w-3.5" /></button>
              <button type="button" onClick={() => save(rules.filter((x) => x.id !== r.id))} className="rounded p-1 text-sub/60 hover:text-rose-300" aria-label={t("config.regex.delete")}><Trash2 className="h-3.5 w-3.5" /></button>
            </li>
          ))}
        </ul>
      )}
      {editing && rules.length >= REGEX_RULES_MAX && <p className="mt-2 text-xs text-sub"><X className="inline h-3 w-3" /> {t("config.regex.full", { n: REGEX_RULES_MAX })}</p>}
    </div>
  );
}
