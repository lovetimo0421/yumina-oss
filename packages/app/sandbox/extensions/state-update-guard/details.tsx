import type { StateValidationAudit } from "@yumina/shared";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ChevronRight, History } from "lucide-react";
import { diagnosticSummary, OutputComparison, readableLabels, variableLabel } from "./readable-output";
export { validationRecords } from "./audit-records";

const copy = {
  en: ["State Update Guard", "No checked turns yet. Protection applies to new replies after installation.", "Checked commands", "No AI updates", "Not required", "Checking", "Correcting", "Failed", "Cancelled", "Interrupted / stale", "Format checking cannot guarantee story accuracy. Automatic rules can still change values. Saved corrections with paid Yumina models cost mushies. Free models and BYOK do not deduct mushies; BYOK provider charges may apply.", "Commands", "Corrections", "Close"],
  zh: ["状态更新守卫", "尚无检查记录。安装后保护新生成的回复。", "指令已验证", "无需 AI 更新", "无需检查", "检查中", "修正中", "检查失败", "已取消", "已中断或过期", "格式检查不保证剧情判断正确。自动规则仍可更新数值。使用 Yumina 付费模型保存修正会扣除蘑菇。免费模型和自备 API 不扣蘑菇，但 API 服务商可能收费。", "指令", "修正次数", "关闭"],
  "zh-Hant": ["狀態更新守衛", "尚無檢查記錄。安裝後保護新產生的回覆。", "指令已驗證", "無需 AI 更新", "無需檢查", "檢查中", "修正中", "檢查失敗", "已取消", "已中斷或過期", "格式檢查不保證劇情判斷正確。自動規則仍可更新數值。使用 Yumina 付費模型儲存修正會扣除蘑菇。免費模型和自備 API 不扣蘑菇，但 API 服務商可能收費。", "指令", "修正次數", "關閉"],
  ja: ["状態更新ガード", "確認済みの返信はまだありません。インストール後の新しい返信が対象です。", "コマンド確認済み", "AIの更新なし", "確認不要", "確認中", "修正中", "失敗", "キャンセル済み", "中断・期限切れ", "形式の確認は物語の正確さを保証しません。自動ルールは値を更新できます。Yuminaの有料モデルで保存した修正にはマッシュが必要です。無料モデルと自分のAPIではマッシュを消費しませんが、APIプロバイダーの料金は発生する場合があります。", "コマンド", "修正回数", "閉じる"],
  es: ["Protección de estado", "Aún no hay respuestas comprobadas. Protege las respuestas nuevas tras instalarla.", "Comandos verificados", "Sin cambios de IA", "No necesario", "Comprobando", "Corrigiendo", "Falló", "Cancelado", "Interrumpido / caducado", "Comprobar el formato no garantiza la precisión narrativa. Las reglas automáticas siguen funcionando. Las correcciones guardadas con modelos de pago de Yumina cuestan mushies. Los modelos gratuitos y BYOK no descuentan mushies; tu proveedor de API puede cobrar.", "Comandos", "Correcciones", "Cerrar"],
} as const;

export function guardLabels(language?: string) {
  const key = language?.startsWith("zh-Hant") || language?.startsWith("zh-TW") ? "zh-Hant" : language?.startsWith("zh") ? "zh" : language?.startsWith("ja") ? "ja" : language?.startsWith("es") ? "es" : "en";
  return copy[key];
}

export function auditOutcome(audit: StateValidationAudit): StateValidationAudit["outcome"] {
  return ["validating", "repairing"].includes(audit.outcome) && Date.now() - Date.parse(audit.startedAt) > 180_000 ? "stale" : audit.outcome;
}

export function StateGuardDetails({ records, language }: { records: StateValidationAudit[]; language?: string }) {
  const text = guardLabels(language);
  const labels: Record<StateValidationAudit["outcome"], string> = { "valid-updates": text[2], "explicit-none": text[3], "not-required": text[4], validating: text[5], repairing: text[6], failed: text[7], cancelled: text[8], stale: text[9] };
  return <div className="space-y-4 text-sm">
    {!records.length && <p>{text[1]}</p>}
    {records.slice(-12).reverse().map((audit) => <section key={audit.attemptId} className="rounded-lg border border-white/15 p-3" aria-live="polite">
      <p className="font-medium">{labels[auditOutcome(audit)]}</p>
      <p className="mt-1 text-white/60">{text[11]}: {audit.parsedCount} · {text[12]}: {audit.correctionCount}</p>
      <p className="mt-1 break-all text-xs text-white/50">{audit.model} · {new Date(audit.startedAt).toLocaleString()}</p>
      {audit.correctionModel && <p className="mt-1 break-all text-xs text-white/60">{text[12]}: {audit.correctionModel}</p>}
      {diagnosticSummary(audit.diagnostics, language).map((message) => <p key={message} className="mt-2 text-amber-300">{message}</p>)}
      <details className="mt-2"><summary className="cursor-pointer py-3 text-white/70">{readableLabels(language)[4]}</summary>
        <p className="break-words text-xs text-white/70">{audit.diagnostics.join(", ")}</p><p className="mt-2 text-white/70">{text[10]}</p>
      </details>
    </section>)}
  </div>;
}

const historyCopy = {
  en: ["View history", "Back", "History", "Call details", "Before", "After", "AI updates", "Automatic rules", "Applied", "Not applied", "Before/after details were not recorded for this older call.", "No value changes.", "Correction output", "Value preview shortened.", "Some changes are omitted from this preview.", "Recorded checks from loaded chat messages and saved alternatives.", "Checked without an extra model call.", "Trigger", "send", "regenerate", "continue"],
  zh: ["查看历史", "返回", "历史记录", "调用详情", "之前", "之后", "AI 更新", "自动规则", "已应用", "未应用", "此旧调用未记录前后数值。", "数值没有变化。", "修正输出", "数值预览已缩短。", "此预览省略了部分变化。", "已加载聊天消息及已保存备选回复的检查记录。", "仅检查，未额外调用模型。", "触发方式", "发送", "重新生成", "继续"],
  "zh-Hant": ["檢視記錄", "返回", "歷史記錄", "呼叫詳情", "之前", "之後", "AI 更新", "自動規則", "已套用", "未套用", "此舊呼叫未記錄前後數值。", "數值沒有變化。", "修正輸出", "數值預覽已縮短。", "此預覽省略了部分變化。", "已載入聊天訊息及已儲存備選回覆的檢查記錄。", "僅檢查，未額外呼叫模型。", "觸發方式", "傳送", "重新產生", "繼續"],
  ja: ["履歴を表示", "戻る", "履歴", "呼び出しの詳細", "変更前", "変更後", "AIの更新", "自動ルール", "適用済み", "未適用", "この古い呼び出しには変更前後の値が記録されていません。", "値の変更はありません。", "修正出力", "値のプレビューは省略されています。", "一部の変更は省略されています。", "読み込み済みメッセージと保存済み候補の確認履歴。", "追加のモデル呼び出しなしで確認しました。", "トリガー", "送信", "再生成", "続行"],
  es: ["Ver historial", "Volver", "Historial", "Detalles de la llamada", "Antes", "Después", "Cambios de IA", "Reglas automáticas", "Aplicado", "No aplicado", "Esta llamada antigua no registró los valores anteriores y posteriores.", "Sin cambios de valores.", "Salida de corrección", "Vista previa abreviada.", "Se omiten algunos cambios en esta vista previa.", "Comprobaciones de mensajes cargados y alternativas guardadas.", "Comprobado sin otra llamada al modelo.", "Activador", "enviar", "regenerar", "continuar"],
} as const;

/** A separate settings → history → detail navigation flow, available even when Off. */
export function StateGuardHistory(props: { records: StateValidationAudit[]; language?: string; children?: ReactNode }) {
  const [view, setView] = useState("settings");
  const heading = useRef<HTMLHeadingElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const previousView = useRef(view);
  const lang = props.language ?? "en";
  const key = lang.startsWith("zh-Hant") || lang.startsWith("zh-TW") ? "zh-Hant" : lang.startsWith("zh") ? "zh" : lang.startsWith("ja") ? "ja" : lang.startsWith("es") ? "es" : "en";
  const text = historyCopy[key];
  const labels = guardLabels(props.language);
  const audit = props.records.find((record) => record.attemptId === view);
  useEffect(() => {
    if (view !== previousView.current) (view === "settings" ? trigger.current : heading.current)?.focus();
    previousView.current = view;
  }, [view]);
  const button = "flex min-h-11 items-center gap-2 rounded-lg px-2 text-sm text-white/80 hover:bg-white/5 focus-visible:outline focus-visible:outline-2";
  return <>
    <div hidden={view !== "settings"}>{props.children}
      <button ref={trigger} type="button" onClick={() => setView("history")} className={`${button} mt-4 w-full border-t border-white/10`}>
        <History aria-hidden="true" className="h-4 w-4" />{text[0]}<ChevronRight aria-hidden="true" className="ml-auto h-4 w-4" />
      </button>
    </div>
    {view !== "settings" && <div className="space-y-4 text-sm">
      <button type="button" onClick={() => setView(view === "history" ? "settings" : "history")} className={button}><ArrowLeft aria-hidden="true" className="h-4 w-4" />{text[1]}</button>
      <h3 ref={heading} tabIndex={-1} className="text-base font-semibold focus:outline-none">{view === "history" ? text[2] : text[3]}</h3>
      {view === "history" ? <>
        <p className="text-white/60">{text[15]}</p>
        {!props.records.length && <p>{labels[1]}</p>}
        <ol className="space-y-2">{[...props.records].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map((record) => <li key={record.attemptId}>
          <button type="button" onClick={() => setView(record.attemptId)} className={`${button} w-full border border-white/10 p-3 text-left`}>
            <span className="min-w-0 flex-1"><span className="block">{new Date(record.startedAt).toLocaleString()}</span>
              <span className="block break-all text-xs text-white/60">{record.correctionModel ?? record.model}</span>
              <span className="block text-xs text-white/60">{record.correctionCount ? `${labels[12]}: ${record.correctionCount}` : text[16]} · {labels[({ "valid-updates": 2, "explicit-none": 3, "not-required": 4, validating: 5, repairing: 6, failed: 7, cancelled: 8, stale: 9 } as const)[auditOutcome(record)]]}</span>
            </span><ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0" />
          </button>
        </li>)}</ol>
      </> : audit ? <>
        <p className="text-sm text-white/70">{labels[({ "valid-updates": 2, "explicit-none": 3, "not-required": 4, validating: 5, repairing: 6, failed: 7, cancelled: 8, stale: 9 } as const)[auditOutcome(audit)]]}</p>
        <p className="break-words text-xs text-white/60">{audit.correctionModel ?? audit.model} · {new Date(audit.startedAt).toLocaleString()} · {labels[11]}: {audit.parsedCount} · {labels[12]}: {audit.correctionCount}</p>
        <p>{text[17]}: {text[audit.path === "send" ? 18 : audit.path === "regenerate" ? 19 : 20]}</p>
        {audit.committed !== undefined && <p className={audit.committed ? "text-green-300" : "text-amber-300"}>{text[audit.committed ? 8 : 9]}</p>}
        <OutputComparison audit={audit} language={props.language} />
        <details><summary className="cursor-pointer py-3 text-white/70">{readableLabels(props.language)[4]}</summary>
          <p className="break-words text-xs text-white/60">{audit.diagnostics.join(", ")}</p><p className="mt-2 text-white/60">{labels[10]}</p>
        </details>
        <h4 className="font-semibold">{readableLabels(props.language)[27]}</h4>
        {!audit.changes ? <p className="text-white/60">{text[10]}</p> : !audit.changes.length ? <p>{text[11]}</p> :
          audit.changes.map((change, index) => <section key={index} className="space-y-2 rounded-lg border border-white/10 p-3">
            <h4 className="break-words font-medium">{variableLabel(change.variableId, audit.variableNames, props.language)}</h4><p className="text-xs text-white/60">{text[change.source === "ai" ? 6 : 7]}</p>
            <div className="grid min-w-0 gap-3 sm:grid-cols-2">{[[text[4], change.oldValue], [text[5], change.newValue]].map(([label, value], side) => <div key={side} className="min-w-0"><p className="mb-1 text-xs text-white/60">{label as string}</p><pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all rounded bg-white/5 p-2 text-xs">{typeof value === "string" ? value : JSON.stringify(value, null, 2)}</pre></div>)}</div>
            {change.truncated && <p className="text-xs text-amber-300">{text[13]}</p>}
          </section>)}
        {audit.changesTruncated && <p className="text-amber-300">{text[14]}</p>}
      </> : <p>{labels[1]}</p>}
    </div>}
  </>;
}
