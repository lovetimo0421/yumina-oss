import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ImageBatchSnapshot } from "@yumina/shared";
import { useSession } from "@/lib/auth-client";
import { useCreditStore } from "@/edition/slots.state";
import { GenerationRequestScope } from "@/lib/generation-request-scope";
import type { StudioImageBatchEdits, StudioImageBatchProposal } from "./types";
import { imageBatchRetryIds, matchingImageBatch, proposalWithImageBatch, sameImageBatchCardScope } from "./image-batch-state";

const apiBase = import.meta.env?.VITE_API_URL || "";

/** Image tasks have their own lifetime: polling never holds the assistant stream
 * open, and retry/resume never calls the assistant model. */
export function useImageBatch({ proposal, worldId, conversationId, onUpdate }: {
  proposal: StudioImageBatchProposal;
  worldId: string;
  conversationId: string | null;
  onUpdate: (proposal: StudioImageBatchProposal) => void;
}) {
  const { data: session } = useSession();
  const owner = session?.user.id ?? null;
  const identity = useMemo(() => ({ owner, worldId, conversationId, runId: proposal.runId, toolCallId: proposal.toolCallId }),
    [owner, worldId, conversationId, proposal.runId, proposal.toolCallId]);
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const scope = useMemo(() => new GenerationRequestScope(() => sameImageBatchCardScope(identity, identityRef.current)), [identity]);
  const latest = useRef({ proposal, onUpdate });
  latest.current = { proposal, onUpdate };
  const [state, setState] = useState({ identity, busy: false, restoring: true, error: "" });
  const [estimates, setEstimates] = useState<{ identity: typeof identity; values: Record<string, number> }>({ identity, values: {} });
  const [refreshVersion, setRefreshVersion] = useState(0);
  const operations = useMemo(() => ({ busy: false, version: 0 }), [identity]);
  const base = `${apiBase}/api/studio/${encodeURIComponent(worldId)}/agent`;
  const currentState = state.identity === identity ? state : { busy: false, restoring: true, error: "" };
  const updateState = useCallback((patch: Partial<Omit<typeof state, "identity">>) => {
    if (scope.current) setState(previous => ({ ...(previous.identity === identity ? previous : { busy: false, restoring: true, error: "" }), ...patch, identity }));
  }, [identity, scope]);
  const accept = useCallback((batch: ImageBatchSnapshot) => {
    if (!scope.current || !matchingImageBatch(latest.current.proposal, worldId, [batch])) return;
    const previous = latest.current.proposal.batch;
    if (previous && Date.parse(previous.updatedAt) > Date.parse(batch.updatedAt)) return;
    const next = proposalWithImageBatch(latest.current.proposal, batch);
    latest.current.proposal = next;
    latest.current.onUpdate(next);
    updateState({ error: "" });
    if (batch.costMushies !== previous?.costMushies) void useCreditStore.getState().forceFetchCredits().catch(() => {});
  }, [scope, worldId, updateState]);

  useEffect(() => {
    scope.activate();
    return () => scope.dispose();
  }, [scope]);

  useEffect(() => {
    if (!owner) return;
    const controller = new AbortController();
    void scope.request<{ smartEstimates?: Record<string, number> }>(`${apiBase}/api/generation/templates`, { signal: controller.signal })
      .then(({ response, data }) => {
        if (!response.ok || !scope.current) return;
        setEstimates({ identity, values: Object.fromEntries(Object.entries(data.smartEstimates ?? {})
          .filter(([, value]) => Number.isFinite(value) && value >= 0)) });
      }).catch(() => {});
    return () => controller.abort();
  }, [owner, scope, identity]);

  useEffect(() => {
    if (!owner || proposal.status === "declined") { updateState({ restoring: false }); return; }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const poll = async () => {
      if (stopped || !scope.current) return;
      const version = operations.version;
      try {
        const remembered = latest.current.proposal.batch;
        const url = remembered ? `${base}/image-batches/${encodeURIComponent(remembered.id)}`
          : `${base}/image-batches?runId=${encodeURIComponent(proposal.runId)}`;
        const { response, data } = await scope.request<{ data: ImageBatchSnapshot | ImageBatchSnapshot[] }>(url, { signal: controller.signal });
        if (stopped || !scope.current || version !== operations.version) return;
        if (!response.ok) throw new Error(`HTTP_${response.status}`);
        const batch = matchingImageBatch(latest.current.proposal, worldId, Array.isArray(data.data) ? data.data : data.data ? [data.data] : []);
        if (batch) accept(batch);
        updateState({ restoring: false });
        setState(previous => previous.identity === identity && previous.error === "SYNC_FAILED" ? { ...previous, error: "" } : previous);
        if (batch?.status === "running") timer = setTimeout(poll, 3_000);
      } catch {
        if (stopped || !scope.current || version !== operations.version) return;
        updateState({ restoring: false, error: "SYNC_FAILED" });
        timer = setTimeout(poll, 8_000);
      }
    };
    void poll();
    const wake = () => { if (timer) clearTimeout(timer); if (!operations.busy) void poll(); };
    window.addEventListener("online", wake);
    return () => { stopped = true; controller.abort(); if (timer) clearTimeout(timer); window.removeEventListener("online", wake); };
  }, [owner, scope, identity, base, worldId, proposal.runId, proposal.status, proposal.batch?.id, refreshVersion, operations, accept, updateState]);

  const mutate = useCallback(async (action: "confirm" | "decline" | "retry" | "resume", edits?: StudioImageBatchEdits) => {
    if (!owner || !scope.current || operations.busy) return;
    const current = latest.current.proposal;
    if ((action === "confirm" || action === "decline") && current.status !== "pending") return;
    if ((action === "retry" || action === "resume") && !current.batch) return;
    operations.busy = true;
    operations.version++;
    updateState({ busy: true, error: "" });
    try {
      const url = action === "confirm" || action === "decline" ? `${base}/generate-images`
        : `${base}/image-batches/${encodeURIComponent(current.batch!.id)}/${action}`;
      const body = action === "confirm" || action === "decline"
        ? { runId: current.runId, approved: action === "confirm", ...edits }
        : action === "retry" ? { itemIds: imageBatchRetryIds(current.batch!), requestId: crypto.randomUUID() } : {};
      const { response, data } = await scope.request<{ data?: ImageBatchSnapshot; declined?: boolean; code?: string }>(url, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(data.code ?? `HTTP_${response.status}`);
      if (data.data) accept(data.data);
      else if (data.declined && action === "decline") {
        const next = { ...current, status: "declined" as const };
        latest.current.proposal = next;
        latest.current.onUpdate(next);
      } else throw new Error("REQUEST_FAILED");
    } catch (error) {
      if (scope.current) updateState({ error: error instanceof Error ? error.message : "REQUEST_FAILED" });
    } finally {
      operations.busy = false;
      if (scope.current) {
        updateState({ busy: false });
        // Reconcile even a lost POST response. Creation is idempotent by run/tool;
        // refreshing finds the saved batch without starting or paying for it again.
        setRefreshVersion(version => version + 1);
      }
    }
  }, [owner, scope, operations, updateState, base, accept]);

  return { ...currentState, owner, estimates: estimates.identity === identity ? estimates.values : {},
    confirm: (edits: StudioImageBatchEdits) => mutate("confirm", edits), decline: () => mutate("decline"),
    retry: () => mutate("retry"), resume: () => mutate("resume"), refresh: () => setRefreshVersion(version => version + 1) };
}
