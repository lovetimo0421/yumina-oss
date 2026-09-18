import { createWorldSchema, updateWorldSchema, MAX_REQUEST_BODY_BYTES } from "@yumina/shared";

export interface WorldSaveErrorOptions {
  /** The submitted snapshot, not a draft that may have changed during the request. */
  payload?: Record<string, unknown>;
  t?: (key: string, options: Record<string, unknown>) => string;
}

const messages = {
  field_name: "World title",
  field_description: "Description",
  field_schema: "World content",
  field_language: "Language",
  field_languageGroupId: "Language group",
  field_variantLabel: "Version label",
  field_tags: "Tags",
  field_thumbnailUrl: "Cover image URL",
  field_galleryImages: "Gallery images",
  field_announcement: "Announcement",
  field_approxTime: "Estimated play time",
  tooLong: "{{field}} can have at most {{limit}} characters; currently {{actual}}. Shorten it and save again.",
  tooLongUnknown: "{{field}} can have at most {{limit}} characters. Shorten it and save again.",
  tooShort: "{{field}} needs at least {{limit}} characters. Fill it in and save again.",
  tooMany: "{{field}} can have at most {{limit}} items. Remove some and save again.",
  invalidType: "{{field}} has an invalid format (expected {{expected}}, received {{received}}). Check this field in the imported file.",
  fieldError: "{{field}}: {{reason}}",
  tooLarge: "This world is too large to save (limit: {{limit}} MB). Move large embedded assets to the Asset Library. Your edits are still here.",
  tooLargeMeasured: "This world needs {{actual}} MB to save; the limit is {{limit}} MB. Move large embedded assets to the Asset Library. Your edits are still here.",
  sessionExpired: "Your session expired. Sign in again to save. Your edits are still here.",
  forbidden: "You do not have permission to save this world. Check that you are signed in to the owner's account.",
  accountRestricted: "Your account is restricted. You cannot create new worlds.",
  notFound: "This world no longer exists, or you no longer have access to it. Your edits are still here.",
  rateLimited: "Too many save requests. Wait a moment and save again. Your edits are still here.",
  rateLimitedSeconds: "Too many save requests. Wait {{seconds}} seconds and save again. Your edits are still here.",
  serverUnavailable: "The server is temporarily unavailable (HTTP {{status}}). Try saving again shortly. Your edits are still here.",
  network: "Could not reach the server. Check your connection and save again. Your edits are still here.",
  unexpected: "An unexpected error stopped the save. Your edits are still here; please try again.",
  failed: "Failed to save (HTTP {{status}}). Your edits are still here; please try again.",
};

function message(key: keyof typeof messages, options: WorldSaveErrorOptions, values: Record<string, string | number> = {}): string {
  const fallback = messages[key];
  return options.t?.(`editor:saveErrors.${key}`, { defaultValue: fallback, ...values })
    ?? fallback.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values[name] ?? ""));
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export class WorldSavePayloadTooLargeError extends Error {
  constructor(readonly bytes: number, readonly limit: number) {
    super(
      `This world needs ${(bytes / 1024 / 1024).toFixed(1)} MB to save; the limit is ${(limit / 1024 / 1024).toFixed(1)} MB. Move large embedded assets to the Asset Library. Your edits are still here.`,
    );
    this.name = "WorldSavePayloadTooLargeError";
  }
}

/** The compiled root is a disposable load-time cache, not authored content.
 * Large imported games can fit the request limit until save adds this second
 * copy of their code and model data. Drop only that cache when necessary; the
 * player already recompiles from files when it is absent. Never mutate a draft.
 */
export function serializeWorldSavePayload(
  payload: Record<string, unknown>,
  limit = MAX_REQUEST_BODY_BYTES,
): string {
  const encoder = new TextEncoder();
  let body = JSON.stringify(payload);
  let bytes = encoder.encode(body).byteLength;
  if (bytes <= limit) return body;

  const schema = record(payload.schema);
  const root = record(schema?.rootComponent);
  if (schema && root && "compiled" in root) {
    const { compiled: _compiled, ...sourceRoot } = root;
    body = JSON.stringify({
      ...payload,
      schema: { ...schema, rootComponent: sourceRoot },
    });
    bytes = encoder.encode(body).byteLength;
  }
  if (bytes > limit) throw new WorldSavePayloadTooLargeError(bytes, limit);
  return body;
}

/** Preserve useful API rejections instead of collapsing every status into the
 * same "Failed to save" toast. Never replace or clear the unsaved draft. */
export function worldSaveErrorMessage(status: number, body: unknown, options: WorldSaveErrorOptions = {}): string {
  if (status === 413) {
    return message("tooLarge", options, { limit: (MAX_REQUEST_BODY_BYTES / 1024 / 1024).toFixed(1) });
  }
  if (status === 401) return message("sessionExpired", options);
  // A proxy can return HTML, and internal 5xx messages aren't actionable to a creator.
  if (status >= 500) return message("serverUnavailable", options, { status });
  const data = record(body);
  const details = record(data?.details);
  const fields = record(details?.fieldErrors);
  const reasons: string[] = [];
  for (const [field, errors] of Object.entries(fields ?? {})) {
    if (!Array.isArray(errors)) continue;
    for (const error of errors) {
      if (typeof error === "string" && error.trim()) reasons.push(fieldError(field, error, options));
    }
  }
  if (Array.isArray(details?.formErrors)) {
    reasons.push(...details.formErrors.filter((v): v is string => typeof v === "string" && Boolean(v.trim())));
  }
  if (reasons.length) return reasons.join("\n");
  const reason = [data?.message, data?.error].find((v): v is string => typeof v === "string" && Boolean(v.trim()));
  if (status === 403 && reason === "Your account is restricted. You cannot create new worlds.") {
    return message("accountRestricted", options);
  }
  if (status === 403 && /^(?:Not authorized|Forbidden)$/.test(reason ?? "")) return message("forbidden", options);
  if (status === 404 && /^World not found(?: or not authorized)?$/.test(reason ?? "")) return message("notFound", options);
  if (status === 429 && data?.code === "RATE_LIMITED") {
    const seconds = Number(data.retryAfter ?? /^Too many requests\. Please wait (\d+) seconds?\.$/.exec(reason ?? "")?.[1]);
    return Number.isFinite(seconds) && seconds > 0
      ? message("rateLimitedSeconds", options, { seconds: Math.ceil(seconds) })
      : message("rateLimited", options);
  }
  if (reason) return reason;
  if (status === 403) return message("forbidden", options);
  if (status === 404) return message("notFound", options);
  if (status === 429) return message("rateLimited", options);
  return message("failed", options, { status });
}

function fieldError(field: string, reason: string, options: WorldSaveErrorOptions): string {
  const labelKey = `field_${field}` as keyof typeof messages;
  const label = Object.prototype.hasOwnProperty.call(messages, labelKey) ? message(labelKey, options) : field;
  const max = /^String must contain at most (\d+) character\(s\)$/.exec(reason);
  if (max) {
    const value = options.payload?.[field];
    return typeof value === "string"
      ? message("tooLong", options, { field: label, limit: max[1]!, actual: value.length })
      : message("tooLongUnknown", options, { field: label, limit: max[1]! });
  }
  const min = /^String must contain at least (\d+) character\(s\)$/.exec(reason);
  if (min) return message("tooShort", options, { field: label, limit: min[1]! });
  const items = /^Array must contain at most (\d+) element\(s\)$/.exec(reason);
  if (items) return message("tooMany", options, { field: label, limit: items[1]! });
  const type = /^Expected (\w+), received (\w+)$/.exec(reason);
  if (type) return message("invalidType", options, { field: label, expected: type[1]!, received: type[2]! });
  // Preserve unfamiliar server validation messages instead of hiding their reason.
  return message("fieldError", options, { field: label, reason });
}

/** Use the same schemas as the API; don't trim imported content or change server limits. */
export function worldSaveValidationMessage(payload: Record<string, unknown>, existing: boolean, options: WorldSaveErrorOptions = {}): string | null {
  const result = (existing ? updateWorldSchema : createWorldSchema).safeParse(payload);
  return result.success ? null : worldSaveErrorMessage(400,
    { error: "Validation failed", details: result.error.flatten() }, { ...options, payload });
}

export function worldSaveExceptionMessage(error: unknown, options: WorldSaveErrorOptions = {}): string {
  if (error instanceof WorldSavePayloadTooLargeError) {
    return message("tooLargeMeasured", options, {
      actual: (error.bytes / 1024 / 1024).toFixed(1), limit: (error.limit / 1024 / 1024).toFixed(1),
    });
  }
  if (error instanceof Error && /failed to fetch|fetch failed|load failed|networkerror|network request failed/i.test(error.message)) {
    return message("network", options);
  }
  return message("unexpected", options);
}
