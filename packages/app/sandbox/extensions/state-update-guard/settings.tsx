import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { DEFAULT_STATE_GUARD_MODEL, FREE_STATE_GUARD_MODEL, parseStateGuardModel, stateGuardModelSelection, type StateGuardSettings } from "@yumina/shared";

const copy = {
  en: ["Enabled for this chat", "On", "Off", "Correction model", "Same as story model", "Used only when a reply needs correction; does not change your story model. Uses your current AI Provider connection.", "Changes apply to the next reply. Off restores normal card updates without format checking or correction. It does not uninstall the extension.", "Loading settings…", "Saving…", "Saved", "Could not load settings.", "Could not confirm the save. Retry reloads the current settings; check your provider and model access if selection failed.", "Retry", "Could not load models. You can still turn the guard off.", "Unavailable in preview or replay."],
  zh: ["在此聊天中启用", "开启", "停用", "修正模型", "与剧情模型相同", "仅在回复需要修正时使用，不会更改剧情模型。使用当前 AI 供应商连接。", "更改从下一条回复开始生效。停用后恢复卡片原有更新方式，不再检查或修正格式，不会卸载扩展。", "正在加载设置…", "正在保存…", "已保存", "无法加载设置。", "无法确认保存结果。重试可重新加载当前设置；模型选择失败时请检查供应商连接和模型权限。", "重试", "无法加载模型，仍可停用守卫。", "预览或回放中不可用。"],
  "zh-Hant": ["在此聊天中啟用", "啟用", "停用", "修正模型", "與劇情模型相同", "僅在回覆需要修正時使用，不會更改劇情模型。使用目前的 AI 供應商連線。", "變更從下一則回覆開始生效。停用後恢復卡片原有更新方式，不再檢查或修正格式，不會解除安裝擴充功能。", "正在載入設定…", "正在儲存…", "已儲存", "無法載入設定。", "無法確認儲存結果。重試可重新載入目前設定；模型選擇失敗時請檢查供應商連線和模型權限。", "重試", "無法載入模型，仍可停用守衛。", "預覽或重播中無法使用。"],
  ja: ["このチャットで有効", "オン", "オフ", "修正モデル", "物語と同じモデル", "修正が必要な返信にのみ使用します。物語モデルは変わりません。現在のAIプロバイダー接続を使用します。", "変更は次の返信から有効です。オフでは形式確認・修正なしで通常のカード更新を行います。拡張機能は削除されません。", "設定を読み込み中…", "保存中…", "保存しました", "設定を読み込めませんでした。", "保存結果を確認できません。再試行で現在の設定を読み直します。モデル選択の失敗時は接続と権限を確認してください。", "再試行", "モデルを読み込めませんでした。ガードはオフにできます。", "プレビュー・リプレイでは使用できません。"],
  es: ["Activado para este chat", "Activado", "Desactivado", "Modelo de corrección", "Mismo modelo que la historia", "Solo se usa si una respuesta necesita corrección; no cambia el modelo narrativo. Usa tu conexión actual de proveedor de IA.", "Los cambios se aplican a la siguiente respuesta. Al desactivarlo, la tarjeta se actualiza sin comprobar ni corregir el formato. No desinstala la extensión.", "Cargando ajustes…", "Guardando…", "Guardado", "No se pudieron cargar los ajustes.", "No se pudo confirmar el guardado. Reintentar recarga los ajustes; revisa la conexión y el acceso al modelo si falló la selección.", "Reintentar", "No se pudieron cargar modelos. Aún puedes desactivar la protección.", "No disponible en vista previa o repetición."],
} as const;
const compactCopy = {
  en: ["This extension is off.", "Only corrects invalid state updates. Changes apply to the next reply."],
  zh: ["此扩展已停用。", "仅修正无效的状态更新。更改从下一条回复开始生效。"],
  "zh-Hant": ["此擴充功能已停用。", "僅修正無效的狀態更新。變更從下一則回覆開始生效。"],
  ja: ["この拡張機能はオフです。", "無効な状態更新のみ修正します。変更は次の返信から有効です。"],
  es: ["Esta extensión está desactivada.", "Solo corrige actualizaciones de estado inválidas. Los cambios se aplican a la siguiente respuesta."],
} as const;
const defaultModelLabels = { en: "Default model", zh: "默认模型", "zh-Hant": "預設模型", ja: "既定のモデル", es: "Modelo predeterminado" };
const billingCopy = {
  en: ["Paid per correction", "Use free model", "Free updates", "Your API provider may charge; no Yumina mushies.", "Only saved corrections are charged. Format checks are free."],
  zh: ["按次修正计费", "使用免费模型", "免费更新", "自备 API 由服务商计费，不扣除 Yumina 蘑菇。", "仅保存成功的修正收费，格式检查免费。"],
  "zh-Hant": ["按次修正計費", "使用免費模型", "免費更新", "自備 API 由服務商計費，不扣除 Yumina 蘑菇。", "僅儲存成功的修正收費，格式檢查免費。"],
  ja: ["修正ごとに課金", "無料モデルを使う", "無料の更新", "自分のAPIはプロバイダーが課金します。Yuminaのマッシュは不要です。", "保存された修正のみ課金されます。形式チェックは無料です。"],
  es: ["Pago por corrección", "Usar modelo gratuito", "Actualizaciones gratuitas", "Tu proveedor de API puede cobrar; no se cobran mushies de Yumina.", "Solo se cobran las correcciones guardadas. Comprobar el formato es gratis."],
} as const;
const legacyBillingCopy = {
  en: "Yumina models: paid per correction. BYOK: provider charges only.",
  zh: "Yumina 模型按次修正计费；自备 API 仅由服务商收费。",
  "zh-Hant": "Yumina 模型按次修正計費；自備 API 僅由服務商收費。",
  ja: "Yuminaモデルは修正ごとに課金。自分のAPIはプロバイダーの料金のみ。",
  es: "Modelos de Yumina: pago por corrección. BYOK: solo cobra tu proveedor.",
};
function languageKey(language?: string) {
  return language?.startsWith("zh-Hant") || language?.startsWith("zh-TW") ? "zh-Hant" : language?.startsWith("zh") ? "zh" : language?.startsWith("ja") ? "ja" : language?.startsWith("es") ? "es" : "en";
}
export function guardSettingsLabels(language?: string) {
  return copy[languageKey(language)];
}
export interface StateGuardSettingsProps {
  sessionId: string;
  language?: string;
  readOnly?: boolean;
  officialModels?: boolean;
  /** Local edition uses the current story's BYOK model when no override exists. */
  storyModel?: string;
  load: () => Promise<StateGuardSettings>;
  save: (patch: Partial<StateGuardSettings>) => Promise<StateGuardSettings>;
  getModels: () => Promise<Array<{ id: string; name: string }>>;
  /** Sandbox reuses Memory's full picker; host has the same model-list fallback. */
  chooseModel?: (selected: string | null, save: (model: string) => void) => void;
  /** Reuse the exact Memory model trigger without coupling the host to sandbox context. */
  renderModel?: (model: string | null, onClick: () => void) => ReactNode;
}
export function StateGuardSettingsPanel(props: StateGuardSettingsProps) {
  const text = guardSettingsLabels(props.language);
  const compact = compactCopy[languageKey(props.language)];
  const billing = billingCopy[languageKey(props.language)];
  const modelId = useId();
  const [settings, setSettings] = useState<StateGuardSettings | null>(null);
  const [models, setModels] = useState<Array<{ id: string; name: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [modelError, setModelError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [reload, setReload] = useState(0);
  const generation = useRef(0);
  const saving = useRef(false);
  const current = useRef(props); current.current = props;
  const officialModels = props.officialModels ?? settings?.officialModels ?? true;
  const savedSelection = parseStateGuardModel(settings?.model);
  const localModel = savedSelection.provider !== "official" ? savedSelection.model ?? props.storyModel : props.storyModel;
  const selectedModel = officialModels ? settings?.model ?? DEFAULT_STATE_GUARD_MODEL : localModel ? stateGuardModelSelection(localModel, "private") : null;
  useEffect(() => {
    const version = ++generation.current;
    setSettings(null); setError(null); setModels([]); setModelError(false); setSaved(false); setBusy(false); saving.current = false;
    if (props.readOnly || !props.sessionId) return;
    current.current.load().then((value) => { if (version === generation.current) setSettings(value); })
      .catch(() => { if (version === generation.current) setError("load"); });
    current.current.getModels().then((value) => { if (version === generation.current) setModels(value); })
      .catch(() => { if (version === generation.current) setModelError(true); });
    return () => { generation.current++; };
  }, [props.sessionId, props.readOnly, reload]);
  const save = async (patch: Partial<StateGuardSettings>) => {
    if (saving.current || !settings || props.readOnly) return;
    const version = generation.current;
    saving.current = true; setBusy(true); setError(null); setSaved(false);
    try {
      const value = await current.current.save(patch);
      if (version === generation.current) { setSettings(value); setSaved(true); }
    } catch { if (version === generation.current) setError("save"); }
    finally { if (version === generation.current) { saving.current = false; setBusy(false); } }
  };
  if (props.readOnly || !props.sessionId) return <p className="mb-4 text-sm text-white/70">{text[14]}</p>;
  return <section className="space-y-4 text-sm" aria-busy={busy}>
    {settings ? <>
      <div className="flex min-h-11 items-center justify-between gap-3">
        <span>{text[0]}</span>
        <button type="button" role="switch" aria-checked={settings.enabled} aria-label={text[0]} disabled={busy}
          onClick={() => void save({ enabled: !settings.enabled })}
          className={`min-h-11 min-w-16 cursor-pointer rounded-full border px-3 py-2 text-xs font-medium transition-colors focus-visible:outline focus-visible:outline-2 disabled:opacity-50 ${settings.enabled ? "border-primary/30 bg-primary/10 text-primary hover:bg-primary/15" : "border-white/15 bg-white/5 text-white/70 hover:bg-white/10"}`}>
          {settings.enabled ? text[1] : text[2]}
        </button>
      </div>
      {!settings.enabled ? <p className="py-2 text-white/70">{compact[0]}</p> : <>
      <fieldset disabled={busy} className="min-w-0 space-y-2 rounded-lg border border-white/10 bg-white/[0.025] p-3 disabled:opacity-50">
      <legend className="sr-only">{text[3]}</legend>
      <p id={modelId} className="text-xs font-medium text-white/70">{text[3]}</p>
      {props.chooseModel ? <div className="flex flex-wrap items-center gap-2">
        {props.renderModel ? props.renderModel(selectedModel, () => props.chooseModel?.(selectedModel, (model) => void save({ model }))) : <button type="button" disabled={busy} aria-labelledby={modelId} onClick={() => props.chooseModel?.(selectedModel, (model) => void save({ model }))}
          className="min-h-11 max-w-full break-all rounded-lg border border-white/30 px-3 py-2 text-left hover:bg-white/10 disabled:opacity-50">
          {settings.model && (officialModels || savedSelection.provider !== "official") ? models.find((m) => m.id === settings.model)?.name ?? settings.model : defaultModelLabels[languageKey(props.language)]}
        </button>}
      </div> : <select aria-labelledby={modelId} value={!officialModels && savedSelection.provider === "official" ? "" : settings.model ?? ""} disabled={busy} onChange={(event) => void save({ model: event.target.value || null })}
        className="min-h-11 w-full min-w-0 rounded-lg border border-white/30 bg-zinc-950 px-3 py-2 text-white">
        <option value="">{officialModels ? "Gemini 2.5 Flash Lite" : props.storyModel ?? defaultModelLabels[languageKey(props.language)]}</option>
        {settings.model && (officialModels || savedSelection.provider !== "official") && !models.some((m) => m.id === settings.model) && <option value={settings.model}>{settings.model}</option>}
        {models.filter((model) => officialModels || parseStateGuardModel(model.id).provider !== "official").map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
      </select>}
      <div className="flex flex-wrap items-center gap-2 text-xs text-white/60">
        <span>{!officialModels || parseStateGuardModel(settings.model ?? DEFAULT_STATE_GUARD_MODEL).provider === "private" || settings.model?.startsWith("custom/") ? billing[3]
          : settings.model && !parseStateGuardModel(settings.model).provider ? legacyBillingCopy[languageKey(props.language)]
          : parseStateGuardModel(settings.model).model === "openrouter/free" || parseStateGuardModel(settings.model).model?.endsWith(":free") ? billing[2] : billing[0]}</span>
        {officialModels && settings.model !== FREE_STATE_GUARD_MODEL && <button type="button" onClick={() => void save({ model: FREE_STATE_GUARD_MODEL })}
          className="min-h-11 cursor-pointer rounded-md border border-emerald-300/20 bg-emerald-500/10 px-3 py-2 text-emerald-200 hover:bg-emerald-500/20 focus-visible:outline focus-visible:outline-2">{billing[1]}</button>}
      </div>
      {officialModels && <p className="text-xs text-white/60">{billing[4]}</p>}
      </fieldset>
      <p className="text-xs leading-relaxed text-white/60">{compact[1]}</p>
      </>}
    </> : !error && <p role="status">{text[7]}</p>}
    {settings?.enabled && modelError && <p className="text-amber-300">{text[13]}</p>}
    {error && <div role="alert"><p className="text-red-300">{error === "load" ? text[10] : text[11]}</p><button type="button" className="min-h-11 underline" onClick={() => setReload((n) => n + 1)}>{text[12]}</button></div>}
    <p role="status" className={busy ? "text-xs text-white/70" : "sr-only"}>{busy ? text[8] : saved ? text[9] : ""}</p>
  </section>;
}
