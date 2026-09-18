/**
 * Helpers for Settings → Account → Login devices.
 *
 * Kept out of settings-page.tsx so the User-Agent parsing is unit-testable:
 * the labels are the only thing a player has to go on when deciding whether a
 * session is theirs, so a wrong label ("Android" for a TV box) is the
 * difference between spotting an intruder and shrugging past one.
 */

export type ActiveSession = {
  id: string;
  token: string;
  createdAt: string | Date;
  updatedAt: string | Date;
  ipAddress?: string | null;
  userAgent?: string | null;
};

export type DeviceDescription = { device: string; browser: string };

/**
 * Turn a raw User-Agent into something a player recognizes ("iPhone · Safari").
 * Deliberately coarse: the point is "is this the phone I left logged in at my
 * cousin's place", not analytics-grade fingerprinting.
 *
 * Order matters. Every Chromium browser still ships "Safari/537.36" in its UA,
 * Edge and Opera both ship "Chrome/", and Android TV boxes ship "Android" —
 * so the most specific token has to win, checked first.
 */
export function describeDevice(ua: string | null | undefined): DeviceDescription {
  const s = ua ?? "";
  if (!s) return { device: "", browser: "" };

  let device = "";
  if (/\biPhone\b/i.test(s)) device = "iPhone";
  else if (/\biPad\b/i.test(s)) device = "iPad";
  else if (/\bAndroid TV\b|\bGoogleTV\b|\bMiTV\b|\bSmartTV\b|\bBRAVIA\b|\bAFT[A-Z0-9]+\b/i.test(s)) device = "TV";
  else if (/\bAndroid\b/i.test(s)) device = "Android";
  else if (/OpenHarmony|\bHarmonyOS\b|\bArkWeb\//i.test(s)) device = "HarmonyOS";
  else if (/\bMac OS X\b|\bMacintosh\b/i.test(s)) device = "Mac";
  else if (/\bWindows\b/i.test(s)) device = "Windows";
  else if (/\bCrOS\b/i.test(s)) device = "ChromeOS";
  else if (/\bLinux\b|\bX11\b/i.test(s)) device = "Linux";

  // In-app browsers first. These UAs usually also carry "Safari/" or "Chrome/",
  // so the generic checks below would swallow them and show a WeChat webview as
  // plain "Safari" — useless when the player is trying to work out which of
  // their own logins is which. 2.1% of live sessions are one of these.
  let browser = "";
  if (/\bMicroMessenger\//i.test(s)) browser = "WeChat";
  else if (/\bInstagram\b|\bIABMV\//i.test(s)) browser = "Instagram";
  else if (/\bFBAN\/|\bFBAV\/|\bFBOP\/|\bFB_IAB\b/i.test(s)) browser = "Facebook";
  else if (/\bLine\/|\bLIFF\b/i.test(s)) browser = "LINE";
  else if (/\bTikTok\b|\bmusical_ly\b|\bBytedanceWebview\b/i.test(s)) browser = "TikTok";
  else if (/\bWhatsApp\//i.test(s)) browser = "WhatsApp";
  else if (/\bDingTalk\b/i.test(s)) browser = "DingTalk";
  else if (/\bWeibo\b|\bWeiboOverseas\b/i.test(s)) browser = "Weibo";
  else if (/\bQuark\//i.test(s)) browser = "Quark";
  else if (/\bUCBrowser\//i.test(s)) browser = "UC Browser";
  else if (/\bmailapp\/|\bSinaMail\/|\bQQMail\b/i.test(s)) browser = "Mail app";
  // Generic browsers. Order matters: every Chromium UA still ends in
  // "Safari/537.36", Edge/Opera both carry "Chrome/", and "HeadlessChrome/"
  // does NOT match /\bChrome\// (no word boundary inside "sChrome") — without
  // its own token our QA sessions were being labelled Safari.
  else if (/\bEdgA?\//i.test(s)) browser = "Edge";
  else if (/\bOPR\/|\bOpera\//i.test(s)) browser = "Opera";
  else if (/\bSamsungBrowser\//i.test(s)) browser = "Samsung Internet";
  else if (/\bFirefox\/|\bFxiOS\//i.test(s)) browser = "Firefox";
  else if (/HeadlessChrome\//i.test(s)) browser = "Chrome";
  else if (/\bChrome\/|\bCriOS\//i.test(s)) browser = "Chrome";
  else if (/\bSafari\//i.test(s)) browser = "Safari";
  // Any iOS WKWebView that named no app at all — still an app, not Safari.
  else if (device === "iPhone" || device === "iPad") browser = "In-app browser";

  return { device, browser };
}

/** "iPhone · Safari", or "" when the UA tells us nothing usable. */
export function deviceLabel(ua: string | null | undefined): string {
  const { device, browser } = describeDevice(ua);
  return [device, browser].filter(Boolean).join(" · ");
}

export function formatSessionTime(value: string | Date | undefined | null, locale: string): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(locale, {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

/**
 * Current device pinned to the top (it's the one row the player must NOT kill
 * by accident), then most recently active first.
 */
export function sortSessions(sessions: ActiveSession[], currentToken: string | null): ActiveSession[] {
  return [...sessions].sort((a, b) => {
    if (a.token === currentToken) return -1;
    if (b.token === currentToken) return 1;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
}
