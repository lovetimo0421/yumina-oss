import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { X, Search, Star, Clock, Lock, Unlock, Sparkles, ChevronRight, Layers, Shuffle, Plus, Minus, ArrowLeft } from "lucide-react";
import { useModelControls as useYumina } from "./model-controls-context";
import { SandboxPlatformOverlay } from "../platform-overlay-portal";
import { initializeSandboxPlatformOverlay } from "../platform-overlay-root";
import { PLAY_MODELS, PLAN_HIERARCHY as SHARED_PLAN_HIERARCHY, MAX_PINNED_MODELS, formatAvgCost } from "@yumina/shared";
import {
  DeepSeekPricingInfo,
  type DeepSeekPricingCopy,
} from "../../src/features/chat/deepseek-pricing-info";
import {
  ProviderSwitchConfirmDialog,
  ProviderSwitchControl,
  type ProviderSwitchCopy,
} from "@/components/provider-switch-confirm-dialog";

/** Compact mushie-balance formatter: full with thousands separators below
 * 100k, then abbreviated (123k / 1.2M) so the model-pill tag never overflows
 * on large balances. */
function formatBalance(n: number): string {
  const v = Math.floor(n);
  if (v < 100_000) return v.toLocaleString();
  if (v < 1_000_000) return `${Math.round(v / 1_000)}k`;
  const m = v / 1_000_000;
  return `${m >= 10 ? Math.round(m) : Math.round(m * 10) / 10}M`;
}

/** Small mushroom glyph for the mushie currency. Language-agnostic, so the
 * balance pill needs no translated unit word. Inherits color via currentColor. */
function MushroomIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M12 2.5c-5.1 0-9.2 3.6-9.2 8.1 0 1 .8 1.8 1.9 1.8h14.6c1 0 1.9-.8 1.9-1.8 0-4.5-4.1-8.1-9.2-8.1z" />
      <path d="M9.7 13c-.2 0-.4.2-.4.5l.5 5.8c.1 1.3 1.1 2.2 2.2 2.2s2.1-.9 2.2-2.2l.5-5.8c0-.3-.2-.5-.4-.5H9.7z" />
    </svg>
  );
}

// ─── Inline i18n ────────────────────────────────────────────────────
//
// The sandbox runs in its own iframe and doesn't share the host's i18next
// instance, so we keep a tiny local string table here. Host pushes the active
// language code via the UI channel (see UIChannelData.language); we pick zh
// when it starts with "zh", otherwise fall back to en. Keep keys in sync if
// you add UI text — there's no static checking across this boundary.
type Lang = "en" | "zh" | "ja" | "es";
const STRINGS: Record<Lang, Record<string, string>> = {
  en: {
    chooseModel: "Choose Model",
    yuminaApi: "Yumina API",
    privateApiKey: "Private API Key",
    searchModels: "Search models...",
    pinned: "Pinned",
    recent: "Recent",
    allModels: "All Models",
    resultsOne: "{{count}} result",
    resultsMany: "{{count}} results",
    noModelsMatch: "No models match \"{{query}}\"",
    noModelsAvailable: "No models available — connect a key in AI Provider settings",
    upgradeForMore: "Upgrade your plan to unlock more models",
    currentPlan: "Current plan: {{plan}}",
    higherCost: "Costs more credits, especially as context grows larger",
    usageNote: "Token usage increases with context length and number of replies.",
    avgCost: "~{{cost}} mushies/reply",
    avgCostByPeriod: "Peak ~{{peak}} · Off-peak ~{{offPeak}} mushies/reply",
    mushieBalance: "Mushie balance",
    free: "Free",
    mixModels: "Mix Models",
    mixDescription: "Each message randomly picks a model based on these weights.",
    addModel: "Add a model...",
    activate: "Activate Mix Mode",
    deactivate: "Deactivate Mix Mode",
    needTwo: "Add at least 2 models to activate",
    lockWeight: "Lock this ratio",
    unlockWeight: "Unlock this ratio",
    switchToYumina: "Switch to Yumina API?",
    switchToPrivate: "Switch to Private Key?",
    yuminaSwitchDesc: "Future replies will use Yumina models and spend mushies/credits.",
    privateSwitchDesc: "Future replies will use your configured provider key and provider billing.",
    confirmSwitch: "Confirm switch",
    cancel: "Cancel",
    switchFailed: "Could not switch provider. Please try again.",
    pinLimit: "You can pin up to {{max}} models. Unpin one first.",
    deepSeekPricingTrigger: "View DeepSeek pricing notice",
    deepSeekPricingTitle: "DeepSeek pricing",
    deepSeekPricingBody: "Yumina now uses DeepSeek's latest pricing rates. These models are automatically settled using the new rates.",
  },
  zh: {
    chooseModel: "选择模型",
    yuminaApi: "梦坞 API",
    privateApiKey: "私有 API 密钥",
    searchModels: "搜索模型...",
    pinned: "已固定",
    recent: "最近使用",
    allModels: "全部模型",
    resultsOne: "{{count}} 个结果",
    resultsMany: "{{count}} 个结果",
    noModelsMatch: "没有匹配 \"{{query}}\" 的模型",
    noModelsAvailable: "暂无可用模型 — 请到「AI 供应商」设置中绑定一个密钥",
    upgradeForMore: "升级方案以解锁更多模型",
    currentPlan: "当前方案：{{plan}}",
    higherCost: "消耗更多积分，上下文越长费用越高",
    usageNote: "Token 的消耗会跟随上下文/回复次数增加。",
    avgCost: "~{{cost}} 蘑菇币/回复",
    avgCostByPeriod: "峰时 ~{{peak}} · 非峰时 ~{{offPeak}} 蘑菇币/回复",
    mushieBalance: "蘑菇币余额",
    free: "免费",
    mixModels: "混合模型",
    mixDescription: "每条消息根据权重随机选择模型。",
    addModel: "添加模型...",
    activate: "启用混合模式",
    deactivate: "关闭混合模式",
    needTwo: "至少添加 2 个模型才能启用",
    lockWeight: "固定这个占比",
    unlockWeight: "取消固定这个占比",
    pinLimit: "最多只能固定 {{max}} 个模型，先取消一个。",
    deepSeekPricingTrigger: "查看 DeepSeek 收费说明",
    deepSeekPricingTitle: "DeepSeek 收费说明",
    deepSeekPricingBody: "Yumina 已同步采用 DeepSeek 最新的收费费率，相关模型会自动按照新费率结算。",
  },
  ja: {
    chooseModel: "モデルを選択",
    yuminaApi: "Yumina API",
    privateApiKey: "プライベート API キー",
    searchModels: "モデルを検索...",
    pinned: "ピン留め",
    recent: "最近使用",
    allModels: "すべてのモデル",
    resultsOne: "{{count}} 件",
    resultsMany: "{{count}} 件",
    noModelsMatch: "「{{query}}」に一致するモデルはありません",
    noModelsAvailable: "利用可能なモデルがありません — AI プロバイダー設定でキーを接続してください",
    upgradeForMore: "プランをアップグレードしてモデルを解放",
    currentPlan: "現在のプラン：{{plan}}",
    higherCost: "クレジット消費が多く、コンテキストが長いほど高くなります",
    usageNote: "トークン消費はコンテキストの長さと返信数に応じて増加します。",
    avgCost: "~{{cost}} マッシュ/返信",
    avgCostByPeriod: "ピーク ~{{peak}} · オフピーク ~{{offPeak}} マッシュ/返信",
    mushieBalance: "マッシュ残高",
    free: "無料",
    mixModels: "モデルミックス",
    mixDescription: "各メッセージは重みに基づいてランダムにモデルを選択します。",
    addModel: "モデルを追加...",
    activate: "ミックスモードを有効化",
    deactivate: "ミックスモードを無効化",
    needTwo: "有効にするには2つ以上のモデルを追加してください",
    lockWeight: "この比率を固定",
    unlockWeight: "この比率の固定を解除",
    pinLimit: "ピン留めは最大 {{max}} 件です。先に解除してください。",
    switchToYumina: "Yumina APIに切り替えますか？",
    switchToPrivate: "プライベートキーに切り替えますか？",
    yuminaSwitchDesc: "以降の返信はYuminaモデルを使用し、mushies/クレジットを消費します。",
    privateSwitchDesc: "以降の返信は設定したプロバイダーキーを使用し、プロバイダーに課金されます。",
    confirmSwitch: "切り替えを確認",
    cancel: "キャンセル",
    switchFailed: "切り替えに失敗しました。もう一度お試しください。",
    deepSeekPricingTrigger: "DeepSeek の料金について",
    deepSeekPricingTitle: "DeepSeek 料金について",
    deepSeekPricingBody: "Yumina は DeepSeek の最新料金体系を採用しています。対象モデルは新しい料金で自動的に精算されます。",
  },
  es: {
    chooseModel: "Elegir modelo",
    yuminaApi: "Yumina API",
    privateApiKey: "Clave API privada",
    searchModels: "Buscar modelos...",
    pinned: "Fijados",
    recent: "Recientes",
    allModels: "Todos los modelos",
    resultsOne: "{{count}} resultado",
    resultsMany: "{{count}} resultados",
    noModelsMatch: "Ningún modelo coincide con \"{{query}}\"",
    noModelsAvailable: "No hay modelos disponibles — conecta una clave en los ajustes de proveedor de IA",
    upgradeForMore: "Mejora tu plan para desbloquear más modelos",
    currentPlan: "Plan actual: {{plan}}",
    higherCost: "Cuesta más créditos, especialmente con contextos más largos",
    usageNote: "El uso de tokens aumenta con la longitud del contexto y el número de respuestas.",
    avgCost: "~{{cost}} mushies/respuesta",
    avgCostByPeriod: "Punta ~{{peak}} · Fuera de punta ~{{offPeak}} mushies/respuesta",
    mushieBalance: "Saldo de mushies",
    free: "Gratis",
    mixModels: "Mezclar modelos",
    mixDescription: "Cada mensaje elige un modelo aleatoriamente según estos pesos.",
    addModel: "Añadir un modelo...",
    activate: "Activar modo mezcla",
    deactivate: "Desactivar modo mezcla",
    needTwo: "Agrega al menos 2 modelos para activar",
    lockWeight: "Fijar esta proporción",
    unlockWeight: "Desbloquear esta proporción",
    pinLimit: "Puedes fijar hasta {{max}} modelos. Quita uno primero.",
    switchToYumina: "¿Cambiar a Yumina API?",
    switchToPrivate: "¿Cambiar a clave privada?",
    yuminaSwitchDesc: "Las respuestas futuras usarán modelos de Yumina y gastarán mushies/créditos.",
    privateSwitchDesc: "Las respuestas futuras usarán tu clave de proveedor configurada.",
    confirmSwitch: "Confirmar cambio",
    cancel: "Cancelar",
    switchFailed: "No se pudo cambiar el proveedor. Intenta de nuevo.",
    deepSeekPricingTrigger: "Ver aviso de precios de DeepSeek",
    deepSeekPricingTitle: "Precios de DeepSeek",
    deepSeekPricingBody: "Yumina ya utiliza las tarifas más recientes de DeepSeek. Estos modelos se liquidan automáticamente con las nuevas tarifas.",
  },
} as const;

Object.assign(STRINGS.zh, {
  switchToYumina: "切换到 Yumina API？",
  switchToPrivate: "切换到私人密钥？",
  yuminaSwitchDesc: "之后的回复会使用 Yumina 模型，并消耗 mushies/积分。",
  privateSwitchDesc: "之后的回复会使用你配置的供应商密钥，并由供应商计费。",
  confirmSwitch: "确认切换",
  cancel: "取消",
  switchFailed: "切换失败，请重试。",
});

const MODEL_DESCRIPTION_BY_LANG = {
  en: {
    "openrouter/free": "Free for everyone",
    "deepseek/deepseek-v4-flash": "Budget, can drift off-plot",
    "deepseek/deepseek-v3.2": "Low censorship",
    "mistralai/mistral-nemo": "Cheapest — short, snappy replies",
    "mistralai/mistral-small-3.2-24b-instruct": "Fast & cheap, keeps replies tight",
    "nousresearch/hermes-4-70b": "Low censorship, naturally concise",
    "qwen/qwen3-vl-235b-a22b-instruct": "Great value, default",
    "anthropic/claude-3-haiku": "Smart & unrestricted",
    "moonshotai/kimi-k2-0905": "Rivals Pro quality, slower thinking",
    "z-ai/glm-4.6": "200K context, supports reasoning",
    "google/gemini-3.1-flash-lite": "Lightweight, cheap",
    "google/gemini-3.5-flash": "Google's newest model",
    "google/gemini-2.5-pro": "Reliable classic",
    "google/gemini-3-flash-preview": "Fast & versatile",
    "deepseek/deepseek-v4-pro": "Follows instructions well",
    "anthropic/claude-haiku-4.5": "Smart & fast",
    "x-ai/grok-4.3": "Newest Grok — high quality & Limitless-friendly",
    "x-ai/grok-4.20": "High quality & Limitless-friendly",
    "google/gemini-3.1-pro-preview": "Best overall & large knowledge base",
    "anthropic/claude-sonnet-4.6": "Top quality & personality",
    "anthropic/claude-sonnet-5": "Newest Sonnet — top quality & personality",
    "anthropic/claude-opus-4.7": "Maximum intelligence",
    "anthropic/claude-opus-5": "Newest Opus — maximum intelligence",
    "z-ai/glm-5.3-flash": "Cheapest strong Chinese — thinks first",
    "tencent/hy3": "Great value, picks up subtle setups",
    "openai/gpt-5.6-luna": "Cheap, clean English — no explicit scenes",
    "meituan/longcat-2.0": "Natural prose, Limitless-friendly",
    "google/gemini-3.5-flash-lite": "Fastest replies, cheap",
    "stepfun/step-3.7-flash": "Cheap, updates panels reliably",
    "minimax/minimax-m3": "Vivid multilingual prose",
    "mistralai/mistral-large-2512": "Long, detailed replies",
    "thinkingmachines/inkling-small": "Best panel updates, long context",
    "google/gemini-3.7-flash": "Newest Gemini that stays Limitless",
    "openai/gpt-5.4-mini": "Sharp English, mild on explicit",
    "google/gemini-3.8-flash": "Strong writing — refuses Japanese adult",
    "moonshotai/kimi-k2.6": "Best prose, fully Limitless, slow",
    "openai/gpt-5.6-sol": "OpenAI flagship — no explicit scenes",
    "google/gemini-2.5-flash-lite": "Ultra lightweight",
  },
  zh: {
    "openrouter/free": "完全免费",
    "deepseek/deepseek-v4-flash": "经济，剧情略跳脱",
    "deepseek/deepseek-v3.2": "低审查",
    "mistralai/mistral-nemo": "最便宜，回复短小干脆",
    "mistralai/mistral-small-3.2-24b-instruct": "又快又省，回复简洁",
    "nousresearch/hermes-4-70b": "低审查，天生简短",
    "qwen/qwen3-vl-235b-a22b-instruct": "性价比，默认模型",
    "anthropic/claude-3-haiku": "聪明，不限内容",
    "moonshotai/kimi-k2-0905": "质量高，思考较慢",
    "z-ai/glm-4.6": "200K 上下文，支持推理",
    "google/gemini-3.1-flash-lite": "轻量，便宜",
    "google/gemini-3.5-flash": "谷歌最新模型",
    "google/gemini-2.5-pro": "不偏激，靠谱老模型",
    "google/gemini-3-flash-preview": "快速全能",
    "deepseek/deepseek-v4-pro": "听指令，遵循规则",
    "anthropic/claude-haiku-4.5": "聪明且快速",
    "x-ai/grok-4.3": "最新 Grok，高质量，支持「无限制」模式",
    "x-ai/grok-4.20": "高质量，支持「无限制」模式",
    "google/gemini-3.1-pro-preview": "综合最佳，知识库庞大",
    "anthropic/claude-sonnet-4.6": "顶级质量与个性",
    "anthropic/claude-sonnet-5": "最新 Sonnet，顶级质量与个性",
    "anthropic/claude-opus-4.7": "最高智能",
    "anthropic/claude-opus-5": "最新 Opus，最高智能",
    "z-ai/glm-5.3-flash": "中文最强的省钱档，先想后写",
    "tencent/hy3": "超值，接得住伏笔",
    "openai/gpt-5.6-luna": "便宜干净的英文，不写露骨场面",
    "meituan/longcat-2.0": "文风自然，不回避",
    "google/gemini-3.5-flash-lite": "回复最快，便宜",
    "stepfun/step-3.7-flash": "便宜，面板更新稳",
    "minimax/minimax-m3": "多语种描写细腻",
    "mistralai/mistral-large-2512": "回复长而详细",
    "thinkingmachines/inkling-small": "面板更新最稳，超长上下文",
    "google/gemini-3.7-flash": "最新且不回避的 Gemini",
    "openai/gpt-5.4-mini": "英文出色，露骨内容较收敛",
    "google/gemini-3.8-flash": "文笔强，但日语成人内容会拒答",
    "moonshotai/kimi-k2.6": "文笔最好，完全不回避，但慢",
    "openai/gpt-5.6-sol": "OpenAI 旗舰，不写露骨场面",
    "google/gemini-2.5-flash-lite": "超轻量",
  },
  ja: {
    "openrouter/free": "全員無料",
    "deepseek/deepseek-v4-flash": "経済的、展開がそれることも",
    "deepseek/deepseek-v3.2": "低検閲",
    "mistralai/mistral-nemo": "最安、短くテンポの良い返信",
    "mistralai/mistral-small-3.2-24b-instruct": "高速・低コスト、返信は簡潔",
    "nousresearch/hermes-4-70b": "低検閲、自然と簡潔",
    "qwen/qwen3-vl-235b-a22b-instruct": "コスパ良好、デフォルト",
    "anthropic/claude-3-haiku": "賢くて制限なし",
    "moonshotai/kimi-k2-0905": "Pro級の品質、思考は遅め",
    "z-ai/glm-4.6": "200Kコンテキスト、推論対応",
    "google/gemini-3.1-flash-lite": "軽量・安価",
    "google/gemini-3.5-flash": "Google の最新モデル",
    "google/gemini-2.5-pro": "安定の定番",
    "google/gemini-3-flash-preview": "高速で万能",
    "deepseek/deepseek-v4-pro": "指示によく従う",
    "anthropic/claude-haiku-4.5": "賢くて高速",
    "x-ai/grok-4.3": "最新Grok、高品質、無制限モード対応",
    "x-ai/grok-4.20": "高品質、無制限モード対応",
    "google/gemini-3.1-pro-preview": "総合最強、知識量豊富",
    "anthropic/claude-sonnet-4.6": "最高品質と個性",
    "anthropic/claude-sonnet-5": "最新Sonnet、最高品質と個性",
    "anthropic/claude-opus-4.7": "最高の知能",
    "anthropic/claude-opus-5": "最新Opus、最高の知能",
    "z-ai/glm-5.3-flash": "中国語が最も強い格安枠・熟考型",
    "tencent/hy3": "コスパ最強・伏線を拾う",
    "openai/gpt-5.6-luna": "安価で綺麗な英語・露骨描写なし",
    "meituan/longcat-2.0": "自然な文体・制限なし向き",
    "google/gemini-3.5-flash-lite": "応答最速・低価格",
    "stepfun/step-3.7-flash": "低価格・パネル更新が安定",
    "minimax/minimax-m3": "多言語で描写が繊細",
    "mistralai/mistral-large-2512": "長文で描写が細かい",
    "thinkingmachines/inkling-small": "パネル更新が最も安定・長文脈",
    "google/gemini-3.7-flash": "制限を避けない最新 Gemini",
    "openai/gpt-5.4-mini": "英語が得意・露骨表現は控えめ",
    "google/gemini-3.8-flash": "文章力は高いが日本語アダルトは拒否",
    "moonshotai/kimi-k2.6": "文章が最高・完全対応だが低速",
    "openai/gpt-5.6-sol": "OpenAI 旗艦・露骨描写なし",
    "google/gemini-2.5-flash-lite": "超軽量",
  },
  es: {
    "openrouter/free": "Gratis para todos",
    "deepseek/deepseek-v4-flash": "Económico, puede desviarse de la trama",
    "deepseek/deepseek-v3.2": "Censura baja",
    "mistralai/mistral-nemo": "El más barato — respuestas cortas y ágiles",
    "mistralai/mistral-small-3.2-24b-instruct": "Rápido y barato, respuestas concisas",
    "nousresearch/hermes-4-70b": "Baja censura, naturalmente conciso",
    "qwen/qwen3-vl-235b-a22b-instruct": "Gran relación calidad-precio, por defecto",
    "anthropic/claude-3-haiku": "Inteligente y sin restricciones",
    "moonshotai/kimi-k2-0905": "Calidad cercana a Pro, pensamiento más lento",
    "z-ai/glm-4.6": "Contexto de 200K, admite razonamiento",
    "google/gemini-3.1-flash-lite": "Ligero y barato",
    "google/gemini-3.5-flash": "El modelo más nuevo de Google",
    "google/gemini-2.5-pro": "Clásico fiable",
    "google/gemini-3-flash-preview": "Rápido y versátil",
    "deepseek/deepseek-v4-pro": "Sigue bien las instrucciones",
    "anthropic/claude-haiku-4.5": "Inteligente y rápido",
    "x-ai/grok-4.3": "El Grok más reciente, alta calidad y compatible con Sin límites",
    "x-ai/grok-4.20": "Alta calidad y compatible con Sin límites",
    "google/gemini-3.1-pro-preview": "El mejor en general y gran base de conocimiento",
    "anthropic/claude-sonnet-4.6": "Máxima calidad y personalidad",
    "anthropic/claude-sonnet-5": "El Sonnet más nuevo: máxima calidad y personalidad",
    "anthropic/claude-opus-4.7": "Inteligencia máxima",
    "anthropic/claude-opus-5": "El Opus más nuevo: inteligencia máxima",
    "z-ai/glm-5.3-flash": "Chino potente y barato, piensa antes",
    "tencent/hy3": "Gran valor, capta las pistas sutiles",
    "openai/gpt-5.6-luna": "Inglés limpio y barato, sin escenas explícitas",
    "meituan/longcat-2.0": "Prosa natural, apto para Limitless",
    "google/gemini-3.5-flash-lite": "Las respuestas más rápidas, barato",
    "stepfun/step-3.7-flash": "Barato, actualiza bien los paneles",
    "minimax/minimax-m3": "Prosa vívida en varios idiomas",
    "mistralai/mistral-large-2512": "Respuestas largas y detalladas",
    "thinkingmachines/inkling-small": "Mejores paneles, contexto largo",
    "google/gemini-3.7-flash": "El Gemini más nuevo sin filtros",
    "openai/gpt-5.4-mini": "Inglés preciso, poco explícito",
    "google/gemini-3.8-flash": "Buena prosa, rechaza adulto en japonés",
    "moonshotai/kimi-k2.6": "La mejor prosa, sin límites, lenta",
    "openai/gpt-5.6-sol": "Buque insignia de OpenAI, sin escenas explícitas",
    "google/gemini-2.5-flash-lite": "Ultraligero",
  },
} as const;

const TIER_LABEL_BY_LANG = {
  en: {
    budget: "Budget",
    standard: "Standard",
    premium: "Premium",
    ultra: "Ultra",
  },
  zh: {
    budget: "经济",
    standard: "标准",
    premium: "高级",
    ultra: "极致",
  },
  ja: {
    budget: "エコノミー",
    standard: "スタンダード",
    premium: "プレミアム",
    ultra: "ウルトラ",
  },
  es: {
    budget: "Económico",
    standard: "Estándar",
    premium: "Premium",
    ultra: "Ultra",
  },
} as const;

const PLAN_DISPLAY_BY_LANG = {
  en: {
    free: "Free",
    go: "Gold",
    plus: "Platinum",
    pro: "Diamond",
    ultra: "Ascendant",
    internal: "Internal",
  },
  zh: {
    free: "免费",
    go: "黄金",
    plus: "白金",
    pro: "钻石",
    ultra: "登峰",
    internal: "内部",
  },
  ja: {
    free: "無料",
    go: "ゴールド",
    plus: "プラチナ",
    pro: "ダイヤモンド",
    ultra: "アセンダント",
    internal: "内部",
  },
  es: {
    free: "Gratis",
    go: "Oro",
    plus: "Platino",
    pro: "Diamante",
    ultra: "Ascendente",
    internal: "Interno",
  },
} as const;

function pickLang(language: string): Lang {
  const l = language?.toLowerCase() ?? "";
  if (l.startsWith("zh")) return "zh";
  if (l.startsWith("ja")) return "ja";
  if (l.startsWith("es")) return "es";
  return "en";
}

function makeT(language: string) {
  const dict = STRINGS[pickLang(language)];
  return (key: keyof typeof STRINGS["en"], vars?: Record<string, string | number>): string => {
    let s: string = dict[key] ?? STRINGS.en[key] ?? key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        s = s.replace(`{{${k}}}`, String(v));
      }
    }
    return s;
  };
}

function getModelDescription(modelId: string, language: string): string {
  const lang = pickLang(language);
  return MODEL_DESCRIPTION_BY_LANG[lang][modelId as keyof typeof MODEL_DESCRIPTION_BY_LANG.en]
    ?? MODEL_DESCRIPTION_BY_LANG.en[modelId as keyof typeof MODEL_DESCRIPTION_BY_LANG.en]
    ?? modelId;
}

function getTierLabel(tier: Tier, language: string): string {
  const lang = pickLang(language);
  return TIER_LABEL_BY_LANG[lang][tier];
}

function getPlanLabel(planId: string, language: string): string {
  const lang = pickLang(language);
  return PLAN_DISPLAY_BY_LANG[lang][planId as keyof typeof PLAN_DISPLAY_BY_LANG.en]
    ?? PLAN_DISPLAY_BY_LANG.en[planId as keyof typeof PLAN_DISPLAY_BY_LANG.en]
    ?? planId;
}

const OFFICIAL_MODELS = PLAY_MODELS;

const TIERS = ["budget", "standard", "premium", "ultra"] as const;
type Tier = typeof TIERS[number];

const TIER_META: Record<Tier, { color: string; dot: string; bg: string; border: string; glow: string; costWarning?: boolean }> = {
  budget:   { color: "text-emerald-400", dot: "bg-emerald-400", bg: "bg-emerald-400/10", border: "border-emerald-400/25", glow: "shadow-emerald-500/20" },
  standard: { color: "text-blue-400",    dot: "bg-blue-400",    bg: "bg-blue-400/10",    border: "border-blue-400/25",    glow: "shadow-blue-500/20" },
  premium:  { color: "text-purple-400",  dot: "bg-purple-400",  bg: "bg-purple-400/10",  border: "border-purple-400/25",  glow: "shadow-purple-500/20", costWarning: true },
  ultra:    { color: "text-amber-400",   dot: "bg-amber-400",   bg: "bg-amber-400/10",   border: "border-amber-400/25",   glow: "shadow-amber-500/20", costWarning: true },
};

const PLAN_HIERARCHY = SHARED_PLAN_HIERARCHY as readonly string[];

const PROVIDER_COLORS: Record<string, string> = {
  Anthropic: "text-orange-400",
  OpenAI: "text-green-400",
  Google: "text-blue-400",
  Meta: "text-sky-400",
  Mistral: "text-violet-400",
  DeepSeek: "text-cyan-400",
  Cohere: "text-pink-400",
  xAI: "text-amber-400",
};

function formatModelId(id: string): string {
  const slug = id.includes("/") ? id.split("/").pop()! : id;
  return slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─── Main modal ────────────────────────────────────────────────────

interface ModelPickerModalProps {
  open: boolean;
  onClose: () => void;
  selectedModel?: string;
  onSelectModel?: (modelId: string) => void;
  title?: string;
  subtitle?: string;
  /** External selectors (memory/summary) can expose the normal provider
   * switch so the server and catalog keep using the same provider. */
  allowExternalProviderSwitch?: boolean;
  /** A protected world can require the official catalog for this choice. */
  providerOverride?: "official" | "private";
  /** Controlled extension-only source: switching this never changes story settings. */
  selectionProvider?: "official" | "private";
  /** A BYOK-only edition must never offer or resolve the platform catalog. */
  allowOfficialModels?: boolean;
  onSelectionProviderChange?: (provider: "official" | "private") => void;
}

export function ModelPickerModal({
  open,
  onClose,
  selectedModel: selectedModelProp,
  onSelectModel,
  title,
  subtitle,
  allowExternalProviderSwitch = false,
  providerOverride,
  selectionProvider,
  allowOfficialModels = true,
  onSelectionProviderChange,
}: ModelPickerModalProps) {
  const api = useYumina();
  const { language } = api;
  const preferredProvider = allowOfficialModels ? selectionProvider ?? api.preferredProvider : "private";
  const activeModel = selectedModelProp ?? api.selectedModel;
  const t = useMemo(() => makeT(language), [language]);
  const isExternalModelSelection = Boolean(onSelectModel);
  const [confirmProvider, setConfirmProvider] = useState<"official" | "private" | null>(null);
  const [switchingProvider, setSwitchingProvider] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [showMix, setShowMix] = useState(false);

  useEffect(() => {
    if (!open) {
      setConfirmProvider(null);
      setSwitchError(null);
      setSwitchingProvider(false);
      setShowMix(false);
    }
  }, [open]);

  useEffect(() => {
    setConfirmProvider(null);
    setSwitchError(null);
  }, [preferredProvider]);

  const requestProvider = useCallback((provider: "official" | "private") => {
    if (provider === preferredProvider || switchingProvider) return;
    if (onSelectionProviderChange) { onSelectionProviderChange(provider); return; }
    setSwitchError(null);
    setConfirmProvider(provider);
  }, [preferredProvider, switchingProvider, onSelectionProviderChange]);

  const confirmProviderSwitch = useCallback(async () => {
    if (!confirmProvider || switchingProvider) return;
    setSwitchingProvider(true);
    setSwitchError(null);
    try {
      const result = await api.setPreferredProvider(confirmProvider);
      if (!result?.ok) {
        setSwitchError(result?.error || t("switchFailed"));
      } else {
        setConfirmProvider(null);
      }
    } catch {
      setSwitchError(t("switchFailed"));
    } finally {
      setSwitchingProvider(false);
    }
  }, [api, confirmProvider, switchingProvider, t]);

  const providerSwitchCopy: ProviderSwitchCopy = {
    official: {
      title: t("switchToYumina"),
      description: t("yuminaSwitchDesc"),
    },
    private: {
      title: t("switchToPrivate"),
      description: t("privateSwitchDesc"),
    },
    confirmLabel: t("confirmSwitch"),
    cancelLabel: t("cancel"),
  };

  const providerSwitch = (
    <ProviderSwitchControl
      provider={preferredProvider}
      disabled={switchingProvider}
      onRequest={requestProvider}
      officialLabel={t("yuminaApi")}
      privateLabel={t("privateApiKey")}
    />
  );
  const visibleProviderSwitch = allowOfficialModels && (!isExternalModelSelection || allowExternalProviderSwitch || onSelectionProviderChange)
    ? providerSwitch
    : undefined;

  const handleSelectModel = useCallback((modelId: string) => {
    if (onSelectModel) {
      onSelectModel(modelId);
    } else {
      const isMixActive = api.mixMode && api.modelPool && api.modelPool.length >= 2;
      if (isMixActive) api.setMixMode(false);
      api.setModel(modelId);
    }
  }, [api, onSelectModel]);

  // Escape key to close
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (confirmProvider && !switchingProvider) {
        setConfirmProvider(null);
        setSwitchError(null);
        return;
      }
      if (!confirmProvider) onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [confirmProvider, open, onClose, switchingProvider]);

  if (!open) return null;
  const platformOverlayMount = initializeSandboxPlatformOverlay();

  return (
    <SandboxPlatformOverlay>
      <>
        <div
          className="yumina-model-dialog fixed inset-0 z-[10000] flex items-center justify-center pt-[calc(env(safe-area-inset-top,0px)+2.5rem)] pb-[calc(env(safe-area-inset-bottom,0px)+1.5rem)]"
          onClick={onClose}
          role="dialog"
          aria-modal="true"
          aria-label={title ?? t("chooseModel")}
        >
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

          <div
            onClick={(e) => e.stopPropagation()}
            className="yumina-model-sheet relative z-10 w-[min(440px,calc(100vw-2rem))] max-h-[min(600px,calc(100dvh-env(safe-area-inset-top,0px)-env(safe-area-inset-bottom,0px)-4rem))] flex flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-[#1a1b1e]/95 shadow-2xl shadow-black/40 backdrop-blur-xl"
            style={{ animation: "modalIn 0.2s ease-out" }}
          >
            {showMix && !isExternalModelSelection ? (
              <SandboxMixConfig onBack={() => setShowMix(false)} onClose={onClose} t={t} />
            ) : allowOfficialModels && (providerOverride ?? preferredProvider) === "official" ? (
              <OfficialPicker
                onClose={onClose}
                t={t}
                providerSwitch={visibleProviderSwitch}
                onMixMode={isExternalModelSelection ? undefined : () => {
                  const { modelPool, selectedModel, addToPool } = api;
                  if (!modelPool || modelPool.length === 0) addToPool(selectedModel);
                  setShowMix(true);
                }}
                selectedModel={activeModel}
                onSelectModel={handleSelectModel}
                title={title}
                subtitle={subtitle}
              />
            ) : (
              <ByokPicker
                onClose={onClose}
                t={t}
                providerSwitch={visibleProviderSwitch}
                onMixMode={isExternalModelSelection ? undefined : () => {
                  const { modelPool, selectedModel, addToPool } = api;
                  if (!modelPool || modelPool.length === 0) addToPool(selectedModel);
                  setShowMix(true);
                }}
                selectedModel={activeModel}
                onSelectModel={handleSelectModel}
                title={title}
                subtitle={subtitle}
                independentProvider={!allowOfficialModels || Boolean(onSelectionProviderChange)}
              />
            )}
          </div>

          <style>{`
            /* Short landscape screens scroll the sheet, not a model list
               squeezed down to a few pixels by the fixed controls above it. */
            @media (max-height: 500px) {
              .yumina-model-dialog { padding-top: calc(env(safe-area-inset-top,0px) + 8px); padding-bottom: calc(env(safe-area-inset-bottom,0px) + 8px); }
              .yumina-model-sheet { display: block; max-height: calc(100dvh - env(safe-area-inset-top,0px) - env(safe-area-inset-bottom,0px) - 16px); overflow-y: auto; overscroll-behavior: contain; }
              .yumina-model-sheet > .overflow-y-auto { overflow: visible; }
              .yumina-model-sheet button { min-height: 44px; }
              .yumina-model-sheet > div:first-child { position: sticky; top: 0; z-index: 2; padding-top: 4px; padding-bottom: 4px; background: #1a1b1e; }
              .yumina-model-sheet > div:first-child button { min-width: 44px; min-height: 44px; }
            }
            @keyframes modalIn {
              from { opacity: 0; transform: scale(0.96) translateY(8px); }
              to { opacity: 1; transform: scale(1) translateY(0); }
            }
          `}</style>
        </div>

        <ProviderSwitchConfirmDialog
          provider={confirmProvider}
          copy={providerSwitchCopy}
          busy={switchingProvider}
          error={switchError}
          onConfirm={confirmProviderSwitch}
          onCancel={() => {
            if (switchingProvider) return;
            setConfirmProvider(null);
            setSwitchError(null);
          }}
          portalContainer={platformOverlayMount}
          portalClassName="yumina-platform-overlay-surface"
        />
      </>
    </SandboxPlatformOverlay>
  );
}

// ─── Official API picker (tabs) ────────────────────────────────────

type T = ReturnType<typeof makeT>;

function OfficialPicker({
  onClose,
  t,
  providerSwitch,
  onMixMode,
  selectedModel,
  onSelectModel,
  title,
  subtitle,
}: {
  onClose: () => void;
  t: T;
  providerSwitch?: React.ReactNode;
  onMixMode?: () => void;
  selectedModel: string;
  onSelectModel: (modelId: string) => void;
  title?: string;
  subtitle?: string;
}) {
  const { userPlan, language, mixMode, modelPool } = useYumina();
  const deepSeekPricingCopy: DeepSeekPricingCopy = {
    triggerLabel: t("deepSeekPricingTrigger"),
    title: t("deepSeekPricingTitle"),
    body: t("deepSeekPricingBody"),
  };
  const isMixActive = Boolean(onMixMode && mixMode && modelPool && modelPool.length >= 2);
  const [activeTier, setActiveTier] = useState<Tier>(() => {
    const current = OFFICIAL_MODELS.find((m) => m.id === selectedModel);
    return current?.tier ?? "budget";
  });

  useEffect(() => {
    const current = OFFICIAL_MODELS.find((m) => m.id === selectedModel);
    if (current) setActiveTier(current.tier);
  }, [selectedModel]);

  const canAccess = (minPlan: string) =>
    PLAN_HIERARCHY.indexOf(userPlan) >= PLAN_HIERARCHY.indexOf(minPlan);

  const models = OFFICIAL_MODELS
    .filter((m) => m.tier === activeTier)
    .sort((a, b) => a.avgCostMushies - b.avgCostMushies);

  const handleSelect = (modelId: string, minPlan: string) => {
    if (!canAccess(minPlan)) return;
    onSelectModel(modelId);
    onClose();
  };

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between px-5 pt-5 pb-1">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary/10">
            <Sparkles className="h-4 w-4 text-primary" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-white">{title ?? t("chooseModel")}</h2>
            <p className="text-[11px] text-white/40">{subtitle ?? t("yuminaApi")}</p>
          </div>
        </div>
        <button
          onClick={onClose}
          aria-label={t("cancel")}
          className="play-action-btn flex h-7 w-7 items-center justify-center rounded-lg text-white/30 transition-colors hover:bg-white/5 hover:text-white/60 active:bg-white/5 active:text-white/60"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {providerSwitch}

      <div className="flex items-center gap-2 border-y border-white/[0.06] px-5 py-2">
        <p className="flex-1 text-[11px] leading-snug text-white/45">{t("usageNote")}</p>
        {onMixMode && <SandboxMixPill onClick={onMixMode} t={t} />}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 px-5 pt-3 pb-2">
        {TIERS.map((tier) => {
          const meta = TIER_META[tier];
          const isActive = activeTier === tier;
          return (
            <button
              key={tier}
              onClick={() => setActiveTier(tier)}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-xl border px-2 py-2 text-[11px] font-semibold uppercase tracking-wider transition-all ${
                isActive
                  ? `${meta.bg} ${meta.border} ${meta.color} shadow-md ${meta.glow}`
                  : "border-white/[0.06] bg-white/[0.02] text-white/30 hover:border-white/10 hover:text-white/50"
              }`}
            >
              <div className={`h-1.5 w-1.5 rounded-full ${isActive ? meta.dot : "bg-white/20"}`} />
              <span>{getTierLabel(tier, language)}</span>
            </button>
          );
        })}
      </div>

      {/* Cost warning for premium/ultra */}
      {TIER_META[activeTier].costWarning && (
        <div className="px-5 pb-1">
          <span className="text-[11px] text-sub/40">{t("higherCost")}</span>
        </div>
      )}

      {/* Model list */}
      <div className="flex-1 overflow-y-auto px-4 py-2">
        <div className="space-y-1.5">
          {models.map((m) => {
            const isSelected = !isMixActive && selectedModel === m.id;
            const locked = !canAccess(m.minPlan);
            const meta = TIER_META[m.tier as Tier];

            return (
              <div
                key={m.id}
                className={`group flex w-full items-center gap-3 rounded-xl border p-3.5 text-left transition-all ${
                  locked
                    ? "cursor-not-allowed border-white/[0.04] bg-white/[0.01] opacity-45"
                    : isSelected
                      ? `${meta.border} ${meta.bg} shadow-md ${meta.glow}`
                      : "border-white/[0.06] bg-white/[0.02] hover:border-white/10 hover:bg-white/[0.04]"
                }`}
              >
                <button
                  type="button"
                  onClick={() => handleSelect(m.id, m.minPlan)}
                  disabled={locked}
                  className="group flex min-w-0 flex-1 items-center gap-3 rounded-xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25"
                >
                  {/* Tier dot */}
                  <div className={`h-2.5 w-2.5 shrink-0 rounded-full ${meta.dot} ${locked ? "opacity-30" : isSelected ? "opacity-100" : "opacity-50"}`} />

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`text-sm font-medium ${locked ? "text-white/30" : isSelected ? "text-white" : "text-white/80"}`}>
                        {m.name}
                      </span>
                      {m.badge && !locked && (
                        <span className="rounded bg-[#f3d361]/15 px-1.5 py-0.5 text-[9px] font-bold text-[#f3d361]/80">
                          {m.badge}
                        </span>
                      )}
                      {locked && (
                        <span className="inline-flex items-center gap-0.5 rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[9px] font-bold text-white/30">
                          <Lock className="h-2.5 w-2.5" />
                          {getPlanLabel(m.minPlan, language)}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                      <span className={`text-[11px] ${locked ? "text-white/15" : "text-white/35"}`}>
                        {getModelDescription(m.id, language)}
                      </span>
                      {m.avgCostMushiesByPeriod && !locked ? (
                        <span className="text-[10px] text-[#f3d361]/50">
                          {t("avgCostByPeriod", {
                            peak: formatAvgCost(m.avgCostMushiesByPeriod.peak),
                            offPeak: formatAvgCost(m.avgCostMushiesByPeriod.offPeak),
                          })}
                        </span>
                      ) : m.avgCostMushies != null && m.avgCostMushies > 0 && !locked && (
                        <span className="text-[10px] text-[#f3d361]/50">{t("avgCost", { cost: m.avgCostMushies })}</span>
                      )}
                      {m.avgCostMushies != null && m.avgCostMushies === 0 && !locked && (
                        <span className="text-[10px] font-medium text-emerald-400/60">{t("free")}</span>
                      )}
                    </div>
                  </div>

                  {/* Selected indicator */}
                  {isSelected && !locked && (
                    <div className={`h-2.5 w-2.5 shrink-0 rounded-full ${meta.dot} shadow-lg ${meta.glow}`} />
                  )}
                </button>
                <DeepSeekPricingInfo
                  modelId={m.id}
                  modelName={m.name}
                  copy={deepSeekPricingCopy}
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* Footer */}
      <div className="px-5 py-3 border-t border-white/[0.06]">
        <p className="text-[10px] text-white/25 text-center">
          {userPlan === "free"
            ? t("upgradeForMore")
            : t("currentPlan", { plan: getPlanLabel(userPlan, language) })}
        </p>
      </div>
    </>
  );
}

// ─── BYOK picker (search + list) ──────────────────────────────────

interface ByokModel {
  id: string;
  name: string;
  provider: string;
  contextLength: number;
}

function ByokPicker({
  onClose,
  t,
  providerSwitch,
  onMixMode,
  selectedModel,
  onSelectModel,
  title,
  subtitle,
  independentProvider = false,
}: {
  onClose: () => void;
  t: T;
  providerSwitch?: React.ReactNode;
  onMixMode?: () => void;
  selectedModel: string;
  onSelectModel: (modelId: string) => void;
  title?: string;
  subtitle?: string;
  independentProvider?: boolean;
}) {
  const { getModels, pinModel, unpinModel, mixMode, modelPool } = useYumina();
  const isMixActive = Boolean(onMixMode && mixMode && modelPool && modelPool.length >= 2);
  const [query, setQuery] = useState("");
  const [models, setModels] = useState<ByokModel[]>([]);
  const [pinnedIds, setPinnedIds] = useState<string[]>([]);
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const [pinLimitHit, setPinLimitHit] = useState(false);
  const [loading, setLoading] = useState(true);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setLoading(true);
    getModels(independentProvider ? "private" : undefined).then((data) => {
      setModels(data.models ?? []);
      setPinnedIds(data.pinnedModels ?? []);
      setRecentIds(data.recentlyUsed ?? []);
      setLoading(false);
    }).catch(() => setLoading(false));
    // Autofocus only on pointer devices: on touch it pops the keyboard over the
    // list, and focusing this sub-16px input triggers iOS's sticky page zoom.
    // preventScroll: the modal is fixed-position — focusing its search box
    // must not scroll the document scroller (#sandbox-root) behind it.
    if (!window.matchMedia("(pointer: coarse)").matches) {
      requestAnimationFrame(() => searchRef.current?.focus({ preventScroll: true }));
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const pinnedSet = useMemo(() => new Set(pinnedIds), [pinnedIds]);

  const filtered = useMemo(() => {
    if (!query) return [];
    const q = query.toLowerCase();
    return models.filter(
      (m) =>
        m.id.toLowerCase().includes(q) ||
        m.name.toLowerCase().includes(q) ||
        m.provider.toLowerCase().includes(q)
    );
  }, [query, models]);

  const pinnedModels = useMemo(
    () => pinnedIds.map((id) => models.find((m) => m.id === id)).filter(Boolean) as ByokModel[],
    [pinnedIds, models]
  );

  const recentModels = useMemo(
    () => recentIds.filter((id) => !pinnedSet.has(id)).slice(0, 5).map((id) => models.find((m) => m.id === id)).filter(Boolean) as ByokModel[],
    [recentIds, pinnedSet, models]
  );

  /** Everything else: the full key catalog minus what's already shown above
   *  in Pinned/Recent, so the BYOK picker behaves like the API settings'
   *  "Available models" dropdown — the user can browse every model the active
   *  key serves without having to search or pin first. */
  const recentSet = useMemo(
    () => new Set(recentModels.map((m) => m.id)),
    [recentModels],
  );
  const otherModels = useMemo(
    () => models.filter((m) => !pinnedSet.has(m.id) && !recentSet.has(m.id)),
    [models, pinnedSet, recentSet],
  );

  const handleSelect = (modelId: string) => {
    onSelectModel(modelId);
    onClose();
  };

  // The star renders the host's answer, never a local guess. Optimistically
  // lighting it hid two real failures (a full pin list, a dropped bridge call)
  // behind a star that looked saved and was gone after a refresh.
  const handleTogglePin = (modelId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const wasPinned = pinnedSet.has(modelId);
    const call = wasPinned ? unpinModel(modelId) : pinModel(modelId);
    void Promise.resolve(call)
      .then((res) => {
        if (Array.isArray(res?.pinnedModels)) setPinnedIds(res.pinnedModels);
        setPinLimitHit(!wasPinned && res?.accepted === false);
      })
      .catch(() => {
        // Bridge call failed — leave the list as the host last reported it.
      });
  };

  const renderModel = (m: ByokModel) => {
    const isSelected = !isMixActive && selectedModel === m.id;
    const isPinned = pinnedSet.has(m.id);
    const providerColor = PROVIDER_COLORS[m.provider] ?? "text-white/40";

    return (
      <button
        key={m.id}
        onClick={() => handleSelect(m.id)}
        className={`group flex w-full items-center gap-2.5 rounded-xl border p-3 text-left transition-all ${
          isSelected
            ? "border-slate-400/25 bg-slate-400/8 shadow-md shadow-slate-500/10"
            : "border-white/[0.05] bg-white/[0.015] hover:border-slate-400/15 hover:bg-slate-400/[0.04]"
        }`}
      >
        {/* Pin control — span, not button: it sits inside the model-row
            <button>, and nested interactive elements are invalid HTML with
            flaky tap behavior. Touch devices get a resting tint (hover can
            never reveal it there) and a larger hit box. */}
        {!independentProvider && <span
          role="button"
          tabIndex={0}
          aria-label="Pin model"
          onClick={(e) => handleTogglePin(m.id, e)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              handleTogglePin(m.id, e as unknown as React.MouseEvent);
            }
          }}
          className={`play-action-btn flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors ${
            isPinned
              ? "text-slate-300/70 hover:text-slate-300"
              : "text-transparent group-hover:text-white/20 hover:!text-white/40 [@media(hover:none)]:text-white/25"
          }`}
        >
          <Star className={`h-3 w-3 ${isPinned ? "fill-current" : ""}`} />
        </span>}

        {/* Model info */}
        <div className="flex-1 min-w-0">
          <p className={`truncate text-sm font-medium ${isSelected ? "text-white" : "text-white/80"}`}>
            {m.name || formatModelId(m.id)}
          </p>
        </div>

        {/* Provider */}
        <span className={`shrink-0 text-[10px] font-medium ${providerColor}`}>
          {m.provider}
        </span>

        {/* Context length */}
        {m.contextLength > 0 && (
          <span className="shrink-0 text-[10px] text-white/20">
            {Math.round(m.contextLength / 1000)}k
          </span>
        )}

        {/* Selected */}
        {isSelected && (
          <div className="h-2 w-2 shrink-0 rounded-full bg-slate-300 shadow-lg shadow-slate-400/30" />
        )}
      </button>
    );
  };

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between px-5 pt-5 pb-1">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-slate-400/10">
            <Sparkles className="h-4 w-4 text-slate-300" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-white">{title ?? t("chooseModel")}</h2>
            <p className="text-[11px] text-white/40">{subtitle ?? t("privateApiKey")}</p>
          </div>
        </div>
        <button
          onClick={onClose}
          aria-label={t("cancel")}
          className="play-action-btn flex h-7 w-7 items-center justify-center rounded-lg text-white/30 transition-colors hover:bg-white/5 hover:text-white/60 active:bg-white/5 active:text-white/60"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {providerSwitch}

      <div className="flex items-center gap-2 border-y border-white/[0.06] px-5 py-2">
        <p className="flex-1 text-[11px] leading-snug text-white/45">{t("usageNote")}</p>
        {onMixMode && <SandboxMixPill onClick={onMixMode} t={t} />}
      </div>

      {/* Search */}
      <div className="px-4 pt-3 pb-1">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/25" />
          <input
            ref={searchRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("searchModels")}
            className="w-full rounded-xl border border-slate-400/10 bg-slate-400/[0.03] py-2.5 pl-9 pr-3 text-xs text-white placeholder:text-white/25 focus:border-slate-400/20 focus:outline-none"
          />
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 py-2">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-white/10 border-t-primary" />
          </div>
        ) : query ? (
          /* Search results */
          <div className="space-y-1">
            <SectionLabel>
              {filtered.length === 1
                ? t("resultsOne", { count: filtered.length })
                : t("resultsMany", { count: filtered.length })}
            </SectionLabel>
            {filtered.length === 0 && (
              <p className="py-6 text-center text-xs text-white/25">
                {t("noModelsMatch", { query })}
              </p>
            )}
            {filtered.map(renderModel)}
          </div>
        ) : (
          /* Default: pinned + recent + ALL OTHER models from the active key.
              Showing the full list (not just pinned/recent) is what users
              expect — same surface as the API settings "Available models"
              dropdown, so they can switch between any of their key's models
              without having to know one's name to search. */
          <div className="space-y-3">
            {pinLimitHit && (
              <p className="rounded-lg border border-amber-400/20 bg-amber-400/[0.06] px-3 py-2 text-[11px] text-amber-200/80">
                {t("pinLimit", { max: MAX_PINNED_MODELS })}
              </p>
            )}
            {pinnedModels.length > 0 && (
              <div className="space-y-1">
                <SectionLabel icon={<Star className="h-3 w-3" />}>{t("pinned")}</SectionLabel>
                {pinnedModels.map(renderModel)}
              </div>
            )}
            {recentModels.length > 0 && (
              <div className="space-y-1">
                <SectionLabel icon={<Clock className="h-3 w-3" />}>{t("recent")}</SectionLabel>
                {recentModels.map(renderModel)}
              </div>
            )}
            {otherModels.length > 0 && (
              <div className="space-y-1">
                <SectionLabel icon={<Layers className="h-3 w-3" />}>
                  {t("allModels")} ({otherModels.length})
                </SectionLabel>
                {otherModels.map(renderModel)}
              </div>
            )}
            {models.length === 0 && (
              <p className="py-8 text-center text-xs text-white/25">
                {t("noModelsAvailable")}
              </p>
            )}
          </div>
        )}
      </div>
    </>
  );
}

// ─── Shared components ─────────────────────────────────────────────

function SectionLabel({ icon, children }: { icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 px-1 pb-1 pt-2">
      {icon && <span className="text-white/20">{icon}</span>}
      <span className="text-[10px] font-semibold uppercase tracking-wider text-white/25">
        {children}
      </span>
    </div>
  );
}

// ─── Trigger button (used below composer) ──────────────────────────

// ─── Mix pill + config (sandbox) ──────────────────────────────────
// MIRROR: These components must stay in sync with the React ModelBrowser
// equivalents in packages/app/src/features/chat/model-browser.tsx
// (MixPill + MixConfigView). The sandbox runs in an iframe with no
// shared React tree, so the UI is duplicated.

export const MIX_COLORS = ["bg-blue-500", "bg-violet-500", "bg-emerald-500", "bg-amber-500", "bg-rose-500"];

function poolPercentages(pool: Array<{ modelId: string; weight: number; locked?: boolean }>) {
  const total = pool.reduce((s, e) => s + e.weight, 0);
  if (total <= 0) return [];
  const raw = pool.map((e) => ({ modelId: e.modelId, pct: Math.round((e.weight / total) * 100) }));
  const diff = 100 - raw.reduce((s, e) => s + e.pct, 0);
  if (diff !== 0 && raw.length > 0) {
    const diffIndex = Math.max(0, pool.findIndex((entry) => !entry.locked));
    raw[diffIndex].pct += diff;
  }
  return raw;
}

function SandboxMixPill({ onClick, t }: { onClick: () => void; t: T }) {
  const { mixMode, modelPool } = useYumina();
  const isActive = mixMode && modelPool && modelPool.length >= 2;
  const pcts = useMemo(() => (isActive ? poolPercentages(modelPool) : []), [isActive, modelPool]);

  if (isActive) {
    return (
      <button onClick={onClick}
        className="flex shrink-0 items-center gap-1.5 rounded-full border border-primary/30 bg-primary/[0.08] px-2.5 py-1 text-[10px] font-medium text-primary transition-all hover:border-primary/50 hover:bg-primary/[0.14]">
        <Shuffle className="h-3 w-3" />
        <div className="flex h-1.5 w-8 overflow-hidden rounded-full bg-white/[0.08]">
          {pcts.map((e, i) => <div key={e.modelId} className={MIX_COLORS[i % MIX_COLORS.length]} style={{ width: `${e.pct}%` }} />)}
        </div>
        <span>{modelPool.length}</span>
      </button>
    );
  }

  return (
    <button onClick={onClick}
      className="flex shrink-0 items-center gap-1 rounded-full border border-white/[0.08] bg-white/[0.04] px-2.5 py-1 text-[10px] font-medium text-white/50 transition-all hover:border-primary/30 hover:bg-primary/[0.08] hover:text-primary">
      <Shuffle className="h-3 w-3" />
      {t("mixModels")}
    </button>
  );
}

function SandboxMixConfig({ onBack, onClose, t }: { onBack: () => void; onClose: () => void; t: T }) {
  const { mixMode, modelPool, addToPool, removeFromPool, setPoolWeight, togglePoolLock, setMixMode, getModels } = useYumina();
  const [addQuery, setAddQuery] = useState("");
  const [availableModels, setAvailableModels] = useState<Array<{ id: string; name: string; provider: string }>>([]);
  const canActivate = modelPool && modelPool.length >= 2;
  const canLockWeights = !!modelPool && modelPool.length > 2;
  const pcts = useMemo(() => poolPercentages(modelPool ?? []), [modelPool]);
  const poolIds = useMemo(() => new Set((modelPool ?? []).map((e) => e.modelId)), [modelPool]);
  const MAX_POOL = 5;

  useEffect(() => {
    getModels().then((data) => setAvailableModels(data.models ?? [])).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const addResults = useMemo(() => {
    if (!addQuery) return [];
    const q = addQuery.toLowerCase();
    return availableModels.filter((m) => !poolIds.has(m.id))
      .filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q) || m.provider.toLowerCase().includes(q))
      .slice(0, 5);
  }, [addQuery, availableModels, poolIds]);

  const resolveName = (id: string) => {
    const m = availableModels.find((am) => am.id === id) ?? OFFICIAL_MODELS.find((om) => om.id === id);
    return m?.name ?? formatModelId(id);
  };

  const handleToggle = () => {
    if (mixMode) setMixMode(false);
    else if (canActivate) setMixMode(true);
  };

  return (
    <>
      <div className="flex items-center justify-between px-5 pt-5 pb-1">
        <div className="flex items-center gap-2.5">
          <button onClick={onBack} className="flex h-8 w-8 items-center justify-center rounded-xl bg-white/[0.04] text-white/40 transition-colors hover:bg-white/[0.08] hover:text-white/70">
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div>
            <h2 className="text-sm font-bold text-white">{t("mixModels")}</h2>
            <p className="text-[11px] text-white/40">{(modelPool ?? []).length}/{MAX_POOL}</p>
          </div>
        </div>
        <button onClick={onClose} className="play-action-btn flex h-7 w-7 items-center justify-center rounded-lg text-white/30 transition-colors hover:bg-white/5 hover:text-white/60 active:bg-white/5 active:text-white/60">
          <X className="h-4 w-4" />
        </button>
      </div>

      <p className="border-y border-white/[0.06] px-5 py-2 text-[11px] leading-snug text-white/45">{t("mixDescription")}</p>

      {(modelPool ?? []).length > 0 && (
        <div className="px-5 pt-3 pb-1">
          <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-white/[0.04]">
            {pcts.map((e, i) => <div key={e.modelId} className={`transition-all duration-300 ease-out ${MIX_COLORS[i % MIX_COLORS.length]}`} style={{ width: `${e.pct}%` }} />)}
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-4 py-2">
        <div className="space-y-1">
          {(modelPool ?? []).map((entry, i) => {
            const pct = pcts.find((p) => p.modelId === entry.modelId)?.pct ?? 0;
            const name = resolveName(entry.modelId);
            const locked = canLockWeights && !!entry.locked;
            const lockLabel = t(locked ? "unlockWeight" : "lockWeight");
            return (
              <div key={entry.modelId} className="group rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 transition-all hover:border-white/10">
                <div className="flex items-center gap-2.5">
                  <div className={`h-2.5 w-2.5 shrink-0 rounded-full ${MIX_COLORS[i % MIX_COLORS.length]}`} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-white/80">{name}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button onClick={() => setPoolWeight(entry.modelId, pct - 1)} disabled={pct <= 0}
                      className="flex h-6 w-6 items-center justify-center rounded-lg text-white/30 hover:bg-white/[0.06] hover:text-white/60 disabled:pointer-events-none disabled:opacity-20">
                      <Minus className="h-3 w-3" />
                    </button>
                    <span className="w-10 text-center text-xs font-medium tabular-nums text-white/50">{pct}%</span>
                    <button onClick={() => setPoolWeight(entry.modelId, pct + 1)} disabled={pct >= 100}
                      className="flex h-6 w-6 items-center justify-center rounded-lg text-white/30 hover:bg-white/[0.06] hover:text-white/60 disabled:pointer-events-none disabled:opacity-20">
                      <Plus className="h-3 w-3" />
                    </button>
                  </div>
                  {canLockWeights && (
                    <button onClick={() => togglePoolLock(entry.modelId)} title={lockLabel} aria-label={lockLabel}
                      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-lg transition-all ${
                        locked
                          ? "bg-primary/15 text-primary hover:bg-primary/25"
                          : "text-white/25 hover:bg-white/[0.06] hover:text-white/60"
                      }`}>
                      {locked ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}
                    </button>
                  )}
                  <button onClick={() => removeFromPool(entry.modelId)}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-white/20 transition-all hover:bg-red-500/10 hover:text-red-400 md:opacity-0 md:group-hover:opacity-100">
                    <X className="h-3 w-3" />
                  </button>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={pct}
                  aria-label={`${name} mix weight`}
                  onChange={(e) => setPoolWeight(entry.modelId, Number(e.currentTarget.value))}
                  className="mt-2 h-1.5 w-full cursor-pointer appearance-none rounded-full bg-white/[0.06] outline-none [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white/80 [&::-webkit-slider-thumb]:shadow-sm [&::-webkit-slider-thumb]:transition-all [&::-webkit-slider-thumb]:hover:scale-110 [&::-webkit-slider-thumb]:hover:bg-white [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-white/80"
                />
              </div>
            );
          })}
        </div>

        {(modelPool ?? []).length < MAX_POOL && (
          <div className="mt-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/25" />
              <input type="text" value={addQuery} onChange={(e) => setAddQuery(e.target.value)}
                placeholder={t("addModel")}
                className="w-full rounded-xl border border-white/[0.06] bg-white/[0.02] py-2.5 pl-9 pr-3 text-xs text-white placeholder:text-white/20 focus:border-white/15 focus:outline-none" />
            </div>
            {addResults.length > 0 && (
              <div className="mt-1.5 space-y-0.5">
                {addResults.map((m) => (
                  <button key={m.id} onClick={() => { addToPool(m.id); setAddQuery(""); }}
                    className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left transition-all hover:bg-white/[0.04]">
                    <Plus className="h-3.5 w-3.5 shrink-0 text-primary/60" />
                    <span className="flex-1 truncate text-xs font-medium text-white/70">{m.name || formatModelId(m.id)}</span>
                    <span className="shrink-0 text-[10px] text-white/25">{m.provider}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="border-t border-white/[0.06] px-5 py-3">
        <button onClick={handleToggle} disabled={!canActivate && !mixMode}
          className={`flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-xs font-semibold transition-all ${
            mixMode
              ? "border border-white/[0.08] bg-white/[0.04] text-white/60 hover:bg-white/[0.08]"
              : canActivate
                ? "bg-primary text-white hover:bg-primary/90"
                : "bg-white/[0.04] text-white/20 cursor-not-allowed"
          }`}>
          {mixMode ? t("deactivate") : t("activate")}
        </button>
        {!canActivate && !mixMode && (
          <p className="mt-1.5 text-center text-[10px] text-white/25">{t("needTwo")}</p>
        )}
      </div>
    </>
  );
}

// ─── Composer model summary (shared) ──────────────────────────────
// A tiny, render-free digest of the current model selection, so the compact
// mobile tool menu (sandbox/chat/composer-tool-menu.tsx) can label its trigger
// without duplicating the OFFICIAL_MODELS / mix-pool lookups that live here.

export interface ComposerModelSummary {
  /** True when mix mode is active with a pool of ≥2 models. */
  isMix: boolean;
  /** Human label for the single-model case (model name, e.g. "Gemini 3 Flash"). */
  label: string;
  /** Tier dot color class for the single-model case, or null (BYOK / unknown). */
  dotClass: string | null;
  /** Rounded pool percentages for the mix case (empty otherwise). */
  poolPcts: Array<{ modelId: string; pct: number }>;
  /** Number of models in the mix pool (0 when not mixing). */
  poolCount: number;
}

export function getComposerModelSummary(opts: {
  selectedModel: string;
  preferredProvider: "official" | "private";
  mixMode: boolean;
  modelPool: Array<{ modelId: string; weight: number; locked?: boolean }>;
  language: string;
}): ComposerModelSummary {
  const { selectedModel, preferredProvider, mixMode, modelPool, language } = opts;
  const isMix = Boolean(mixMode && modelPool && modelPool.length >= 2);
  if (isMix) {
    return {
      isMix: true,
      label: `${STRINGS[pickLang(language)].mixModels} · ${modelPool.length}`,
      dotClass: null,
      poolPcts: poolPercentages(modelPool),
      poolCount: modelPool.length,
    };
  }
  if (preferredProvider === "official") {
    const found = OFFICIAL_MODELS.find((m) => m.id === selectedModel);
    return {
      isMix: false,
      label: found?.name ?? formatModelId(selectedModel),
      dotClass: found ? TIER_META[found.tier].dot : null,
      poolPcts: [],
      poolCount: 0,
    };
  }
  return { isMix: false, label: formatModelId(selectedModel), dotClass: null, poolPcts: [], poolCount: 0 };
}

/** Current remaining mushie balance shown on the composer pills. Prefers the
 * live wallet balance pushed from the host (identical on every card and
 * device), falling back to the most recent message that carries a
 * balance-after (the active swipe's, else the message's own) for old sessions
 * or before the live value arrives. Null when unknown — and always null on
 * BYOK/private, where the user pays their own provider and any value would be
 * a stale carry-over from an earlier official-API message. */
export function useMushieBalance(): number | null {
  const { messages, balance: liveBalance, preferredProvider } = useYumina();
  const messageBalance = useMemo<number | null>(() => {
    if (!messages?.length) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i] as {
        creditBalanceAfter?: unknown;
        swipes?: Array<{ creditBalanceAfter?: unknown }>;
        activeSwipeIndex?: unknown;
      };
      const swipe =
        Array.isArray(m.swipes) && typeof m.activeSwipeIndex === "number"
          ? m.swipes[m.activeSwipeIndex]
          : undefined;
      const b =
        typeof swipe?.creditBalanceAfter === "number"
          ? swipe.creditBalanceAfter
          : typeof m.creditBalanceAfter === "number"
            ? m.creditBalanceAfter
            : null;
      if (b != null) return b;
    }
    return null;
  }, [messages]);
  // `??` keeps a real 0 balance.
  return preferredProvider !== "official" ? null : (liveBalance ?? messageBalance);
}

/** Divider + amount + mushroom glyph rendered inside a composer pill. Shared
 * by the inline ModelTrigger and the collapsed mobile tool-menu trigger. */
export function BalanceTag({
  balance,
  language,
  dividerClass = "bg-white/10",
}: {
  balance: number;
  language: string;
  dividerClass?: string;
}) {
  return (
    <>
      <span aria-hidden className={`h-3 w-px shrink-0 ${dividerClass}`} />
      <span
        aria-label={`${formatBalance(balance)} ${STRINGS[pickLang(language)].mushieBalance}`}
        className="inline-flex shrink-0 items-center gap-0.5 text-[11px] font-semibold text-[#f3d361] tabular-nums whitespace-nowrap"
      >
        {formatBalance(balance)}
        <MushroomIcon className="h-3 w-3 text-[#f3d361]/80" />
      </span>
    </>
  );
}

export function ModelTrigger({ onClick, model, className, provider, showBalance = true }: { onClick: () => void; model?: string; className?: string; provider?: "official" | "private"; showBalance?: boolean }) {
  const { selectedModel, preferredProvider: storyProvider, mixMode, modelPool, language } = useYumina();
  const preferredProvider = provider ?? storyProvider;
  const currentModel = model || selectedModel;
  const lang: Lang = pickLang(language);
  const s = STRINGS[lang];

  const displayName = useMemo(() => {
    if (preferredProvider === "official") {
      const found = OFFICIAL_MODELS.find((m) => m.id === currentModel);
      return found?.name ?? formatModelId(currentModel);
    }
    return formatModelId(currentModel);
  }, [currentModel, preferredProvider]);

  const tierInfo = useMemo(() => {
    if (preferredProvider !== "official") return null;
    const found = OFFICIAL_MODELS.find((m) => m.id === currentModel);
    if (!found) return null;
    return TIER_META[found.tier];
  }, [currentModel, preferredProvider]);

  const isMix = !model && mixMode && modelPool && modelPool.length >= 2;

  const poolPcts = useMemo(() => {
    if (!isMix) return [];
    return poolPercentages(modelPool);
  }, [isMix, modelPool]);

  const balance = useMushieBalance();

  if (isMix) {
    return (
      <button
        onClick={onClick}
        data-hint-anchor="model"
        className={[
          // em paddings/gap (= px-3 py-1.5 gap-2 at 16px) so the pill grows
          // with Android textZoom-inflated text instead of losing its padding.
          "group flex items-center gap-[0.5em] rounded-full border border-primary/25 bg-primary/[0.06] px-[0.75em] py-[0.375em] transition-all hover:border-primary/40 hover:bg-primary/[0.12]",
          className ?? "mx-auto",
        ].join(" ")}
      >
        <Shuffle className="h-3 w-3 text-primary/70" />
        <div className="flex h-1.5 w-8 overflow-hidden rounded-full bg-white/[0.08]">
          {poolPcts.map((entry: { modelId: string; pct: number }, i: number) => (
            <div
              key={entry.modelId}
              className={MIX_COLORS[i % MIX_COLORS.length]}
              style={{ width: `${entry.pct}%` }}
            />
          ))}
        </div>
        <span className="text-[11px] font-medium text-primary/80 group-hover:text-primary transition-colors">
          {s.mixModels} · {modelPool.length}
        </span>
        {showBalance && balance != null && <BalanceTag balance={balance} language={language} dividerClass="bg-primary/20" />}
        <ChevronRight className="h-3 w-3 text-primary/45 group-hover:text-primary/70 transition-colors" />
      </button>
    );
  }
  return (
    <button
      onClick={onClick}
      data-hint-anchor="model"
      className={[
        // em paddings/gap — see the mix-mode pill above.
        "group flex min-w-0 items-center gap-[0.5em] rounded-full border border-white/[0.12] bg-white/[0.05] px-[0.75em] py-[0.375em] transition-all hover:border-white/20 hover:bg-white/[0.09]",
        className ?? "mx-auto",
      ].join(" ")}
    >
      {tierInfo && (
        <div className={`h-1.5 w-1.5 rounded-full ${tierInfo.dot} opacity-90`} />
      )}
      <span className="truncate text-[11px] font-medium text-white/75 transition-colors group-hover:text-white">
        {displayName}
      </span>
      {showBalance && balance != null && <BalanceTag balance={balance} language={language} />}
      <ChevronRight className="h-3 w-3 text-white/45 group-hover:text-white/70 transition-colors" />
    </button>
  );
}
