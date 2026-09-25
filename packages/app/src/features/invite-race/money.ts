import i18n from "i18next";

/**
 * Every prize amount in the race is US dollars, and "$" alone reads as the
 * local currency in Chinese and Spanish. So: 「1,000 美元」 in Chinese,
 * 「US$1,000」 in Spanish, "$1,000" everywhere else.
 *
 * `decimals` defaults to 0 for whole numbers and 2 otherwise.
 */
export function formatUsd(value: number, decimals?: number, lang: string = i18n.language || "en"): string {
  const d = decimals ?? (Number.isInteger(value) ? 0 : 2);
  const n = Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  const sign = value < 0 ? "−" : "";
  if (lang.startsWith("zh")) return `${sign}${n} 美元`;
  if (lang.startsWith("es")) return `${sign}US$${n}`;
  return `${sign}$${n}`;
}
