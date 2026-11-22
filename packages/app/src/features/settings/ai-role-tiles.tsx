import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Bot, Check, ChevronDown, ChevronRight, Lock } from "lucide-react";
import {
  DEFAULT_BACKGROUND_MODEL,
  FILM_PARTNER_VIDEO_MODELS,
  FOLLOW_STORY_MODEL,
  PLAY_MODELS,
  filmPartnerShotPrice,
  formatModelId,
  getVideoModel,
  parseStateGuardModel,
  stateGuardModelSelection,
  type PlayerTextAiRole,
} from "@yumina/shared";
import { useConfigStore } from "@/stores/config";
import { useCreditStore } from "@/edition/slots.state";
import { ModelBrowser } from "@/features/chat/model-browser";
import { InfoTip } from "@/components/ui/info-tip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

function modelName(id: string): string {
  return PLAY_MODELS.find((model) => model.id === id)?.name ?? formatModelId(id);
}

const menuClass = "profile-overview-dropdown-surface w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-gold/20 p-1.5 text-main shadow-2xl shadow-black/40 backdrop-blur-xl";
const tileClass = "flex min-w-0 items-center gap-2 rounded-lg bg-white/[0.02] px-3 py-2.5 text-left";

/** A tile's two lines: which AI, and what it runs on. A gold dot marks a choice the player made. */
function TileBody({ label, value, changed, icon }: { label: ReactNode; value: ReactNode; changed?: boolean; icon?: ReactNode }) {
  return (
    <>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1 text-[11px] text-white/40">{label}</div>
        <div className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-white/80">
          {icon}
          <span className="truncate">{value}</span>
          {changed && <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-gold" />}
        </div>
      </div>
    </>
  );
}

function Option({ label, description, selected, onSelect }: { label: ReactNode; description?: ReactNode; selected: boolean; onSelect: () => void }) {
  return (
    <DropdownMenuItem
      onSelect={onSelect}
      className={cn("flex items-start gap-2 rounded-lg px-3 py-2", selected ? "bg-primary/5 text-primary" : "text-foreground")}
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-medium">{label}</span>
        {description && <span className="text-xs text-muted-foreground">{description}</span>}
      </div>
      {selected && <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />}
    </DropdownMenuItem>
  );
}

export type AiRoleTile = PlayerTextAiRole | "voice" | "decision" | "video" | "write";

/**
 * Tiles for the AIs besides the story one, on the Advanced page (owner
 * 2026-10-26: the AI Settings card stays as it was; these would only make
 * players anxious there). Background AIs follow a cheap default until the
 * player picks; voice is chosen per character in the chat; decision stays
 * on the judge model.
 */
export function AiRoleTiles({ roles, className }: { roles: readonly AiRoleTile[]; className?: string }) {
  const { t } = useTranslation("profile");
  const roleModels = useConfigStore((s) => s.roleModels);
  const setConfig = useConfigStore((s) => s.setConfig);
  const privateMode = useCreditStore((s) => s.provider === "private");
  const [picking, setPicking] = useState<PlayerTextAiRole | "write" | null>(null);

  const setRole = (role: keyof typeof roleModels, value: string | null) => {
    const next = { ...roleModels };
    if (value) next[role] = value;
    else delete next[role];
    setConfig("roleModels", next);
  };
  // The state check stores which key pays alongside the model.
  const toStored = (role: PlayerTextAiRole, id: string) =>
    role === "guard" ? stateGuardModelSelection(id, privateMode ? "private" : "official") : id;
  const pickedModel = (role: PlayerTextAiRole | "write") => {
    const stored = roleModels[role];
    if (!stored || stored === FOLLOW_STORY_MODEL) return null;
    return role === "guard" ? parseStateGuardModel(stored).model ?? stored : stored;
  };

  const textTile = (role: PlayerTextAiRole, note?: string) => {
    const stored = roleModels[role];
    const model = pickedModel(role);
    const value = model ? modelName(model) : stored === FOLLOW_STORY_MODEL ? t("config.roles.optStory") : t("config.roles.optDefault");
    return (
      <DropdownMenu key={role} modal={false}>
        <DropdownMenuTrigger asChild>
          <button type="button" className={cn(tileClass, "group transition-colors hover:bg-white/[0.04] data-[state=open]:bg-white/[0.05]")}>
            <TileBody label={t(`config.roles.${role}`)} value={value} changed={!!stored} />
            <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-white/20 transition-transform group-hover:text-white/40 group-data-[state=open]:rotate-180" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className={menuClass}>
          {note && <p className="px-3 pb-1.5 pt-1 text-xs text-muted-foreground">{note}</p>}
          <Option
            label={t("config.roles.optDefault")}
            description={role === "guard" ? t("config.roles.optGuardDefaultDesc") : t("config.roles.optDefaultDesc", { model: modelName(DEFAULT_BACKGROUND_MODEL) })}
            selected={!stored}
            onSelect={() => setRole(role, null)}
          />
          <Option
            label={t("config.roles.optStory")}
            // The recap makes several calls a run: on a priced story model
            // that added up to hundreds of mushies a fold (2026-11-08).
            description={role === "summary" ? t("config.roles.optStoryDescSummary") : t("config.roles.optStoryDesc")}
            selected={stored === FOLLOW_STORY_MODEL}
            onSelect={() => setRole(role, FOLLOW_STORY_MODEL)}
          />
          {model && <Option label={modelName(model)} selected onSelect={() => undefined} />}
          <DropdownMenuSeparator className="bg-white/[0.06]" />
          <Option label={t("config.roles.optPick")} selected={false} onSelect={() => setPicking(role)} />
        </DropdownMenuContent>
      </DropdownMenu>
    );
  };

  // 帮我写 has no platform default: it writes on the story model until the player picks one.
  const writeModel = pickedModel("write");

  const video = roleModels.video;
  const videoName = video ? getVideoModel(video)?.name ?? video : "MiniMax H3";

  return (
    <>
      <div className={cn("grid grid-cols-2 gap-1.5", className)}>
        {roles.map((role) => {
          if (role === "voice") return (
            <div key={role} className={tileClass}>
              <TileBody label={<>{t("config.roles.voice")}<InfoTip text={t("config.roles.voiceTip")} /></>} value={t("config.roles.voiceValue")} />
            </div>
          );
          if (role === "decision") return (
            <div key={role} className={tileClass}>
              <TileBody
                label={<>{t("config.roles.decision")}<InfoTip text={t("config.roles.decisionTip")} /></>}
                value={t("config.roles.decisionFixed")}
                icon={<Lock aria-hidden="true" className="h-3 w-3 shrink-0 text-white/35" />}
              />
            </div>
          );
          if (role === "write") return (
            <DropdownMenu key={role} modal={false}>
              <DropdownMenuTrigger asChild>
                <button type="button" data-role-tile="write" className={cn(tileClass, "group transition-colors hover:bg-white/[0.04] data-[state=open]:bg-white/[0.05]")}>
                  <TileBody label={t("config.roles.write")} value={writeModel ? modelName(writeModel) : t("config.roles.optStory")} changed={!!writeModel} />
                  <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-white/20 transition-transform group-hover:text-white/40 group-data-[state=open]:rotate-180" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className={menuClass}>
                <Option label={t("config.roles.optStory")} description={t("config.roles.optStoryDesc")} selected={!writeModel} onSelect={() => setRole("write", null)} />
                {writeModel && <Option label={modelName(writeModel)} selected onSelect={() => undefined} />}
                <DropdownMenuSeparator className="bg-white/[0.06]" />
                <Option label={t("config.roles.optPick")} selected={false} onSelect={() => setPicking("write")} />
              </DropdownMenuContent>
            </DropdownMenu>
          );
          if (role === "video") return (
            <DropdownMenu key={role} modal={false}>
              <DropdownMenuTrigger asChild>
                <button type="button" className={cn(tileClass, "group transition-colors hover:bg-white/[0.04] data-[state=open]:bg-white/[0.05]")}>
                  <TileBody label={t("config.roles.video")} value={videoName} changed={!!video} />
                  <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-white/20 transition-transform group-hover:text-white/40 group-data-[state=open]:rotate-180" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className={menuClass}>
                <Option label="MiniMax H3" description={t("config.roles.videoDefaultDesc")} selected={!video} onSelect={() => setRole("video", null)} />
                {FILM_PARTNER_VIDEO_MODELS.map((id) => (
                  <Option
                    key={id}
                    label={getVideoModel(id)?.name ?? id}
                    description={t("config.roles.videoPrice", { price: filmPartnerShotPrice(id).toLocaleString() })}
                    selected={video === id}
                    onSelect={() => setRole("video", id)}
                  />
                ))}
                <p className="px-3 pb-1 pt-2 text-[11px] leading-snug text-muted-foreground">{t("config.roles.videoNote")}</p>
              </DropdownMenuContent>
            </DropdownMenu>
          );
          return textTile(role, role === "world" ? t("config.roles.worldTip") : undefined);
        })}
      </div>
      <ModelBrowser
        open={picking !== null}
        onClose={() => setPicking(null)}
        selectionOnly
        selectedModel={picking ? pickedModel(picking) ?? "" : ""}
        onSelect={(id) => {
          if (picking === "write") setRole("write", id);
          else if (picking) setRole(picking, toStored(picking, id));
          setPicking(null);
        }}
      />
    </>
  );
}

/**
 * The Advanced page's section for every AI besides the story one. The ones a
 * player might care about are out; memory, summary and the state check run on
 * their own and stay folded until opened (or until the player changed one).
 */
export function OtherAiSettings() {
  const { t } = useTranslation("profile");
  const roleModels = useConfigStore((s) => s.roleModels);
  // The recap's model ("summary") sits with the recap's size (recap-share-setting).
  const changedBackground = !!(roleModels.memory || roleModels.guard);
  const [open, setOpen] = useState(changedBackground);
  return (
    <section id="other-ais" className="scroll-mt-6 border-b border-white/[0.06] pb-5" aria-labelledby="other-ais-title">
      <h3 id="other-ais-title" className="flex items-center gap-2 text-sm font-medium text-main">
        <Bot className="h-4 w-4 text-gold" aria-hidden="true" />{t("config.roles.otherAis")}<InfoTip text={t("config.roles.otherAisTip")} />
      </h3>
      <AiRoleTiles roles={["world", "write", "video", "voice", "decision"]} className="mt-3 md:grid-cols-5" />
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="mt-3 flex items-center gap-1.5 text-xs font-medium text-sub transition-colors hover:text-main"
      >
        <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")} aria-hidden="true" />
        {t("config.roles.backgroundAis")}
      </button>
      {open && (
        <div className="mt-2 animate-in fade-in duration-200">
          <p className="mb-2 text-xs text-sub">{t("config.roles.backgroundAisHint")}</p>
          <AiRoleTiles roles={["memory", "guard"]} className="md:grid-cols-2" />
        </div>
      )}
    </section>
  );
}
