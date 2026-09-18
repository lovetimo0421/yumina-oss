import "i18next";

import type common from "../locales/en/common.json";
import type auth from "../locales/en/auth.json";
import type settings from "../locales/en/settings.json";
import type editor from "../locales/en/editor.json";
import type chat from "../locales/en/chat.json";
import type library from "../locales/en/library.json";
import type profile from "../locales/en/profile.json";
import type toasts from "../locales/en/toasts.json";
import type templatesContent from "../locales/en/templates-content.json";
import type extensions from "../locales/en/extensions.json";

declare global {
  /**
   * Namespace -> resource map for typed `t()`. Core namespaces live here;
   * hosted-only namespaces (hub, admin, community, plans, creator,
   * achievements) are merged in by `i18next.hosted.d.ts`, which the
   * open-source export leaves out together with those locale files.
   */
  interface YuminaI18nResources {
    common: typeof common;
    auth: typeof auth;
    settings: typeof settings;
    editor: typeof editor;
    chat: typeof chat;
    library: typeof library;
    profile: typeof profile;
    toasts: typeof toasts;
    "templates-content": typeof templatesContent;
    extensions: typeof extensions;
  }
}

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    resources: YuminaI18nResources;
  }
}
