import { useEffect, useState } from "react";
import { useUserProfileStore } from "@/stores/user-profile";
import { useFeature } from "@/edition/edition";
import type { Persona } from "@/stores/personas";
import { PersonaCarousel } from "@/features/personas/persona-carousel";
import { PersonaEditModal } from "@/features/personas/persona-edit-modal";
import { GlobalPrompts } from "@/features/configs/global-prompts";
import { ProfileIdentityHeader } from "./sections/profile-identity-header";
import { ProfileAiSettings } from "./sections/profile-ai-settings";
import { ExtensionsSection } from "./sections/extensions-section";
import { RecentlyPlayed } from "./sections/recently-played";

/**
 * `/app/profile` in the local (open-source) edition.
 *
 * The hosted profile with the platform removed: no wall, followers, badges,
 * ledger or stats — but the same own-account sections, in the same order,
 * rendered by the same components (features/account/sections): the avatar
 * and display name, AI Settings, personas, extensions, recently played and
 * custom prompts. Each section already hides its hosted bits behind
 * `useFeature(...)` and the edition slots.
 */
export function LocalProfilePage() {
  const { fetchProfile } = useUserProfileStore();
  const hasExtensions = useFeature("extensions");
  const [editingPersona, setEditingPersona] = useState<Persona | null | undefined>(undefined);

  useEffect(() => {
    void fetchProfile();
  }, [fetchProfile]);

  return (
    <div data-scroll-restoration-id="local-profile" className="h-full overflow-y-auto">
      <PersonaEditModal
        isOpen={editingPersona !== undefined}
        onClose={() => setEditingPersona(undefined)}
        persona={editingPersona ?? null}
      />

      <div className="mx-auto w-full max-w-[1000px] px-4 py-8 sm:px-8 sm:py-10">
        {/* 0. Avatar + display name */}
        <ProfileIdentityHeader />

        {/* Sections stacked in the hosted order, minus the platform ones. */}
        <div className="space-y-10 pb-20">
          {/* 1. AI Settings (no plan / wallet block without billing) */}
          <ProfileAiSettings />

          {/* 2. Personas */}
          <PersonaCarousel onEdit={(persona) => setEditingPersona(persona)} />

          {/* 3. Extensions */}
          {hasExtensions && <ExtensionsSection />}

          {/* 4. Recently Played (from this user's own sessions) */}
          <RecentlyPlayed />

          {/* 5. Custom Prompts */}
          <GlobalPrompts />
        </div>
      </div>
    </div>
  );
}
