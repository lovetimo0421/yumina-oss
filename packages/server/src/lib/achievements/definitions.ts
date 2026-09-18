// ─── Achievement catalog (registry) ─────────────────────────────────────────
// Pure data — no DB imports (so db/index.ts can seed from it without a cycle).
// Titles/descriptions are seeded into the DB; the UI renders them directly.
// Badges are placeholder medal emojis per tier until real art lands.

export type TierLevel = "bronze" | "silver" | "gold" | "diamond";
export type TriggerType = "event" | "batch" | "backfill" | "admin" | "series";

export const MEDAL: Record<TierLevel, string> = {
  bronze: "🥉",
  silver: "🥈",
  gold: "🥇",
  diamond: "💎",
};

export interface TierDef {
  level: TierLevel;
  threshold: number;
  badge: string;
}

export interface AchievementDef {
  key: string;
  groupKey: string;
  title: string; // display title (zh)
  description: string; // requirement text (zh)
  /** Metric this achievement tracks. null for admin/backfill/series-only achievements. */
  metricKey: string | null;
  triggerType: TriggerType;
  tiers: TierDef[];
  isCapstone?: boolean;
  /** True for a per-group diamond capstone (earned when its whole group is maxed). */
  isGroupCapstone?: boolean;
}

export interface GroupDef {
  key: string;
  title: string;
  description: string;
  sortOrder: number;
}

/** Build a tier with the placeholder medal badge for its level. */
function tier(level: TierLevel, threshold: number): TierDef {
  return { level, threshold, badge: MEDAL[level] };
}

const HOUR = 3600;

// Display order of the groups on the achievements page (lowest sortOrder first).
// The UI reads this order from the DB (platform_achievement_groups.sort_order),
// which seedPlatformAchievements() re-syncs from these values on every boot.
export const ACHIEVEMENT_GROUPS: GroupDef[] = [
  { key: "player", title: "逐梦者", description: "游玩与探索更多世界。", sortOrder: 1 },
  { key: "ai-model", title: "驭灵者", description: "驾驭各路 AI 模型。", sortOrder: 2 },
  { key: "community", title: "凝聚者", description: "在论坛中与众人共鸣、邀请伙伴。", sortOrder: 3 },
  { key: "creator", title: "造梦者", description: "发布与经营你的世界。", sortOrder: 4 },
  { key: "commemorative", title: "荣誉殿堂", description: "里程碑与至高荣誉。", sortOrder: 5 },
];

export const ACHIEVEMENTS: AchievementDef[] = [
  // ── 1. 造梦者 (creator) ──────────────────────────────────────────────────────
  { key: "first_publish", groupKey: "creator", title: "初入造梦", description: "发布你的第 1 个公开世界。", metricKey: "published_world_count", triggerType: "event", tiers: [tier("bronze", 1)] },
  { key: "acclaimed", groupKey: "creator", title: "佳作频出", description: "拥有收藏数 ≥ 50 的世界达到 3 / 10 / 25 个。", metricKey: "creator_worlds_fav50", triggerType: "event", tiers: [tier("bronze", 3), tier("silver", 10), tier("gold", 25)] },
  { key: "beloved", groupKey: "creator", title: "人见人爱", description: "你的世界累计被 100 / 500 / 2000 位不同用户收藏。", metricKey: "creator_distinct_fans", triggerType: "event", tiers: [tier("bronze", 100), tier("silver", 500), tier("gold", 2000)] },
  { key: "evergreen", groupKey: "creator", title: "常青世界", description: "某个世界发布满 90 天后，仍在近 30 天内有新活跃。", metricKey: "evergreen_world_count", triggerType: "batch", tiers: [tier("silver", 1)] },
  { key: "breakout", groupKey: "creator", title: "破圈之作", description: "单个世界被 100 / 500 / 1000 位不同用户游玩。", metricKey: "max_world_distinct_players", triggerType: "event", tiers: [tier("bronze", 100), tier("silver", 500), tier("gold", 1000)] },
  { key: "master_craftsman", groupKey: "creator", title: "金牌工匠", description: "至少 3 个世界，平均评分 ≥ 4.5 且评论数 ≥ 20。", metricKey: "creator_quality_worlds", triggerType: "event", tiers: [tier("gold", 3)] },
  { key: "polyglot", groupKey: "creator", title: "多语筑梦", description: "同一个世界拥有 2 / 3 / 4 个语言版本。", metricKey: "max_lang_group_size", triggerType: "event", tiers: [tier("bronze", 2), tier("silver", 3), tier("gold", 4)] },
  { key: "last_touch", groupKey: "creator", title: "我再改最后一次", description: "在某世界发布后 24 小时内，对其发布 2 / 4 / 6 次更新。", metricKey: "max_edits_24h_after_publish", triggerType: "event", tiers: [tier("bronze", 2), tier("silver", 4), tier("gold", 6)] },
  { key: "patch_alchemist", groupKey: "creator", title: "补丁炼金术", description: "对同一个世界累计发布 5 / 10 / 20 次公开更新。", metricKey: "max_world_public_edits", triggerType: "event", tiers: [tier("bronze", 5), tier("silver", 10), tier("gold", 20)] },
  { key: "long_forged", groupKey: "creator", title: "十年磨一剑", description: "创建世界后 7 / 14 / 30 天才首次发布。", metricKey: "max_publish_delay_days", triggerType: "event", tiers: [tier("bronze", 7), tier("silver", 14), tier("gold", 30)] },
  { key: "cap_creator", groupKey: "creator", title: "造梦者", description: "将「造梦者」分组的所有成就升至最高等级。", metricKey: null, triggerType: "series", tiers: [tier("diamond", 1)], isCapstone: true, isGroupCapstone: true },

  // ── 2. 逐梦者 (player) ───────────────────────────────────────────────────────
  { key: "first_steps", groupKey: "player", title: "启程", description: "第一次开始游玩任意世界。", metricKey: "play_session_count", triggerType: "event", tiers: [tier("bronze", 1)] },
  { key: "traveler", groupKey: "player", title: "旅人", description: "游玩过 5 / 25 / 100 个不同世界。", metricKey: "distinct_worlds_played", triggerType: "event", tiers: [tier("bronze", 5), tier("silver", 25), tier("gold", 100)] },
  { key: "deep_diver", groupKey: "player", title: "深潜者", description: "在同一个世界累计游玩 5 / 20 / 100 小时。", metricKey: "max_world_playtime_seconds", triggerType: "event", tiers: [tier("bronze", 5 * HOUR), tier("silver", 20 * HOUR), tier("gold", 100 * HOUR)] },
  { key: "avid_reader", groupKey: "player", title: "最佳读者", description: "在 10 / 50 / 100 位不同创作者的世界留下评论。", metricKey: "distinct_creators_reviewed", triggerType: "event", tiers: [tier("bronze", 10), tier("silver", 50), tier("gold", 100)] },
  { key: "collector", groupKey: "player", title: "收藏家", description: "收藏 20 / 100 / 500 个世界。", metricKey: "favorites_count", triggerType: "event", tiers: [tier("bronze", 20), tier("silver", 100), tier("gold", 500)] },
  { key: "pioneer", groupKey: "player", title: "开荒者", description: "在 5 / 10 / 15 个不同世界发布的 24 小时内游玩它们。", metricKey: "worlds_played_within_24h_of_publish", triggerType: "event", tiers: [tier("bronze", 5), tier("silver", 10), tier("gold", 15)] },
  { key: "old_friend", groupKey: "player", title: "老朋友", description: "和同一个世界累计互动 200 / 500 / 1000 条消息。", metricKey: "max_world_message_count", triggerType: "event", tiers: [tier("bronze", 200), tier("silver", 500), tier("gold", 1000)] },
  { key: "talent_scout", groupKey: "player", title: "伯乐", description: "你早期收藏的世界后来达到 100 收藏，累计 1 / 3 / 10 个。", metricKey: "scouted_world_count", triggerType: "batch", tiers: [tier("bronze", 1), tier("silver", 3), tier("gold", 10)] },
  { key: "cap_player", groupKey: "player", title: "逐梦者", description: "将「逐梦者」分组的所有成就升至最高等级。", metricKey: null, triggerType: "series", tiers: [tier("diamond", 1)], isCapstone: true, isGroupCapstone: true },

  // ── 3. 凝聚者 (community) ─────────────────────────────────────────────────────
  { key: "regular", groupKey: "community", title: "常驻嘉宾", description: "在 7 / 30 / 100 个不同自然日发帖或回复。", metricKey: "distinct_forum_days", triggerType: "event", tiers: [tier("bronze", 7), tier("silver", 30), tier("gold", 100)] },
  { key: "crowd_puller", groupKey: "community", title: "千客万来", description: "自己的主题帖累计收到 20 / 100 / 500 位不同用户回复。", metricKey: "distinct_repliers_on_my_threads", triggerType: "event", tiers: [tier("bronze", 20), tier("silver", 100), tier("gold", 500)] },
  { key: "cheer_captain", groupKey: "community", title: "应援团长", description: "在 10 / 20 / 50 个他人的主题帖里留下 ≥ 200 字回复。", metricKey: "long_reply_threads", triggerType: "event", tiers: [tier("bronze", 10), tier("silver", 20), tier("gold", 50)] },
  { key: "footstool", groupKey: "community", title: "人型脚凳", description: "在 20 / 50 / 100 个他人主题帖里抢到前五楼。", metricKey: "top5_reply_threads", triggerType: "event", tiers: [tier("bronze", 20), tier("silver", 50), tier("gold", 100)] },
  { key: "world_curator", groupKey: "community", title: "世界推荐官", description: "在帖子或回复里附带 10 / 50 个不同世界。", metricKey: "distinct_worlds_attached", triggerType: "event", tiers: [tier("bronze", 10), tier("silver", 50)] },
  { key: "pathfinder", groupKey: "community", title: "引路人", description: "成功邀请 5 / 15 / 20 位真正游玩的好友。", metricKey: "confirmed_referrals", triggerType: "event", tiers: [tier("bronze", 5), tier("silver", 15), tier("gold", 20)] },
  { key: "cap_community", groupKey: "community", title: "凝聚者", description: "将「凝聚者」分组的所有成就升至最高等级。", metricKey: null, triggerType: "series", tiers: [tier("diamond", 1)], isCapstone: true, isGroupCapstone: true },

  // ── 4. 驭灵者 (ai-model) ──────────────────────────────────────────────────────
  { key: "gemini_loyalist", groupKey: "ai-model", title: "双子铁粉", description: "Gemini 系列调用达到 1000 / 5000 / 10000 次。", metricKey: "gemini_call_count", triggerType: "event", tiers: [tier("bronze", 1000), tier("silver", 5000), tier("gold", 10000)] },
  { key: "claude_patron", groupKey: "ai-model", title: "大户人家", description: "Claude 系列调用达到 1000 / 5000 / 10000 次。", metricKey: "claude_call_count", triggerType: "event", tiers: [tier("bronze", 1000), tier("silver", 5000), tier("gold", 10000)] },
  { key: "grok_believer", groupKey: "ai-model", title: "老马信徒", description: "Grok / xAI 系列调用达到 1000 / 5000 / 10000 次。", metricKey: "grok_call_count", triggerType: "event", tiers: [tier("bronze", 1000), tier("silver", 5000), tier("gold", 10000)] },
  { key: "deepseek_loyalist", groupKey: "ai-model", title: "梁爷鲸子", description: "DeepSeek 系列调用达到 1000 / 5000 / 10000 次。", metricKey: "deepseek_call_count", triggerType: "event", tiers: [tier("bronze", 1000), tier("silver", 5000), tier("gold", 10000)] },
  { key: "own_models", groupKey: "ai-model", title: "我命由我", description: "使用自己的模型（自带密钥 BYOK）调用达到 1000 / 5000 / 10000 次。", metricKey: "own_model_call_count", triggerType: "event", tiers: [tier("bronze", 1000), tier("silver", 5000), tier("gold", 10000)] },
  { key: "model_collector", groupKey: "ai-model", title: "模型海王", description: "累计使用过 5 / 10 / 17 个不同模型。", metricKey: "distinct_models_used", triggerType: "event", tiers: [tier("bronze", 5), tier("silver", 10), tier("gold", 17)] },
  { key: "impatient_king", groupKey: "ai-model", title: "急急国王", description: "生成完成后 10 秒内再次发送消息，累计 50 次。", metricKey: "fast_followup_count", triggerType: "event", tiers: [tier("gold", 50)] },
  { key: "one_more_try", groupKey: "ai-model", title: "再来一口", description: "对同一条回复重新生成 3 / 7 / 10 次。", metricKey: "max_regens_on_message", triggerType: "event", tiers: [tier("bronze", 3), tier("silver", 7), tier("gold", 10)] },
  { key: "never_satisfied", groupKey: "ai-model", title: "不满意，再来", description: "累计重新生成 100 / 200 / 600 次。", metricKey: "total_regenerations", triggerType: "event", tiers: [tier("bronze", 100), tier("silver", 200), tier("gold", 600)] },
  { key: "cap_ai", groupKey: "ai-model", title: "驭灵者", description: "将「驭灵者」分组的所有成就升至最高等级。", metricKey: null, triggerType: "series", tiers: [tier("diamond", 1)], isCapstone: true, isGroupCapstone: true },

  // ── 5. 荣誉殿堂 (commemorative) ────────────────────────────────────────────────
  { key: "founding_resident", groupKey: "commemorative", title: "梦坞原住民", description: "成为平台最早的前 3000 名活跃用户（发送过 3 条以上消息）。", metricKey: null, triggerType: "backfill", tiers: [tier("gold", 3000)] },
  { key: "first_dreamers", groupKey: "commemorative", title: "第一批造梦者", description: "成为平台最早发布世界的前 1000 名用户。", metricKey: null, triggerType: "backfill", tiers: [tier("gold", 1000)] },
  { key: "bug_hunter", groupKey: "commemorative", title: "Bug 猎人", description: "你提交的问题被官方确认并修复。", metricKey: null, triggerType: "admin", tiers: [tier("gold", 1)] },
  { key: "night_watch", groupKey: "commemorative", title: "守夜人", description: "连续 7 / 14 / 30 天有有效游玩或社区互动。", metricKey: "current_streak_days", triggerType: "batch", tiers: [tier("bronze", 7), tier("silver", 14), tier("gold", 30)] },
  { key: "cap_commemorative", groupKey: "commemorative", title: "梦坞信徒", description: "将「荣誉殿堂」分组的所有成就升至最高等级。", metricKey: null, triggerType: "series", tiers: [tier("diamond", 1)], isCapstone: true, isGroupCapstone: true },
  { key: "star_collector", groupKey: "commemorative", title: "星图收藏家", description: "将除「梦坞原住民」「第一批造梦者」外的所有成就升至最高等级。", metricKey: null, triggerType: "series", tiers: [tier("diamond", 1)], isCapstone: true },
];

/** Content groups that each have a diamond group-capstone. */
export const CAPSTONE_GROUP_KEYS = ["creator", "player", "community", "ai-model", "commemorative"] as const;

/** Achievements that do NOT count toward the global star_collector: the closed
 *  founding cohorts plus the Hall-of-Honor capstone (Partisan / cap_commemorative).
 *  Group capstones are already excluded as capstones; this is the authoritative set. */
export const STAR_COLLECTOR_EXCLUDE: readonly string[] = ["founding_resident", "first_dreamers", "cap_commemorative"];

export const ACHIEVEMENTS_BY_KEY: Map<string, AchievementDef> = new Map(
  ACHIEVEMENTS.map((a) => [a.key, a]),
);

/** Highest tier level of an achievement (its "completed" tier). */
export function maxTier(def: AchievementDef): TierDef {
  return def.tiers[def.tiers.length - 1]!;
}
