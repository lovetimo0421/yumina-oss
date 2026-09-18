/** Acquisition labels only: never retain full URLs, query strings or click IDs. */
export function acquisitionSource(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const raw = value.trim().toLowerCase();
  if (raw === "$direct" || raw === "direct") return "Direct";
  let host: string;
  try { host = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname; }
  catch { return null; }
  if (host === "yumina.io" || host.endsWith(".yumina.io") || host === "localhost" || host === "127.0.0.1"
    || /^accounts\.google\./.test(host) || /^(login|accounts|auth|mail|webmail|wx\.mail|wap\.mail)\./.test(host)
    || /(^|\.)(temp-mail|tempmail|emailtick|emailnator)\./.test(host)
    || host === "com.google.android.gm" || host === "outlook.live.com") return null;
  if (/(^|\.)youtube\.com$/.test(host) || host === "youtu.be") return "YouTube";
  if (/(^|\.)reddit\.com$/.test(host) || host === "com.reddit.frontpage") return "Reddit";
  if (/(^|\.)google\.[a-z.]+$/.test(host) || host === "com.google.android.googlequicksearchbox") return "Google";
  if (/(^|\.)bing\.com$/.test(host)) return "Bing";
  if (/(^|\.)discord\.(com|gg)$/.test(host)) return "Discord";
  if (/(^|\.)(x|twitter)\.com$/.test(host) || host === "com.twitter.android") return "X";
  if (/(^|\.)threads\.(com|net)$/.test(host)) return "Threads";
  if (/(^|\.)instagram\.com$/.test(host)) return "Instagram";
  if (/(^|\.)facebook\.com$/.test(host)) return "Facebook";
  if (host === "chatgpt.com") return "ChatGPT";
  return host.replace(/^www\./, "").slice(0, 120);
}

export function signupAttribution(p: Record<string, unknown>) {
  const field = (name: string) => typeof p[name] === "string" ? (p[name] as string).trim().slice(0, 200) : "";
  const campaignSource = (source: string) => ({ reddit: "Reddit", youtube: "YouTube", google: "Google", facebook: "Facebook", instagram: "Instagram", twitter: "X", x: "X", "chatgpt.com": "ChatGPT" })[source.toLowerCase()] || source;
  // New first-party arrival survives OAuth and PostHog identity resets.
  if (field("arrival_source")) return { source: field("arrival_source"), medium: field("arrival_medium"), campaign: field("arrival_campaign") };
  if (field("utm_source")) return { source: campaignSource(field("utm_source")), medium: field("utm_medium"), campaign: field("utm_campaign") };
  return { source: acquisitionSource(field("$referring_domain") || field("$referrer")) || "Unattributed", medium: "", campaign: "" };
}
