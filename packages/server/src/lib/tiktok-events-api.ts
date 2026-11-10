/**
 * Open-source edition stub. Ad-conversion reporting is a hosted concern; the
 * local build never talks to an ads API.
 */
export interface TikTokEventOpts {
  [key: string]: unknown;
}

export function sendTikTokEvent(_opts: TikTokEventOpts): void {}

export function tikTokCookieKeys(_cookieHeader: string | null | undefined): { ttclid: string | null; ttp: string | null } {
  return { ttclid: null, ttp: null };
}
