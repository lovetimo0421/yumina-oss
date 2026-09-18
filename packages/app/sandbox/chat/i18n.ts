// ─── Sandbox chat i18n ──────────────────────────────────────────────
//
// The sandbox runs in its own iframe and doesn't share the host's i18next
// instance — it only receives the active language code via the UI channel
// (see UIChannelData.language). This module keeps a local 4-language string
// table so the chat composer, message actions, swipe controls and bubbles
// render in the player's language instead of falling back to English.
//
// Wording is kept in sync with the host's `chat.json` (en/zh/ja/es) so the
// in-iframe UI matches the rest of the app. There is no static checking
// across this boundary — if you add UI text, add all four languages here.

export type SandboxLang = "en" | "zh" | "ja" | "es";

export function pickLang(language: string | undefined): SandboxLang {
  const l = (language ?? "en").toLowerCase();
  if (l.startsWith("zh")) return "zh";
  if (l.startsWith("ja")) return "ja";
  if (l.startsWith("es")) return "es";
  return "en";
}

type Dict = Record<string, string>;

// Provider safety-filter refusals arrive as raw English text ("Response
// blocked by safety/content filter…", "…PROHIBITED_CONTENT", OpenAI
// "content_filter", Alibaba "inappropriate content"). Classify them so the
// bubble can show a localized explanation instead of the raw English line.
// Mirrors the host-side classifier in src/lib/chat-errors.ts — the sandbox
// iframe can't import host modules, so keep the two patterns in sync.
// Deliberately narrow: a match REPLACES the error text the user sees, so bare
// words like "safety" or "flagged" (which can appear in non-refusal provider
// errors) must not match here.
const CONTENT_BLOCK_PATTERN =
  /prohibited[_\s-]?content|content[_\s-]?filter|blocked by safety|safety filter|content moderation|inappropriate content|flagged as/i;

export function isContentBlockedError(message: string | null | undefined): boolean {
  return !!message && CONTENT_BLOCK_PATTERN.test(message);
}

/**
 * The server stores a failure as `"[CODE] human readable text"` (see
 * server/src/lib/turn-failure.ts). The code is what the UI branches on — it
 * decides whether "retry" is even useful — while the text is the fallback for
 * codes this build doesn't know about yet.
 */
export function parseFailureCode(errorMessage: string | null | undefined): {
  code: string | null;
  text: string;
} {
  if (!errorMessage) return { code: null, text: "" };
  const match = errorMessage.match(/^\[([A-Z_]+)\]\s*(.*)$/s);
  if (!match) return { code: null, text: errorMessage };
  return { code: match[1]!, text: match[2] ?? "" };
}

/** Cheapest model with a proven-low failure rate; the target of the one-tap
 *  "switch model" action offered when the free pool is exhausted. */
export const FALLBACK_MODEL_ID = "google/gemini-3.1-flash-lite";

const en: Dict = {
  // composer placeholders + toolbar
  generating: "Generating...",
  choiceHint: "Pick a choice above, or type your own action...",
  placeholder: "Type whatever you want to do in this world!",
  dismissChoices: "Dismiss choices",
  actions: "Actions",
  continue: "Continue",
  restartChat: "Restart chat",
  persona: "Persona",
  sharePlaythrough: "Share playthrough",
  stopGeneration: "Stop generation",
  sendMessage: "Send message",
  // compact mobile tool menu (model + extensions)
  toolsMenu: "Model & extensions",
  toolsMenuHint: "Choose what to open",
  modelLabel: "Model",
  extensionsLabel: "Extensions",
  // restart confirmation
  restartBanner: "This will clear all messages and restart the chat. Are you sure?",
  restart: "Restart",
  cancel: "Cancel",
  chatRestarted: "Chat restarted",
  // time-ago
  timeJustNow: "just now",
  timeMinAgo: "{{n}}m ago",
  timeHourAgo: "{{n}}h ago",
  timeDayAgo: "{{n}}d ago",
  // branch panel
  branches: "Branches",
  branchCurrent: "Current",
  branchParent: "Parent",
  branchSiblings: "Siblings",
  branchChildren: "Children",
  branchFromLatest: "Branch from latest message",
  branchFromHere: "Branch from here",
  openManager: "Open session manager",
  branchEmpty: "No other branches yet.",
  branchLoading: "Loading branches...",
  branchFailed: "Couldn't load branches.",
  msgs: "msgs",
  untitledBranch: "Untitled branch",
  // message actions
  copy: "Copy",
  edit: "Edit",
  regenerate: "Regenerate",
  revertToHere: "Revert to here",
  delete: "Delete",
  deleteThisMessage: "Delete this message?",
  deleteWarning: "This action cannot be undone.",
  confirmDelete: "Delete",
  revertThisMessage: "Revert to this message?",
  revertWarning: "All messages after this will be deleted.",
  confirmRevert: "Revert",
  revertedToHere: "Reverted to this message",
  failedDelete: "Failed to delete message",
  failedRevert: "Failed to revert",
  failedBranch: "Failed to branch",
  failedEdit: "Failed to edit message",
  // swipe controls
  failedSwitchVariant: "Failed to switch message variant",
  previousResponse: "Previous response",
  nextResponse: "Next response",
  generateNew: "Generate new response",
  lastResponse: "Last response",
  // message list
  startConversation: "Start the conversation...",
  showEarlier: "Show {{count}} earlier messages",
  hideEarlier: "Hide {{count}} earlier messages",
  loadEarlier: "Load earlier messages",
  loadingEarlier: "Loading earlier messages...",
  loadEarlierFailed: "Couldn't load earlier messages. Retry",
  // bubble
  generationFailed: "AI response failed. Please try again later.",
  contentBlocked: "The model's safety filter blocked this response. Some prompts can trigger it — regenerating may pass, or try a different model.",
  freePoolExhausted: "Yumina Free has hit its daily limit upstream. Switch models to keep playing — your story is saved.",
  turnInterrupted: "The connection dropped before the reply arrived. Tap retry to generate it again.",
  upstreamBusy: "The model provider is busy right now. Retry in a moment, or switch models.",
  retryTurn: "Retry",
  switchModel: "Switch model",
  you: "You",
  narrator: "Narrator",
  thinking: "Thinking",
  showRawOutput: "View raw output",
  hideRawOutput: "Hide raw output",
  tokensTooltip: "{{count}} tokens (prompt + generation, from provider)",
};

const zh: Dict = {
  generating: "生成中...",
  choiceHint: "在上方选择一个选项，或输入你的操作...",
  placeholder: "输入你想在这个世界中做的任何事！",
  dismissChoices: "关闭选项",
  actions: "操作",
  continue: "继续",
  restartChat: "重新开始",
  persona: "人设",
  sharePlaythrough: "分享游玩",
  stopGeneration: "停止生成",
  sendMessage: "发送消息",
  toolsMenu: "模型与扩展",
  toolsMenuHint: "选择要打开的功能",
  modelLabel: "模型",
  extensionsLabel: "扩展",
  restartBanner: "这将清除所有消息并重新开始聊天，确定吗？",
  restart: "重新开始",
  cancel: "取消",
  chatRestarted: "聊天已重新开始",
  timeJustNow: "刚刚",
  timeMinAgo: "{{n}}分钟前",
  timeHourAgo: "{{n}}小时前",
  timeDayAgo: "{{n}}天前",
  branches: "分支",
  branchCurrent: "当前分支",
  branchParent: "父分支",
  branchSiblings: "并列分支",
  branchChildren: "子分支",
  branchFromLatest: "从最新消息开新分支",
  branchFromHere: "从此处开新分支",
  openManager: "打开会话管理器",
  branchEmpty: "暂无其他分支。",
  branchLoading: "加载分支中...",
  branchFailed: "无法加载分支。",
  msgs: "条消息",
  untitledBranch: "未命名分支",
  copy: "复制",
  edit: "编辑",
  regenerate: "重新生成",
  revertToHere: "恢复到此处",
  delete: "删除",
  deleteThisMessage: "删除此消息？",
  deleteWarning: "此操作无法撤销。",
  confirmDelete: "删除",
  revertThisMessage: "恢复到此消息？",
  revertWarning: "此消息之后的所有消息将被删除。",
  confirmRevert: "恢复",
  revertedToHere: "已恢复到此消息",
  failedDelete: "删除消息失败",
  failedRevert: "恢复失败",
  failedBranch: "创建分支失败",
  failedEdit: "编辑消息失败",
  failedSwitchVariant: "切换消息版本失败",
  previousResponse: "上一个回复",
  nextResponse: "下一个回复",
  generateNew: "生成新回复",
  lastResponse: "最后一个回复",
  startConversation: "开始对话...",
  showEarlier: "显示 {{count}} 条早期消息",
  hideEarlier: "隐藏 {{count}} 条早期消息",
  loadEarlier: "加载更早的消息",
  loadingEarlier: "正在加载更早的消息...",
  loadEarlierFailed: "无法加载更早的消息，点击重试",
  generationFailed: "AI 响应失败，请稍后重试。",
  contentBlocked: "模型的安全过滤拦截了这次回复。部分提示词可能触发过滤——重新生成有机会通过，也可以更换其他模型。",
  freePoolExhausted: "Yumina Free 今日的上游额度已用完。换一个模型即可继续——你的剧情已保存。",
  turnInterrupted: "回复还没送达，连接就断了。点击重试可以重新生成。",
  upstreamBusy: "模型服务商正忙。稍等片刻重试，或更换其他模型。",
  retryTurn: "重试",
  switchModel: "更换模型",
  you: "你",
  narrator: "旁白",
  thinking: "思考中",
  showRawOutput: "查看原始输出",
  hideRawOutput: "隐藏原始输出",
  tokensTooltip: "{{count}} tokens（提示词 + 生成，来自提供商）",
};

const ja: Dict = {
  generating: "生成中...",
  choiceHint: "上から選択肢を選ぶか、自分の行動を入力してください...",
  placeholder: "この世界でやりたいことを自由に入力!",
  dismissChoices: "選択肢を閉じる",
  actions: "アクション",
  continue: "続行",
  restartChat: "チャットを再開",
  persona: "ペルソナ",
  sharePlaythrough: "プレイを共有",
  stopGeneration: "生成を停止",
  sendMessage: "メッセージを送信",
  toolsMenu: "モデルと拡張機能",
  toolsMenuHint: "開く機能を選択",
  modelLabel: "モデル",
  extensionsLabel: "拡張機能",
  restartBanner: "すべてのメッセージを消去してチャットを再開します。よろしいですか?",
  restart: "再開",
  cancel: "キャンセル",
  chatRestarted: "チャットを再開しました",
  timeJustNow: "たった今",
  timeMinAgo: "{{n}}分前",
  timeHourAgo: "{{n}}時間前",
  timeDayAgo: "{{n}}日前",
  branches: "分岐",
  branchCurrent: "現在",
  branchParent: "親",
  branchSiblings: "兄弟",
  branchChildren: "子",
  branchFromLatest: "最新メッセージから分岐",
  branchFromHere: "ここから分岐",
  openManager: "セッションマネージャーを開く",
  branchEmpty: "他の分岐はまだありません。",
  branchLoading: "分岐を読み込み中...",
  branchFailed: "分岐を読み込めませんでした。",
  msgs: "メッセージ",
  untitledBranch: "無題の分岐",
  copy: "コピー",
  edit: "編集",
  regenerate: "再生成",
  revertToHere: "ここまで戻す",
  delete: "削除",
  deleteThisMessage: "このメッセージを削除しますか?",
  deleteWarning: "この操作は取り消せません。",
  confirmDelete: "削除",
  revertThisMessage: "このメッセージまで戻しますか?",
  revertWarning: "これ以降のすべてのメッセージが削除されます。",
  confirmRevert: "戻す",
  revertedToHere: "このメッセージまで戻しました",
  failedDelete: "メッセージの削除に失敗しました",
  failedRevert: "復元に失敗しました",
  failedBranch: "分岐の作成に失敗しました",
  failedEdit: "メッセージの編集に失敗しました",
  failedSwitchVariant: "メッセージのバリエーション切り替えに失敗しました",
  previousResponse: "前の応答",
  nextResponse: "次の応答",
  generateNew: "新しい応答を生成",
  lastResponse: "最後の応答",
  startConversation: "会話を始めましょう...",
  showEarlier: "以前の {{count}} 件のメッセージを表示",
  hideEarlier: "以前の {{count}} 件のメッセージを隠す",
  loadEarlier: "さらに前のメッセージを読み込む",
  loadingEarlier: "前のメッセージを読み込み中...",
  loadEarlierFailed: "以前のメッセージを読み込めませんでした。再試行",
  generationFailed: "AI の応答に失敗しました。しばらくしてからもう一度お試しください。",
  contentBlocked: "モデルの安全フィルターにより応答がブロックされました。特定のプロンプトで発生することがあり、再生成で通る場合もあります。別のモデルもお試しください。",
  freePoolExhausted: "Yumina Free の本日の上流利用枠を使い切りました。モデルを切り替えれば続行できます。ストーリーは保存済みです。",
  turnInterrupted: "返信が届く前に接続が切れました。再試行をタップすると生成し直せます。",
  upstreamBusy: "モデルプロバイダーが混み合っています。少し待って再試行するか、別のモデルをお試しください。",
  retryTurn: "再試行",
  switchModel: "モデルを変更",
  you: "あなた",
  narrator: "ナレーター",
  thinking: "思考中",
  showRawOutput: "生の出力を表示",
  hideRawOutput: "生の出力を隠す",
  tokensTooltip: "{{count}} トークン（プロンプト + 生成、プロバイダー提供）",
};

const es: Dict = {
  generating: "Generando...",
  choiceHint: "Elige una opción arriba o escribe tu propia acción...",
  placeholder: "¡Escribe lo que quieras hacer en este mundo!",
  dismissChoices: "Descartar opciones",
  actions: "Acciones",
  continue: "Continuar",
  restartChat: "Reiniciar chat",
  persona: "Persona",
  sharePlaythrough: "Compartir partida",
  stopGeneration: "Detener generación",
  sendMessage: "Enviar mensaje",
  toolsMenu: "Modelo y extensiones",
  toolsMenuHint: "Elige qué abrir",
  modelLabel: "Modelo",
  extensionsLabel: "Extensiones",
  restartBanner: "Esto borrará todos los mensajes y reiniciará el chat. ¿Estás seguro?",
  restart: "Reiniciar",
  cancel: "Cancelar",
  chatRestarted: "Chat reiniciado",
  timeJustNow: "ahora",
  timeMinAgo: "hace {{n}} min",
  timeHourAgo: "hace {{n}} h",
  timeDayAgo: "hace {{n}} d",
  branches: "Ramas",
  branchCurrent: "Actual",
  branchParent: "Padre",
  branchSiblings: "Hermanos",
  branchChildren: "Hijos",
  branchFromLatest: "Ramificar desde el último mensaje",
  branchFromHere: "Ramificar desde aquí",
  openManager: "Abrir gestor de sesiones",
  branchEmpty: "Aún no hay otras ramas.",
  branchLoading: "Cargando ramas...",
  branchFailed: "No se pudieron cargar las ramas.",
  msgs: "msjs",
  untitledBranch: "Rama sin título",
  copy: "Copiar",
  edit: "Editar",
  regenerate: "Regenerar",
  revertToHere: "Revertir hasta aquí",
  delete: "Eliminar",
  deleteThisMessage: "¿Eliminar este mensaje?",
  deleteWarning: "Esto no se puede deshacer.",
  confirmDelete: "Eliminar",
  revertThisMessage: "¿Revertir a este mensaje?",
  revertWarning: "Se eliminarán todos los mensajes posteriores.",
  confirmRevert: "Revertir",
  revertedToHere: "Revertido a este mensaje",
  failedDelete: "No se pudo eliminar el mensaje",
  failedRevert: "No se pudo revertir",
  failedBranch: "No se pudo ramificar",
  failedEdit: "No se pudo editar el mensaje",
  failedSwitchVariant: "No se pudo cambiar la variante del mensaje",
  previousResponse: "Respuesta anterior",
  nextResponse: "Respuesta siguiente",
  generateNew: "Generar nueva respuesta",
  lastResponse: "Última respuesta",
  startConversation: "Inicia la conversación...",
  showEarlier: "Mostrar {{count}} mensajes anteriores",
  hideEarlier: "Ocultar {{count}} mensajes anteriores",
  loadEarlier: "Cargar mensajes anteriores",
  loadingEarlier: "Cargando mensajes anteriores...",
  loadEarlierFailed: "No se pudieron cargar los mensajes anteriores. Reintentar",
  generationFailed: "La respuesta de la IA falló. Inténtalo de nuevo más tarde.",
  contentBlocked: "El filtro de seguridad del modelo bloqueó esta respuesta. Algunos prompts pueden activarlo: vuelve a generar (puede funcionar) o prueba otro modelo.",
  freePoolExhausted: "Yumina Free alcanzó su límite diario upstream. Cambia de modelo para seguir jugando: tu historia está guardada.",
  turnInterrupted: "La conexión se cortó antes de que llegara la respuesta. Toca reintentar para generarla de nuevo.",
  upstreamBusy: "El proveedor del modelo está saturado. Reintenta en un momento o cambia de modelo.",
  retryTurn: "Reintentar",
  switchModel: "Cambiar modelo",
  you: "Tú",
  narrator: "Narrador",
  thinking: "Pensando",
  showRawOutput: "Ver salida sin procesar",
  hideRawOutput: "Ocultar salida sin procesar",
  tokensTooltip: "{{count}} tokens (prompt + generación, del proveedor)",
};

const STRINGS: Record<SandboxLang, Dict> = { en, zh, ja, es };

export type ChatStringKey = keyof typeof en;

/** Build a translator bound to the active language. Falls back to English for
 *  any key missing in the active language, then to the key itself. */
export function makeChatT(language: string | undefined) {
  const dict = STRINGS[pickLang(language)];
  return (key: ChatStringKey, vars?: Record<string, string | number>): string => {
    let s: string = dict[key] ?? en[key] ?? String(key);
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        s = s.replace(`{{${k}}}`, String(v));
      }
    }
    return s;
  };
}
