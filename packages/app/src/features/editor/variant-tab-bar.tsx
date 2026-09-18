import { useState, useCallback, useRef, useEffect, useMemo, Fragment } from "react";
import { useRouter } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, Plus, Loader2, Pencil, X, Star } from "lucide-react";
import { feedback } from "@/lib/feedback";
import { cn } from "@/lib/utils";
import { useEditorStore } from "@/stores/editor";
import { useWorldsStore } from "@/stores/worlds";
import { LANGUAGE_SHORT } from "@/lib/languages";
import { LanguageSelectDialog } from "@/components/language-select-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const apiBase = import.meta.env.VITE_API_URL || "";

function displayLabel(v: {
  variantLabel: string | null;
  language: string | null;
  name: string;
}) {
  if (v.variantLabel) return v.variantLabel;
  return v.name;
}

function langBadge(language: string | null): string | null {
  if (!language) return null;
  return LANGUAGE_SHORT[language] ?? language.toUpperCase();
}

export function VariantTabBar({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation(["editor", "common"]);
  const router = useRouter();

  const serverWorldId = useEditorStore((s) => s.serverWorldId);
  const variants = useEditorStore((s) => s.variants);
  const variantsLoading = useEditorStore((s) => s.variantsLoading);
  const saving = useEditorStore((s) => s.saving);
  const loadingWorld = useEditorStore((s) => s.loadingWorld);
  const language = useEditorStore((s) => s.language);
  const worldName = useEditorStore((s) => s.worldDraft.name);
  const variantLabel = useEditorStore((s) => s.variantLabel);

  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const confirmDeleteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editRef = useRef<HTMLInputElement>(null);
  const renameCommitted = useRef(false);

  // Language picker states
  const [showCreateLangPicker, setShowCreateLangPicker] = useState(false);
  const [changeLangTargetId, setChangeLangTargetId] = useState<string | null>(null);

  // 主/副 (primary/secondary): the marker and the "set primary" action only
  // matter when a language actually has 2+ variants to choose between.
  const sameLangCount = useCallback(
    (lang: string | null) => variants.filter((v) => (v.language ?? "") === (lang ?? "")).length,
    [variants],
  );
  const hasPrimarySecondary = useMemo(() => {
    const counts = new Map<string, number>();
    for (const v of variants) {
      const k = v.language ?? "";
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return [...counts.values()].some((n) => n >= 2);
  }, [variants]);
  // Only a PUBLISHED version can become the public hub face. The action stays
  // visible on a draft 副 so the path is discoverable, but it is DISABLED and
  // labelled "(publish first)" — the guidance sits on the control instead of
  // firing a pill at someone who did nothing wrong.
  const handleSetPrimary = useCallback((variantId: string, status?: string | null) => {
    if (status !== "published") return;
    void useEditorStore.getState().setPrimary(variantId);
  }, []);

  useEffect(() => {
    if (editingId && editRef.current) {
      editRef.current.focus();
      editRef.current.select();
    }
  }, [editingId]);

  // Step 1: user clicks "+", we show language picker
  const handleCreateClick = useCallback(() => {
    if (creating || saving || loadingWorld) return;
    setShowCreateLangPicker(true);
  }, [creating, saving, loadingWorld]);

  // Step 2: user picks a language, we create the variant
  const handleCreateWithLanguage = useCallback(async (lang: string | null) => {
    setShowCreateLangPicker(false);
    // A variant in a language the group doesn't have yet needs no label: every
    // picker falls back to its own title, which the author writes in that
    // language while translating the card. "Variant 3" would say less and go
    // stale. A second variant in a language that already exists is the one case
    // where the title can't tell them apart, so there we still number it.
    const sameLanguageExists = variants.some(
      (v) => (v.language ?? null) === (lang ?? null),
    );
    const nextNum = variants.length + 1;
    const label = sameLanguageExists
      ? `${t("variantBar.variantPrefix", "Variant")} ${nextNum}`
      : "";

    setCreating(true);
    const newWorldId = await useEditorStore.getState().createVariant(label, lang);
    setCreating(false);

    if (newWorldId) {
      router.navigate({
        to: "/app/worlds/$worldId/edit",
        params: { worldId: newWorldId },
      });
    }
  }, [creating, saving, loadingWorld, variants.length, router, t]);

  // Change language on a variant via PATCH + store update
  const handleChangeLanguage = useCallback(async (lang: string | null) => {
    const targetId = changeLangTargetId;
    setChangeLangTargetId(null);
    if (!targetId) return;

    const isCurrentWorld = targetId === serverWorldId;

    if (isCurrentWorld) {
      // Update store immediately
      useEditorStore.getState().setLanguage(lang);
    }

    // Update the variants list optimistically
    useEditorStore.setState((s) => ({
      variants: s.variants.map((v) =>
        v.id === targetId ? { ...v, language: lang } : v,
      ),
    }));

    // If not the current world, also PATCH the server. Either way, re-fetch the
    // variants afterward: the server demotes the moved row to 副 and re-promotes
    // a sibling (ensureGroupPrimaries), so the optimistic local patch (which only
    // touched `language`) would otherwise leave stale / duplicate 主 stars.
    if (!isCurrentWorld) {
      try {
        const res = await fetch(`${apiBase}/api/worlds/${targetId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ language: lang }),
        });
        if (!res.ok) throw new Error("patch failed");
      } catch {
        feedback.error(t("variantBar.changeLanguageFailed", "Couldn't change the language"));
      }
      await useEditorStore.getState().loadVariants();
    }
  }, [changeLangTargetId, serverWorldId, t]);

  const handleSwitch = useCallback(
    async (worldId: string) => {
      if (worldId === serverWorldId || loadingWorld || saving) return;

      const store = useEditorStore.getState();
      if (store.isDirty) {
        // saveDraft surfaces its own failure pill with a Retry — a second pill
        // here would just replace it with less useful copy.
        if (!(await store.saveDraft())) return;
      }

      router.navigate({
        to: "/app/worlds/$worldId/edit",
        params: { worldId },
      });
    },
    [serverWorldId, loadingWorld, saving, router],
  );

  const startRename = useCallback((variantId: string, currentLabel: string) => {
    renameCommitted.current = false;
    setEditingId(variantId);
    setEditValue(currentLabel);
  }, []);

  const commitRename = useCallback(async () => {
    if (renameCommitted.current) return;
    if (!editingId || !editValue.trim()) {
      setEditingId(null);
      return;
    }
    renameCommitted.current = true;

    const isCurrentWorld = editingId === serverWorldId;

    if (isCurrentWorld) {
      useEditorStore.getState().setVariantLabel(editValue.trim());
      useEditorStore.setState((s) => ({
        variants: s.variants.map((v) =>
          v.id === editingId ? { ...v, variantLabel: editValue.trim() } : v,
        ),
      }));
    } else {
      try {
        await fetch(`${apiBase}/api/worlds/${editingId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ variantLabel: editValue.trim() }),
        });
        await useEditorStore.getState().loadVariants();
      } catch {
        feedback.error(t("variantBar.renameFailed", "Couldn't rename this version"));
      }
    }

    setEditingId(null);
  }, [editingId, editValue, serverWorldId, t]);

  const handleDeleteClick = useCallback(
    (variantId: string) => {
      if (deleting) return;
      if (variants.length <= 1) return;

      // First click: show confirmation state
      if (confirmDeleteId !== variantId) {
        setConfirmDeleteId(variantId);
        // Auto-reset after 5 seconds
        if (confirmDeleteTimer.current) clearTimeout(confirmDeleteTimer.current);
        confirmDeleteTimer.current = setTimeout(() => setConfirmDeleteId(null), 5000);
        return;
      }

      // Second click: actually delete
      setConfirmDeleteId(null);
      if (confirmDeleteTimer.current) clearTimeout(confirmDeleteTimer.current);
      performDelete(variantId);
    },
    [deleting, variants.length, confirmDeleteId],
  );

  // Deleting a variant is a server delete with no restore endpoint, so the
  // failure gets a Retry pill: the row is still on screen but the two-tap
  // confirm it came from has already reset.
  const performDeleteRef = useRef<(variantId: string) => void>(() => {});
  const deleteFailed = useCallback(
    (variantId: string) => {
      feedback.error(t("variantBar.deleteFailed", "Couldn't delete this version"), {
        label: t("common:action.retry"),
        onClick: () => performDeleteRef.current(variantId),
      });
    },
    [t],
  );

  const performDelete = useCallback(
    async (variantId: string) => {
      setDeleting(variantId);
      try {
        const res = await fetch(`${apiBase}/api/worlds/${variantId}`, {
          method: "DELETE",
          credentials: "include",
        });

        if (!res.ok) {
          deleteFailed(variantId);
          setDeleting(null);
          return;
        }

        useWorldsStore.getState().invalidate();

        if (variantId === serverWorldId) {
          const other = variants.find((v) => v.id !== variantId);
          if (other) {
            router.navigate({
              to: "/app/worlds/$worldId/edit",
              params: { worldId: other.id },
            });
          }
        } else {
          await useEditorStore.getState().loadVariants();
        }
      } catch {
        deleteFailed(variantId);
      } finally {
        setDeleting(null);
      }
    },
    [deleting, variants, serverWorldId, router, deleteFailed],
  );

  performDeleteRef.current = performDelete;

  const hasMultipleVariants = variants.length >= 2;

  // Build the list of tabs to render.
  // When variants exist (multi-variant world), use them directly.
  // Otherwise, synthesize a single tab from the current world state.
  const tabs = variants.length > 0
    ? variants
    : serverWorldId
      ? [{ id: serverWorldId, name: worldName || t("variantBar.untitled", "Untitled"), variantLabel, language, thumbnailUrl: null, isPrimaryVariant: true }]
      : [];

  // Group variants by language so each language's 主/副 sit together. Within a
  // language the 主 (primary) comes first. Preserves first-seen language order.
  const langGroups: { lang: string | null; items: typeof tabs }[] = [];
  {
    const idx = new Map<string, number>();
    for (const v of tabs) {
      const key = v.language ?? "";
      let i = idx.get(key);
      if (i === undefined) {
        i = langGroups.length;
        idx.set(key, i);
        langGroups.push({ lang: v.language ?? null, items: [] });
      }
      langGroups[i]!.items.push(v);
    }
    for (const g of langGroups) {
      g.items.sort((a, b) => Number(b.isPrimaryVariant) - Number(a.isPrimaryVariant));
    }
  }
  const multipleLanguages = langGroups.length > 1;

  if (compact) {
    const current = tabs.find((variant) => variant.id === serverWorldId) ?? tabs[0] ?? null;
    if (!current) return null;
    const currentLabel = current ? displayLabel(current) : t("variantBar.untitled", "Untitled");
    const currentBadge = current ? langBadge(current.language) : null;
    const isEditingCurrent = current && editingId === current.id;

    return (
      <div className="min-w-0 shrink">
        {isEditingCurrent ? (
          <div className="flex min-w-0 items-center gap-1.5">
            <input
              ref={editRef}
              type="text"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === "Enter") commitRename();
                if (e.key === "Escape") setEditingId(null);
              }}
              maxLength={100}
              placeholder={t("variantBar.rename", "Rename")}
              className="h-8 min-w-0 flex-1 rounded-full border border-border bg-background px-3 text-xs text-foreground focus:border-primary/40 focus:outline-none"
            />
            <button
              type="button"
              onClick={commitRename}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground"
              aria-label={t("action.confirm", { defaultValue: "Confirm" })}
            >
              <Check className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setEditingId(null)}
              className="hover-surface inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground"
              aria-label={t("action.cancel", { defaultValue: "Cancel" })}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-border bg-card/70 px-2 text-left transition-colors hover:bg-accent"
                title={currentLabel}
              >
                {variantsLoading ? (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
                ) : (
                  <>
                    <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-bold text-primary">
                      {currentBadge ?? t("variantBar.noLanguage", "Lang")}
                    </span>
                    <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  </>
                )}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-[min(22rem,calc(100vw-1.5rem))]">
              {hasPrimarySecondary && (
                <p className="px-2 py-1.5 text-[11px] leading-snug text-muted-foreground/70">
                  {t("variantBar.primaryExplainer", "一种语言可以做好几个版本。带 ★ 的「主」是别人浏览时看到的那个；其它版本玩家点进卡片后也能选来玩。")}
                </p>
              )}
              {langGroups.map((group) => (
                <div key={group.lang ?? "_none"}>
                  {multipleLanguages && (
                    <div className="px-2 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/50">
                      {langBadge(group.lang) ?? t("variantBar.noLanguage", "Lang")}
                    </div>
                  )}
                  {group.items.map((variant) => {
                    const isActive = variant.id === serverWorldId;
                    const label = displayLabel(variant);
                    const badge = langBadge(variant.language);
                    const isDeleting = deleting === variant.id;
                    const showPrimaryStar = variant.isPrimaryVariant && group.items.length >= 2;

                    return (
                      <DropdownMenuItem
                        key={variant.id}
                        onClick={() => handleSwitch(variant.id)}
                        disabled={isActive || loadingWorld || saving || creating || isDeleting}
                        className={cn("gap-2", isActive && "bg-primary/10")}
                      >
                        <span className="min-w-0 flex-1 truncate">{label}</span>
                        {showPrimaryStar && (
                          <Star
                            className="h-3 w-3 shrink-0 fill-[#C9A25E] text-[#C9A25E]"
                            aria-label={t("variantBar.primaryBadge", "主")}
                          />
                        )}
                        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-bold text-muted-foreground">
                          {badge ?? t("variantBar.noLanguage", "Lang")}
                        </span>
                        {isActive && <Check className="h-4 w-4 text-primary" />}
                      </DropdownMenuItem>
                    );
                  })}
                </div>
              ))}

              {current && (
                <>
                  <DropdownMenuSeparator />
                  {current.isPrimaryVariant === false && sameLangCount(current.language) >= 2 && (
                    <DropdownMenuItem
                      disabled={current.status !== "published"}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleSetPrimary(current.id, current.status);
                      }}
                    >
                      <Star className="mr-2 h-4 w-4" />
                      {current.status === "published"
                        ? t("variantBar.setPrimary", "Set as primary")
                        : t("variantBar.setPrimaryDraft", "Set as primary (publish first)")}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onClick={() => setChangeLangTargetId(current.id)}>
                    {t("variantBar.changeLanguage", "Change language")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => startRename(current.id, currentLabel)}>
                    <Pencil className="mr-2 h-4 w-4" />
                    {t("variantBar.rename", "Rename")}
                  </DropdownMenuItem>
                  {hasMultipleVariants && (
                    <DropdownMenuItem
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteClick(current.id);
                      }}
                      disabled={deleting === current.id}
                      className={confirmDeleteId === current.id ? "text-destructive" : undefined}
                    >
                      <X className="mr-2 h-4 w-4" />
                      {confirmDeleteId === current.id
                        ? t("variantBar.confirmDelete", "Tap again to delete")
                        : t("variantBar.delete", "Delete variant")}
                    </DropdownMenuItem>
                  )}
                </>
              )}

              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={handleCreateClick}
                disabled={creating || saving || loadingWorld || !serverWorldId}
              >
                {creating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
                {t("variantBar.newVariant", "New Variant")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        <LanguageSelectDialog
          open={showCreateLangPicker}
          onSelect={handleCreateWithLanguage}
          onClose={() => setShowCreateLangPicker(false)}
          title={t("variantBar.selectLanguageForVariant", "Select language for new variant")}
          allowSkip
        />
        <LanguageSelectDialog
          open={changeLangTargetId !== null}
          onSelect={handleChangeLanguage}
          onClose={() => setChangeLangTargetId(null)}
          title={t("variantBar.changeLanguage", "Change language")}
          allowSkip
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col border-b border-border bg-card/20">
      <div className="flex shrink-0 items-center gap-1.5 px-3 py-1.5">
      {/* Variant tabs — grouped by language; 主/副 cluster within each language */}
      {langGroups.map((group, gi) => (
        <Fragment key={group.lang ?? "_none"}>
          {gi > 0 && multipleLanguages && (
            <div className="mx-0.5 h-5 w-px shrink-0 self-center bg-border/60" aria-hidden />
          )}
          {group.items.map((variant) => {
        const isActive = variant.id === serverWorldId;
        const label = displayLabel(variant);
        const badge = langBadge(variant.language);
        const isEditing = editingId === variant.id;
        const isDeleting = deleting === variant.id;

        if (isEditing) {
          return (
            <div key={variant.id} className="inline-flex items-center gap-1">
              <input
                ref={editRef}
                type="text"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                  if (e.key === "Enter") commitRename();
                  if (e.key === "Escape") setEditingId(null);
                }}
                onBlur={() => setEditingId(null)}
                maxLength={100}
                placeholder={t("variantBar.enterToSave", "Enter ↵")}
                className="h-7 w-36 rounded-full border border-[#C9A25E]/[0.12] bg-[#C9A25E]/[0.08] px-3 text-xs text-foreground backdrop-blur-xl focus:outline-none focus:border-[#C9A25E]/25"
              />
            </div>
          );
        }

        return (
          <div
            key={variant.id}
            className={cn(
              "group inline-flex shrink-0 items-center rounded-full transition-all",
              isActive
                ? "text-foreground rounded-full border border-[#C9A25E]/[0.12] bg-[#C9A25E]/[0.08] shadow-[inset_0_1px_0_rgba(201,162,94,0.1)] backdrop-blur-xl"
                : "text-muted-foreground hover:bg-white/5 hover:text-foreground",
            )}
          >
            {/* Language badge — clickable to change language */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (isActive) {
                  setChangeLangTargetId(variant.id);
                }
              }}
              disabled={!isActive}
              className={cn(
                "shrink-0 rounded-full px-1.5 py-0.5 ml-2.5 text-[10px] font-bold leading-none transition-colors",
                isActive
                  ? "text-muted-foreground hover:bg-white/10 hover:text-foreground cursor-pointer"
                  : "text-muted-foreground/60 cursor-default",
              )}
              title={isActive ? t("variantBar.changeLanguage", "Change language") : undefined}
            >
              {badge ?? t("variantBar.noLanguage", "Lang")}
            </button>

            <button
              onClick={() => handleSwitch(variant.id)}
              disabled={isActive || loadingWorld || saving || creating || isDeleting}
              className="flex items-center gap-1.5 py-1.5 pr-1 text-xs font-medium max-w-[200px]"
            >
              <span className="truncate">{label}</span>
            </button>

            {/* 主 marker — only when this language has 2+ variants to choose from */}
            {variant.isPrimaryVariant && sameLangCount(variant.language) >= 2 && (
              <Star
                className="mr-0.5 h-3 w-3 shrink-0 fill-[#C9A25E] text-[#C9A25E]"
                aria-label={t("variantBar.primaryBadge", "主")}
              />
            )}

            {/* Action buttons — fade in on hover; always visible on touch devices */}
            <div className="touch-reveal flex items-center gap-0 overflow-hidden pr-1 opacity-0 transition-all duration-150 group-hover:opacity-100">
              {/* Promote a 副 to 主. Shown for any same-language 副 so the path
                  is discoverable; a draft one is disabled and its tooltip says
                  "(publish first)". */}
              {variant.isPrimaryVariant === false && sameLangCount(variant.language) >= 2 && (
                <button
                  disabled={variant.status !== "published"}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleSetPrimary(variant.id, variant.status);
                  }}
                  className={cn(
                    "rounded-full p-1 transition-colors",
                    variant.status === "published"
                      ? "text-muted-foreground/50 hover:bg-[#C9A25E]/15 hover:text-[#C9A25E]"
                      : "cursor-not-allowed text-muted-foreground/30",
                  )}
                  title={variant.status === "published"
                    ? t("variantBar.setPrimary", "Set as primary")
                    : t("variantBar.setPrimaryDraft", "Set as primary (publish first)")}
                >
                  <Star className="h-3 w-3" />
                </button>
              )}
              {isActive && (
                <button
                  onClick={() => startRename(variant.id, label)}
                  className={cn(
                    "rounded-full p-1 transition-colors",
                    "text-muted-foreground/50 hover:bg-white/10 hover:text-foreground",
                  )}
                  title={t("entries.rename")}
                >
                  <Pencil className="h-3 w-3" />
                </button>
              )}

              {hasMultipleVariants && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeleteClick(variant.id);
                  }}
                  disabled={isDeleting}
                  className={cn(
                    "rounded-full p-1 transition-colors",
                    confirmDeleteId === variant.id
                      ? "bg-destructive/20 text-destructive"
                      : "text-muted-foreground/50 hover:bg-destructive/15 hover:text-destructive",
                  )}
                  title={confirmDeleteId === variant.id ? t("extra.clickAgainConfirm") : t("extra.deleteVariant")}
                >
                  {isDeleting ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <X className="h-3 w-3" />
                  )}
                </button>
              )}
            </div>
          </div>
        );
          })}
        </Fragment>
      ))}

      {/* Loading */}
      {variantsLoading && (
        <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground/30" />
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Create button */}
      <button
        onClick={handleCreateClick}
        disabled={creating || saving || loadingWorld || !serverWorldId}
        title={!serverWorldId ? t("variantBar.saveFirst") : undefined}
        className="flex shrink-0 items-center gap-1.5 rounded-full border border-dashed border-white/10 px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-white/20 hover:bg-white/5 hover:text-foreground disabled:opacity-40 disabled:pointer-events-none"
      >
        {creating ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Plus className="h-3.5 w-3.5" />
        )}
        {!hasMultipleVariants && t("variantBar.newVariant", "New Variant")}
      </button>

      {/* Language picker for creating a new variant */}
      <LanguageSelectDialog
        open={showCreateLangPicker}
        onSelect={handleCreateWithLanguage}
        onClose={() => setShowCreateLangPicker(false)}
        title={t("variantBar.selectLanguageForVariant", "Select language for new variant")}
        allowSkip
      />

      {/* Language picker for changing a variant's language */}
      <LanguageSelectDialog
        open={changeLangTargetId !== null}
        onSelect={handleChangeLanguage}
        onClose={() => setChangeLangTargetId(null)}
        title={t("variantBar.changeLanguage", "Change language")}
        allowSkip
      />
      </div>

      {/* 主/副 explainer — only when a language actually has multiple versions */}
      {hasPrimarySecondary && (
        <p className="flex items-center gap-1.5 px-3 pb-1.5 text-[11px] leading-snug text-muted-foreground/70">
          <Star className="h-3 w-3 shrink-0 fill-[#C9A25E] text-[#C9A25E]" />
          {t("variantBar.primaryExplainer", "一种语言可以做好几个版本。带 ★ 的「主」是别人浏览时看到的那个；其它版本玩家点进卡片后也能选来玩。")}
        </p>
      )}
    </div>
  );
}
