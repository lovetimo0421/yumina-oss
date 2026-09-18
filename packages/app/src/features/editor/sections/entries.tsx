import { useState, useRef, useMemo, useCallback, useEffect, memo } from "react";
import { useTranslation } from "react-i18next";
import {
  Plus,
  Trash2,
  Copy,
  FileText,
  ChevronDown,
  ChevronRight,
  Settings2,
  GripVertical,
  MessageCircle,
  FolderOpen,
  FolderClosed,
  Pencil,
  ArrowLeft,
  Shield,
  RotateCcw,
  AlertTriangle,
  SlidersHorizontal,
  Check,
  Tag as TagIcon,
  LayoutGrid,
  List,
} from "lucide-react";
import { EntriesTriggerBoard } from "../components/entries-trigger-board";
import { TagManagerDialog } from "../components/tag-manager-dialog";
import { StyledCheckbox } from "../components/styled-checkbox";
import { useTemplateContentPlaceholder } from "../template-placeholders";
import { KeywordsInput } from "../components/keywords-input";
import { ConditionEditor } from "../components/condition-editor";
import { DebouncedInput, DebouncedTextarea } from "../components/debounced-field";
import { cn } from "@/lib/utils";
import { TwoTapDeleteButton } from "@/components/ui/two-tap-delete-button";
import { DOCS_URLS } from "@/lib/docs-urls";
import {
  SECONDARY_LOGIC_OPTIONS,
  getSendAsOptions,
  DEFAULT_TAGS,
  getTagColor,
  getTagLabel,
  getBundleColor,
} from "@/lib/entry-constants";
import { useEditorStore } from "@/stores/editor";
import { HoverHint } from "../components/hover-hint";
import {
  estimateTokens,
  deriveSectionDefaults,
  deriveSectionDefaultsForEntry,
  OFFICIAL_PRESETS,
} from "@yumina/engine";
import {
  formatConditionLabel,
  getEntryBoundSlotId,
  normalizeLoreUiBindingsList,
} from "../lib/lore-ui-bindings";
import {
  defaultConditionForVariable,
  entryUsesVariableBinding,
} from "../lib/entry-conditions";
import {
  parseExampleContent,
  serializeTurns,
  type ExampleTurn,
} from "../lib/example-turns";
import { getUiBoundEntryIds, isVariableBoundEntry } from "@yumina/engine";
import type { Worldbook } from "@yumina/engine";

// Stable empty-array reference — never inline `?? []` inside a Zustand selector
// (allocates a new array each render → useSyncExternalStore infinite loop).
const EMPTY_WORLDBOOKS: Worldbook[] = [];
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { NumberInput } from "@/components/ui/number-input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import type { WorldEntry, EntryFolder } from "@yumina/engine";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  useDroppable,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

// ── Section classification ──

type Section = "system-presets" | "examples" | "chat-history" | "post-history";

/** Returns the entry's section (now a required field on WorldEntry). */
function classifyEntry(entry: WorldEntry): Section {
  return entry.section;
}

// Label/hint resolved at render-time via t() — see useSectionMeta() below
const SECTION_META_IDS: { id: Section; labelKey: string; hintKey: string }[] = [
  { id: "system-presets", labelKey: "entries.sections.systemPresets", hintKey: "entries.sections.systemPresetsHint" },
  { id: "examples", labelKey: "entries.sections.examples", hintKey: "" },
  { id: "chat-history", labelKey: "entries.sections.chatHistory", hintKey: "entries.sections.chatHistoryHint" },
  { id: "post-history", labelKey: "entries.sections.postHistory", hintKey: "" },
];

function entrySort(a: WorldEntry, b: WorldEntry): number {
  const aPos = a.position ?? Infinity;
  const bPos = b.position ?? Infinity;
  return aPos - bPos;
}

// PERF: cache token estimates keyed by the entry OBJECT. updateEntry replaces
// only the edited entry's object (others keep identity), so on each keystroke
// the token summary recomputes just the one changed entry and reuses cached
// counts for the rest — turning an O(total-content) re-tokenize per keystroke
// into O(1). A WeakMap means stale entries are GC'd automatically, no eviction.
const entryTokenCache = new WeakMap<WorldEntry, number>();
function getEntryTokens(entry: WorldEntry): number {
  const cached = entryTokenCache.get(entry);
  if (cached !== undefined) return cached;
  const tokens = estimateTokens(entry.content);
  entryTokenCache.set(entry, tokens);
  return tokens;
}

// ── Main component ──

export function EntriesSection({ compact, mobileListMode, scopeWorldbookId }: { compact?: boolean; mobileListMode?: boolean; scopeWorldbookId?: string | null } = {}) {
  const { t } = useTranslation("editor");

  const SECTION_META = useMemo(() => SECTION_META_IDS.map((m) => ({
    id: m.id,
    label: t(m.labelKey as any) as string,
    hint: m.hintKey ? t(m.hintKey as any) as string : "",
  })), [t]);

  const worldDraft = useEditorStore(s => s.worldDraft);
  const worldbooks = useEditorStore(s => s.worldDraft.worldbooks) ?? EMPTY_WORLDBOOKS;
  const addEntry = useEditorStore(s => s.addEntry);
  const updateEntry = useEditorStore(s => s.updateEntry);
  const duplicateEntry = useEditorStore(s => s.duplicateEntry);
  const removeEntry = useEditorStore(s => s.removeEntry);
  const reorderEntries = useEditorStore(s => s.reorderEntries);
  const setEntryWorldbook = useEditorStore(s => s.setEntryWorldbook);
  const setSettings = useEditorStore(s => s.setSettings);
  const addFolder = useEditorStore(s => s.addFolder);
  const removeFolder = useEditorStore(s => s.removeFolder);
  const renameFolder = useEditorStore(s => s.renameFolder);
  const moveFolder = useEditorStore(s => s.moveFolder);
  const setField = useEditorStore(s => s.setField);
  const setActiveSection = useEditorStore(s => s.setActiveSection);
  const setCustomUiTab = useEditorStore(s => s.setCustomUiTab);

  const [viewMode, setViewMode] = useState<"classic" | "triggers">(() => {
    try {
      return localStorage.getItem("yumina-entries-view") === "triggers"
        ? "triggers"
        : "classic";
    } catch {
      return "classic";
    }
  });

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeTagFilters, setActiveTagFilters] = useState<Set<string>>(new Set());
  const [tagFilterMode, setTagFilterMode] = useState<"or" | "and">("or");
  const [showSettings, setShowSettings] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [collapsedSections, setCollapsedSections] = useState<Set<Section>>(new Set());
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const [dragActiveId, setDragActiveId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [showTagManager, setShowTagManager] = useState(false);
  const [confirmAlwaysSendOff, setConfirmAlwaysSendOff] = useState(false);

  const selectEntry = useCallback((id: string | null) => {
    setSelectedId(id);
    setConfirmAlwaysSendOff(false);
  }, []);

  // PERF: stable, id-keyed row handlers. Passing fresh inline closures to each
  // SortableEntryCard would defeat React.memo (props change every render), so
  // every one of the 200-1000+ rows would re-render on each keystroke commit.
  // These keep referential identity across renders; selectedId is read through
  // a ref so the delete handler stays stable instead of changing with selection.
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const handleSelectEntry = useCallback((id: string) => selectEntry(id), [selectEntry]);
  const handleDeleteEntry = useCallback((id: string) => {
    removeEntry(id);
    if (selectedIdRef.current === id) selectEntry(null);
  }, [removeEntry, selectEntry]);
  const handleRenameEntry = useCallback(
    (id: string, name: string) => updateEntry(id, { name }),
    [updateEntry],
  );
  // The copy's row opens in rename mode. A ref (not state) so the flag can't
  // survive into a later remount of the same row — the new card reads it once
  // on mount and clears it.
  const pendingRenameIdRef = useRef<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const consumeAutoEdit = useCallback((id: string) => {
    if (pendingRenameIdRef.current !== id) return false;
    pendingRenameIdRef.current = null;
    return true;
  }, []);
  const duplicateAndSelect = useCallback((id: string, openRename: boolean) => {
    const newId = duplicateEntry(id, t("entries.copySuffix"));
    if (!newId) return;
    // Inline rename only where the list stays on screen next to the detail
    // panel (the same @[640px] container query the layout below uses). Below
    // that width selecting the copy hides the list, so an armed rename would
    // ambush the user with a keyboard whenever they later tapped Back — there
    // the detail panel's own Name field is the obvious place to edit.
    const sideBySide = (rootRef.current?.clientWidth ?? 0) >= 640;
    if (openRename && sideBySide) pendingRenameIdRef.current = newId;
    selectEntry(newId);
  }, [duplicateEntry, selectEntry, t]);
  const handleDuplicateEntry = useCallback(
    (id: string) => duplicateAndSelect(id, true),
    [duplicateAndSelect],
  );
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const toggleSection = (id: Section) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleFolder = (id: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // All available tags = defaults + custom + legacy tags from entries
  const allTags = useMemo(() => {
    const custom = worldDraft.customTags ?? [];
    const entryTags = new Set<string>();
    for (const e of worldDraft.entries) {
      for (const t of e.tags ?? []) entryTags.add(t);
    }
    const known = new Set([...DEFAULT_TAGS, ...custom]);
    const legacy = [...entryTags].filter((t) => !known.has(t));
    return [...DEFAULT_TAGS, ...custom.filter((t) => !DEFAULT_TAGS.includes(t)), ...legacy];
  }, [worldDraft.customTags, worldDraft.entries]);

  // Tag counts based on entry.tags array
  const tagCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const e of worldDraft.entries) {
      for (const tag of e.tags ?? []) {
        counts[tag] = (counts[tag] || 0) + 1;
      }
    }
    return counts;
  }, [worldDraft.entries]);

  const uiBoundEntryIds = useMemo(
    () => getUiBoundEntryIds(normalizeLoreUiBindingsList(worldDraft.loreUiBindings)),
    [worldDraft.loreUiBindings],
  );

  // Filter entries by tags. OR mode = any selected tag matches (default).
  // AND mode = entry must carry every selected tag.
  // Greeting entries are filtered out — they live in the First Message panel.
  // Frontend-bound entries are NOT in the normal lists — they live exclusively
  // in their dedicated "Frontend controls" lorebook (the Custom UI → Bindings
  // view), created by writing <LoreButton>/<LoreSwitch> in the rootComponent.
  const filteredEntries = useMemo(() => {
    let entries = worldDraft.entries.filter(
      (e) => e.role !== "greeting" && !uiBoundEntryIds.has(e.id),
    );
    // When this list is scoped to one knowledge base (book), show only that
    // book's entries. null = the always-on Main book (entries with no worldbookId).
    if (scopeWorldbookId !== undefined) {
      entries = entries.filter((e) => (e.worldbookId ?? null) === scopeWorldbookId);
    }
    if (activeTagFilters.size > 0) {
      entries = entries.filter((e) => {
        const entryTags = new Set(e.tags ?? []);
        if (tagFilterMode === "and") {
          for (const t of activeTagFilters) {
            if (!entryTags.has(t)) return false;
          }
          return true;
        }
        for (const t of entryTags) {
          if (activeTagFilters.has(t)) return true;
        }
        return false;
      });
    }
    return entries;
  }, [worldDraft.entries, activeTagFilters, tagFilterMode, uiBoundEntryIds, scopeWorldbookId]);

  // Group filtered entries into sections
  const sectionEntries = useMemo(() => {
    const map: Record<Section, WorldEntry[]> = {
      "system-presets": [],
      "examples": [],
      "chat-history": [],
      "post-history": [],
    };
    for (const entry of filteredEntries) {
      const section = classifyEntry(entry);
      if (map[section]) map[section].push(entry);
      else map["system-presets"].push(entry); // fallback for unknown sections
    }
    for (const key of Object.keys(map) as Section[]) {
      map[key].sort(entrySort);
    }
    return map;
  }, [filteredEntries]);

  // Folders grouped by section
  const sectionFolders = useMemo(() => {
    const map: Record<Section, EntryFolder[]> = {
      "system-presets": [],
      "examples": [],
      "chat-history": [],
      "post-history": [],
    };
    for (const folder of worldDraft.entryFolders ?? []) {
      if (
        scopeWorldbookId !== undefined &&
        (folder.worldbookId ?? null) !== scopeWorldbookId
      ) {
        continue;
      }
      if (map[folder.section]) {
        map[folder.section].push(folder);
      }
    }
    for (const key of Object.keys(map) as Section[]) {
      map[key].sort((a, b) => a.order - b.order);
    }
    return map;
  }, [worldDraft.entryFolders, scopeWorldbookId]);

  // Token estimate split into cost-meaningful buckets. Categorization mirrors
  // the runtime gating in lorebook-matcher.ts + prompt-builder.ts so each
  // bucket maps to a distinct cost behavior:
  //   greeting          — role=greeting; sent once per session (alwaysSend has
  //                       no effect on greetings, runtime filters them out)
  //   alwaysSent        — alwaysSend=true; every turn, predictable baseline
  //   keywordTriggered  — !alwaysSend with keywords; fires when keywords match,
  //                       capped by `lorebookTokenBudget` setting (variable)
  //   dormant           — !alwaysSend AND no keywords; matcher's
  //                       `if (entry.keywords.length === 0) continue;` means
  //                       these NEVER fire — usually a setup mistake
  //   disabled          — enabled=false; zero cost until re-enabled
  // Sums on `worldDraft.entries` directly — tag filtering must not affect totals.
  const tokenSummary = useMemo(() => {
    const buckets = {
      greeting: 0,
      alwaysSent: 0,
      keywordTriggered: 0,
      dormant: 0,
      disabled: 0,
    };
    let greetingCount = 0;
    let total = 0;
    for (const e of worldDraft.entries) {
      const tk = getEntryTokens(e);
      total += tk;
      if (e.enabled === false) { buckets.disabled += tk; continue; }
      if (e.role === "greeting") { buckets.greeting += tk; greetingCount++; continue; }
      if (e.alwaysSend) { buckets.alwaysSent += tk; continue; }
      if (e.keywords && e.keywords.length > 0) buckets.keywordTriggered += tk;
      else if (e.conditions && e.conditions.length > 0) buckets.keywordTriggered += tk;
      else buckets.dormant += tk;
    }
    // perTurn = predictable per-turn floor (only alwaysSend fires every turn).
    // Health bands nudge creators toward concise lorebooks — past ~60k the
    // model starts losing fidelity on early-prompt details. Kept subtle: the
    // dot's colour is the signal, the tooltip is the explanation.
    const health: "healthy" | "caution" | "heavy" =
      total < 30_000 ? "healthy" : total < 60_000 ? "caution" : "heavy";
    return { ...buckets, greetingCount, perTurn: buckets.alwaysSent, total, health };
  }, [worldDraft.entries]);

  // Toggle for the token-breakdown footer. Persisted so creators don't have to
  // re-expand on every visit.
  const [tokenViewExpanded, setTokenViewExpanded] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("yumina:editor:tokenBreakdownExpanded") === "1";
  });
  const toggleTokenView = useCallback(() => {
    setTokenViewExpanded((v) => {
      const next = !v;
      try { localStorage.setItem("yumina:editor:tokenBreakdownExpanded", next ? "1" : "0"); } catch { /* quota */ }
      return next;
    });
  }, []);

  // Check which official presets are missing from this world
  const missingPresets = useMemo(() => {
    const existingPresetIds = new Set(worldDraft.entries.filter((e) => e.presetId).map((e) => e.presetId));
    return OFFICIAL_PRESETS.filter((p) => !existingPresetIds.has(p.presetId));
  }, [worldDraft.entries]);

  const toggleTagFilter = (tag: string) => {
    setActiveTagFilters((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  };



  function handleAddEntryInSection(section: Section, folder?: EntryFolder) {
    const role = section === "examples" ? "example" : "custom";
    addEntry(role, section, {
      folderId: folder?.id,
      worldbookId: folder ? folder.worldbookId : scopeWorldbookId ?? undefined,
      content: section === "examples" ? "<START>\n{{user}}: \n{{char}}: " : "",
    });
    const entries = useEditorStore.getState().worldDraft.entries;
    const newEntry = entries[entries.length - 1];
    if (newEntry) {
      setActiveTagFilters(new Set());
      if (folder) setCollapsedFolders((prev) => {
        const next = new Set(prev);
        next.delete(folder.id);
        return next;
      });
      selectEntry(newEntry.id);
    }
  }

  function handleAddFolderInSection(section: Section) {
    addFolder(section, t("entries.newFolder"), scopeWorldbookId ?? undefined);
  }

  function handleDragStart(event: DragStartEvent) {
    setDragActiveId(event.active.id as string);
  }

  function handleDragOver(event: DragOverEvent) {
    setDragOverId(event.over ? String(event.over.id) : null);
  }

  function handleDragEnd(event: DragEndEvent) {
    setDragActiveId(null);
    setDragOverId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const activeIdStr = active.id as string;
    const overIdStr = over.id as string;

    const isActiveEntry = activeIdStr.startsWith("entry:");
    const isActiveFolder = activeIdStr.startsWith("folder:");
    const isOverEntry = overIdStr.startsWith("entry:");
    const isOverFolder = overIdStr.startsWith("folder:");
    const isOverSection = overIdStr.startsWith("section:");

    const activeRealId = activeIdStr.replace(/^(entry|folder|section):/, "");
    const overRealId = overIdStr.replace(/^(entry|folder|section):/, "");

    // Resolve source section for the dragged item
    const activeSourceSection: Section | null = isActiveEntry
      ? (worldDraft.entries.find((e) => e.id === activeRealId)?.section as Section ?? null)
      : isActiveFolder
        ? ((worldDraft.entryFolders ?? []).find((f) => f.id === activeRealId)?.section as Section ?? null)
        : null;

    // Block dragging in/out of examples — its structure is fundamentally different
    const resolveTargetSection = (): Section | null => {
      if (isOverSection) return overRealId as Section;
      if (isOverFolder) return (worldDraft.entryFolders ?? []).find((f) => f.id === overRealId)?.section as Section ?? null;
      if (isOverEntry) return worldDraft.entries.find((e) => e.id === overRealId)?.section as Section ?? null;
      return null;
    };
    const targetSection = resolveTargetSection();
    if (activeSourceSection === "examples" && targetSection !== "examples") return;
    if (activeSourceSection !== "examples" && targetSection === "examples") return;

    // Entry or folder dragged onto a section header → move to that section
    if (isOverSection) {
      if (isActiveEntry) {
        const entry = worldDraft.entries.find((e) => e.id === activeRealId);
        if (entry && classifyEntry(entry) !== targetSection) {
          const sectionUpdates = entry.role === "greeting"
            ? {}
            : deriveSectionDefaultsForEntry(entry, targetSection!);
          updateEntry(activeRealId, { folderId: undefined, section: targetSection!, ...sectionUpdates });
        }
      } else if (isActiveFolder) {
        moveFolder(activeRealId, targetSection!);
      }
      return;
    }

    // Entry dragged onto a folder → move entry into folder
    if (isActiveEntry && isOverFolder) {
      const entry = worldDraft.entries.find((e) => e.id === activeRealId);
      const folder = (worldDraft.entryFolders ?? []).find((f) => f.id === overRealId);
      if (entry && folder) {
        const folderSection = folder.section as Section;
        const sectionUpdates = entry.role === "greeting"
          ? {} // Don't override greeting entries
          : deriveSectionDefaultsForEntry(entry, folderSection);
        updateEntry(activeRealId, {
          folderId: overRealId,
          worldbookId: folder.worldbookId,
          section: folderSection,
          ...sectionUpdates,
        });
      }
      return;
    }

    // Entry dragged onto another entry → reorder (and maybe change folder)
    if (isActiveEntry && isOverEntry) {
      const allEntries = worldDraft.entries.filter((e) => e.role !== "greeting");
      const activeEntry = allEntries.find((e) => e.id === activeRealId);
      const overEntry = allEntries.find((e) => e.id === overRealId);
      if (!activeEntry || !overEntry) return;

      // Adopt the folder of the target entry
      const newFolderId = overEntry.folderId;
      const overSection = classifyEntry(overEntry);

      const updates: Partial<WorldEntry> = {};
      if (activeEntry.folderId !== newFolderId) updates.folderId = newFolderId;
      if (newFolderId) {
        const targetFolder = (worldDraft.entryFolders ?? []).find((folder) => folder.id === newFolderId);
        if (targetFolder && activeEntry.worldbookId !== targetFolder.worldbookId) {
          updates.worldbookId = targetFolder.worldbookId;
        }
      }
      if (classifyEntry(activeEntry) !== overSection) {
        updates.section = overSection;
        // Sync alwaysSend/depth from new section (unless greeting)
        if (activeEntry.role !== "greeting") {
          Object.assign(updates, deriveSectionDefaultsForEntry(activeEntry, overSection));
        }
      }
      if (Object.keys(updates).length > 0) {
        updateEntry(activeRealId, updates);
      }

      // Reorder in the section's FULL cross-book order, not just the visible
      // slice: splice the dragged entry next to the drop target and re-emit the
      // whole section. Positions are global across books (the prompt builder
      // interleaves every book by `position`), so re-emitting only the visible
      // subset would shove this book/filter to the tail of the section and
      // silently destroy any cross-book arrangement.
      const globalSection = allEntries
        .filter((e) => e.id !== activeRealId && classifyEntry(e) === overSection)
        .sort(entrySort);
      const overIdx = globalSection.findIndex((e) => e.id === overRealId);
      if (overIdx === -1) return;

      // Mirror the visible-list drop semantics: dragging downward lands AFTER
      // the target row, dragging upward (or in from another section) BEFORE it.
      const visible = sectionEntries[overSection];
      const visOld = visible.findIndex((e) => e.id === activeRealId);
      const visNew = visible.findIndex((e) => e.id === overRealId);
      const insertAt = visOld !== -1 && visNew !== -1 && visOld < visNew ? overIdx + 1 : overIdx;

      const ids = globalSection.map((e) => e.id);
      ids.splice(insertAt, 0, activeRealId);
      reorderEntries(ids);
      return;
    }

    // Folder dragged → cross-section move
    if (isActiveFolder) {
      const folder = (worldDraft.entryFolders ?? []).find((f) => f.id === activeRealId);
      if (!folder) return;
      let folderTargetSection: Section | null = null;
      if (isOverEntry) {
        const overEntry = worldDraft.entries.find((e) => e.id === overRealId);
        if (overEntry) folderTargetSection = classifyEntry(overEntry);
      } else if (isOverFolder) {
        const overFolder = (worldDraft.entryFolders ?? []).find((f) => f.id === overRealId);
        if (overFolder) folderTargetSection = overFolder.section as Section;
      }
      if (folderTargetSection && folderTargetSection !== folder.section) {
        moveFolder(folder.id, folderTargetSection);
      }
      return;
    }
  }

  const selected = worldDraft.entries.find((e) => e.id === selectedId);
  const dragActiveRealId = dragActiveId?.replace(/^(entry|folder):/, "") ?? null;
  const dragActiveEntry = dragActiveRealId ? worldDraft.entries.find((e) => e.id === dragActiveRealId) : null;
  const dragActiveFolder = dragActiveRealId ? (worldDraft.entryFolders ?? []).find((f) => f.id === dragActiveRealId) : null;

  // Build flat list of composite sortable IDs (folders + entries interleaved)
  const allSortableIds = useMemo(() => {
    const ids: string[] = [];
    for (const meta of SECTION_META) {
      const entries = sectionEntries[meta.id];
      const folders = sectionFolders[meta.id];
      const knownFolderIds = new Set(folders.map((f) => f.id));
      const entriesByFolder = new Map<string, WorldEntry[]>();
      const unfolderedEntries: WorldEntry[] = [];
      for (const entry of entries) {
        if (entry.folderId && knownFolderIds.has(entry.folderId)) {
          if (!entriesByFolder.has(entry.folderId)) {
            entriesByFolder.set(entry.folderId, []);
          }
          entriesByFolder.get(entry.folderId)!.push(entry);
        } else {
          unfolderedEntries.push(entry);
        }
      }
      for (const folder of folders) {
        ids.push(`folder:${folder.id}`);
        if (!collapsedFolders.has(folder.id)) {
          for (const entry of entriesByFolder.get(folder.id) ?? []) {
            ids.push(`entry:${entry.id}`);
          }
        }
      }
      for (const entry of unfolderedEntries) {
        ids.push(`entry:${entry.id}`);
      }
    }
    return ids;
  }, [SECTION_META, sectionEntries, sectionFolders, collapsedFolders]);

  return (
    <div ref={rootRef} className={cn("entries-section-root @container flex min-h-0 flex-1 flex-col", mobileListMode && "studio-mobile-list-mode")}>
      {/* Header (full editor only) */}
      {!compact && (
        <div className="shrink-0 border-b border-border bg-card px-6 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="max-w-xl">
              <h1 className="text-[22px] font-bold tracking-tight text-foreground">
                {t("entries.title")}
              </h1>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                {t("entries.description")}
              </p>
              <a
                href={DOCS_URLS.entries}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary transition-colors hover:bg-primary/15"
              >
                {t("entries.learnMore")}
              </a>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex rounded-lg border border-border/70 bg-background p-0.5">
                <button
                  type="button"
                  onClick={() => {
                    setViewMode("classic");
                    try {
                      localStorage.setItem("yumina-entries-view", "classic");
                    } catch {
                      /* ignore */
                    }
                  }}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors",
                    viewMode === "classic"
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  title={t("entries.viewClassic")}
                >
                  <List className="h-3.5 w-3.5" />
                  {t("entries.viewClassic")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setViewMode("triggers");
                    try {
                      localStorage.setItem("yumina-entries-view", "triggers");
                    } catch {
                      /* ignore */
                    }
                  }}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors",
                    viewMode === "triggers"
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  title={t("entries.viewTriggers")}
                >
                  <LayoutGrid className="h-3.5 w-3.5" />
                  {t("entries.viewTriggers")}
                </button>
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="flex items-center gap-2 rounded-lg border border-border/70 bg-background px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-accent">
                    <SlidersHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
                    {t("entries.filter")}
                    {activeTagFilters.size > 0 && (
                      <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary">
                        {activeTagFilters.size}
                      </span>
                    )}
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="z-[1300] w-56">
                  <DropdownMenuItem
                    onClick={() => setActiveTagFilters(new Set())}
                    className="text-xs"
                  >
                    <span className="flex-1">{t("entries.all")}</span>
                    <span className="text-[10px] text-muted-foreground">{worldDraft.entries.length}</span>
                    {activeTagFilters.size === 0 && <Check className="h-3.5 w-3.5 text-primary" />}
                  </DropdownMenuItem>
                  {allTags.map((tag) => {
                    const count = tagCounts[tag] ?? 0;
                    if (count === 0 && !activeTagFilters.has(tag)) return null;
                    return (
                      <DropdownMenuItem
                        key={tag}
                        onClick={() => toggleTagFilter(tag)}
                        className="text-xs"
                      >
                        <span className={cn("h-1.5 w-1.5 rounded-full", getTagColor(tag, worldDraft.customTagColors).replace("text-", "bg-"))} />
                        <span className="min-w-0 flex-1 truncate">{getTagLabel(tag, t)}</span>
                        <span className="text-[10px] text-muted-foreground">{count}</span>
                        {activeTagFilters.has(tag) && <Check className="h-3.5 w-3.5 text-primary" />}
                      </DropdownMenuItem>
                    );
                  })}
                  {activeTagFilters.size >= 2 && (
                    <>
                      <DropdownMenuSeparator />
                      <div className="px-2 py-1.5">
                        <FilterModeToggle mode={tagFilterMode} onChange={setTagFilterMode} t={t} />
                      </div>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
              {mobileListMode && (
                <button
                  onClick={() => setShowSettings(!showSettings)}
                  title={t("entries.entrySettings")}
                  aria-label={t("entries.entrySettings")}
                  className={cn(
                    "flex h-7 shrink-0 items-center gap-1.5 rounded-lg border px-2 text-xs font-semibold transition-colors",
                    showSettings
                      ? "border-primary/50 bg-primary/10 text-primary"
                      : "border-border/70 bg-background text-foreground hover:bg-accent",
                  )}
                >
                  <Settings2 className="h-3.5 w-3.5" />
                  <span>{t("entries.entrySettings")}</span>
                </button>
              )}
              <button
                onClick={() => setShowTagManager(true)}
                title={t("entries.manageTags")}
                className="flex items-center gap-1.5 rounded-lg border border-border/70 bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-primary/30 hover:bg-primary/[0.06] hover:text-primary"
              >
                <TagIcon className="h-3.5 w-3.5" />
                <span className="hidden md:inline">{t("entries.manageTags")}</span>
              </button>
              <button
                onClick={() => handleAddEntryInSection("system-presets")}
                data-tour="entries-add"
                className="flex items-center gap-2 rounded-lg bg-primary px-4 py-1.5 text-xs font-semibold text-primary-foreground shadow-[0_0_15px_hsl(var(--primary)/0.3)] transition-colors hover:bg-primary/90"
              >
                <Plus className="h-3.5 w-3.5" /> {t("entries.addEntry")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Compact filter strip (studio only) */}
      {compact && (
        <div className="shrink-0 flex items-center gap-1.5 overflow-x-auto border-b border-border px-3 py-2 @[520px]:px-4">
          <button
            onClick={() => handleAddEntryInSection("system-presets")}
            data-tour="entries-add"
            className="flex h-7 shrink-0 items-center gap-1 rounded-lg bg-primary px-2 text-[11px] font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <Plus className="h-3 w-3" /> {t("entries.add")}
          </button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex h-7 min-w-0 shrink-0 items-center gap-1.5 rounded-lg border border-border/70 bg-card px-2 text-[11px] font-semibold text-foreground transition-colors hover:bg-accent">
                <SlidersHorizontal className="h-3 w-3 text-muted-foreground" />
                <span>{t("entries.filter")}</span>
                {activeTagFilters.size > 0 && (
                  <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary">
                    {activeTagFilters.size}
                  </span>
                )}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="z-[1300] w-56">
              <DropdownMenuItem
                onClick={() => setActiveTagFilters(new Set())}
                className="text-xs"
              >
                <span className="flex-1">{t("entries.all")}</span>
                <span className="text-[10px] text-muted-foreground">{worldDraft.entries.length}</span>
                {activeTagFilters.size === 0 && <Check className="h-3.5 w-3.5 text-primary" />}
              </DropdownMenuItem>
              {allTags.map((tag) => {
                const count = tagCounts[tag] ?? 0;
                if (count === 0 && !activeTagFilters.has(tag)) return null;
                return (
                  <DropdownMenuItem
                    key={tag}
                    onClick={() => toggleTagFilter(tag)}
                    className="text-xs"
                  >
                    <span className={cn("h-1.5 w-1.5 rounded-full", getTagColor(tag, worldDraft.customTagColors).replace("text-", "bg-"))} />
                    <span className="min-w-0 flex-1 truncate">{getTagLabel(tag, t)}</span>
                    <span className="text-[10px] text-muted-foreground">{count}</span>
                    {activeTagFilters.has(tag) && <Check className="h-3.5 w-3.5 text-primary" />}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* View mode toggle (compact) */}
          <div className="ml-auto flex h-7 shrink-0 items-center rounded-lg border border-border/70 bg-card p-0.5">
            <button
              type="button"
              onClick={() => {
                setViewMode("classic");
                try { localStorage.setItem("yumina-entries-view", "classic"); } catch { /* ignore */ }
              }}
              title={t("entries.viewClassic")}
              aria-label={t("entries.viewClassic")}
              className={cn(
                "flex h-6 w-6 items-center justify-center rounded-md transition-colors",
                viewMode === "classic" ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <List className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={() => {
                setViewMode("triggers");
                try { localStorage.setItem("yumina-entries-view", "triggers"); } catch { /* ignore */ }
              }}
              title={t("entries.viewTriggers")}
              aria-label={t("entries.viewTriggers")}
              className={cn(
                "flex h-6 w-6 items-center justify-center rounded-md transition-colors",
                viewMode === "triggers" ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <LayoutGrid className="h-3 w-3" />
            </button>
          </div>
          <button
            onClick={() => setShowSettings(!showSettings)}
            title={t("entries.entrySettings")}
            aria-label={t("entries.entrySettings")}
            className={cn(
              "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border transition-colors",
              showSettings
                ? "border-primary/50 bg-primary/10 text-primary"
                : "border-border/70 bg-card text-foreground hover:bg-accent",
            )}
          >
            <Settings2 className="h-3 w-3" />
          </button>
          <button
            onClick={() => setShowTagManager(true)}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-card text-foreground transition-colors hover:border-primary/30 hover:bg-primary/[0.06] hover:text-primary"
            title={t("entries.manageTags")}
            aria-label={t("entries.manageTags")}
          >
            <TagIcon className="h-3 w-3" />
          </button>
        </div>
      )}

      {compact && showSettings && (
        <div className="shrink-0 grid grid-cols-2 gap-2 border-b border-border bg-sidebar/70 px-3 py-2">
          <label className="min-w-0">
            <span className="mb-1 block truncate text-[10px] font-bold uppercase tracking-wide text-muted-foreground/70">
              {t("entries.scanDepth")}
            </span>
            <NumberInput
              value={worldDraft.settings.lorebookScanDepth ?? 2}
              onChange={(val) => setSettings("lorebookScanDepth", val === "" ? 2 : val)}
              min={1}
              max={50}
            />
          </label>
          <label className="min-w-0">
            <span className="mb-1 block truncate text-[10px] font-bold uppercase tracking-wide text-muted-foreground/70">
              {t("entries.recursionDepth")}
            </span>
            <NumberInput
              value={worldDraft.settings.lorebookRecursionDepth ?? 0}
              onChange={(val) => setSettings("lorebookRecursionDepth", val === "" ? 0 : Math.min(Math.max(val, 0), 10))}
              min={0}
              max={10}
            />
          </label>
        </div>
      )}

      {viewMode === "triggers" ? (
        <EntriesTriggerBoard
          onSelectEntry={(id) => {
            setViewMode("classic");
            try {
              localStorage.setItem("yumina-entries-view", "classic");
            } catch {
              /* ignore */
            }
            selectEntry(id);
          }}
          onOpenBindings={() => {
            setActiveSection("components");
            setCustomUiTab("bindings");
          }}
        />
      ) : (
      /* Two-panel body — single-column master/detail below the 640px container
         width (mobile + the narrow KB panel), side-by-side above it. compact
         shares this responsive model so the embedded KB editor doesn't force a
         cramped list+detail split on phones (matches the production entries UI). */
      <div className={cn("entries-section-body flex flex-1 min-h-0 overflow-hidden flex-col @[640px]:flex-row")}>
        {/* Left panel — section list */}
        <div className={cn(
          "entries-section-list flex min-h-0 flex-col border-border/45 bg-sidebar",
          compact
            ? "w-full border-b @[640px]:w-72 @[640px]:shrink-0 @[640px]:border-b-0 @[640px]:border-r"
            : "w-full border-b @[640px]:w-80 @[640px]:shrink-0 @[640px]:border-b-0 @[640px]:border-r",
          selectedId && "hidden @[640px]:flex"
        )}>
          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            {/* Entry Settings card */}
            {!compact && !mobileListMode && (
              <button
                onClick={() => setShowSettings(!showSettings)}
                className="mb-4 flex w-full items-center justify-between rounded-xl border border-border bg-card p-3.5 text-sm font-medium transition-colors hover:bg-accent group"
              >
                <div className="flex items-center gap-2.5 text-foreground">
                  <Settings2 className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground" />
                  {t("entries.entrySettings")}
                </div>
                <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", showSettings && "rotate-180")} />
              </button>
            )}

            {!compact && showSettings && (
              <div className="mb-4 space-y-4 rounded-xl border border-border bg-card p-4">
                <div>
                  <label className="mb-1.5 block text-sm font-bold text-foreground">{t("entries.scanDepth")}</label>
                  <NumberInput
                    value={worldDraft.settings.lorebookScanDepth ?? 2}
                    onChange={(val) => setSettings("lorebookScanDepth", val === "" ? 2 : val)}
                    min={1}
                    max={50}
                  />
                  <p className="mt-1 text-xs text-muted-foreground/40">{t("entries.scanDepthHint")}</p>
                </div>
                <div>
                  <label className="mb-1.5 block text-sm font-bold text-foreground">{t("entries.recursionDepth")}</label>
                  <NumberInput
                    value={worldDraft.settings.lorebookRecursionDepth ?? 0}
                    onChange={(val) => setSettings("lorebookRecursionDepth", val === "" ? 0 : Math.min(Math.max(val, 0), 10))}
                    min={0}
                    max={10}
                  />
                  <p className="mt-1 text-xs text-muted-foreground/40">{t("entries.recursionDepthHint")}</p>
                </div>
              </div>
            )}

            {/* Restore missing presets */}
            {missingPresets.length > 0 && (
              <button
                onClick={() => {
                  const newEntries = missingPresets.map((preset) => {
                    const defaults = deriveSectionDefaults(preset.section);
                    return {
                      id: crypto.randomUUID(),
                      name: preset.name,
                      content: preset.content,
                      role: "system" as const,
                      apiRole: preset.apiRole,
                      alwaysSend: defaults.alwaysSend,
                      keywords: [],
                      conditions: [],
                      conditionLogic: "all" as const,
                      enabled: true,
                      position: preset.position,
                      section: preset.section,
                      presetId: preset.presetId,
                      tags: ["Preset"],
                    } satisfies WorldEntry;
                  });
                  setField("entries", [...worldDraft.entries, ...newEntries]);
                }}
                className="mb-3 flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-indigo-500/30 bg-indigo-500/5 px-3 py-2.5 text-xs font-medium text-indigo-400 transition-colors hover:bg-indigo-500/10 hover:border-indigo-500/50"
              >
                <Shield className="h-3.5 w-3.5" />
                Add Official Presets ({missingPresets.length} missing)
              </button>
            )}

            {/* Sections with DnD */}
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragStart={handleDragStart}
              onDragOver={handleDragOver}
              onDragEnd={handleDragEnd}
            >
              <SortableContext items={allSortableIds} strategy={verticalListSortingStrategy}>
                {SECTION_META.map((meta) => {
                  const entries = sectionEntries[meta.id];
                  const folders = sectionFolders[meta.id];
                  const isCollapsed = collapsedSections.has(meta.id);

                  // Separate entries into foldered and unfoldered. Treat entries
                  // whose folderId points to a missing folder as unfoldered so they
                  // remain visible — otherwise the header count stays > 0 while the
                  // list silently goes empty.
                  const knownFolderIds = new Set(folders.map((f) => f.id));
                  const unfolderedEntries = entries.filter((e) => !e.folderId || !knownFolderIds.has(e.folderId));
                  const entriesByFolder = new Map<string, WorldEntry[]>();
                  for (const entry of entries) {
                    if (entry.folderId && knownFolderIds.has(entry.folderId)) {
                      if (!entriesByFolder.has(entry.folderId)) {
                        entriesByFolder.set(entry.folderId, []);
                      }
                      entriesByFolder.get(entry.folderId)!.push(entry);
                    }
                  }

                  return (
                    <div key={meta.id} className="mb-3">
                      <DroppableSectionHeader
                        section={meta.id}
                        label={meta.label}
                        hint={meta.hint}
                        entryCount={entries.length}
                        isCollapsed={isCollapsed}
                        isDragActive={!!dragActiveId}
                        onToggle={() => toggleSection(meta.id)}
                        onAddEntry={() => handleAddEntryInSection(meta.id)}
                        onAddFolder={() => handleAddFolderInSection(meta.id)}
                      >

                      {/* Chat History: message divider */}
                      {meta.id === "chat-history" && !isCollapsed && (
                        <div className="ml-5 flex items-center gap-2 px-2 py-1 text-[10px] text-muted-foreground/30 italic">
                          <MessageCircle className="h-3 w-3" />
                          ...messages...
                        </div>
                      )}

                      {/* Section body */}
                      {!isCollapsed && (
                        <div className="ml-5 space-y-0.5 mt-0.5">
                          {/* Folders (sortable) */}
                          {folders.map((folder) => {
                            const folderEntries = entriesByFolder.get(folder.id) ?? [];
                            const isFolderCollapsed = collapsedFolders.has(folder.id);
                            return (
                              <FolderCard
                                key={folder.id}
                                folder={folder}
                                entries={folderEntries}
                                isCollapsed={isFolderCollapsed}
                                isDropTarget={dragOverId === `folder:${folder.id}` && !!dragActiveId?.startsWith("entry:")}
                                onToggle={() => toggleFolder(folder.id)}
                                onRename={(name) => renameFolder(folder.id, name)}
                                onDelete={() => removeFolder(folder.id)}
                                onAddEntry={() => handleAddEntryInSection(meta.id, folder)}
                                selectedId={selectedId}
                                onSelectEntry={handleSelectEntry}
                                onDeleteEntry={handleDeleteEntry}
                                onDuplicateEntry={handleDuplicateEntry}
                                onRenameEntry={handleRenameEntry}
                                consumeAutoEdit={consumeAutoEdit}
                              />
                            );
                          })}

                          {/* Unfoldered entries */}
                          {unfolderedEntries.length === 0 && folders.length === 0 ? (
                            <div className="px-2 py-2 text-[11px] text-muted-foreground/40 italic">{t("entries.noEntriesLabel")}</div>
                          ) : (
                            unfolderedEntries.map((entry) => (
                              <SortableEntryCard
                                key={entry.id}
                                entry={entry}
                                sortableId={`entry:${entry.id}`}
                                isActive={selectedId === entry.id}
                                onSelect={handleSelectEntry}
                                onDelete={handleDeleteEntry}
                                onDuplicate={handleDuplicateEntry}
                                onRename={handleRenameEntry}
                                consumeAutoEdit={consumeAutoEdit}
                              />
                            ))
                          )}
                        </div>
                      )}
                      </DroppableSectionHeader>
                    </div>
                  );
                })}
              </SortableContext>

              <DragOverlay>
                {dragActiveEntry && (
                  <div className="rounded-lg border border-primary/30 bg-card px-3 py-2 text-sm font-bold text-primary shadow-lg">
                    {dragActiveEntry.name || t("entries.unnamed")}
                  </div>
                )}
                {dragActiveFolder && (
                  <div className="rounded-lg border border-amber-400/30 bg-card px-3 py-2 text-sm font-bold text-amber-400 shadow-lg">
                    {dragActiveFolder.name || t("entries.unnamedFolder")}
                  </div>
                )}
              </DragOverlay>
            </DndContext>

            {/* Empty state */}
            {worldDraft.entries.length === 0 && (
              <div className="px-4 py-10 text-center">
                <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-accent">
                  <FileText className="h-5 w-5 text-muted-foreground" />
                </div>
                <p className="text-sm font-medium text-muted-foreground">{t("entries.noEntries")}</p>
                <p className="mt-1.5 max-w-xs mx-auto text-xs text-muted-foreground/60">{t("entries.noEntriesDesc")}</p>
                <a href={DOCS_URLS.entries} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block text-xs text-primary hover:underline">{t("entries.learnMore")}</a>
              </div>
            )}
          </div>
          {/* Token breakdown footer — collapsed by default. Simple view shows
              the predictable per-turn baseline and the file total; expanding
              reveals 5 cost-meaningful buckets (greeting / alwaysSent /
              keywordTriggered / dormant / disabled). */}
          <div className="shrink-0 border-t border-border bg-card">
            <div className="relative flex items-center pr-3">
              <button
                type="button"
                onClick={toggleTokenView}
                className="flex flex-1 items-center justify-between px-5 py-2 text-xs text-muted-foreground transition-colors hover:bg-accent/40"
                title={t("entries.tokenBreakdown.toggleHint")}
              >
                <span className="flex items-center gap-2">
                  <ChevronRight
                    className={cn(
                      "h-3 w-3 transition-transform",
                      tokenViewExpanded && "rotate-90"
                    )}
                  />
                  <span>
                    <span className="opacity-70">{t("entries.tokenBreakdown.perTurnLabel")}</span>{" "}
                    ~{tokenSummary.perTurn.toLocaleString()}
                    <span className="mx-2 opacity-30">·</span>
                    <span className="opacity-70">{t("entries.tokenBreakdown.totalLabel")}</span>{" "}
                    ~{tokenSummary.total.toLocaleString()} tok
                  </span>
                </span>
              </button>
              {/* Health dot — uses HoverHint (portals to <body>) so the
                  popup escapes the editor's outer overflow-hidden container. */}
              <HoverHint
                side="top"
                align="end"
                width={320}
                content={t(`entries.tokenBreakdown.health${tokenSummary.health === "healthy" ? "Healthy" : tokenSummary.health === "caution" ? "Caution" : "Heavy"}`)}
              >
                <span
                  aria-label={t(`entries.tokenBreakdown.health${tokenSummary.health === "healthy" ? "Healthy" : tokenSummary.health === "caution" ? "Caution" : "Heavy"}`)}
                  className="shrink-0 cursor-help p-2"
                >
                  <span
                    className={cn(
                      "block h-2 w-2 rounded-full transition-colors",
                      tokenSummary.health === "healthy" && "bg-emerald-400/80 shadow-[0_0_6px_rgba(52,211,153,0.55)]",
                      tokenSummary.health === "caution" && "bg-amber-400/90 shadow-[0_0_6px_rgba(251,191,36,0.6)]",
                      tokenSummary.health === "heavy" && "bg-rose-400 shadow-[0_0_8px_rgba(251,113,133,0.7)] animate-pulse"
                    )}
                  />
                </span>
              </HoverHint>
            </div>
            {tokenViewExpanded && (
              <div className="space-y-1 border-t border-border/50 px-5 py-2.5 text-xs text-muted-foreground">
                <div
                  className="flex items-center justify-between"
                  title={
                    tokenSummary.greetingCount > 1
                      ? t("entries.tokenBreakdown.greetingHintMulti", { count: tokenSummary.greetingCount })
                      : t("entries.tokenBreakdown.greetingHint")
                  }
                >
                  <span>
                    {t("entries.tokenBreakdown.greeting")}
                    {tokenSummary.greetingCount > 1 && (
                      <span className="ml-1.5 opacity-50">×{tokenSummary.greetingCount}</span>
                    )}
                  </span>
                  <span className="tabular-nums">~{tokenSummary.greeting.toLocaleString()}</span>
                </div>
                <div
                  className="flex items-center justify-between"
                  title={t("entries.tokenBreakdown.alwaysSentHint")}
                >
                  <span>{t("entries.tokenBreakdown.alwaysSent")}</span>
                  <span className="tabular-nums">~{tokenSummary.alwaysSent.toLocaleString()}</span>
                </div>
                <div
                  className="flex items-center justify-between"
                  title={t("entries.tokenBreakdown.keywordTriggeredHint")}
                >
                  <span>{t("entries.tokenBreakdown.keywordTriggered")}</span>
                  <span className="tabular-nums">~{tokenSummary.keywordTriggered.toLocaleString()}</span>
                </div>
                <div
                  className="flex items-center justify-between"
                  title={t("entries.tokenBreakdown.dormantHint")}
                >
                  <span className={cn(tokenSummary.dormant > 0 && "text-amber-300/70")}>
                    {t("entries.tokenBreakdown.dormant")}
                  </span>
                  <span className="tabular-nums">~{tokenSummary.dormant.toLocaleString()}</span>
                </div>
                <div className="flex items-center justify-between opacity-60">
                  <span>{t("entries.tokenBreakdown.disabledLabel")}</span>
                  <span className="tabular-nums">~{tokenSummary.disabled.toLocaleString()}</span>
                </div>
                <div className="mt-1.5 flex items-center justify-between border-t border-border/50 pt-1.5 font-medium text-foreground/80">
                  <span>{t("entries.tokenBreakdown.totalLabel")}</span>
                  <span className="tabular-nums">~{tokenSummary.total.toLocaleString()} tok</span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right panel — entry form */}
        <div className={cn(
          "entries-section-detail min-h-0 flex-1 overflow-y-auto",
          !selectedId && "hidden @[640px]:flex"
        )}>
          {selected ? (
            <div className="p-8 lg:p-12" data-tour="entries-detail">
              {/* Back button — narrow mode only */}
              <button
                onClick={() => selectEntry(null)}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground @[640px]:hidden mb-4"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Back
              </button>
              <div className="mb-8 flex max-w-3xl items-center justify-between gap-2">
                <h2 className="text-xl font-bold text-foreground">{t("entries.editEntry")}</h2>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    onClick={() => duplicateAndSelect(selected.id, false)}
                    className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <Copy className="h-4 w-4" /> {t("entries.duplicate")}
                  </button>
                  <TwoTapDeleteButton
                    onConfirm={() => {
                      removeEntry(selected.id);
                      selectEntry(null);
                    }}
                    className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium text-destructive transition-colors hover:bg-destructive/10"
                    armedChildren={<><Trash2 className="h-4 w-4" /> {t("twoTapConfirm")}</>}
                  >
                    <Trash2 className="h-4 w-4" /> {t("entries.delete")}
                  </TwoTapDeleteButton>
                </div>
              </div>

              <div className="max-w-3xl space-y-8">
                {/* Cache-cost warning: keyword-triggered entry outside chat-history section
                    breaks prompt caching because it injects above the depth=5 breakpoint,
                    forcing every turn to re-process the full prefix when keywords match.
                    alwaysSend entries are exempt: they're part of the stable every-turn prefix
                    (engine excludes them from the keyword-triggered block), so their keywords
                    never gate injection and there is no cache break. */}
                {selected.keywords.length > 0 && !selected.alwaysSend && selected.section !== "chat-history" && (
                  <div className="flex items-start gap-3 rounded-xl border border-amber-400/30 bg-amber-500/5 px-4 py-3">
                    <AlertTriangle className="h-5 w-5 shrink-0 text-amber-400 mt-0.5" />
                    <div className="space-y-1 text-sm">
                      <div className="font-bold text-amber-300/90">{t("entries.cacheWarningTitle")}</div>
                      <div className="text-amber-200/70">{t("entries.cacheWarningDesc")}</div>
                    </div>
                  </div>
                )}

                {/* Name */}
                <div className="space-y-3">
                  <label className="text-sm font-bold text-foreground">{t("entries.name")}</label>
                  <DebouncedInput
                    type="text"
                    value={selected.name}
                    onCommit={(name) => updateEntry(selected.id, { name })}
                    syncKey={selected.id}
                    className="w-full rounded-xl border border-border bg-card px-4 py-3 text-sm text-foreground shadow-inner transition-all focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
                  />
                </div>

                {/* Worldbook (lore module) membership */}
                {scopeWorldbookId === undefined && worldbooks.length > 0 && (
                  <div className="space-y-2">
                    <label className="text-sm font-bold text-foreground">{t("entries.worldbookLabel")}</label>
                    <select
                      value={selected.worldbookId ?? ""}
                      onChange={(e) => setEntryWorldbook(selected.id, e.target.value || undefined)}
                      className="w-full rounded-xl border border-border bg-card px-4 py-2.5 text-sm text-foreground focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
                    >
                      <option value="">{t("entries.worldbookCore")}</option>
                      {worldbooks.map((wb) => (
                        <option key={wb.id} value={wb.id}>{wb.name}</option>
                      ))}
                    </select>
                    <p className="text-xs text-muted-foreground/60">{t("entries.worldbookHint")}</p>
                  </div>
                )}

                {/* Send as (hidden for examples — engine handles user/assistant pairs) */}
                {selected.section !== "examples" && (
                <div className="space-y-3">
                  <label className="text-sm font-bold text-foreground">{t("entries.sendAs")}</label>
                  <div className="flex gap-2">
                    {getSendAsOptions(t).map((opt) => {
                      const isSelected = (selected.apiRole ?? "system") === opt.value;
                      return (
                        <button
                          key={opt.value}
                          onClick={() => updateEntry(selected.id, { apiRole: opt.value })}
                          className={cn(
                            "flex-1 rounded-xl border px-3 py-2.5 text-sm font-medium transition-all",
                            isSelected
                              ? "border-primary/40 bg-primary/10 text-primary shadow-[0_0_10px_hsl(var(--primary)/0.1)]"
                              : "border-border bg-card text-muted-foreground hover:border-muted-foreground/30 hover:text-foreground"
                          )}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                  <p className="text-xs text-muted-foreground/60">
                    {getSendAsOptions(t).find((r) => r.value === (selected.apiRole ?? "system"))?.hint}
                  </p>
                </div>
                )}

                {/* Content */}
                <div className="space-y-3">
                  <label className="text-sm font-bold text-foreground">
                    {selected.section === "examples" ? t("entries.dialogue") : t("entries.content")}
                  </label>
                  {selected.section === "examples" ? (
                    <ExampleTurnsEditor
                      entry={selected}
                      onUpdate={(content) => updateEntry(selected.id, { content })}
                    />
                  ) : (
                    <EntryContentTextarea
                      entry={selected}
                      onChange={(content) => updateEntry(selected.id, { content })}
                      fallbackPlaceholder={t("entries.entryPlaceholder")}
                    />
                  )}
                  <div className="mt-1 flex items-center justify-between">
                    {selected.presetId ? (
                      <button
                        onClick={() => {
                          const official = OFFICIAL_PRESETS.find((p) => p.presetId === selected.presetId);
                          if (official) {
                            updateEntry(selected.id, { content: official.content, apiRole: official.apiRole, name: official.name });
                          }
                        }}
                        className="flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
                      >
                        <RotateCcw className="h-3 w-3" />
                        {t("entries.resetToOfficial")}
                      </button>
                    ) : <span />}
                    <p className="text-right text-xs text-muted-foreground/40">
                      ~{estimateTokens(selected.content).toLocaleString()} {estimateTokens(selected.content) === 1 ? "token" : "tokens"}
                    </p>
                  </div>
                </div>

                {/* Tags — pure toggle pills. Tag CRUD lives in TagManagerDialog. */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <label className="text-sm font-bold text-foreground">{t("entries.tags")}</label>
                    <button
                      onClick={() => setShowTagManager(true)}
                      className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/30 hover:bg-primary/[0.06] hover:text-primary"
                    >
                      <TagIcon className="h-3 w-3" />
                      {t("entries.manageTags")}
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {allTags.map((tag) => {
                      const isAssigned = (selected.tags ?? []).includes(tag);
                      return (
                        <button
                          key={tag}
                          onClick={() => {
                            const currentTags = selected.tags ?? [];
                            const newTags = isAssigned
                              ? currentTags.filter((t) => t !== tag)
                              : [...currentTags, tag];
                            updateEntry(selected.id, { tags: newTags });
                          }}
                          className={cn(
                            "rounded-full border px-3 py-1 text-xs font-medium transition-all",
                            isAssigned
                              ? "border-primary/30 bg-primary/10 text-primary"
                              : "border-border text-muted-foreground hover:border-muted-foreground/30 hover:text-foreground"
                          )}
                        >
                          {getTagLabel(tag, t)}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Depth (shown prominently for chat-history entries) */}
                {selected.section === "chat-history" && (
                  <div className="space-y-3 flex max-w-[200px] flex-col">
                    <label className="text-sm font-bold text-foreground">{t("entries.depth")}</label>
                    <NumberInput
                      value={selected.depth ?? 4}
                      onChange={(val) => updateEntry(selected.id, { depth: val === "" ? 4 : val })}
                      min={1}
                      max={100}
                    />
                    <p className="text-xs text-muted-foreground/40">
                      {t("entries.depthHint")}
                    </p>
                  </div>
                )}

                {/* Position — sort order within section */}
                <div className="space-y-3 flex max-w-[200px] flex-col">
                  <label className="text-sm font-bold text-foreground">{t("entries.position")}</label>
                  <NumberInput
                    value={selected.position ?? 0}
                    onChange={(val) => updateEntry(selected.id, { position: val === "" ? 0 : val })}
                    step={1}
                  />
                  <p className="text-xs text-muted-foreground/40">
                    {t("entries.positionHint")}
                  </p>
                </div>

                {/* Keywords (shown prominently for chat-history keyword entries — primary trigger mechanism) */}
                {selected.section === "chat-history" && !selected.alwaysSend && (
                  <div className="space-y-3">
                    <label className="text-sm font-bold text-foreground">
                      {t("entries.keywords")}
                    </label>
                    <KeywordsInput
                      value={selected.keywords}
                      onChange={(next) => updateEntry(selected.id, { keywords: next })}
                      placeholder={t("entries.keywordsPlaceholder")}
                      showHint={false}
                    />
                    <p className="text-xs text-muted-foreground/40">
                      {t("entries.keywordsHint")}
                    </p>
                  </div>
                )}

                {/* Trigger mode */}
                <div className="space-y-4 border-t border-border pt-6">
                  <div className="space-y-2">
                    <label className="text-sm font-bold text-foreground">
                      {t("entries.triggerMode")}
                    </label>
                    <div className="inline-flex rounded-lg border border-border bg-card p-1">
                      <button
                        type="button"
                        onClick={() => {
                          if (!entryUsesVariableBinding(selected)) return;
                          updateEntry(selected.id, {
                            variableBound: false,
                            conditions: [],
                          });
                        }}
                        className={cn(
                          "rounded-md px-4 py-1.5 text-xs font-bold transition-colors",
                          !entryUsesVariableBinding(selected)
                            ? "bg-primary text-primary-foreground"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {t("entries.triggerModeManual")}
                      </button>
                      <button
                        type="button"
                        disabled={(worldDraft.variables ?? []).length === 0}
                        onClick={() => {
                          if (entryUsesVariableBinding(selected)) return;
                          const vars = worldDraft.variables ?? [];
                          if (vars.length === 0) return;
                          updateEntry(selected.id, {
                            variableBound: true,
                            alwaysSend: false,
                            enabled: true,
                            conditions:
                              (selected.conditions ?? []).length > 0
                                ? selected.conditions
                                : [defaultConditionForVariable(vars[0]!)],
                          });
                        }}
                        className={cn(
                          "rounded-md px-4 py-1.5 text-xs font-bold transition-colors disabled:opacity-40",
                          entryUsesVariableBinding(selected)
                            ? "bg-primary text-primary-foreground"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {t("entries.triggerModeVariable")}
                      </button>
                    </div>
                    {(worldDraft.variables ?? []).length === 0 && (
                      <p className="text-xs text-muted-foreground/50">
                        {t("entries.variableBindNoVars")}
                      </p>
                    )}
                  </div>

                  {entryUsesVariableBinding(selected) ? (
                    <div className="space-y-4 rounded-xl border border-primary/20 bg-primary/[0.04] p-4">
                      <p className="text-xs leading-relaxed text-muted-foreground">
                        {t("entries.variableBindExplain")}
                      </p>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-xs font-bold text-foreground">
                          {t("entries.whenConditions")}
                        </span>
                        <div className="flex rounded-lg border border-border bg-card p-1">
                          <button
                            type="button"
                            onClick={() => updateEntry(selected.id, { conditionLogic: "all" })}
                            className={cn(
                              "rounded-md px-3 py-1 text-xs font-bold transition-colors",
                              (selected.conditionLogic ?? "all") === "all"
                                ? "bg-primary text-primary-foreground"
                                : "text-muted-foreground hover:text-foreground",
                            )}
                          >
                            ALL
                          </button>
                          <button
                            type="button"
                            onClick={() => updateEntry(selected.id, { conditionLogic: "any" })}
                            className={cn(
                              "rounded-md px-3 py-1 text-xs font-bold transition-colors",
                              selected.conditionLogic === "any"
                                ? "bg-primary text-primary-foreground"
                                : "text-muted-foreground hover:text-foreground",
                            )}
                          >
                            ANY
                          </button>
                        </div>
                      </div>
                      <ConditionEditor
                        conditions={selected.conditions ?? []}
                        variables={worldDraft.variables ?? []}
                        onChange={(conditions) =>
                          updateEntry(selected.id, {
                            conditions,
                            variableBound: conditions.length > 0,
                          })
                        }
                      />
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                      <StyledCheckbox
                        checked={selected.enabled}
                        onChange={(v) => updateEntry(selected.id, { enabled: v })}
                        label={t("entries.enabled")}
                      />
                      <StyledCheckbox
                        checked={selected.alwaysSend}
                        onChange={(v) => {
                          const needsWarning =
                            !v &&
                            (selected.section === "system-presets" ||
                              selected.section === "examples");
                          if (needsWarning && !confirmAlwaysSendOff) {
                            setConfirmAlwaysSendOff(true);
                            return;
                          }
                          setConfirmAlwaysSendOff(false);
                          updateEntry(selected.id, { alwaysSend: v });
                        }}
                        label={t("entries.alwaysSend")}
                        hint={
                          (selected.section === "system-presets" ||
                            selected.section === "examples") &&
                          !confirmAlwaysSendOff
                            ? t("entries.alwaysSendRecommended")
                            : undefined
                        }
                      />
                    </div>
                  )}
                </div>

                {/* Cache warning — centered modal dialog */}
                <Dialog open={confirmAlwaysSendOff} onOpenChange={setConfirmAlwaysSendOff}>
                  <DialogContent className="max-w-sm">
                    <DialogHeader>
                      <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-amber-500/10">
                        <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5 text-amber-400" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                          <line x1="12" y1="9" x2="12" y2="13" />
                          <line x1="12" y1="17" x2="12.01" y2="17" />
                        </svg>
                      </div>
                      <DialogTitle className="text-center text-amber-300/90">{t("entries.alwaysSendWarningTitle")}</DialogTitle>
                      <DialogDescription className="text-center">
                        {t("entries.alwaysSendWarningDesc")}
                      </DialogDescription>
                    </DialogHeader>
                    <DialogFooter className="mt-2 flex gap-2 sm:justify-center">
                      <button
                        onClick={() => setConfirmAlwaysSendOff(false)}
                        className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      >
                        {t("entries.cancel")}
                      </button>
                      <button
                        onClick={() => {
                          setConfirmAlwaysSendOff(false);
                          updateEntry(selected.id, { alwaysSend: false });
                        }}
                        className="rounded-lg bg-amber-500/15 px-4 py-2 text-sm font-semibold text-amber-300 transition-colors hover:bg-amber-500/25"
                      >
                        {t("entries.disableAlwaysSend")}
                      </button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>

                {/* Advanced (collapsed) — keywords, matching, recursion */}
                {/* Hidden for always-sent sections (no keyword triggering) */}
                {((selected.section !== "system-presets" && selected.section !== "examples") || !selected.alwaysSend) && (
                <div className="space-y-5">
                  <button
                    onClick={() => setShowAdvanced(!showAdvanced)}
                    className="group flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <ChevronDown
                      className={cn("h-4 w-4 transition-transform duration-200 group-hover:text-primary", !showAdvanced && "-rotate-90")}
                    />
                    {t("entries.advanced")}
                    {selected.keywords.length > 0 && !(selected.section === "chat-history" && !selected.alwaysSend) && (
                      <span className="rounded-full bg-accent px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {t("entries.keywordsCount", { count: selected.keywords.length })}
                      </span>
                    )}
                  </button>

                  {showAdvanced && (
                    <div className="ml-2 space-y-6 border-l border-border pl-6">
                      {/* Keywords (only in Advanced for sections that don't show it above; chat-history keyword entries have it promoted) */}
                      {!(selected.section === "chat-history" && !selected.alwaysSend) && (
                      <div className="space-y-3">
                        <label className="text-sm font-bold text-foreground">
                          {t("entries.keywords")}
                        </label>
                        <KeywordsInput
                          value={selected.keywords}
                          onChange={(next) => updateEntry(selected.id, { keywords: next })}
                          placeholder={t("entries.keywordsPlaceholder")}
                        />
                      </div>
                      )}

                      {/* Secondary Keywords */}
                      <div className="space-y-3">
                        <label className="text-sm font-bold text-foreground">
                          {t("entries.secondaryKeywords")}
                        </label>
                        <KeywordsInput
                          value={selected.secondaryKeywords ?? []}
                          onChange={(next) => updateEntry(selected.id, { secondaryKeywords: next })}
                          placeholder={t("entries.secondaryKeywordsPlaceholder")}
                        />
                      </div>

                      {/* Secondary Logic */}
                      {(selected.secondaryKeywords ?? []).length > 0 && (
                        <div className="space-y-3">
                          <label className="text-sm font-bold text-foreground">{t("entries.secondaryLogicLabel")}</label>
                          <select
                            value={selected.secondaryKeywordLogic ?? "AND_ANY"}
                            onChange={(e) =>
                              updateEntry(selected.id, {
                                secondaryKeywordLogic: e.target.value as WorldEntry["secondaryKeywordLogic"],
                              })
                            }
                            className="w-full rounded-xl border border-border bg-card px-4 py-3 text-sm text-foreground transition-all focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/50 [&>option]:bg-popover"
                          >
                            {SECONDARY_LOGIC_OPTIONS.map((opt) => (
                              <option key={opt.value} value={opt.value}>
                                {opt.label} — {opt.hint}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}

                      {/* Keyword matching options */}
                      <div className="flex items-center gap-6">
                        <StyledCheckbox
                          checked={selected.matchWholeWords ?? false}
                          onChange={(v) => updateEntry(selected.id, { matchWholeWords: v })}
                          label={t("entries.wholeWord")}
                        />
                      </div>

                      {/* Recursion toggles — only meaningful when global recursion depth > 0 */}
                      {(worldDraft.settings.lorebookRecursionDepth ?? 0) > 0 && (
                        <div className="flex items-center gap-6">
                          <StyledCheckbox
                            checked={selected.preventRecursion ?? false}
                            onChange={(v) => updateEntry(selected.id, { preventRecursion: v })}
                            label={t("entries.preventRecursion")}
                          />
                          <StyledCheckbox
                            checked={selected.excludeRecursion ?? false}
                            onChange={(v) => updateEntry(selected.id, { excludeRecursion: v })}
                            label={t("entries.excludeRecursion")}
                          />
                        </div>
                      )}
                    </div>
                  )}
                </div>
                )}

                <div className="pb-12" />
              </div>
            </div>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center pb-20 text-center opacity-50">
              <FileText className="mb-4 h-16 w-16 text-muted-foreground opacity-50" />
              <h2 className="mb-2 text-xl font-bold text-foreground">{t("entries.emptyTitle")}</h2>
            </div>
          )}
        </div>
      </div>
      )}

      <TagManagerDialog open={showTagManager} onClose={() => setShowTagManager(false)} />
    </div>
  );
}

// ── Reusable components ──

/** Entry content textarea — shows the template's i18n placeholder when the
 *  entry was seeded by a template (tag `template-content:...`) and is still
 *  empty. Falls back to the generic placeholder for non-template entries. */
function EntryContentTextarea({
  entry,
  onChange,
  fallbackPlaceholder,
}: {
  entry: WorldEntry;
  onChange: (content: string) => void;
  fallbackPlaceholder: string;
}) {
  const templatePlaceholder = useTemplateContentPlaceholder(entry);
  // This was the original hand-rolled debounce that useDebouncedFieldCommit was
  // extracted from — but it predated the `_undoEpoch` override, so a store
  // undo() while the textarea was focused never resynced the visible text
  // (token count rolled back, text didn't), and the next blur flushed the stale
  // text back over the rollback. The shared component carries the fix.
  return (
    <DebouncedTextarea
      value={entry.content ?? ""}
      onCommit={onChange}
      syncKey={entry.id}
      rows={8}
      placeholder={templatePlaceholder || fallbackPlaceholder}
      className="min-h-[160px] w-full resize-y rounded-xl border border-border bg-card px-4 py-4 font-mono text-sm leading-relaxed text-foreground shadow-inner transition-all placeholder:whitespace-pre-line placeholder:text-muted-foreground/30 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
    />
  );
}

/** Tiny segmented toggle that switches the tag-filter logic between OR/AND.
 *  Only rendered when the user has >=2 active tag filters — for a single
 *  filter the modes are equivalent, so showing the control would be noise. */
function FilterModeToggle({
  mode,
  onChange,
  t,
}: {
  mode: "or" | "and";
  onChange: (mode: "or" | "and") => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: (key: any) => string;
}) {
  return (
    <div className="ml-1 inline-flex shrink-0 items-center rounded-full border border-border bg-card p-0.5">
      <button
        onClick={() => onChange("or")}
        title={t("entries.filterMode.anyHint")}
        className={cn(
          "rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide transition-colors",
          mode === "or"
            ? "bg-primary/15 text-primary"
            : "text-muted-foreground hover:text-foreground"
        )}
      >
        {t("entries.filterMode.any")}
      </button>
      <button
        onClick={() => onChange("and")}
        title={t("entries.filterMode.allHint")}
        className={cn(
          "rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide transition-colors",
          mode === "and"
            ? "bg-primary/15 text-primary"
            : "text-muted-foreground hover:text-foreground"
        )}
      >
        {t("entries.filterMode.all")}
      </button>
    </div>
  );
}

function DroppableSectionHeader({
  section,
  label,
  hint,
  entryCount,
  isCollapsed,
  isDragActive,
  onToggle,
  onAddEntry,
  onAddFolder,
  children,
}: {
  section: Section;
  label: string;
  hint?: string;
  entryCount: number;
  isCollapsed: boolean;
  isDragActive: boolean;
  onToggle: () => void;
  onAddEntry: () => void;
  onAddFolder: () => void;
  children?: React.ReactNode;
}) {
  const { t } = useTranslation("editor");
  const { setNodeRef, isOver } = useDroppable({ id: `section:${section}` });
  const showDropHighlight = isDragActive && isOver;

  return (
    <div ref={setNodeRef}>
      <div className={cn(
        "flex items-center gap-1.5 rounded-lg px-2 py-1.5 group/sh transition-colors",
        showDropHighlight
          ? "bg-primary/10 ring-1 ring-primary/40"
          : "hover:bg-muted/50"
      )}>
        <button onClick={onToggle} className="text-muted-foreground">
          {isCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </button>
        <div className="flex-1 min-w-0">
          <span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
            {label}
          </span>
          {hint && (
            <span className="ml-1.5 text-[9px] text-muted-foreground/40 normal-case tracking-normal font-normal">
              {hint}
            </span>
          )}
        </div>
        <span className="rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-bold text-muted-foreground">
          {entryCount}
        </span>
        {/* Section [+] dropdown: Entry or Folder */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className="touch-reveal opacity-0 group-hover/sh:opacity-100 text-muted-foreground hover:text-primary transition-opacity"
              title={`Add to ${label}`}
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onAddEntry}>
              <Plus className="mr-2 h-3.5 w-3.5" /> {t("entries.newEntry")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onAddFolder}>
              <FolderOpen className="mr-2 h-3.5 w-3.5" /> {t("entries.newFolder")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {children}
    </div>
  );
}

// PERF: memoized so editing one entry doesn't re-render all 200-1000+ rows.
// Props are referentially stable across parent renders (entry object identity is
// preserved for unchanged entries by updateEntry; the on* handlers are id-keyed
// useCallbacks), so memo's shallow compare skips every row except the one that
// actually changed (plus the two whose isActive flips on selection).
const SortableEntryCard = memo(function SortableEntryCard({
  entry,
  sortableId,
  isActive,
  onSelect,
  onDelete,
  onDuplicate,
  onRename,
  consumeAutoEdit,
}: {
  entry: WorldEntry;
  sortableId?: string;
  isActive: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  onRename: (id: string, name: string) => void;
  /** True exactly once, for the row a duplicate just created — it opens in
   *  rename mode because renaming the copy is always the next action. */
  consumeAutoEdit?: (id: string) => boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: sortableId ?? `entry:${entry.id}` });
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(entry.name);
  const inputRef = useRef<HTMLInputElement>(null);
  const { t } = useTranslation("editor");

  // Mount-only: a freshly duplicated row starts in rename mode with the name
  // selected, so the creator can type straight over "… (copy)".
  useEffect(() => {
    if (!consumeAutoEdit?.(entry.id)) return;
    setEditName(entry.name);
    setIsEditing(true);
    const timer = setTimeout(() => inputRef.current?.select(), 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Per-bundle color + name for entries imported from a bundle. Two primitive
  // selectors keep this memo-stable without any delimiter encoding.
  const bundleColorKey = useEditorStore((s) =>
    entry.bundleInstallId
      ? s.worldDraft.installedBundles?.find((b) => b.installId === entry.bundleInstallId)?.colorKey
      : undefined,
  );
  const bundleName = useEditorStore((s) =>
    entry.bundleInstallId
      ? s.worldDraft.installedBundles?.find((b) => b.installId === entry.bundleInstallId)?.name
      : undefined,
  );
  const uiSlotId = useEditorStore((s) =>
    getEntryBoundSlotId(
      entry.id,
      normalizeLoreUiBindingsList(s.worldDraft.loreUiBindings),
    ),
  );
  // Narrow primitive selector (memo-stable) for the entry's worldbook name.
  const worldbookName = useEditorStore((s) =>
    entry.worldbookId
      ? s.worldDraft.worldbooks?.find((w) => w.id === entry.worldbookId)?.name
      : undefined,
  );
  const variables = useEditorStore((s) => s.worldDraft.variables ?? []);
  const bundleColor = bundleColorKey ? getBundleColor(bundleColorKey) : null;

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const apiRole = entry.apiRole ?? "system";

  const handleStartEdit = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setEditName(entry.name);
    setIsEditing(true);
    setTimeout(() => inputRef.current?.select(), 0);
  }, [entry.name]);

  const handleFinishEdit = useCallback(() => {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== entry.name) {
      onRename(entry.id, trimmed);
    }
    setIsEditing(false);
  }, [editName, entry.id, entry.name, onRename]);

  return (
    <div ref={setNodeRef} style={style} className="group/entry flex items-center">
      <button
        {...attributes}
        {...listeners}
        className="shrink-0 cursor-grab p-2.5 -m-1.5 touch-none text-muted-foreground/30 hover:text-muted-foreground active:cursor-grabbing"
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <div
        onClick={() => onSelect(entry.id)}
        className={cn(
          "flex flex-1 items-center gap-2 rounded-lg px-2 py-2 text-left transition-all min-w-0 cursor-pointer",
          isActive
            ? "border border-primary/30 bg-primary/[0.06] shadow-[0_0_10px_hsl(var(--primary)/0.06)]"
            : "border border-transparent hover:bg-accent",
          entry.presetId && !isActive && "border-l-2 border-l-indigo-500/40",
          bundleColor && !isActive && cn("border-l-2", bundleColor.border)
        )}
      >
        {isEditing ? (
          <input
            ref={inputRef}
            type="text"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onBlur={handleFinishEdit}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === "Enter") handleFinishEdit();
              if (e.key === "Escape") setIsEditing(false);
            }}
            onClick={(e) => e.stopPropagation()}
            className="flex-1 min-w-0 rounded border border-primary/50 bg-card px-1.5 py-0.5 text-sm font-bold text-foreground focus:outline-none"
            autoFocus
          />
        ) : (
          <>
            {entry.presetId && (
              <Shield className="h-3 w-3 shrink-0 text-indigo-400/60" />
            )}
            {bundleColor && (
              <span
                className={cn("h-2 w-2 shrink-0 rounded-full", bundleColor.dot)}
                title={bundleName ? t("entries.fromBundleNamed", { name: bundleName }) : t("entries.fromBundle")}
              />
            )}
            <span
              className={cn(
                "text-sm font-bold truncate flex-1 min-w-0",
                isActive ? "text-primary" : "text-foreground",
                !entry.enabled && !isVariableBoundEntry(entry) && "opacity-40",
              )}
              onDoubleClick={handleStartEdit}
            >
              {entry.name || t("entries.unnamed")}
            </span>
          </>
        )}

        {entry.section === "chat-history" && (
          <span className="shrink-0 rounded bg-secondary px-1 py-0.5 text-[9px] font-bold text-muted-foreground">
            D:{entry.depth ?? 4}
          </span>
        )}

        {worldbookName && (
          <span
            className="shrink-0 max-w-[7rem] truncate rounded bg-sky-500/15 px-1.5 py-0.5 text-[9px] font-bold text-sky-300"
            title={t("entries.worldbookBadge", { name: worldbookName })}
          >
            {worldbookName}
          </span>
        )}

        {entry.keywords.length > 0 && !entry.alwaysSend && entry.section !== "chat-history" && (
          <span
            className="shrink-0 flex items-center"
            title="Keyword-triggered entry outside chat-history breaks prompt caching — move to chat-history section"
          >
            <AlertTriangle className="h-3 w-3 text-amber-400" />
          </span>
        )}

        {uiSlotId && (
          <span
            className="shrink-0 max-w-[7rem] truncate rounded bg-primary/15 px-1.5 py-0.5 text-[9px] font-bold text-primary"
            title={t("entries.uiBindBadge", { slot: uiSlotId })}
          >
            UI:{uiSlotId}
          </span>
        )}

        {isVariableBoundEntry(entry) && (
          <span
            className="shrink-0 rounded bg-violet-500/15 px-1 py-0.5 text-[9px] font-bold text-violet-400"
            title={t("entries.variableBindExplain")}
          >
            {t("entries.variableBoundBadge")}
          </span>
        )}

        {(entry.conditions ?? []).slice(0, 2).map((cond, i) => (
          <span
            key={`${cond.variableId}-${i}`}
            className="shrink-0 max-w-[7rem] truncate rounded bg-violet-500/10 px-1 py-0.5 text-[9px] font-medium text-violet-300/90"
            title={formatConditionLabel(cond, variables)}
          >
            {formatConditionLabel(cond, variables)}
          </span>
        ))}
        {(entry.conditions ?? []).length > 2 && (
          <span className="shrink-0 text-[9px] font-medium text-muted-foreground/60">
            +{(entry.conditions ?? []).length - 2}
          </span>
        )}

        {apiRole !== "system" && (
          <span
            className={cn(
              "shrink-0 rounded px-1 py-0.5 text-[9px] font-bold",
              apiRole === "user" ? "bg-secondary text-primary/80" : "bg-secondary text-muted-foreground"
            )}
          >
            {apiRole === "user" ? "USR" : "AI"}
          </span>
        )}

        {/* Hover actions: rename + duplicate + delete (touch-reveal keeps them
            visible where hover doesn't exist). Duplicate is non-destructive, so
            unlike delete it needs no two-tap confirm. */}
        {!isEditing && (
          <div className="touch-reveal shrink-0 flex items-center gap-0.5 opacity-0 group-hover/entry:opacity-100 transition-opacity">
            <button
              onClick={handleStartEdit}
              className="p-0.5 text-muted-foreground/40 hover:text-foreground"
              title={t("entries.rename")}
            >
              <Pencil className="h-3 w-3" />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onDuplicate(entry.id); }}
              className="p-0.5 text-muted-foreground/40 hover:text-foreground"
              title={t("entries.duplicate")}
            >
              <Copy className="h-3 w-3" />
            </button>
            <TwoTapDeleteButton
              onConfirm={() => onDelete(entry.id)}
              className="p-0.5 text-muted-foreground/40 hover:text-destructive"
              armedClassName="rounded-sm bg-destructive text-destructive-foreground"
              title={t("entries.delete")}
              armedTitle={t("twoTapConfirm")}
            >
              <Trash2 className="h-3 w-3" />
            </TwoTapDeleteButton>
          </div>
        )}
      </div>
    </div>
  );
});

function FolderCard({
  folder,
  entries,
  isCollapsed,
  isDropTarget,
  onToggle,
  onRename,
  onDelete,
  onAddEntry,
  selectedId,
  onSelectEntry,
  onDeleteEntry,
  onDuplicateEntry,
  onRenameEntry,
  consumeAutoEdit,
}: {
  folder: EntryFolder;
  entries: WorldEntry[];
  isCollapsed: boolean;
  isDropTarget?: boolean;
  onToggle: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onAddEntry: () => void;
  selectedId: string | null;
  onSelectEntry: (id: string) => void;
  onDeleteEntry: (id: string) => void;
  onDuplicateEntry: (id: string) => void;
  onRenameEntry: (id: string, name: string) => void;
  consumeAutoEdit?: (id: string) => boolean;
}) {
  const { t } = useTranslation("editor");
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(folder.name);
  const inputRef = useRef<HTMLInputElement>(null);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: `folder:${folder.id}` });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const handleFinishEdit = () => {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== folder.name) {
      onRename(trimmed);
    }
    setIsEditing(false);
  };

  return (
    <div ref={setNodeRef} style={style} className="mb-1">
      {/* Folder header — card-like styling matching entry cards */}
      <div className={cn(
        "group/folder flex items-center gap-1.5 rounded-lg border px-2 py-2 transition-colors",
        isDropTarget
          ? "border-primary/50 bg-primary/[0.06] ring-2 ring-primary/30"
          : "border-border bg-card hover:bg-accent"
      )}>
        <button
          {...attributes}
          {...listeners}
          className="shrink-0 cursor-grab p-2.5 -m-1.5 touch-none text-muted-foreground/30 hover:text-muted-foreground active:cursor-grabbing"
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <button onClick={onToggle} className="text-muted-foreground">
          {isCollapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        </button>
        {isCollapsed ? (
          <FolderClosed className="h-3.5 w-3.5 text-muted-foreground/60" />
        ) : (
          <FolderOpen className="h-3.5 w-3.5 text-muted-foreground/60" />
        )}

        {isEditing ? (
          <input
            ref={inputRef}
            type="text"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onBlur={handleFinishEdit}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === "Enter") handleFinishEdit();
              if (e.key === "Escape") setIsEditing(false);
            }}
            className="flex-1 min-w-0 rounded border border-primary/50 bg-card px-1.5 py-0.5 text-sm font-bold text-foreground focus:outline-none"
            autoFocus
          />
        ) : (
          <span
            className="flex-1 text-sm font-bold text-foreground truncate cursor-pointer"
            onDoubleClick={() => {
              setEditName(folder.name);
              setIsEditing(true);
              setTimeout(() => inputRef.current?.select(), 0);
            }}
          >
            {folder.name}
          </span>
        )}

        <span className="rounded-full bg-accent px-1.5 py-0.5 text-[9px] font-bold text-muted-foreground">
          {entries.length}
        </span>

        {!isEditing && (
          <button
            type="button"
            onClick={onAddEntry}
            className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-primary focus-visible:outline focus-visible:outline-primary"
            title={t("entries.addEntry")}
            aria-label={`${t("entries.addEntry")} · ${folder.name}`}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        )}
        {!isEditing && (
          <div className="touch-reveal flex items-center gap-0.5 opacity-0 group-hover/folder:opacity-100 transition-opacity">
            <button
              onClick={() => {
                setEditName(folder.name);
                setIsEditing(true);
                setTimeout(() => inputRef.current?.select(), 0);
              }}
              className="p-0.5 text-muted-foreground/40 hover:text-foreground"
              title={t("entries.renameFolder")}
            >
              <Pencil className="h-3 w-3" />
            </button>
            <TwoTapDeleteButton
              onConfirm={onDelete}
              className="p-0.5 text-muted-foreground/40 hover:text-destructive"
              armedClassName="rounded-sm bg-destructive text-destructive-foreground"
              title={t("entries.deleteFolder")}
              armedTitle={t("twoTapConfirm")}
            >
              <Trash2 className="h-3 w-3" />
            </TwoTapDeleteButton>
          </div>
        )}
      </div>

      {/* Folder entries (indented with left-border connector) */}
      {!isCollapsed && (
        <div className="ml-4 border-l-2 border-amber-400/15 pl-2 space-y-0.5 mt-0.5">
          {entries.length === 0 ? (
            <div className="px-2 py-1 text-[10px] text-muted-foreground/30 italic">{t("entries.emptyFolder")}</div>
          ) : (
            entries.map((entry) => (
              <SortableEntryCard
                key={entry.id}
                entry={entry}
                sortableId={`entry:${entry.id}`}
                isActive={selectedId === entry.id}
                onSelect={onSelectEntry}
                onDelete={onDeleteEntry}
                onDuplicate={onDuplicateEntry}
                onRename={onRenameEntry}
                consumeAutoEdit={consumeAutoEdit}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ── Example turns editor ──

function ExampleTurnsEditor({
  entry,
  onUpdate,
}: {
  entry: WorldEntry;
  onUpdate: (content: string) => void;
}) {
  const turns = useMemo(() => parseExampleContent(entry.content), [entry.content]);
  const { t: tr } = useTranslation("editor");

  const updateTurn = (index: number, updates: Partial<ExampleTurn>) => {
    const newTurns = turns.map((t, i) => (i === index ? { ...t, ...updates } : t));
    onUpdate(serializeTurns(newTurns));
  };

  const addTurn = () => {
    const lastRole = turns.length > 0 ? turns[turns.length - 1].role : "assistant";
    const newRole = lastRole === "user" ? "assistant" : "user";
    onUpdate(serializeTurns([...turns, { role: newRole, content: "" }]));
  };

  const removeTurn = (index: number) => {
    onUpdate(serializeTurns(turns.filter((_, i) => i !== index)));
  };

  return (
    <div className="space-y-3">
      {turns.map((turn, i) => (
        <div key={i} className="flex gap-2 items-start">
          <button
            onClick={() => updateTurn(i, { role: turn.role === "user" ? "assistant" : "user" })}
            className={cn(
              "shrink-0 mt-2.5 w-12 rounded-md px-1.5 py-1 text-[11px] font-bold transition-colors text-center",
              turn.role === "user"
                ? "bg-primary/10 text-primary border border-primary/30"
                : "bg-secondary text-muted-foreground border border-border"
            )}
          >
            {turn.role === "user" ? "User" : "AI"}
          </button>
          <textarea
            value={turn.content}
            onChange={(e) => updateTurn(i, { content: e.target.value })}
            rows={2}
            placeholder={turn.role === "user" ? tr("extra.userMsg") : tr("extra.aiResponse")}
            className="flex-1 min-h-[60px] resize-y rounded-xl border border-border bg-card px-3 py-2.5 font-mono text-sm leading-relaxed text-foreground shadow-inner transition-all placeholder:text-muted-foreground/30 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
          />
          <button
            onClick={() => removeTurn(i)}
            className="shrink-0 mt-2.5 p-1 text-muted-foreground/40 hover:text-destructive transition-colors"
            title={tr("entries.removeTurn")}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <button
        onClick={addTurn}
        className="flex items-center gap-1.5 rounded-lg border border-dashed border-border px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/30 hover:text-primary"
      >
        <Plus className="h-3 w-3" /> Add message
      </button>
    </div>
  );
}
