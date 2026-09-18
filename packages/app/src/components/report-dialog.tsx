import { useState, useRef, useEffect, useCallback } from "react";
import { Flag, X, Loader2, ImagePlus, Upload, Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { feedback } from "@/lib/feedback";
import { FieldError } from "@/components/ui/field-error";

const apiBase = import.meta.env.VITE_API_URL || "";

const REPORT_REASONS = [
  { value: "illegal_content", labelKey: "report.reasons.illegalContent" },
  { value: "copyright", labelKey: "report.reasons.copyright" },
  { value: "harassment_hate", labelKey: "report.reasons.harassment" },
  { value: "nsfw_mislabeled", labelKey: "report.reasons.nsfwMislabeled" },
] as const;

interface ScreenshotState {
  file: File;
  preview: string;
  key: string | null;
  uploading: boolean;
  error: boolean;
}

interface ReportDialogProps {
  worldId: string;
  targetName: string;
  open: boolean;
  onClose: () => void;
}

export function ReportDialog({ worldId, targetName, open, onClose }: ReportDialogProps) {
  const { t } = useTranslation();
  const [reason, setReason] = useState<string>("");
  const [details, setDetails] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [alreadyReported, setAlreadyReported] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [screenshots, setScreenshots] = useState<ScreenshotState[]>([]);
  const [screenshotError, setScreenshotError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Check if user already reported this world
  useEffect(() => {
    if (!open) return;
    setSubmitted(false);
    setFormError(null);
    setScreenshotError(null);
    fetch(`${apiBase}/api/worlds/${worldId}/report/mine`, { credentials: "include" })
      .then((r) => r.json())
      .then((d) => {
        if (d.data?.reported) setAlreadyReported(true);
      })
      .catch(() => {});
  }, [open, worldId]);

  // Cleanup preview URLs on unmount
  useEffect(() => {
    return () => {
      screenshots.forEach((s) => URL.revokeObjectURL(s.preview));
    };
  }, [screenshots]);

  const uploadScreenshot = useCallback(async (file: File): Promise<ScreenshotState> => {
    const preview = URL.createObjectURL(file);
    const state: ScreenshotState = { file, preview, key: null, uploading: true, error: false };

    try {
      // Get presigned URL
      const urlRes = await fetch(`${apiBase}/api/reports/upload-screenshot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ filename: file.name, contentType: file.type }),
      });

      if (!urlRes.ok) throw new Error("Failed to get upload URL");
      const { data } = await urlRes.json();

      // Upload to S3
      const uploadRes = await fetch(data.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });

      if (!uploadRes.ok) throw new Error("Upload failed");
      return { ...state, key: data.key, uploading: false };
    } catch {
      return { ...state, uploading: false, error: true };
    }
  }, []);

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const fileArray = Array.from(files);
    const remaining = 4 - screenshots.length;
    setScreenshotError(null);
    if (remaining <= 0) {
      setScreenshotError(t("toasts:maxScreenshots", "Maximum 4 screenshots"));
      return;
    }

    const validFiles = fileArray
      .filter((f) => f.type.startsWith("image/") && f.size <= 10 * 1024 * 1024)
      .slice(0, remaining);

    if (validFiles.length < fileArray.length) {
      setScreenshotError(t("toasts:filesSkipped", "Some files were skipped (must be images under 10MB)"));
    }

    // Add placeholders immediately
    const placeholders: ScreenshotState[] = validFiles.map((f) => ({
      file: f,
      preview: URL.createObjectURL(f),
      key: null,
      uploading: true,
      error: false,
    }));
    setScreenshots((prev) => [...prev, ...placeholders]);

    // Upload in parallel
    const results = await Promise.all(validFiles.map(uploadScreenshot));

    // Replace placeholders with results
    setScreenshots((prev) => {
      const updated = [...prev];
      for (const result of results) {
        const idx = updated.findIndex((s) => s.file === result.file);
        if (idx !== -1) updated[idx] = result;
      }
      return updated;
    });
  }, [screenshots.length, uploadScreenshot, t]);

  const removeScreenshot = useCallback((index: number) => {
    setScreenshots((prev) => {
      const removed = prev[index];
      if (removed) URL.revokeObjectURL(removed.preview);
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length > 0) {
      addFiles(e.dataTransfer.files);
    }
  }, [addFiles]);

  async function handleSubmit() {
    setFormError(null);
    if (!reason) {
      setFormError(t("toasts:selectReason", "Please select a reason"));
      return;
    }

    // Wait for any uploads in progress
    if (screenshots.some((s) => s.uploading)) {
      setFormError(t("toasts:waitForScreenshots", "Please wait for screenshots to finish uploading"));
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`${apiBase}/api/worlds/${worldId}/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          reason,
          details: details.trim() || undefined,
          screenshotKeys: screenshots.filter((s) => s.key).map((s) => s.key),
        }),
      });

      if (res.status === 409) {
        // No pill: the dialog's own "already reported" branch below is the
        // confirmation the user needs.
        setAlreadyReported(true);
        return;
      }

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to submit report");
      }

      // Show the confirmation as the dialog's own success step, not a pill —
      // the caller closes it when the user dismisses that step.
      setReason("");
      setDetails("");
      setScreenshots([]);
      setSubmitted(true);
    } catch (err) {
      feedback.error(err instanceof Error ? err.message : t("toasts:failedSubmitReport", "Failed to submit report"), {
        label: t("common:action.retry", "Retry"),
        onClick: () => void handleSubmit(),
      });
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative mx-4 w-full max-w-md rounded-2xl border border-white/10 bg-card shadow-2xl animate-in fade-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <Flag className="h-4 w-4 text-red-400" />
            <h2 className="text-base font-black text-foreground">{t("report.title", { name: targetName })}</h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-full p-1.5 text-muted-foreground/40 transition-colors hover:bg-white/5 hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Content */}
        <div className="px-6 py-5 space-y-4 max-h-[70vh] overflow-y-auto">
          {submitted ? (
            <div className="rounded-xl border border-white/5 bg-[#1A1A1C] px-4 py-6 text-center">
              <div className="mx-auto flex h-8 w-8 items-center justify-center rounded-full bg-emerald-500/15">
                <Check className="h-4 w-4 text-emerald-400" />
              </div>
              <p className="mt-2 text-sm font-medium text-foreground">{t("toasts:reportSubmitted", "Report submitted. We'll review it shortly.")}</p>
            </div>
          ) : alreadyReported ? (
            <div className="rounded-xl border border-white/5 bg-[#1A1A1C] px-4 py-6 text-center">
              <Flag className="mx-auto h-8 w-8 text-muted-foreground/30 mb-2" />
              <p className="text-sm font-medium text-foreground">{t("report.alreadyReported")}</p>
              <p className="text-xs text-muted-foreground/60 mt-1">
                {t("report.alreadyReportedDesc")}
              </p>
            </div>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                {t("report.selectReason")}
              </p>
              <FieldError id="report-form-error" message={formError} />

              {/* Reason selection */}
              <div className="space-y-2">
                {REPORT_REASONS.map((r) => (
                  <button
                    key={r.value}
                    onClick={() => setReason(r.value)}
                    className={`w-full rounded-xl border px-4 py-2.5 text-left text-sm font-medium transition-all ${
                      reason === r.value
                        ? "border-red-400/40 bg-red-500/10 text-red-400"
                        : "border-white/5 bg-[#1A1A1C] text-muted-foreground hover:border-white/10 hover:bg-white/5 hover:text-foreground"
                    }`}
                  >
                    {t(r.labelKey)}
                  </button>
                ))}
              </div>

              {/* Optional details */}
              <textarea
                value={details}
                onChange={(e) => setDetails(e.target.value)}
                placeholder={t("report.detailsPlaceholder")}
                maxLength={2000}
                rows={3}
                className="w-full rounded-xl border border-white/5 bg-[#1A1A1C] px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground/40 focus:border-white/10 focus:outline-none resize-none"
              />

              {/* Screenshot upload */}
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground/60">
                  {t("report.screenshots")}
                </p>

                {/* Thumbnail grid */}
                {screenshots.length > 0 && (
                  <div className="grid grid-cols-4 gap-2">
                    {screenshots.map((s, i) => (
                      <div key={i} className="relative aspect-square rounded-lg overflow-hidden border border-white/10 bg-[#1A1A1C]">
                        <img src={s.preview} alt="" className="h-full w-full object-cover" />
                        {s.uploading && (
                          <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                            <Loader2 className="h-4 w-4 animate-spin text-white" />
                          </div>
                        )}
                        {s.error && (
                          <div className="absolute inset-0 flex items-center justify-center bg-red-900/50">
                            <span className="text-xs text-red-300">{t("combat.error")}</span>
                          </div>
                        )}
                        <button
                          onClick={() => removeScreenshot(i)}
                          className="absolute top-1 right-1 rounded-full bg-black/60 p-0.5 text-white/60 hover:text-white transition-colors"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {/* Drop zone */}
                {screenshots.length < 4 && (
                  <div
                    onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={handleDrop}
                    onClick={() => fileInputRef.current?.click()}
                    className={`flex flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed px-4 py-4 cursor-pointer transition-all ${
                      dragging
                        ? "border-red-400/40 bg-red-500/5"
                        : "border-white/10 hover:border-white/20 hover:bg-white/[0.02]"
                    }`}
                  >
                    {dragging ? (
                      <Upload className="h-5 w-5 text-red-400/60" />
                    ) : (
                      <ImagePlus className="h-5 w-5 text-muted-foreground/30" />
                    )}
                    <span className="text-xs text-muted-foreground/40">
                      {dragging ? t("report.dropHere") : t("report.dragHere")}
                    </span>
                  </div>
                )}

                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/gif,image/webp"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    if (e.target.files) addFiles(e.target.files);
                    e.target.value = "";
                  }}
                />
                <FieldError id="report-screenshot-error" message={screenshotError} />
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        {!alreadyReported && !submitted && (
          <div className="flex items-center justify-end gap-3 border-t border-white/10 px-6 py-4">
            <button
              onClick={onClose}
              className="rounded-xl px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
            >
              {t("report.cancel")}
            </button>
            <button
              onClick={handleSubmit}
              disabled={!reason || submitting}
              className="flex items-center gap-2 rounded-xl bg-red-500/10 border border-red-500/30 px-5 py-2 text-sm font-bold text-red-400 transition-all hover:bg-red-500/20 disabled:opacity-40 disabled:pointer-events-none"
            >
              {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {submitting ? t("report.submitting") : t("report.submit")}
            </button>
          </div>
        )}

        {(alreadyReported || submitted) && (
          <div className="flex items-center justify-end border-t border-white/10 px-6 py-4">
            <button
              onClick={onClose}
              className="rounded-xl px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
            >
              {t("report.close")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
