import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Camera, Save, Loader2, User, Plus, Trash2 } from "lucide-react";
import { personaEntriesSchema, MAX_PERSONA_ENTRIES, MAX_PERSONA_ENTRY_TITLE, MAX_PERSONA_ENTRY_CONTENT, MAX_PERSONA_ENTRIES_TOTAL, type PersonaEntry } from "@yumina/shared";
import { FieldError } from "@/components/ui/field-error";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { usePersonasStore, type Persona } from "@/stores/personas";
import { useUserAssetStore } from "@/stores/user-assets";
import { resolveImageUrl } from "@/lib/asset-url";

interface PersonaEditModalProps {
  isOpen: boolean;
  onClose: () => void;
  persona?: Persona | null;
}

export function PersonaEditModal({ isOpen, onClose, persona }: PersonaEditModalProps) {
  const { t } = useTranslation("profile");
  const { createPersona, updatePersona } = usePersonasStore();
  const { uploadAsset } = useUserAssetStore();

  const [isSaving, setIsSaving] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  // R4: this modal stays open on failure, so problems print inside it.
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [appearance, setAppearance] = useState("");
  const [personality, setPersonality] = useState("");
  const [backstory, setBackstory] = useState("");
  const [note, setNote] = useState("");
  const [entries, setEntries] = useState<(PersonaEntry & { key: string })[]>([]);

  const avatarInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setName(persona?.name ?? "");
      setAvatarUrl(persona?.avatarUrl ?? null);
      setAppearance(persona?.appearance ?? "");
      setPersonality(persona?.personality ?? "");
      setBackstory(persona?.backstory ?? "");
      setNote(persona?.note ?? "");
      setEntries((persona?.entries ?? []).map(entry => ({ ...entry, key: crypto.randomUUID() })));
      setIsSaving(false);
      setUploadingAvatar(false);
      setAvatarError(null);
      setFormError(null);
    }
  }, [isOpen, persona]);

  const handleAvatarUpload = async (file: File) => {
    setUploadingAvatar(true);
    setAvatarError(null);
    try {
      const asset = await uploadAsset(file, "image");
      if (!asset) return;
      // Use the CDN URL directly (matches edit-profile-modal pattern)
      setAvatarUrl(asset.url);
    } catch {
      setAvatarError(t("persona.modal.avatarUploadFailed"));
    } finally {
      setUploadingAvatar(false);
    }
  };

  const handleSave = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) return;

    const parsedEntries = personaEntriesSchema.safeParse(
      entries.filter(entry => entry.title.trim() || entry.content.trim())
        .map(({ title, content }) => ({ title, content })),
    );
    if (!parsedEntries.success) {
      setFormError(t("persona.modal.entriesInvalid", { max: MAX_PERSONA_ENTRIES_TOTAL }));
      return;
    }

    setIsSaving(true);
    setFormError(null);
    try {
      const input = {
        name: trimmedName,
        avatarUrl: avatarUrl || null,
        appearance: appearance.trim() || null,
        personality: personality.trim() || null,
        backstory: backstory.trim() || null,
        note: note.trim() || null,
        entries: parsedEntries.data,
      };

      const result = persona
        ? await updatePersona(persona.id, input)
        : await createPersona(input);

      if (result) {
        // No pill: the modal closes onto the persona list, which now holds it.
        onClose();
      } else {
        setFormError(persona ? t("persona.modal.updateFailed") : t("persona.modal.createFailed"));
      }
    } catch {
      setFormError(persona ? t("persona.modal.updateFailed") : t("persona.modal.createFailed"));
    } finally {
      setIsSaving(false);
    }
  };

  const resolvedAvatar = resolveImageUrl(avatarUrl);
  const isEditing = !!persona;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl gap-0 overflow-hidden border-white/10 bg-[#1F1D21] p-0 text-main shadow-2xl shadow-gold/5 sm:rounded-3xl [&>button:last-child]:hidden">
        <DialogTitle className="sr-only">
          {isEditing ? t("persona.modal.editTitle") : t("persona.modal.createTitle")}
        </DialogTitle>

        {/* Header — matches EditProfileModal pattern */}
        <div className="relative flex items-center justify-between overflow-hidden border-b border-white/5 bg-transparent p-6">
          <div className="absolute -right-10 -top-10 h-40 w-40 rounded-full bg-gold/10 blur-3xl" />

          <div className="relative z-10">
            <h2 className="flex items-center gap-2 text-2xl font-black text-main">
              <User className="h-5 w-5 text-gold" />
              {isEditing ? t("persona.modal.editTitle") : t("persona.modal.createTitle")}
            </h2>
            <p className="mt-1 text-xs text-sub">
              {t("persona.emptyDesc")}
            </p>
          </div>

          <div className="relative z-10 flex items-center gap-3">
            <Button
              onClick={onClose}
              variant="ghost"
              className="h-10 rounded-xl px-4 font-semibold text-sub hover:bg-white/5 hover:text-main"
            >
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={!name.trim() || isSaving}
              className="h-10 rounded-xl border border-gold/30 bg-gold/15 px-6 font-bold text-gold transition-all hover:bg-gold/25 disabled:opacity-50"
            >
              {isSaving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  <Save className="mr-2 h-4 w-4" />
                  {t("persona.modal.save")}
                </>
              )}
            </Button>
          </div>
        </div>

        {formError && (
          <div className="border-b border-white/5 px-6 pb-3">
            <FieldError message={formError} />
          </div>
        )}

        {/* Content */}
        <div className="relative max-h-[75vh] overflow-y-auto bg-transparent p-8">
          <div className="relative z-10 space-y-8 animate-in fade-in duration-300">

            {/* Identity Section — Avatar + Name */}
            <section>
              <div className="group relative overflow-hidden rounded-2xl border border-white/10 bg-[#2A272B]/50 p-6 transition-all hover:border-gold/30">
                <div className="relative z-10 flex flex-col items-center gap-6 md:flex-row md:items-start">
                  {/* Avatar */}
                  <div className="flex flex-col items-center gap-3">
                    <button
                      onClick={() => avatarInputRef.current?.click()}
                      disabled={uploadingAvatar}
                      className="group/avatar relative cursor-pointer"
                    >
                      <div className="relative h-28 w-28 overflow-hidden rounded-2xl border-2 border-white/10 shadow-lg transition-all group-hover/avatar:border-gold">
                        {resolvedAvatar ? (
                          <img
                            src={resolvedAvatar}
                            alt="Avatar"
                            className="h-full w-full object-cover transition-transform duration-500 group-hover/avatar:scale-105"
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-gold/20 to-transparent">
                            <User className="h-10 w-10 text-gold/40" />
                          </div>
                        )}
                        <div className="absolute inset-0 flex flex-col items-center justify-center rounded-2xl bg-black/60 opacity-0 backdrop-blur-sm transition-opacity group-hover/avatar:opacity-100">
                          {uploadingAvatar ? (
                            <Loader2 className="h-6 w-6 animate-spin text-white" />
                          ) : (
                            <>
                              <Camera className="mb-1 h-6 w-6 text-white" />
                              <span className="text-[10px] font-bold uppercase tracking-wider text-white">
                                {resolvedAvatar
                                  ? t("persona.modal.avatarChange")
                                  : t("persona.modal.avatarUpload")}
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                      <div className="absolute -bottom-2 -right-2 flex h-8 w-8 items-center justify-center rounded-full border-2 border-[#2A272B] bg-[#2A272B]">
                        <div className="flex h-5 w-5 items-center justify-center rounded-full bg-gold text-black">
                          <Camera className="h-3 w-3" />
                        </div>
                      </div>
                    </button>
                    <input
                      ref={avatarInputRef}
                      type="file"
                      accept="image/jpeg,image/png,image/gif,image/webp"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        e.target.value = "";
                        handleAvatarUpload(file);
                      }}
                    />
                    <FieldError message={avatarError} />
                  </div>

                  {/* Name + private note */}
                  <div className="flex-1 space-y-3 self-center md:self-start md:pt-2">
                    <label className="text-xs font-semibold uppercase tracking-wider text-sub">
                      {t("persona.modal.name")}
                    </label>
                    <Input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder={t("persona.modal.namePlaceholder")}
                      className="h-12 rounded-xl border-white/10 bg-white/[0.05] px-4 text-white shadow-sm placeholder:text-sub/50 transition-all focus-visible:border-gold/50 focus-visible:ring-1 focus-visible:ring-gold/50"
                    />
                    <label className="block pt-1 text-xs font-semibold uppercase tracking-wider text-sub">
                      {t("persona.modal.note")}
                    </label>
                    <Input
                      value={note}
                      onChange={(e) => setNote(e.target.value.slice(0, 200))}
                      placeholder={t("persona.modal.notePlaceholder")}
                      className="h-10 rounded-xl border-white/10 bg-white/[0.05] px-4 text-white shadow-sm placeholder:text-sub/50 transition-all focus-visible:border-gold/50 focus-visible:ring-1 focus-visible:ring-gold/50"
                    />
                    <p className="text-[10px] leading-relaxed text-sub/50">
                      {t("persona.modal.noteHint")}
                    </p>
                  </div>
                </div>
              </div>
            </section>

            <hr className="border-white/5" />

            {/* Character Details Section */}
            <section>
              <div className="group relative overflow-hidden rounded-2xl border border-white/10 bg-[#2A272B]/50 p-6 transition-all hover:border-gold/30">
                <div className="relative z-10 space-y-6">
                  {/* Appearance */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-semibold uppercase tracking-wider text-sub">
                        {t("persona.modal.appearance")}
                      </label>
                      <span className="text-[10px] text-sub/40">{appearance.length}/1000</span>
                    </div>
                    <textarea
                      value={appearance}
                      onChange={(e) => setAppearance(e.target.value.slice(0, 1000))}
                      placeholder={t("persona.modal.appearancePlaceholder")}
                      className="min-h-[120px] w-full resize-none rounded-xl border border-white/10 bg-white/[0.05] px-4 py-3 text-sm leading-relaxed text-white shadow-sm placeholder:text-sub/50 transition-all focus-visible:border-gold/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gold/50"
                    />
                  </div>

                  {/* Personality */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-semibold uppercase tracking-wider text-sub">
                        {t("persona.modal.personality")}
                      </label>
                      <span className="text-[10px] text-sub/40">{personality.length}/1000</span>
                    </div>
                    <textarea
                      value={personality}
                      onChange={(e) => setPersonality(e.target.value.slice(0, 1000))}
                      placeholder={t("persona.modal.personalityPlaceholder")}
                      className="min-h-[120px] w-full resize-none rounded-xl border border-white/10 bg-white/[0.05] px-4 py-3 text-sm leading-relaxed text-white shadow-sm placeholder:text-sub/50 transition-all focus-visible:border-gold/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gold/50"
                    />
                  </div>

                  {/* Backstory */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-semibold uppercase tracking-wider text-sub">
                        {t("persona.modal.backstory")}
                      </label>
                      <span className="text-[10px] text-sub/40">{backstory.length}/2000</span>
                    </div>
                    <textarea
                      value={backstory}
                      onChange={(e) => setBackstory(e.target.value.slice(0, 2000))}
                      placeholder={t("persona.modal.backstoryPlaceholder")}
                      className="min-h-[120px] w-full resize-none rounded-xl border border-white/10 bg-white/[0.05] px-4 py-3 text-sm leading-relaxed text-white shadow-sm placeholder:text-sub/50 transition-all focus-visible:border-gold/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gold/50"
                    />
                  </div>
                </div>
              </div>
            </section>

            <section aria-label={t("persona.modal.entriesTitle")}>
              {entries.length > 0 && (
                <div className="mb-4 space-y-3">
                  <div>
                    <h3 className="text-sm font-semibold text-main">{t("persona.modal.entriesTitle")}</h3>
                    <p className="mt-1 text-xs text-sub">{t("persona.modal.entriesHint")}</p>
                  </div>
                  {entries.map((entry, index) => (
                    <div key={entry.key} className="space-y-3 rounded-2xl border border-white/10 bg-[#2A272B]/50 p-4">
                      <div className="flex items-end gap-3">
                        <label className="min-w-0 flex-1 space-y-2">
                          <span className="text-xs font-semibold text-sub">{t("persona.modal.entryTitle")}</span>
                          <Input
                            value={entry.title}
                            maxLength={MAX_PERSONA_ENTRY_TITLE}
                            onChange={event => setEntries(current => current.map(item => item.key === entry.key ? { ...item, title: event.target.value } : item))}
                            placeholder={t("persona.modal.entryTitlePlaceholder")}
                            className="h-11 rounded-xl border-white/10 bg-white/[0.05] text-main focus-visible:border-gold/50 focus-visible:ring-gold/50"
                          />
                        </label>
                        <Button
                          type="button"
                          variant="ghost"
                          aria-label={t("persona.modal.removeEntry", { name: entry.title || index + 1 })}
                          onClick={() => setEntries(current => current.filter(item => item.key !== entry.key))}
                          className="h-11 rounded-xl px-3 text-sub hover:bg-white/5 hover:text-main"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                      <label className="block space-y-2">
                        <span className="text-xs font-semibold text-sub">{t("persona.modal.entryContent")}</span>
                        <textarea
                          value={entry.content}
                          maxLength={MAX_PERSONA_ENTRY_CONTENT}
                          onChange={event => setEntries(current => current.map(item => item.key === entry.key ? { ...item, content: event.target.value } : item))}
                          placeholder={t("persona.modal.entryContentPlaceholder")}
                          className="min-h-[120px] w-full resize-y rounded-xl border border-white/10 bg-white/[0.05] px-4 py-3 text-sm leading-relaxed text-main placeholder:text-sub/50 focus-visible:border-gold/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gold/50"
                        />
                      </label>
                      <p className="text-right text-xs text-sub/60">{entry.content.length}/{MAX_PERSONA_ENTRY_CONTENT}</p>
                    </div>
                  ))}
                </div>
              )}
              <Button
                type="button"
                variant="ghost"
                disabled={entries.length >= MAX_PERSONA_ENTRIES}
                onClick={() => setEntries(current => [...current, { key: crypto.randomUUID(), title: "", content: "" }])}
                className="h-11 w-full rounded-xl border border-dashed border-white/15 text-gold hover:border-gold/40 hover:bg-gold/5"
              >
                <Plus className="mr-2 h-4 w-4" />
                {t("persona.modal.addEntry")}
              </Button>
            </section>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
