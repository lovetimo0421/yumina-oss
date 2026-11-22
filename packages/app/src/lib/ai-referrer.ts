/**
 * Did this visit begin in an AI assistant? ChatGPT, Claude, Perplexity,
 * Gemini and Copilot either send their host as the referrer or tag the link
 * with utm_source. The first answer in a tab is kept for the whole session
 * (sessionStorage), so later page views report the same source. PostHog
 * gets it as a property on every event (lib/analytics.ts).
 */
export type AiReferrer = "chatgpt" | "claude" | "perplexity" | "gemini" | "copilot";

const HOSTS: ReadonlyArray<readonly [host: string, name: AiReferrer]> = [
  ["chatgpt.com", "chatgpt"],
  ["chat.openai.com", "chatgpt"],
  ["claude.ai", "claude"],
  ["perplexity.ai", "perplexity"],
  ["gemini.google.com", "gemini"],
  ["copilot.microsoft.com", "copilot"],
];
const NAMES = new Set<string>(HOSTS.map(([, name]) => name));

/** The assistant behind a host, subdomains included (www.perplexity.ai), or null. */
export function aiReferrerFromHost(host: string | null | undefined): AiReferrer | null {
  const h = (host ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!h) return null;
  for (const [known, name] of HOSTS) if (h === known || h.endsWith(`.${known}`)) return name;
  return null;
}

/** The referrer URL first, then utm_source (a host like chatgpt.com or a name like chatgpt). */
export function detectAiReferrer(input: { referrer: string | null | undefined; search: string | null | undefined }): AiReferrer | null {
  let host = "";
  try {
    host = input.referrer ? new URL(input.referrer).hostname : "";
  } catch {
    host = "";
  }
  const fromReferrer = aiReferrerFromHost(host);
  if (fromReferrer) return fromReferrer;
  const utm = (new URLSearchParams(input.search ?? "").get("utm_source") ?? "").trim().toLowerCase();
  if (NAMES.has(utm)) return utm as AiReferrer;
  return aiReferrerFromHost(utm);
}

const KEY = "yumina:ai-referrer:v1";
let remembered: AiReferrer | null | undefined;

export type AiReferrerPage = {
  referrer: string;
  search: string;
  storage: Pick<Storage, "getItem" | "setItem"> | null;
};

function currentPage(): AiReferrerPage | null {
  if (typeof window === "undefined" || typeof document === "undefined") return null;
  let storage: AiReferrerPage["storage"] = null;
  try {
    storage = window.sessionStorage;
  } catch {
    storage = null;
  }
  return { referrer: document.referrer, search: window.location.search, storage };
}

/** The session's assistant, found once and kept: the first value wins over later navigations. */
export function rememberAiReferrer(page: AiReferrerPage | null = currentPage()): AiReferrer | null {
  if (remembered !== undefined) return remembered;
  if (!page) return null;
  let prior: string | null = null;
  try {
    prior = page.storage?.getItem(KEY) ?? null;
  } catch {
    prior = null;
  }
  const found = prior && NAMES.has(prior) ? (prior as AiReferrer) : detectAiReferrer(page);
  if (found) {
    try {
      page.storage?.setItem(KEY, found);
    } catch {
      // Storage may be disabled; the in-memory value still serves this tab.
    }
  }
  remembered = found;
  return found;
}

/** For tests. */
export function forgetAiReferrer(): void {
  remembered = undefined;
}
