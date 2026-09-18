import { useCreditStore } from "@/edition/slots.state";
import { useUserProfileStore } from "@/stores/user-profile";

const apiBase = import.meta.env?.VITE_API_URL || "";

export async function savePreferredProvider(provider: "official" | "private"): Promise<void> {
  const response = await fetch(`${apiBase}/api/users/me`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ preferences: { preferredProvider: provider } }),
  });
  if (!response.ok) throw new Error("Failed to switch provider");
  const { data } = await response.json();
  if (!data || data.preferences?.preferredProvider !== provider) {
    throw new Error("Failed to switch provider");
  }
  // The write response is authoritative. Optional account reads may fail or
  // arrive late; neither should undo a switch the server has already saved.
  useUserProfileStore.getState().acceptProfile(data);
  useCreditStore.getState().acceptProvider(provider);
}
