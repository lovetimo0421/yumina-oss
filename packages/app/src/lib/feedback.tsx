/**
 * The only module (besides components/ui/sonner.tsx) allowed to import Sonner.
 * Five shapes, no success(): the tier policy sends successes to inline state.
 * Spec: docs/superpowers/specs/2026-09-05-feedback-system-redesign-design.md
 */
import { toast } from "sonner";
import i18n from "./i18n";

/**
 * Pill telemetry loads analytics (and with it posthog-js) lazily: showing a
 * pill is on the path of every store, and a static import would drag the
 * PostHog SDK into each of those module graphs — and into node tests that
 * give jsdom a `window` but no `location`, where posthog-js throws on load.
 */
const captureHubEvent: typeof import("./analytics")["captureHubEvent"] = (event, props) => {
  void import("./analytics").then((m) => m.captureHubEvent(event, props)).catch(() => {});
};
import { FEEDBACK_MAX_CHARS, durationFor, validateFeedbackText } from "./feedback-policy";
import { Pill, type PillAction } from "@/components/feedback/pill";

export type FeedbackAction = PillAction;

const tr = (key: string, fallback: string) =>
  (i18n.t as (k: string, o?: Record<string, unknown>) => string)(key, { defaultValue: fallback });

function guard(text: string): void {
  if (!import.meta.env?.DEV) return;
  const violation = validateFeedbackText(text);
  if (!violation) return;
  // Length is a soft rule: copy that interpolates a user or world name can run
  // long legitimately, and the pill truncates with an ellipsis. Everything else
  // (multi-line, "!", "successfully", empty) is authored copy and must be fixed.
  if (violation === "length") {
    console.warn(`[feedback] copy over ${FEEDBACK_MAX_CHARS} chars, will truncate: "${text}"`);
    return;
  }
  throw new Error(`[feedback] copy rejected (${violation}): "${text}"`);
}

function dismissAfter(id: string | number) {
  return () => toast.dismiss(id);
}

/** Analytics copy: enough to tell flows apart, short enough to stay cheap. */
function forAnalytics(text: string): string {
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

export const feedback = {
  /**
   * Informational outcome the user could not see happen (T2, neutral): "Changes
   * merged with agent edits", "Draft restored". Plain, 2.5s, no icon, no action.
   * Never for confirming what the user just did — that is inline state (T1) or
   * silence (T0). Guidance about a blocked action belongs next to the control.
   */
  notice(text: string): () => void {
    guard(text);
    captureHubEvent("feedback_pill_shown", { kind: "notice", text: forAnalytics(text) });
    const id = toast.custom((t) => <Pill kind="plain" text={text} onClose={() => toast.dismiss(t)} />, {
      duration: durationFor("notice"),
    });
    return dismissAfter(id);
  },

  /** Unanchored failure (network, stream). Field validation never comes here. */
  error(text: string, action?: FeedbackAction): () => void {
    guard(text);
    captureHubEvent("feedback_pill_shown", { kind: "error", text: forAnalytics(text) });
    const id = toast.custom(
      (t) => (
        <Pill
          kind="error"
          text={text}
          action={
            action && {
              label: action.label,
              onClick: () => {
                toast.dismiss(t);
                action.onClick();
              },
            }
          }
          onClose={() => toast.dismiss(t)}
        />
      ),
      { duration: durationFor("error") },
    );
    return dismissAfter(id);
  },

  /**
   * Act-then-undo. `onUndo` reverses the optimistic change. `onCommit` (optional)
   * runs once when the window closes without an undo — by timer, swipe, or tap —
   * for callers that defer the server call until the window closes.
   */
  undo(text: string, onUndo: () => void, opts?: { onCommit?: () => void }): () => void {
    guard(text);
    captureHubEvent("feedback_pill_shown", { kind: "undo", text: forAnalytics(text) });
    let settled = false;
    const commit = () => {
      if (settled) return;
      settled = true;
      window.removeEventListener("pagehide", commit);
      opts?.onCommit?.();
    };
    // A deferred delete must not be lost to a reload or tab close mid-window.
    window.addEventListener("pagehide", commit);
    const id = toast.custom(
      (t) => (
        <Pill
          kind="plain"
          text={text}
          action={{
            label: tr("common:action.undo", "Undo"),
            onClick: () => {
              if (settled) return;
              settled = true;
              toast.dismiss(t);
              onUndo();
            },
          }}
          onClose={() => {
            commit();
            toast.dismiss(t);
          }}
        />
      ),
      { duration: durationFor("undo"), onAutoClose: commit, onDismiss: commit },
    );
    return () => {
      commit();
      toast.dismiss(id);
    };
  },

  /** Async completion: spinner while pending, then done or failed copy. */
  progress<T>(p: Promise<T>, labels: { pending: string; done: string; failed: string }): Promise<T> {
    guard(labels.pending);
    guard(labels.done);
    guard(labels.failed);
    captureHubEvent("feedback_pill_shown", { kind: "progress", text: forAnalytics(labels.pending) });
    const id = toast.custom(
      (t) => <Pill kind="progress" busy text={labels.pending} onClose={() => toast.dismiss(t)} />,
      { duration: durationFor("progress") },
    );
    p.then(
      () => {
        toast.custom((t) => <Pill kind="plain" text={labels.done} onClose={() => toast.dismiss(t)} />, {
          id,
          duration: durationFor("progress", "done"),
        });
      },
      () => {
        toast.custom((t) => <Pill kind="error" text={labels.failed} onClose={() => toast.dismiss(t)} />, {
          id,
          duration: durationFor("progress", "failed"),
        });
      },
    );
    return p;
  },

  /** Stays until acted on. Rare by design (deploy fallback). */
  persistent(text: string, action: FeedbackAction, opts?: { id?: string }): () => void {
    guard(text);
    captureHubEvent("feedback_pill_shown", { kind: "persistent", text: forAnalytics(text) });
    const id = toast.custom(
      (t) => (
        <Pill
          kind="persistent"
          text={text}
          showClose
          action={{
            label: action.label,
            onClick: () => {
              toast.dismiss(t);
              action.onClick();
            },
          }}
          onClose={() => toast.dismiss(t)}
        />
      ),
      // Sonner spreads options over its generated ID. An undefined ID would
      // replace it, leaving the close handlers pointing at a different toast.
      { duration: durationFor("persistent"), ...(opts?.id ? { id: opts.id } : {}) },
    );
    return dismissAfter(id);
  },
};
