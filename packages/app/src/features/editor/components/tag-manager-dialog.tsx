import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Pencil, Trash2, Check, X, Palette, Sparkles } from "lucide-react";
import { feedback } from "@/lib/feedback";
import { FieldError } from "@/components/ui/field-error";
import { cn } from "@/lib/utils";
import { useEditorStore } from "@/stores/editor";
import { DEFAULT_TAGS, TAG_COLOR_PALETTE, getTagColor, getTagLabel } from "@/lib/entry-constants";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
} from "@/components/ui/dropdown-menu";

interface TagManagerDialogProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Centralized tag CRUD: create, rename, delete custom tags.
 * Default tags are read-only (engine relies on them for prompt assembly).
 * Each tag row shows its usage count across entries.
 */
export function TagManagerDialog({ open, onClose }: TagManagerDialogProps) {
  const { t } = useTranslation("editor");
  const worldDraft = useEditorStore((s) => s.worldDraft);
  const addCustomTag = useEditorStore((s) => s.addCustomTag);
  const removeCustomTag = useEditorStore((s) => s.removeCustomTag);
  const renameCustomTag = useEditorStore((s) => s.renameCustomTag);
  const setCustomTagColor = useEditorStore((s) => s.setCustomTagColor);
  const updateEntry = useEditorStore((s) => s.updateEntry);

  const [newTagName, setNewTagName] = useState("");
  const [newTagError, setNewTagError] = useState<string | null>(null);
  const [editingTag, setEditingTag] = useState<string | null>(null);
  const [editingTagName, setEditingTagName] = useState("");
  const [editingTagError, setEditingTagError] = useState<string | null>(null);

  const customTags = worldDraft.customTags ?? [];
  const customTagColors = worldDraft.customTagColors;

  // Aggregate counts and any orphan tags found on entries
  const { tagCounts, allTags } = useMemo(() => {
    const counts: Record<string, number> = {};
    const seen = new Set<string>();
    for (const entry of worldDraft.entries) {
      for (const tag of entry.tags ?? []) {
        counts[tag] = (counts[tag] || 0) + 1;
        seen.add(tag);
      }
    }
    const known = new Set([...DEFAULT_TAGS, ...customTags]);
    const orphans = [...seen].filter((tag) => !known.has(tag));
    return {
      tagCounts: counts,
      allTags: [
        ...DEFAULT_TAGS.map((tag) => ({ tag, kind: "default" as const })),
        ...customTags.map((tag) => ({ tag, kind: "custom" as const })),
        ...orphans.map((tag) => ({ tag, kind: "orphan" as const })),
      ],
    };
  }, [worldDraft.entries, customTags]);

  const handleCreate = () => {
    const name = newTagName.trim();
    if (!name) return;
    const known = new Set([...DEFAULT_TAGS, ...customTags]);
    if (known.has(name)) {
      setNewTagError(t("entries.tagAlreadyExists"));
      return;
    }
    // The new tag appears in the list above the input — no confirmation needed.
    addCustomTag(name);
    setNewTagName("");
    setNewTagError(null);
  };

  /** Re-create a tag exactly as it was, including its colour and entry assignments. */
  const restoreTag = (tag: string, color: string | null, entryIds: string[]) => {
    addCustomTag(tag);
    if (color) setCustomTagColor(tag, color);
    const entries = useEditorStore.getState().worldDraft.entries;
    for (const id of entryIds) {
      const entry = entries.find((e) => e.id === id);
      if (entry && !entry.tags?.includes(tag)) {
        updateEntry(id, { tags: [...(entry.tags ?? []), tag] });
      }
    }
  };

  const handleDelete = (tag: string) => {
    const draft = useEditorStore.getState().worldDraft;
    const color = draft.customTagColors?.[tag] ?? null;
    const entryIds = draft.entries.filter((e) => e.tags?.includes(tag)).map((e) => e.id);
    removeCustomTag(tag);
    feedback.undo(t("entries.tagManager.deletedPill"), () => restoreTag(tag, color, entryIds));
  };

  // List of custom tags currently not assigned to any entry — candidates for cleanup.
  const unusedCustomTags = useMemo(
    () => customTags.filter((tag) => (tagCounts[tag] ?? 0) === 0),
    [customTags, tagCounts]
  );

  const handleCleanupUnused = () => {
    if (unusedCustomTags.length === 0) return;
    // Unused by definition: no entry carries them, so only colours need restoring.
    const removed = unusedCustomTags.map((tag) => ({
      tag,
      color: customTagColors?.[tag] ?? null,
    }));
    for (const { tag } of removed) removeCustomTag(tag);
    feedback.undo(
      t("entries.tagManager.cleanedUp", { count: removed.length }),
      () => {
        for (const { tag, color } of removed) restoreTag(tag, color, []);
      }
    );
  };

  const cancelRename = () => {
    setEditingTag(null);
    setEditingTagError(null);
  };

  const handleCommitRename = (oldName: string) => {
    const trimmed = editingTagName.trim();
    if (!trimmed || trimmed === oldName) {
      cancelRename();
      return;
    }
    const known = new Set([...DEFAULT_TAGS, ...customTags]);
    if (known.has(trimmed)) {
      setEditingTagError(t("entries.tagAlreadyExists"));
      return;
    }
    // The row re-renders under the new name — that is the confirmation.
    renameCustomTag(oldName, trimmed);
    cancelRename();
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("entries.tagManager.title")}</DialogTitle>
          <DialogDescription>{t("entries.tagManager.description")}</DialogDescription>
        </DialogHeader>

        <div className="mt-2 max-h-[420px] space-y-1 overflow-y-auto pr-1">
          {allTags.map(({ tag, kind }) => {
            const count = tagCounts[tag] ?? 0;
            const isEditing = editingTag === tag;
            const colorDot = getTagColor(tag, customTagColors).replace("text-", "bg-");

            if (isEditing) {
              return (
                <div
                  key={tag}
                  className="rounded-lg border border-primary/40 bg-primary/[0.04] px-3 py-2"
                >
                  <div className="flex items-center gap-2">
                    <span className={cn("h-2 w-2 shrink-0 rounded-full", colorDot)} />
                    <input
                      type="text"
                      value={editingTagName}
                      onChange={(e) => {
                        setEditingTagName(e.target.value);
                        if (editingTagError) setEditingTagError(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                        if (e.key === "Enter") handleCommitRename(tag);
                        if (e.key === "Escape") cancelRename();
                      }}
                      autoFocus
                      aria-invalid={!!editingTagError}
                      aria-describedby="tag-rename-error"
                      className="min-w-0 flex-1 bg-transparent text-sm text-foreground focus:outline-none"
                    />
                    <button
                      onClick={() => handleCommitRename(tag)}
                      className="rounded p-1 text-emerald-300 hover:bg-emerald-500/15"
                      title={t("entries.tagManager.confirm")}
                    >
                      <Check className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={cancelRename}
                      className="rounded p-1 text-muted-foreground hover:bg-accent"
                      title={t("entries.tagManager.cancel")}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <FieldError id="tag-rename-error" message={editingTagError} />
                </div>
              );
            }

            return (
              <div
                key={tag}
                className="group flex items-center gap-2 rounded-lg border border-transparent px-3 py-2 transition-colors hover:border-border hover:bg-accent/40"
              >
                <span className={cn("h-2 w-2 shrink-0 rounded-full", colorDot)} />
                <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                  {getTagLabel(tag, t)}
                </span>
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                  {count > 0
                    ? t("entries.tagManager.usageCount", { count })
                    : t("entries.tagManager.unused")}
                </span>
                {kind === "default" ? (
                  <span className="shrink-0 rounded-full bg-muted/30 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                    {t("entries.tagManager.builtin")}
                  </span>
                ) : kind === "orphan" ? (
                  <span className="shrink-0 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-300">
                    {t("entries.tagManager.orphan")}
                  </span>
                ) : (
                  <div className="flex shrink-0 items-center gap-0.5">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          className="rounded p-1 text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
                          title={t("entries.tagManager.color")}
                        >
                          <Palette className="h-3.5 w-3.5" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-auto p-2">
                        <div className="grid grid-cols-5 gap-1.5">
                          {TAG_COLOR_PALETTE.map((c) => {
                            const isCurrent =
                              (customTagColors?.[tag] ?? null) === c.value;
                            return (
                              <button
                                key={c.name}
                                onClick={() => setCustomTagColor(tag, c.value)}
                                className={cn(
                                  "flex h-6 w-6 items-center justify-center rounded-full border transition-transform hover:scale-110",
                                  c.value.replace("text-", "bg-"),
                                  isCurrent
                                    ? "border-foreground/80 ring-2 ring-foreground/20"
                                    : "border-transparent"
                                )}
                                title={c.name}
                              >
                                {isCurrent && <Check className="h-3 w-3 text-black/70" />}
                              </button>
                            );
                          })}
                        </div>
                        <button
                          onClick={() => setCustomTagColor(tag, null)}
                          className="mt-2 w-full rounded px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
                        >
                          {t("entries.tagManager.resetColor")}
                        </button>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <button
                      onClick={() => {
                        setEditingTag(tag);
                        setEditingTagName(tag);
                      }}
                      className="rounded p-1 text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
                      title={t("entries.tagManager.rename")}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => handleDelete(tag)}
                      className="rounded p-1 text-muted-foreground/70 transition-colors hover:bg-destructive/10 hover:text-destructive"
                      title={t("entries.tagManager.delete")}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Cleanup unused — only shown when there's something to clean */}
        {unusedCustomTags.length > 0 && (
          <button
            onClick={handleCleanupUnused}
            className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg border border-amber-400/30 bg-amber-500/[0.06] px-3 py-1.5 text-xs font-medium text-amber-300 transition-colors hover:border-amber-400/60 hover:bg-amber-500/[0.12]"
          >
            <Sparkles className="h-3.5 w-3.5" />
            {t("entries.tagManager.cleanupUnused", {
              count: unusedCustomTags.length,
            })}
          </button>
        )}

        {/* New tag creation row — pinned at the bottom */}
        <div className="mt-3 border-t border-border pt-3">
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={newTagName}
              onChange={(e) => {
                setNewTagName(e.target.value);
                if (newTagError) setNewTagError(null);
              }}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === "Enter") handleCreate();
              }}
              placeholder={t("entries.tagManager.newPlaceholder")}
              aria-invalid={!!newTagError}
              aria-describedby="new-tag-error"
              className="flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/40 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/50 aria-invalid:border-destructive/60"
            />
            <button
              onClick={handleCreate}
              disabled={!newTagName.trim()}
              className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
            >
              <Plus className="h-3.5 w-3.5" />
              {t("entries.tagManager.add")}
            </button>
          </div>
          <FieldError id="new-tag-error" message={newTagError} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
