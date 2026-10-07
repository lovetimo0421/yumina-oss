import { captureCreatorLearningEvent, newFeedRequestId, type CreatorLearningEvent } from "@/lib/analytics";

/** One flow per guide opening; no draft or conversation data enters analytics. */
export function createLearningTracker(capture = captureCreatorLearningEvent) {
  let flowId = newFeedRequestId();
  let previousView = "";
  return {
    reset() { flowId = newFeedRequestId(); previousView = ""; },
    track(event: Omit<CreatorLearningEvent, "flow_id">) { capture({ ...event, flow_id: flowId }); },
    view(event: Omit<CreatorLearningEvent, "flow_id" | "action">) {
      const key = `${event.step}:${event.outcome ?? ""}`;
      if (key === previousView) return;
      previousView = key;
      capture({ ...event, flow_id: flowId, action: "view" });
    },
  };
}
