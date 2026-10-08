import i18n from "@/lib/i18n";

const DOCS_HOST = "https://docs.yumina.io";

function url(path: string): string {
  const lang = i18n.language;
  const prefix = lang?.startsWith("zh")
    ? "/zh"
    : lang?.startsWith("es")
      ? "/es"
      : lang?.startsWith("ja")
        ? "/ja"
        : "";
  return `${DOCS_HOST}${prefix}${path}`;
}

export const DOCS_URLS = {
  get home() { return url("/"); },
  get welcome() { return url("/creator/"); },
  get canvas() { return url("/creator/canvas"); },
  get beginnerGuide() { return url("/creator/advanced/tutorial-basic"); },
  // Shipped with the app: testing must not depend on a production docs release.
  get blueprintStart() { return "/app/learn"; },
  get entries() { return url("/creator/entries"); },
  get modules() { return url("/creator/modules"); },
  get variables() { return url("/creator/variables"); },
  get rulesEngine() { return url("/creator/automation"); },
  get components() { return url("/creator/advanced/custom-ui-deep"); },
  get audio() { return url("/creator/advanced/audio-deep"); },
  get sceneImages() { return url("/creator/visuals-audio"); },
  get termsOfUse() { return url("/legal/terms-of-use"); },
  get privacyPolicy() { return url("/legal/privacy-policy"); },
  get communityGuidelines() { return url("/legal/community-guidelines"); },
  openSource: "https://github.com/lovetimo0421/yumina-oss",
};
