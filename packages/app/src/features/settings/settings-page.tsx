import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  createContext,
  useContext,
} from "react";
import { useRouter } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { resolveImageUrl } from "@/lib/asset-url";
import { useSettingsDocumentScroll } from "./use-settings-document-scroll";
import {
  User,
  Key,
  Bot,
  Eye,
  Bell,
  Info,
  Globe,
  Lock,
  LogOut,
  ArrowLeft,
  ChevronRight,
  Settings as SettingsIcon,
  Image as ImageIcon,
  Upload,
  Loader2,
  Type,
  Mail,
  MessageSquare,
  Link2,
  MonitorSmartphone,
  ShieldOff,
  X,
  Trash2,
  TriangleAlert,
  CheckCircle2,
  Check,
  Search,
} from "lucide-react";
import { feedback } from "@/lib/feedback";
import { FieldError } from "@/components/ui/field-error";
import { useTransientFlag } from "@/hooks/use-transient-flag";
import { useCopyFeedback } from "@/hooks/use-copy-feedback";
import { signOut, useSession, authClient, clearSessionCache } from "@/lib/auth-client";
import { useUserProfileStore } from "@/stores/user-profile";
import { useStartDm } from "@/edition/slots";
import { invalidateHubWorlds } from "@/edition/slots.state";
import { useEdition } from "@/edition/edition";
import { getUserProfileHref } from "@/edition/routes";
import { useAuthGuard } from "@/hooks/use-auth-guard";
import { useUserAssetStore, type UserAsset } from "@/stores/user-assets";
import { useUiStore } from "@/stores/ui";
import { useTouchDevice } from "@/hooks/use-touch-device";
import { getAssetCdnUrl } from "@/lib/asset-url";
import { DOCS_URLS } from "@/lib/docs-urls";
import {
  deviceLabel,
  formatSessionTime,
  sortSessions,
  type ActiveSession,
} from "./login-devices";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  getAgeFromBirthYear,
  normalizeAudiencePreference,
  AUDIENCE_PREFERENCE_DEFAULT,
  type AudiencePreference,
} from "@yumina/shared";
import { normalizeVisualStrength } from "@/lib/visual-settings";
import { AiProviderTab } from "./ai-provider-tab";
import { AiConfigTab } from "./ai-config-tab";
import {
  OFFICIAL_SUPPORT_EMAIL,
  OFFICIAL_USER_ID,
  OFFICIAL_USERNAME,
  OfficialBadge,
} from "@/lib/official-account";
import {
  mergeSettingsSearchAliases,
  searchSettingsItems,
  type SettingsSearchItem,
} from "./settings-search";
import { SETTINGS_SEARCH_TRANSLATORS } from "./settings-search-translations";
import { SUPPORTED_LANGUAGES } from "@/lib/language-clamp";
import { modelFallbackText } from "@yumina/shared";

const apiBase = import.meta.env.VITE_API_URL || "";

type ContentLevel = "safe" | "sensitive";
type WallpaperPreset = "starry-night" | "library-canvas";
type WallpaperChoice = WallpaperPreset | string;
type CloudedGlassTexture = "lighter" | "darker" | "cloudy";

interface NotificationPreferences {
  engagement: boolean;
  social: boolean;
  library: boolean;
  community: boolean;
}

const DEFAULT_NOTIFICATION_PREFS: NotificationPreferences = {
  engagement: true,
  social: true,
  library: true,
  community: true,
};

interface PrivacySettings {
  profileVisibility: "public" | "followers" | "private";
  isPrivateAccount: boolean;
  allowDMs: boolean;
  showPlayHistory: boolean;
  showRecentPlay: boolean;
  showStats: boolean;
  showFollowLists: boolean;
  showFavorites: boolean;
}

const DEFAULT_PRIVACY: PrivacySettings = {
  profileVisibility: "public",
  isPrivateAccount: false,
  allowDMs: true,
  showPlayHistory: true,
  showRecentPlay: true,
  showStats: true,
  showFollowLists: true,
  showFavorites: true,
};

interface ProfileSettings {
  contentLevel: ContentLevel;
  audiencePreference: AudiencePreference;
  blurSensitive: boolean;
  notificationPreferences: NotificationPreferences;
  privacy: PrivacySettings;
  wallpaperOpacity: number;
  wallpaperGradientStrength: number;
  cloudyGlassStrength: number;
  cloudedGlassTexture: CloudedGlassTexture;
  autoFullscreenOnPlay: boolean;
  worldAudioEnabled: boolean;
  discoverWallpaper: WallpaperChoice;
  profileWallpaper: WallpaperChoice;
  settingsWallpaper: WallpaperChoice;
  libraryWallpaper: WallpaperChoice;
}

const DEFAULTS: ProfileSettings = {
  contentLevel: "safe",
  audiencePreference: AUDIENCE_PREFERENCE_DEFAULT,
  blurSensitive: true,
  notificationPreferences: { ...DEFAULT_NOTIFICATION_PREFS },
  privacy: { ...DEFAULT_PRIVACY },
  wallpaperOpacity: 100,
  wallpaperGradientStrength: 100,
  cloudyGlassStrength: 100,
  cloudedGlassTexture: "cloudy",
  autoFullscreenOnPlay: true,
  worldAudioEnabled: true,
  discoverWallpaper: "starry-night",
  profileWallpaper: "starry-night",
  settingsWallpaper: "starry-night",
  libraryWallpaper: "library-canvas",
};

const LANGUAGE_OPTIONS = [
  { code: "en", label: "English", native: "English" },
  { code: "zh", label: "Chinese (Simplified)", native: "简体中文" },
  { code: "zh-Hant", label: "Chinese (Traditional)", native: "繁體中文" },
  { code: "es", label: "Spanish", native: "Español" },
  { code: "ja", label: "Japanese", native: "日本語" },
] as const;

function normalizeCloudedGlassTexture(
  value: unknown,
  legacyStyle?: unknown,
  legacyLevel?: unknown
): CloudedGlassTexture {
  if (value === "lighter" || value === "darker" || value === "cloudy") {
    return value;
  }
  if (legacyStyle === "lighter" || legacyStyle === "darker") {
    return legacyStyle;
  }
  const parsed = typeof legacyLevel === "number" ? legacyLevel : Number(legacyLevel);
  if (Number.isFinite(parsed)) {
    if (parsed <= 38) return "lighter";
    if (parsed <= 58) return "darker";
    return "cloudy";
  }
  return DEFAULTS.cloudedGlassTexture;
}

function isWallpaperPreset(value: unknown): value is WallpaperPreset {
  return value === "library-canvas" || value === "starry-night";
}

function normalizeWallpaperChoice(value: unknown, fallback: WallpaperChoice): WallpaperChoice {
  if (typeof value !== "string") return fallback;
  if (isWallpaperPreset(value)) return value;
  if (value.startsWith("@asset:")) return value;
  if (value.startsWith("http://") || value.startsWith("https://") || value.startsWith("/")) {
    return value;
  }
  return fallback;
}

function loadPrivacySettings(raw: unknown): PrivacySettings {
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const rawVisibility = obj.profileVisibility;
    const profileVisibility =
      rawVisibility === "public" || rawVisibility === "followers" || rawVisibility === "private"
        ? rawVisibility
        : obj.isPrivateAccount === true
          ? "followers"
          : "public";
    return {
      profileVisibility,
      isPrivateAccount: profileVisibility !== "public",
      allowDMs: obj.allowDMs !== false,
      showPlayHistory: obj.showPlayHistory !== false && obj.showRecentPlay !== false,
      showRecentPlay: obj.showPlayHistory !== false && obj.showRecentPlay !== false,
      showStats: obj.showStats !== false,
      showFollowLists: obj.showFollowLists !== false && obj.showStats !== false,
      showFavorites: obj.showFavorites !== false,
    };
  }
  return { ...DEFAULT_PRIVACY };
}

function loadNotificationPreferences(raw: unknown): NotificationPreferences {
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    return {
      engagement: obj.engagement !== false,
      social: obj.social !== false,
      library: obj.library !== false,
      community: obj.community !== false,
    };
  }
  return { ...DEFAULT_NOTIFICATION_PREFS };
}

function loadSettings(preferences?: Record<string, unknown>): ProfileSettings {
  if (preferences && Object.keys(preferences).length > 0) {
    const base = { ...DEFAULTS, ...preferences } as ProfileSettings & { showNsfw?: boolean };
    if (!preferences.contentLevel && base.showNsfw) {
      base.contentLevel = "sensitive";
    }
    // Profiles created before the sensitive-content rename may still hold
    // "r18" or "r18g".
    const cl = base.contentLevel as string;
    if (cl === "r18" || cl === "r18g") {
      base.contentLevel = "sensitive";
    }
    base.audiencePreference = normalizeAudiencePreference(preferences.audiencePreference);
    base.notificationPreferences = loadNotificationPreferences(preferences.notificationPreferences);
    base.privacy = loadPrivacySettings(preferences.privacy);
    base.autoFullscreenOnPlay = preferences.autoFullscreenOnPlay !== false;
    base.worldAudioEnabled = preferences.worldAudioEnabled !== false;
    base.wallpaperOpacity = normalizeVisualStrength(preferences.wallpaperOpacity);
    base.wallpaperGradientStrength = normalizeVisualStrength(preferences.wallpaperGradientStrength);
    base.cloudyGlassStrength = normalizeVisualStrength(preferences.cloudyGlassStrength);
    base.cloudedGlassTexture = normalizeCloudedGlassTexture(
      preferences.cloudedGlassTexture,
      preferences.cloudedGlassStyle,
      preferences.cloudedGlassLevel
    );
    const legacyImmersive = normalizeWallpaperChoice(
      preferences.immersiveWallpaper,
      DEFAULTS.discoverWallpaper
    );
    base.discoverWallpaper = normalizeWallpaperChoice(
      preferences.discoverWallpaper,
      legacyImmersive
    );
    base.profileWallpaper = normalizeWallpaperChoice(preferences.profileWallpaper, legacyImmersive);
    base.settingsWallpaper = normalizeWallpaperChoice(
      preferences.settingsWallpaper,
      legacyImmersive
    );
    base.libraryWallpaper = normalizeWallpaperChoice(
      preferences.libraryWallpaper,
      DEFAULTS.libraryWallpaper
    );
    delete base.showNsfw;
    return base;
  }
  return DEFAULTS;
}

// --- Reusable pieces ---

function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="relative inline-flex shrink-0 cursor-pointer items-center">
      <input
        type="checkbox"
        className="peer sr-only"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <div className="h-6 w-11 rounded-full border border-white/10 bg-white/10 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-transparent after:bg-white after:transition-all peer-checked:bg-gold peer-checked:after:translate-x-full peer-checked:after:border-transparent peer-focus:outline-none" />
    </label>
  );
}

const SettingsBackContext = createContext<(() => void) | null>(null);

function SectionHeader({
  title,
  description,
  id,
}: {
  title: string;
  description?: string;
  id?: string;
}) {
  const onBack = useContext(SettingsBackContext);
  const { t } = useTranslation("common");
  return (
    <div
      id={id}
      tabIndex={id ? -1 : undefined}
      className="mb-6 scroll-mt-8 rounded-lg focus:outline-none focus:ring-2 focus:ring-gold/50"
    >
      <div className="flex items-center gap-2">
        {onBack && (
          <button type="button" onClick={onBack} aria-label={t("action.back")}
            className="-ml-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-sub transition-colors hover:bg-white/5 hover:text-main md:hidden">
            <ArrowLeft className="h-5 w-5" aria-hidden="true" />
          </button>
        )}
        <h2 className="text-xl font-bold text-main">{title}</h2>
      </div>
      {description && <p className="mt-1 text-sm text-sub">{description}</p>}
    </div>
  );
}

// --- Nav items ---

const SECTIONS = [
  { id: "account", labelKey: "nav.account" as const, icon: User },
  { id: "ai-config", labelKey: "nav.aiConfig" as const, icon: Bot },
  { id: "content-safety", labelKey: "nav.contentSafety" as const, icon: Eye },
  { id: "privacy", labelKey: "nav.privacy" as const, icon: Lock },
  { id: "notifications", labelKey: "nav.notifications" as const, icon: Bell },
  { id: "display", labelKey: "nav.display" as const, icon: Type },
  { id: "wallpaper", labelKey: "nav.wallpaper" as const, icon: ImageIcon },
  { id: "about", labelKey: "nav.about" as const, icon: Info },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

/** Account search entries whose cards AccountSection drops in single-user mode. */
const SINGLE_USER_HIDDEN_ACCOUNT_ITEMS: ReadonlySet<string> = new Set([
  "account-email",
  "account-password",
  "account-sign-out",
  "account-devices",
  "account-delete",
]);

function parseSectionHash(hash: string): SectionId | null {
  const normalized = hash.replace(/^#/, "");
  if (!normalized) return null;
  return SECTIONS.some((section) => section.id === normalized)
    ? (normalized as SectionId)
    : null;
}

function createSettingsSearchItems(
  t: ReturnType<typeof useTranslation<"settings">>["t"], language = "en",
): SettingsSearchItem<SectionId>[] {
  const category = {
    account: t("nav.account"),
    aiConfig: t("nav.aiConfig"),
    contentSafety: t("nav.contentSafety"),
    privacy: t("nav.privacy"),
    notifications: t("nav.notifications"),
    display: t("nav.display"),
    wallpaper: t("nav.wallpaper"),
    about: t("nav.about"),
  };

  return [
    { id: "account", sectionId: "account", targetId: "settings-target-account", title: category.account, category: category.account },
    { id: "account-email", sectionId: "account", targetId: "settings-target-account-email", title: t("account.emailLabel"), description: t("account.emailCannotChange"), category: category.account },
    { id: "account-username", sectionId: "account", targetId: "settings-target-account-username", title: t("account.usernameLabel"), description: t("account.usernameHint"), category: category.account },
    { id: "account-password", sectionId: "account", targetId: "settings-target-account-password", title: t("account.changePassword.title"), description: t("account.changePassword.description"), category: category.account },
    { id: "account-connections", sectionId: "account", targetId: "settings-target-account-connections", title: t("account.connectedAccounts.title"), description: t("account.connectedAccounts.description"), category: category.account },
    { id: "account-devices", sectionId: "account", targetId: "settings-target-account-devices", title: t("account.loginDevices.title"), description: t("account.loginDevices.description"), category: category.account },
    { id: "account-sign-out", sectionId: "account", targetId: "settings-target-account-sign-out", title: t("account.signOut.title"), description: t("account.signOut.description"), category: category.account },
    { id: "account-delete", sectionId: "account", targetId: "settings-target-account-delete", title: t("account.deleteAccount.title"), description: t("account.deleteAccount.description"), category: category.account },

    { id: "ai-config", sectionId: "ai-config", targetId: "settings-target-ai-config", title: category.aiConfig, description: t("search.aiConfigDescription"), category: category.aiConfig, keywords: ["API", "OpenRouter"] },
    { id: "model-fallback", sectionId: "ai-config", targetId: "model-fallback", title: modelFallbackText(language, "settingsTitle"), description: modelFallbackText(language, "settingsBody"), category: category.aiConfig, keywords: ["fallback", modelFallbackText(language, "auto"), modelFallbackText(language, "ask")] },

    { id: "content-safety", sectionId: "content-safety", targetId: "settings-target-content-safety", title: category.contentSafety, description: t("contentSafety.description"), category: category.contentSafety },
    { id: "content-level", sectionId: "content-safety", targetId: "settings-target-content-level", title: t("contentSafety.contentLevel"), description: t("contentSafety.description"), category: category.contentSafety },
    { id: "audience-preference", sectionId: "content-safety", targetId: "settings-target-audience-preference", title: t("contentSafety.audiencePreference.title"), description: t("contentSafety.audiencePreference.description"), category: category.contentSafety },
    { id: "blur-sensitive", sectionId: "content-safety", targetId: "settings-target-blur-sensitive", title: t("contentSafety.blurSensitive.title"), description: t("contentSafety.blurSensitive.description"), category: category.contentSafety },

    { id: "privacy", sectionId: "privacy", targetId: "settings-target-privacy", title: category.privacy, description: t("privacy.description"), category: category.privacy },
    { id: "profile-visibility", sectionId: "privacy", targetId: "settings-target-profile-visibility", title: t("privacy.profileVisibility.title"), description: t("privacy.profileVisibility.description"), category: category.privacy },
    { id: "allow-dms", sectionId: "privacy", targetId: "settings-target-allow-dms", title: t("privacy.allowDMs.title"), description: t("privacy.allowDMs.description"), category: category.privacy },
    { id: "play-history", sectionId: "privacy", targetId: "settings-target-play-history", title: t("privacy.showPlayHistory.title", { defaultValue: t("privacy.showRecentPlay.title") }), description: t("privacy.showPlayHistory.description", { defaultValue: t("privacy.showRecentPlay.description") }), category: category.privacy },
    { id: "follow-lists", sectionId: "privacy", targetId: "settings-target-follow-lists", title: t("privacy.showFollowLists.title"), description: t("privacy.showFollowLists.description"), category: category.privacy },
    { id: "favorites", sectionId: "privacy", targetId: "settings-target-favorites", title: t("privacy.showFavorites.title"), description: t("privacy.showFavorites.description"), category: category.privacy },
    { id: "blacklist", sectionId: "privacy", targetId: "settings-target-blacklist", title: t("privacy.blacklist.title"), description: t("privacy.blacklist.subtitle"), category: category.privacy },

    { id: "notifications", sectionId: "notifications", targetId: "settings-target-notifications", title: category.notifications, category: category.notifications },
    { id: "notification-engagement", sectionId: "notifications", targetId: "settings-target-notification-groups", title: t("notifications.groups.engagement"), description: t("notifications.groups.engagementDesc"), category: category.notifications },
    { id: "notification-social", sectionId: "notifications", targetId: "settings-target-notification-groups", title: t("notifications.groups.social"), description: t("notifications.groups.socialDesc"), category: category.notifications },
    { id: "notification-library", sectionId: "notifications", targetId: "settings-target-notification-groups", title: t("notifications.groups.library"), description: t("notifications.groups.libraryDesc"), category: category.notifications },
    { id: "notification-community", sectionId: "notifications", targetId: "settings-target-notification-groups", title: t("notifications.groups.community"), description: t("notifications.groups.communityDesc"), category: category.notifications },

    { id: "display", sectionId: "display", targetId: "settings-target-display", title: category.display, category: category.display },
    { id: "font-size", sectionId: "display", targetId: "settings-target-font-size", title: t("display.fontSize.title"), description: t("display.fontSize.hint"), category: category.display },
    { id: "send-key", sectionId: "display", targetId: "settings-target-send-key", title: t("display.sendKey.title"), description: t("display.sendKey.description"), category: category.display },
    { id: "auto-fullscreen", sectionId: "display", targetId: "settings-target-auto-fullscreen", title: t("display.autoFullscreenOnPlay.title"), description: t("display.autoFullscreenOnPlay.description"), category: category.display },
    { id: "world-audio", sectionId: "display", targetId: "settings-target-world-audio", title: t("display.worldAudio.title"), description: t("display.worldAudio.description"), category: category.display },
    { id: "language", sectionId: "display", targetId: "settings-target-language", title: t("display.language.title"), category: category.display, keywords: LANGUAGE_OPTIONS.flatMap((language) => [language.label, language.native]) },

    { id: "wallpaper", sectionId: "wallpaper", targetId: "settings-target-wallpaper", title: category.wallpaper, description: t("wallpaper.description"), category: category.wallpaper },
    { id: "wallpaper-visual", sectionId: "wallpaper", targetId: "settings-target-wallpaper-visual", title: t("wallpaper.visualControls.title"), description: t("wallpaper.description"), category: category.wallpaper },
    { id: "wallpaper-opacity", sectionId: "wallpaper", targetId: "settings-target-wallpaper-visual", title: t("wallpaper.opacity.title"), description: t("wallpaper.opacity.description"), category: category.wallpaper },
    { id: "wallpaper-gradient", sectionId: "wallpaper", targetId: "settings-target-wallpaper-visual", title: t("wallpaper.gradient.title"), description: t("wallpaper.gradient.description"), category: category.wallpaper },
    { id: "wallpaper-glass", sectionId: "wallpaper", targetId: "settings-target-wallpaper-visual", title: t("wallpaper.cloudyGlass.title"), description: t("wallpaper.cloudyGlass.description"), category: category.wallpaper },
    { id: "wallpaper-library", sectionId: "wallpaper", targetId: "settings-target-wallpaper-library", title: t("wallpaper.library.title"), description: t("wallpaper.library.description"), category: category.wallpaper },
    { id: "wallpaper-upload", sectionId: "wallpaper", targetId: "settings-target-wallpaper-library", title: t("wallpaper.upload.title"), description: t("wallpaper.upload.description", { folderName: "wallpaper" }), category: category.wallpaper },

    { id: "about", sectionId: "about", targetId: "settings-target-about", title: category.about, category: category.about },
    { id: "contact-support", sectionId: "about", targetId: "settings-target-contact-support", title: t("about.contactSupport"), category: category.about },
    { id: "version", sectionId: "about", targetId: "settings-target-version", title: t("about.version"), description: t("about.versionValue"), category: category.about },
    { id: "terms", sectionId: "about", targetId: "settings-target-legal", title: t("about.termsOfService"), category: category.about },
    { id: "privacy-policy", sectionId: "about", targetId: "settings-target-legal", title: t("about.privacyPolicy"), category: category.about },
    { id: "licenses", sectionId: "about", targetId: "settings-target-legal", title: t("about.licenses"), category: category.about },
  ];
}

const LOCALIZED_SETTINGS_SEARCH_ITEMS = SETTINGS_SEARCH_TRANSLATORS.map((translate, index) =>
  createSettingsSearchItems(translate, SUPPORTED_LANGUAGES[index])
);

// ============================================================
// Main Settings Page
// ============================================================

export function SettingsPage() {
  const { t, i18n } = useTranslation("settings");
  const router = useRouter();
  const isTouchDevice = useTouchDevice();
  const { isAuthenticated } = useAuthGuard();
  const { data: session } = useSession();
  const { profile, fetchProfile, forceFetchProfile } = useUserProfileStore();
  const {
    assets: userAssets,
    loading: assetsLoading,
    uploading: wallpaperUploading,
    fetchAssets,
    fetchFolders,
    uploadAsset,
    createFolder,
  } = useUserAssetStore();
  const isMinor = profile?.birthYear ? getAgeFromBirthYear(profile.birthYear) < 18 : false;
  const wallpaperFolderIdRef = useRef<string | null>(null);

  const { features, auth } = useEdition();
  // Content level (Discover), privacy (profiles/DMs) and notifications are
  // hosted concerns; the local edition keeps account, AI config, display,
  // wallpaper and about.
  const visibleSections = useMemo(() => SECTIONS.filter((section) =>
    (section.id !== "content-safety" || features.hub)
    && (section.id !== "privacy" || features.socialProfiles || features.dm)
    && (section.id !== "notifications" || features.notifications),
  ), [features.hub, features.socialProfiles, features.dm, features.notifications]);
  // Single-user mode has one auto-signed-in local account: no email, no
  // password, nothing to sign out of. AccountSection drops those cards.
  const isSingleUser = auth.mode === "single-user";
  const [activeSection, setActiveSection] = useState<SectionId>(() => {
    if (typeof window === "undefined") return "account";
    return parseSectionHash(window.location.hash) ?? "account";
  });
  // Mobile: show nav list vs section content
  const [mobileShowNav, setMobileShowNav] = useState(() => {
    if (typeof window === "undefined") return true;
    return parseSectionHash(window.location.hash) === null;
  });
  const rememberNavScroll = useSettingsDocumentScroll(mobileShowNav, activeSection);
  const [searchQuery, setSearchQuery] = useState("");
  const [pendingTargetId, setPendingTargetId] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchResultRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const normalizedSearchQuery = searchQuery.trim();
  const searchItems = useMemo(() => {
    const localizedItems = mergeSettingsSearchAliases(
      createSettingsSearchItems(t, i18n.language),
      LOCALIZED_SETTINGS_SEARCH_ITEMS
    );

    // Search only finds what the page renders: hidden sections and the
    // single-user account cards stay out of the index.
    const visibleSectionIds = new Set<SectionId>(visibleSections.map((section) => section.id));
    return localizedItems.filter((item) =>
      visibleSectionIds.has(item.sectionId)
      && (!isTouchDevice || item.id !== "send-key")
      && (!isSingleUser || !SINGLE_USER_HIDDEN_ACCOUNT_ITEMS.has(item.id)));
  }, [isTouchDevice, t, i18n.language, visibleSections, isSingleUser]);
  const searchResults = useMemo(
    () => searchSettingsItems(searchItems, normalizedSearchQuery),
    [normalizedSearchQuery, searchItems]
  );
  const isSearching = normalizedSearchQuery.length > 0;

  // --- Profile settings state ---
  const [settings, setSettings] = useState<ProfileSettings>(() => loadSettings(profile?.preferences));

  useEffect(() => {
    if (profile?.preferences && Object.keys(profile.preferences).length > 0) {
      setSettings(loadSettings(profile.preferences));
    }
  }, [profile?.preferences]);

  useEffect(() => {
    if (isAuthenticated) fetchProfile();
  }, [isAuthenticated, fetchProfile]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const syncFromHash = () => {
      const hashSection = parseSectionHash(window.location.hash);
      if (hashSection) {
        setActiveSection(hashSection);
        setMobileShowNav(false);
      }
    };

    syncFromHash();
    window.addEventListener("hashchange", syncFromHash);
    return () => window.removeEventListener("hashchange", syncFromHash);
  }, []);

  useEffect(() => {
    if (!pendingTargetId || mobileShowNav) return;

    const frame = window.requestAnimationFrame(() => {
      const target = document.getElementById(pendingTargetId);
      if (!target) {
        setPendingTargetId(null);
        return;
      }

      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      target.scrollIntoView({
        behavior: reduceMotion ? "auto" : "smooth",
        block: "start",
      });
      target.focus({ preventScroll: true });
      setPendingTargetId(null);
    });

    return () => window.cancelAnimationFrame(frame);
  }, [activeSection, mobileShowNav, pendingTargetId]);

  const ensureWallpaperFolder = useCallback(async (): Promise<string | null> => {
    if (wallpaperFolderIdRef.current) {
      return wallpaperFolderIdRef.current;
    }

    const existingKnownFolder = useUserAssetStore
      .getState()
      .folders.find(
        (folder) =>
          folder.parentFolderId === null && folder.name.trim().toLowerCase() === "wallpaper"
      );

    if (existingKnownFolder) {
      wallpaperFolderIdRef.current = existingKnownFolder.id;
      return existingKnownFolder.id;
    }

    await fetchFolders();

    const existingFolder = useUserAssetStore
      .getState()
      .folders.find(
        (folder) =>
          folder.parentFolderId === null && folder.name.trim().toLowerCase() === "wallpaper"
      );

    if (existingFolder) {
      wallpaperFolderIdRef.current = existingFolder.id;
      return existingFolder.id;
    }

    const createdFolder = await createFolder("wallpaper");
    if (createdFolder) {
      wallpaperFolderIdRef.current = createdFolder.id;
      return createdFolder.id;
    }

    // R7: nothing rendered yet to hang this on — the section is still empty.
    feedback.error(t("wallpaper.folderError"));
    return null;
  }, [createFolder, fetchFolders, t]);

  useEffect(() => {
    if (!isAuthenticated || activeSection !== "wallpaper") return;

    let cancelled = false;

    void (async () => {
      const folderId = await ensureWallpaperFolder();
      if (!folderId || cancelled) return;
      await fetchAssets({ type: "image", folderId });
    })();

    return () => {
      cancelled = true;
    };
  }, [activeSection, ensureWallpaperFolder, fetchAssets, isAuthenticated]);

  // R1: the control shows the new value at once. If the PATCH is refused we put the
  // old value back — a switch that silently snaps back needs a word and a Retry.
  const updateSetting: <K extends keyof ProfileSettings>(key: K, value: ProfileSettings[K]) => Promise<void> = useCallback(
    async <K extends keyof ProfileSettings>(key: K, value: ProfileSettings[K]) => {
      let prevValue: ProfileSettings[K] = value;
      setSettings((prev) => {
        prevValue = prev[key];
        return { ...prev, [key]: value };
      });

      const rollBack = () => {
        setSettings((prev) => ({ ...prev, [key]: prevValue }));
        feedback.error(t("account.validation.saveFailed"), {
          label: t("action.retry", { ns: "common" }),
          onClick: () => void updateSetting(key, value),
        });
      };

      try {
        const res = await fetch(`${apiBase}/api/users/me`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ preferences: { [key]: value } }),
        });
        if (res.ok) {
          await forceFetchProfile();
          if (key === "contentLevel") invalidateHubWorlds();
        } else {
          rollBack();
        }
      } catch {
        rollBack();
      }
    },
    [forceFetchProfile, t]
  );

  // --- Account state ---
  const [editUsername, setEditUsername] = useState(profile?.username ?? "");
  const [savingUsername, setSavingUsername] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);
  // R3 + R4: both account forms report where they live — a "Saved" button label on
  // success, an error line under the field on failure. No pills.
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [usernameSavedAt, setUsernameSavedAt] = useState(0);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSavedAt, setPasswordSavedAt] = useState(0);

  useEffect(() => {
    if (profile?.username) setEditUsername(profile.username);
  }, [profile?.username]);

  useEffect(() => {
    const persisted = normalizeVisualStrength(profile?.preferences?.wallpaperOpacity);
    if (settings.wallpaperOpacity === persisted) return;

    const timeout = window.setTimeout(() => {
      void updateSetting("wallpaperOpacity", settings.wallpaperOpacity);
    }, 220);

    return () => window.clearTimeout(timeout);
  }, [profile?.preferences?.wallpaperOpacity, settings.wallpaperOpacity, updateSetting]);

  useEffect(() => {
    const persisted = normalizeVisualStrength(profile?.preferences?.wallpaperGradientStrength);
    if (settings.wallpaperGradientStrength === persisted) return;

    const timeout = window.setTimeout(() => {
      void updateSetting("wallpaperGradientStrength", settings.wallpaperGradientStrength);
    }, 220);

    return () => window.clearTimeout(timeout);
  }, [profile?.preferences?.wallpaperGradientStrength, settings.wallpaperGradientStrength, updateSetting]);

  useEffect(() => {
    const persisted = normalizeVisualStrength(profile?.preferences?.cloudyGlassStrength);
    if (settings.cloudyGlassStrength === persisted) return;

    const timeout = window.setTimeout(() => {
      void updateSetting("cloudyGlassStrength", settings.cloudyGlassStrength);
    }, 220);

    return () => window.clearTimeout(timeout);
  }, [profile?.preferences?.cloudyGlassStrength, settings.cloudyGlassStrength, updateSetting]);

  const handleWallpaperUpload = async (file: File) => {
    const folderId = await ensureWallpaperFolder();
    if (!folderId) return;

    const asset = await uploadAsset(file, "image", folderId);
    if (!asset) return;

    await fetchAssets({ type: "image", folderId });
  };

  const handleSaveUsername = async () => {
    setUsernameError(null);
    const trimmed = editUsername.trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
    if (!trimmed || trimmed.length < 3) { setUsernameError(t("account.validation.usernameMinLength")); return; }
    if (trimmed === profile?.username) return;
    setSavingUsername(true);
    try {
      const res = await fetch(`${apiBase}/api/users/me`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ username: trimmed }),
      });
      if (res.ok) { await forceFetchProfile(); setUsernameSavedAt(Date.now()); }
      else if (res.status === 409) setUsernameError(t("account.validation.usernameTaken"));
      else setUsernameError(t("account.validation.usernameUpdateFailed"));
    } catch { setUsernameError(t("account.validation.usernameUpdateFailed")); }
    finally { setSavingUsername(false); }
  };

  const handleChangePassword = async () => {
    setPasswordError(null);
    if (newPassword.length < 8) { setPasswordError(t("account.validation.passwordMinLength")); return; }
    if (newPassword !== confirmPassword) { setPasswordError(t("account.validation.passwordsMismatch")); return; }
    setChangingPassword(true);
    try {
      const { error } = await authClient.changePassword({ currentPassword, newPassword, revokeOtherSessions: true });
      if (error) setPasswordError(error.message ?? t("account.validation.passwordChangeFailed"));
      // The three fields emptying out plus "Changed" on the button is the receipt.
      else { setPasswordSavedAt(Date.now()); setCurrentPassword(""); setNewPassword(""); setConfirmPassword(""); }
    } catch { setPasswordError(t("account.validation.passwordChangeFailed")); }
    finally { setChangingPassword(false); }
  };

  const handleSignOut = async () => {
    clearSessionCache();
    await signOut();
    router.navigate({ to: "/login" });
  };

  const handleSelectSection = (id: SectionId, targetId?: string) => {
    rememberNavScroll();
    setActiveSection(id);
    setMobileShowNav(false);
    setPendingTargetId(targetId ?? null);
    router.navigate({
      to: "/app/settings",
      hash: id,
      replace: true,
      resetScroll: false,
    });
  };

  const handleSelectSearchResult = (result: SettingsSearchItem<SectionId>) => {
    setSearchQuery("");
    handleSelectSection(result.sectionId, result.targetId);
  };

  const focusSearchResult = (index: number) => {
    searchResultRefs.current[index]?.focus();
  };

  const handleSearchInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" && searchResults.length > 0) {
      event.preventDefault();
      focusSearchResult(0);
    } else if (event.key === "Escape" && searchQuery) {
      event.preventDefault();
      setSearchQuery("");
    }
  };

  const handleSearchResultKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number
  ) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusSearchResult((index + 1) % searchResults.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (index === 0) searchInputRef.current?.focus();
      else focusSearchResult(index - 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      searchInputRef.current?.focus();
      setSearchQuery("");
    }
  };

  const handleMobileBack = () => {
    setMobileShowNav(true);
    router.navigate({
      to: "/app/settings",
      hash: "",
      replace: true,
      resetScroll: false,
    });
  };

  // --- Render active section ---
  const renderSection = () => {
    switch (activeSection) {
      case "account":
        return <AccountSection
          session={session} profile={profile}
          editUsername={editUsername} setEditUsername={setEditUsername}
          savingUsername={savingUsername} handleSaveUsername={handleSaveUsername}
          usernameError={usernameError} usernameSavedAt={usernameSavedAt}
          currentPassword={currentPassword} setCurrentPassword={setCurrentPassword}
          newPassword={newPassword} setNewPassword={setNewPassword}
          confirmPassword={confirmPassword} setConfirmPassword={setConfirmPassword}
          changingPassword={changingPassword} handleChangePassword={handleChangePassword}
          passwordError={passwordError} passwordSavedAt={passwordSavedAt}
          handleSignOut={handleSignOut}
        />;
      case "ai-config":
        return <AiConfigSection />;
      case "content-safety":
        return <ContentSafetySection settings={settings} updateSetting={updateSetting} isMinor={isMinor} />;
      case "privacy":
        return <PrivacySection settings={settings} updateSetting={updateSetting} />;
      case "notifications":
        return <NotificationsSection settings={settings} updateSetting={updateSetting} />;
      case "display":
        return <DisplaySection settings={settings} updateSetting={updateSetting} />;
      case "wallpaper":
        return (
          <WallpaperSection
            wallpaperOpacity={settings.wallpaperOpacity}
            wallpaperGradientStrength={settings.wallpaperGradientStrength}
            cloudyGlassStrength={settings.cloudyGlassStrength}
            discoverWallpaper={settings.discoverWallpaper}
            profileWallpaper={settings.profileWallpaper}
            settingsWallpaper={settings.settingsWallpaper}
            libraryWallpaper={settings.libraryWallpaper}
            wallpaperAssets={userAssets.filter((asset) => asset.type === "image")}
            wallpaperFolderName="wallpaper"
            wallpaperAssetsLoading={assetsLoading}
            wallpaperUploading={wallpaperUploading}
            setWallpaperOpacity={(value) =>
              setSettings((prev) => ({ ...prev, wallpaperOpacity: normalizeVisualStrength(value) }))
            }
            setWallpaperGradientStrength={(value) =>
              setSettings((prev) => ({
                ...prev,
                wallpaperGradientStrength: normalizeVisualStrength(value),
              }))
            }
            setCloudyGlassStrength={(value) =>
              setSettings((prev) => ({
                ...prev,
                cloudyGlassStrength: normalizeVisualStrength(value),
              }))
            }
            onUploadWallpaper={handleWallpaperUpload}
            onSelectDiscoverWallpaper={(value) => void updateSetting("discoverWallpaper", value)}
            onSelectProfileWallpaper={(value) => void updateSetting("profileWallpaper", value)}
            onSelectSettingsWallpaper={(value) => void updateSetting("settingsWallpaper", value)}
            onSelectLibraryWallpaper={(value) => void updateSetting("libraryWallpaper", value)}
          />
        );
      case "about":
        return <AboutSection />;
    }
  };

  return (
    <div className="settings-page h-full overflow-hidden">
      <div className="settings-layout mx-auto flex h-full max-w-[1100px] flex-col md:flex-row">

        {/* ---- Sidebar (desktop) / Nav list (mobile) ---- */}
        <aside className={`shrink-0 md:block md:w-[260px] md:border-r md:border-white/5 ${mobileShowNav ? "block" : "hidden"}`}>
          <div data-scroll-restoration-id={mobileShowNav ? "settings-main" : "settings-nav"} className="settings-nav-scroll flex h-full flex-col overflow-y-auto px-4 py-8 md:px-6 md:py-10">
            {/* Title */}
            <h1 className="mb-5 flex items-center gap-3 text-2xl font-black text-main">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gold/10">
                <SettingsIcon aria-hidden="true" className="h-4.5 w-4.5 text-gold" />
              </div>
              {t("pageTitle")}
            </h1>

            <div role="search" className="mb-6">
              <label htmlFor="settings-search" className="sr-only">
                {t("search.label")}
              </label>
              <div className="relative">
                <Search
                  aria-hidden="true"
                  className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-sub/60"
                />
                <input
                  ref={searchInputRef}
                  id="settings-search"
                  type="search"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  onKeyDown={handleSearchInputKeyDown}
                  placeholder={t("search.placeholder")}
                  autoComplete="off"
                  spellCheck={false}
                  aria-controls={isSearching ? "settings-search-results" : undefined}
                  aria-describedby={isSearching ? "settings-search-status" : undefined}
                  className="profile-overview-input-surface h-11 w-full appearance-none rounded-xl border border-white/10 bg-white/[0.04] py-2 pl-10 pr-11 text-sm text-main outline-none transition-colors placeholder:text-sub/45 focus:border-gold/70 focus:ring-2 focus:ring-gold/20 [&::-webkit-search-cancel-button]:appearance-none"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => {
                      setSearchQuery("");
                      searchInputRef.current?.focus();
                    }}
                    aria-label={t("search.clear")}
                    className="absolute right-0.5 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-lg text-sub transition-colors hover:bg-white/[0.06] hover:text-main focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/70"
                  >
                    <X aria-hidden="true" className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>

            {isSearching ? (
              <div id="settings-search-results" className="flex-1">
                <p
                  id="settings-search-status"
                  aria-live="polite"
                  className="mb-2 px-1 text-xs font-medium text-sub/70"
                >
                  {t("search.results", { count: searchResults.length })}
                </p>

                {searchResults.length > 0 ? (
                  <div className="space-y-1">
                    {searchResults.map((result, index) => {
                      const section = SECTIONS.find((item) => item.id === result.sectionId)!;
                      const Icon = section.icon;
                      return (
                        <button
                          key={result.id}
                          ref={(node) => {
                            searchResultRefs.current[index] = node;
                          }}
                          type="button"
                          onClick={() => handleSelectSearchResult(result)}
                          onKeyDown={(event) => handleSearchResultKeyDown(event, index)}
                          className="group flex min-h-11 w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-white/[0.06] focus-visible:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/70"
                        >
                          <Icon
                            aria-hidden="true"
                            className="mt-0.5 h-[17px] w-[17px] shrink-0 text-gold/75"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-semibold leading-5 text-main">
                              {result.title}
                            </span>
                            {result.title !== result.category && (
                              <span className="block truncate text-[11px] font-medium text-gold/70">
                                {result.category}
                              </span>
                            )}
                            {result.description && (
                              <span className="mt-0.5 line-clamp-2 block text-[11px] leading-4 text-sub/65">
                                {result.description}
                              </span>
                            )}
                          </span>
                          <ChevronRight
                            aria-hidden="true"
                            className="mt-0.5 h-4 w-4 shrink-0 text-sub/30 transition-transform group-hover:translate-x-0.5 group-hover:text-main/60"
                          />
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.025] px-4 py-6 text-center">
                    <p className="text-sm font-semibold text-main">{t("search.noResults")}</p>
                    <p className="mt-1 text-xs leading-5 text-sub/60">{t("search.noResultsHint")}</p>
                  </div>
                )}
              </div>
            ) : (
              /* Nav items */
              <nav className="flex-1 space-y-1">
                {visibleSections.map((section) => {
                  const Icon = section.icon;
                  const isActive = activeSection === section.id;
                  return (
                    <button
                      key={section.id}
                      type="button"
                      onClick={() => handleSelectSection(section.id)}
                      className={`group flex min-h-11 w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-left text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/70 ${
                        isActive
                          ? "bg-gold/10 text-gold"
                          : "text-sub hover:bg-white/[0.06] hover:text-main"
                      }`}
                    >
                      <Icon aria-hidden="true" className={`h-[18px] w-[18px] shrink-0 ${isActive ? "text-gold" : "text-sub/60 group-hover:text-main/60"}`} />
                      {t(section.labelKey)}
                      {/* Mobile chevron */}
                      <ChevronRight aria-hidden="true" className="ml-auto h-4 w-4 text-sub/30 md:hidden" />
                    </button>
                  );
                })}
              </nav>
            )}

          </div>
        </aside>

        {/* ---- Content panel ---- */}
        <main data-scroll-restoration-id={mobileShowNav ? "settings-content" : "settings-main"} className={`settings-content min-h-0 flex-1 overflow-y-auto md:block ${mobileShowNav ? "hidden" : "block"}`}>
          <div className="px-4 pb-8 pt-2 md:px-10 md:py-10">
            <SettingsBackContext.Provider value={handleMobileBack}>
            <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
              {renderSection()}
            </div>
            </SettingsBackContext.Provider>
          </div>
        </main>
      </div>
    </div>
  );
}

// ============================================================
// Section Components
// ============================================================

function AiConfigSection() {
  const { t } = useTranslation("settings");

  return (
    <div className="max-w-3xl space-y-8">
      <SectionHeader id="settings-target-ai-config" title={t("aiConfig.title")} />

      <AiProviderTab />
      <AiConfigTab />
    </div>
  );
}

type SocialProviderId = "google" | "discord" | "twitter" | "github";

function GoogleSocialIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
    </svg>
  );
}

function DiscordSocialIcon() {
  return (
    <svg className="h-4 w-4 text-[#5865F2]" viewBox="0 0 24 24">
      <path fill="currentColor" d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
    </svg>
  );
}

function XSocialIcon() {
  return (
    <svg className="h-3.5 w-3.5 text-main" viewBox="0 0 24 24">
      <path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

const SOCIAL_PROVIDERS: Array<{ id: SocialProviderId; label: string; Icon: React.ComponentType }> = [
  { id: "google", label: "Google", Icon: GoogleSocialIcon },
  { id: "discord", label: "Discord", Icon: DiscordSocialIcon },
  { id: "twitter", label: "X", Icon: XSocialIcon },
];

/**
 * Settings → Account → Login devices.
 *
 * Before this existed the only way to kick a forgotten phone off your account
 * was to change your password (which revokes everything, including the device
 * you are holding). Better Auth already exposed list/revoke session endpoints;
 * this surfaces them.
 */
function LoginDevicesCard({ currentToken }: { currentToken: string | null }) {
  const { t, i18n } = useTranslation("settings");
  const [sessions, setSessions] = useState<ActiveSession[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busyToken, setBusyToken] = useState<string | null>(null);
  const [revokingOthers, setRevokingOthers] = useState(false);
  // R4: the card is on screen, so a refused revoke prints inside it.
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await authClient.listSessions();
      if (result?.error) { setFailed(true); setSessions([]); return; }
      const list = Array.isArray(result?.data) ? (result.data as unknown as ActiveSession[]) : [];
      setFailed(false);
      setSessions(list);
    } catch {
      setFailed(true);
      setSessions([]);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const handleRevoke = useCallback(async (token: string) => {
    setBusyToken(token);
    setActionError(null);
    try {
      const { error } = await authClient.revokeSession({ token });
      // No pill on success: the device row leaves the list.
      if (error) setActionError(error.message ?? t("account.loginDevices.revokeError"));
      else await refresh();
    } catch {
      setActionError(t("account.loginDevices.revokeError"));
    } finally {
      setBusyToken(null);
    }
  }, [refresh, t]);

  const handleRevokeOthers = useCallback(async () => {
    setRevokingOthers(true);
    setActionError(null);
    try {
      const { error } = await authClient.revokeOtherSessions();
      // No pill on success: every other row leaves the list.
      if (error) setActionError(error.message ?? t("account.loginDevices.revokeError"));
      else await refresh();
    } catch {
      setActionError(t("account.loginDevices.revokeError"));
    } finally {
      setRevokingOthers(false);
    }
  }, [refresh, t]);

  const ordered = sortSessions(sessions ?? [], currentToken);
  const otherCount = ordered.filter((s) => s.token !== currentToken).length;

  return (
    <Card id="settings-target-account-devices">
      <CardIcon icon={MonitorSmartphone} />
      <div className="min-w-0 flex-1 space-y-4">
        <div>
          <div className="font-semibold text-main">{t("account.loginDevices.title")}</div>
          <div className="mt-0.5 text-xs text-sub">{t("account.loginDevices.description")}</div>
        </div>

        {sessions === null ? (
          <div className="flex items-center gap-2 text-xs text-sub">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t("account.loginDevices.loading")}
          </div>
        ) : failed ? (
          <div className="text-xs text-sub">{t("account.loginDevices.loadError")}</div>
        ) : (
          <div className="space-y-2">
            {ordered.map((s) => {
              const isCurrent = s.token === currentToken;
              const label = deviceLabel(s.userAgent) || t("account.loginDevices.unknownDevice");
              return (
                <div
                  key={s.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-semibold text-main">{label}</span>
                      {isCurrent && (
                        <span className="shrink-0 rounded-full border border-gold/30 bg-gold/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-gold">
                          {t("account.loginDevices.thisDevice")}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-xs text-sub/60">
                      {t("account.loginDevices.lastActive", {
                        time: formatSessionTime(s.updatedAt, i18n.language),
                      })}
                      {s.ipAddress ? ` · ${s.ipAddress}` : ""}
                    </div>
                  </div>
                  {!isCurrent && (
                    <button
                      onClick={() => void handleRevoke(s.token)}
                      disabled={busyToken === s.token || revokingOthers}
                      className="shrink-0 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs font-bold text-red-400 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {busyToken === s.token ? t("account.loginDevices.signingOut") : t("account.loginDevices.signOutDevice")}
                    </button>
                  )}
                </div>
              );
            })}

            {otherCount > 0 && (
              <button
                onClick={() => void handleRevokeOthers()}
                disabled={revokingOthers || busyToken !== null}
                className="w-full rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm font-bold text-red-400 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {revokingOthers
                  ? t("account.loginDevices.signingOut")
                  : t("account.loginDevices.signOutOthers", { n: otherCount })}
              </button>
            )}

            <FieldError message={actionError} />
            <div className="text-xs text-sub/40">{t("account.loginDevices.propagationNote")}</div>
          </div>
        )}
      </div>
    </Card>
  );
}

function ConnectedAccountsCard() {
  const { t } = useTranslation("settings");
  const [accounts, setAccounts] = useState<Array<{ providerId: string; accountId: string }> | null>(null);
  const [busyProvider, setBusyProvider] = useState<string | null>(null);
  // R4: link/unlink problems print in the card, under the provider rows.
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await authClient.listAccounts();
      const list = Array.isArray(result?.data) ? result.data : [];
      setAccounts(list as Array<{ providerId: string; accountId: string }>);
    } catch {
      setAccounts([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const linkedSet = new Set((accounts ?? []).map((a) => a.providerId));
  const credentialLinked = linkedSet.has("credential");

  const handleConnect = useCallback(async (provider: SocialProviderId) => {
    setBusyProvider(provider);
    setActionError(null);
    try {
      const { data, error } = await authClient.linkSocial({
        provider,
        callbackURL: window.location.pathname + window.location.search,
      });
      if (error) {
        setActionError(error.message ?? t("account.connectedAccounts.connectError"));
        setBusyProvider(null);
        return;
      }
      if (data && typeof (data as { url?: string }).url === "string") {
        window.location.href = (data as { url: string }).url;
        return;
      }
      await refresh();
    } catch {
      setActionError(t("account.connectedAccounts.connectError"));
    } finally {
      setBusyProvider(null);
    }
  }, [refresh, t]);

  const handleDisconnect = useCallback(async (providerId: SocialProviderId) => {
    setBusyProvider(providerId);
    setActionError(null);
    try {
      const { error } = await authClient.unlinkAccount({ providerId });
      // No pill on success: the row's status flips to "Not connected".
      if (error) setActionError(error.message ?? t("account.connectedAccounts.disconnectError"));
      else await refresh();
    } catch {
      setActionError(t("account.connectedAccounts.disconnectError"));
    } finally {
      setBusyProvider(null);
    }
  }, [refresh, t]);

  return (
    <Card id="settings-target-account-connections">
      <CardIcon icon={Link2} />
      <div className="flex-1 space-y-4">
        <div>
          <div className="font-semibold text-main">{t("account.connectedAccounts.title")}</div>
          <div className="mt-0.5 text-xs text-sub">{t("account.connectedAccounts.description")}</div>
        </div>

        <div className="space-y-2">
          {/* Email & password — always shown, no action */}
          <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3">
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/[0.04] text-main/80">
                <Mail className="h-4 w-4" />
              </div>
              <div>
                <div className="text-sm font-semibold text-main">{t("account.connectedAccounts.emailPassword")}</div>
                <div className="text-[11px] text-sub/60">
                  {accounts === null
                    ? t("account.connectedAccounts.loading")
                    : credentialLinked
                      ? t("account.connectedAccounts.connected")
                      : t("account.connectedAccounts.notConnected")}
                </div>
              </div>
            </div>
          </div>

          {SOCIAL_PROVIDERS.map(({ id, label, Icon }) => {
            const isLinked = linkedSet.has(id);
            const isBusy = busyProvider === id;
            const disabled = isBusy || accounts === null;
            return (
              <div key={id} className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3">
                <div className="flex items-center gap-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/[0.04]">
                    <Icon />
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-main">{label}</div>
                    <div className="text-[11px] text-sub/60">
                      {accounts === null
                        ? t("account.connectedAccounts.loading")
                        : isLinked
                          ? t("account.connectedAccounts.connected")
                          : t("account.connectedAccounts.notConnected")}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => (isLinked ? handleDisconnect(id) : handleConnect(id))}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                    isLinked
                      ? "border-white/10 bg-white/[0.04] text-sub hover:border-red-400/30 hover:bg-red-500/10 hover:text-red-300"
                      : "border-gold/30 bg-gold/15 text-gold hover:bg-gold/25"
                  }`}
                >
                  {isBusy
                    ? isLinked
                      ? t("account.connectedAccounts.disconnecting")
                      : t("account.connectedAccounts.connecting")
                    : isLinked
                      ? t("account.connectedAccounts.disconnect")
                      : t("account.connectedAccounts.connect")}
                </button>
              </div>
            );
          })}
        </div>

        <FieldError message={actionError} />
      </div>
    </Card>
  );
}

function AccountSection({
  session, profile, editUsername, setEditUsername, savingUsername, handleSaveUsername,
  usernameError, usernameSavedAt,
  currentPassword, setCurrentPassword, newPassword, setNewPassword,
  confirmPassword, setConfirmPassword, changingPassword, handleChangePassword,
  passwordError, passwordSavedAt,
  handleSignOut,
}: {
  session: { user?: { email?: string | null }; session?: { token?: string | null } } | null;
  profile: { username?: string | null } | null;
  editUsername: string; setEditUsername: (v: string) => void;
  savingUsername: boolean; handleSaveUsername: () => void;
  usernameError: string | null; usernameSavedAt: number;
  currentPassword: string; setCurrentPassword: (v: string) => void;
  newPassword: string; setNewPassword: (v: string) => void;
  confirmPassword: string; setConfirmPassword: (v: string) => void;
  changingPassword: boolean; handleChangePassword: () => void;
  passwordError: string | null; passwordSavedAt: number;
  handleSignOut: () => void;
}) {
  const { t } = useTranslation("settings");
  const { auth } = useEdition();
  const usernameSaved = useTransientFlag(usernameSavedAt, 1500);
  const passwordSaved = useTransientFlag(passwordSavedAt, 1500);
  return (
    <div className="max-w-2xl space-y-8">
      <SectionHeader id="settings-target-account" title={t("account.title")} />

      {/* Email — not in single-user mode (the local account has a placeholder address) */}
      {auth.mode === "multi-user" && (
      <Card id="settings-target-account-email">
        <CardIcon icon={User} />
        <div className="flex-1">
          <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-sub">{t("account.emailLabel")}</div>
          <div className="text-sm text-main/60">{session?.user?.email ?? "--"}</div>
          <div className="mt-1 text-xs text-sub/40">{t("account.emailCannotChange")}</div>
        </div>
      </Card>
      )}

      {/* Username */}
      <Card id="settings-target-account-username">
        <CardIcon icon={User} />
        <div className="flex-1 space-y-3">
          <div className="text-xs font-semibold uppercase tracking-wider text-sub">{t("account.usernameLabel")}</div>
          <div className="flex items-center gap-3">
            <div className="relative flex-1">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-sub">@</span>
              <input
                type="text"
                value={editUsername}
                onChange={(e) => setEditUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))}
                maxLength={30}
                aria-invalid={!!usernameError}
                aria-describedby={usernameError ? "settings-username-error" : undefined}
                className="profile-overview-input-surface w-full rounded-lg border border-white/10 py-2 pl-7 pr-3 text-sm text-main outline-none focus:border-gold focus:ring-1 focus:ring-gold"
              />
            </div>
            <button
              onClick={handleSaveUsername}
              disabled={savingUsername || editUsername === (profile?.username ?? "")}
              className="rounded-lg border border-gold/30 bg-gold/15 px-4 py-2 text-sm font-bold text-gold transition-colors hover:bg-gold/25 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {savingUsername ? t("account.saving") : usernameSaved ? t("account.saved") : t("account.save")}
            </button>
          </div>
          <FieldError id="settings-username-error" message={usernameError} />
          <div className="text-xs text-sub/40">{t("account.usernameHint")}</div>
        </div>
      </Card>

      {/* Change Password — not in single-user mode (the local account has no password) */}
      {auth.mode === "multi-user" && (
      <Card id="settings-target-account-password">
        <CardIcon icon={Key} />
        <div className="flex-1 space-y-4">
          <div>
            <div className="font-semibold text-main">{t("account.changePassword.title")}</div>
            <div className="mt-0.5 text-xs text-sub">{t("account.changePassword.description")}</div>
          </div>
          <div className="profile-overview-glass profile-overview-glass--soft space-y-3 rounded-xl p-4">
            <PasswordField label={t("account.changePassword.currentPassword")} value={currentPassword} onChange={setCurrentPassword} autoComplete="current-password" />
            <PasswordField label={t("account.changePassword.newPassword")} value={newPassword} onChange={setNewPassword} autoComplete="new-password" />
            <PasswordField label={t("account.changePassword.confirmNewPassword")} value={confirmPassword} onChange={setConfirmPassword} autoComplete="new-password" />
          </div>
          <FieldError message={passwordError} />
          <button
            onClick={handleChangePassword}
            disabled={changingPassword || !currentPassword || !newPassword || !confirmPassword}
            className="rounded-lg border border-gold/30 bg-gold/15 px-4 py-2 text-sm font-bold text-gold transition-colors hover:bg-gold/25 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {changingPassword
              ? t("account.changePassword.changing")
              : passwordSaved
                ? t("account.changePassword.changed")
                : t("account.changePassword.submit")}
          </button>
        </div>
      </Card>
      )}

      {/* Connected accounts + login devices — not in single-user mode (one local
          account, no sign-in methods to link, nothing to sign out of) */}
      {auth.mode === "multi-user" && (
        <>
          <ConnectedAccountsCard />
          <LoginDevicesCard currentToken={session?.session?.token ?? null} />
        </>
      )}

      {/* Sign Out — not in single-user mode (one auto-signed-in local account) */}
      {auth.mode === "multi-user" && (
      <div
        id="settings-target-account-sign-out"
        tabIndex={-1}
        className="profile-overview-glass profile-overview-glass--soft scroll-mt-8 rounded-2xl border-red-500/20 p-5 focus:outline-none focus:ring-2 focus:ring-gold/50"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-red-500/10 text-red-400">
              <LogOut className="h-5 w-5" />
            </div>
            <div>
              <div className="font-semibold text-main">{t("account.signOut.title")}</div>
              <div className="mt-0.5 text-xs text-sub">{t("account.signOut.description")}</div>
            </div>
          </div>
          <button
            onClick={handleSignOut}
            className="rounded-xl bg-red-500 px-6 py-2 text-sm font-bold text-white transition-colors hover:bg-red-500/80"
          >
            {t("account.signOut.button")}
          </button>
        </div>
      </div>
      )}

      {/* Delete account — not in single-user mode (the one local account is
          recreated on the next start; wiping data is a matter of deleting ./data) */}
      {auth.mode === "multi-user" && (
        <DeleteAccountCard
          email={session?.user?.email ?? ""}
          username={profile?.username ?? ""}
        />
      )}
    </div>
  );
}

type DeleteAccountResponse = {
  success?: boolean;
  message?: string;
  error?: string;
  code?: string;
};

function DeleteAccountCard({ email, username }: { email: string; username: string }) {
  const { t, i18n } = useTranslation("settings");
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [emailSent, setEmailSent] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);

  const confirmationTarget = username.trim() || email.trim();
  const canRequest = !!confirmationTarget
    && confirmation.trim() === confirmationTarget
    && acknowledged
    && !requesting;

  const resetDialog = () => {
    setConfirmation("");
    setAcknowledged(false);
    setEmailSent(false);
    setRequestError(null);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (requesting) return;
    setOpen(nextOpen);
    if (!nextOpen) resetDialog();
  };

  const getErrorMessage = (code?: string) => {
    switch (code) {
      case "CONFIRMATION_MISMATCH":
        return t("account.deleteAccount.errors.confirmationMismatch");
      case "PENDING_CREATOR_EARNINGS":
        return t("account.deleteAccount.errors.pendingEarnings");
      case "BILLING_CLEANUP_UNAVAILABLE":
      case "SUBSCRIPTION_CANCELLATION_FAILED":
        return t("account.deleteAccount.errors.billing");
      case "CREATOR_ACCOUNT_CLOSURE_FAILED":
        return t("account.deleteAccount.errors.creatorAccount");
      case "ACCOUNT_DELETION_NOT_READY":
        return t("account.deleteAccount.errors.notReady");
      case "ACCOUNT_DELETION_COOLDOWN":
        return t("account.deleteAccount.errors.cooldown");
      case "LAST_ADMIN_ACCOUNT":
        return t("account.deleteAccount.errors.lastAdmin");
      case "REFERRAL_HISTORY_REQUIRES_SUPPORT":
        return t("account.deleteAccount.errors.referral");
      case "ACCOUNT_RESTRICTION_REQUIRES_SUPPORT":
        return t("account.deleteAccount.errors.protectedHistory");
      case "DELETE_CONFIRMATION_EMAIL_FAILED":
        return t("account.deleteAccount.errors.email");
      default:
        return t("account.deleteAccount.errors.generic");
    }
  };

  const handleRequestDeletion = async () => {
    if (!canRequest) return;
    setRequesting(true);
    setRequestError(null);
    try {
      const response = await fetch(`${apiBase}/api/auth/delete-user`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          confirmation: confirmation.trim(),
          locale: i18n.resolvedLanguage ?? i18n.language,
        }),
      });
      const payload = await response.json().catch(() => ({})) as DeleteAccountResponse;

      if (!response.ok || !payload.success) {
        // R4: the dialog stays open, so the reason belongs inside it.
        setRequestError(getErrorMessage(payload.code));
        return;
      }

      setEmailSent(true);
    } catch {
      setRequestError(t("account.deleteAccount.errors.generic"));
    } finally {
      setRequesting(false);
    }
  };

  return (
    <>
      <div
        id="settings-target-account-delete"
        tabIndex={-1}
        className="scroll-mt-8 rounded-2xl border border-red-500/30 bg-red-950/20 p-5 focus:outline-none focus:ring-2 focus:ring-gold/50"
      >
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-red-500/15 text-red-400">
              <Trash2 className="h-5 w-5" />
            </div>
            <div>
              <div className="font-semibold text-red-200">{t("account.deleteAccount.title")}</div>
              <div className="mt-0.5 text-xs leading-relaxed text-red-100/60">
                {t("account.deleteAccount.description")}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setOpen(true)}
            disabled={!confirmationTarget}
            className="shrink-0 rounded-xl border border-red-500/40 bg-red-500/10 px-5 py-2 text-sm font-bold text-red-300 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t("account.deleteAccount.button")}
          </button>
        </div>
      </div>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-h-[90vh] overflow-y-auto border-red-500/20 bg-[#18181b] text-main sm:max-w-lg">
          {emailSent ? (
            <div className="py-4 text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-400">
                <CheckCircle2 className="h-7 w-7" />
              </div>
              <DialogHeader className="mt-5">
                <DialogTitle className="text-center">
                  {t("account.deleteAccount.emailSentTitle")}
                </DialogTitle>
                <DialogDescription className="text-center leading-relaxed text-sub">
                  {t("account.deleteAccount.emailSentDescription", { email })}
                </DialogDescription>
              </DialogHeader>
              <button
                type="button"
                onClick={() => handleOpenChange(false)}
                className="mt-6 rounded-xl border border-white/10 bg-white/[0.06] px-6 py-2 text-sm font-semibold text-main transition-colors hover:bg-white/[0.1]"
              >
                {t("account.deleteAccount.close")}
              </button>
            </div>
          ) : (
            <>
              <DialogHeader>
                <div className="mb-2 flex h-11 w-11 items-center justify-center rounded-xl bg-red-500/15 text-red-400">
                  <TriangleAlert className="h-6 w-6" />
                </div>
                <DialogTitle className="text-red-200">
                  {t("account.deleteAccount.dialogTitle")}
                </DialogTitle>
                <DialogDescription className="leading-relaxed text-sub">
                  {t("account.deleteAccount.dialogDescription")}
                </DialogDescription>
              </DialogHeader>

              <div className="rounded-xl border border-red-500/25 bg-red-950/25 p-4">
                <div className="text-sm font-bold text-red-200">
                  {t("account.deleteAccount.warningTitle")}
                </div>
                <ul className="mt-3 list-disc space-y-2 pl-5 text-xs leading-relaxed text-red-100/70">
                  <li>{t("account.deleteAccount.warnings.identity")}</li>
                  <li>{t("account.deleteAccount.warnings.deletionCooldown")}</li>
                  <li>{t("account.deleteAccount.warnings.content")}</li>
                  <li>{t("account.deleteAccount.warnings.community")}</li>
                  <li>{t("account.deleteAccount.warnings.billing")}</li>
                  <li>{t("account.deleteAccount.warnings.records")}</li>
                  <li>{t("account.deleteAccount.warnings.antiAbuse")}</li>
                  <li>{t("account.deleteAccount.warnings.cache")}</li>
                </ul>
              </div>

              <p className="text-xs leading-relaxed text-amber-200/70">
                {t("account.deleteAccount.pendingEarnings")}
              </p>

              <div className="space-y-2">
                <label htmlFor="delete-account-confirmation" className="text-xs font-semibold text-main">
                  {t("account.deleteAccount.confirmLabel", { target: confirmationTarget })}
                </label>
                <input
                  id="delete-account-confirmation"
                  type="text"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  placeholder={t("account.deleteAccount.confirmPlaceholder", { target: confirmationTarget })}
                  autoComplete="off"
                  spellCheck={false}
                  className="w-full rounded-xl border border-red-500/25 bg-black/20 px-3 py-2.5 text-sm text-main outline-none transition-colors placeholder:text-sub/35 focus:border-red-400/60 focus:ring-1 focus:ring-red-400/20"
                />
              </div>

              <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-white/10 bg-white/[0.025] p-3 text-xs leading-relaxed text-sub">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-red-500"
                />
                <span>{t("account.deleteAccount.acknowledge")}</span>
              </label>

              <FieldError message={requestError} />

              <DialogFooter className="gap-2 sm:gap-2">
                <button
                  type="button"
                  onClick={() => handleOpenChange(false)}
                  disabled={requesting}
                  className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-semibold text-main transition-colors hover:bg-white/[0.08] disabled:opacity-50"
                >
                  {t("account.deleteAccount.cancel")}
                </button>
                <button
                  type="button"
                  onClick={handleRequestDeletion}
                  disabled={!canRequest}
                  className="inline-flex items-center justify-center gap-2 rounded-xl bg-red-600 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {requesting && <Loader2 className="h-4 w-4 animate-spin" />}
                  {requesting
                    ? t("account.deleteAccount.sending")
                    : t("account.deleteAccount.sendEmail")}
                </button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function ContentSafetySection({
  settings, updateSetting, isMinor,
}: {
  settings: ProfileSettings;
  updateSetting: <K extends keyof ProfileSettings>(key: K, value: ProfileSettings[K]) => void;
  isMinor: boolean;
}) {
  const { t } = useTranslation("settings");
  return (
    <div className="max-w-2xl space-y-8">
      <SectionHeader id="settings-target-content-safety" title={t("contentSafety.title")} />

      {/* Content Mode — hidden entirely for minors: Limitless mode should not
          even be discoverable for them (the top-bar eye is hidden the same way). */}
      {!isMinor && (
        <Card id="settings-target-content-level">
          <CardIcon icon={Eye} />
          <div className="flex-1 space-y-4">
            <div className="font-semibold text-main">{t("contentSafety.contentLevel")}</div>
            <RadioGroup
              value={settings.contentLevel}
              onValueChange={(v) => updateSetting("contentLevel", v as ContentLevel)}
              className="gap-3"
            >
              <label className="profile-overview-glass profile-overview-glass--soft flex cursor-pointer items-center gap-3 rounded-lg px-4 py-3 transition-colors hover:border-white/15">
                <RadioGroupItem value="safe" className="border-white/20 text-gold data-[state=checked]:border-gold" />
                <div>
                  <div className="text-sm font-medium text-main">{t("contentSafety.safe.label")}</div>
                  <div className="text-xs text-sub">{t("contentSafety.safe.description")}</div>
                </div>
              </label>
              <label className="profile-overview-glass profile-overview-glass--soft flex cursor-pointer items-center gap-3 rounded-lg px-4 py-3 transition-colors hover:border-white/15">
                <RadioGroupItem value="sensitive" className="border-white/20 text-gold data-[state=checked]:border-gold" />
                <div>
                  <div className="text-sm font-medium text-main">{t("contentSafety.sensitive.label")}</div>
                  <div className="text-xs text-sub">{t("contentSafety.sensitive.description")}</div>
                </div>
              </label>
            </RadioGroup>
          </div>
        </Card>
      )}

      {/* Audience Preference */}
      <Card id="settings-target-audience-preference">
        <CardIcon icon={Eye} />
        <div className="flex-1 space-y-4">
          <div className="font-semibold text-main">{t("contentSafety.audiencePreference.title")}</div>
          <div className="text-xs text-sub -mt-2">{t("contentSafety.audiencePreference.description")}</div>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
            {([
              {
                value: "all" as const,
                label: t("contentSafety.audiencePreference.all.label"),
                description: t("contentSafety.audiencePreference.all.description"),
                activeCard: "border-emerald-400/50 bg-emerald-400/[0.08] shadow-[inset_0_1px_0_0_rgba(110,231,183,0.15)]",
                inactiveCard: "border-white/8 bg-white/[0.02] hover:border-emerald-400/25 hover:bg-emerald-400/[0.03]",
                activeDot: "bg-emerald-400 shadow-[0_0_12px_-2px_rgba(52,211,153,0.7)]",
                activeLabel: "text-emerald-100",
                activeDesc: "text-emerald-200/60",
              },
              {
                value: "male" as const,
                label: t("contentSafety.audiencePreference.male.label"),
                description: t("contentSafety.audiencePreference.male.description"),
                activeCard: "border-sky-400/50 bg-sky-400/[0.08] shadow-[inset_0_1px_0_0_rgba(125,211,252,0.15)]",
                inactiveCard: "border-white/8 bg-white/[0.02] hover:border-sky-400/25 hover:bg-sky-400/[0.03]",
                activeDot: "bg-sky-400 shadow-[0_0_12px_-2px_rgba(56,189,248,0.7)]",
                activeLabel: "text-sky-100",
                activeDesc: "text-sky-200/60",
              },
              {
                value: "female" as const,
                label: t("contentSafety.audiencePreference.female.label"),
                description: t("contentSafety.audiencePreference.female.description"),
                activeCard: "border-rose-400/50 bg-rose-400/[0.08] shadow-[inset_0_1px_0_0_rgba(253,164,175,0.15)]",
                inactiveCard: "border-white/8 bg-white/[0.02] hover:border-rose-400/25 hover:bg-rose-400/[0.03]",
                activeDot: "bg-rose-400 shadow-[0_0_12px_-2px_rgba(251,113,133,0.7)]",
                activeLabel: "text-rose-100",
                activeDesc: "text-rose-200/60",
              },
            ]).map((opt) => {
              const active = settings.audiencePreference === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => updateSetting("audiencePreference", opt.value)}
                  aria-pressed={active}
                  className={`group relative flex flex-col items-start gap-2 rounded-xl border px-4 py-3.5 text-left transition-all duration-200 ${
                    active ? opt.activeCard : opt.inactiveCard
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`relative flex h-4 w-4 items-center justify-center rounded-full transition-all ${
                        active ? opt.activeDot : "border border-white/20 bg-transparent"
                      }`}
                    >
                      {active && (
                        <svg viewBox="0 0 12 12" className="h-2.5 w-2.5 text-[#181818]" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="2,6.5 5,9 10,3.5" />
                        </svg>
                      )}
                    </span>
                    <span className={`text-sm font-semibold transition-colors ${active ? opt.activeLabel : "text-sub"}`}>
                      {opt.label}
                    </span>
                  </div>
                  <span className={`text-[11px] leading-relaxed transition-colors ${active ? opt.activeDesc : "text-sub/50"}`}>
                    {opt.description}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </Card>

      {/* Blur sensitive */}
      <ToggleRow
        id="settings-target-blur-sensitive"
        title={t("contentSafety.blurSensitive.title")}
        description={t("contentSafety.blurSensitive.description")}
        checked={settings.blurSensitive}
        onChange={(v) => updateSetting("blurSensitive", v)}
      />
    </div>
  );
}

function PrivacySection({
  settings, updateSetting,
}: {
  settings: ProfileSettings;
  updateSetting: <K extends keyof ProfileSettings>(key: K, value: ProfileSettings[K]) => void;
}) {
  const { t } = useTranslation("settings");
  const { features } = useEdition();

  const togglePrivacy = (key: keyof PrivacySettings, value: boolean) => {
    updateSetting("privacy", { ...settings.privacy, [key]: value });
  };
  const setProfileVisibility = (profileVisibility: PrivacySettings["profileVisibility"]) => {
    updateSetting("privacy", {
      ...settings.privacy,
      profileVisibility,
      isPrivateAccount: profileVisibility !== "public",
    });
  };
  const visibilityOptions = [
    {
      value: "public" as const,
      title: t("privacy.profileVisibility.public.title", { defaultValue: "Public" }),
      description: t("privacy.profileVisibility.public.description", { defaultValue: "Anyone can view your profile." }),
    },
    {
      value: "followers" as const,
      title: t("privacy.profileVisibility.followers.title", { defaultValue: "Followers" }),
      description: t("privacy.profileVisibility.followers.description", { defaultValue: "Only users you follow can see your published worlds and private profile data." }),
    },
    {
      value: "private" as const,
      title: t("privacy.profileVisibility.private.title", { defaultValue: "Private" }),
      description: t("privacy.profileVisibility.private.description", { defaultValue: "Only you can see your published worlds and private profile data." }),
    },
  ];

  return (
    <div className="max-w-2xl space-y-6">
      <SectionHeader id="settings-target-privacy" title={t("privacy.title")} />
      {features.socialProfiles && (
      <Card id="settings-target-profile-visibility">
        <CardIcon icon={Lock} />
        <div className="flex-1">
          <div className="font-semibold text-main">{t("privacy.profileVisibility.title", { defaultValue: "Profile Visibility" })}</div>
          <div className="mt-0.5 text-xs text-sub">{t("privacy.profileVisibility.description", { defaultValue: "Choose who can see your profile details." })}</div>
          <div className="mt-4 grid gap-2 sm:grid-cols-3">
            {visibilityOptions.map((option) => {
              const active = settings.privacy.profileVisibility === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setProfileVisibility(option.value)}
                  className={`rounded-xl border px-3 py-3 text-left transition-colors ${
                    active
                      ? "border-gold/40 bg-gold/10 text-main"
                      : "border-white/8 bg-white/[0.03] text-sub hover:bg-white/[0.06]"
                  }`}
                >
                  <div className="text-sm font-semibold">{option.title}</div>
                  <div className="mt-1 text-[11px] leading-relaxed opacity-70">{option.description}</div>
                </button>
              );
            })}
          </div>
        </div>
      </Card>
      )}
      {features.dm && (
      <ToggleRow
        id="settings-target-allow-dms"
        title={t("privacy.allowDMs.title")}
        description={t("privacy.allowDMs.description")}
        checked={settings.privacy.allowDMs}
        onChange={(v) => togglePrivacy("allowDMs", v)}
      />
      )}
      <ToggleRow
        id="settings-target-play-history"
        title={t("privacy.showPlayHistory.title", { defaultValue: t("privacy.showRecentPlay.title") })}
        description={t("privacy.showPlayHistory.description", { defaultValue: t("privacy.showRecentPlay.description") })}
        checked={settings.privacy.showPlayHistory}
        onChange={(v) => updateSetting("privacy", { ...settings.privacy, showPlayHistory: v, showRecentPlay: v })}
      />
      {features.socialProfiles && (
      <>
      <ToggleRow
        id="settings-target-follow-lists"
        title={t("privacy.showFollowLists.title", { defaultValue: "Show Followers / Following Lists" })}
        description={t("privacy.showFollowLists.description", { defaultValue: "Let others open your followers and following lists. The counts still show either way." })}
        checked={settings.privacy.showFollowLists}
        onChange={(v) => togglePrivacy("showFollowLists", v)}
      />
      <ToggleRow
        id="settings-target-favorites"
        title={t("privacy.showFavorites.title", { defaultValue: "Show My Favorites" })}
        description={t("privacy.showFavorites.description", { defaultValue: "Display favorites and collection previews on your public profile." })}
        checked={settings.privacy.showFavorites}
        onChange={(v) => togglePrivacy("showFavorites", v)}
      />
      </>
      )}
      {features.dm && <BlacklistManager />}
    </div>
  );
}

interface BlockedUser {
  id: string;
  name: string;
  username: string | null;
  image: string | null;
  blockedAt: string;
  hideBlockedWorlds: boolean;
  hideOwnWorlds: boolean;
  hideBlockedActivity: boolean;
}

function BlacklistManager() {
  const { t } = useTranslation("settings");
  const [items, setItems] = useState<BlockedUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  const loadBlocks = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${apiBase}/api/dm/blocks`, { credentials: "include" });
      if (res.ok) {
        const { data } = await res.json();
        setItems(Array.isArray(data) ? data : []);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadBlocks();
  }, []);

  // R1 for both: the checkbox/row already moved, so a refusal has to put it back
  // and offer the retry. The dialog scrolls, so the pill is the reliable anchor.
  const updateBlock = async (id: string, updates: Partial<BlockedUser>) => {
    const prev = items;
    setItems((list) => list.map((item) => item.id === id ? { ...item, ...updates } : item));
    const res = await fetch(`${apiBase}/api/dm/block/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(updates),
    });
    if (!res.ok) {
      setItems(prev);
      feedback.error(t("privacy.blacklist.saveFailed", { defaultValue: "Failed to update blacklist" }), {
        label: t("action.retry", { ns: "common" }),
        onClick: () => void updateBlock(id, updates),
      });
    }
  };

  const unblock = async (id: string) => {
    const prev = items;
    setItems((list) => list.filter((item) => item.id !== id));
    const res = await fetch(`${apiBase}/api/dm/block/${id}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (!res.ok) {
      setItems(prev);
      feedback.error(t("privacy.blacklist.saveFailed", { defaultValue: "Failed to update blacklist" }), {
        label: t("action.retry", { ns: "common" }),
        onClick: () => void unblock(id),
      });
    }
  };

  return (
    <>
      <Card id="settings-target-blacklist">
        <CardIcon icon={ShieldOff} />
        <div className="flex-1">
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="flex w-full items-center justify-between text-left"
          >
            <div>
              <div className="font-semibold text-main">{t("privacy.blacklist.title", { defaultValue: "Blacklist" })}</div>
              <div className="mt-0.5 text-xs text-sub">{t("privacy.blacklist.subtitle", { defaultValue: "Manage blocked users" })}</div>
            </div>
            <div className="flex items-center gap-2">
              {items.length > 0 && (
                <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[10px] font-medium tabular-nums text-sub/50">
                  {items.length}
                </span>
              )}
              <ChevronRight className="h-4 w-4 text-sub/40" />
            </div>
          </button>
        </div>
      </Card>

      {open && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm animate-in fade-in duration-150"
          onClick={() => setOpen(false)}
        >
          <div
            className="flex max-h-[80vh] w-full max-w-[520px] flex-col rounded-2xl border border-white/[0.08] bg-[#1A1B20] shadow-[0_18px_60px_rgba(0,0,0,0.5)] animate-in fade-in zoom-in-95 duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-white/[0.06] px-6 py-4">
              <div className="flex items-center gap-2.5">
                <ShieldOff className="h-4 w-4 text-red-300" />
                <div>
                  <div className="text-sm font-semibold text-foreground">{t("privacy.blacklist.title", { defaultValue: "Blacklist" })}</div>
                  <div className="text-[10px] text-muted-foreground/50">{t("privacy.blacklist.subtitle", { defaultValue: "Manage blocked users" })}</div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-lg p-1.5 text-muted-foreground/40 transition-colors hover:bg-white/[0.06] hover:text-muted-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-4 scrollbar-hide">
              {loading ? (
                <div className="flex justify-center py-10">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground/40" />
                </div>
              ) : items.length === 0 ? (
                <div className="rounded-xl border border-white/6 bg-white/[0.03] px-4 py-10 text-center text-xs text-muted-foreground/45">
                  {t("privacy.blacklist.empty", { defaultValue: "No blocked users." })}
                </div>
              ) : (
                <div className="space-y-3">
                  {items.map((item) => (
                    <div key={item.id} className="rounded-2xl border border-white/8 bg-white/[0.035] p-4">
                      <div className="mb-4 flex items-center gap-3">
                        {item.image ? (
                          <img src={resolveImageUrl(item.image)} alt="" className="h-11 w-11 rounded-full object-cover" />
                        ) : (
                          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-white/8 text-sm font-bold text-main">
                            {item.name.charAt(0).toUpperCase()}
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-bold text-main">{item.name}</div>
                          {item.username && <div className="truncate text-xs text-sub/55">@{item.username}</div>}
                        </div>
                        <button
                          type="button"
                          onClick={() => unblock(item.id)}
                          className="flex h-8 w-8 items-center justify-center rounded-lg text-sub/45 transition-colors hover:bg-white/8 hover:text-main"
                          aria-label={t("privacy.blacklist.unblock", { defaultValue: "Unblock" })}
                          title={t("privacy.blacklist.unblock", { defaultValue: "Unblock" })}
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                      <div className="space-y-2.5">
                        {([
                          ["hideBlockedWorlds", "hideTheirWorlds"],
                          ["hideOwnWorlds", "hideMyWorlds"],
                          ["hideBlockedActivity", "hideTheirActivity"],
                        ] as const).map(([key, labelKey]) => (
                          <label key={key} className="flex items-center justify-between gap-3 text-sm text-sub/72">
                            <span>{t(`privacy.blacklist.${labelKey}`, { defaultValue: labelKey })}</span>
                            <input
                              type="checkbox"
                              checked={item[key]}
                              onChange={(e) => void updateBlock(item.id, { [key]: e.target.checked })}
                              className="h-4 w-4 accent-[#D6A94A]"
                            />
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function NotificationsSection({
  settings, updateSetting,
}: {
  settings: ProfileSettings;
  updateSetting: <K extends keyof ProfileSettings>(key: K, value: ProfileSettings[K]) => void;
}) {
  const { t } = useTranslation("settings");

  const toggleNotifPref = (key: keyof NotificationPreferences, value: boolean) => {
    updateSetting("notificationPreferences", {
      ...settings.notificationPreferences,
      [key]: value,
    });
  };

  const NOTIFICATION_GROUPS = [
    { key: "engagement" as const, titleKey: "notifications.groups.engagement" as const, descKey: "notifications.groups.engagementDesc" as const },
    { key: "social" as const, titleKey: "notifications.groups.social" as const, descKey: "notifications.groups.socialDesc" as const },
    { key: "library" as const, titleKey: "notifications.groups.library" as const, descKey: "notifications.groups.libraryDesc" as const },
    { key: "community" as const, titleKey: "notifications.groups.community" as const, descKey: "notifications.groups.communityDesc" as const },
  ];

  return (
    <div className="max-w-2xl space-y-8">
      <SectionHeader id="settings-target-notifications" title={t("notifications.title")} />

      <Card id="settings-target-notification-groups">
        <CardIcon icon={Bell} />
        <div className="flex-1 space-y-1">
          {NOTIFICATION_GROUPS.map((group) => (
            <div key={group.key} className="flex items-center justify-between rounded-xl px-3 py-3 transition-colors hover:bg-white/[0.03]">
              <div className="min-w-0 pr-4">
                <div className="text-sm font-medium text-main">{t(group.titleKey)}</div>
                <div className="mt-0.5 text-xs text-sub">{t(group.descKey)}</div>
              </div>
              <ToggleSwitch
                checked={settings.notificationPreferences[group.key]}
                onChange={(v) => toggleNotifPref(group.key, v)}
              />
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

type FontSize = "small" | "default" | "large" | "x-large";
const FONT_SIZE_OPTIONS = [
  { value: "small" as FontSize, labelKey: "display.fontSize.small" as const, scale: 0.875 },
  { value: "default" as FontSize, labelKey: "display.fontSize.default" as const, scale: 1 },
  { value: "large" as FontSize, labelKey: "display.fontSize.large" as const, scale: 1.125 },
  { value: "x-large" as FontSize, labelKey: "display.fontSize.xLarge" as const, scale: 1.25 },
];

function DisplaySection({
  settings,
  updateSetting,
}: {
  settings: ProfileSettings;
  updateSetting: <K extends keyof ProfileSettings>(key: K, value: ProfileSettings[K]) => void;
}) {
  const { t, i18n } = useTranslation("settings");
  const isTouch = useTouchDevice();
  const fontSize = useUiStore((s) => s.fontSize ?? "default") as FontSize;
  const setFontSize = useUiStore((s) => s.setFontSize);
  const composerSendKey = useUiStore((s) => s.composerSendKey ?? "enter");
  const setComposerSendKey = useUiStore((s) => s.setComposerSendKey);
  const forceFetchProfile = useUserProfileStore((s) => s.forceFetchProfile);
  const languageTitle = t("display.language.title", { defaultValue: "Language" });
  const languageCurrent = t("display.language.current", { defaultValue: "Current" });

  const handleLanguageChange = async (code: string) => {
    await i18n.changeLanguage(code);

    const store = useUserProfileStore.getState();
    if (store.profile) {
      useUserProfileStore.setState({
        profile: {
          ...store.profile,
          preferences: { ...store.profile.preferences, language: code },
        },
      });
    }

    try {
      const res = await fetch(`${apiBase}/api/users/me`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ preferences: { language: code } }),
      });
      if (res.ok) {
        await forceFetchProfile();
      }
    } catch {
      // Keep the UI responsive even if preference persistence fails.
    }
  };

  return (
    <div className="max-w-2xl space-y-8">
      <SectionHeader id="settings-target-display" title={t("display.title")} />

      <Card id="settings-target-font-size">
        <div className="flex-1 space-y-4">
          <DisplaySubsectionHeader icon={Type} title={t("display.fontSize.title")} />
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {FONT_SIZE_OPTIONS.map((opt) => {
              const isActive = fontSize === opt.value;
              return (
                <button
                  key={opt.value}
                  onClick={() => setFontSize(opt.value)}
                  className={`flex flex-col items-center gap-2 rounded-xl border px-3 py-4 transition-all ${
                    isActive
                      ? "border-gold/40 bg-gold/10"
                      : "border-white/8 bg-white/[0.02] hover:border-white/15"
                  }`}
                >
                  <span
                    className="font-semibold text-main"
                    style={{ fontSize: `${opt.scale}rem` }}
                  >
                    Aa
                  </span>
                  <span className={`text-xs font-medium ${isActive ? "text-gold" : "text-sub"}`}>
                    {t(opt.labelKey)}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="text-[11px] text-sub/50">{t("display.fontSize.hint")}</p>
        </div>
      </Card>

      {!isTouch && (
        <ToggleRow
          id="settings-target-send-key"
          title={t("display.sendKey.title")}
          description={t("display.sendKey.description")}
          checked={composerSendKey === "enter"}
          onChange={(value) => setComposerSendKey(value ? "enter" : "mod-enter")}
        />
      )}

      <ToggleRow
        id="settings-target-auto-fullscreen"
        title={t("display.autoFullscreenOnPlay.title")}
        description={t("display.autoFullscreenOnPlay.description")}
        checked={settings.autoFullscreenOnPlay}
        onChange={(value) => updateSetting("autoFullscreenOnPlay", value)}
      />

      <ToggleRow
        id="settings-target-world-audio"
        title={t("display.worldAudio.title")}
        description={t("display.worldAudio.description")}
        checked={settings.worldAudioEnabled}
        onChange={(value) => updateSetting("worldAudioEnabled", value)}
      />

      <Card id="settings-target-language">
        <div className="flex-1 space-y-4">
          <DisplaySubsectionHeader icon={Globe} title={languageTitle} />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {LANGUAGE_OPTIONS.map((lang) => {
              const isActive = lang.code === i18n.language;
              return (
                <button
                  key={lang.code}
                  type="button"
                  onClick={() => void handleLanguageChange(lang.code)}
                  className={`flex items-center justify-between rounded-xl border px-4 py-3 text-left transition-all ${
                    isActive
                      ? "border-gold/40 bg-gold/10"
                      : "border-white/8 bg-white/[0.02] hover:border-white/15"
                  }`}
                >
                  <div>
                    <div className="text-sm font-semibold text-main">{lang.native}</div>
                    <div className="mt-0.5 text-xs text-sub">{lang.label}</div>
                  </div>
                  <span className={`text-xs font-semibold ${isActive ? "text-gold" : "text-sub/50"}`}>
                    {isActive ? languageCurrent : ""}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </Card>
    </div>
  );
}

function WallpaperSection({
  wallpaperOpacity,
  wallpaperGradientStrength,
  cloudyGlassStrength,
  discoverWallpaper,
  profileWallpaper,
  settingsWallpaper,
  libraryWallpaper,
  wallpaperAssets,
  wallpaperFolderName,
  wallpaperAssetsLoading,
  wallpaperUploading,
  setWallpaperOpacity,
  setWallpaperGradientStrength,
  setCloudyGlassStrength,
  onUploadWallpaper,
  onSelectDiscoverWallpaper,
  onSelectProfileWallpaper,
  onSelectSettingsWallpaper,
  onSelectLibraryWallpaper,
}: {
  wallpaperOpacity: number;
  wallpaperGradientStrength: number;
  cloudyGlassStrength: number;
  discoverWallpaper: WallpaperChoice;
  profileWallpaper: WallpaperChoice;
  settingsWallpaper: WallpaperChoice;
  libraryWallpaper: WallpaperChoice;
  wallpaperAssets: UserAsset[];
  wallpaperFolderName: string;
  wallpaperAssetsLoading: boolean;
  wallpaperUploading: boolean;
  setWallpaperOpacity: (value: number) => void;
  setWallpaperGradientStrength: (value: number) => void;
  setCloudyGlassStrength: (value: number) => void;
  onUploadWallpaper: (file: File) => Promise<void>;
  onSelectDiscoverWallpaper: (value: WallpaperChoice) => void;
  onSelectProfileWallpaper: (value: WallpaperChoice) => void;
  onSelectSettingsWallpaper: (value: WallpaperChoice) => void;
  onSelectLibraryWallpaper: (value: WallpaperChoice) => void;
}) {
  const { t } = useTranslation("settings");
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const wallpaperOptions = buildWallpaperOptions(wallpaperAssets, t);
  const wallpaperAssignments = [
    {
      label: t("wallpaper.assignments.discover.label"),
      description: t("wallpaper.assignments.discover.description"),
      value: discoverWallpaper,
      onSelect: onSelectDiscoverWallpaper,
    },
    {
      label: t("wallpaper.assignments.profile.label"),
      description: t("wallpaper.assignments.profile.description"),
      value: profileWallpaper,
      onSelect: onSelectProfileWallpaper,
    },
    {
      label: t("wallpaper.assignments.settings.label"),
      description: t("wallpaper.assignments.settings.description"),
      value: settingsWallpaper,
      onSelect: onSelectSettingsWallpaper,
    },
    {
      label: t("wallpaper.assignments.library.label"),
      description: t("wallpaper.assignments.library.description"),
      value: libraryWallpaper,
      onSelect: onSelectLibraryWallpaper,
    },
  ];

  return (
    <div className="max-w-2xl space-y-8">
      <SectionHeader
        id="settings-target-wallpaper"
        title={t("wallpaper.title")}
        description={t("wallpaper.description")}
      />

      <Card id="settings-target-wallpaper-visual">
        <CardIcon icon={ImageIcon} />
        <div className="min-w-0 flex-1 space-y-6">
          <div>
            <div className="font-semibold text-main">{t("wallpaper.visualControls.title")}</div>
            <p className="mt-1 text-xs text-sub">{t("wallpaper.autoSaves")}</p>
          </div>

          <WallpaperSlider
            title={t("wallpaper.opacity.title")}
            minLabel={t("wallpaper.opacity.minLabel")}
            maxLabel={t("wallpaper.opacity.maxLabel")}
            value={wallpaperOpacity}
            ariaLabel={t("wallpaper.opacity.ariaLabel")}
            hint={t("wallpaper.opacity.hint")}
            onChange={setWallpaperOpacity}
          />

          <WallpaperSlider
            title={t("wallpaper.gradient.title")}
            description={t("wallpaper.gradient.description")}
            minLabel={t("wallpaper.gradient.minLabel")}
            maxLabel={t("wallpaper.gradient.maxLabel")}
            value={wallpaperGradientStrength}
            ariaLabel={t("wallpaper.gradient.ariaLabel")}
            onChange={setWallpaperGradientStrength}
          />

          <WallpaperSlider
            title={t("wallpaper.cloudyGlass.title")}
            description={t("wallpaper.cloudyGlass.description")}
            minLabel={t("wallpaper.cloudyGlass.minLabel")}
            maxLabel={t("wallpaper.cloudyGlass.maxLabel")}
            value={cloudyGlassStrength}
            ariaLabel={t("wallpaper.cloudyGlass.ariaLabel")}
            onChange={setCloudyGlassStrength}
          />
        </div>
      </Card>

      <Card id="settings-target-wallpaper-library">
        <CardIcon icon={ImageIcon} />
        <div className="min-w-0 flex-1 space-y-6">
          <div>
            <div className="font-semibold text-main">{t("wallpaper.library.title")}</div>
            <div className="mt-1 text-xs text-sub">
              {t("wallpaper.library.description")}
            </div>
          </div>

          <div className="profile-overview-glass profile-overview-glass--soft max-w-full rounded-2xl p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-main">{t("wallpaper.upload.title")}</div>
                <div className="mt-1 text-xs text-sub">
                  {t("wallpaper.upload.description", { folderName: wallpaperFolderName })}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                {wallpaperAssetsLoading ? (
                  <span className="text-xs text-sub">{t("wallpaper.upload.loading")}</span>
                ) : (
                  <span className="text-xs text-sub">{t("wallpaper.upload.assetCount", { count: wallpaperAssets.length })}</span>
                )}
                <button
                  type="button"
                  onClick={() => uploadInputRef.current?.click()}
                  disabled={wallpaperUploading}
                  className="inline-flex items-center gap-2 rounded-xl border border-gold/30 bg-gold/15 px-4 py-2 text-sm font-semibold text-gold transition-colors hover:bg-gold/25 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {wallpaperUploading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Upload className="h-4 w-4" />
                  )}
                  {t("wallpaper.upload.button")}
                </button>
                <input
                  ref={uploadInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (!file) return;
                    event.target.value = "";
                    void onUploadWallpaper(file);
                  }}
                />
              </div>
            </div>
          </div>

          <div className="max-w-full overflow-hidden rounded-2xl">
            <div
              className="grid grid-cols-2 gap-3 sm:flex sm:w-full sm:max-w-full sm:gap-4 sm:overflow-x-auto sm:overflow-y-hidden sm:pb-2 sm:pr-3"
              style={{ scrollbarWidth: "thin" }}
            >
              {wallpaperOptions.map((option) => {
                const assignedPages = wallpaperAssignments.filter((assignment) => assignment.value === option.id);

                return (
                  <DropdownMenu key={option.id}>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className="profile-overview-glass profile-overview-glass--soft group w-full shrink-0 overflow-hidden rounded-2xl border text-left transition-all hover:border-white/16 sm:w-[196px]"
                      >
                        <div
                          className="relative h-28 w-full bg-cover bg-center"
                          style={{ backgroundImage: `${option.tint}, url(${option.image})` }}
                        >
                          <div className="absolute inset-0 bg-gradient-to-t from-black/65 via-black/18 to-transparent" />
                          <div className="absolute left-2 top-2 flex max-w-[calc(100%-1rem)] flex-wrap gap-1">
                            {assignedPages.length > 0 ? (
                              assignedPages.map((assignment) => (
                                <span
                                  key={`${option.id}-${assignment.label}`}
                                  className="rounded-full border border-white/10 bg-black/45 px-2 py-0.5 text-[10px] font-semibold text-white/90 backdrop-blur-md"
                                >
                                  {assignment.label}
                                </span>
                              ))
                            ) : (
                              <span className="rounded-full border border-white/10 bg-black/35 px-2 py-0.5 text-[10px] font-semibold text-white/75 backdrop-blur-md">
                                {t("wallpaper.unused")}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="px-3 py-3">
                          <div className="truncate text-sm font-semibold text-main">{option.label}</div>
                          <div className="mt-1 line-clamp-2 text-[11px] text-sub">{option.description}</div>
                        </div>
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="start"
                      className="profile-overview-dropdown-surface w-[280px] rounded-2xl border-white/10 p-1.5 text-main shadow-2xl backdrop-blur-2xl"
                    >
                      <DropdownMenuLabel className="px-3 pb-2 pt-2 text-main">
                        {t("wallpaper.setFor", { name: option.label })}
                      </DropdownMenuLabel>
                      <DropdownMenuSeparator className="bg-white/6" />
                      {wallpaperAssignments.map((assignment) => {
                        const isCurrent = assignment.value === option.id;

                        return (
                          <DropdownMenuItem
                            key={`${option.id}-${assignment.label}-target`}
                            onSelect={() => assignment.onSelect(option.id)}
                            className="flex items-center justify-between rounded-xl px-3 py-3 text-main focus:bg-white/10"
                          >
                            <div className="min-w-0">
                              <div className="text-sm font-medium">{assignment.label}</div>
                              <div className="mt-0.5 text-xs text-sub">{assignment.description}</div>
                            </div>
                            <span
                              className={`ml-3 shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${
                                isCurrent ? "bg-gold text-black" : "bg-white/8 text-sub"
                              }`}
                            >
                              {isCurrent ? t("wallpaper.current") : t("wallpaper.set")}
                            </span>
                          </DropdownMenuItem>
                        );
                      })}
                    </DropdownMenuContent>
                  </DropdownMenu>
                );
              })}
            </div>

            <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-sub/75">
              {wallpaperAssignments.map((assignment) => (
                <span
                  key={`active-${assignment.label}`}
                  className="rounded-full border border-white/8 bg-white/5 px-3 py-1"
                >
                  {assignment.label}: {wallpaperOptions.find((option) => option.id === assignment.value)?.label ?? t("wallpaper.unknown")}
                </span>
              ))}
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

function WallpaperSlider({
  title,
  description,
  minLabel,
  maxLabel,
  value,
  ariaLabel,
  hint,
  onChange,
}: {
  title: string;
  description?: string;
  minLabel: string;
  maxLabel: string;
  value: number;
  ariaLabel: string;
  hint?: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="profile-overview-glass profile-overview-glass--soft rounded-2xl p-4">
      <div>
        <div className="font-semibold text-main">{title}</div>
        {description && <div className="mt-1 text-xs text-sub">{description}</div>}
      </div>

      <div className="mt-4 space-y-3">
        <div className="flex items-center justify-between text-sm">
          <span className="text-sub">{minLabel}</span>
          <span className="font-semibold text-main">{value}%</span>
          <span className="text-sub">{maxLabel}</span>
        </div>
        <input
          type="range"
          min={0}
          max={200}
          step={1}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="h-2 w-full cursor-pointer appearance-none rounded-full bg-white/10 accent-[#C9A25E]"
          aria-label={ariaLabel}
        />
        {hint && <p className="text-[11px] text-sub/70">{hint}</p>}
      </div>
    </div>
  );
}

interface WallpaperOption {
  id: WallpaperChoice;
  label: string;
  image: string;
  tint: string;
  description: string;
}

function buildWallpaperOptions(assets: UserAsset[], t: ReturnType<typeof useTranslation<"settings">>["t"]): WallpaperOption[] {
  const builtIns: WallpaperOption[] = [
    {
      id: "starry-night",
      label: t("wallpaper.presets.starryNight.label"),
      image: "/starry-night-bg.jpg",
      tint: "linear-gradient(to top, rgba(11,15,25,0.78), rgba(18,18,18,0.28))",
      description: t("wallpaper.presets.starryNight.description"),
    },
    {
      id: "library-canvas",
      label: t("wallpaper.presets.libraryCanvas.label"),
      image: "/libary-bg.jpg",
      tint: "linear-gradient(to top, rgba(11,15,25,0.72), rgba(18,18,18,0.22))",
      description: t("wallpaper.presets.libraryCanvas.description"),
    },
  ];

  const custom = assets.map((asset) => ({
    id: `@asset:${asset.id}`,
    label: asset.filename.replace(/\.[^.]+$/, ""),
    image: getAssetCdnUrl(asset.id),
    tint: "linear-gradient(to top, rgba(11,15,25,0.58), rgba(18,18,18,0.18))",
    description: t("wallpaper.presets.uploaded.description"),
  }));

  return [...builtIns, ...custom];
}

function AboutSection() {
  const { t } = useTranslation("settings");
  const router = useRouter();
  const startDm = useStartDm();
  const { features, edition, release } = useEdition();
  // R2: the mail icon becomes a check when the address lands on the clipboard.
  const { copied: emailCopied, copy: copyEmail } = useCopyFeedback();

  const startMessageWithOfficial = useCallback(async () => {
    try {
      await startDm(OFFICIAL_USER_ID);
    } catch {
      // Fall back to opening the public profile so the user can still reach the account
      const href = getUserProfileHref(OFFICIAL_USER_ID);
      if (href) router.navigate({ to: href });
    }
  }, [router, startDm]);

  return (
    <div className="max-w-2xl space-y-8">
      <SectionHeader id="settings-target-about" title={t("about.title")} />

      {/* Contact Support */}
      <div
        id="settings-target-contact-support"
        tabIndex={-1}
        className="scroll-mt-8 space-y-3 rounded-2xl focus:outline-none focus:ring-2 focus:ring-gold/50"
      >
        <div className="profile-overview-glass relative overflow-hidden rounded-2xl p-5 ring-1 ring-cyan-400/20 shadow-[0_0_40px_-15px_rgba(56,189,248,0.45)]">
          <div className="pointer-events-none absolute -top-12 -right-10 h-40 w-40 rounded-full bg-cyan-500/10 blur-3xl" />
          <div className="pointer-events-none absolute -bottom-16 -left-8 h-40 w-40 rounded-full bg-sky-500/10 blur-3xl" />

          <div className="relative flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-cyan-500/15 text-cyan-300 ring-1 ring-cyan-400/30">
              <MessageSquare className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <div className="font-semibold text-main">{t("about.contactSupport")}</div>
                <OfficialBadge size="xs" />
              </div>
            </div>
          </div>

          <div className="relative mt-4 grid gap-2 sm:grid-cols-2">
            {features.dm && (
            <button
              type="button"
              onClick={startMessageWithOfficial}
              className="flex items-center gap-2.5 rounded-xl border border-cyan-400/25 bg-cyan-500/5 px-3.5 py-2.5 text-left transition-colors hover:border-cyan-400/40 hover:bg-cyan-500/10"
            >
              <MessageSquare className="h-4 w-4 shrink-0 text-cyan-300" />
              <div className="min-w-0">
                <div className="text-[13px] font-semibold text-main">
                  {t("about.messageOfficial", { username: `@${OFFICIAL_USERNAME}` })}
                </div>
              </div>
            </button>
            )}

            <a
              href={`mailto:${OFFICIAL_SUPPORT_EMAIL}`}
              onClick={() => {
                // Clipboard may be unavailable; the mailto navigation still fires.
                void copyEmail(OFFICIAL_SUPPORT_EMAIL);
              }}
              className="flex items-center gap-2.5 rounded-xl border border-white/10 bg-white/[0.04] px-3.5 py-2.5 text-left transition-colors hover:border-white/20 hover:bg-white/[0.07]"
            >
              {emailCopied
                ? <Check className="h-4 w-4 shrink-0 text-emerald-300" />
                : <Mail className="h-4 w-4 shrink-0 text-sub" />}
              <div className="min-w-0">
                <div className="text-[13px] font-semibold text-main">{t("about.emailSupport")}</div>
                <div className="text-[11px] text-sub truncate">{OFFICIAL_SUPPORT_EMAIL}</div>
              </div>
            </a>
          </div>
        </div>
      </div>

      <div
        id="settings-target-legal"
        tabIndex={-1}
        className="scroll-mt-8 space-y-3 rounded-xl focus:outline-none focus:ring-2 focus:ring-gold/50"
      >
        <div
          id="settings-target-version"
          tabIndex={-1}
          className="profile-overview-glass profile-overview-glass--soft flex scroll-mt-8 items-center justify-between rounded-xl p-4 focus:outline-none focus:ring-2 focus:ring-gold/50"
        >
          <div>
            <div className="font-semibold text-main">{t("about.version")}</div>
            <div className="mt-0.5 text-xs text-sub">{t("about.versionValue")}</div>
            {/* Edition + release, so a bug report can say exactly what is running. */}
            <div className="mt-1 text-[11px] text-sub/60">
              {edition === "local" ? "Yumina (local)" : "Yumina"} · {release ? release.slice(0, 12) : "dev"}
            </div>
          </div>
        </div>

        <a href={DOCS_URLS.termsOfUse} target="_blank" rel="noopener noreferrer"
          className="profile-overview-glass profile-overview-glass--soft flex items-center justify-between rounded-xl p-4 transition-colors hover:border-white/15">
          <div className="font-semibold text-main">{t("about.termsOfService")}</div>
          <ChevronRight className="h-4 w-4 text-sub/40" />
        </a>

        <a href={DOCS_URLS.privacyPolicy} target="_blank" rel="noopener noreferrer"
          className="profile-overview-glass profile-overview-glass--soft flex items-center justify-between rounded-xl p-4 transition-colors hover:border-white/15">
          <div className="font-semibold text-main">{t("about.privacyPolicy")}</div>
          <ChevronRight className="h-4 w-4 text-sub/40" />
        </a>

        <div className="profile-overview-glass profile-overview-glass--soft rounded-xl p-4">
          <div className="font-semibold text-main">{t("about.licenses")}</div>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Shared UI building blocks
// ============================================================

function Card({ children, id }: { children: React.ReactNode; id?: string }) {
  return (
    <div
      id={id}
      tabIndex={id ? -1 : undefined}
      className="profile-overview-glass profile-overview-glass--soft flex max-w-full scroll-mt-8 gap-4 overflow-hidden rounded-2xl p-5 focus:outline-none focus:ring-2 focus:ring-gold/50"
    >
      {children}
    </div>
  );
}

function CardIcon({ icon: Icon }: { icon: React.ComponentType<{ className?: string }> }) {
  return (
    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gold/10 text-gold">
      <Icon className="h-5 w-5" />
    </div>
  );
}

function DisplaySubsectionHeader({
  icon,
  title,
  className = "",
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  className?: string;
}) {
  return (
    <div className={`grid grid-cols-[2.5rem,minmax(0,1fr)] items-start gap-4 ${className}`}>
      <CardIcon icon={icon} />
      <div className="min-w-0">
        <div className="font-semibold text-main">{title}</div>
      </div>
    </div>
  );
}

function ToggleRow({
  title, description, checked, onChange, id,
}: {
  title: string; description: string; checked: boolean; onChange: (v: boolean) => void; id?: string;
}) {
  return (
    <div
      id={id}
      tabIndex={id ? -1 : undefined}
      className="profile-overview-glass profile-overview-glass--soft grid scroll-mt-8 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 rounded-2xl p-5 focus:outline-none focus:ring-2 focus:ring-gold/50 sm:gap-x-8"
    >
      <div className="min-w-0">
        <div className="font-semibold text-main">{title}</div>
        <div className="mt-1 text-xs text-sub">{description}</div>
      </div>
      <ToggleSwitch checked={checked} onChange={onChange} />
    </div>
  );
}

function PasswordField({
  label, value, onChange, autoComplete,
}: {
  label: string; value: string; onChange: (v: string) => void; autoComplete: string;
}) {
  return (
    <div>
      <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-sub">{label}</div>
      <input
        type="password" value={value} onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        className="profile-overview-input-surface w-full rounded-lg border border-white/10 px-3 py-2 text-sm text-main outline-none focus:border-gold focus:ring-1 focus:ring-gold"
      />
    </div>
  );
}
