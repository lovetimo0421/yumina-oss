/** A durable image from the player's personal Assets library. */
export interface ChatImageAttachment {
  type: "image";
  assetId: string;
  mimeType: string;
  name: string;
  url: string;
}

const en = {
  title: "Choose image", images: "Images", root: "My Assets", upload: "Upload image",
  search: "Search this folder", add: "Add to message", empty: "No images in this folder",
  noMatches: "No matching images or folders", selected: "1 image selected", none: "No image selected",
  previous: "Previous", next: "Next", loading: "Loading…", failed: "Could not load images",
  retry: "Retry", remove: "Remove image", uploading: "Uploading…",
};
type Copy = typeof en;
const copies: Record<string, Copy> = {
  en,
  zh: { title: "选择图片", images: "图片", root: "我的 Assets", upload: "上传图片", search: "搜索当前文件夹", add: "添加到消息", empty: "此文件夹暂无图片", noMatches: "没有匹配的图片或文件夹", selected: "已选 1 张", none: "未选择图片", previous: "上一页", next: "下一页", loading: "加载中…", failed: "图片加载失败", retry: "重试", remove: "移除图片", uploading: "上传中…" },
  "zh-Hant": { title: "選擇圖片", images: "圖片", root: "我的 Assets", upload: "上傳圖片", search: "搜尋目前資料夾", add: "新增至訊息", empty: "此資料夾暫無圖片", noMatches: "沒有符合的圖片或資料夾", selected: "已選 1 張", none: "未選擇圖片", previous: "上一頁", next: "下一頁", loading: "載入中…", failed: "圖片載入失敗", retry: "重試", remove: "移除圖片", uploading: "上傳中…" },
  ja: { title: "画像を選択", images: "画像", root: "マイ Assets", upload: "画像をアップロード", search: "このフォルダーを検索", add: "メッセージに追加", empty: "このフォルダーに画像はありません", noMatches: "一致する画像やフォルダーはありません", selected: "1 枚選択中", none: "画像が未選択です", previous: "前へ", next: "次へ", loading: "読み込み中…", failed: "画像を読み込めませんでした", retry: "再試行", remove: "画像を削除", uploading: "アップロード中…" },
  es: { title: "Elegir imagen", images: "Imágenes", root: "Mis Assets", upload: "Subir imagen", search: "Buscar en esta carpeta", add: "Añadir al mensaje", empty: "Esta carpeta no tiene imágenes", noMatches: "No hay imágenes ni carpetas coincidentes", selected: "1 imagen seleccionada", none: "Ninguna imagen seleccionada", previous: "Anterior", next: "Siguiente", loading: "Cargando…", failed: "No se pudieron cargar las imágenes", retry: "Reintentar", remove: "Quitar imagen", uploading: "Subiendo…" },
};
export function chatImageCopy(language = "en"): Copy {
  if (/^zh-(hant|tw|hk)/i.test(language)) return copies["zh-Hant"]!;
  return copies[language.split("-")[0]!] ?? en;
}
