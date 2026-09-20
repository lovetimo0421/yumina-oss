import type { StateGuardSettings } from "@yumina/shared";

export async function requestStateGuardSettings(sessionId: string, patch?: Partial<StateGuardSettings>): Promise<StateGuardSettings> {
  if (!sessionId) throw new Error("No active session");
  const response = await fetch(`${import.meta.env.VITE_API_URL || ""}/api/sessions/${encodeURIComponent(sessionId)}/state-update-guard`, {
    credentials: "include",
    ...(patch ? { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) } : {}),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "State update settings unavailable");
  if (typeof body.data?.enabled !== "boolean" || !(body.data.model === null || typeof body.data.model === "string")) throw new Error("Invalid settings response");
  return body.data;
}
