import { DEFAULT_MODEL, PLAY_MODELS, PLAN_HIERARCHY } from "@yumina/shared";
import { composeSelectedModelId } from "./model-id";

type PlanId = (typeof PLAN_HIERARCHY)[number];

export interface ApiKeyModelProfile {
  id: string;
  provider: string;
  metadata: {
    defaultModel?: string;
    models?: string[];
  } | null;
  createdAt?: string;
}

function planRank(plan: string): number {
  const idx = PLAN_HIERARCHY.indexOf(plan as PlanId);
  return idx >= 0 ? idx : 0;
}

function canAccess(minPlan: string, userPlan: string): boolean {
  return planRank(userPlan) >= planRank(minPlan);
}

export function isAccessibleOfficialModel(modelId: string, userPlan: string): boolean {
  const model = PLAY_MODELS.find((m) => m.id === modelId);
  return !!model && canAccess(model.minPlan, userPlan);
}

export function resolveOfficialSelectedModel(currentModel: string, userPlan: string): string {
  if (isAccessibleOfficialModel(currentModel, userPlan)) return currentModel;

  const defaultModel = PLAY_MODELS.find(
    (model) => model.id === DEFAULT_MODEL && canAccess(model.minPlan, userPlan),
  );
  if (defaultModel) return defaultModel.id;

  return PLAY_MODELS.find((model) => canAccess(model.minPlan, userPlan))?.id ?? DEFAULT_MODEL;
}

export function resolvePrivateSelectedModel(
  profiles: ApiKeyModelProfile[],
  activeKeyId: string | null | undefined,
): string {
  const ordered = [...profiles].sort(
    (a, b) => Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? ""),
  );
  const target =
    (activeKeyId ? ordered.find((profile) => profile.id === activeKeyId) : null)
    ?? ordered[0]
    ?? null;
  if (!target) return "";

  const raw =
    target.metadata?.defaultModel?.trim()
    || target.metadata?.models?.find((model) => model.trim().length > 0)
    || "";

  return raw ? composeSelectedModelId(target.provider, raw) : "";
}

export async function fetchApiKeyModelProfiles(apiBase = ""): Promise<ApiKeyModelProfile[]> {
  const res = await fetch(`${apiBase}/api/keys`, { credentials: "include" });
  if (!res.ok) return [];
  const { data } = await res.json();
  return Array.isArray(data) ? data : [];
}
