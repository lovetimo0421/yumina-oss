import { useTranslation } from "react-i18next";
import { FileCode2 } from "lucide-react";
import type { FrontendFileFacts } from "@yumina/engine";
import { cn } from "@/lib/utils";
import { BLOCK_BODY_PAD, PLAIN_ROW_H } from "./board";

/** Files the strip lists before folding the rest behind one line. */
export const FRONTEND_FILE_ROWS = 5;

/** Rows the strip takes, for the board's height model: a header line, up
 *  to FRONTEND_FILE_ROWS files, and one "N more" line when they overflow. */
export function frontendFileRowCount(fileCount: number): number {
  if (fileCount <= 0) return 0;
  return 1 + Math.min(fileCount, FRONTEND_FILE_ROWS) + (fileCount > FRONTEND_FILE_ROWS ? 1 : 0);
}

export function frontendFilesStripHeight(fileCount: number): number {
  const rows = frontendFileRowCount(fileCount);
  return rows === 0 ? 0 : BLOCK_BODY_PAD * 2 + rows * PLAIN_ROW_H;
}

const chip = "shrink-0 rounded px-1.5 text-[10px] font-semibold leading-[16px]";

/**
 * What the interface's code does, file by file, under the live phone.
 *
 * A coded card used to be a phone on the canvas and nothing else; its logic
 * — the files, what each reads and writes, which ones ask the AI — was
 * somewhere behind a button. These rows are that logic, in the open. Each
 * row is a canvas object (`file:<name>`): a sticky note sticks to it, a click
 * opens the file, and the assistant reads the same list.
 */
export function FrontendFilesStrip({ files, entryFile, aiCalls, onOpenFile }: {
  files: FrontendFileFacts[];
  entryFile?: string;
  aiCalls: number;
  onOpenFile?: (file: string, line: number) => void;
}) {
  const { t } = useTranslation("editor");
  if (files.length === 0) return null;
  const shown = files.slice(0, FRONTEND_FILE_ROWS);
  const more = files.length - shown.length;
  const reads = new Set(files.flatMap((f) => f.reads)).size;
  const writes = new Set(files.flatMap((f) => f.writes)).size;
  const lines = files.reduce((n, f) => n + f.lines, 0);
  return (
    <div data-frontend-files="" className="border-t border-white/[0.06]" style={{ paddingBlock: BLOCK_BODY_PAD }}>
      <div className="flex items-center gap-2 px-2.5 text-[11px] text-muted-foreground" style={{ height: PLAIN_ROW_H }}>
        <FileCode2 className="h-3.5 w-3.5 shrink-0 text-rose-300" />
        <span className="min-w-0 truncate">
          {t("blueprint.files.summary", { files: files.length, lines })}
          {reads > 0 && ` · ${t("blueprint.files.reads", { count: reads })}`}
          {writes > 0 && ` · ${t("blueprint.files.writes", { count: writes })}`}
          {aiCalls > 0 && ` · ${t("blueprint.files.aiCalls", { count: aiCalls })}`}
        </span>
      </div>
      {shown.map((f) => (
        <div
          key={f.file}
          data-row-anchor={`file:${f.file}`}
          role={onOpenFile ? "button" : undefined}
          tabIndex={onOpenFile ? 0 : undefined}
          onClick={onOpenFile ? (e) => { e.stopPropagation(); onOpenFile(f.file, 1); } : undefined}
          onKeyDown={onOpenFile ? (e) => { if (e.key === "Enter") { e.stopPropagation(); onOpenFile(f.file, 1); } } : undefined}
          title={[
            f.reads.length ? t("blueprint.files.readsList", { names: f.reads.join(", ") }) : "",
            f.writes.length ? t("blueprint.files.writesList", { names: f.writes.join(", ") }) : "",
            f.uses.length ? t("blueprint.files.usesList", { names: f.uses.map((u) => t(`blueprint.files.use_${u}`)).join(", ") }) : "",
          ].filter(Boolean).join("\n")}
          className={cn("nodrag flex items-center gap-2 px-2.5 text-left", onOpenFile && "cursor-pointer hover:bg-white/[0.06]")}
          style={{ height: PLAIN_ROW_H }}
        >
          <span className={cn("min-w-0 truncate font-mono text-[11.5px]", f.file === entryFile ? "text-foreground/90" : "text-foreground/75")}>{f.file}</span>
          <span className="shrink-0 text-[10px] text-muted-foreground/70">{t("blueprint.files.lines", { count: f.lines })}</span>
          <span className="flex-1" />
          {f.reads.length > 0 && <span className={cn(chip, "bg-sky-400/15 text-sky-200")}>{t("blueprint.files.chipReads", { count: f.reads.length })}</span>}
          {f.writes.length > 0 && <span className={cn(chip, "bg-amber-400/15 text-amber-200")}>{t("blueprint.files.chipWrites", { count: f.writes.length })}</span>}
          {f.aiCalls.length > 0 && <span className={cn(chip, "bg-violet-400/15 text-violet-200")}>{t("blueprint.files.chipAi", { count: f.aiCalls.length })}</span>}
          {f.uses.filter((u) => u !== "ai").slice(0, 2).map((u) => (
            <span key={u} className={cn(chip, "bg-white/[0.08] text-foreground/70")}>{t(`blueprint.files.use_${u}`)}</span>
          ))}
        </div>
      ))}
      {more > 0 && (
        <div className="flex items-center px-2.5 text-[11px] text-muted-foreground/70" style={{ height: PLAIN_ROW_H }}>
          {t("blueprint.files.more", { count: more })}
        </div>
      )}
    </div>
  );
}
