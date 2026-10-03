import type { GenerationErrorCode } from "@yumina/shared";

interface ProviderProgress {
  nodeClass?: string;
  step?: number;
  steps?: number;
  nodesDone?: number;
  nodesTotal?: number;
}

export interface WorkflowSubmission {
  workflow: Record<string, unknown>;
  /** Reference images, uploaded to the worker before the graph runs. */
  images?: { name: string; imageBase64: string }[];
}

export type ProviderJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface ProviderOutputFile {
  filename: string;
  /** Exactly one of buffer / base64 / url is set, depending on the source.
   *  `buffer` is the cheap path: the OpenRouter reader decodes as the response
   *  streams, so re-encoding it to base64 here purely to satisfy this type would
   *  put back the copy that rewrite existed to remove. */
  buffer?: Buffer;
  base64?: string;
  url?: string;
}

export interface ProviderStatusResult {
  status: ProviderJobStatus;
  outputs: ProviderOutputFile[];
  error?: string;
  /** Stable classification of `error` for client-side localization. */
  errorCode?: GenerationErrorCode;
  /** Live execution progress while running; null/absent when the provider has none. */
  progress?: ProviderProgress | null;
}

/** Live capacity signal, aggregated across endpoints. Null = unknown. */
export interface CapacitySnapshot {
  /** Total live workers across endpoints (0 = drought). */
  workers: number;
  /** Jobs waiting in provider queues. */
  queueDepth: number;
  /** No workers anywhere while jobs wait — expect delays. */
  degraded: boolean;
}

export interface GenerationProvider {
  readonly name: "runpod" | "local" | "comfy-cloud";
  /**
   * Returns the provider-side job id. `allowedRegions`, when set, restricts
   * submission to endpoints in those regions (the job needs models that only
   * live on those regions' volumes).
   */
  submit(
    submission: WorkflowSubmission,
    webhookUrl: string | null,
    allowedRegions?: string[],
  ): Promise<string>;
  getStatus(providerJobId: string): Promise<ProviderStatusResult>;
  cancel(providerJobId: string): Promise<void>;
  /** Live queue/worker signal for user-facing transparency. Null = unknown. */
  getCapacity?(): Promise<CapacitySnapshot | null>;
}

// No hosted provider is available in the open-source edition. These
// getters also keep per-turn illustration's availability gate closed.
export const getGenerationProvider = (): GenerationProvider | null => null;
export const getTurnImagePoolProvider = (): GenerationProvider | null => null;
export const getFallbackGenerationProvider = (): GenerationProvider | null => null;
