import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type ComponentPropsWithoutRef, type DragEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Loader2, X } from "lucide-react";
import { MAX_WORLD_DESCRIPTION } from "@yumina/shared";
import { FieldError } from "@/components/ui/field-error";
import { ImageSourceMenu } from "@/components/image-source-menu";
import { resolveImageUrl } from "@/lib/asset-url";
import { cn } from "@/lib/utils";
import { useAssetStore } from "@/stores/assets";
import { useEditorStore } from "@/stores/editor";
import { AssetPicker } from "../asset-picker";
import { DebouncedTextarea } from "./debounced-field";
import {
  createImageTagRegistry,
  imageTag,
  insertBlocks,
  removeStoredImage,
  storedImageIds,
  storedImageMarkdown,
  tagsFor,
  toDisplayText,
  toStoredText,
} from "./description-image-markdown";

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function imageFiles(list: FileList | null | undefined): File[] {
  return Array.from(list ?? []).filter((file) => IMAGE_TYPES.has(file.type));
}

function hasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes("Files");
}

type DescriptionFieldProps = Omit<ComponentPropsWithoutRef<"textarea">, "value" | "onChange"> & {
  value: string;
  onCommit: (next: string) => void;
  maxLength?: number;
  /** Passed through to the debounced field (see DebouncedTextarea). */
  syncKey?: string;
  /** The canvas card's inline blurb: tags, paste and drop, and a small icon
   *  under the box; the card has no room for the toolbar and thumbnails. */
  compact?: boolean;
};

/**
 * The card description box, with pictures, laid out like the community
 * composer: an image icon in a toolbar above the box (upload from the
 * computer or choose from assets), plus drop and paste. An upload goes to the
 * card's own assets, and each picture lands at the caret as `[Image 1]`,
 * stored as the `![](@asset:id)` markdown Discover already renders. Added
 * pictures show as thumbnails below with a remove button, so a creator coming
 * from other platforms can lay out a picture-per-character bio without
 * touching markdown.
 */
export function DescriptionField({ value, onCommit, maxLength = MAX_WORLD_DESCRIPTION, compact = false, syncKey, className, ...rest }: DescriptionFieldProps) {
  const { t } = useTranslation("editor");
  const label = t("overview.descriptionImageLabel");
  const serverWorldId = useEditorStore((s) => s.serverWorldId);
  const canUpload = useEditorStore((s) => !s.guestMode && !s.readOnlyInspect);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const registryRef = useRef(createImageTagRegistry());
  // A box nobody has clicked into reports its caret at 0; an added picture
  // then belongs at the end, not above the creator's opening line.
  const touchedRef = useRef(false);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resync, setResync] = useState(0);
  const [pickerWorldId, setPickerWorldId] = useState<string | null>(null);

  const registry = registryRef.current;
  const display = toDisplayText(value, registry, label);
  const imageIds = useMemo(() => storedImageIds(value), [value]);
  // The box counts what it shows; the limit is on what is stored, and every
  // tag stands in for a longer reference.
  const tagSavings = imageIds.reduce(
    (sum, id) => sum + storedImageMarkdown(id).length - imageTag(label, registry.byId.get(id) ?? 0).length,
    0,
  );

  const commitDisplay = (next: string) => onCommit(toStoredText(next, registry, label));

  // A focused box ignores store changes so typing isn't yanked; an inserted
  // or removed picture must still show, so the box is told to take the new
  // text. On the canvas the new value reaches this field a render or more
  // after the commit, so it is told again once that value has arrived.
  const awaitingRef = useRef<string | null>(null);
  const commitAndResync = (stored: string) => {
    awaitingRef.current = stored;
    onCommit(stored);
    setResync((n) => n + 1);
  };
  useEffect(() => {
    if (awaitingRef.current === null || value !== awaitingRef.current) return;
    awaitingRef.current = null;
    setResync((n) => n + 1);
  }, [value]);

  const ensureWorldId = async (): Promise<string | null> => {
    let id = serverWorldId;
    if (!id) {
      await useEditorStore.getState().saveDraft();
      id = useEditorStore.getState().serverWorldId;
    }
    if (!id) setError(t("overview.descriptionImageNeedsSave"));
    return id;
  };

  const insertImages = (ids: string[]) => {
    if (!ids.length) return;
    // Read the box itself, not the store: it holds whatever was typed during
    // the upload that the debounce hasn't committed yet. (Saving a new card
    // can remount the field, so look it up now rather than before.)
    const textarea = wrapperRef.current?.querySelector("textarea");
    const current = textarea?.value ?? toDisplayText(useEditorStore.getState().worldDraft.description ?? "", registry, label);
    const useCaret = textarea && touchedRef.current;
    const start = useCaret ? textarea.selectionStart : current.length;
    const end = useCaret ? textarea.selectionEnd : current.length;
    const next = insertBlocks(current, start, end, tagsFor(ids, registry, label));
    const stored = toStoredText(next.text, registry, label);
    if (stored.length > maxLength) {
      setError(t("overview.descriptionImageTooLong"));
      return;
    }
    commitAndResync(stored);
    requestAnimationFrame(() => {
      if (textarea && document.activeElement === textarea) textarea.setSelectionRange(next.caret, next.caret);
    });
  };

  const upload = async (files: File[]) => {
    if (!files.length || uploading) return;
    setError(null);
    setUploading(true);
    try {
      const id = await ensureWorldId();
      if (!id) return;
      const ids: string[] = [];
      for (const file of files) {
        // The store reports its own failures; a failed file is just skipped.
        const asset = await useAssetStore.getState().uploadAsset(id, file, "image");
        if (asset) ids.push(asset.id);
      }
      insertImages(ids);
    } finally {
      setUploading(false);
    }
  };

  const openLibrary = async () => {
    setError(null);
    const id = await ensureWorldId();
    if (id) setPickerWorldId(id);
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = imageFiles(e.clipboardData?.files);
    if (!files.length) return;
    e.preventDefault();
    touchedRef.current = true;
    void upload(files);
  };

  const dropHandlers = {
    onDragOver: (e: DragEvent<HTMLDivElement>) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      // The canvas takes dropped files as new assets; this box keeps its own.
      e.stopPropagation();
      setDragging(true);
    },
    onDragLeave: (e: DragEvent<HTMLDivElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
    },
    onDrop: (e: DragEvent<HTMLDivElement>) => {
      setDragging(false);
      if (!hasFiles(e)) return;
      // Any dropped file, image or not, would otherwise open in the tab.
      e.preventDefault();
      e.stopPropagation();
      void upload(imageFiles(e.dataTransfer.files));
    },
  };

  if (!canUpload) {
    return <DebouncedTextarea {...rest} syncKey={syncKey} value={value} onCommit={onCommit} maxLength={maxLength} className={className} />;
  }

  const textarea = (
    <DebouncedTextarea
      {...rest}
      syncKey={syncKey}
      value={display}
      onCommit={commitDisplay}
      forceSyncKey={resync}
      maxLength={maxLength - tagSavings}
      onFocus={(e) => { touchedRef.current = true; rest.onFocus?.(e); }}
      onPaste={onPaste}
      className={cn(className, dragging && "ring-1 ring-primary")}
    />
  );

  const menuLabels = {
    button: t("overview.descriptionInsertImage"),
    computer: t("overview.descriptionImageFromComputer"),
    library: t("overview.descriptionImageFromAssets"),
  };

  // Portalled: inside a canvas node a fixed overlay would be placed relative
  // to the zoomed board, not the window.
  const picker = pickerWorldId && createPortal(
    <AssetPicker
      mediaUsage="public"
      worldId={pickerWorldId}
      filterType="image"
      onSelect={(ref) => {
        setPickerWorldId(null);
        const match = /^@asset:(.+)$/.exec(ref);
        if (match) insertImages([match[1]!]);
      }}
      onClose={() => setPickerWorldId(null)}
    />,
    document.body,
  );

  const menu = (small: boolean) => (
    <ImageSourceMenu
      onFiles={(files) => void upload(files)}
      onLibrary={() => void openLibrary()}
      uploading={uploading}
      labels={menuLabels}
      className={small
        ? "h-5 w-5 rounded text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
        : "h-8 w-8 rounded-lg text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"}
      iconClassName={small ? "h-3.5 w-3.5" : "h-4 w-4"}
    />
  );

  if (compact) {
    return (
      <div ref={wrapperRef} {...dropHandlers} className="flex min-h-0 flex-1 flex-col">
        {textarea}
        <div className="mt-0.5 flex items-center">{menu(true)}</div>
        {error && <p role="alert" className="mt-0.5 text-[10px] text-destructive/85">{error}</p>}
        {picker}
      </div>
    );
  }

  return (
    <div ref={wrapperRef} {...dropHandlers}>
      {/* Toolbar above the box, as in the community composer. */}
      <div className="mb-2 flex items-center gap-1 border-b border-border/60 pb-1.5">
        {menu(false)}
      </div>

      {textarea}

      {imageIds.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {imageIds.map((id) => (
            <div key={id} className="group relative">
              <img
                src={resolveImageUrl(`@asset:${id}`)}
                alt={imageTag(label, registry.byId.get(id) ?? 0)}
                title={imageTag(label, registry.byId.get(id) ?? 0)}
                loading="lazy"
                className="h-16 w-16 rounded-lg border border-border object-cover"
              />
              <button
                type="button"
                onClick={() => commitAndResync(removeStoredImage(value, id))}
                aria-label={t("overview.descriptionImageRemove")}
                className="touch-reveal absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full bg-background/90 text-muted-foreground opacity-0 shadow-sm transition-opacity hover:text-foreground group-hover:opacity-100"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {uploading && (
        <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t("overview.descriptionImageUploading")}
        </div>
      )}

      <FieldError message={error} />
    </div>
  );
}
