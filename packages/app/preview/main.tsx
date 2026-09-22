/**
 * Static UI preview harness — NOT part of the shipped app.
 *
 * Renders the real plans page and the real AI settings tab against seeded
 * Zustand state and a memory router, so a design change can be looked at
 * without a database, an account, or a running API. Build it with:
 *
 *   pnpm --filter @yumina/app preview:ui
 *
 * and open the emitted index.html straight off disk.
 *
 * Query string: ?lang=zh|en|ja|es|zh-Hant  ?plan=free|go|plus|pro|ultra
 *               ?lineup=1|2  ?view=plans|settings|profile
 */
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";

import "./preview.css";
import "@/lib/i18n";

import { useCreditStore, type LineupV2Plan } from "@/stores/credits";
import { PlansPage } from "@/features/plans/plans-page";
import { AiConfigTab } from "@/features/settings/ai-config-tab";
import { ProfilePlanSummary } from "@/features/profile/profile-plan-summary";

const params = new URLSearchParams(window.location.search);
const PLAN = params.get("plan") ?? "plus";
const LINEUP = params.get("lineup") === "1" ? 1 : 2;

// ── Seeded wallet ─────────────────────────────────────────────────────────
// Mirrors what the server sends a version-2 Platinum subscriber, taken from
// packages/server/src/lib/plan-config-v2.ts so the preview cannot show
// numbers the product does not actually pay.
const lineup: Record<string, LineupV2Plan> = {
  free: { monthlyCredits: 1000, drops: [{ day: 0, amount: 700 }, { day: 7, amount: 100 }, { day: 14, amount: 100 }, { day: 21, amount: 100 }], questMonthlyCap: 1000, questMaxTotal: 1000, inviteMonthlyMax: 1200, packBonusPct: 0 },
  go: { monthlyCredits: 3200, drops: [{ day: 0, amount: 1600 }, { day: 10, amount: 800 }, { day: 20, amount: 800 }], questMonthlyCap: 2000, questMaxTotal: 2000, inviteMonthlyMax: 1200, packBonusPct: 10 },
  plus: { monthlyCredits: 13600, drops: [{ day: 0, amount: 6800 }, { day: 10, amount: 3400 }, { day: 20, amount: 3400 }], questMonthlyCap: 2800, questMaxTotal: 5300, inviteMonthlyMax: 1200, packBonusPct: 15 },
  pro: { monthlyCredits: 40000, drops: [{ day: 0, amount: 20000 }, { day: 10, amount: 10000 }, { day: 20, amount: 10000 }], questMonthlyCap: 5000, questMaxTotal: 10500, inviteMonthlyMax: 1200, packBonusPct: 20 },
  ultra: { monthlyCredits: 88000, drops: [{ day: 0, amount: 44000 }, { day: 10, amount: 22000 }, { day: 20, amount: 22000 }], questMonthlyCap: 7000, questMaxTotal: 17500, inviteMonthlyMax: 1200, packBonusPct: 25 },
};

/** Legacy lineup: the same board, per-tier caps including the forge rungs. */
const questCaps: Record<string, number> = { free: 1000, go: 2000, plus: 5300, pro: 10500, ultra: 17500 };

const noop = async () => {};

useCreditStore.setState({
  planVersion: LINEUP,
  rewards: "quests",
  lineup: LINEUP === 2 ? lineup : null,
  questCaps,
  plan: PLAN,
  basePlan: PLAN,
  balance: 8420,
  addonBalance: 1250,
  monthlyCredits: lineup[PLAN]?.monthlyCredits ?? 13600,
  hasSubscription: PLAN !== "free",
  subscriptionSource: PLAN === "free" ? null : "stripe",
  periodEnd: new Date(Date.now() + 18 * 86_400_000).toISOString(),
  provider: "official",
  // Free and Gold are the tiers that carry a lorebook ceiling; above that the
  // world is never trimmed and the settings tab shows no cap chip.
  memoryCap: PLAN === "free" ? 64_000 : PLAN === "go" ? 96_000 : null,
  freeOfferMonthly: 1000,
  // The profile block renders the real wallet, which needs a real breakdown.
  breakdown: {
    version: 1,
    planVersion: LINEUP,
    nextDrop: LINEUP === 2 ? { amount: 3400, at: new Date(Date.now() + 4 * 86_400_000).toISOString() } : null,
    total: 9670,
    monthly: 8420,
    bonus: 450,
    saved: 800,
    monthlyResetsAt: new Date(Date.now() + 18 * 86_400_000).toISOString(),
    groups: [{ id: "lot1", amount: 450, origin: "quest", expiresAt: new Date(Date.now() + 6 * 86_400_000).toISOString() }],
    policy: { reducedCycle: false, reducedCheckins: false, checkinsChangeAt: null, cycleChangeAt: null },
  },
  loading: false,
  lastFetched: Date.now(),
  // Nothing in a static preview may reach the network.
  fetchCredits: noop,
  forceFetchCredits: noop,
});

// ── Chrome ────────────────────────────────────────────────────────────────
type View = "plans" | "settings" | "profile";
const VIEWS: View[] = ["plans", "settings", "profile"];
const VIEW_LABEL: Record<View, string> = { plans: "Plans", settings: "AI settings", profile: "Profile card" };

function Frame() {
  const [tab, setTab] = useState<View>(() => {
    const requested = params.get("view") as View | null;
    return requested && VIEWS.includes(requested) ? requested : "plans";
  });
  return (
    <div className="min-h-screen bg-page text-main">
      <div className="sticky top-0 z-50 flex items-center gap-2 border-b border-white/[0.06] bg-black/60 px-4 py-2 backdrop-blur">
        <span className="mr-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground/40">
          UI preview
        </span>
        {VIEWS.map((k) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`rounded-lg px-3 py-1 text-xs transition-colors ${
              tab === k
                ? "bg-white/[0.08] text-foreground"
                : "text-muted-foreground/50 hover:text-foreground/80"
            }`}
          >
            {VIEW_LABEL[k]}
          </button>
        ))}
        <span className="ml-auto text-[10px] text-muted-foreground/30">
          plan={PLAN} · lineup={LINEUP} · add ?plan=pro&amp;lang=zh
        </span>
      </div>
      {tab === "plans" && <PlansPage />}
      {tab === "settings" && (
        <div className="mx-auto max-w-2xl px-4 py-8">
          <AiConfigTab />
        </div>
      )}
      {tab === "profile" && (
        <div className="mx-auto max-w-md px-4 py-8">
          <div className="overflow-hidden rounded-2xl border border-white/[0.06] bg-white/[0.02]">
            <ProfilePlanSummary />
          </div>
        </div>
      )}
    </div>
  );
}

// PlansPage calls useSearch({ from: "/app/plans" }), so the harness needs a
// route at exactly that path. A memory history keeps the URL untouched.
const rootRoute = createRootRoute({ component: () => <Outlet /> });
const plansRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app/plans",
  component: Frame,
  validateSearch: (s: Record<string, unknown>) => s,
});
const router = createRouter({
  routeTree: rootRoute.addChildren([plansRoute]),
  history: createMemoryHistory({ initialEntries: ["/app/plans"] }),
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
