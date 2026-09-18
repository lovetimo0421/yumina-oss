export const COMMUNITY_LINKS = {
  discord: "https://discord.gg/gPhncrugz3",
  reddit: "https://www.reddit.com/r/yuminaAI/",
  github: "https://github.com/lovetimo0421/yumina-oss",
} as const;

export type CommunityChannel = keyof typeof COMMUNITY_LINKS;
