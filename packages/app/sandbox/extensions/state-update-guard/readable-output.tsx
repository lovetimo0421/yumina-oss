import type { StateValidationAudit } from "@yumina/shared";

const copy = {
  en: ["Before correction", "After correction", "Original response was not saved for this older call.", "No correction was needed.", "View technical details", "View original output", "View corrected output", "The reply did not include the required update confirmation.", "The update confirmation did not match the instructions.", "Some update instructions could not be read safely.", "The correction did not pass validation. No changes from it were applied.", "The check could not finish. See technical details.", "The model explicitly requested no updates.", "These are requested operations, not proof that they were applied.", "No readable structured update list was found. The original text is available below.", "set to", "increase by", "decrease by", "multiply by", "switch on/off", "append", "merge", "add item", "delete", "Output preview shortened.", "The model did not provide any output.", "Variable", "Recorded value changes"],
  zh: ["修正前", "修正后", "此旧调用未保存原始回复。", "无需修正。", "查看技术详情", "查看原始输出", "查看修正输出", "回复缺少必需的更新确认标记。", "更新确认与指令不一致。", "部分更新指令无法安全读取。", "修正未通过验证，其中的更改未应用。", "检查未能完成，请查看技术详情。", "模型明确表示无需更新。", "以下是请求的操作，不代表已应用。", "未找到可读的结构化更新列表，可在下方查看原文。", "设置为", "增加", "减少", "乘以", "切换开关", "追加", "合并", "添加项目", "删除", "输出预览已缩短。", "模型未返回任何输出。", "变量", "已记录的数值变化"],
  "zh-Hant": ["修正前", "修正後", "此舊呼叫未儲存原始回覆。", "無需修正。", "檢視技術詳情", "檢視原始輸出", "檢視修正輸出", "回覆缺少必要的更新確認標記。", "更新確認與指令不一致。", "部分更新指令無法安全讀取。", "修正未通過驗證，其中的變更未套用。", "檢查未能完成，請檢視技術詳情。", "模型明確表示無需更新。", "以下是請求的操作，不代表已套用。", "未找到可讀的結構化更新清單，可在下方檢視原文。", "設為", "增加", "減少", "乘以", "切換開關", "附加", "合併", "新增項目", "刪除", "輸出預覽已縮短。", "模型未傳回任何輸出。", "變數", "已記錄的數值變化"],
  ja: ["修正前", "修正後", "この古い呼び出しの元の返信は保存されていません。", "修正は不要でした。", "技術的な詳細", "元の出力を表示", "修正出力を表示", "返信に必要な更新確認がありませんでした。", "更新確認と指示が一致しませんでした。", "一部の更新指示を安全に読み取れませんでした。", "修正は検証に失敗しました。その変更は適用されていません。", "確認を完了できませんでした。詳細をご覧ください。", "モデルは更新なしと明示しました。", "要求された操作です。適用済みとは限りません。", "読み取れる更新リストがありません。元のテキストは下に表示できます。", "設定", "増加", "減少", "乗算", "オン・オフ切替", "追記", "結合", "項目追加", "削除", "出力プレビューは省略されています。", "モデルから出力がありませんでした。", "変数", "記録された値の変更"],
  es: ["Antes de corregir", "Después de corregir", "No se guardó la respuesta original de esta llamada antigua.", "No se necesitó corrección.", "Ver detalles técnicos", "Ver salida original", "Ver salida corregida", "Faltaba la confirmación de actualización requerida.", "La confirmación no coincidía con las instrucciones.", "No se pudieron leer algunas instrucciones de forma segura.", "La corrección no superó la validación. Sus cambios no se aplicaron.", "No se pudo completar la comprobación. Consulta los detalles.", "El modelo indicó explícitamente que no había cambios.", "Son operaciones solicitadas, no prueba de que se aplicaran.", "No se encontró una lista legible de cambios. El texto original está disponible abajo.", "establecer en", "aumentar en", "reducir en", "multiplicar por", "alternar", "añadir texto", "combinar", "añadir elemento", "eliminar", "Vista previa abreviada.", "El modelo no devolvió ninguna salida.", "Variable", "Cambios de valores registrados"],
} as const;

function languageKey(language = "en") {
  return /^zh-(Hant|TW)/.test(language) ? "zh-Hant" : language.startsWith("zh") ? "zh" : language.startsWith("ja") ? "ja" : language.startsWith("es") ? "es" : "en";
}
export function readableLabels(language = "en") {
  return copy[languageKey(language)];
}

const checkCopy = {
  en: ["Original reply", "Original reply passed validation.", "Recognized update commands", "No correction model was called.", "No correction was performed."],
  zh: ["原始回复", "原始回复已通过验证。", "已识别的更新指令", "未调用修正模型。", "未执行修正。"],
  "zh-Hant": ["原始回覆", "原始回覆已通過驗證。", "已識別的更新指令", "未呼叫修正模型。", "未執行修正。"],
  ja: ["元の返信", "元の返信は検証に合格しました。", "認識された更新コマンド", "修正モデルは呼び出されていません。", "修正は実行されていません。"],
  es: ["Respuesta original", "La respuesta original superó la validación.", "Comandos de actualización reconocidos", "No se llamó al modelo de corrección.", "No se realizó ninguna corrección."],
} as const;
export function diagnosticSummary(codes: string[], language?: string): string[] {
  const text = readableLabels(language);
  return [...new Set(codes.map((code) => text[code === "missing_receipt" ? 7 : /receipt|count_mismatch/.test(code) ? 8 : code === "invalid_correction" ? 10 : /malformed|invalid_|unknown_|unsafe_|type_|json|patch|value|writable|contradictory|state_changes|colon|no_update/.test(code) ? 9 : 11]))];
}
export function variableLabel(id: string, names?: Record<string, string>, language?: string): string {
  const root = id.split(/[.\[]/, 1)[0]!;
  const name = names && Object.hasOwn(names, root) ? names[root] : undefined;
  if (name) return name + id.slice(root.length);
  return /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(root) ? `${readableLabels(language)[26]} ${root.slice(0, 8)}${id.slice(root.length)}` : id;
}
type Operation = { variableId: string; operation: string; value?: unknown };
/** Display only. Never repair/execute model output or infer historic state values. */
export function readableBatch(raw: string): { operations: Operation[]; none: boolean; truncated?: boolean } | null {
  try {
    const trimmed = raw.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, "$1");
    const data = JSON.parse(trimmed);
    if (!data || typeof data !== "object" || !Object.hasOwn(data, "stateChanges")) return null;
    const batch = data.stateChanges;
    if (!batch || typeof batch !== "object") return null;
    const operations = Array.isArray(batch) ? batch : Object.entries(batch).map(([variableId, value]) => ({ variableId, operation: "set", value }));
    if (!operations.every((op: unknown) => {
      if (!op || typeof op !== "object") return false;
      const row = op as Operation;
      return typeof row.variableId === "string" && Object.hasOwn(operationIndexes, row.operation) && (row.operation === "toggle" || row.operation === "delete" || Object.hasOwn(row, "value"));
    })) return null;
    if (!operations.length && data.status !== "none") return null;
    if (operations.length && data.status === "none") return null;
    return { operations: operations.slice(0, 100), none: !operations.length, ...(operations.length > 100 ? { truncated: true } : {}) };
  } catch { return null; }
}
const operationIndexes: Record<string, number> = { set: 15, add: 16, subtract: 17, multiply: 18, toggle: 19, append: 20, merge: 21, push: 22, delete: 23 };
function valueText(value: unknown) { return typeof value === "string" ? value : JSON.stringify(value, null, 2); }
function prettyRaw(raw: string) { try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; } }

export function OutputComparison({ audit, language }: { audit: StateValidationAudit; language?: string }) {
  const text = readableLabels(language);
  const check = checkCopy[languageKey(language)];
  const attemptedCorrection = audit.correctionCount > 0;
  // The server audit, not this JSON-only display helper, determines validity.
  // Legacy bracket commands are valid too; don't revalidate historical output here.
  const originalPassed = !attemptedCorrection && (audit.outcome === "valid-updates" || audit.outcome === "explicit-none");
  return <div className="space-y-4">{(attemptedCorrection ? [false, true] : [false]).map((corrected) => {
    const raw = corrected ? audit.correctedBatch : audit.originalRaw;
    const parsed = raw ? readableBatch(raw) : null;
    return <section key={String(corrected)} className="space-y-3 rounded-xl border border-white/15 p-4">
      <h4 className="font-semibold">{attemptedCorrection ? text[corrected ? 1 : 0] : check[0]}</h4>
      {!attemptedCorrection && <div className="space-y-2 text-white/70">
        {originalPassed && <p>{check[1]} {audit.outcome === "explicit-none" ? text[12] : `${check[2]}: ${audit.parsedCount}.`}</p>}
        <p>{check[originalPassed ? 3 : 4]}</p>
      </div>}
      {!corrected && diagnosticSummary(audit.diagnostics, language).map((message) => <p key={message} className="text-amber-300">{message}</p>)}
      {raw === undefined ? <p className="text-white/70">{text[corrected ? 25 : 2]}</p> : <>
        {(!originalPassed || (parsed && !parsed.none)) && <p className="text-white/70">{parsed?.none ? text[12] : parsed ? text[13] : raw ? text[14] : text[25]}</p>}
        {parsed && <ul className="space-y-2">{parsed.operations.map((op, i) => <li key={i} className="break-words">
          <span className="font-medium">{variableLabel(op.variableId, audit.variableNames, language)}</span>: {text[operationIndexes[op.operation]!]}{op.value !== undefined && <span className="whitespace-pre-wrap break-words"> {valueText(op.value)}</span>}
        </li>)}</ul>}
        {parsed?.truncated && <p className="text-amber-300">{text[24]}</p>}
        <details><summary className="cursor-pointer py-3 text-white/70 focus-visible:outline focus-visible:outline-2">{text[corrected ? 6 : 5]}</summary>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-white/5 p-3 text-xs">{prettyRaw(raw)}</pre>
        </details>
        {!corrected && audit.originalRawTruncated && <p className="text-amber-300">{text[24]}</p>}
      </>}
    </section>;
  })}</div>;
}
