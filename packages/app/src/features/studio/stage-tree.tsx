import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  BookOpen,
  Boxes,
  ChevronDown,
  ChevronRight,
  Globe,
  LayoutTemplate,
  MessageCircle,
  Music,
  Search,
  Variable as VariableIcon,
  Zap,
} from "lucide-react";
import { entryTrigger } from "@yumina/engine";
import { cn } from "@/lib/utils";
import { useEditorStore } from "@/stores/editor";
import { indexWorldContent, searchWorldContent } from "./lib/world-search";

/**
 * The card's index — Voyage's file tree, translated. The canvas is a great
 * MAP of a card and a poor LIST of one: 62% of cards have zero wires, and
 * for their creators "where is my variable" should not be a spatial
 * question. Every object, grouped the way the board groups them, with
 * counts; clicking an item selects it on the canvas and flies there
 * (the panel's own jumpTo, reached by event so the tree needs none of the
 * graph machinery).
 */

const focusOnCanvas = (objId: string) =>
  window.dispatchEvent(new CustomEvent("yumina:studio-canvas-focus", { detail: { objId } }));

/** Double-click: straight into the object's own editor page. */
const PANEL_FOR: Array<[prefix: string, panelId: string]> = [
  ["entry:", "lorebook"],
  ["greeting:", "first-message"],
  ["var:", "variables"],
  ["reaction:", "rules"],
  ["audio:", "audio"],
  ["image:", "scene-images"],
  ["module:", "modules"],
];

const openEditorFor = (objId: string) => {
  const store = useEditorStore.getState();
  const id = objId.slice(objId.indexOf(":") + 1);
  if (objId.startsWith("entry:")) {
    const entry = store.worldDraft.entries.find((e) => e.id === id);
    store.focusObject("entry", id, entry?.worldbookId);
  } else if (objId.startsWith("var:")) {
    const variable = store.worldDraft.variables.find((v) => v.id === id);
    store.focusObject("variable", id, variable?.worldbookId);
  } else if (objId.startsWith("reaction:")) {
    const reaction = store.worldDraft.reactions?.find((r) => r.id === id);
    store.focusObject("reaction", id, reaction?.worldbookId);
  } else if (objId.startsWith("module:")) {
    store.focusObject("module", id);
  } else if (objId.startsWith("greeting:")) {
    const greeting = store.worldDraft.entries.find((e) => e.id === id);
    store.focusObject("greeting", id, greeting?.worldbookId);
  } else if (objId.startsWith("audio:")) {
    store.focusObject("audio", id);
  } else if (objId.startsWith("image:")) {
    store.focusObject("sceneImage", id);
  }
  const panelId =
    objId === "frontend" ? "frontend"
    : objId === "world:root" ? "overview"
    : PANEL_FOR.find(([prefix]) => objId.startsWith(prefix))?.[1];
  if (panelId) {
    window.dispatchEvent(new CustomEvent("yumina:studio-stage-open-panel", { detail: { panelId } }));
  }
};

interface Leaf {
  objId: string;
  label: string;
  muted?: boolean;
}

interface Group {
  key: string;
  label: string;
  icon: typeof Zap;
  tint: string;
  leaves: Leaf[];
}

export function StageTree() {
  const { t } = useTranslation("editor");
  const world = useEditorStore(s => s.worldDraft);
  const entries = useEditorStore((s) => s.worldDraft.entries);
  const variables = useEditorStore((s) => s.worldDraft.variables);
  const reactions = useEditorStore((s) => s.worldDraft.reactions);
  const audioTracks = useEditorStore((s) => s.worldDraft.audioTracks);
  const worldbooks = useEditorStore((s) => s.worldDraft.worldbooks);
  const rootComponent = useEditorStore((s) => s.worldDraft.rootComponent);
  const cardName = useEditorStore((s) => s.worldDraft.name);

  const [query, setQuery] = useState("");
  const [closed, setClosed] = useState<Set<string>>(() => new Set(["presets"]));

  const groups = useMemo<Group[]>(() => {
    const sorted = entries.slice().sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    const greetings = sorted.filter((e) => e.role === "greeting");
    // The platform's own presets (虚构模式, 思维链绕过…) are not the creator's
    // writing: listed first under the card's settings they read as a to-do.
    const lore = sorted.filter((e) => e.role !== "greeting" && !e.presetId);
    const presets = sorted.filter((e) => e.role !== "greeting" && e.presetId);
    const byTrigger: Record<string, Leaf[]> = { always: [], keywords: [], conditions: [], manual: [] };
    for (const e of lore) {
      const trigger = entryTrigger(e);
      (byTrigger[trigger] ?? byTrigger.manual!).push({
        objId: `entry:${e.id}`,
        label: e.name || t("blueprint.nodes.emptyContent"),
        muted: !e.content?.trim(),
      });
    }
    const result: Group[] = [
      {
        key: "card",
        label: t("blueprint.blocks.card"),
        icon: Globe,
        tint: "text-zinc-300",
        leaves: [{ objId: "world:root", label: cardName || t("blueprint.blocks.card") }],
      },
      {
        key: "openings",
        label: t("blueprint.blocks.opening"),
        icon: MessageCircle,
        tint: "text-emerald-400",
        leaves: greetings.map((g) => ({ objId: `greeting:${g.id}`, label: g.name || "—", muted: !g.content?.trim() })),
      },
      ...(["always", "keywords", "conditions", "manual"] as const).map((trigger) => ({
        key: `lore-${trigger}`,
        label: t(`blueprint.blocks.lore.${trigger}` as never) as string,
        icon: BookOpen,
        tint: "text-violet-400",
        leaves: byTrigger[trigger]!,
      })),
      {
        key: "presets",
        label: t("blueprint.tree.presets"),
        icon: BookOpen,
        tint: "text-zinc-500",
        leaves: presets.map((e) => ({ objId: `entry:${e.id}`, label: e.name || t("blueprint.nodes.emptyContent"), muted: true })),
      },
      {
        key: "modules",
        label: t("blueprint.addModule"),
        icon: Boxes,
        tint: "text-amber-400",
        leaves: (worldbooks ?? []).map((w) => ({ objId: `module:${w.id}`, label: w.name || w.id })),
      },
      {
        key: "state",
        label: t("blueprint.blocks.state"),
        icon: VariableIcon,
        tint: "text-sky-400",
        leaves: variables.map((v) => ({ objId: `var:${v.id}`, label: v.name })),
      },
      {
        key: "behaviors",
        label: t("blueprint.blocks.behavior"),
        icon: Zap,
        tint: "text-orange-400",
        leaves: (reactions ?? []).map((r) => ({ objId: `reaction:${r.id}`, label: r.name })),
      },
      {
        key: "frontend",
        label: t("blueprint.blocks.frontend"),
        icon: LayoutTemplate,
        tint: "text-rose-400",
        // "World Component" is the file's internal default name, not a title.
        leaves: rootComponent ? [{ objId: "frontend", label: rootComponent.name && rootComponent.name !== "World Component" ? rootComponent.name : t("blueprint.blocks.frontend") }] : [],
      },
      {
        key: "audio",
        label: t("blueprint.blocks.audio"),
        icon: Music,
        tint: "text-teal-400",
        leaves: (audioTracks ?? []).map((a) => ({ objId: `audio:${a.id}`, label: a.name || a.id })),
      },
    ];
    // An empty station earns no tree row either — same rule as the board.
    return result.filter((g) => g.leaves.length > 0);
  }, [entries, variables, reactions, audioTracks, worldbooks, rootComponent, cardName, t]);

  const q = query.trim().toLowerCase();
  const searchIndex = useMemo(() => indexWorldContent(world), [world]);
  const searchMatches = useMemo(() => new Map(searchWorldContent(searchIndex, query).map(result => [result.id, result])), [searchIndex, query]);
  const visible = q
    ? groups
        .map((g) => ({ ...g, leaves: g.leaves.filter((l) => searchMatches.has(l.objId)) }))
        .filter((g) => g.leaves.length > 0)
    : groups;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border/60 p-2">
        <div className="flex items-center gap-1.5 rounded-md border border-border/60 bg-black/25 px-2 py-1.5">
          <Search className="h-3 w-3 shrink-0 text-muted-foreground/50" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("blueprint.tree.search")}
            className="min-w-0 flex-1 bg-transparent text-[11px] text-foreground placeholder:text-muted-foreground/40 focus:outline-none"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {visible.map((g) => {
          const isClosed = !q && closed.has(g.key);
          const Icon = g.icon;
          return (
            <div key={g.key}>
              <button
                type="button"
                onClick={() =>
                  setClosed((prev) => {
                    const next = new Set(prev);
                    if (next.has(g.key)) next.delete(g.key);
                    else next.add(g.key);
                    return next;
                  })
                }
                className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left transition-colors hover:bg-white/[0.04]"
              >
                {isClosed ? (
                  <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/50" />
                ) : (
                  <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/50" />
                )}
                <Icon className={cn("h-3 w-3 shrink-0", g.tint)} />
                <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-foreground/85">{g.label}</span>
                <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/45">
                  {g.leaves.length}
                </span>
              </button>
              {!isClosed &&
                g.leaves.map((leaf) => (
                  <button
                    key={leaf.objId}
                    type="button"
                    title={t("blueprint.insp.openFull")}
                    onClick={() => leaf.objId === "frontend" ? openEditorFor(leaf.objId) : focusOnCanvas(leaf.objId)}
                    onDoubleClick={() => openEditorFor(leaf.objId)}
                    className={cn(
                      "flex w-full items-center gap-1.5 py-1 pl-8 pr-2 text-left transition-colors hover:bg-white/[0.06]",
                      leaf.muted ? "text-muted-foreground/45 italic" : "text-foreground/75",
                    )}
                  >
                    <span className="min-w-0 flex-1 text-[11px]">
                      <span className="block truncate">{leaf.label}</span>
                      {q && <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{searchMatches.get(leaf.objId)?.scope ?? t("blueprint.writing.sharedScope")}</span>}
                      {q && searchMatches.get(leaf.objId)?.excerpt && <span className="mt-1 line-clamp-2 text-[10px] leading-4 text-muted-foreground">{searchMatches.get(leaf.objId)?.excerpt}</span>}
                    </span>
                  </button>
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
