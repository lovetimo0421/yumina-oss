import { useRef } from "react";
import { FolderOpen, ImagePlus, Loader2, Upload } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

const IMAGE_ACCEPT = "image/jpeg,image/png,image/gif,image/webp";

interface ImageSourceMenuProps {
  /** Files chosen from the computer, already filtered to images. */
  onFiles: (files: File[]) => void;
  /** Open the caller's asset-library picker. */
  onLibrary: () => void;
  uploading?: boolean;
  labels: { button: string; computer: string; library: string };
  /** The trigger's look; each composer keeps its own toolbar styling. */
  className?: string;
  iconClassName?: string;
  menuClassName?: string;
  itemClassName?: string;
}

/**
 * One small image icon for a composer toolbar, the way a mail client does it:
 * clicking it offers "upload from computer" or "choose from assets".
 */
export function ImageSourceMenu({ onFiles, onLibrary, uploading = false, labels, className, iconClassName, menuClassName, itemClassName }: ImageSourceMenuProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={IMAGE_ACCEPT}
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []).filter((file) => file.type.startsWith("image/"));
          e.target.value = "";
          if (files.length) onFiles(files);
        }}
      />
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={uploading}
            title={labels.button}
            aria-label={labels.button}
            onClick={(e) => e.stopPropagation()}
            className={cn("nodrag flex items-center justify-center transition-all disabled:opacity-50", className)}
          >
            {uploading ? <Loader2 className={cn("animate-spin", iconClassName)} /> : <ImagePlus className={iconClassName} />}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className={cn("min-w-44", menuClassName)}>
          <DropdownMenuItem className={itemClassName} onSelect={() => inputRef.current?.click()}>
            <Upload />
            {labels.computer}
          </DropdownMenuItem>
          <DropdownMenuItem className={itemClassName} onSelect={onLibrary}>
            <FolderOpen />
            {labels.library}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
