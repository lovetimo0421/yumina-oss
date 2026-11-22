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

// Each language's heading anchor for the creator docs' LoRA section.
const LORA_ANCHOR: Record<string, string> = { zh: "#插图-lora", es: "#lora-de-ilustración", ja: "#挿絵-lora" };
const LIVE_ANCHOR: Record<string, string> = { zh: "#动态立绘", es: "#personajes-vivos", ja: "#動く立ち絵" };

export const DOCS_URLS = {
  get illustrationLoras() { return url("/creator/visuals-audio") + (LORA_ANCHOR[(i18n.language ?? "en").slice(0, 2)] ?? "#illustration-loras"); },
  get liveCharacters() { return url("/creator/visuals-audio") + (LIVE_ANCHOR[(i18n.language ?? "en").slice(0, 2)] ?? "#live-characters"); },
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
  get interfaceTemplates() { return url("/creator/advanced/publishing-deep#interface-templates"); },
  get shareableInterface() { return url("/creator/advanced/publishing-deep#shareable-interface"); },
  get components() { return url("/creator/advanced/custom-ui-deep"); },
  get audio() { return url("/creator/advanced/audio-deep"); },
  get sceneImages() { return url("/creator/visuals-audio"); },
  // Player-facing answers, linked from where the question comes up in the app.
  get models() { return url("/help/which-ai-models-can-i-use"); },
  get storyMemory() { return url("/guide/choosing-an-ai-model#story-memory"); },
  get howToPlay() { return url("/guide/playing-a-world"); },
  get termsOfUse() { return url("/legal/terms-of-use"); },
  get privacyPolicy() { return url("/legal/privacy-policy"); },
  get communityGuidelines() { return url("/legal/community-guidelines"); },
  openSource: "https://github.com/lovetimo0421/yumina-oss",
  get publishingMedia() { return url("/legal/community-guidelines#publishing-media"); },
};
