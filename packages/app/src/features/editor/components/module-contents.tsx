import { useTranslation } from "react-i18next";
import { BookOpen, Clapperboard, MessageCircle, Pencil, Plus, Variable as VariableIcon, Zap } from "lucide-react";
import { ENTRY_TRIGGER_ORDER, entryTrigger, type EntryTrigger, type Worldbook, type WorldEntry } from "@yumina/engine";
import { useEditorStore } from "@/stores/editor";
import { cn } from "@/lib/utils";
import { setPendingCodeJump } from "@/lib/code-jump";
import { ModuleScenePreview } from "./module/module-scene-preview";

/**
 * What a module holds — by name, and reachable.
 *
 * A module's contents used to be a count in a panel about tokens. A count
 * tells you the module has three entries; it does not tell you which three,
 * and nothing on it took you to them. So this lists them, each a link to its
 * own page narrowed to this module, with a "+" that lands a new one here.
 *
 * Composed the way the canvas composes a module's frame, and for the same
 * reason: a module is a place. Its openings, its lore split by how each entry
 * reaches the prompt, its behaviours, its variables, the scene that shows
 * while it is on. Switch to another module and all of it is another module's.
 *
 * The card's objects are drawn INSIDE it as rows marked shared, not summed up
 * in a footnote. That is the whole shape of the thing: every module has its
 * own, and every module also has the card's — one HP variable seen from four
 * places, not four variables. A count at the bottom said the number and hid
 * the idea.
 */

const SHOW = 12;

function Chips({
  items,
  onOpen,
  emptyLabel,
}: {
  /** `shared` = the card's own object, seen from inside this module. Same
   *  object in every module; editing it here edits it everywhere. */
  items: Array<{ id: string; name: string; shared?: boolean }>;
  onOpen: (id: string) => void;
  emptyLabel: string;
}) {
  const { t } = useTranslation("editor");
  if (items.length === 0) return <span className="text-[11px] text-muted-foreground/50">{emptyLabel}</span>;
  return (
    <>
      {items.slice(0, SHOW).map((it) => (
        <button
          key={it.id}
          type="button"
          onClick={() => onOpen(it.id)}
          title={it.shared ? t("blueprint.block.sharedRowHint") : undefined}
          className={cn(
            "max-w-[14rem] truncate rounded-md border px-2 py-0.5 text-[11px] transition-colors hover:border-primary/50 hover:text-primary",
            it.shared
              ? "border-dashed border-border/60 bg-transparent text-muted-foreground"
              : "border-border/70 bg-card text-foreground/90",
          )}
        >
          {it.name}
          {it.shared && <span className="ml-1 text-[9px] text-muted-foreground/70">{t("blueprint.block.sharedRow")}</span>}
        </button>
      ))}
      {items.length > SHOW && (
        <span className="text-[11px] text-muted-foreground/60">{t("modules.more", { count: items.length - SHOW })}</span>
      )}
    </>
  );
}

/**
 * Where "edit this file" lands: the classic editor's Custom UI section, or
 * the Studio's code panel (reached by the stage's open-panel event, so this
 * component needs none of the stage's machinery).
 */
function openSceneFile(file: string, via: "classic" | "studio") {
  setPendingCodeJump(file, 1);
  if (via === "studio") {
    window.dispatchEvent(new CustomEvent("yumina:studio-stage-open-panel", { detail: { panelId: "code-view" } }));
    return;
  }
  const store = useEditorStore.getState();
  store.setCustomUiTab("code");
  store.setActiveSection("components");
}

/** `book` is null for the card itself.
 *
 *  The card is a module — the one every other module's content is shared into
 *  — so its openings, lore, variables and behaviours are module contents like
 *  any other, and this lists them the same way. Only the two things that are
 *  about being INSIDE something else differ: the card has no scene file of its
 *  own (its interface is the card's), and nothing is shared in to it. */
export function ModuleContents({ book, editVia = "classic", ownOnly = false, onOpenObject }: {
  book: Worldbook | null;
  editVia?: "classic" | "studio";
  /** On the canvas: open an object where it stands on the board (its graph
   *  id, e.g. `entry:<id>`). Without it an open went through focusObject,
   *  which on the canvas swapped the whole board for the full 设定 page. */
  onOpenObject?: (objectId: string) => void;
  /** Only what the module itself holds. The card's content is in play in
   *  every module, and listing it under each one ("开场 1 · 共通", the
   *  platform's own presets) read as contents the module had grown. */
  ownOnly?: boolean;
}) {
  const { t } = useTranslation("editor");
  const allEntries = useEditorStore((s) => s.worldDraft.entries);
  const allVariables = useEditorStore((s) => s.worldDraft.variables);
  const allReactions = useEditorStore((s) => s.worldDraft.reactions);
  const sceneFiles = useEditorStore((s) => s.worldDraft.rootComponent?.files);
  const storeFocus = useEditorStore((s) => s.focusObject);
  const PREFIX = { entry: "entry:", greeting: "greeting:", variable: "var:", reaction: "reaction:" } as const;
  const focusObject = (kind: keyof typeof PREFIX, id: string, worldbookId?: string) =>
    onOpenObject ? onOpenObject(`${PREFIX[kind]}${id}`) : storeFocus(kind, id, worldbookId);
  const updateWorldbook = useEditorStore((s) => s.updateWorldbook);
  const fileNames = Object.keys(sceneFiles ?? {});

  // undefined is the card's own id: a core object carries no worldbookId.
  const ownerId = book?.id;
  /** Inside a module you see its own objects and the card's; on the card
   *  itself there is nothing above it to share in. */
  const belongsHere = (wb: string | undefined) => wb === ownerId || (!ownOnly && ownerId !== undefined && !wb);
  const isShared = (wb: string | undefined) => ownerId !== undefined && !wb;
  /** Own first, then the card's — the order the canvas draws them in. */
  const order = <T extends { worldbookId?: string }>(list: T[]) =>
    [...list.filter((x) => !isShared(x.worldbookId)), ...list.filter((x) => isShared(x.worldbookId))];

  const chip = (x: { id: string; worldbookId?: string }, name: string) =>
    ({ id: x.id, name, shared: isShared(x.worldbookId) });

  const openings = order(allEntries.filter((e) => e.role === "greeting" && belongsHere(e.worldbookId)));
  const loreByTrigger = new Map<EntryTrigger, WorldEntry[]>();
  for (const e of allEntries) {
    if (e.role === "greeting" || !belongsHere(e.worldbookId)) continue;
    const key = entryTrigger(e);
    if (!loreByTrigger.has(key)) loreByTrigger.set(key, []);
    loreByTrigger.get(key)!.push(e);
  }
  const variables = order(allVariables.filter((v) => !v.internal && belongsHere(v.worldbookId)));
  const reactions = order((allReactions ?? []).filter((r) => belongsHere(r.worldbookId)));

  // Each "+" makes the object, homes it here and opens it — the store's add
  // actions append, so the newest is the last.
  const addOpening = () => {
    const store = useEditorStore.getState();
    store.addEntry("greeting", "system-presets");
    const made = useEditorStore.getState().worldDraft.entries.at(-1);
    if (!made) return;
    store.setEntryWorldbook(made.id, ownerId);
    focusObject("greeting", made.id, ownerId);
  };
  const addEntry = () => {
    const store = useEditorStore.getState();
    store.addEntry();
    const made = useEditorStore.getState().worldDraft.entries.at(-1);
    if (!made) return;
    store.setEntryWorldbook(made.id, ownerId);
    focusObject("entry", made.id, ownerId);
  };
  const addVariable = () => {
    const store = useEditorStore.getState();
    store.addVariable();
    const vars = useEditorStore.getState().worldDraft.variables;
    const made = vars.at(-1);
    if (!made) return;
    store.updateVariableAt(vars.length - 1, { worldbookId: ownerId });
    focusObject("variable", made.id, ownerId);
  };
  const addReaction = () => {
    const store = useEditorStore.getState();
    store.addReaction();
    const made = (useEditorStore.getState().worldDraft.reactions ?? []).at(-1);
    if (!made) return;
    store.updateReaction(made.id, { worldbookId: ownerId });
    focusObject("reaction", made.id, ownerId);
  };
  const untitled = t("entries.untitledEntry", { defaultValue: "(untitled)" });
  const openEntry = (id: string) => focusObject("entry", id, ownerId);

  // Canvas order: openings, lore split by how it fires, behaviours, variables.
  const rows: Array<{
    key: string;
    icon: typeof BookOpen;
    tint: string;
    label: string;
    items: Array<{ id: string; name: string; shared?: boolean }>;
    empty: string;
    onOpen: (id: string) => void;
    onAdd: () => void;
  }> = [
    // A module has no openings of its own: they are the card's.
    ...(ownOnly ? [] : [{
      key: "openings", icon: MessageCircle, tint: "text-emerald-300", label: t("blueprint.blocks.opening"),
      items: openings.map((e) => chip(e, e.name || untitled)),
      empty: t("blueprint.blocks.empty.opening"),
      onOpen: (id: string) => focusObject("greeting", id, ownerId), onAdd: addOpening,
    }]),
    ...ENTRY_TRIGGER_ORDER.flatMap((trigger) => {
      const list = loreByTrigger.get(trigger) ?? [];
      // A trigger with nothing in it is not a thing the module has. Only
      // always-on stays, so there is somewhere to put the first entry.
      if (list.length === 0 && trigger !== "always") return [];
      return [{
        key: `lore:${trigger}`, icon: BookOpen, tint: "text-violet-300",
        label: t(`blueprint.blocks.lore.${trigger}` as never) as string,
        items: order(list).map((e) => chip(e, e.name || untitled)),
        empty: t("blueprint.blocks.empty.lore"),
        onOpen: openEntry, onAdd: addEntry,
      }];
    }),
    {
      key: "behaviors", icon: Zap, tint: "text-orange-300", label: t("blueprint.blocks.behavior"),
      items: reactions.map((r) => chip(r, r.name)),
      empty: t("blueprint.blocks.empty.behavior"),
      onOpen: (id) => focusObject("reaction", id, ownerId), onAdd: addReaction,
    },
    {
      key: "vars", icon: VariableIcon, tint: "text-sky-300", label: t("blueprint.blocks.state"),
      items: variables.map((v) => chip(v, v.name)),
      empty: t("blueprint.blocks.empty.state"),
      onOpen: (id) => focusObject("variable", id, ownerId), onAdd: addVariable,
    },
  ];

  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <div key={row.key} className="flex items-start gap-2">
          <row.icon className={cn("mt-1 h-3.5 w-3.5 shrink-0", row.tint)} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-semibold text-foreground">
                {row.label}
                <span className="ml-1 tabular-nums text-muted-foreground">{row.items.length}</span>
              </span>
              <button
                type="button"
                onClick={row.onAdd}
                title={t("modules.addInto")}
                className="flex h-5 w-5 items-center justify-center rounded-md border border-dashed border-border text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary"
              >
                <Plus className="h-3 w-3" />
              </button>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1">
              <Chips items={row.items} onOpen={row.onOpen} emptyLabel={row.empty} />
            </div>
          </div>
        </div>
      ))}
      {/* The module's scene: the file of the card's interface that shows
          while it is on. Only on a card that has an interface. */}
      {book && fileNames.length > 0 && (
        <div className="flex items-start gap-2">
          <Clapperboard className="mt-1 h-3.5 w-3.5 shrink-0 text-rose-300" />
          <div className="min-w-0 flex-1">
            <span className="text-[11px] font-semibold text-foreground">{t("modules.contentsInterface")}</span>
            <div className="mt-1 flex items-center gap-1.5">
              <select
                aria-label={t("blueprint.scene.pick")}
                value={book.frontendFile ?? ""}
                onChange={(e) => updateWorldbook(book.id, { frontendFile: e.target.value || undefined })}
                className={cn(
                  "h-7 min-w-0 max-w-[16rem] flex-1 rounded-md border border-border/70 bg-card px-2 text-[11px] text-foreground outline-none focus:border-primary/50",
                  !book.frontendFile && "text-muted-foreground",
                )}
              >
                <option value="">{t("blueprint.scene.none")}</option>
                {fileNames.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={!book.frontendFile}
                title={t("blueprint.scene.editHint")}
                onClick={() => book.frontendFile && openSceneFile(book.frontendFile, editVia)}
                className="flex h-7 items-center gap-1 rounded-md border border-border/70 px-2 text-[11px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Pencil className="h-3 w-3" />
                {t("blueprint.scene.edit")}
              </button>
            </div>
            {/* Only when the module actually has a screen of its own. The
                preview compiles the card's TSX for real, so it is not a
                decoration to leave running under every module that has none. */}
            {book.frontendFile && <ModuleScenePreview book={book} />}
          </div>
        </div>
      )}
      {/* The card's objects used to be counted here. They are rows in the
          groups above now, marked shared — the count said how many, the rows
          say which, and which is the part that lets you work. */}
    </div>
  );
}
