import { isDeepStrictEqual } from "node:util";

type RuleTimelineKey =
  | "registrationOpensAt"
  | "registrationClosesAt"
  | "finalDataOpensAt"
  | "finalDataClosesAt"
  | "settlementDeadlineAt";

export interface LockedEventRulePatch extends Partial<Record<RuleTimelineKey, string | null>> {
  submissionType?: string;
  rulesVersion?: number;
  rulesConfig?: unknown;
}

export interface LockedEventRuleState extends Record<RuleTimelineKey, Date | null> {
  submissionType: string;
  rulesVersion: number;
  rulesConfig: unknown;
}

const TIMELINE_KEYS: RuleTimelineKey[] = [
  "registrationOpensAt",
  "registrationClosesAt",
  "finalDataOpensAt",
  "finalDataClosesAt",
  "settlementDeadlineAt",
];

function dateValue(value: string | null): number | null {
  return value === null ? null : new Date(value).getTime();
}

export function hasLockedEventRuleChanges(
  patch: LockedEventRulePatch,
  existing: LockedEventRuleState,
  normalizedRulesConfig: unknown = patch.rulesConfig,
): boolean {
  if (patch.submissionType !== undefined && patch.submissionType !== existing.submissionType) return true;
  if (patch.rulesVersion !== undefined && patch.rulesVersion !== existing.rulesVersion) return true;
  if (patch.rulesConfig !== undefined && !isDeepStrictEqual(normalizedRulesConfig, existing.rulesConfig)) return true;
  return TIMELINE_KEYS.some((key) => {
    const next = patch[key];
    if (next === undefined) return false;
    return dateValue(next) !== existing[key]?.getTime() && !(next === null && existing[key] === null);
  });
}
