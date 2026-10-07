import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { Suspense, useState, useRef, useCallback, useEffect, useLayoutEffect } from "react";
import { useModalFocus } from "@/hooks/use-modal-focus";
import {
  ChevronRight,
  Loader2,
  ArrowLeft,
  Sparkles,
  Wand2,
  Upload,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useEditorStore } from "@/stores/editor";
import { clampWorldTags } from "@yumina/shared";
import { useAuthGuard } from "@/hooks/use-auth-guard";
import { WORLD_TEMPLATES, type WorldTemplate, defaultOpening } from "@/lib/world-templates";
import { parseImportedFileFlexible } from "@/lib/import-world";
import type { WorldDefinition } from "@yumina/engine";
import { ApplyChangesDialog } from "@/features/world-changes/apply-changes-dialog";
import { findImportTargets, type ApplyTarget } from "@/features/world-changes/apply-world-changes";
import { useCreatePageStore } from "@/stores/create-page";
import { lazyRouteComponent } from "@/lib/lazy-route-component";
import i18n from "@/lib/i18n";
import { getGlobalEditorMode, saveGlobalEditorMode } from "@/features/editor/lib/editor-mode";
import { prepareStudioEntry } from "@/features/editor/editor-entry";
import { fetchBlueprintAccess } from "@/lib/blueprint-access";
import { getEditorSurface, saveEditorSurface, shouldOpenVisual } from "@/lib/editor-surface";
import { requestQuietTour } from "@/lib/studio-entry";
import { useUnsavedChangesGuard } from "@/features/editor/use-unsaved-changes-guard";
import { UnsavedChangesDialog } from "@/features/editor/unsaved-changes-dialog";
import { navigateBackSafely } from "@/lib/safe-back";
import { getGenerateHref, getLandingRoute } from "@/edition/routes";
import { useFeature } from "@/edition/edition";
import { FieldError } from "@/components/ui/field-error";


const EditorShell = lazyRouteComponent(
  () => import("@/features/editor/editor-shell"),
  (m) => m.EditorShell
);

const QuickCreateEditor = lazyRouteComponent(
  () => import("@/features/editor/quick-create-editor"),
  (m) => m.QuickCreateEditor
);

// Ordered by what someone who just signed up is most likely to want.
// "Import a world from a JSON file" led this list while being the one
// option that requires a file you already have — and the page carries a
// second Import button in its own corner. Image generation is a tool that
// navigates away rather than a world you start, so it sits last.
const CREATE_OPTIONS = [
  {
    id: "character-chat",
    template: "character-chat",
    titleKey: "templates.characterChat",
    descKey: "templates.characterChatDesc",
    artwork: "/create/character-chat.webp",
    accent: "#B661F3",
  },
  {
    id: "world-simulation",
    template: "world-simulation",
    titleKey: "templates.worldSimulation",
    descKey: "templates.worldSimulationDesc",
    artwork: "/create/world-simulation.webp",
    accent: "#61C7F3",
  },
  {
    id: "blank",
    template: null,
    titleKey: "templates.blank",
    descKey: "templates.blankDesc",
    artwork: "/create/blank-project.webp",
    accent: "#F2D479",
  },
  {
    id: "import",
    template: null,
    titleKey: "templates.importWorld",
    descKey: "templates.importWorldDesc",
    artwork: "/create/import-existing.webp",
    accent: "#72E6C8",
  },
  {
    id: "image-generation",
    template: null,
    titleKey: "templates.imageGeneration",
    descKey: "templates.imageGenerationDesc",
    artwork: "/create/image-generation.webp",
    accent: "#76D8EA",
  },
] as const;

function TemplatePicker({
  onSelect,
  onImport,
  onBack,
  importError,
}: {
  onSelect: (template: WorldTemplate | null) => void | Promise<void>;
  onImport: () => void;
  onBack: () => void;
  importError?: string | null;
}) {
  const { t } = useTranslation(["library", "templates-content"]);
  const navigate = useNavigate();
  // The image-generation card leads to a hosted-only route; drop it without the feature.
  const imageGeneration = useFeature("imageGeneration");
  const createOptions = imageGeneration
    ? CREATE_OPTIONS
    : CREATE_OPTIONS.filter((option) => option.id !== "image-generation");

  const handleClick = (option: (typeof CREATE_OPTIONS)[number]) => {
    if (option.id === "image-generation") {
      const href = getGenerateHref();
      if (href) void navigate({ to: href });
    } else if (option.id === "blank") {
      onSelect(null);
    } else if (option.id === "import") {
      onImport();
    } else {
      const tpl = WORLD_TEMPLATES.find((t) => t.id === option.template);
      if (tpl) onSelect(tpl);
    }
  };

  return (
    // Mobile shares Discover's document scrollport; the shell owns safe areas.
    <div data-scroll-restoration-id="create-picker" className="create-shell flex h-full min-h-0 w-full overflow-hidden px-4 pb-3 pt-0 md:items-start md:justify-center md:overflow-y-auto md:p-6 lg:p-8">
      <div className="create-col mx-auto flex h-full min-h-0 w-full max-w-[430px] flex-col md:h-auto md:max-w-6xl">
        <div className="shrink-0 animate-[fadeInUp_0.5s_ease-out_both] md:hidden">
          <div className="mb-1 flex items-center gap-3">
            <button
              onClick={onBack}
              className="flex min-h-11 items-center gap-2 rounded-full pr-3 text-sm text-white/75 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              title={t("create.back")}
            >
              <ArrowLeft className="h-5 w-5" />
              {t("create.back")}
            </button>
          </div>
          <div className="relative w-fit">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -inset-x-5 -inset-y-3 rounded-full bg-amber-200/10 blur-xl"
            />
            <h1
              className="relative mb-3 bg-gradient-to-r from-white via-amber-100 to-amber-200 bg-clip-text text-[clamp(1.75rem,8vw,2rem)] font-bold leading-[1.08] tracking-[-0.035em] text-transparent drop-shadow-[0_2px_14px_rgba(245,190,82,0.32)]"
              style={{
                fontFamily:
                  '"Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif',
              }}
            >
              {t("create.mobileTitle", {
                defaultValue: "Create a New Story",
              })}
            </h1>
          </div>
        </div>

        <div className="hidden items-end justify-between gap-3 animate-[fadeInUp_0.5s_ease-out_both] md:flex">
          <div className="flex min-w-0 items-start gap-3">
            <button
              onClick={onBack}
              className="hover-surface mt-0.5 shrink-0 rounded-xl p-2 text-muted-foreground transition-colors hover:text-foreground"
              title={t("create.back")}
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
            <div className="min-w-0">
              <h1 className="mb-2 text-3xl font-black tracking-tight text-white lg:text-4xl">
                {t("create.title")}
              </h1>
            </div>
          </div>
          <button
            onClick={onImport}
            className="hover-surface inline-flex shrink-0 items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm font-semibold text-foreground transition-colors hover:bg-white/10"
          >
            <Upload className="h-4 w-4" />
            {t("create.import")}
          </button>
        </div>

        {importError ? <FieldError message={importError} /> : null}

        <div className="create-mobile-grid mt-[clamp(0.75rem,3vh,2rem)] grid min-h-0 flex-1 auto-rows-fr grid-cols-1 gap-[clamp(0.375rem,1vh,0.625rem)] md:hidden">
          {createOptions.map((option, index) => {
            return (
              <button
                key={option.id}
                onClick={() => handleClick(option)}
                className="group relative grid min-h-0 cursor-pointer grid-cols-[1fr_auto] items-center overflow-hidden rounded-lg border border-white/20 bg-black/20 px-4 py-[clamp(0.5rem,1.25vh,1.25rem)] text-left shadow-[0_10px_24px_rgba(0,0,0,0.14)] transition-transform duration-200 hover:scale-[1.01] focus:outline-none focus:ring-2 focus:ring-white/45 animate-[fadeInUp_0.5s_ease-out_both]"
                style={
                  {
                    animationDelay: `${index * 100}ms`,
                    backgroundImage: `linear-gradient(90deg, rgba(4,10,10,0.46) 0%, rgba(4,10,10,0.4) 34%, rgba(4,9,12,0.46) 64%, rgba(3,6,9,0.58) 100%), linear-gradient(180deg, rgba(255,255,255,0.05), rgba(0,0,0,0.14)), url(${option.artwork})`,
                    backgroundSize: "100% 100%",
                    backgroundPosition: "center",
                  } as React.CSSProperties
                }
              >
                <span className="relative z-10 block translate-x-8 text-base font-extrabold leading-tight text-white drop-shadow-[0_1px_8px_rgba(0,0,0,0.55)]">
                  {t(option.titleKey)}
                </span>
                <ChevronRight className="relative z-10 h-6 w-6 text-white/85 drop-shadow-[0_1px_8px_rgba(0,0,0,0.55)] transition-transform group-hover:translate-x-0.5" />
              </button>
            );
          })}
        </div>

        <div className="create-grid mt-7 hidden grid-cols-1 gap-4 pb-4 md:grid md:grid-cols-2 md:gap-5 lg:grid-cols-3">
          {createOptions.map((option, index) => {
            return (
              <button
                key={option.id}
                onClick={() => handleClick(option)}
                className="create-card group relative flex min-h-[170px] cursor-pointer flex-col overflow-hidden rounded-xl border border-border bg-card p-5 text-left transition-all duration-300 hover:scale-[1.02] hover:border-[color:var(--card-accent)]/50 focus:outline-none focus:ring-2 focus:ring-white/35 animate-[fadeInUp_0.5s_ease-out_both] md:min-h-[180px] lg:min-h-[190px]"
                style={
                  {
                    animationDelay: `${index * 100}ms`,
                    "--card-accent": option.accent,
                  } as React.CSSProperties
                }
              >
                <div
                  className="absolute inset-y-0 -right-8 left-0 bg-cover bg-right bg-no-repeat transition-transform duration-500 group-hover:scale-[1.04]"
                  style={{ backgroundImage: `url(${option.artwork})` }}
                />
                <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(8,10,12,0.9)_0%,rgba(8,10,12,0.78)_42%,rgba(8,10,12,0.46)_72%,rgba(8,10,12,0.3)_100%),linear-gradient(180deg,rgba(255,255,255,0.05),rgba(0,0,0,0.28))]" />

                <div className="relative z-10 flex max-w-[68%] flex-1 flex-col">
                  <h3 className="create-card-title mb-1.5 text-lg font-bold text-white drop-shadow-[0_1px_10px_rgba(0,0,0,0.45)] lg:text-xl">
                    {t(option.titleKey)}
                  </h3>
                  <p className="create-card-desc flex-1 text-xs leading-snug text-white/68 lg:text-sm">
                    {t(option.descKey)}
                  </p>
                </div>

                <div
                  className="absolute bottom-0 left-0 h-1 w-0 transition-all duration-500 ease-out group-hover:w-full"
                  style={{ backgroundColor: option.accent }}
                />
              </button>
            );
          })}
        </div>
      </div>

      <style>{`
        @keyframes fadeInUp {
          from {
            opacity: 0;
            transform: translateY(20px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        /* Tall desktop screens only: pin the header near the top and float
           enlarged cards in the vertical center. Short screens keep the
           compact top-aligned layout so the page never scrolls. */
        @media (min-width: 768px) and (min-height: 820px) {
          .create-shell {
            padding-top: 3.5rem;
          }
          .create-col {
            min-height: 100%;
          }
          .create-grid {
            margin-top: auto;
            margin-bottom: auto;
            padding-top: 2rem;
            padding-bottom: 2rem;
            gap: 1.75rem;
          }
          .create-card {
            min-height: 225px;
            padding: 1.5rem;
          }
          .create-card-title {
            font-size: 1.5rem;
            line-height: 2rem;
          }
          .create-card-desc {
            font-size: 15px;
            line-height: 1.4;
          }
        }
      `}</style>
    </div>
  );
}

function ModeSelectionDialog({
  open,
  onSelect,
  onClose,
}: {
  open: boolean;
  onSelect: (mode: "simple" | "advanced") => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("editor");
  // Escape used to be wired to a div nobody could focus, so the key never
  // reached the handler: the backdrop closed the dialog and the keyboard did
  // not. Trapping focus inside the panel puts the keydown back in range, and
  // brings Tab containment and focus return with it.
  const panelRef = useRef<HTMLDivElement>(null);
  useModalFocus(panelRef, open);
  if (!open) return null;

  return (
    <div
      ref={panelRef}
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="mode-dialog-title"
      onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
    >
      <div className="absolute inset-0 modal-backdrop" onClick={onClose} />
      <div className="relative z-10 w-full max-w-lg mx-4 rounded-2xl border border-border bg-popover p-6 shadow-2xl animate-[fadeInUp_0.3s_ease-out_both]">
        <h2 id="mode-dialog-title" className="text-xl font-bold text-foreground mb-1">
          {t("quickCreate.modeDialogTitle")}
        </h2>
        <p className="text-sm text-muted-foreground mb-6">
          {t("quickCreate.modeDialogSubtitle")}
        </p>

        <div className="grid grid-cols-2 gap-4">
          <button
            onClick={() => onSelect("simple")}
            className="group flex flex-col rounded-xl border border-border bg-card p-5 text-left transition-all hover:border-gold/50 hover:bg-gold/5"
          >
            <Sparkles className="mb-3 h-8 w-8 text-gold" />
            <span className="text-base font-bold text-foreground mb-1">
              {t("quickCreate.modeSimpleTitle")}
            </span>
            <span className="text-xs text-muted-foreground leading-relaxed">
              {t("quickCreate.modeSimpleDesc")}
            </span>
          </button>

          <button
            onClick={() => onSelect("advanced")}
            className="group flex flex-col rounded-xl border border-border bg-card p-5 text-left transition-all hover:border-primary/50 hover:bg-primary/5"
          >
            <Wand2 className="mb-3 h-8 w-8 text-primary" />
            <span className="text-base font-bold text-foreground mb-1">
              {t("quickCreate.modeAdvancedTitle")}
            </span>
            <span className="text-xs text-muted-foreground leading-relaxed">
              {t("quickCreate.modeAdvancedDesc")}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}

function WorldCreatePage() {
  const [picked, setPicked] = useState(false);
  const [quickCreate, setQuickCreate] = useState(false);
  /** An advanced card on its way to the canvas: the save it needs first is a
   *  round trip, and rendering the classic editor meanwhile was a flash of the
   *  surface the creator is not going to use. */
  const [enteringStudio, setEnteringStudio] = useState(false);
  const mounted = useRef(true);
  const [pendingTemplate, setPendingTemplate] = useState<WorldTemplate | null | undefined>(undefined);
  const [pendingLoadedDraft, setPendingLoadedDraft] = useState(false);
  const pendingCover = useRef<Blob | null>(null);
  /** An imported file becomes a saved card the moment it opens, PNG or JSON
   *  alike. A PNG always had to save first (its cover uploads against a real
   *  world); a JSON used to open unsaved, so the same card imported two ways
   *  appeared in 我的卡 once and not the other time. */
  const pendingImportSave = useRef(false);
  const importInFlight = useRef(false);
  const [applyOffer, setApplyOffer] = useState<{
    world: WorldDefinition;
    coverImage: Blob | null;
    targets: ApplyTarget[];
    fileName: string;
  } | null>(null);
  const [showModeDialog, setShowModeDialog] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const setPickerActive = useCreatePageStore((s: { setPickerActive: (active: boolean) => void }) => s.setPickerActive);
  const isDirty = useEditorStore((s) => s.isDirty);
  const { isAuthenticated, requireAuth } = useAuthGuard();

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // Set guest mode before paint so the editor never exposes an interactive
  // frame while the auth-derived store flag is still catching up.
  useLayoutEffect(() => {
    const store = useEditorStore.getState();
    store.setGuestMode(!isAuthenticated);
    return () => { store.setGuestMode(false); };
  }, [isAuthenticated]);

  // Block SPA navigation + browser close when there are unsaved changes (skip for guests)
  const blocker = useUnsavedChangesGuard(isAuthenticated && (picked || pendingLoadedDraft) && isDirty, {
    getIsDirty: () => isAuthenticated && (picked || pendingLoadedDraft) && useEditorStore.getState().isDirty,
  });

  // Once the first save gives the card an id, the address bar says where it
  // lives. Left on /create, a refresh dropped the creator back on the template
  // picker with no sign their card existed. Only the URL changes: navigating
  // would remount the editor and end the first-run tour halfway through.
  const serverWorldId = useEditorStore((s) => s.serverWorldId);
  const swappedUrl = useRef(false);
  useEffect(() => {
    if (!picked) {
      // Back to the picker: the address goes back to the page on screen.
      if (swappedUrl.current) window.history.replaceState(window.history.state, "", "/app/worlds/create");
      swappedUrl.current = false;
      return;
    }
    if (enteringStudio || !serverWorldId) return;
    const path = `/app/worlds/${serverWorldId}/edit`;
    if (window.location.pathname === path) return;
    window.history.replaceState(window.history.state, "", path);
    swappedUrl.current = true;
  }, [picked, enteringStudio, serverWorldId]);

  useLayoutEffect(() => {
    // Switch the picker header/scroll owner before the editor can paint.
    setPickerActive(!picked);
    return () => {
      setPickerActive(false);
      useEditorStore.getState().stopAutosave();
    };
  }, [picked, setPickerActive]);

  // Simple mode opens in place. Advanced goes to the canvas, because that is
  // where an advanced card is edited from now on: leaving the first session
  // here would teach someone one editor and hand them another the next time
  // they open the card. The canvas needs a saved card, so this saves once —
  // and a save that cannot happen (no name yet, offline, signed out) leaves
  // them in this editor, which still works and still carries the switch.
  const openLoadedDraft = useCallback(async (mode: "simple" | "advanced", fromTemplate = false) => {
    useEditorStore.getState().setField("editorMode", mode);
    setPendingLoadedDraft(false);
    setPendingTemplate(undefined);
    setQuickCreate(mode === "simple");
    // Held on a spinner until we know whether this card opens on the canvas;
    // only a card that stays here (phone, switch turned off, save failed)
    // ever shows the classic editor.
    setEnteringStudio(mode === "advanced");
    setPicked(true);
    try {
      const importing = pendingImportSave.current;
      pendingImportSave.current = false;
      if (pendingCover.current) {
        const cover = pendingCover.current;
        pendingCover.current = null;
        await useEditorStore.getState().applyImportedCover(cover);
        // The cover lands in the draft after the save that made the world, so
        // save once more — otherwise the next visit offers to 「恢复」 an edit
        // the creator never made.
        if (importing && useEditorStore.getState().isDirty) await useEditorStore.getState().saveDraft();
      } else if (importing && !useEditorStore.getState().serverWorldId) {
        const store = useEditorStore.getState();
        if (!store.worldDraft.name?.trim()) {
          store.setField("name", i18n.t("editor:shell.untitledWorld", { defaultValue: "Untitled World" }));
        }
        await store.saveDraft();
      }
      // Everything so far — the template, its screen, the bundle and the
      // name it brought, the mode — is how the card STARTS, not an edit:
      // the first Ctrl+Z must not take the whole template away.
      useEditorStore.getState().clearHistory();
      if (mode !== "advanced") return;
      if (!shouldOpenVisual({ mode: "advanced", last: getEditorSurface(),
        allowed: await fetchBlueprintAccess(), guest: !isAuthenticated })) return;
      const id = await prepareStudioEntry(useEditorStore.getState);
      if (!id) return;
      saveEditorSurface("visual");
      // A template or an imported card opens on a board it filled; the
      // first-visit welcome would cover it, and its first lesson talks about
      // a greeting we wrote (it stays one click away under 帮助).
      if (fromTemplate || importing) requestQuietTour();
      await router.navigate({ to: "/app/studio/$worldId", params: { worldId: id } });
    } finally {
      setEnteringStudio(false);
    }
  }, [isAuthenticated, router]);

  const applyTemplate = useCallback(async (template: WorldTemplate | null, mode: "simple" | "advanced") => {
    pendingCover.current = null;
    pendingImportSave.current = false;
    const store = useEditorStore.getState();
    if (template) {
      store.loadTemplate(template);
    } else {
      // A blank card still opens on something: its first moment, as a real
      // opening the author writes over. With none, the player's screen on
      // the board was an empty chat.
      store.createNew(defaultOpening());
    }
    const uiLang = i18n.language?.split("-")[0];
    if (uiLang) {
      store.setLanguage(uiLang);
    }
    // Guests retain their existing local preview and sign-in entry points.
    // Signed-in advanced creators always enter Studio, including after retry.
    await openLoadedDraft(mode, !!template);
  }, [openLoadedDraft]);

  /** The saved editor-mode preference short-circuits straight into the
   *  editor, otherwise ask simple/advanced. */
  const proceedWithTemplate = useCallback((template: WorldTemplate | null) => {
    const globalPref = getGlobalEditorMode();
    if (globalPref) {
      void applyTemplate(template, globalPref);
    } else {
      setPendingTemplate(template);
      setPendingLoadedDraft(false);
      setShowModeDialog(true);
    }
  }, [applyTemplate]);

  const handleSelect = useCallback(async (template: WorldTemplate | null) => {
    if (importInFlight.current) return;
    await i18n.loadNamespaces("templates-content");
    // Like a new deck: the card starts as its skeleton, and ready-made
    // screens (选开局, 填名字, 背包…) are added from 新建一页 when wanted.
    proceedWithTemplate(template);
  }, [proceedWithTemplate]);

  const handleModeSelected = useCallback((mode: "simple" | "advanced") => {
    saveGlobalEditorMode(mode);
    setShowModeDialog(false);
    if (pendingLoadedDraft) {
      void openLoadedDraft(mode);
    } else if (pendingTemplate !== undefined) {
      void applyTemplate(pendingTemplate, mode);
    }
  }, [pendingLoadedDraft, pendingTemplate, openLoadedDraft, applyTemplate]);

  // Continue an import as a brand-new card (also the "keep as a new project"
  // answer when the file turned out to be one of the creator's own cards).
  const importAsNewWorld = useCallback(async (worldDef: WorldDefinition, coverImage: Blob | null) => {
    pendingCover.current = null;
    pendingImportSave.current = true;
    const store = useEditorStore.getState();
    store.loadWorldDefinition(worldDef);
    // Default to UI language if the imported file has none. Re-read state:
    // `store` is a pre-import snapshot, and loadWorldDefinition just reset
    // `language` from the imported definition (usually null — exported
    // schemas don't carry the DB-level language column). Reading the stale
    // snapshot here skipped the backfill whenever the previous editor
    // session had a language set, creating language-less worlds that fall
    // out of the hub's locale filters.
    if (!useEditorStore.getState().language) {
      const uiLang = i18n.language?.split("-")[0];
      if (uiLang) store.setLanguage(uiLang);
    }
    // The imported draft is already initialized. Choosing a mode may only
    // open it — it must never run createNew/loadTemplate again.
    store.stopAutosave();
    pendingCover.current = coverImage ?? null;
    const globalPref = getGlobalEditorMode();
    if (!globalPref) {
      setPendingTemplate(undefined);
      setPendingLoadedDraft(true);
      setShowModeDialog(true);
    }
    // The editor that appears next is the confirmation; no pill needed.
    // openLoadedDraft also applies the PNG card image as the cover (it is
    // parked in pendingCover above). When no mode is stored the dialog runs
    // first, so the cover waits for that choice rather than being orphaned.
    if (globalPref) await openLoadedDraft(globalPref);
  }, [openLoadedDraft]);

  const handleFileImport = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || importInFlight.current) return;

    // Reset input so same file can be re-selected
    e.target.value = "";

    if (!isAuthenticated) {
      requireAuth("create worlds");
      return;
    }

    importInFlight.current = true;
    setImportError(null);

    try {
      const result = await parseImportedFileFlexible(file, { sourceHint: "auto" });
      if (!mounted.current) return;
      pendingCover.current = null;
      pendingImportSave.current = true;

      // Bundle file → seed a brand-new card from it. The create screen starts
      // from a blank world, so importBundle merges with zero conflicts.
      // Content-rich bundles default to Studio unless simple was preferred.
      if (result.kind === "bundle") {
        const store = useEditorStore.getState();
        const bundle = result.bundle;
        store.createNew();
        store.importBundle(bundle);
        // importBundle only brings CONTENT — seed the card's own identity too.
        if (bundle.name) store.setField("name", bundle.name);
        if (bundle.description) store.setField("description", bundle.description);
        if (Array.isArray(bundle.tags) && bundle.tags.length > 0) {
          store.setTags(clampWorldTags(bundle.tags));
        }
        // Re-read state: `store` is a snapshot from before createNew/importBundle,
        // so its `language` is stale here.
        if (!useEditorStore.getState().language) {
          const uiLang = i18n.language?.split("-")[0];
          if (uiLang) store.setLanguage(uiLang);
        }
        const mode = getGlobalEditorMode() ?? "advanced";
        // The editor that appears next — with the bundle's entries, variables,
        // and rules already loaded — is the confirmation; no pill needed.
        // openLoadedDraft records the mode, switches to the right shell and,
        // for a signed-in advanced creator, creates the server draft.
        await openLoadedDraft(mode);
        return;
      }

      // One of the creator's own cards coming back (downloaded, edited
      // elsewhere, re-imported): offer to update that card rather than
      // quietly making yet another copy of it.
      const targets = await findImportTargets(result.world, result.originWorldId);
      if (!mounted.current) return;
      if (targets.length > 0) {
        setApplyOffer({ world: result.world, coverImage: result.coverImage, targets, fileName: file.name });
        return;
      }
      await importAsNewWorld(result.world, result.coverImage);
    } catch (err) {
      // Show WHY it failed, not just a contentless "import failed" — e.g. a
      // Yumina bundle or UI-package (what the editor's export / AI assistant
      // produce) is deliberately rejected here and tells the user which import
      // flow to use instead. This is validation on the file the user just
      // picked, so it lives inline on the picker rather than in a pill.
      const reason = err instanceof Error ? err.message : null;
      setImportError(reason || i18n.t("toasts:failedImportWorld", { defaultValue: "Import failed" }));
    } finally {
      importInFlight.current = false;
    }
  }, [isAuthenticated, requireAuth, openLoadedDraft, importAsNewWorld]);

  if (!picked) {
    return (
      <>
        <TemplatePicker
          onSelect={handleSelect}
          onBack={() => {
            navigateBackSafely(router.history, getLandingRoute());
          }}
          onImport={() => {
            setImportError(null);
            if (isAuthenticated) {
              fileInputRef.current?.click();
            } else {
              requireAuth("create worlds");
            }
          }}
          importError={importError}
        />
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,.png"
          className="hidden"
          onChange={handleFileImport}
        />
        <ModeSelectionDialog
          open={showModeDialog}
          onSelect={handleModeSelected}
          onClose={() => setShowModeDialog(false)}
        />
        <UnsavedChangesDialog blocker={blocker} />
        {applyOffer && (
          <ApplyChangesDialog
            open
            onClose={() => setApplyOffer(null)}
            targets={applyOffer.targets}
            incoming={applyOffer.world}
            source={{ kind: "file", fileName: applyOffer.fileName }}
            onSaveAsNew={async () => {
              const offer = applyOffer;
              setApplyOffer(null);
              await importAsNewWorld(offer.world, offer.coverImage);
            }}
          />
        )}
      </>
    );
  }

  if (enteringStudio) return <LoadingSpinner />;

  if (quickCreate) {
    return (
      <>
        <Suspense fallback={<LoadingSpinner />}>
          <QuickCreateEditor
            autoTour
            onOpenFullEditor={() => void openLoadedDraft("advanced")}
            onBack={() => { setPicked(false); setQuickCreate(false); }}
          />
        </Suspense>
        <UnsavedChangesDialog blocker={blocker} />
      </>
    );
  }

  return (
    <>
      <Suspense fallback={<LoadingSpinner />}>
        <EditorShell autoTour onSwitchToSimple={() => setQuickCreate(true)} />
      </Suspense>
      <UnsavedChangesDialog blocker={blocker} />
    </>
  );
}

export const Route = createFileRoute("/app/worlds/create")({
  component: WorldCreatePage,
});

function LoadingSpinner() {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground/40" />
    </div>
  );
}
