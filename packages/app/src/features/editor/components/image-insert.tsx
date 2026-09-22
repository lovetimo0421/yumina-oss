import { useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen, ImagePlus, Upload } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { feedback } from "@/lib/feedback";
import { cn } from "@/lib/utils";
import { useEditorStore } from "@/stores/editor";
import { useAssetStore } from "@/stores/assets";
import { AssetPicker } from "../asset-picker";

/**
 * Put text at the caret of a textarea the way typing would: through the native
 * value setter plus an input event, so the controlled field (and the debounced
 * commit behind it) sees an edit, not a prop change, and the caret lands after
 * what was inserted.
 */
export function insertAtCaret(el: HTMLTextAreaElement, text: string): void {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;
  const before = el.value.slice(0, start);
  const after = el.value.slice(end);
  // A picture sits on a line of its own; pad only where a line break is missing.
  const lead = before.length === 0 || before.endsWith("\n") ? "" : "\n";
  const trail = after.length === 0 || after.startsWith("\n") ? "" : "\n";
  const insert = `${lead}${text}${trail}`;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(el, before + insert + after);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  const caret = start + insert.length;
  el.focus();
  el.setSelectionRange(caret, caret);
}

/** The shared `[image:…]` embed for a library asset or URL. */
export function imageEmbedTag(ref: string, alt?: string): string {
  const clean = (alt ?? "").replace(/[|\]\n]/g, " ").trim();
  return clean ? `[image:${ref}|alt=${clean}]` : `[image:${ref}]`;
}

export interface ImageInsert {
  busy: boolean;
  dragOver: boolean;
  /** Spread onto the textarea: drop a file or paste a picture to add it here. */
  dropProps: {
    onDragOver: (e: DragEvent<HTMLTextAreaElement>) => void;
    onDragLeave: () => void;
    onDrop: (e: DragEvent<HTMLTextAreaElement>) => void;
    onPaste: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
  };
  /** The hidden file input and the library modal — render once near the field. */
  overlays: ReactNode;
  openFiles: () => void;
  openLibrary: () => Promise<void>;
}

/**
 * Everything a text field needs to take pictures like a mail composer does:
 * a toolbar button (upload from the computer, or pick from the world's
 * assets), drag-and-drop, and paste. Files go through the world asset
 * library and land in the text as `[image:@asset:…]` at the caret.
 */
export function useImageInsert(getTextarea: () => HTMLTextAreaElement | null): ImageInsert {
  const { t } = useTranslation("editor");
  const uploadAsset = useAssetStore((s) => s.uploadAsset);
  const serverWorldId = useEditorStore((s) => s.serverWorldId);
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const ensureWorldId = async (): Promise<string | null> => {
    const store = useEditorStore.getState;
    if (store().serverWorldId) return store().serverWorldId;
    await store().saveDraft();
    return store().serverWorldId;
  };

  const insertRef = (ref: string, alt?: string) => {
    const el = getTextarea();
    if (!el) return;
    insertAtCaret(el, imageEmbedTag(ref, alt));
  };

  const insertFiles = async (files: FileList | File[]) => {
    const list = [...files].filter((f) => f.type.startsWith("image/"));
    if (list.length === 0) return;
    const worldId = await ensureWorldId();
    if (!worldId) return;
    setBusy(true);
    try {
      for (const file of list) {
        const asset = await uploadAsset(worldId, file, "image");
        if (!asset) {
          feedback.error(t("imageInsert.failed", { name: file.name }));
          continue;
        }
        insertRef(`@asset:${asset.id}`, file.name.replace(/\.[^.]+$/, ""));
      }
    } finally {
      setBusy(false);
    }
  };

  const openLibrary = async () => {
    if (!(await ensureWorldId())) return;
    setPicker(true);
  };

  const dropProps: ImageInsert["dropProps"] = {
    onDragOver: (e) => {
      if (![...e.dataTransfer.types].includes("Files")) return;
      e.preventDefault();
      setDragOver(true);
    },
    onDragLeave: () => setDragOver(false),
    onDrop: (e) => {
      if (!e.dataTransfer.files?.length) return;
      e.preventDefault();
      setDragOver(false);
      void insertFiles(e.dataTransfer.files);
    },
    onPaste: (e) => {
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
      if (files.length === 0) return;
      e.preventDefault();
      void insertFiles(files);
    },
  };

  const overlays = (
    <>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) void insertFiles(e.target.files);
          e.target.value = "";
        }}
      />
      {picker && serverWorldId && (
        <AssetPicker
          worldId={serverWorldId}
          filterType="image"
          onSelect={(ref) => {
            insertRef(ref);
            setPicker(false);
          }}
          onClose={() => setPicker(false)}
        />
      )}
    </>
  );

  return { busy, dragOver, dropProps, overlays, openFiles: () => fileRef.current?.click(), openLibrary };
}

/** The toolbar button: one click, then upload or pick from assets. */
export function ImageInsertButton({ insert, className }: { insert: ImageInsert; className?: string }) {
  const { t } = useTranslation("editor");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={insert.busy}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50",
            className,
          )}
        >
          <ImagePlus className="h-3.5 w-3.5" />
          {insert.busy ? t("imageInsert.uploading") : t("imageInsert.button")}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onClick={insert.openFiles}>
          <Upload className="mr-2 h-4 w-4" />
          {t("imageInsert.upload")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void insert.openLibrary()}>
          <FolderOpen className="mr-2 h-4 w-4" />
          {t("imageInsert.library")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
