import type { ApiKeyMetadata } from "@yumina/shared";
import type { CustomProvider } from "./custom.js";

/** Discovery and generation are independent capabilities on compatible APIs. */
export function customEndpointFailure(stage: "models" | "chat", status?: number, detail?: string) {
  if (status === 401) return { code: "authentication_failed", reason: "Authentication failed. Check the API key." };
  if (status === 403) return { code: "access_denied", reason: "The provider denied access. Check your account and model permissions." };
  if (status === 429) return { code: "rate_limited", reason: "Rate limited by the provider. Try again later." };
  const http = status ? ` (HTTP ${status})` : "";
  if (stage === "models") {
    return {
      code: "model_list_unavailable",
      reason: `Could not fetch the model list${http}. Enter a model ID and send a test message.`,
    };
  }
  return {
    code: "model_test_failed",
    reason: status === 404
      ? "The endpoint or model was not found (HTTP 404). Check the base URL and model ID."
      : detail || `The model test failed${http}.`,
  };
}

export async function verifyCustomConnection(
  provider: Pick<CustomProvider, "listModelsDetailed" | "sendTestMessage">,
  metadata?: ApiKeyMetadata | null,
): Promise<{
  valid: boolean;
  modelVerified: boolean;
  status?: number;
  detectedModels?: string[];
  code?: string;
  reason?: string;
}> {
  // Honor a manually entered default even when discovery has never succeeded.
  // A model list is not evidence that this particular model can generate.
  const model = metadata?.defaultModel?.trim() || metadata?.models?.find(id => id.trim())?.trim();
  if (model) {
    const probe = await provider.sendTestMessage(model);
    if (probe.ok) return { valid: true, modelVerified: true, status: probe.status };
    return { valid: false, modelVerified: false, status: probe.status, ...customEndpointFailure("chat", probe.status, probe.reason) };
  }
  const discovery = await provider.listModelsDetailed();
  if (discovery.ok && discovery.models.length > 0) {
    return { valid: true, modelVerified: false, detectedModels: discovery.models };
  }
  return {
    valid: false,
    modelVerified: false,
    status: discovery.status,
    ...customEndpointFailure("models", discovery.status, discovery.reason),
  };
}
