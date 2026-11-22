import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { HALLOWEEN_HERO_IMAGE } from "./halloween-panel";
import { halloweenRunning, useHalloweenStore } from "./halloween-store";

export interface HalloweenHeroSlide {
  eventId: string;
  eyebrow: string;
  title: string;
  subtitle: string;
  image: string;
  cta: string;
  onActivate: () => void;
}

/**
 * The home banner's lead slide while the event runs: the poster art, and a
 * click opens the event panel instead of navigating anywhere.
 */
export function useHalloweenHeroSlide(): HalloweenHeroSlide | null {
  const { t } = useTranslation("common");
  const state = useHalloweenStore((s) => s.state);
  const setPanelOpen = useHalloweenStore((s) => s.setPanelOpen);
  return useMemo(() => {
    if (!state || !halloweenRunning(state)) return null;
    const found = Object.keys(state.found ?? {}).length;
    return {
      eventId: "halloween-2026",
      eyebrow: t("halloween.kicker"),
      title: t("halloween.title"),
      subtitle: t("halloween.heroSub"),
      image: HALLOWEEN_HERO_IMAGE,
      cta: state.guest || found === 0 ? t("halloween.heroCta") : found >= 5 ? t("halloween.heroCtaDone") : t("halloween.heroCtaProgress", { found }),
      onActivate: () => setPanelOpen(true),
    };
  }, [state, t, setPanelOpen]);
}
