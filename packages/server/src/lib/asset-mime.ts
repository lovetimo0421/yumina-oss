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
