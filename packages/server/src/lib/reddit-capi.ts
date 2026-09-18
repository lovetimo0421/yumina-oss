/**
 * Open-source edition stub. Ad-conversion reporting is a hosted concern; the
 * local build never talks to an ads API.
 */
export interface RedditConversionOpts {
  [key: string]: unknown;
}

export function sendRedditConversion(_opts: RedditConversionOpts): void {}
