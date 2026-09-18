import { useState, useEffect, useRef } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { Check, AlertCircle, FileCode, Pencil, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { feedback } from "@/lib/feedback";
import { useEditorStore } from "@/stores/editor";
import { bundleTSX } from "../lib/tsx-bundler";
import { normalizeCardFileName, starterCardFile } from "../lib/card-file-names";
import { CopyErrorButton } from "@/components/copy-error-button";

const COMPILE_DEBOUNCE_MS = 500;

// The badge compiles the WHOLE root component with the multi-file bundler (the
// same path play/preview uses), not the active file alone. Per-file compilation
// strips inter-file imports, so any file that imports a sibling would falsely
// flag every reference to it as undefined — a red "error" on a card that runs
// perfectly. Bundling resolves imports across files, so only REAL errors show.
function CompileStatusBadge({
  files,
  entryFile,
  activeFile,
}: {
  files: Record<string, string>;
  entryFile: string;
  activeFile: string;
}) {
  const { t } = useTranslation("editor");
  const [compileStatus, setCompileStatus] = useState<{ ok: boolean; error: string | null } | null>(null);
  const compileTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (!files[activeFile]) {
      setCompileStatus(null);
      return;
    }
    if (compileTimerRef.current) clearTimeout(compileTimerRef.current);
    compileTimerRef.current = setTimeout(() => {
      const result = bundleTSX({ files, entryFile });
      // A compile error in THIS file → red here. A structural error with no
      // attributable file (circular/unresolved import, missing entry) is
      // component-wide → red on every file. An error in a DIFFERENT file leaves
      // this one green (that file's own badge shows it).
      const fileErr = result.fileErrors[activeFile];
      if (fileErr) {
        setCompileStatus({ ok: false, error: fileErr });
      } else if (result.error && Object.keys(result.fileErrors).length === 0) {
        setCompileStatus({ ok: false, error: result.error });
      } else {
        setCompileStatus({ ok: true, error: null });
      }
    }, COMPILE_DEBOUNCE_MS);
    return () => { if (compileTimerRef.current) clearTimeout(compileTimerRef.current); };
  }, [files, entryFile, activeFile]);

  if (!compileStatus) return null;

  return (
    <>
      <span
        className={`flex items-center gap-1 text-[10px] ${
          compileStatus.ok ? "text-green-400" : "text-destructive"
        }`}
      >
        {compileStatus.ok ? (
          <>
            <Check className="h-3 w-3" />
            {t("studio.codeView.ok")}
          </>
        ) : (
          <>
            <AlertCircle className="h-3 w-3" />
            {t("studio.codeView.error")}
          </>
        )}
      </span>
      {!compileStatus.ok && compileStatus.error && (
        <div className="absolute bottom-0 left-0 right-0 flex items-start gap-2 border-t border-destructive/30 bg-destructive/5 px-3 py-2">
          <p className="flex-1 text-xs text-destructive font-mono whitespace-pre-wrap break-all">
            {compileStatus.error}
          </p>
          <CopyErrorButton inline text={compileStatus.error} className="mt-0.5" />
        </div>
      )}
    </>
  );
}

// ── Root component editor ────────────────────────────────────────────
// Multi-file editor for worlds with rootComponent.files

function RootComponentCodeView() {
  const { t } = useTranslation("editor");
  const rootComponent = useEditorStore(s => s.worldDraft.rootComponent);
  const updateRootComponent = useEditorStore(s => s.updateRootComponent);

  const entryFile = rootComponent?.entryFile ?? "index.tsx";
  const files = rootComponent?.files ?? {};
  const [activeFile, setActiveFile] = useState<string>(entryFile);

  // If active file was deleted, fall back to entry file
  const fileExists = activeFile in files;
  useEffect(() => {
    if (!fileExists) setActiveFile(entryFile);
  }, [fileExists, entryFile]);

  if (!rootComponent) return (
    <div className="flex h-full w-full items-center justify-center text-muted-foreground/50">
      <p className="text-xs">{t("studio.codeView.selectOrCreate")}</p>
    </div>
  );

  const fileNames = Object.keys(files).sort((a, b) => {
    if (a === entryFile) return -1;
    if (b === entryFile) return 1;
    return a.localeCompare(b);
  });

  const safeActiveFile = fileExists ? activeFile : entryFile;
  const activeFileCode = files[safeActiveFile] ?? "";

  /** Validate a name typed into a prompt(); report why it was refused.
   *  The name came from a native prompt() — there is no field left to anchor
   *  an inline error to, so these go to a toast. */
  const resolveTypedName = (typed: string): string | null => {
    const result = normalizeCardFileName(typed);
    if (!result.ok) {
      if (result.reason !== "empty") {
        feedback.error(
          t(result.reason === "extension"
            ? "studio.codeView.fileBadExtension"
            : "studio.codeView.fileBadPath"),
        );
      }
      return null;
    }
    if (files[result.name] !== undefined) {
      feedback.error(t("studio.codeView.fileExists"));
      return null;
    }
    return result.name;
  };

  const handleAddFile = () => {
    const typed = prompt(t("studio.codeView.newFilePrompt") || "File name (e.g. stat-bar.tsx):");
    if (!typed) return;
    const name = resolveTypedName(typed);
    if (!name) return;
    updateRootComponent({ files: { ...files, [name]: starterCardFile(name) } });
    setActiveFile(name);
  };

  const handleRenameFile = (oldName: string) => {
    const typed = prompt(t("studio.codeView.renamePrompt") || "New file name:", oldName);
    if (!typed || typed === oldName) return;
    const name = resolveTypedName(typed);
    if (!name) return;
    // Rebuild in place so file order holds, and move the entry pointer with the
    // file when the entry itself is being renamed — an entryFile that names a
    // missing file black-screens the card.
    const nextFiles: Record<string, string> = {};
    for (const [key, code] of Object.entries(files)) {
      nextFiles[key === oldName ? name : key] = code;
    }
    updateRootComponent({
      files: nextFiles,
      ...(entryFile === oldName ? { entryFile: name } : {}),
    });
    setActiveFile(name);
  };

  return (
    <div className="flex h-full bg-background">
      {/* File list sidebar */}
      <div className="w-44 shrink-0 border-r border-border overflow-y-auto">
        <div className="flex items-center justify-between px-3 py-2 border-b border-border">
          <span className="text-xs font-medium text-muted-foreground">
            {t("studio.codeView.components")}
          </span>
          <button
            onClick={handleAddFile}
            className="hover-surface rounded p-0.5 text-muted-foreground"
            title={t("studio.codeView.addFile") || "Add file"}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>

        {fileNames.map((name) => (
          <button
            key={name}
            onClick={() => setActiveFile(name)}
            className={`flex w-full items-center gap-2 px-3 py-2 text-xs transition-colors ${
              safeActiveFile === name
                ? "active-surface text-foreground"
                : "text-muted-foreground hover-surface"
            }`}
          >
            <FileCode className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate flex-1 text-left font-mono">{name}</span>
            {name === entryFile && (
              <span className="shrink-0 rounded bg-primary/15 px-1 py-0.5 text-[9px] text-primary">
                entry
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Editor */}
      <div className="relative flex flex-1 flex-col overflow-hidden">
        {/* Toolbar */}
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <span className="flex-1 text-xs font-medium font-mono text-foreground">
            {safeActiveFile}
          </span>
          <CompileStatusBadge files={files} entryFile={entryFile} activeFile={safeActiveFile} />
          {/* Bundle files belong to the bundle that installed them. */}
          {!safeActiveFile.startsWith("_bundles/") && (
            <button
              onClick={() => handleRenameFile(safeActiveFile)}
              className="hover-surface rounded p-1 text-muted-foreground hover:text-foreground"
              title={t("studio.codeView.renameComponent")}
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )}
          {safeActiveFile !== entryFile && (
            <button
              onClick={() => {
                if (!window.confirm(t("studio.codeView.confirmDelete"))) return;
                const newFiles = { ...files };
                delete newFiles[safeActiveFile];
                updateRootComponent({ files: newFiles });
                setActiveFile(entryFile);
              }}
              className="hover-surface rounded p-1 text-muted-foreground hover:text-destructive"
              title={t("studio.codeView.deleteComponent")}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* Code textarea */}
        <textarea
          value={activeFileCode}
          onChange={(e) => {
            updateRootComponent({
              files: { ...files, [safeActiveFile]: e.target.value },
            });
          }}
          spellCheck={false}
          className="flex-1 resize-none bg-muted/30 p-4 font-mono text-xs text-foreground focus:outline-none"
          style={{ tabSize: 2 }}
        />
      </div>
    </div>
  );
}

// Every world has rootComponent after v19→v20 migration (phase 3). The old
// customUI[]-based editor was deleted in phase 6 — there's nothing to route
// between anymore.
export function CodeViewPanel(_props: IDockviewPanelProps) {
  return <RootComponentCodeView />;
}
