import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import { ArrowDown, ArrowUp, BookOpenText, Dices, ImagePlus, Loader2, Plus, UserRound, UserRoundPlus, Users, X } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { AssetPicker } from "@/features/editor/asset-picker";
import { resolveImageUrl } from "@/lib/asset-url";
import { isAlwaysSendEntry } from "@yumina/engine";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useEditorStore } from "@/stores/editor";
import { useStudioStore } from "@/stores/studio";
import { STUDIO_ASK_EVENT, type StudioAskDetail } from "@/features/studio/lib/block-ask";
import { cn } from "@/lib/utils";
import { feedback } from "@/lib/feedback";
import { requestRoomOnNextPlay } from "@/features/story-room/room-store";
import { Check, DraftInput, Field, Group, Row, Stepper, Switch, rowControl } from "./controls";
import { ModelIdInput } from "./story-ai-settings";
import {
  addAiName,
  addRole,
  clampSeatRange,
  defaultRulesFile,
  moveRole,
  multiplayerForm,
  multiplayerSetting,
  removeAiName,
  removeRole,
  roleSourceEntries,
  rulesFileChoices,
  updateRole,
  MAX_AI_NAMES,
  MAX_ROLES,
  type MultiplayerForm,
} from "./multiplayer-form";
import { MULTIPLAYER_MAX_SEATS, MULTIPLAYER_MIN_SEATS } from "@yumina/shared";

/** The card's 联机 chip on the board opens the card settings here. A flag,
 *  not only an event: the group may not be mounted yet when it is asked. */
const MULTIPLAYER_FOCUS_EVENT = "yumina:studio-multiplayer-focus";
let focusPending = false;
export function requestMultiplayerFocus(): void {
  focusPending = true;
  window.dispatchEvent(new Event(MULTIPLAYER_FOCUS_EVENT));
}

const small = "rounded-md border border-white/10 bg-background px-1.5 py-1 text-[11px] outline-none focus:border-sky-400/60";
const iconButton = "shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-30 disabled:hover:text-muted-foreground";

/**
 * 联机: whether friends can play this card together, and how.
 *
 * Off unless the author turns it on. Story mode shares one story among the
 * players (seats, the roles they can take); rules mode runs the card's own
 * rules file at a table, empty seats taken by AI. Written into
 * settings.multiplayer through the draft, so it saves and undoes with the rest.
 */
export function MultiplayerGroup({ card = false }: { card?: boolean } = {}) {
  const { t } = useTranslation("editor");
  const raw = useEditorStore((s) => s.worldDraft.settings?.multiplayer);
  const files = useEditorStore((s) => s.worldDraft.rootComponent?.files);
  const entries = useEditorStore((s) => s.worldDraft.entries);
  const setSettings = useEditorStore((s) => s.setSettings);
  const form = useMemo(() => multiplayerForm(raw), [raw]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const go = () => {
      if (!focusPending) return;
      focusPending = false;
      // After the inspector has laid out the card's form above.
      window.setTimeout(() => ref.current?.scrollIntoView({ block: "start", behavior: "smooth" }), 120);
    };
    go();
    window.addEventListener(MULTIPLAYER_FOCUS_EVENT, go);
    return () => window.removeEventListener(MULTIPLAYER_FOCUS_EVENT, go);
  }, []);

  const write = (patch: Partial<MultiplayerForm>) => {
    const current = useEditorStore.getState().worldDraft.settings?.multiplayer;
    setSettings("multiplayer", multiplayerSetting({ ...multiplayerForm(current), ...patch }, current));
  };
  const rulesFiles = useMemo(() => rulesFileChoices(files), [files]);
  const pickRules = (patch: Partial<MultiplayerForm>) => {
    const next = { ...form, ...patch };
    write(next.mode === "rules" && !next.rulesFile ? { ...patch, rulesFile: defaultRulesFile(files) } : patch);
  };

  const body = (
    <div ref={ref} data-insp-multiplayer="" className="scroll-mt-3">
      <Group
        title={t("blueprint.multiplayer.title")}
        right={<Switch checked={form.enabled} label={t("blueprint.multiplayer.title")} onChange={(enabled) => pickRules({ enabled })} />}
      >
        {form.enabled && (
          <>
            <div role="radiogroup" aria-label={t("blueprint.multiplayer.mode")} className="grid grid-cols-2 gap-2 pb-1" data-mp-mode="">
              {([
                { value: "story", label: t("blueprint.multiplayer.story"), Icon: BookOpenText },
                { value: "rules", label: t("blueprint.multiplayer.rules"), Icon: Dices },
              ] as const).map(({ value, label, Icon }) => {
                const on = form.mode === value;
                return (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => pickRules({ mode: value })}
                    className={cn(
                      "flex flex-col items-start gap-2 rounded-xl border px-3 py-2.5 text-left transition-colors",
                      on ? "border-[rgba(240,198,116,0.55)] bg-[rgba(240,198,116,0.09)]" : "border-white/[0.08] bg-white/[0.02] hover:border-white/20",
                    )}
                  >
                    <Icon className={cn("h-4 w-4", on ? "text-[#f5d48a]" : "text-foreground/45")} />
                    <span className={cn("text-[12.5px] font-semibold", on ? "text-[#f5d48a]" : "text-foreground/80")}>{label}</span>
                  </button>
                );
              })}
            </div>
            <Row label={t("blueprint.multiplayer.seats")} wide>
              <Stepper
                label={t("blueprint.multiplayer.seatsMin")}
                value={form.minSeats}
                min={MULTIPLAYER_MIN_SEATS}
                max={MULTIPLAYER_MAX_SEATS}
                onChange={(n) => { const r = clampSeatRange(n, form.maxSeats, "min"); write({ minSeats: r.min, maxSeats: r.max }); }}
              />
              <span className="text-xs text-foreground/45">–</span>
              <Stepper
                label={t("blueprint.multiplayer.seatsMax")}
                value={form.maxSeats}
                min={MULTIPLAYER_MIN_SEATS}
                max={MULTIPLAYER_MAX_SEATS}
                onChange={(n) => { const r = clampSeatRange(form.minSeats, n, "max"); write({ minSeats: r.min, maxSeats: r.max }); }}
              />
            </Row>
            {form.mode === "story"
              ? <StoryRoles form={form} entries={entries} write={write} />
              : <RulesTable form={form} rulesFiles={rulesFiles} write={write} />}
            <TryTable story={form.mode === "story"} />
          </>
        )}
      </Group>
    </div>
  );
  return card ? <div className="rounded-lg border border-border bg-background p-5">{body}</div> : body;
}

type Entry = { id: string; name?: string; role?: string; enabled?: boolean; alwaysSend?: boolean; variableBound?: boolean; conditions?: unknown[]; portrait?: string };

/** A role's picture: the author's own pick, or (shown, not stored) its linked character's portrait. */
function RolePicture({ value, own, onChange }: { value?: string; own: boolean; onChange: (image: string | undefined) => void }) {
  const { t } = useTranslation("editor");
  const serverWorldId = useEditorStore((s) => s.serverWorldId);
  const saveDraft = useEditorStore((s) => s.saveDraft);
  const [picking, setPicking] = useState(false);
  const src = value ? resolveImageUrl(value) : undefined;
  const open = async () => {
    if (!useEditorStore.getState().serverWorldId) await saveDraft();
    if (useEditorStore.getState().serverWorldId) setPicking(true);
  };
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => void open()}
        aria-label={t("blueprint.multiplayer.rolePicture")}
        title={t("blueprint.multiplayer.rolePicture")}
        data-mp-role-picture=""
        className={cn(
          "group flex h-[4.25rem] w-[3.25rem] items-center justify-center overflow-hidden rounded-lg border bg-background/50 transition-colors",
          src ? "border-white/10 hover:border-[rgba(240,198,116,0.6)]" : "border-dashed border-white/15 hover:border-[rgba(240,198,116,0.5)]",
        )}
      >
        {src ? <img src={src} alt="" draggable={false} className="h-full w-full object-cover" /> : <ImagePlus className="h-4 w-4 text-foreground/35 group-hover:text-[#f5d48a]" />}
      </button>
      {own && (
        <button
          type="button"
          onClick={() => onChange(undefined)}
          aria-label={t("blueprint.insp.delete")}
          className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full border border-white/15 bg-card text-muted-foreground hover:text-destructive"
        >
          <X className="h-2.5 w-2.5" />
        </button>
      )}
      {picking && serverWorldId && createPortal(
        <AssetPicker worldId={serverWorldId} filterType="image" onSelect={(ref) => { onChange(ref); setPicking(false); }} onClose={() => setPicking(false)} />,
        document.body,
      )}
    </div>
  );
}

function StoryRoles({ form, entries, write }: { form: MultiplayerForm; entries: readonly Entry[]; write: (patch: Partial<MultiplayerForm>) => void }) {
  const { t } = useTranslation("editor");
  const [name, setName] = useState("");
  const sources = useMemo(
    () => roleSourceEntries(entries, (e) => isAlwaysSendEntry(e as Parameters<typeof isAlwaysSendEntry>[0])),
    [entries],
  );
  const entryName = (id: string | undefined) => (id ? entries.find((e) => e.id === id)?.name : undefined);
  const portraitOf = (id: string | undefined) => (id ? entries.find((e) => e.id === id)?.portrait : undefined);
  const roles = form.roles;
  const full = roles.length >= MAX_ROLES;
  const addTyped = () => {
    if (!name.trim()) return;
    write({ roles: addRole(roles, { name }) });
    setName("");
  };
  return (
    <>
      <Field label={t("blueprint.multiplayer.roles")}>
        <div className="space-y-1">
          {roles.map((role, i) => {
            const linked = entryName(role.entryId);
            return (
              <div key={role.id} data-mp-role={role.id} className="flex gap-2.5 rounded-xl border border-white/[0.07] bg-white/[0.02] p-2">
                <RolePicture
                  value={role.image ?? portraitOf(role.entryId)}
                  own={!!role.image}
                  onChange={(image) => write({ roles: updateRole(roles, role.id, { image: image ?? null }) })}
                />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center gap-1">
                    {role.entryId && <span title={linked ?? role.entryId} className="shrink-0 text-foreground/45"><UserRound className="h-3.5 w-3.5" /></span>}
                    <DraftInput
                      aria-label={t("blueprint.multiplayer.roleName")}
                      value={role.name}
                      onCommit={(raw) => write({ roles: updateRole(roles, role.id, { name: raw }) })}
                      className={cn(small, "min-w-0 flex-1 border-transparent bg-transparent px-1 text-[13px] font-semibold hover:border-white/10")}
                    />
                    <button type="button" aria-label={t("blueprint.multiplayer.moveUp")} disabled={i === 0} onClick={() => write({ roles: moveRole(roles, role.id, -1) })} className={iconButton}><ArrowUp className="h-3.5 w-3.5" /></button>
                    <button type="button" aria-label={t("blueprint.multiplayer.moveDown")} disabled={i === roles.length - 1} onClick={() => write({ roles: moveRole(roles, role.id, 1) })} className={iconButton}><ArrowDown className="h-3.5 w-3.5" /></button>
                    <button type="button" aria-label={t("blueprint.insp.delete")} onClick={() => write({ roles: removeRole(roles, role.id) })} className={iconButton}><X className="h-3.5 w-3.5" /></button>
                  </div>
                  <DraftInput
                    aria-label={t("blueprint.multiplayer.roleNote")}
                    placeholder={t("blueprint.multiplayer.roleNote")}
                    value={role.note ?? ""}
                    onCommit={(raw) => write({ roles: updateRole(roles, role.id, { note: raw }) })}
                    className={cn(small, "w-full border-transparent bg-transparent px-1 text-foreground/65 hover:border-white/10")}
                  />
                </div>
              </div>
            );
          })}
          {!full && (
            <div className="flex items-center gap-1">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") addTyped(); }}
                placeholder={t("blueprint.multiplayer.roleName")}
                aria-label={t("blueprint.multiplayer.roleName")}
                data-mp-role-new=""
                className={cn(small, "min-w-0 flex-1")}
              />
              {sources.length > 0 && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button type="button" title={t("blueprint.multiplayer.fromEntries")} aria-label={t("blueprint.multiplayer.fromEntries")} data-mp-role-pick="" className={cn(iconButton, "p-1 data-[state=open]:text-foreground")}>
                      <UserRoundPlus className="h-3.5 w-3.5" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="max-h-72 min-w-[10rem] overflow-y-auto">
                    {sources.map((e) => (
                      <DropdownMenuItem
                        key={e.id}
                        disabled={roles.some((r) => r.entryId === e.id)}
                        onSelect={() => write({ roles: addRole(roles, { name: e.name ?? "", entryId: e.id }) })}
                      >
                        {e.name}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              <button type="button" aria-label={t("blueprint.multiplayer.add")} disabled={!name.trim()} onClick={addTyped} className={cn(iconButton, "p-1")}>
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>
      </Field>
      {roles.length > 0 && (
        <Check label={t("blueprint.multiplayer.rolesRequired")} checked={form.rolesRequired} onChange={(rolesRequired) => write({ rolesRequired })} />
      )}
    </>
  );
}

function RulesTable({ form, rulesFiles, write }: { form: MultiplayerForm; rulesFiles: string[]; write: (patch: Partial<MultiplayerForm>) => void }) {
  const { t } = useTranslation("editor");
  const [aiName, setAiName] = useState("");
  const worldId = useEditorStore((s) => s.serverWorldId ?? s.worldDraft.id);
  const choices = form.rulesFile && !rulesFiles.includes(form.rulesFile) ? [form.rulesFile, ...rulesFiles] : rulesFiles;
  const askAssistant = () => {
    useStudioStore.getState().setAssistantMode("build");
    window.dispatchEvent(new CustomEvent<StudioAskDetail>(STUDIO_ASK_EVENT, {
      detail: { prompt: t("blueprint.multiplayer.askRules", { min: form.minSeats, max: form.maxSeats }), requestId: crypto.randomUUID(), ...(worldId ? { worldId } : {}) },
    }));
  };
  const addName = () => {
    if (!aiName.trim()) return;
    write({ aiNames: addAiName(form.aiNames, aiName) });
    setAiName("");
  };
  let rulesControl: ReactNode;
  if (choices.length === 0) {
    rulesControl = (
      <div data-mp-rules-empty="" className="flex items-center gap-2 rounded-lg border border-dashed border-white/15 px-2.5 py-2 text-[11.5px] text-foreground/60">
        <span className="min-w-0 flex-1">{t("blueprint.multiplayer.noRulesFile")}</span>
        <button
          type="button"
          onClick={askAssistant}
          data-mp-ask-rules=""
          className="shrink-0 rounded-md border border-[rgba(240,198,116,0.35)] bg-[rgba(240,198,116,0.1)] px-2 py-1 text-[11px] font-medium text-[#f5d48a] transition-colors hover:bg-[rgba(240,198,116,0.18)]"
        >
          {t("blueprint.multiplayer.askAssistant")}
        </button>
      </div>
    );
  } else {
    rulesControl = (
      <Row label={t("blueprint.multiplayer.rulesFile")}>
        <select
          aria-label={t("blueprint.multiplayer.rulesFile")}
          value={form.rulesFile ?? ""}
          onChange={(e) => write({ rulesFile: e.target.value || null })}
          data-mp-rules-file=""
          className={cn(rowControl, "font-mono")}
        >
          {!form.rulesFile && <option value="">—</option>}
          {choices.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
      </Row>
    );
  }
  return (
    <>
      {rulesControl}
      <Field label={t("blueprint.multiplayer.aiSeats")}>
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-1">
            {form.aiNames.map((n) => (
              <span key={n} data-mp-ai-name={n} className="flex items-center gap-0.5 rounded-full border border-white/10 bg-white/[0.04] py-px pl-2 pr-1 text-[11px] text-foreground/80">
                {n}
                <button type="button" aria-label={t("blueprint.insp.delete")} onClick={() => write({ aiNames: removeAiName(form.aiNames, n) })} className={iconButton}><X className="h-3 w-3" /></button>
              </span>
            ))}
            {form.aiNames.length < MAX_AI_NAMES && (
              <span className="flex min-w-[7rem] flex-1 items-center gap-1">
                <input
                  value={aiName}
                  onChange={(e) => setAiName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") addName(); }}
                  placeholder={t("blueprint.multiplayer.aiName")}
                  aria-label={t("blueprint.multiplayer.aiName")}
                  data-mp-ai-name-new=""
                  className={cn(small, "min-w-0 flex-1")}
                />
                <button type="button" aria-label={t("blueprint.multiplayer.add")} disabled={!aiName.trim()} onClick={addName} className={cn(iconButton, "p-1")}>
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </span>
            )}
          </div>
          <ModelIdInput
            value={form.aiModel ?? ""}
            onCommit={(aiModel) => write({ aiModel: aiModel ?? null })}
            placeholder={t("blueprint.multiplayer.aiModelDefault")}
            unknownLabel={t("blueprint.multiplayer.aiModelUnknown")}
            data-mp-ai-model=""
          />
        </div>
      </Field>
    </>
  );
}

const apiBase = import.meta.env.VITE_API_URL || "";

/** Opens a real table on the saved card, the way a player would: a new play
 *  session, and for story mode the room with its invite sheet. */
function TryTable({ story }: { story: boolean }) {
  const { t } = useTranslation("common");
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const open = async () => {
    setBusy(true);
    try {
      const editor = useEditorStore.getState();
      if ((editor.isDirty || !editor.serverWorldId) && !(await editor.saveDraft())) return;
      const worldId = useEditorStore.getState().serverWorldId;
      if (!worldId) return;
      const res = await fetch(`${apiBase}/api/sessions`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ worldId }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const { data } = (await res.json()) as { data: { id: string } };
      if (story) requestRoomOnNextPlay();
      void navigate({ to: "/app/chat/$sessionId", params: { sessionId: data.id } });
    } catch {
      feedback.error(t("chat:play.startFailed", "Couldn't start the session"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => void open()}
      data-mp-try=""
      className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-[rgba(240,198,116,0.35)] bg-[rgba(240,198,116,0.1)] px-3 py-2 text-[12.5px] font-semibold text-[#f5d48a] transition-colors hover:bg-[rgba(240,198,116,0.18)] disabled:opacity-50"
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Users className="h-3.5 w-3.5" />}
      {story ? t("storyRoom.tab.openRoom") : t("storyRoom.tab.openTable")}
    </button>
  );
}
