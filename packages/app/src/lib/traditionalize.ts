// Runtime Simplified → Traditional conversion for auto-translated user content
// (community posts, reviews, hero editorial). The translation pipeline stores
// one Simplified `_zh` column; a Traditional (zh-Hant) viewer derives Traditional
// from it on the fly — mirroring how the UI strings are derived from zh, just at
// runtime instead of build time. The server only ever sees the normalized `zh`
// hub language, so the "show this in Traditional" intent lives here on the client.
//
// opencc-js is ~1MB (the S→T phrase dictionary that resolves character ambiguity,
// 头发→頭髮 not 頭發, is most of it). It is therefore ONLY ever loaded via dynamic
// import() — never a static import — so it lands in its own lazy chunk that only
// Traditional viewers download, and never bloats the main bundle.
//
// Conversion target `cn → tw`: Taiwan-standard Traditional characters WITHOUT
// vocabulary substitution (软件 stays 軟件, not 軟體) — faithful to what the author
// actually wrote, just rendered in Traditional script.

import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";

let converter: ((text: string) => string) | null = null;
let loadStarted = false;

// Bumped to true once the dictionary chunk has loaded and the converter is live;
// consumers subscribe so they re-render and re-convert when it becomes ready.
const useConverterReady = create<{ ready: boolean }>(() => ({ ready: false }));

/** Whether a UI locale is Traditional Chinese (the only locale we convert for). */
export function isTraditionalLocale(lang: string | null | undefined): boolean {
  const l = (lang ?? "").toLowerCase();
  return (
    l.startsWith("zh-hant") ||
    l.startsWith("zh-tw") ||
    l.startsWith("zh-hk") ||
    l.startsWith("zh-mo")
  );
}

/**
 * Kick off the one-time lazy load of the OpenCC converter. Idempotent and safe
 * to call eagerly (e.g. prefetch on app load for Traditional users) — fails open
 * (leaves text Simplified) if the chunk can't load.
 */
export function ensureTraditionalizer(): void {
  if (loadStarted || converter) return;
  loadStarted = true;
  void import("opencc-js")
    .then((mod) => {
      const factory =
        (mod as { Converter?: unknown }).Converter ??
        (mod as { default?: { Converter?: unknown } }).default?.Converter;
      if (typeof factory === "function") {
        converter = factory({ from: "cn", to: "tw" }) as (text: string) => string;
        useConverterReady.setState({ ready: true });
      }
    })
    .catch(() => {
      // Network/chunk failure — retry allowed on a later call.
      loadStarted = false;
    });
}

/**
 * Hook returning a `tt(text)` function. For Traditional viewers it converts
 * Simplified → Traditional once the dictionary has loaded (and triggers the load);
 * for everyone else, and until the dictionary is ready, it returns the text
 * unchanged (readable Simplified, never a blank or English fallback).
 */
export function useTraditionalize(): (text: string | null | undefined) => string {
  const { i18n } = useTranslation();
  const traditional = isTraditionalLocale(i18n.language);
  const ready = useConverterReady((s) => s.ready);

  useEffect(() => {
    if (traditional) ensureTraditionalizer();
  }, [traditional]);

  return useCallback(
    (text) => {
      if (!text) return text ?? "";
      if (!traditional || !ready || !converter) return text;
      return converter(text);
    },
    [traditional, ready],
  );
}
