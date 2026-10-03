import { useEffect, useMemo, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Check, History, Loader2 } from "lucide-react";
import type { WorldChange, WorldDefinition, WorldDiff } from "@yumina/engine";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { FieldError } from "@/components/ui/field-error";
import { cn } from "@/lib/utils";
import { feedback } from "@/lib/feedback";
import { formatTimeAgo } from "@/lib/format-time";
import { useWorldsStore } from "@/stores/worlds";
import { applyIncomingToWorld, diffAgainstTarget, ApplyChangesError, type ApplyTarget } from "./apply-world-changes";

const SHOWN_CHANGES = 10;

const TONE: Record<WorldChange["op"], { mark: string; cls: string }> = {
  added: { mark: "+", cls: "text-emerald-400" },
  modified: { mark: "~", cls: "text-amber-300" },
  removed: { mark: "−", cls: "text-red-400" },
};

interface Props {
  open: boolean;
  onClose: () => void;
  /** The caller's own cards this could update; the first is preselected. */
  targets: ApplyTarget[];
  incoming: WorldDefinition;
  /** Where the content came from, for the header and the backup's note. */
  source: { kind: "file"; fileName: string } | { kind: "copy"; fromName: string };
  /** The author kept editing after the helper copied — applying replaces that too. */
  targetChangedSinceCopy?: boolean;
  /** Keep the incoming content as its own project instead. */
  onSaveAsNew: () => void | Promise<void>;
}

/** "Update my card with this" — shared by importing a file that is one of the
 *  creator's own cards, and by a helper's changed copy coming back over DM. */
export function ApplyChangesDialog({ open, onClose, targets, incoming, source, targetChangedSinceCopy, onSaveAsNew }: Props) {
  const { t, i18n } = useTranslation(["editor", "common"]);
  const router = useRouter();
  const [targetId, setTargetId] = useState(targets[0]?.id ?? "");
  const [diff, setDiff] = useState<WorldDiff | null>(null);
  const [diffFailed, setDiffFailed] = useState(false);
  const [busy, setBusy] = useState<"apply" | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const target = targets.find((w) => w.id === targetId) ?? targets[0];

  useEffect(() => {
    if (!open || !target) return;
    let live = true;
    setDiff(null);
    setDiffFailed(false);
    diffAgainstTarget(target.id, incoming)
      .then((d) => { if (live) setDiff(d); })
      .catch(() => { if (live) setDiffFailed(true); });
    return () => { live = false; };
  }, [open, target, incoming]);

  // i18next keys are statically typed; the kind/op keys are built at runtime.
  const tt = t as unknown as (key: string, opts?: Record<string, unknown>) => string;
  const ordered = useMemo(() => {
    if (!diff) return [];
    const rank = { added: 0, modified: 1, removed: 2 } as const;
    return [...diff.changes].sort((a, b) => rank[a.op] - rank[b.op]);
  }, [diff]);
  const isPublished = target?.status === "published";
  const sourceLine = source.kind === "file"
    ? tt("editor:worldChanges.fromFile", { file: source.fileName })
    : tt("editor:worldChanges.fromCopy", { name: source.fromName });

  async function apply() {
    if (!target || busy) return;
    setBusy("apply");
    setError(null);
    try {
      const note = source.kind === "file"
        ? tt("editor:worldChanges.backupNoteFile", { file: source.fileName })
        : tt("editor:worldChanges.backupNoteCopy", { name: source.fromName });
      const { heldForReview } = await applyIncomingToWorld({ targetId: target.id, incoming, note });
      useWorldsStore.getState().invalidate();
      feedback.notice(tt(heldForReview ? "editor:worldChanges.appliedHeld" : "editor:worldChanges.applied", { name: target.name }));
      onClose();
      void router.navigate({ to: "/app/worlds/$worldId/edit", params: { worldId: target.id } });
    } catch (err) {
      const step = err instanceof ApplyChangesError ? err.step : "save";
      setError(tt(`editor:worldChanges.error.${step}`));
    } finally {
      setBusy(null);
    }
  }

  async function saveAsNew() {
    if (busy) return;
    setBusy("new");
    try {
      await onSaveAsNew();
    } finally {
      setBusy(null);
    }
  }

  if (!target) return null;
  const noChanges = diff !== null && diff.changes.length === 0;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      <DialogContent mobileSheet className="gap-0 p-0 sm:max-w-md">
        <div className="space-y-1.5 px-5 pb-4 pt-5 pr-14">
          <DialogTitle className="text-base leading-snug">
            {tt("editor:worldChanges.title", { name: target.name })}
          </DialogTitle>
          <DialogDescription className="text-[13px]">{sourceLine}</DialogDescription>
        </div>

        <div className="space-y-4 px-5 pb-5">
          {targets.length > 1 && (
            <div>
              <p className="mb-2 text-xs font-medium text-muted-foreground">{tt("editor:worldChanges.pickTarget")}</p>
              <div className="max-h-44 space-y-1.5 overflow-y-auto pr-0.5">
                {targets.map((w) => (
                  <button
                    key={w.id}
                    type="button"
                    disabled={!!busy}
                    onClick={() => setTargetId(w.id)}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-xl border px-3 py-2 text-left transition-colors",
                      w.id === target.id ? "border-primary/50 bg-primary/[0.08]" : "border-border hover:bg-accent/40",
                    )}
                  >
                    {w.thumbnailUrl
                      ? <img src={w.thumbnailUrl} alt="" className="h-9 w-9 shrink-0 rounded-lg object-cover" />
                      : <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-sm font-semibold text-muted-foreground">{w.name.charAt(0)}</span>}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-foreground">{w.name}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {w.status === "published" ? tt("editor:worldChanges.statusPublished") : tt("editor:worldChanges.statusDraft")}
                        {w.updatedAt ? ` · ${formatTimeAgo(w.updatedAt, i18n.language)}` : ""}
                        {w.exact ? ` · ${tt("editor:worldChanges.exactOrigin")}` : ""}
                      </span>
                    </span>
                    {w.id === target.id && <Check className="h-4 w-4 shrink-0 text-primary" />}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="rounded-xl border border-border bg-background/40 px-3.5 py-3">
            {diffFailed ? (
              <p className="text-[13px] text-muted-foreground">{tt("editor:worldChanges.diffFailed")}</p>
            ) : diff === null ? (
              <div className="flex items-center gap-2 text-[13px] text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />{tt("editor:worldChanges.comparing")}</div>
            ) : noChanges ? (
              <p className="text-[13px] text-muted-foreground">{tt("editor:worldChanges.noChanges")}</p>
            ) : (
              <>
                <p className="text-[13px] font-medium text-foreground">
                  {tt("editor:worldChanges.summary", { added: diff.counts.added, modified: diff.counts.modified, removed: diff.counts.removed })}
                </p>
                <ul className="mt-2 space-y-1">
                  {ordered.slice(0, SHOWN_CHANGES).map((c, i) => (
                    <li key={`${c.kind}-${c.id ?? i}-${c.op}`} className="flex min-w-0 items-baseline gap-2 text-[12.5px]">
                      <span className={cn("w-3 shrink-0 text-center font-semibold", TONE[c.op].cls)}>{TONE[c.op].mark}</span>
                      <span className="shrink-0 text-muted-foreground">{tt(`editor:studio.changeLog.kind.${c.kind}`, { defaultValue: c.kind })}</span>
                      <span className="min-w-0 truncate text-foreground/90">{c.name ?? c.id ?? ""}</span>
                    </li>
                  ))}
                </ul>
                {ordered.length > SHOWN_CHANGES && (
                  <p className="mt-1.5 pl-5 text-[11.5px] text-muted-foreground">{tt("editor:worldChanges.more", { count: ordered.length - SHOWN_CHANGES })}</p>
                )}
              </>
            )}
          </div>

          {targetChangedSinceCopy && (
            <p className="flex gap-2 rounded-xl border border-amber-500/25 bg-amber-500/[0.07] px-3 py-2.5 text-[12.5px] leading-relaxed text-amber-200/90">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {tt("editor:worldChanges.changedSinceCopy")}
            </p>
          )}

          <ul className="space-y-1.5 text-[12px] leading-relaxed text-muted-foreground">
            <li className="flex gap-2"><History className="mt-0.5 h-3.5 w-3.5 shrink-0" />{tt("editor:worldChanges.backupLine")}</li>
            {isPublished && <li className="flex gap-2"><Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />{tt("editor:worldChanges.publishedLine")}</li>}
          </ul>

          <FieldError message={error} />

          <div className="flex flex-col gap-2 pt-1">
            <button
              type="button"
              onClick={() => void apply()}
              disabled={!!busy || noChanges}
              className="flex min-h-11 items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
            >
              {busy === "apply" && <Loader2 className="h-4 w-4 animate-spin" />}
              {tt("editor:worldChanges.apply", { name: target.name })}
            </button>
            <button
              type="button"
              onClick={() => void saveAsNew()}
              disabled={!!busy}
              className="flex min-h-11 items-center justify-center gap-2 rounded-xl border border-border px-4 text-sm font-medium text-foreground/85 transition-colors hover:bg-accent/40 disabled:opacity-40"
            >
              {busy === "new" && <Loader2 className="h-4 w-4 animate-spin" />}
              {tt("editor:worldChanges.saveAsNew")}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
