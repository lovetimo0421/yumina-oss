import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronRight,
  Plus,
  Minus,
  Trash2,
  FolderPlus,
  Download,
  Upload,
  Power,
  Pencil,
  X,
  Check,
  Zap,
} from "lucide-react";
import { useUserPromptsStore, type UserPromptItem, type PromptFolder } from "@/stores/user-prompts";
import { Select } from "@/components/ui/select";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// ─── Constants ───────────────────────────────────────────────────────

const SECTION_OPTIONS = [
  { value: "system-presets", label: "System Prompt" },
  { value: "chat-history", label: "In-Chat" },
  { value: "post-history", label: "Final" },
];

const SECTION_COLORS: Record<string, string> = {
  "system-presets": "bg-blue-500/15 text-blue-400",
  "chat-history": "bg-orange-500/15 text-orange-400",
  "post-history": "bg-rose-500/15 text-rose-400",
};

const SECTION_LABELS: Record<string, string> = {
  "system-presets": "System",
  "chat-history": "In-Chat",
  "post-history": "Final",
};

// ─── Shared field chrome ─────────────────────────────────────────────
// Every control in the add/edit forms sits in a grid cell and fills it, so
// they line up in columns at a uniform height instead of each taking its own
// natural width. h-8/py-0 override the Select's roomier defaults.

const FIELD_TRIGGER_CLASS =
  "h-8 rounded-md border border-white/10 bg-transparent px-2 py-0 text-xs text-foreground";

const FIELD_INPUT_CLASS =
  "profile-overview-input-surface h-8 w-full rounded-md border border-white/10 px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50";

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
      <span className="block text-[10px] font-medium uppercase tracking-wide text-muted-foreground/50">
        {label}
      </span>
      {children}
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────────

export function GlobalPrompts() {
  const { t } = useTranslation("profile");

  const {
    prompts,
    folders,
    loading,
    fetchPrompts,
    createPrompt,
    updatePrompt,
    deletePrompt,
    createFolder,
    updateFolder,
    deleteFolder,
    importPrompts,
  } = useUserPromptsStore();

  const [editingPromptId, setEditingPromptId] = useState<string | null>(null);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const [addingPrompt, setAddingPrompt] = useState(false);
  const [newName, setNewName] = useState("");
  const [newContent, setNewContent] = useState("");
  const [newSection, setNewSection] = useState<string>("system-presets");
  const [newDepth, setNewDepth] = useState(4);
  const [newPosition, setNewPosition] = useState<number | "">("");
  const [newFolderId, setNewFolderId] = useState<string | null>(null);
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

  const handleAddPrompt = async () => {
    if (!newName.trim()) return;
    await createPrompt({
      name: newName.trim(),
      content: newContent,
      section: newSection,
      ...(newSection === "chat-history" && { depth: newDepth }),
      position: newPosition === "" ? null : newPosition,
      folderId: newFolderId,
    });
    setAddingPrompt(false);
    setNewName("");
    setNewContent("");
    setNewSection("system-presets");
    setNewDepth(4);
    setNewPosition("");
    setNewFolderId(null);
  };

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

  const folderOptions = folders.map((f) => ({ value: f.id, label: f.name }));

  return (
    <Card className="profile-overview-glass profile-overview-glass--soft rounded-xl">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Zap className="h-5 w-5" />
              {t("customPrompts.title")}
            </CardTitle>
            <CardDescription className="mt-2 text-muted-foreground/50">
              {t("customPrompts.subtitle")}
            </CardDescription>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="hover-surface rounded-lg p-1.5 text-muted-foreground"
              title={t("customPrompts.importFromFile")}
            >
              <Download className="h-4 w-4" />
            </button>
            <button
              onClick={handleExport}
              className="hover-surface rounded-lg p-1.5 text-muted-foreground"
              title={t("customPrompts.exportPrompts")}
            >
              <Upload className="h-4 w-4" />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json"
              onChange={handleImport}
              className="hidden"
            />
            <button
              onClick={() => createFolder("New Folder")}
              className="hover-surface rounded-lg p-1.5 text-muted-foreground"
              title={t("customPrompts.addFolder")}
            >
              <FolderPlus className="h-4 w-4" />
            </button>
            <button
              onClick={() => setAddingPrompt(true)}
              className="hover-surface rounded-lg p-1.5 text-primary"
              title={t("customPrompts.addPrompt")}
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>
        </div>
      </CardHeader>

      <CardContent>
        {loading && prompts.length === 0 && (
          <p className="text-xs text-muted-foreground/40">{t("customPrompts.loading")}</p>
        )}

        {/* Add prompt form */}
        {addingPrompt && (
          <div className="mb-4 space-y-2 rounded-lg border border-primary/20 bg-primary/5 p-3">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={t("customPrompts.namePlaceholder")}
              className="profile-overview-input-surface w-full rounded-md border border-white/10 px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/30 focus:outline-none focus:ring-1 focus:ring-primary/50"
              autoFocus
            />
            <textarea
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
              placeholder={t("customPrompts.contentPlaceholder")}
              rows={3}
              className="profile-overview-input-surface w-full resize-none rounded-md border border-white/10 px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground/30 focus:outline-none focus:ring-1 focus:ring-primary/50"
            />
            <div className="grid grid-cols-2 gap-x-2 gap-y-1.5">
              <Field label={t("customPrompts.fieldSection")}>
                <Select
                  value={newSection}
                  onValueChange={(v) => setNewSection(v)}
                  options={SECTION_OPTIONS}
                  triggerClassName={FIELD_TRIGGER_CLASS}
                  contentClassName="rounded-lg border border-white/10 bg-popover p-1 text-foreground shadow-xl"
                />
              </Field>
              {newSection === "chat-history" && (
                <Field label={t("customPrompts.fieldDepth")} title={t("messagesFromEnd")}>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={newDepth}
                    onChange={(e) => setNewDepth(Number(e.target.value) || 4)}
                    className={FIELD_INPUT_CLASS}
                  />
                </Field>
              )}
              <Field
                label={t("customPrompts.fieldPosition")}
                title={
                  newSection !== "chat-history"
                    ? t("promptConfig.positionHelp")
                    : t("promptConfig.positionWithin")
                }
              >
                <PositionInput value={newPosition} onChange={setNewPosition} />
              </Field>
              {folders.length > 0 && (
                <Field label={t("customPrompts.fieldFolder")}>
                  <Select
                    value={newFolderId ?? ""}
                    onValueChange={(v) => setNewFolderId(v || null)}
                    options={[{ value: "", label: t("customPrompts.noFolder") }, ...folderOptions]}
                    triggerClassName={FIELD_TRIGGER_CLASS}
                    contentClassName="rounded-lg border border-white/10 bg-popover p-1 text-foreground shadow-xl"
                  />
                </Field>
              )}
            </div>
            <div className="flex justify-end gap-2 border-t border-white/5 pt-2">
              <button
                onClick={() => setAddingPrompt(false)}
                className="rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
              >
                {t("customPrompts.cancel")}
              </button>
              <button
                onClick={handleAddPrompt}
                disabled={!newName.trim()}
                className="rounded-md bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-40"
              >
                {t("customPrompts.add")}
              </button>
            </div>
          </div>
        )}

        {/* Folders */}
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

        {/* Unfoldered custom prompts */}
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

        {/* Empty state */}
        {prompts.length === 0 && folders.length === 0 && !addingPrompt && !loading && (
          <p className="py-4 text-center text-xs text-muted-foreground/40">
            {t("customPrompts.empty")}
          </p>
        )}
      </CardContent>
    </Card>
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
  const [editingName, setEditingName] = useState(false);
  const [nameVal, setNameVal] = useState(folder.name);

  return (
    <div className="mb-2">
      <div className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 hover:bg-muted/50">
        <button onClick={onToggle} className="text-muted-foreground">
          {collapsed
            ? <ChevronRight className="h-3.5 w-3.5" />
            : <ChevronDown className="h-3.5 w-3.5" />}
        </button>

        {editingName ? (
          <div className="flex flex-1 items-center gap-1">
            <input
              value={nameVal}
              onChange={(e) => setNameVal(e.target.value)}
              className="profile-overview-input-surface flex-1 rounded border border-white/10 px-2 py-0.5 text-xs text-foreground focus:outline-none"
              autoFocus
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === "Enter") { onUpdateFolder(folder.id, { name: nameVal }); setEditingName(false); }
                if (e.key === "Escape") setEditingName(false);
              }}
            />
            <button onClick={() => { onUpdateFolder(folder.id, { name: nameVal }); setEditingName(false); }}>
              <Check className="h-3 w-3 text-primary" />
            </button>
            <button onClick={() => setEditingName(false)}>
              <X className="h-3 w-3 text-muted-foreground" />
            </button>
          </div>
        ) : (
          <span
            className="flex-1 text-xs font-medium text-foreground cursor-pointer"
            onDoubleClick={() => setEditingName(true)}
          >
            {folder.name}
            <span className="ml-1.5 text-muted-foreground/40">({prompts.length})</span>
          </span>
        )}

        <button
          onClick={() => onUpdateFolder(folder.id, { enabled: !folder.enabled })}
          className={`rounded p-1 ${folder.enabled ? "text-primary" : "text-muted-foreground/30"}`}
          title={folder.enabled ? t("promptConfig.disableFolder") : t("promptConfig.enableFolder")}
        >
          <Power className="h-3 w-3" />
        </button>
        <button
          onClick={() => setEditingName(true)}
          className="rounded p-1 text-muted-foreground hover:text-foreground"
        >
          <Pencil className="h-3 w-3" />
        </button>
        <button
          onClick={() => onDeleteFolder(folder.id)}
          className="rounded p-1 text-muted-foreground hover:text-destructive"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>

      {!collapsed && (
        <div className="ml-5 space-y-0.5">
          {prompts.length === 0 && (
            <p className="py-1 text-[10px] text-muted-foreground/30 italic">
              {t("customPrompts.emptyFolder")}
            </p>
          )}
          {prompts.map((prompt) => (
            <PromptRow
              key={prompt.id}
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
}: {
  prompt: UserPromptItem;
  editing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onUpdate: (id: string, data: Record<string, unknown>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const { t } = useTranslation("profile");
  const [editName, setEditName] = useState(prompt.name);
  const [editContent, setEditContent] = useState(prompt.content);
  const [editSection, setEditSection] = useState(prompt.section);
  const [editDepth, setEditDepth] = useState(prompt.depth ?? 4);
  const [editPosition, setEditPosition] = useState<number | "">(prompt.position ?? "");

  if (editing) {
    return (
      <div className="profile-overview-control-surface space-y-2 rounded-lg border border-white/10 p-3">
        <input
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          className="profile-overview-input-surface w-full rounded-md border border-white/10 px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
          autoFocus
        />
        <textarea
          value={editContent}
          onChange={(e) => setEditContent(e.target.value)}
          rows={4}
          className="profile-overview-input-surface w-full resize-none rounded-md border border-white/10 px-3 py-2 text-xs text-foreground font-mono focus:outline-none focus:ring-1 focus:ring-primary/50"
        />
        <div className="grid grid-cols-2 gap-x-2 gap-y-1.5">
          <Field label={t("customPrompts.fieldSection")}>
            <Select
              value={editSection}
              onValueChange={(v) => setEditSection(v as typeof editSection)}
              options={SECTION_OPTIONS}
              triggerClassName={FIELD_TRIGGER_CLASS}
              contentClassName="rounded-lg border border-white/10 bg-popover p-1 text-foreground shadow-xl"
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
        <div className="flex justify-end gap-2 border-t border-white/5 pt-2">
          <button
            onClick={onCancelEdit}
            className="rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            {t("customPrompts.cancel")}
          </button>
          <button
            onClick={() => {
              onUpdate(prompt.id, {
                name: editName,
                content: editContent,
                section: editSection,
                ...(editSection === "chat-history" && { depth: editDepth }),
                position: editPosition === "" ? null : editPosition,
              });
              onCancelEdit();
            }}
            className="rounded-md bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground"
          >
            {t("customPrompts.save")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="group flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-muted/50">
      <button
        onClick={() => onUpdate(prompt.id, { enabled: !prompt.enabled })}
        className={`shrink-0 rounded p-0.5 ${prompt.enabled ? "text-primary" : "text-muted-foreground/30"}`}
      >
        <Power className="h-3 w-3" />
      </button>
      <span
        className={`flex-1 text-xs truncate cursor-pointer ${prompt.enabled ? "text-foreground" : "text-muted-foreground/40 line-through"}`}
        onClick={onEdit}
      >
        {prompt.name}
      </span>
      <span className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium ${SECTION_COLORS[prompt.section] ?? "bg-muted text-muted-foreground"}`}>
        {SECTION_LABELS[prompt.section] ?? prompt.section}
      </span>
      {prompt.position != null && (
        <span className="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium bg-muted/60 text-muted-foreground/60">
          pos {prompt.position}
        </span>
      )}
      <button
        onClick={onEdit}
        className="touch-reveal shrink-0 rounded p-0.5 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground active:text-foreground [@media(hover:none)]:p-2 [@media(hover:none)]:-m-1.5"
      >
        <Pencil className="h-3 w-3" />
      </button>
      <button
        onClick={() => onDelete(prompt.id)}
        className="touch-reveal shrink-0 rounded p-0.5 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive active:text-destructive [@media(hover:none)]:p-2 [@media(hover:none)]:-m-1.5"
      >
        <Trash2 className="h-3 w-3" />
      </button>
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
    <div className="profile-overview-input-surface flex h-8 items-center overflow-hidden rounded-md border border-white/10">
      <button
        type="button"
        onClick={handleDecrement}
        className="flex h-full w-7 shrink-0 items-center justify-center border-r border-white/10 text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
      >
        <Minus className="h-2.5 w-2.5" />
      </button>
      <input
        type="number"
        step="any"
        value={value}
        onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
        placeholder={t("customPrompts.positionAuto")}
        className="w-full min-w-0 bg-transparent px-1 text-center text-xs text-foreground placeholder:text-muted-foreground/30 focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <button
        type="button"
        onClick={handleIncrement}
        className="flex h-full w-7 shrink-0 items-center justify-center border-l border-white/10 text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
      >
        <Plus className="h-2.5 w-2.5" />
      </button>
    </div>
  );
}
