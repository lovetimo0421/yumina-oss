import { useEffect, useMemo, useState } from "react";
import { resolveAssetUrl } from "@/lib/asset-url";

export type AssetFontFormat = "opentype" | "truetype" | "woff" | "woff2";

export interface AssetFontOptions {
  family?: string;
  fallback?: string;
  filename?: string | null;
  mimeType?: string | null;
  format?: AssetFontFormat | null;
  weight?: string | number;
  style?: string;
  stretch?: string;
  display?: FontDisplay;
}

const fontLoadCache = new Map<string, Promise<void>>();

function extractAssetId(assetRef: string): string {
  return assetRef.startsWith("@asset:") ? assetRef.slice(7) : assetRef;
}

function escapeFontFamily(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function quoteFontFamily(value: string): string {
  return `"${escapeFontFamily(value)}"`;
}

function normalizeFamilyName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "Yumina Uploaded Font";
  return trimmed;
}

function buildScopedFamilyName(assetRef: string, familyName: string): string {
  const assetId = extractAssetId(assetRef);
  if (!assetId) return familyName;
  return `${familyName}__yumina_${assetId.slice(0, 8)}`;
}

function filenameBase(filename?: string | null): string {
  if (!filename) return "";
  return filename.replace(/\.[^.]+$/u, "").trim();
}

function toIdentifier(value: string): string {
  const sanitized = value
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((part, index) =>
      index === 0
        ? part.toLowerCase()
        : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()
    )
    .join("");

  if (!sanitized) return "assetFont";
  return /^[a-zA-Z_$]/.test(sanitized) ? sanitized : `font${sanitized}`;
}

function fontFormatFromExtension(filename?: string | null): AssetFontFormat | null {
  const ext = filename?.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "otf":
      return "opentype";
    case "ttf":
      return "truetype";
    case "woff":
      return "woff";
    case "woff2":
      return "woff2";
    default:
      return null;
  }
}

function fontFormatFromMimeType(mimeType?: string | null): AssetFontFormat | null {
  switch (mimeType?.toLowerCase()) {
    case "font/otf":
    case "application/font-sfnt":
    case "application/vnd.ms-opentype":
    case "font/sfnt":
    case "application/x-font-opentype":
    case "application/x-font-otf":
      return "opentype";
    case "font/ttf":
    case "application/x-font-ttf":
      return "truetype";
    case "font/woff":
    case "application/font-woff":
    case "application/x-font-woff":
      return "woff";
    case "font/woff2":
    case "application/font-woff2":
    case "application/x-font-woff2":
      return "woff2";
    default:
      return null;
  }
}

function buildFontSource(url: string, format: AssetFontFormat | null): string {
  return format ? `url("${url}") format("${format}")` : `url("${url}")`;
}

function buildDescriptors(options: AssetFontOptions): FontFaceDescriptors {
  const descriptors: FontFaceDescriptors = {};
  if (options.weight !== undefined) descriptors.weight = String(options.weight);
  if (options.style) descriptors.style = options.style;
  if (options.stretch) descriptors.stretch = options.stretch;
  if (options.display) descriptors.display = options.display;
  return descriptors;
}

function buildCacheKey(
  assetRef: string,
  family: string,
  source: string,
  descriptors: FontFaceDescriptors
): string {
  return JSON.stringify({
    assetRef,
    family,
    source,
    descriptors,
  });
}

export function suggestAssetFontFamilyName(
  filename?: string | null,
  assetRef?: string
): string {
  const fromFilename = filenameBase(filename);
  if (fromFilename) return normalizeFamilyName(fromFilename);

  const assetId = assetRef ? extractAssetId(assetRef) : "";
  if (assetId) return `Yumina Font ${assetId.slice(0, 8)}`;

  return "Yumina Uploaded Font";
}

export function inferAssetFontFormat(
  filename?: string | null,
  mimeType?: string | null
): AssetFontFormat | null {
  return fontFormatFromMimeType(mimeType) ?? fontFormatFromExtension(filename);
}

export function buildAssetFontFamily(
  assetRef: string,
  options: Pick<AssetFontOptions, "family" | "fallback" | "filename"> = {}
): string {
  const familyName = normalizeFamilyName(
    options.family ?? suggestAssetFontFamilyName(options.filename, assetRef)
  );

  if (!options.fallback) return quoteFontFamily(familyName);
  return `${quoteFontFamily(familyName)}, ${options.fallback}`;
}

export function buildAssetFontFaceCss(
  assetRef: string,
  options: AssetFontOptions = {}
): string {
  const familyName = normalizeFamilyName(
    options.family ?? suggestAssetFontFamilyName(options.filename, assetRef)
  );
  const format =
    options.format ?? inferAssetFontFormat(options.filename ?? assetRef, options.mimeType);

  const lines = [
    "@font-face {",
    `  font-family: ${quoteFontFamily(familyName)};`,
    `  src: ${buildFontSource(assetRef, format)};`,
    `  font-display: ${options.display ?? "swap"};`,
  ];

  if (options.weight !== undefined) {
    lines.push(`  font-weight: ${options.weight};`);
  }

  if (options.style) {
    lines.push(`  font-style: ${options.style};`);
  }

  if (options.stretch) {
    lines.push(`  font-stretch: ${options.stretch};`);
  }

  lines.push("}");
  return lines.join("\n");
}

export function buildUseAssetFontSnippet(
  assetRef: string,
  options: Pick<AssetFontOptions, "family" | "fallback" | "filename"> = {}
): string {
  const familyName = normalizeFamilyName(
    options.family ?? suggestAssetFontFamilyName(options.filename, assetRef)
  );
  const variableName = toIdentifier(familyName);
  const fallback = options.fallback ?? "serif";

  return [
    `var ${variableName} = useAssetFont("${assetRef}", {`,
    `  family: "${escapeFontFamily(familyName)}",`,
    `  fallback: "${fallback}",`,
    "});",
    "",
    `<div style={{ fontFamily: ${variableName} }}>Sample Text</div>`,
  ].join("\n");
}

export function useAssetFont(
  assetRef: string | null | undefined,
  options: AssetFontOptions = {}
): string {
  const requestedFamilyName = useMemo(
    () =>
      normalizeFamilyName(
        options.family ?? suggestAssetFontFamilyName(options.filename, assetRef ?? undefined)
      ),
    [assetRef, options.family, options.filename]
  );

  const loadedFamilyName = useMemo(
    () =>
      assetRef
        ? buildScopedFamilyName(assetRef, requestedFamilyName)
        : requestedFamilyName,
    [assetRef, requestedFamilyName]
  );

  const [isLoaded, setIsLoaded] = useState(() => {
    if (!assetRef) return true;
    if (typeof document === "undefined" || !document.fonts) return false;
    return document.fonts.check(`16px ${quoteFontFamily(loadedFamilyName)}`);
  });

  useEffect(() => {
    if (!assetRef) {
      setIsLoaded(true);
      return;
    }

    if (typeof document === "undefined" || !document.fonts) {
      setIsLoaded(false);
      return;
    }

    setIsLoaded(document.fonts.check(`16px ${quoteFontFamily(loadedFamilyName)}`));
  }, [assetRef, loadedFamilyName]);

  useEffect(() => {
    if (!assetRef) return;
    if (typeof window === "undefined") return;
    if (typeof FontFace === "undefined") return;
    if (typeof document === "undefined" || !document.fonts) return;

    const format =
      options.format ?? inferAssetFontFormat(options.filename ?? assetRef, options.mimeType);
    const descriptors = buildDescriptors(options);

    let cancelled = false;

    const loadFont = async () => {
      const url = await resolveAssetUrl(assetRef);
      if (cancelled) return;

      const source = buildFontSource(url, format);
      const cacheKey = buildCacheKey(assetRef, loadedFamilyName, source, descriptors);

      let loadPromise = fontLoadCache.get(cacheKey);
      if (!loadPromise) {
        loadPromise = (async () => {
          const face = new FontFace(loadedFamilyName, source, descriptors);
          const loadedFace = await face.load();
          document.fonts.add(loadedFace);
        })().catch((error) => {
          fontLoadCache.delete(cacheKey);
          throw error;
        });

        fontLoadCache.set(cacheKey, loadPromise);
      }

      await loadPromise;
      if (!cancelled) {
        setIsLoaded(true);
      }
    };

    void loadFont();

    return () => {
      cancelled = true;
    };
  }, [
    assetRef,
    loadedFamilyName,
    options.display,
    options.filename,
    options.format,
    options.mimeType,
    options.stretch,
    options.style,
    options.weight,
  ]);

  if (!assetRef) {
    return buildAssetFontFamily(requestedFamilyName, {
      family: requestedFamilyName,
      fallback: options.fallback,
    });
  }

  if (!isLoaded) {
    return options.fallback ?? "serif";
  }

  if (!options.fallback) {
    return quoteFontFamily(loadedFamilyName);
  }

  return `${quoteFontFamily(loadedFamilyName)}, ${options.fallback}`;
}
