import { signupAttribution } from "@yumina/shared";

const KEY = "yumina:arrival:v1";
type Arrival = { source: string; medium: string; campaign: string; at: number };
let arrival: Arrival | null = null;

/** First observed arrival, retained through OAuth. Never stores the full URL. */
export function rememberArrival() {
  if (typeof window === "undefined") return;
  try {
    const prior = JSON.parse(localStorage.getItem(KEY) || "null") as Arrival | null;
    if (prior && typeof prior.source === "string" && typeof prior.medium === "string" && typeof prior.campaign === "string"
      && Number.isFinite(prior.at) && prior.at <= Date.now() && Date.now() - prior.at < 30 * 86400_000) {
      arrival = prior; return;
    }
  } catch { /* Storage may be disabled; the in-memory observation still works. */ }
  const url = new URL(window.location.href);
  const source = signupAttribution({ utm_source: url.searchParams.get("utm_source"), utm_medium: url.searchParams.get("utm_medium"),
    utm_campaign: url.searchParams.get("utm_campaign"), $referrer: document.referrer || "$direct" });
  // OAuth/email/internal arrivals are not evidence of the original source.
  if (source.source === "Unattributed") return;
  arrival = { ...source, at: Date.now() };
  try { localStorage.setItem(KEY, JSON.stringify(arrival)); } catch { /* best effort */ }
}

export function arrivalProperties() {
  return arrival ? { arrival_source: arrival.source, arrival_medium: arrival.medium, arrival_campaign: arrival.campaign,
    arrival_at: new Date(arrival.at).toISOString() } : {};
}
