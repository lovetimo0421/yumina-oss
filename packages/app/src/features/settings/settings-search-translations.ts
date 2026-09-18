import type { TFunction } from "i18next";
import enSettings from "../../locales/en/settings.json";
import esSettings from "../../locales/es/settings.json";
import jaSettings from "../../locales/ja/settings.json";
import zhSettings from "../../locales/zh/settings.json";
import zhHantSettings from "../../locales/zh-Hant/settings.json";
import {
  SUPPORTED_LANGUAGES,
  type SupportedLanguage,
} from "../../lib/language-clamp";

type TranslationResource = Record<string, unknown>;
type TranslationOptions = Record<string, unknown> & { defaultValue?: unknown };

function readTranslation(resource: TranslationResource, key: string): string | undefined {
  let value: unknown = resource;

  for (const segment of key.split(".")) {
    if (!value || typeof value !== "object") return undefined;
    value = (value as TranslationResource)[segment];
  }

  return typeof value === "string" ? value : undefined;
}

function interpolateTranslation(template: string, options: TranslationOptions): string {
  return template.replace(/{{\s*([\w-]+)\s*}}/g, (match, key: string) => {
    const value = options[key];
    return typeof value === "string" || typeof value === "number"
      ? String(value)
      : match;
  });
}

function createStaticSettingsTranslator(resource: TranslationResource): TFunction<"settings"> {
  const translate = (
    key: string | readonly string[],
    options: TranslationOptions = {}
  ): string => {
    const keys = typeof key === "string" ? [key] : key;
    const translated = keys
      .map((candidate) => readTranslation(resource, candidate))
      .find((value): value is string => value !== undefined);
    const fallback = typeof options.defaultValue === "string"
      ? options.defaultValue
      : keys[0] ?? "";

    return interpolateTranslation(translated ?? fallback, options);
  };

  return translate as unknown as TFunction<"settings">;
}

const SETTINGS_TRANSLATION_RESOURCES = {
  en: enSettings,
  zh: zhSettings,
  "zh-Hant": zhHantSettings,
  es: esSettings,
  ja: jaSettings,
} satisfies Record<SupportedLanguage, TranslationResource>;

export const SETTINGS_SEARCH_TRANSLATORS = SUPPORTED_LANGUAGES.map(
  (language) => createStaticSettingsTranslator(SETTINGS_TRANSLATION_RESOURCES[language])
);
