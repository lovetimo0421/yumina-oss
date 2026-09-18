import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, X, Plus, Link2, Code2 } from "lucide-react";
import { LoreBindingsPanel } from "../components/lore-bindings-panel";
import { FieldError } from "@/components/ui/field-error";
import { useEditorStore } from "@/stores/editor";
import { compileTSX } from "@/features/studio/lib/tsx-compiler";
import { normalizeCardFileName, starterCardFile } from "@/features/studio/lib/card-file-names";
import { cn } from "@/lib/utils";
import { getBundleColor } from "@/lib/entry-constants";
import { DebouncedInput, DebouncedTextarea } from "../components/debounced-field";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { TwoTapDeleteButton } from "@/components/ui/two-tap-delete-button";

/** Editor section for the world's visual layer.
 *
 *  Post v1→v2 unification: every world has exactly one rootComponent — a
 *  multi-file virtual filesystem. This section lets creators edit the entry
 *  file + sibling files. The legacy customUI[]-per-surface editor was
 *  removed; v1 worlds were batch-migrated to rootComponent in prod (phase 3). */

function CompileIndicator({ tsxCode }: { tsxCode: string }) {
  const { t } = useTranslation("editor");
  const [status, setStatus] = useState<{ ok: boolean; message: string }>({ ok: true, message: "" });
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (!tsxCode) {
      setStatus({ ok: true, message: "" });
      return;
    }
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const result = compileTSX(tsxCode);
      if (result.error) {
        setStatus({ ok: false, message: result.error });
      } else {
        setStatus({ ok: true, message: "" });
      }
    }, 400);
    return () => clearTimeout(debounceRef.current);
  }, [tsxCode]);

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-muted-foreground">{t("components.compile")}</span>
      {status.ok ? (
        <span className="flex items-center gap-1 text-emerald-400">
          <Check className="h-3.5 w-3.5" />
          {t("components.ok")}
        </span>
      ) : (
        <span className="flex items-center gap-1 text-destructive">
          <X className="h-3.5 w-3.5" />
          <span className="truncate">{status.message}</span>
        </span>
      )}
    </div>
  );
}

export function ComponentsSection() {
  const { t } = useTranslation("editor");
  const rootComponent = useEditorStore((s) => s.worldDraft.rootComponent);
  const updateRootComponent = useEditorStore((s) => s.updateRootComponent);
  const installedBundles = useEditorStore((s) => s.worldDraft.installedBundles);

  // Map a `_bundles/{slug}/…` file to the color of the bundle it belongs to.
  const bundleColorForFile = useCallback(
    (fileName: string) => {
      const m = fileName.match(/^_bundles\/([^/]+)\//);
      if (!m) return null;
      const rec = installedBundles?.find((b) => b.slug === m[1]);
      return rec ? getBundleColor(rec.colorKey) : null;
    },
    [installedBundles],
  );

  const entryFile = rootComponent?.entryFile ?? "index.tsx";
  const files = rootComponent?.files ?? {};
  const [activeFile, setActiveFile] = useState<string>(entryFile);
  // One dialog, two jobs: "add" creates a file, "rename" moves the one named
  // in `target`. Both go through the same name validation.
  const [fileDialog, setFileDialog] = useState<{ mode: "add" | "rename"; target: string } | null>(null);
  const [newFileName, setNewFileName] = useState("");
  const [newFileError, setNewFileError] = useState<string | null>(null);
  const activeTab = useEditorStore((s) => s.customUiTab);
  const setActiveTab = useEditorStore((s) => s.setCustomUiTab);

  // If active file was deleted, fall back to entry file
  const fileExists = activeFile in files;
  useEffect(() => {
    if (!fileExists) setActiveFile(entryFile);
  }, [fileExists, entryFile]);

  // Worlds that arrived without rootComponent (shouldn't happen — migrator
  // synthesizes one for every world loaded — but render a safety fallback).
  if (!rootComponent) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        This world has no rootComponent. Save the draft to regenerate a default.
      </div>
    );
  }

  const fileNames = Object.keys(files).sort((a, b) => {
    if (a === entryFile) return -1;
    if (b === entryFile) return 1;
    return a.localeCompare(b);
  });

  const safeActiveFile = fileExists ? activeFile : entryFile;
  const activeFileCode = files[safeActiveFile] ?? "";

  const handleConfirmFileName = useCallback(() => {
    if (!fileDialog) return;
    const result = normalizeCardFileName(newFileName);
    if (!result.ok) {
      if (result.reason === "empty") return;
      setNewFileError(
        t(result.reason === "extension" ? "components.fileBadExtension" : "components.fileBadPath"),
      );
      return;
    }
    const { name } = result;
    if (name === fileDialog.target) {
      setNewFileName("");
      setFileDialog(null);
      return;
    }
    if (rootComponent.files[name] !== undefined) {
      setNewFileError(t("components.fileExists"));
      return;
    }
    setNewFileError(null);

    if (fileDialog.mode === "rename") {
      const oldName = fileDialog.target;
      // Rebuild rather than mutate so the key order stays predictable, and
      // carry the entry pointer along when the entry file is the one moving —
      // a rootComponent whose entryFile names a missing file black-screens.
      const nextFiles: Record<string, string> = {};
      for (const [key, code] of Object.entries(rootComponent.files)) {
        nextFiles[key === oldName ? name : key] = code;
      }
      updateRootComponent({
        files: nextFiles,
        ...(rootComponent.entryFile === oldName ? { entryFile: name } : {}),
      });
    } else {
      updateRootComponent({
        files: { ...rootComponent.files, [name]: starterCardFile(name) },
      });
    }

    setActiveFile(name);
    setNewFileName("");
    setFileDialog(null);
  }, [fileDialog, rootComponent, updateRootComponent, newFileName, t]);

  const openAddFileDialog = useCallback(() => {
    setNewFileName("");
    setNewFileError(null);
    setFileDialog({ mode: "add", target: "" });
  }, []);

  const openRenameFileDialog = (name: string) => {
    setNewFileName(name);
    setNewFileError(null);
    setFileDialog({ mode: "rename", target: name });
  };

  const handleRemoveFile = useCallback((name: string) => {
    if (name === rootComponent.entryFile) return;
    const newFiles = { ...rootComponent.files };
    delete newFiles[name];
    updateRootComponent({ files: newFiles });
    setActiveFile(rootComponent.entryFile);
  }, [rootComponent, updateRootComponent]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border bg-card px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-[22px] font-bold tracking-tight text-foreground">
              {t("components.title")}
            </h1>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              {t("components.description")}
            </p>
          </div>
        </div>
      </div>

      <div className="flex shrink-0 gap-1 border-b border-border px-6" data-tour="components-tabs">
        <button
          type="button"
          onClick={() => setActiveTab("code")}
          className={cn(
            "flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-xs font-medium transition-colors",
            activeTab === "code"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          <Code2 className="h-3.5 w-3.5" />
          {t("components.tabCode")}
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("bindings")}
          className={cn(
            "flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-xs font-medium transition-colors",
            activeTab === "bindings"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          <Link2 className="h-3.5 w-3.5" />
          {t("components.tabBindings")}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {activeTab === "bindings" ? (
          <LoreBindingsPanel />
        ) : (
        <div className="space-y-4 pb-8">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              {t("components.componentName")}
            </label>
            <DebouncedInput
              type="text"
              value={rootComponent.name}
              onCommit={(name) => updateRootComponent({ name })}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
            />
          </div>

          <CompileIndicator tsxCode={activeFileCode} />

          {/* overflow-x-auto keeps a long file list scrolling inside the
              strip instead of stretching the whole editor pane. */}
          <div
            className="flex items-center gap-1 overflow-x-auto border-b border-border pb-1"
            style={{ scrollbarWidth: "none" }}
          >
            {fileNames.map((name) => {
              const fileColor = bundleColorForFile(name);
              return (
              <button
                key={name}
                type="button"
                onClick={() => setActiveFile(name)}
                className={cn(
                  "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-t-md px-3 py-1.5 text-xs font-mono",
                  activeFile === name
                    ? "bg-muted text-foreground border border-b-0 border-border"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {fileColor && (
                  <span className={cn("h-2 w-2 shrink-0 rounded-full", fileColor.dot)} />
                )}
                {name}
                {name === rootComponent.entryFile && (
                  <span className="ml-1 text-[9px] text-muted-foreground/50">entry</span>
                )}
              </button>
              );
            })}
            <button
              type="button"
              onClick={openAddFileDialog}
              className="shrink-0 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted"
              title={t("components.addFile")}
            >
              <Plus className="h-3 w-3" />
            </button>
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <label className="text-xs font-medium text-muted-foreground font-mono">
                {activeFile}
              </label>
              <div className="flex items-center gap-3">
                {/* Bundle files are owned by the bundle that installed them —
                    renaming one out of `_bundles/<slug>/` orphans it there. */}
                {!safeActiveFile.startsWith("_bundles/") && (
                  <button
                    type="button"
                    onClick={() => openRenameFileDialog(safeActiveFile)}
                    className="text-xs text-muted-foreground hover:text-foreground hover:underline"
                  >
                    {t("components.rename")}
                  </button>
                )}
                {activeFile !== rootComponent.entryFile && (
                  <TwoTapDeleteButton
                    onConfirm={() => handleRemoveFile(activeFile)}
                    className="text-xs text-destructive hover:underline"
                    armedClassName="rounded px-1.5 bg-destructive text-destructive-foreground no-underline"
                    armedChildren={t("twoTapConfirm")}
                  >
                    {t("components.remove")}
                  </TwoTapDeleteButton>
                )}
              </div>
            </div>
            <DebouncedTextarea
              value={activeFileCode}
              onCommit={(code) => {
                updateRootComponent({
                  files: { ...rootComponent.files, [activeFile]: code },
                });
              }}
              syncKey={safeActiveFile}
              delay={500}
              rows={24}
              spellCheck={false}
              className="w-full resize-y rounded-lg border border-border bg-muted/30 px-4 py-3 font-mono text-xs leading-relaxed text-foreground placeholder:text-muted-foreground/30 focus:border-primary focus:outline-none"
              placeholder={`export default function MyWorld() {\n  return <Chat />;\n}`}
            />
          </div>

          <div className="rounded-lg border border-border/60 bg-muted/20 p-4">
            <h3 className="mb-2 text-xs font-medium text-foreground">{t("components.availableTools")}</h3>
            <div className="space-y-1 text-[11px] text-muted-foreground">
              <div><code className="text-primary">{"useYumina()"}</code> — {t("components.toolUseYumina")}</div>
              <div><code className="text-primary">{"<Chat renderBubble={...} />"}</code> — {t("components.toolChat")}</div>
              <div><code className="text-primary">{"<MessageList>"}</code> — {t("components.toolMessageList")}</div>
              <div><code className="text-primary">{"<MessageInput onSend={...} />"}</code> — {t("components.toolMessageInput")}</div>
              <div><code className="text-primary">{"Icons.Heart, Icons.Sword, ..."}</code> — {t("components.toolIcons")}</div>
              <div><code className="text-primary">{"<LoreSlot id=\"slot-id\" />"}</code> — {t("components.toolLoreSlot")}</div>
            </div>
          </div>
        </div>
        )}
      </div>

      <Dialog open={!!fileDialog} onOpenChange={(open) => { if (!open) setFileDialog(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {t(fileDialog?.mode === "rename" ? "components.renameFile" : "components.addFile")}
            </DialogTitle>
            <DialogDescription>
              {t(fileDialog?.mode === "rename" ? "components.renameFileHint" : "components.addFileHint")}
            </DialogDescription>
          </DialogHeader>
          <div>
            <input
              type="text"
              value={newFileName}
              onChange={(e) => {
                setNewFileName(e.target.value);
                if (newFileError) setNewFileError(null);
              }}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === "Enter") handleConfirmFileName();
                if (e.key === "Escape") setFileDialog(null);
              }}
              placeholder="stat-bar.tsx"
              autoFocus
              aria-invalid={!!newFileError}
              aria-describedby="add-file-error"
              className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm font-mono text-foreground focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/50 aria-invalid:border-destructive/60"
            />
            <FieldError id="add-file-error" message={newFileError} />
          </div>
          <DialogFooter>
            <button
              onClick={() => setFileDialog(null)}
              className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {t("components.cancel")}
            </button>
            <button
              onClick={handleConfirmFileName}
              disabled={!newFileName.trim()}
              className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
            >
              {t(fileDialog?.mode === "rename" ? "components.rename" : "components.create")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
