import { Image } from "lucide-react";

export function ImageCapabilityBadge({ supported, language = typeof document === "undefined" ? "en" : document.documentElement.lang }: { supported?: boolean; language?: string }) {
  if (supported !== true) return null;
  const label = language.startsWith("zh") ? "读图" : language.startsWith("ja") ? "画像" : language.startsWith("es") ? "Imágenes" : "Vision";
  return <span className="inline-flex shrink-0 items-center gap-1 rounded bg-violet-400/10 px-1.5 py-0.5 text-[10px] font-medium text-violet-300"><Image aria-hidden="true" className="h-3 w-3" />{label}</span>;
}
