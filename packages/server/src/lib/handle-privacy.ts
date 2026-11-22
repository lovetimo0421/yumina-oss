/**
 * Handles that give away how to reach their owner.
 *
 * A few members typed their email address or their phone number as a
 * username ("annagmailcom", "13800138000"). The handle is part of the
 * profile's address, so listing that address in the sitemap publishes the
 * contact detail to every crawler. Such a profile is left out of the sitemap
 * and its page carries noindex (lib/seo.ts).
 *
 * The test is kept narrow on purpose. It matches two shapes only, and an
 * ordinary handle that happens to contain "qq" or a year is not one of them.
 */

// Mail services whose name, followed by "com", is not how an ordinary word ends.
const MAIL_HOSTS = ["gmail", "googlemail", "qq", "163", "126", "outlook", "hotmail", "yahoo", "icloud", "foxmail", "protonmail", "naver"];
// Something before the service name (the mailbox), then the service and "com",
// with or without the at sign and the dot the sign-up form stripped.
const EMAIL_SHAPE = new RegExp(`^.+?[@._-]?(?:${MAIL_HOSTS.join("|")})[._-]?com$`);
const SEPARATORS = /[\s._+()-]/g;
const PHONE_MIN_DIGITS = 9;

/** True when the handle is plainly an email address or a phone number. */
export function looksLikeContactHandle(handle: string | null | undefined): boolean {
  const text = (handle ?? "").trim().replace(/^@/, "").toLowerCase();
  if (!text) return false;
  // An at sign with a dotted domain after it is an address whatever the service.
  if (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(text)) return true;
  if (EMAIL_SHAPE.test(text)) return true;
  // Digits only, nine or more: a phone number or a numeric account id.
  const digits = text.replace(SEPARATORS, "");
  return /^\d+$/.test(digits) && digits.length >= PHONE_MIN_DIGITS;
}
