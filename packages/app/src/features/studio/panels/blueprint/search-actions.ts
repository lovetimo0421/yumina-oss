/**
 * The board's search finds places on the board; a creator who does not know
 * where a feature lives types its name there too ("theme", "code",
 * "template") and found nothing (a new creator, 11/08, posted asking where
 * the theme's code was). These are the features the search answers with,
 * above what the card's own content matches.
 */
export type SearchAction = "code" | "look" | "switch" | "saveTemplate" | "market";

/** The words people use for each, in the five UI languages, lower case. */
const WORDS: Record<SearchAction, readonly string[]> = {
  code: ["code", "tsx", "script", "html", "css", "javascript", "frontend", "front end", "代码", "程式", "程序", "源码", "コード", "スクリプト", "código", "codigo"],
  look: ["theme", "look", "colour", "color", "style", "font", "skin", "design", "主题", "外观", "颜色", "配色", "风格", "字体", "皮肤", "样式", "主題", "外觀", "顏色", "風格", "字體", "樣式", "テーマ", "色", "フォント", "デザイン", "tema", "estilo", "fuente", "apariencia"],
  switch: ["layout", "interface", "screen", "ui", "界面", "换界面", "版式", "布局", "介面", "換介面", "版面", "レイアウト", "画面", "interfaz", "diseño", "pantalla"],
  saveTemplate: ["template", "preset", "save", "export", "bundle", "pack", "模板", "预设", "存", "保存", "导出", "资源包", "範本", "預設", "匯出", "資源包", "テンプレート", "プリセット", "保存", "エクスポート", "plantilla", "preajuste", "guardar", "exportar", "paquete"],
  market: ["market", "store", "shop", "市场", "资源市场", "市場", "資源市場", "マーケット", "mercado", "tienda"],
};

const ORDER: readonly SearchAction[] = ["look", "code", "switch", "saveTemplate", "market"];

/** A Latin query needs two letters before it means a word; one CJK
 *  character already does. */
const tooShort = (q: string) => q.length < 2 && !/[぀-ヿ㐀-鿿]/.test(q);

/** The features a search query asks for, most likely first. A query matches
 *  a word it starts (「主」 for 主题, "tem" for template) or contains whole
 *  ("change the theme colour"). */
export function searchActions(query: string): SearchAction[] {
  const q = query.trim().toLowerCase();
  if (!q || tooShort(q)) return [];
  return ORDER.filter((action) => WORDS[action].some((word) => word.startsWith(q) || q.includes(word)));
}
