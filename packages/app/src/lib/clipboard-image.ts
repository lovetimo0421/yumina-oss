/**
 * Collect image `File`s from a paste or drop, checking BOTH places a browser may
 * expose them:
 *
 *  - `data.files` (a FileList) — the reliable path for an image **file copied
 *    from the OS file manager** (Windows Explorer / macOS Finder). There the
 *    matching `items` entry frequently has a blank `.type`, so an items-only
 *    check misses it entirely. This is the same FileList an `<input type="file">`
 *    produces, so paste/drop end up behaving exactly like the file picker.
 *  - `data.items` — needed for **screenshots** and images copied from another
 *    app, where the bitmap is exposed as an item rather than landing in `files`.
 *
 * `getAsFile()` is called synchronously here; callers must invoke this before any
 * `await`, since the underlying clipboard/drag data is neutered afterwards.
 * The two sources usually expose the same payload, so results are de-duped.
 *
 * Works for both `ClipboardEvent.clipboardData` and `DragEvent.dataTransfer`
 * (both are `DataTransfer`).
 */
export function getImageFilesFromTransfer(data: DataTransfer | null | undefined): File[] {
  if (!data) return [];

  const fromItems = Array.from(data.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile());

  const seen = new Set<string>();
  return [...Array.from(data.files ?? []), ...fromItems]
    .filter((file): file is File => file != null && file.type.startsWith("image/"))
    .filter((file) => {
      const key = `${file.name}:${file.size}:${file.lastModified}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
