import type { ActorContextReceipt } from "@yumina/engine";

/** Public actor input; this never imports a persona profile or private variables. */
export interface ActorContextRequest {
  actor: "voice" | "director";
  model?: string;
  recentMessages?: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface ActorContextResult {
  instructions: string;
  receipt: ActorContextReceipt;
}
