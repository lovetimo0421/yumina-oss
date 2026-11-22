const EXTENSION_MIME_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  aac: "audio/aac",
  m4a: "audio/mp4",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  txt: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  json: "application/json",
};

const MIME_ALIASES: Record<string, string> = {
  "application/font-woff": "font/woff",
  "application/font-woff2": "font/woff2",
  "application/x-font-woff": "font/woff",
  "application/x-font-woff2": "font/woff2",
  "application/x-font-ttf": "font/ttf",
  "application/x-font-truetype": "font/ttf",
  "application/x-font-otf": "font/otf",
  "application/vnd.ms-opentype": "font/otf",
};

function getExtension(filename: string): string {
  const dotIndex = filename.lastIndexOf(".");
  return dotIndex >= 0 ? filename.slice(dotIndex + 1).toLowerCase() : "";
}

/**
 * True for a content type a browser treats as a document or as script: HTML,
 * any XML dialect (XHTML, SVG, XSLT...), JavaScript. Judged on the media type
 * alone, so `text/html; charset=utf-8` cannot slip past an exact-string list.
 * /cdn serves uploads from the app's own origin; one of these there is a page
 * that acts as whoever opens it.
 */
export function isActiveContentType(contentType: string | null | undefined): boolean {
  const raw = (contentType ?? "").trim().toLowerCase();
  if (!raw) return false;
  // Anything but a bare `type/subtype` is refused outright: parameters, commas
  // and quotes are where a browser and this check can read the value differently.
  if (!/^[a-z0-9][a-z0-9.+-]*[/][a-z0-9][a-z0-9.+-]*$/.test(raw)) return true;
  const type = raw;
  if (type === "text/html" || type === "application/xhtml" || type === "text/xml" || type === "application/xml") return true;
  if (type.endsWith("+xml") || type.endsWith("/xml")) return true;
  if (/(java|ecma|j)script/.test(type)) return true;
  return type === "text/xsl" || type === "text/xslt" || type === "application/x-httpd-php" || type === "text/vtt+html";
}

export function normalizeAssetMimeType(filename: string, mimeType?: string): string {
  const raw = mimeType?.trim().toLowerCase() ?? "";
  const normalized = MIME_ALIASES[raw] ?? raw;
  const extensionMimeType = EXTENSION_MIME_TYPES[getExtension(filename)];

  if (!normalized || normalized === "application/octet-stream" || normalized === "binary/octet-stream") {
    return extensionMimeType ?? "application/octet-stream";
  }

  if (normalized === "application/font-sfnt" || normalized === "font/sfnt") {
    return extensionMimeType ?? "font/ttf";
  }

  return normalized;
}
