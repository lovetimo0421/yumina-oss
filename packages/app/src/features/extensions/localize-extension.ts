import type { TFunction } from "i18next";
import type { ExtensionDetail, ExtensionSummary } from "@yumina/shared";

function catalogPrefix(extensionKey: string) {
  return `catalog.${extensionKey}`;
}

export function localizeExtensionSummary(
  extension: ExtensionSummary,
  t: TFunction<"extensions">,
): ExtensionSummary {
  const base = catalogPrefix(extension.key);
  return {
    ...extension,
    name: t(`${base}.name`, { defaultValue: extension.name }),
    shortDescription: t(`${base}.shortDescription`, { defaultValue: extension.shortDescription }),
    tags: extension.tags.map((tag) =>
      t(`${base}.tags.${tag}`, { defaultValue: tag }),
    ),
  };
}

export function localizeExtensionDetail(
  detail: ExtensionDetail,
  t: TFunction<"extensions">,
): ExtensionDetail {
  const summary = localizeExtensionSummary(detail, t);
  const base = catalogPrefix(detail.key);
  return {
    ...detail,
    ...summary,
    longDescription: t(`${base}.longDescription`, { defaultValue: detail.longDescription }),
    explanations: detail.explanations.map((ex, i) => ({
      title: t(`${base}.explanations.${i}.title`, { defaultValue: ex.title }),
      body: t(`${base}.explanations.${i}.body`, { defaultValue: ex.body }),
    })),
  };
}
