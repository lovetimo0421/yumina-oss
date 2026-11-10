import { Component, useState, type CSSProperties, type ErrorInfo, type ReactNode } from "react";
import { createCodeDiagnostic, formatCodeDiagnostic, type CodeDiagnostic } from "./diagnostics";

const en = {
  title: "Game interface failed to load", compile: "Compile", resolve: "Resolve imports", load: "Load code", render: "Render component",
  phase: "Stage", type: "Type", source: "Source", unknown: "Not located", details: "Error details", stack: "Stack (generated code)", component: "Component stack",
  copy: "Copy diagnostic", copied: "Copied", copyFailed: "Could not copy. Select the diagnostic text to copy it.", ask: "Ask AI to investigate",
  import: "Check import/export syntax and dependencies. The exact source has not been located.", reference: "Check whether the named value is declared or imported before use.", revision: "Code revision",
};
type Labels = typeof en;
const translations: Record<string, Labels> = {
  en,
  zh: { title: "游戏界面加载失败", compile: "编译代码", resolve: "解析导入", load: "加载代码", render: "渲染组件", phase: "阶段", type: "类型", source: "源位置", unknown: "未定位", details: "错误详情", stack: "堆栈（生成代码）", component: "组件调用栈", copy: "复制诊断", copied: "已复制", copyFailed: "复制失败，可选中诊断文本手动复制。", ask: "交给 AI 排查", import: "请检查 import/export 写法及依赖。具体来源尚未定位。", reference: "请检查错误中提到的值是否已声明或导入。", revision: "代码版本" },
  "zh-Hant": { title: "遊戲介面載入失敗", compile: "編譯程式碼", resolve: "解析匯入", load: "載入程式碼", render: "渲染元件", phase: "階段", type: "類型", source: "來源位置", unknown: "未定位", details: "錯誤詳情", stack: "堆疊（生成程式碼）", component: "元件呼叫堆疊", copy: "複製診斷", copied: "已複製", copyFailed: "複製失敗，可選取診斷文字手動複製。", ask: "交給 AI 排查", import: "請檢查 import/export 寫法及依賴。具體來源尚未定位。", reference: "請檢查錯誤中提到的值是否已宣告或匯入。", revision: "程式碼版本" },
  ja: { title: "ゲーム画面を読み込めません", compile: "コンパイル", resolve: "インポート解決", load: "コード読み込み", render: "コンポーネント描画", phase: "段階", type: "種類", source: "ソース位置", unknown: "特定できません", details: "エラー詳細", stack: "スタック（生成コード）", component: "コンポーネントスタック", copy: "診断をコピー", copied: "コピーしました", copyFailed: "コピーできません。診断テキストを選択してコピーしてください。", ask: "AI に調査を依頼", import: "import/export の書き方と依存関係を確認してください。発生箇所は未特定です。", reference: "エラーに示された値が宣言またはインポートされているか確認してください。", revision: "コード版" },
  es: { title: "No se pudo cargar la interfaz del juego", compile: "Compilación", resolve: "Resolver importaciones", load: "Cargar código", render: "Renderizar componente", phase: "Etapa", type: "Tipo", source: "Ubicación", unknown: "Sin localizar", details: "Detalles del error", stack: "Pila (código generado)", component: "Pila de componentes", copy: "Copiar diagnóstico", copied: "Copiado", copyFailed: "No se pudo copiar. Selecciona el diagnóstico y cópialo manualmente.", ask: "Pedir al AI que investigue", import: "Revisa la sintaxis import/export y las dependencias. Aún no se ha localizado el origen.", reference: "Comprueba si el valor indicado está declarado o importado antes de usarlo.", revision: "Versión del código" },
};
export function diagnosticLabels(language = "en"): Labels {
  if (/^zh-(hant|tw|hk)/i.test(language)) return translations["zh-Hant"];
  return translations[language.split("-")[0]] ?? en;
}

const mono: CSSProperties = { fontFamily: "monospace", fontSize: 12, lineHeight: 1.65, whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: "10px 0" };
const button: CSSProperties = { font: "inherit", fontSize: 12, padding: "8px 12px", borderRadius: 6, border: "1px solid var(--color-border, #443b37)", background: "var(--color-card, #211e1c)", color: "var(--color-foreground, #ebe6e3)", cursor: "pointer", minHeight: 36 };

/** No app stores, router, Tailwind or i18next dependency: also used in the iframe. */
export function CodeDiagnosticCard({ diagnostic: d, language, onAsk }: {
  diagnostic: CodeDiagnostic; language?: string; onAsk?: (diagnostic: CodeDiagnostic) => void;
}) {
  const labels = diagnosticLabels(language);
  const [status, setStatus] = useState("");
  const copy = async () => {
    const value = formatCodeDiagnostic(d);
    let ok = false;
    try { await navigator.clipboard.writeText(value); ok = true; }
    catch {
      const area = document.createElement("textarea");
      area.value = value;
      area.style.cssText = "position:fixed;opacity:0;pointer-events:none";
      document.body.appendChild(area);
      area.select();
      try { ok = document.execCommand("copy"); } catch { /* Show a visible failure, not a false success. */ }
      finally { area.remove(); }
    }
    setStatus(ok ? labels.copied : labels.copyFailed);
  };
  return <section aria-label={labels.title} style={{ color: "var(--color-foreground, #ebe6e3)", background: "var(--color-card, #1d1b1b)", border: "1px solid var(--color-border, #443b37)", borderLeft: "3px solid #d3544b", borderRadius: 9, margin: 16, padding: 20, fontFamily: "Inter, sans-serif", fontSize: 13, lineHeight: 1.6, minWidth: 0 }}>
    <div style={{ fontSize: 12, color: "var(--color-destructive, #d3544b)", marginBottom: 8 }}>{labels.title}</div>
    <strong style={{ fontSize: 16, fontWeight: 600 }}>{labels[d.phase]}</strong>
    <pre style={{ ...mono, color: "var(--color-destructive, #d3544b)", background: "rgba(211,84,75,.08)", padding: 12, borderRadius: 6 }}>{d.message}</pre>
    {d.hint && !(d.hint === "import" && d.file) && <p style={{ fontSize: 12, color: "var(--color-muted-foreground, #aca19b)" }}>{labels[d.hint]}</p>}
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {onAsk && <button type="button" style={{ ...button, background: "var(--color-primary, #be8058)", color: "var(--color-primary-foreground, #18120f)" }} onClick={() => onAsk(d)}>{labels.ask}</button>}
      <button type="button" style={button} onClick={() => void copy()}>{labels.copy}</button>
    </div>
    <details open style={{ borderTop: "1px solid var(--color-border, #443b37)", paddingTop: 12, marginTop: 18 }}>
      <summary style={{ cursor: "pointer", fontSize: 12 }}>{labels.details}</summary>
      <dl style={{ display: "grid", gridTemplateColumns: "auto minmax(0,1fr)", gap: "7px 12px", fontSize: 12, margin: "14px 0" }}>
        <dt>{labels.phase}</dt><dd style={{ margin: 0 }}>{labels[d.phase]}</dd>
        <dt>{labels.type}</dt><dd style={{ margin: 0, overflowWrap: "anywhere" }}>{d.name}</dd>
        <dt>{labels.source}</dt><dd style={{ margin: 0, overflowWrap: "anywhere" }}>{d.file ?? labels.unknown}{d.line ? `:${d.line}${d.column ? `:${d.column}` : ""}` : ""}</dd>
        {d.revision && <><dt>{labels.revision}</dt><dd style={{ margin: 0, fontFamily: "monospace" }}>{d.revision}</dd></>}
      </dl>
      {d.excerpt && <pre style={mono}>{d.excerpt}</pre>}
      {d.stack && <details><summary style={{ cursor: "pointer", fontSize: 12 }}>{labels.stack}</summary><pre style={mono}>{d.stack}</pre></details>}
      {d.componentStack && <details><summary style={{ cursor: "pointer", fontSize: 12 }}>{labels.component}</summary><pre style={mono}>{d.componentStack}</pre></details>}
    </details>
    {status && <p role="status" style={{ fontSize: 12, marginBottom: 0 }}>{status}</p>}
  </section>;
}

export class CodeDiagnosticBoundary extends Component<{
  children: ReactNode;
  files?: Record<string, string>;
  language?: string;
  onAsk?: (diagnostic: CodeDiagnostic) => void;
  onError?: (diagnostic: CodeDiagnostic) => void;
}, { diagnostic: CodeDiagnostic | null }> {
  state = { diagnostic: null as CodeDiagnostic | null };
  static getDerivedStateFromError(error: unknown) {
    return { diagnostic: createCodeDiagnostic(error, { phase: "render" }) };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    const diagnostic = createCodeDiagnostic(error, { phase: "render", files: this.props.files, componentStack: info.componentStack });
    this.setState({ diagnostic });
    this.props.onError?.(diagnostic);
  }
  render() {
    return this.state.diagnostic ? <CodeDiagnosticCard diagnostic={this.state.diagnostic} language={this.props.language} onAsk={this.props.onAsk} /> : this.props.children;
  }
}
