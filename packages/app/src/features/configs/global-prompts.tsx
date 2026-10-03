import { useState, useEffect, useRef, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useRouter } from "@tanstack/react-router";
import {
  ChevronRight,
  Compass,
  Plus,
  Minus,
  Trash2,
  FolderPlus,
  Download,
  Upload,
  Pencil,
  ScrollText,
  X,
  Check,
} from "lucide-react";
import { useUserPromptsStore, type UserPromptItem, type PromptFolder } from "@/stores/user-prompts";
import { Select } from "@/components/ui/select";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { MODEL_FAMILIES, familyLabel } from "@/lib/model-families";

// ─── Constants ───────────────────────────────────────────────────────

export const PROMPTS_HUB_PATH = "/app/prompts";

/** Section labels are i18n keys under `unrestrict:prompts.section*`. */
const SECTION_VALUES = ["system-presets", "chat-history", "post-history"] as const;
const SECTION_KEYS: Record<string, "system" | "inChat" | "final"> = {
  "system-presets": "system",
  "chat-history": "inChat",
  "post-history": "final",
};

function useSectionOptions() {
  const { t } = useTranslation("unrestrict");
  return useMemo(
    () => SECTION_VALUES.map((value) => ({ value, label: t(`prompts.sectionFull.${SECTION_KEYS[value]!}`) })),
    [t],
  );
}

// ─── Small UI atoms (theme tokens only) ──────────────────────────────

function Chip({ children, tone = "plain" }: { children: ReactNode; tone?: "plain" | "gold" }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium leading-4",
        tone === "gold" ? "border-primary/40 bg-primary/10 text-primary" : "border-border bg-muted/60 text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

function Switch({
  checked,
  onChange,
  disabled,
  size = "md",
  label,
}: {
  checked: boolean;
  onChange?: (next: boolean) => void;
  disabled?: boolean;
  size?: "md" | "sm";
  label: string;
}) {
  const sm = size === "sm";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
      className={cn(
        "relative inline-flex shrink-0 items-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed",
        sm ? "h-5 w-9" : "h-6 w-11",
        checked ? "border-primary/60 bg-primary" : "border-border bg-muted",
        disabled && "opacity-60",
      )}
    >
      <span
        className={cn(
          "inline-block rounded-full shadow transition-transform",
          sm ? "h-3.5 w-3.5" : "h-4.5 w-4.5",
          checked ? "bg-primary-foreground" : "bg-muted-foreground/70",
          checked ? (sm ? "translate-x-[18px]" : "translate-x-[22px]") : "translate-x-[3px]",
        )}
      />
    </button>
  );
}

// ─── Shared field chrome ─────────────────────────────────────────────
// Every control in the add/edit forms sits in a grid cell and fills it, so
// they line up in columns at a uniform height instead of each taking its own
// natural width.

const FIELD_TRIGGER_CLASS =
  "h-9 rounded-lg border border-border bg-transparent px-2.5 py-0 text-xs text-foreground";

const FIELD_INPUT_CLASS =
  "profile-overview-input-surface h-9 w-full rounded-lg border border-border px-2.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50";

const FIELD_MENU_CLASS = "rounded-lg border border-border bg-popover p-1 text-foreground shadow-xl";

/** Labelled form cell. The label matters on touch, where the `title`
 *  tooltips these controls used to rely on never appear. */
function Field({
  label,
  title,
  children,
}: {
  label: string;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-1" title={title}>
      <span className="block text-[11px] font-medium text-muted-foreground">
        {label}
      </span>
      {children}
    </div>
  );
}

const ICON_BUTTON =
  "inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** Edit / delete on a row: revealed on hover. Touch screens drop them — a
 *  tap on the row opens the editor, which carries delete. */
const ROW_ICON_BUTTON =
  "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground opacity-0 transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:hidden";

// ─── Main Component ──────────────────────────────────────────────────

/**
 * The player's own prompts, with the per-model auto-binding on top.
 * `embedded`: rendered inside 设置 › 提示词, whose section header already names
 * it, so it brings no card chrome of its own. Otherwise (profile pages) it sits
 * in its own titled card.
 */
export function GlobalPrompts({ embedded = false }: { embedded?: boolean }) {
  const { t } = useTranslation("profile");
  const { t: tu } = useTranslation("unrestrict");
  const router = useRouter();

  const {
    prompts,
    folders,
    loading,
    fetchPrompts,
    updatePrompt,
    deletePrompt,
    createFolder,
    updateFolder,
    deleteFolder,
    importPrompts,
    setBinding,
  } = useUserPromptsStore();

  const [editingPromptId, setEditingPromptId] = useState<string | null>(null);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchPrompts();
    // Revalidate when the tab comes back into view — prompts are edited from
    // multiple devices, and mobile browsers park SPA tabs for days.
    const onVisible = () => {
      if (document.visibilityState === "visible") fetchPrompts();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [fetchPrompts]);

  const unfolderedPrompts = prompts.filter((p) => !p.folderId);
  const folderPrompts = (folderId: string) => prompts.filter((p) => p.folderId === folderId);

  const handleExport = async () => {
    try {
      const apiBase = import.meta.env.VITE_API_URL || "";
      const res = await fetch(`${apiBase}/api/user-prompts/export`, { credentials: "include" });
      if (!res.ok) return;
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "yumina-prompts.json";
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // handled by toast in store
    }
  };

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const json = JSON.parse(reader.result as string);
        importPrompts(json);
      } catch {
        // invalid json
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const enabledCount = prompts.filter((p) => p.enabled).length;
  const go = (path: string) => void router.navigate({ to: path } as never);
  const goCreate = () => void router.navigate({ to: "/app/prompts/upload", search: { from: "settings" } } as never);
  const isEmpty = prompts.length === 0 && folders.length === 0;
  const surface = embedded ? "profile-overview-glass profile-overview-glass--soft rounded-2xl" : "rounded-xl border border-border";

  const body = (
    <div className="space-y-4">
      {prompts.length > 0 && (
        <AutoBindSection surface={surface} prompts={prompts} onBind={setBinding} />
      )}

      <section className={surface}>
        <header className="flex items-center gap-2 py-3.5 pl-4 pr-3 sm:pl-5">
          <div className="min-w-0 flex-1">
            <h3 className="text-[15px] font-semibold text-foreground">{tu("prompts.mine")}</h3>
            {prompts.length > 0 && (
              <p className="mt-0.5 text-xs text-muted-foreground">{tu("prompts.mineCountLong", { total: prompts.length, on: enabledCount })}</p>
            )}
          </div>
          <div className="flex shrink-0 items-center">
            <button type="button" onClick={() => fileInputRef.current?.click()} className={ICON_BUTTON} title={t("customPrompts.importFromFile")} aria-label={t("customPrompts.importFromFile")}>
              <Download className="h-4 w-4" />
            </button>
            <button type="button" onClick={() => void handleExport()} className={ICON_BUTTON} title={t("customPrompts.exportPrompts")} aria-label={t("customPrompts.exportPrompts")}>
              <Upload className="h-4 w-4" />
            </button>
            <button type="button" onClick={() => createFolder(tu("prompts.newFolder"))} className={ICON_BUTTON} title={t("customPrompts.addFolder")} aria-label={t("customPrompts.addFolder")}>
              <FolderPlus className="h-4 w-4" />
            </button>
            <input ref={fileInputRef} type="file" accept=".json" onChange={handleImport} className="hidden" />
            <button
              type="button"
              onClick={goCreate}
              className="ml-1.5 inline-flex h-9 items-center gap-1 rounded-lg border border-primary/30 bg-primary/10 px-3 text-xs font-semibold text-primary transition-colors hover:bg-primary/20"
            >
              <Plus className="h-3.5 w-3.5" />
              {tu("prompts.new")}
            </button>
          </div>
        </header>

        {loading && isEmpty ? (
          <p className="border-t border-border/60 px-5 py-7 text-center text-xs text-muted-foreground/60">{t("customPrompts.loading")}</p>
        ) : isEmpty ? (
          <p className="border-t border-border/60 px-5 py-8 text-center text-sm text-muted-foreground">{tu("prompts.none")}</p>
        ) : (
          <div className="divide-y divide-border/60 border-t border-border/60">
            {folders.map((folder) => (
              <FolderGroup
                key={folder.id}
                folder={folder}
                prompts={folderPrompts(folder.id)}
                collapsed={collapsedFolders.has(folder.id)}
                onToggle={() => {
                  setCollapsedFolders((prev) => {
                    const next = new Set(prev);
                    if (next.has(folder.id)) next.delete(folder.id);
                    else next.add(folder.id);
                    return next;
                  });
                }}
                onUpdateFolder={updateFolder}
                onDeleteFolder={deleteFolder}
                editingId={editingPromptId}
                setEditingId={setEditingPromptId}
                onUpdatePrompt={updatePrompt}
                onDeletePrompt={deletePrompt}
              />
            ))}
            {unfolderedPrompts.map((prompt) => (
              <PromptRow
                key={prompt.id}
                prompt={prompt}
                editing={editingPromptId === prompt.id}
                onEdit={() => setEditingPromptId(prompt.id)}
                onCancelEdit={() => setEditingPromptId(null)}
                onUpdate={updatePrompt}
                onDelete={deletePrompt}
              />
            ))}
          </div>
        )}
      </section>

      <button
        type="button"
        onClick={() => go(PROMPTS_HUB_PATH)}
        className={cn("group flex w-full items-center gap-3.5 px-4 py-3.5 text-left transition-colors hover:border-primary/30 sm:px-5", surface)}
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Compass className="h-5 w-5" />
        </span>
        <span className="min-w-0 flex-1 text-sm font-semibold text-foreground">{tu("prompts.hubRow")}</span>
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5" />
      </button>
    </div>
  );

  if (embedded) return body;

  return (
    <Card className="profile-overview-glass profile-overview-glass--soft rounded-xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ScrollText className="h-5 w-5" />
          {tu("prompts.title")}
        </CardTitle>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}

// ─── Per-model auto-binding ──────────────────────────────────────────

/**
 * One row per model family: pick which installed prompt auto-applies when the
 * chat runs on a model of that family (or 「不启用」). Binding is exclusive per
 * family, handled server-side by PUT /api/user-prompts/bindings.
 */
function AutoBindSection({
  surface,
  prompts,
  onBind,
}: {
  surface: string;
  prompts: UserPromptItem[];
  onBind: (family: string, promptId: string | null) => Promise<void>;
}) {
  const { t: tu } = useTranslation("unrestrict");
  const otherLabel = tu("bindings.families.other");
  const promptOptions = useMemo(
    () => [{ value: "", label: tu("bindings.none") }, ...prompts.map((p) => ({ value: p.id, label: p.name }))],
    [prompts, tu],
  );

  return (
    <section className={surface}>
      <header className="py-3.5 pl-4 pr-3 sm:pl-5">
        <h3 className="text-[15px] font-semibold text-foreground">{tu("bindings.title")}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">{tu("bindings.hint")}</p>
      </header>
      <div className="divide-y divide-border/60 border-t border-border/60">
        {MODEL_FAMILIES.map((family) => {
          const current = prompts.find((p) => (p.autoModels ?? []).includes(family))?.id ?? "";
          return (
            <div key={family} className="flex items-center gap-3 py-2 pl-4 pr-3 sm:pl-5">
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                {familyLabel(family, otherLabel)}
              </span>
              <Select
                value={current}
                onValueChange={(v) => void onBind(family, v || null)}
                options={promptOptions}
                triggerClassName={cn(FIELD_TRIGGER_CLASS, "min-w-0 max-w-[60%]")}
                contentClassName={FIELD_MENU_CLASS}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}

function FormActions({
  onCancel,
  onSubmit,
  onDelete,
  submitLabel,
  disabled,
}: {
  onCancel: () => void;
  onSubmit: () => void;
  onDelete?: () => void;
  submitLabel: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation("profile");
  const { t: tc } = useTranslation("common");
  return (
    <div className="flex items-center justify-end gap-2 pt-1">
      {onDelete && (
        <button
          type="button"
          onClick={onDelete}
          className="mr-auto inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 className="h-3.5 w-3.5" />
          {tc("action.delete")}
        </button>
      )}
      <button
        type="button"
        onClick={onCancel}
        className="h-9 rounded-lg px-3.5 text-sm text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
      >
        {t("customPrompts.cancel")}
      </button>
      <button
        type="button"
        onClick={onSubmit}
        disabled={disabled}
        className="h-9 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
      >
        {submitLabel}
      </button>
    </div>
  );
}

// ─── Folder Group ────────────────────────────────────────────────────

function FolderGroup({
  folder,
  prompts,
  collapsed,
  onToggle,
  onUpdateFolder,
  onDeleteFolder,
  editingId,
  setEditingId,
  onUpdatePrompt,
  onDeletePrompt,
}: {
  folder: PromptFolder;
  prompts: UserPromptItem[];
  collapsed: boolean;
  onToggle: () => void;
  onUpdateFolder: (id: string, data: { name?: string; enabled?: boolean }) => Promise<void>;
  onDeleteFolder: (id: string) => Promise<void>;
  editingId: string | null;
  setEditingId: (id: string | null) => void;
  onUpdatePrompt: (id: string, data: Record<string, unknown>) => Promise<void>;
  onDeletePrompt: (id: string) => Promise<void>;
}) {
  const { t } = useTranslation("profile");
  const { t: tc } = useTranslation("common");
  const [editingName, setEditingName] = useState(false);
  const [nameVal, setNameVal] = useState(folder.name);
  const saveName = () => {
    void onUpdateFolder(folder.id, { name: nameVal });
    setEditingName(false);
  };

  return (
    <div>
      <div className="group flex min-h-12 items-center gap-1.5 py-2 pl-3 pr-4 sm:pl-4 sm:pr-5">
        {editingName ? (
          <div className="flex min-w-0 flex-1 items-center gap-1.5 pl-1">
            <input
              value={nameVal}
              onChange={(e) => setNameVal(e.target.value)}
              className="profile-overview-input-surface h-9 min-w-0 flex-1 rounded-lg border border-border px-2.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
              autoFocus
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === "Enter") saveName();
                if (e.key === "Escape") setEditingName(false);
              }}
            />
            <button type="button" onClick={saveName} aria-label={tc("action.save")} className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-primary hover:bg-primary/10">
              <Check className="h-4 w-4" />
            </button>
            <button type="button" onClick={() => setEditingName(false)} aria-label={tc("action.cancel")} className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-foreground/[0.06]">
              <X className="h-4 w-4" />
            </button>
            <button type="button" onClick={() => void onDeleteFolder(folder.id)} aria-label={tc("action.delete")} title={tc("action.delete")} className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <>
            <button
              type="button"
              onClick={onToggle}
              onDoubleClick={() => setEditingName(true)}
              aria-expanded={!collapsed}
              className="flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-lg pl-1 text-left"
            >
              <ChevronRight className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", !collapsed && "rotate-90")} />
              <span className={cn("truncate text-sm font-semibold", folder.enabled ? "text-foreground" : "text-muted-foreground")}>{folder.name}</span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground/60">{prompts.length}</span>
            </button>
            <button type="button" onClick={() => setEditingName(true)} className={cn(ROW_ICON_BUTTON, "[@media(hover:none)]:inline-flex [@media(hover:none)]:opacity-100")} aria-label={tc("action.edit")} title={tc("action.edit")}>
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button type="button" onClick={() => void onDeleteFolder(folder.id)} className={cn(ROW_ICON_BUTTON, "hover:text-destructive")} aria-label={tc("action.delete")} title={tc("action.delete")}>
              <Trash2 className="h-3.5 w-3.5" />
            </button>
            <span className="ml-1 inline-flex">
              <Switch
                size="sm"
                checked={folder.enabled}
                onChange={(v) => void onUpdateFolder(folder.id, { enabled: v })}
                label={folder.enabled ? t("promptConfig.disableFolder") : t("promptConfig.enableFolder")}
              />
            </span>
          </>
        )}
      </div>

      {!collapsed && (
        <div className={cn("pb-1.5", !folder.enabled && "opacity-60")}>
          {prompts.length === 0 && (
            <p className="py-2 pl-11 pr-4 text-xs text-muted-foreground/50 sm:pl-12">
              {t("customPrompts.emptyFolder")}
            </p>
          )}
          {prompts.map((prompt) => (
            <PromptRow
              key={prompt.id}
              nested
              prompt={prompt}
              editing={editingId === prompt.id}
              onEdit={() => setEditingId(prompt.id)}
              onCancelEdit={() => setEditingId(null)}
              onUpdate={onUpdatePrompt}
              onDelete={onDeletePrompt}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Custom Prompt Row ───────────────────────────────────────────────

function PromptRow({
  prompt,
  editing,
  onEdit,
  onCancelEdit,
  onUpdate,
  onDelete,
  nested = false,
}: {
  prompt: UserPromptItem;
  editing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onUpdate: (id: string, data: Record<string, unknown>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  /** Inside a folder: indented under the folder's chevron. */
  nested?: boolean;
}) {
  const { t } = useTranslation("profile");
  const { t: tu } = useTranslation("unrestrict");
  const { t: tc } = useTranslation("common");
  const sectionOptions = useSectionOptions();
  const otherLabel = tu("bindings.families.other");
  const [editName, setEditName] = useState(prompt.name);
  const [editContent, setEditContent] = useState(prompt.content);
  const [editSection, setEditSection] = useState(prompt.section);
  const [editDepth, setEditDepth] = useState(prompt.depth ?? 4);
  const [editPosition, setEditPosition] = useState<number | "">(prompt.position ?? "");

  if (editing) {
    return (
      <div className={cn("my-2 space-y-2.5 rounded-xl border border-primary/25 bg-primary/[0.04] p-3.5", nested ? "ml-11 mr-4 sm:ml-12 sm:mr-5" : "mx-4 sm:mx-5")}>
        <input
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          className="profile-overview-input-surface h-10 w-full rounded-lg border border-border px-3 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
          autoFocus
        />
        <textarea
          value={editContent}
          onChange={(e) => setEditContent(e.target.value)}
          rows={7}
          className="profile-overview-input-surface w-full resize-y rounded-lg border border-border px-3 py-2 font-mono text-xs leading-relaxed text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
        />
        <div className="grid grid-cols-2 gap-2">
          <Field label={t("customPrompts.fieldSection")}>
            <Select
              value={editSection}
              onValueChange={(v) => setEditSection(v as typeof editSection)}
              options={sectionOptions}
              triggerClassName={FIELD_TRIGGER_CLASS}
              contentClassName={FIELD_MENU_CLASS}
            />
          </Field>
          {editSection === "chat-history" && (
            <Field label={t("customPrompts.fieldDepth")} title={t("messagesFromEnd")}>
              <input
                type="number"
                min={1}
                max={100}
                value={editDepth}
                onChange={(e) => setEditDepth(Number(e.target.value) || 4)}
                className={FIELD_INPUT_CLASS}
              />
            </Field>
          )}
          <Field
            label={t("customPrompts.fieldPosition")}
            title={
              editSection !== "chat-history"
                ? t("promptConfig.positionHelp")
                : t("promptConfig.positionWithin")
            }
          >
            <PositionInput value={editPosition} onChange={setEditPosition} />
          </Field>
        </div>
        <FormActions
          onCancel={onCancelEdit}
          onDelete={() => void onDelete(prompt.id)}
          submitLabel={t("customPrompts.save")}
          onSubmit={() => {
            void onUpdate(prompt.id, {
              name: editName,
              content: editContent,
              section: editSection,
              ...(editSection === "chat-history" && { depth: editDepth }),
              position: editPosition === "" ? null : editPosition,
            });
            onCancelEdit();
          }}
        />
      </div>
    );
  }

  const sectionKey = SECTION_KEYS[prompt.section];
  const meta = [
    sectionKey ? tu(`prompts.section.${sectionKey}`) : prompt.section,
    prompt.position != null ? tu("prompts.pos", { n: prompt.position }) : null,
    prompt.sourceType === "pack" ? tu("chips.fromHub") : null,
  ].filter(Boolean).join(" · ");
  const boundFamilies = prompt.autoModels ?? [];

  return (
    <div className={cn("group flex min-h-12 items-center gap-1.5 py-2 pr-4 sm:pr-5", nested ? "pl-11 sm:pl-12" : "pl-4 sm:pl-5")}>
      <button type="button" onClick={onEdit} className="min-w-0 flex-1 text-left">
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className={cn("truncate text-sm font-medium", prompt.enabled ? "text-foreground" : "text-muted-foreground")}>{prompt.name}</span>
          {boundFamilies.map((f) => (
            <Chip key={f} tone="gold">{familyLabel(f, otherLabel)}</Chip>
          ))}
        </span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground/70">{meta}</span>
      </button>
      <button type="button" onClick={onEdit} className={ROW_ICON_BUTTON} aria-label={tc("action.edit")} title={tc("action.edit")}>
        <Pencil className="h-3.5 w-3.5" />
      </button>
      <button type="button" onClick={() => void onDelete(prompt.id)} className={cn(ROW_ICON_BUTTON, "hover:text-destructive")} aria-label={tc("action.delete")} title={tc("action.delete")}>
        <Trash2 className="h-3.5 w-3.5" />
      </button>
      <span className="ml-1 inline-flex">
        <Switch
          size="sm"
          checked={prompt.enabled}
          label={prompt.name}
          onChange={(v) => void onUpdate(prompt.id, { enabled: v })}
        />
      </span>
    </div>
  );
}

// ─── Compact Position Input ──────────────────────────────────────────

function PositionInput({
  value,
  onChange,
}: {
  value: number | "";
  onChange: (v: number | "") => void;
}) {
  const { t } = useTranslation("profile");

  const handleDecrement = () => {
    const cur = value === "" ? 0 : value;
    onChange(Math.round((cur - 1) * 10) / 10);
  };
  const handleIncrement = () => {
    const cur = value === "" ? -1 : value;
    onChange(Math.round((cur + 1) * 10) / 10);
  };

  // Fills its grid cell so it lines up with the selects beside it; the
  // steppers are fixed-width and the number field absorbs the remainder.
  return (
    <div className="profile-overview-input-surface flex h-9 items-center overflow-hidden rounded-lg border border-border">
      <button
        type="button"
        onClick={handleDecrement}
        className="flex h-full w-8 shrink-0 items-center justify-center border-r border-border text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
      >
        <Minus className="h-3 w-3" />
      </button>
      <input
        type="number"
        step="any"
        value={value}
        onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
        placeholder={t("customPrompts.positionAuto")}
        className="w-full min-w-0 bg-transparent px-1 text-center text-xs text-foreground placeholder:text-muted-foreground/40 focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <button
        type="button"
        onClick={handleIncrement}
        className="flex h-full w-8 shrink-0 items-center justify-center border-l border-border text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
      >
        <Plus className="h-3 w-3" />
      </button>
    </div>
  );
}
