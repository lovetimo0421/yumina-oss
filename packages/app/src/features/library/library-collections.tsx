import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, FolderPlus, Loader2, Plus, Search } from "lucide-react";
import { LIBRARY_COLLECTION_NAME_MAX } from "@yumina/shared";
import { useLibraryStore, type CollectionWriteError, type LibraryCollection, type LibraryItem } from "@/stores/library";
import { useBlurSensitive } from "@/hooks/use-blur-sensitive";
import { useContentLevel } from "@/hooks/use-content-level";
import { CroppedImage } from "@/lib/cover-crop";
import { feedback } from "@/lib/feedback";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

/** The library row behind a detail panel: the card may be any language sibling. */
export function useLibraryRow(worldId: string): LibraryItem | undefined {
  return useLibraryStore((s) =>
    s.items.find((i) => i.worldId === worldId || (i.siblingWorldIds?.includes(worldId) ?? false)),
  );
}

/** The player's collections, fetched once per visit to a page that shows them. */
export function useLibraryCollections(): LibraryCollection[] {
  const collections = useLibraryStore((s) => s.collections);
  const fetchCollections = useLibraryStore((s) => s.fetchCollections);
  useEffect(() => { void fetchCollections(); }, [fetchCollections]);
  return collections;
}

/** What the collection dialog is doing: making one (with these games ticked
 *  to start) or editing an existing one. */
export type CollectionEditorTarget =
  | { kind: "new"; worldIds: string[] }
  | { kind: "edit"; id: string; name: string };

/** Name a collection and tick its games, in one place. Creating one is a
 *  single step: name it, pick the games, done. */
export function CollectionEditorDialog({ target, onClose, onCreated }: {
  target: CollectionEditorTarget | null;
  onClose: () => void;
  onCreated?: (collection: LibraryCollection) => void;
}) {
  const { t } = useTranslation("library");
  const items = useLibraryStore((s) => s.items);
  const hasMore = useLibraryStore((s) => s.hasMore);
  const fetchAll = useLibraryStore((s) => s.fetchAll);
  const createCollection = useLibraryStore((s) => s.createCollection);
  const updateCollection = useLibraryStore((s) => s.updateCollection);
  const collections = useLibraryStore((s) => s.collections);
  const contentLevel = useContentLevel();
  const blurSensitive = useBlurSensitive();
  const open = !!target;

  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [initial, setInitial] = useState<Set<string>>(new Set());
  const [error, setError] = useState<CollectionWriteError | null>(null);
  const [busy, setBusy] = useState(false);

  // The whole library, not just the pages loaded so far.
  useEffect(() => { if (open) void fetchAll(); }, [open, fetchAll]);

  // Hidden games stay out of the picker (their memberships are left alone).
  const games = useMemo(
    () => items.filter((i) => i.shelf !== "hidden" && (contentLevel !== "safe" || !i.worldIsNsfw)),
    [items, contentLevel],
  );

  useEffect(() => {
    if (!target) return;
    const start = target.kind === "new"
      ? new Set(items.filter((i) => target.worldIds.some((w) => w === i.worldId || i.siblingWorldIds?.includes(w))).map((i) => i.worldId))
      : new Set(items.filter((i) => i.collectionIds?.includes(target.id)).map((i) => i.worldId));
    setName(target.kind === "edit" ? target.name : "");
    setQuery("");
    setPicked(start);
    setInitial(start);
    setError(null);
    // Seed once per opening; later pages arriving must not reset the ticks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  // A game in this collection that arrives with a later page starts ticked.
  useEffect(() => {
    if (target?.kind !== "edit") return;
    const late = items.filter((i) => i.collectionIds?.includes(target.id) && !initial.has(i.worldId));
    if (late.length === 0) return;
    setInitial((s) => new Set([...s, ...late.map((i) => i.worldId)]));
    setPicked((s) => new Set([...s, ...late.map((i) => i.worldId)]));
  }, [items, target, initial]);

  const q = query.trim().toLowerCase();
  const shown = q ? games.filter((g) => g.worldName.toLowerCase().includes(q)) : games;
  const trimmed = name.replace(/\s+/g, " ").trim();
  const isEdit = target?.kind === "edit";
  // A blank name is fine: a new collection becomes "Untitled collection" (then
  // "… 2", "… 3"), an edited one keeps the name it had.
  const untitled = useMemo(() => {
    const base = t("collections.untitled");
    const taken = new Set(collections.map((c) => c.name.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    let n = 2;
    while (taken.has(`${base} ${n}`.toLowerCase())) n += 1;
    return `${base} ${n}`;
  }, [collections, t]);
  const placeholderName = target?.kind === "edit" ? target.name : untitled;
  const finalName = trimmed || placeholderName;
  const pickedGames = useMemo(() => games.filter((g) => picked.has(g.worldId)), [games, picked]);

  const toggle = (worldId: string) => setPicked((s) => {
    const next = new Set(s);
    if (next.has(worldId)) next.delete(worldId); else next.add(worldId);
    return next;
  });

  const save = async () => {
    if (!target || busy) return;
    setBusy(true);
    let result: true | CollectionWriteError;
    if (target.kind === "new") {
      const created = await createCollection(finalName, [...picked]);
      result = typeof created === "string" ? created : true;
      if (typeof created !== "string") onCreated?.(created);
    } else {
      result = await updateCollection(target.id, {
        ...(finalName !== target.name ? { name: finalName } : {}),
        add: [...picked].filter((id) => !initial.has(id)),
        remove: [...initial].filter((id) => !picked.has(id)),
      });
    }
    setBusy(false);
    if (result === true) onClose();
    else setError(result);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      <DialogContent mobileSheet className="library-collection-editor flex max-h-[min(88dvh,780px)] flex-col gap-0 overflow-hidden rounded-t-2xl border-amber-200/20 bg-gradient-to-b from-amber-50/[0.04] via-amber-100/[0.02] to-card p-0 backdrop-blur-xl sm:max-w-2xl sm:rounded-2xl">
        <form className="flex min-h-0 flex-1 flex-col" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <DialogHeader className="flex shrink-0 flex-row items-center gap-2.5 space-y-0 border-b border-amber-200/10 bg-gradient-to-r from-amber-500/[0.03] to-transparent py-4 pl-6 pr-14 text-left">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-500/10">
              <FolderPlus className="h-4 w-4 text-amber-400" aria-hidden="true" />
            </span>
            <DialogTitle className="text-[15px] font-bold text-foreground">
              {isEdit ? t("collections.edit") : t("collections.new")}
            </DialogTitle>
          </DialogHeader>

          <div className="shrink-0 px-6 pt-5">
            <label htmlFor="collection-name" className="mb-2 block text-[13px] font-medium text-muted-foreground">
              {t("collections.namePlaceholder")}
            </label>
            <input
              id="collection-name"
              autoFocus={!isEdit}
              value={name}
              maxLength={LIBRARY_COLLECTION_NAME_MAX}
              onChange={(e) => { setName(e.target.value); setError(null); }}
              placeholder={placeholderName}
              aria-invalid={!!error}
              enterKeyHint="done"
              className="h-11 w-full rounded-lg border border-amber-200/20 bg-amber-100/[0.045] px-3 text-base font-semibold text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] placeholder:font-medium placeholder:text-amber-100/35 focus:border-gold/55 focus:bg-amber-100/[0.065] focus:outline-none focus:ring-1 focus:ring-gold/25 sm:text-[15px]"
            />
            {error && <p role="alert" className="mt-1.5 text-[11px] text-destructive/80">{t(`collections.error.${error}`)}</p>}
          </div>

          <div className="flex shrink-0 items-center justify-between gap-3 px-6 pb-3 pt-5">
            <span className="text-[13px] font-medium text-muted-foreground">
              {t("collections.games")} <span className="tabular-nums text-muted-foreground/60">{games.length}</span>
            </span>
            {games.length > 8 && (
              <label className="relative block w-[min(220px,55%)]">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-amber-100/40" aria-hidden="true" />
                <input
                  id="collection-games-search"
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t("collections.searchGames")}
                  aria-label={t("collections.searchGames")}
                  className="library-collection-search h-8 w-full rounded-full border border-amber-200/15 bg-amber-100/[0.03] pl-8 pr-3 text-base text-foreground placeholder:text-amber-100/35 focus:border-gold/45 focus:outline-none sm:text-[12.5px]"
                />
              </label>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pb-5 pt-1">
            <div className="library-collection-picker" role="group" aria-label={t("collections.games")}>
              {shown.map((g) => {
                const on = picked.has(g.worldId);
                return (
                  <button key={g.worldId} type="button" aria-pressed={on} onClick={() => toggle(g.worldId)}
                    className={cn("library-collection-pick group relative flex flex-col overflow-hidden rounded-xl border text-left transition-all duration-150",
                      on ? "is-on border-primary/50 ring-1 ring-primary/30" : "border-border hover:border-primary/40")}>
                    <span className="relative block aspect-[3/4] w-full overflow-hidden bg-accent">
                      {g.worldThumbnailUrl && (
                        <CroppedImage src={g.worldThumbnailUrl} alt="" crop={g.worldCoverCrop ?? null} width={240}
                          className={cn("absolute inset-0 h-full w-full transition-transform duration-200 group-hover:scale-105", blurSensitive && g.worldIsNsfw && "blur-lg")} />
                      )}
                      <span className="library-collection-pick__tick">
                        <Check className="h-3.5 w-3.5" strokeWidth={3} aria-hidden="true" />
                      </span>
                    </span>
                    <span className={cn("block truncate px-2 py-1.5 text-[12px] font-medium", on ? "text-foreground" : "text-muted-foreground group-hover:text-foreground")}>
                      {g.worldName}
                    </span>
                  </button>
                );
              })}
            </div>
            {q && shown.length === 0 && (
              <p className="py-10 text-center text-sm text-muted-foreground">{t("collections.noMatch")}</p>
            )}
            {hasMore && <div className="flex justify-center py-4"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" /></div>}
          </div>

          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-amber-200/10 bg-amber-500/[0.02] px-6 py-4">
            <div className="flex min-w-0 items-center gap-2.5">
              {pickedGames.length > 0 && (
                <span className="library-collection-editor__stack" aria-hidden="true">
                  {pickedGames.slice(0, 4).map((g) => (
                    <span key={g.worldId}>
                      {g.worldThumbnailUrl && (
                        <CroppedImage src={g.worldThumbnailUrl} alt="" crop={g.worldCoverCrop ?? null} width={64}
                          className={cn("h-full w-full", blurSensitive && g.worldIsNsfw && "blur-sm")} />
                      )}
                    </span>
                  ))}
                </span>
              )}
              <span className="truncate text-xs tabular-nums text-muted-foreground">{t("collections.picked", { count: picked.size })}</span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button type="button" onClick={onClose} disabled={busy}
                className="h-10 rounded-xl border border-amber-200/25 bg-amber-100/[0.045] px-4 text-[13px] font-medium text-amber-100/90 transition-colors hover:bg-amber-100/[0.08] hover:text-foreground">
                {t("dialog.cancel")}
              </button>
              <button type="submit" disabled={busy}
                className="inline-flex h-10 items-center gap-2 rounded-xl bg-primary px-5 text-[13px] font-medium text-primary-foreground shadow-lg shadow-amber-500/15 transition-colors hover:bg-primary-hover disabled:opacity-50">
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                {isEdit ? t("collections.save") : t("collections.create")}
              </button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** One row per collection with a tick for the ones that apply, then "New
 *  collection". Rows keep the menu open so several can be ticked in a go. */
export function CollectionMenuItems({ collections, checked, onPick, onNew, keepOpen = true }: {
  collections: LibraryCollection[];
  checked?: ReadonlySet<string>;
  onPick: (collection: LibraryCollection) => void;
  onNew: () => void;
  keepOpen?: boolean;
}) {
  const { t } = useTranslation("library");
  return (
    <>
      {collections.map((c) => (
        <DropdownMenuItem key={c.id}
          onSelect={(e) => { if (keepOpen) e.preventDefault(); onPick(c); }}
          className="gap-2.5">
          {checked && <Check className={cn("h-4 w-4", checked.has(c.id) ? "text-primary" : "opacity-0")} aria-hidden="true" />}
          <span className="min-w-0 truncate">{c.name}</span>
        </DropdownMenuItem>
      ))}
      {collections.length > 0 && <DropdownMenuSeparator />}
      <DropdownMenuItem onSelect={onNew} className="gap-2.5">
        <Plus className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        {t("collections.new")}
      </DropdownMenuItem>
    </>
  );
}

/** The collections one game is in, on its page: the names, and a menu to tick
 *  collections or start a new one with this game in it. */
export function LibraryCollectionsPicker({ row, className }: { row: LibraryItem; className?: string }) {
  const { t } = useTranslation("library");
  const collections = useLibraryCollections();
  const setGameCollections = useLibraryStore((s) => s.setGameCollections);
  const [editor, setEditor] = useState<CollectionEditorTarget | null>(null);

  const mine = new Set(row.collectionIds ?? []);
  const inNames = collections.filter((c) => mine.has(c.id));

  const toggle = async (c: LibraryCollection) => {
    const next = mine.has(c.id) ? [...mine].filter((id) => id !== c.id) : [...mine, c.id];
    if (!(await setGameCollections(row.worldId, next))) feedback.error(t("collections.error.failed"));
  };

  return (
    <div className={cn("library-filter-chips library-collections-picker", className)}>
      {inNames.map((c) => (
        <span key={c.id} className="library-filter-chip library-collection-tag">{c.name}</span>
      ))}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className="library-filter-chip inline-flex items-center gap-1"
            aria-label={t("collections.addTo")} title={t("collections.addTo")}>
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            {inNames.length === 0 && t("collections.addTo")}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" sideOffset={6} className="min-w-48 max-w-72">
          <CollectionMenuItems collections={collections} checked={mine} onPick={(c) => void toggle(c)}
            onNew={() => setEditor({ kind: "new", worldIds: [row.worldId] })} />
        </DropdownMenuContent>
      </DropdownMenu>
      <CollectionEditorDialog target={editor} onClose={() => setEditor(null)} />
    </div>
  );
}
