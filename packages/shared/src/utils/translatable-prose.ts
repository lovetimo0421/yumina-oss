/**
 * Does this text contain anything a translator could act on?
 *
 * Community forums are full of posts that are a bare invite code, a URL, "+1",
 * or pure emoji. The model correctly returns those unchanged, echo-detection
 * correctly refuses to cache the echo, and the pair then looks identical to a
 * genuine failure. Deciding it locally keeps them out of both the retry queue
 * and the API bill, and labels them honestly in the health report.
 *
 * Lives in shared because both ends need the same answer: the server uses it to
 * skip the API call, and the client uses it to avoid promising a translation
 * that is never coming. Two copies would drift and put the "translating..."
 * label back on posts the pipeline already closed out.
 */
export function hasTranslatableProse(content: string, title?: string): boolean {
  const stripped = `${title ?? ""}\n${content}`
    .replace(/!?\[[^\]]*]\([^)]+\)/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]+`/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    // Attachment references are ids, not words.
    .replace(/@asset:[0-9a-f-]+/gi, " ")
    // Invite codes: all-caps alphanumeric tokens containing a digit, and the
    // 8-character all-caps ones with at most two vowels (MXPCXDDH, FMSESTXH,
    // KNGJQVNV). The old digit-only rule sent those to the model, which
    // echoed them until 2026-09-06, when the echo-retry prompt talked it into
    // "translating" MXPCXDDH as 哈哈哈哈哈哈哈哈. Eight caps with three
    // vowels (THANKYOU, AWESOMEE) is still treated as a word.
    .replace(/\b(?=[A-Z0-9]*\d)[A-Z0-9]{6,12}\b/g, " ")
    .replace(/\b(?![A-Z]*(?:[AEIOU][A-Z]*){3})[A-Z]{8}\b/g, " ");
  // A run of two letters, not two letters anywhere: a kaomoji row like
  // "\ o / \ o / \ o /" has five letters and nothing to translate.
  return /\p{L}{2}/u.test(stripped);
}

/**
 * How long a missing translation is still worth calling "pending".
 *
 * Translation fires on create/edit and normally lands within seconds. When that
 * first shot fails the sweeper is the only thing left, and it runs every 15
 * minutes against a 30m/1h/2h/4h/8h backoff, so nothing new can arrive between
 * minute 10 and minute 30. Past this window the honest read is "the pipeline
 * gave up on this one", not "still working". A translation that does land later
 * renders normally the moment it arrives, so this only controls the label.
 */
export const TRANSLATION_PENDING_WINDOW_MS = 10 * 60 * 1000;

/**
 * Should the UI still tell the reader a translation is on its way?
 *
 * Absence of a translation row is not evidence of work in progress. Three
 * server-side outcomes never produce one: `no_prose` (nothing to translate,
 * decided before any model call), an answer rejected as an echo, a placeholder
 * or the wrong language (retried on a backoff that starts at 30 minutes), and
 * retries exhausted. Without this check every one of them shows
 * "translating..." forever, which is what a bare invite code reply does today.
 */
export function isTranslationPending(
  content: string,
  title: string | undefined,
  createdAt: string | number | Date | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!hasTranslatableProse(content, title)) return false;
  if (createdAt === null || createdAt === undefined) return true;
  const postedAt = new Date(createdAt).getTime();
  if (Number.isNaN(postedAt)) return true;
  return now - postedAt < TRANSLATION_PENDING_WINDOW_MS;
}
