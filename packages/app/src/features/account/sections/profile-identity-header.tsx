import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Camera, Check, Loader2, Settings, X } from "lucide-react";
import { useUserProfileStore } from "@/stores/user-profile";
import { useUserAssetStore } from "@/stores/user-assets";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { FieldError } from "@/components/ui/field-error";
import { resolveImageUrl } from "@/lib/asset-url";
import { getAvatarInitials } from "@/lib/avatar-initials";

const apiBase = import.meta.env.VITE_API_URL || "";

const headerButtonClass =
  "flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-semibold text-main backdrop-blur-md transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40";

/**
 * The profile header without the platform: the round avatar and the display
 * name, laid out like the hosted page's header (avatar, name, Edit Profile).
 *
 * Hosted edits both through its modal (banner, bio, username...). Here the
 * avatar is the upload control itself — click it, pick a picture — and takes
 * the same road as that modal (user-asset upload, then PATCH /api/users/me).
 * "Edit Profile" swaps the name for an input; there is nothing else to edit.
 */
export function ProfileIdentityHeader() {
  const { t } = useTranslation("profile");
  const { t: tSettings } = useTranslation("settings");
  const { profile, forceFetchProfile } = useUserProfileStore();
  const uploadAsset = useUserAssetStore((s) => s.uploadAsset);

  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState(profile?.name ?? "");
  const [saving, setSaving] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  // Every problem prints beside its cause; the header never resets on failure.
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  // The draft follows the saved name: filled on first load, reset after a save.
  useEffect(() => {
    setDisplayName(profile?.name ?? "");
  }, [profile?.name]);

  useEffect(() => {
    if (editing) nameInputRef.current?.select();
  }, [editing]);

  const savedName = profile?.name ?? "";
  const trimmedName = displayName.trim();
  const nameChanged = trimmedName.length > 0 && trimmedName !== savedName;
  const avatarSrc = resolveImageUrl(profile?.image);
  const initials = getAvatarInitials(profile?.name);

  const handleAvatarUpload = async (file: File) => {
    setUploadingAvatar(true);
    setAvatarError(null);
    try {
      const asset = await uploadAsset(file, "image");
      if (!asset) return;
      const imageRef = (asset as unknown as { key?: string }).key;
      const res = await fetch(`${apiBase}/api/users/me`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ image: imageRef || asset.url }),
      });
      if (res.ok) {
        // No pill: the avatar swaps to the new picture.
        await forceFetchProfile();
      } else {
        setAvatarError(t("editModal.avatarUpdateFailed"));
      }
    } catch {
      setAvatarError(t("editModal.avatarUploadFailed"));
    } finally {
      setUploadingAvatar(false);
    }
  };

  const startEditing = () => {
    setDisplayName(savedName);
    setNameError(null);
    setEditing(true);
  };

  const cancelEditing = () => {
    if (saving) return;
    setDisplayName(savedName);
    setNameError(null);
    setEditing(false);
  };

  const handleSaveName = async () => {
    if (saving) return;
    if (!nameChanged) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setNameError(null);
    try {
      const res = await fetch(`${apiBase}/api/users/me`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name: trimmedName }),
      });
      if (res.ok) {
        await forceFetchProfile();
        setEditing(false);
      } else {
        setNameError(t("editModal.saveFailed"));
      }
    } catch {
      setNameError(t("editModal.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:gap-6">
        {/* Avatar — the upload control */}
        <div className="flex shrink-0 flex-col items-start gap-2">
          <button
            type="button"
            onClick={() => avatarInputRef.current?.click()}
            disabled={uploadingAvatar}
            aria-label={t("editModal.change")}
            className="group/avatar relative h-32 w-32 overflow-hidden rounded-full border-[6px] border-page bg-page shadow-2xl transition-colors hover:border-gold/60 disabled:cursor-wait sm:h-40 sm:w-40"
          >
            <Avatar className="h-full w-full rounded-full">
              <AvatarImage src={avatarSrc ?? undefined} className="h-full w-full object-cover bg-page" />
              <AvatarFallback className="rounded-full bg-[#111] text-4xl font-bold text-white/80 sm:text-5xl">
                {initials}
              </AvatarFallback>
            </Avatar>
            <div className="absolute inset-0 flex flex-col items-center justify-center rounded-full bg-black/60 opacity-0 backdrop-blur-sm transition-opacity group-hover/avatar:opacity-100 group-focus-visible/avatar:opacity-100">
              {uploadingAvatar ? (
                <Loader2 className="h-6 w-6 animate-spin text-white" />
              ) : (
                <>
                  <Camera className="mb-1 h-6 w-6 text-white" />
                  <span className="text-[10px] font-bold uppercase tracking-wider text-white">
                    {t("editModal.change")}
                  </span>
                </>
              )}
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
              void handleAvatarUpload(file);
            }}
          />
          <FieldError message={avatarError} />
        </div>

        {/* Display name */}
        <div className="flex min-w-0 flex-col sm:mb-2">
          {editing ? (
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void handleSaveName();
              }}
            >
              <label htmlFor="profile-display-name" className="text-xs font-semibold uppercase tracking-wider text-sub">
                {t("editModal.displayName")}
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  ref={nameInputRef}
                  id="profile-display-name"
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") cancelEditing();
                  }}
                  maxLength={50}
                  disabled={saving}
                  aria-invalid={!!nameError}
                  aria-describedby={nameError ? "profile-display-name-error" : undefined}
                  className="profile-overview-input-surface w-full min-w-0 rounded-lg border border-white/10 px-3 py-2 text-2xl font-black tracking-tight text-main outline-none focus:border-gold focus:ring-1 focus:ring-gold sm:w-80"
                />
                <button
                  type="submit"
                  disabled={!nameChanged || saving}
                  aria-label={t("editModal.saveChanges")}
                  className="rounded-lg border border-gold/30 bg-gold/15 p-2 text-gold transition-colors hover:bg-gold/25 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                </button>
                <button
                  type="button"
                  onClick={cancelEditing}
                  disabled={saving}
                  aria-label={t("editModal.cancel")}
                  className="rounded-lg border border-white/10 bg-white/5 p-2 text-sub transition-colors hover:bg-white/10 disabled:opacity-40"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <FieldError id="profile-display-name-error" message={nameError} />
            </form>
          ) : (
            <h1 className="text-3xl font-black tracking-tight text-main [overflow-wrap:anywhere] sm:text-4xl">
              {savedName || initials}
            </h1>
          )}
        </div>
      </div>

      {/* Actions */}
      {!editing && (
        <div className="mb-2 flex gap-3">
          <button type="button" onClick={startEditing} className={headerButtonClass}>
            <Settings className="h-4 w-4" />
            {t("page.editProfile")}
          </button>
        </div>
      )}
      {editing && saving && (
        <span className="mb-2 text-xs text-sub/60">{tSettings("account.saving")}</span>
      )}
    </header>
  );
}
