/** Shared by the app settings and the isolated chat iframe. */
const en = {
  compactUse: "Use this model", compactRetry: "Retry", compactCancel: "Cancel", compactOptions: "Options & pricing", compactBilling: "This turn is billed at the selected model’s rate.", compactSave: "Save & continue",
  title: "{{model}} is temporarily unavailable",
  failed: "The backup model could not finish either",
  body: "No reply was generated. Retry your model, or choose another for this turn.",
  stopped: "Generation paused",
  stoppedBody: "Your settings prevent automatic model changes. You can choose how to continue below.",
  failedBody: "Automatic retries have stopped. You can retry your original model or choose another yourself.",
  backup: "Backup model", choose: "Choose another model", empty: "Choose a backup model",
  remember: "Don't ask again; automatically use this backup model",
  rememberHint: "Change this in Settings → Generation → Backup model.",
  once: "Use for this turn", save: "Enable automatic switching & continue",
  retry: "Retry {{model}}", cancel: "Cancel this turn",
  billing: "Billed at the backup model's actual token usage. Its price and writing style may differ.",
  privateBilling: "Your API key pays for the backup model's usage. Its price and writing style may differ.",
  onlyTurn: "This turn only · Your original model stays selected",
  switching: "Using {{model}} for this turn",
  switchingBody: "Your original model stays selected for the next turn.",
  stop: "Stop generating", details: "Price & switching details",
  average: "Typical reply: {{cost}} mushies", averageNote: "Historical average, not an estimate for this turn.",
  priceUnknown: "A reliable price estimate is unavailable. Billing follows actual usage.",
  settingsTitle: "Backup model", settingsBody: "Decide what happens when your selected model cannot respond.",
  mode: "When the selected model is unavailable", ask: "Ask every time", auto: "Use my backup automatically", stopMode: "Stop and notify me",
  autoNote: "One automatic backup attempt per turn. Model changes are always shown in the conversation.",
  keyNote: "Private-model authorization applies only to the current API key.",
  sameModel: "Choose a different model to continue with a backup.",
  waiting: "Resolve this turn above before sending…",
  badge: "Backup this turn",
  record: "Originally {{model}}. You confirmed using another model for this turn.",
  autoRecord: "Originally {{model}}. Your saved backup preference authorized this switch.",
  original: "Original model", current: "Backup model",
};
type Copy = Record<keyof typeof en, string>;
const zh: Copy = {
  compactUse: "换用此模型", compactRetry: "重试", compactCancel: "取消", compactOptions: "选项与费用", compactBilling: "本轮按所选模型计费", compactSave: "保存并继续",
  title: "{{model}} 暂时不可用", failed: "备用模型也未能完成回复",
  body: "本轮还没有生成回复。你可以重试原模型，或选择另一个模型继续。",
  stopped: "本轮生成已暂停", stoppedBody: "你设置了不自动切换模型，可以在下方选择如何继续。",
  failedBody: "已停止自动重试。你可以重试原模型，或自行选择其他模型。",
  backup: "备用模型", choose: "选择其他模型", empty: "选择备用模型",
  remember: "以后不再询问，自动使用此备用模型", rememberHint: "可在「设置 → 生成设置 → 备用模型」中修改。",
  once: "仅本轮使用，继续生成", save: "开启自动切换并继续", retry: "重试 {{model}}", cancel: "取消本轮",
  billing: "按备用模型的实际 token 用量计费，价格和回复风格可能与原模型不同。",
  privateBilling: "备用模型的用量由你的 API 密钥支付，价格和回复风格可能不同。",
  onlyTurn: "仅本轮生效 · 原模型选择已保留", switching: "本轮正在使用 {{model}}", switchingBody: "下轮仍会优先使用你原来选择的模型。",
  stop: "停止生成", details: "费用与切换说明", average: "历史平均每轮约 {{cost}} 蘑菇",
  averageNote: "历史均值，不代表本轮预计费用。", priceUnknown: "暂无可靠费用预估，按实际用量计费。",
  settingsTitle: "备用模型", settingsBody: "决定原模型无法响应时如何继续。", mode: "原模型不可用时",
  ask: "每次询问", auto: "自动使用备用模型", stopMode: "停止并提示",
  autoNote: "每轮最多自动尝试一个备用模型，聊天中始终显示实际切换情况。",
  keyNote: "自备模型的自动授权仅适用于当前 API 密钥。", sameModel: "请选择与原模型不同的备用模型。",
  waiting: "先处理上方本轮请求，再继续发送…", badge: "本轮备用",
  record: "原选 {{model}}，经你确认，本轮使用了备用模型。", autoRecord: "原选 {{model}}，依据你保存的备用模型设置自动切换。",
  original: "原模型", current: "备用模型",
};
const hant: Copy = {
  compactUse: "改用此模型", compactRetry: "重試", compactCancel: "取消", compactOptions: "選項與費用", compactBilling: "本輪按所選模型計費", compactSave: "儲存並繼續",
  title: "{{model}} 暫時無法使用", failed: "備用模型也未能完成回覆",
  body: "本輪尚未生成回覆。你可以重試原模型，或選擇另一個模型繼續。",
  stopped: "本輪生成已暫停", stoppedBody: "你設定了不自動切換模型，可在下方選擇如何繼續。", failedBody: "已停止自動重試。你可以重試原模型，或自行選擇其他模型。",
  backup: "備用模型", choose: "選擇其他模型", empty: "選擇備用模型", remember: "以後不再詢問，自動使用此備用模型", rememberHint: "可在「設定 → 生成設定 → 備用模型」中修改。",
  once: "僅本輪使用，繼續生成", save: "開啟自動切換並繼續", retry: "重試 {{model}}", cancel: "取消本輪",
  billing: "按備用模型的實際 token 用量計費，價格與回覆風格可能與原模型不同。", privateBilling: "備用模型的用量由你的 API 金鑰支付，價格與回覆風格可能不同。",
  onlyTurn: "僅本輪生效 · 原模型選擇已保留", switching: "本輪正在使用 {{model}}", switchingBody: "下一輪仍會優先使用你原來選擇的模型。", stop: "停止生成", details: "費用與切換說明",
  average: "歷史平均每輪約 {{cost}} 蘑菇", averageNote: "歷史均值，不代表本輪預計費用。", priceUnknown: "暫無可靠費用預估，按實際用量計費。",
  settingsTitle: "備用模型", settingsBody: "決定原模型無法回應時如何繼續。", mode: "原模型無法使用時", ask: "每次詢問", auto: "自動使用備用模型", stopMode: "停止並提示",
  autoNote: "每輪最多自動嘗試一個備用模型，聊天中始終顯示實際切換情況。", keyNote: "自備模型的自動授權僅適用於目前的 API 金鑰。", sameModel: "請選擇與原模型不同的備用模型。",
  waiting: "先處理上方本輪請求，再繼續傳送…", badge: "本輪備用", record: "原選 {{model}}，經你確認，本輪使用了備用模型。", autoRecord: "原選 {{model}}，依據你儲存的備用模型設定自動切換。", original: "原模型", current: "備用模型",
};
const ja: Copy = {
  compactUse: "このモデルを使う", compactRetry: "再試行", compactCancel: "キャンセル", compactOptions: "設定と料金", compactBilling: "このターンは選択したモデルの料金が適用されます。", compactSave: "保存して続行",
  title: "{{model}} は現在利用できません", failed: "代替モデルも応答を完了できませんでした", body: "返信はまだ生成されていません。元のモデルで再試行するか、このターンで使う別のモデルを選べます。",
  stopped: "生成を一時停止しました", stoppedBody: "設定により自動切り替えを停止しました。続行方法を選んでください。", failedBody: "自動再試行を停止しました。元のモデルで再試行するか、別のモデルを選べます。",
  backup: "代替モデル", choose: "別のモデルを選ぶ", empty: "代替モデルを選択", remember: "次回から確認せず、この代替モデルを使用する", rememberHint: "「設定 → 生成設定 → 代替モデル」で変更できます。",
  once: "このターンで使用", save: "自動切り替えを有効にして続行", retry: "{{model}} で再試行", cancel: "このターンをキャンセル", billing: "代替モデルの実際のトークン使用量に応じて課金されます。料金や文体が変わる場合があります。", privateBilling: "代替モデルの使用料はお使いの API キーで支払います。料金や文体が変わる場合があります。",
  onlyTurn: "このターンのみ · 元のモデルの選択は維持", switching: "このターンは {{model}} を使用中", switchingBody: "次のターンでは元のモデルを優先します。", stop: "生成を停止", details: "料金と切り替えの詳細", average: "過去の平均：{{cost}} マッシュ／ターン", averageNote: "過去の平均であり、今回の見積もりではありません。", priceUnknown: "信頼できる料金見積もりはありません。実際の使用量で課金されます。",
  settingsTitle: "代替モデル", settingsBody: "選択したモデルが応答できない場合の動作を設定します。", mode: "モデルが利用できない場合", ask: "毎回確認する", auto: "代替モデルを自動使用", stopMode: "停止して通知", autoNote: "自動試行は各ターン1つの代替モデルまでです。切り替えは常にチャットに表示します。", keyNote: "プライベートモデルの許可は現在の API キーにのみ適用されます。", sameModel: "元のモデルとは異なる代替モデルを選んでください。", waiting: "上のリクエストを処理してから送信してください…", badge: "このターンの代替", record: "元の選択：{{model}}。確認に基づき、このターンで代替モデルを使用しました。", autoRecord: "元の選択：{{model}}。保存された設定に従い自動で切り替えました。", original: "元のモデル", current: "代替モデル",
};
const es: Copy = {
  compactUse: "Usar este modelo", compactRetry: "Reintentar", compactCancel: "Cancelar", compactOptions: "Opciones y precio", compactBilling: "Este turno usa la tarifa del modelo elegido.", compactSave: "Guardar y continuar",
  title: "{{model}} no está disponible temporalmente", failed: "El modelo de respaldo tampoco pudo terminar", body: "No se generó una respuesta. Reintenta con tu modelo o elige otro para este turno.", stopped: "Generación pausada", stoppedBody: "Tus ajustes impiden cambiar de modelo automáticamente. Elige cómo continuar.", failedBody: "Los reintentos automáticos se detuvieron. Puedes reintentar con el modelo original o elegir otro.",
  backup: "Modelo de respaldo", choose: "Elegir otro modelo", empty: "Elegir modelo de respaldo", remember: "No volver a preguntar; usar este modelo automáticamente", rememberHint: "Puedes cambiarlo en Ajustes → Generación → Modelo de respaldo.", once: "Usar solo en este turno", save: "Activar cambio automático y continuar", retry: "Reintentar {{model}}", cancel: "Cancelar este turno", billing: "Se cobra según los tokens reales del modelo de respaldo. El precio y el estilo pueden ser diferentes.", privateBilling: "Tu clave API paga el uso del modelo de respaldo. El precio y el estilo pueden variar.", onlyTurn: "Solo este turno · Se conserva tu modelo original", switching: "Usando {{model}} en este turno", switchingBody: "El próximo turno intentará usar tu modelo original.", stop: "Detener generación", details: "Precio y detalles del cambio", average: "Promedio por respuesta: {{cost}} hongos", averageNote: "Promedio histórico, no una estimación de este turno.", priceUnknown: "No hay una estimación fiable del precio. Se factura el uso real.", settingsTitle: "Modelo de respaldo", settingsBody: "Decide qué hacer cuando el modelo seleccionado no pueda responder.", mode: "Si el modelo no está disponible", ask: "Preguntar cada vez", auto: "Usar mi respaldo automáticamente", stopMode: "Detener y avisar", autoNote: "Un intento automático de respaldo por turno. Los cambios siempre aparecen en el chat.", keyNote: "La autorización del modelo privado solo se aplica a la clave API actual.", sameModel: "Elige un modelo de respaldo distinto del original.", waiting: "Resuelve la solicitud de arriba antes de enviar…", badge: "Respaldo de este turno", record: "Original: {{model}}. Confirmaste usar otro modelo en este turno.", autoRecord: "Original: {{model}}. Tus ajustes guardados autorizaron el cambio.", original: "Modelo original", current: "Modelo de respaldo",
};

export function modelFallbackText(language: string | undefined, key: keyof Copy, values: Record<string, string | number> = {}): string {
  const lang = (language ?? "en").toLowerCase();
  const copy = /zh-(hant|tw|hk)/.test(lang) ? hant : lang.startsWith("zh") ? zh : lang.startsWith("ja") ? ja : lang.startsWith("es") ? es : en;
  return copy[key].replace(/\{\{(\w+)\}\}/g, (match, name: string) => String(values[name] ?? match));
}
