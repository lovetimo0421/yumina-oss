export const COMMUNITY_LINKS = {
  discord: "https://discord.gg/gPhncrugz3",
  reddit: "https://www.reddit.com/r/yuminaAI/",
} as const;

export type CommunityChannel = keyof typeof COMMUNITY_LINKS;
