/**
 * Open-source edition stub: the hosted 「解除限制」 preset texts are not published.
 * Empty strings make assembleUnrestrict() emit nothing, so the feature is inert
 * until a deployment supplies its own texts.
 */

export type UnrestrictVariant = "gemini" | "claude" | "deepseek" | "general";
export type UnrestrictStrength = "light" | "standard" | "strong";
export type UnrestrictExplicitness = "subtle" | "normal" | "explicit";

export interface UnrestrictVariantTexts {
  core: Record<UnrestrictStrength, string>;
  antiApology: string;
  antiEmpty: string;
  noLecture: string;
  adultWriting: Record<UnrestrictExplicitness, string>;
  strongReminder: string;
}

export const UNRESTRICT_TEXT_VERSION = 0;
export const UNRESTRICT_TEXT_VERIFIED_AT = "";

const EMPTY: UnrestrictVariantTexts = {
  core: { light: "", standard: "", strong: "" },
  antiApology: "",
  antiEmpty: "",
  noLecture: "",
  adultWriting: { subtle: "", normal: "", explicit: "" },
  strongReminder: "",
};

export const UNRESTRICT_TEXTS: Record<UnrestrictVariant, UnrestrictVariantTexts> = {
  gemini: EMPTY,
  claude: EMPTY,
  deepseek: EMPTY,
  general: EMPTY,
};
