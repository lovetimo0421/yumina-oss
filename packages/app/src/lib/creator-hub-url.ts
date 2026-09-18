import i18n from "@/lib/i18n";

const CREATOR_HUB_PRODUCTION_URL = "https://creator.yumina.io";
const CREATOR_HUB_TESTING_PATH = "/creator";

export function isCreatorHost(hostname = typeof window !== "undefined" ? window.location.hostname : ""): boolean {
  return hostname.toLowerCase().startsWith("creator.");
}

function withLangParam(url: string, lang?: string): string {
  const effective = lang ?? i18n.resolvedLanguage ?? i18n.language;
  if (!effective) return url;
  try {
    const base = url.startsWith("http") || url.startsWith("//")
      ? new URL(url)
      : new URL(url, typeof window !== "undefined" ? window.location.origin : "http://localhost");
    base.searchParams.set("lang", effective);
    return url.startsWith("http") || url.startsWith("//")
      ? base.toString()
      : `${base.pathname}${base.search}${base.hash}`;
  } catch {
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}lang=${encodeURIComponent(effective)}`;
  }
}

export function getCreatorHubUrl(lang?: string): string {
  const configuredUrl = import.meta.env.VITE_CREATOR_HUB_URL?.trim();
  if (configuredUrl) return withLangParam(configuredUrl, lang);
  if (typeof window === "undefined") return withLangParam(CREATOR_HUB_TESTING_PATH, lang);

  const hostname = window.location.hostname.toLowerCase();
  if (isCreatorHost(hostname)) {
    return withLangParam(new URL(CREATOR_HUB_TESTING_PATH, window.location.origin).toString(), lang);
  }
  if (hostname === "yumina.io" || hostname === "www.yumina.io") {
    return withLangParam(CREATOR_HUB_PRODUCTION_URL, lang);
  }

  return withLangParam(new URL(CREATOR_HUB_TESTING_PATH, window.location.origin).toString(), lang);
}
