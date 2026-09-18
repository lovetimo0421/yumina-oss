/** Public admin report contracts. No vendor secrets or raw payment/customer objects. */
export const ADMIN_ANALYTICS_VERSION = 1 as const;
export const ADMIN_PERIODS = ["all", "1d", "7d", "30d", "90d"] as const;
export type AdminPeriod = (typeof ADMIN_PERIODS)[number];
export const ADMIN_REPORTS = [
  "overview",
  "finance",
  "tokens",
  "worlds",
  "retention",
] as const;
export type AdminReport = (typeof ADMIN_REPORTS)[number];
export type MetricQuality =
  | "exact"
  | "estimated"
  | "allocated"
  | "partial"
  | "unavailable";
export interface SourceCoverage {
  source: string;
  through: string | null;
  from: string | null;
  quality: MetricQuality;
  note: string | null;
}
export interface AdminSnapshot<T = unknown> {
  definitionVersion?: string;
  schemaVersion: typeof ADMIN_ANALYTICS_VERSION;
  report: AdminReport;
  period: AdminPeriod;
  version: string;
  generatedAt: string;
  expiresAt: string;
  range: {
    from: string | null;
    to: string;
    timezone: "UTC";
    chartFrom: string;
  };
  sources: SourceCoverage[];
  data: T;
}
export interface Metric {
  value: number | null;
  quality: MetricQuality;
  note?: string;
}
/** Who the active people were, by channel. Signed-in accounts (a guest who
 *  later signed in counts once, as the account), guests playing on yumina.io
 *  without an account, and players who never opened yumina.io — the CrazyGames
 *  embed or a direct visit to a game host. `outsideCrazyGames` ⊆ `outside`
 *  (players signed in to CrazyGames; the rest are anonymous devices). */
export interface PlayerChannels {
  accounts: number;
  guests: number;
  outside: number;
  outsideCrazyGames: number;
}
export interface OverviewReport {
  accounts: Metric;
  active: Metric;
  players: Metric;
  gameSeconds: Metric;
  playtimeCapturedFrom?: string | null;
  guestPlayers?: number;
  accountActive?: number;
  /** `active` split by channel; the three parts sum to `active.value`. */
  channels?: PlayerChannels;
  standalone?: StandaloneGame[];
  modelTokens: Metric;
  quick: {
    period: "1d" | "7d" | "30d";
    active: number | null;
    accounts: number | null;
    tokens: number | null;
    gameSeconds: number | null;
    gameSecondsPartial?: boolean;
    /** Channel parts of `active` (accounts = active − guests − outside). */
    guests?: number | null;
    outside?: number | null;
  }[];
  activity: {
    day: string;
    active: number | null;
    accounts: number | null;
    players: number | null;
    tokens: number | null;
    gameSeconds: number | null;
    /** Channel parts of `active` for the bucket (accounts = active − guests − outside). */
    guests?: number | null;
    outside?: number | null;
  }[];
  audiences: { name: string; people: number }[];
  acquisition: {
    source: string;
    accounts: number;
    eligible7d?: number;
    activated7d?: number | null;
  }[];
  demographics?: {
    population: "new-accounts";
    asOfYear: number;
    ages: { band: string; accounts: number }[];
  };
  profile?: {
    population: "active-accounts";
    people: number;
    asOfYear: number;
    groups: { name: string; people: number; ages: { label: string; people: number }[];
      genres: { label: string; people: number }[]; languages: { label: string; people: number }[] }[];
  };
}
export interface FinanceDay {
  day: string;
  grossMicros: string;
  netMicros: string;
  costMicros: string | null;
}
export interface FinanceReport {
  customerEconomics?: {
    cohort: string;
    players: number;
    netMicros: string;
    playCostMicros: string | null;
    p95ShortfallMicros: string | null;
    largestShortfallMicros: string | null;
    losingPlayers: number | null;
    unknownCostPlayers: number;
    costCoverage?: { observed:number; modelDay:number; reference:number; unpriced:number };
    fullUse: {
      days: 30;
      mushies: number;
      planPriceMicros: string;
      playCostMicros: string | null;
      basis: "observed-charged-play-mix";
    } | null;
  }[];
  currency: "USD";
  grossMicros: string | null;
  netMicros: string | null;
  cashFeesMicros: string | null;
  creditCoveredFeesMicros: string | null;
  refundsMicros: string | null;
  disputesMicros: string | null;
  aiCostMicros: string | null;
  contributionMicros: string | null;
  active: number | null;
  costReconciliation: {
    observedMicros: string | null;
    gapMicros: string | null;
    unknownRequests: number | null;
  };
  days: FinanceDay[];
  purchases: {
    product: string;
    payers: number;
    costedPayers?: number;
    costedNetMicros?: string|null;
    grossMicros: string;
    netMicros: string;
    costMicros: string | null;
    quality: MetricQuality;
  }[];
  signupCohorts: {
    cohort: string;
    windowDays: number;
    signups: number;
    revenueMicros: string | null;
    costMicros: string | null;
    mature: boolean;
  }[];
  exclusions: string[];
}
export interface TokenReport {
  input: number | null;
  output: number | null;
  byokTokens: number | null;
  byokUsers: number | null;
  days: { day: string; platform: number; byok: number }[];
  models: {
    model: string;
    input: number;
    output: number;
    users: number;
    byokTokens: number;
    costMicros: string | null;
  }[];
  flow: {
    from: string;
    to: string;
    mushies: number;
    costMicros: string | null;
    quality: MetricQuality;
  }[];
  flowCoverage: string;
}
export interface AtlasWorld {
  id: string;
  familyId: string;
  title: string;
  cover: string | null;
  tags: string[];
  language: string;
  rating: string;
  kind: string;
  players: number;
  seconds: number | null;
  tokens: number;
  retention: number | null;
  retentionEligible: number;
  x: number;
  y: number;
}
export interface WorldReport {
  timeSummary?: {
    seconds: number;
    players: number;
    over10Minutes: number;
    over10MinutesSeconds: number;
    partial: boolean;
    from: string | null;
  };
  standalone?: StandaloneGame[];
  timeBasis?: "lifetime-sessions" | "recorded-intervals";
  worlds: AtlasWorld[];
  edges: { from: string; to: string; shared: number; similarity: number }[];
  players: number;
  multiWorldPlayers: number;
  totalWorlds: number;
  displayedWorlds: number;
  tags: { tag: string; players: number; worlds: number }[];
  mapBasis: "shared_players";
}
export interface RetentionCurve {
  cohort: string;
  size: number;
  points: (number | null)[];
}
export interface StandaloneGame {
  game: string;
  players: number;
  guests: number;
  accounts: number;
  /** Of `guests`: players who never opened yumina.io (CrazyGames embed or the game host). */
  outside?: number;
  /** Of `outside`: signed in to a CrazyGames account. */
  crazyGames?: number;
  seconds: number;
  activityBasis?: "player-action";
  qualificationFrom?: string | null;
  first: string | null;
  through: string | null;
}
export interface RetentionReport {
  activity: {
    daily: RetentionCurve[];
    weekly: RetentionCurve[];
    monthly: RetentionCurve[];
  };
  tokens: {
    daily: RetentionCurve[];
    weekly: RetentionCurve[];
    monthly: RetentionCurve[];
  };
  engaged?: RetentionReport["tokens"];
  headlines?: Partial<
    Record<
      "activity" | "tokens" | "engaged",
      {
        d1: { percent: number | null; people: number };
        d7: { percent: number | null; people: number };
        w1?: { percent: number | null; people: number };
        m1: { percent: number | null; people: number };
      }
    >
  >;
  definition: string;
}
export interface AdminReportData {
  overview: OverviewReport;
  finance: FinanceReport;
  tokens: TokenReport;
  worlds: WorldReport;
  retention: RetentionReport;
}
