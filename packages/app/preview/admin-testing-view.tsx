/** Development-only harness view: the real moderation page with its In testing tab, on mock data. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AdminModerationPage } from "@/features/admin/admin-moderation-page";
import { GlobalConfirmDialog } from "@/components/ui/global-confirm-dialog";

const cover = (a: string, b: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="128"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="96" height="128" fill="url(#g)"/></svg>`)}`;
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const people = ["Mika", "Jun Okabe", "Rowan", "Sasha K.", "Ines", "Tobi", "Leila", "Noor", "Wren", "Pax"];
const testers = (n: number, minutes: number) => people.slice(0, n).map((name, i) => ({ id: `t${i}`, name, image: null, invitedAt: ago(minutes + i * 40) }));
let cards = [
  { worldId: "w3", groupKey: "w3", name: "Salt and Ash", thumbnailUrl: cover("#e0915a", "#3a1c12"), status: "rejected", limitless: true, openReports: 2, creator: { id: "c2", name: "Dario", image: null, isBanned: false }, lastInvitedAt: ago(190), testers: testers(8, 190) },
  { worldId: "w1", groupKey: "w1", name: "The Lantern Archive", thumbnailUrl: cover("#7a5cff", "#1b1440"), status: "draft", limitless: false, openReports: 0, creator: { id: "c1", name: "Hana", image: null, isBanned: false }, lastInvitedAt: ago(12), testers: testers(3, 12) },
  { worldId: "w2", groupKey: "w2", name: "Night Market, a very long working title that keeps going", thumbnailUrl: null, status: "pending_review", limitless: false, openReports: 0, creator: { id: "c3", name: "Ume", image: null, isBanned: false }, lastInvitedAt: ago(1500), testers: testers(10, 1500) },
  { worldId: "w4", groupKey: "w4", name: "Glass Harbor", thumbnailUrl: cover("#4fb3a5", "#0e2a2c"), status: "unpublished", limitless: false, openReports: 0, creator: { id: "c4", name: "Pax", image: null, isBanned: false }, lastInvitedAt: ago(4300), testers: testers(1, 4300) },
];
const reply = (data: unknown) => new Response(JSON.stringify({ data }), { headers: { "Content-Type": "application/json" } });
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = String(input);
  if (url.includes("/api/world-testers/admin/testing")) return reply(new URLSearchParams(location.search).get("empty") ? [] : cards);
  if (url.includes("/api/admin/moderation/ai-summary")) return reply({ waitingForYou: 4, checking: 1, aiApproved7d: 212, aiSentToYou7d: 19, enabled: true });
  if (url.includes("/api/admin/moderation/queue")) return reply([]);
  if (url.includes("/api/admin/reports/world/")) {
    cards = cards.filter((card) => !url.includes(`/world/${card.worldId}/`));
    return reply({ action: "unpublish" });
  }
  return realFetch(input, init);
};

const client = new QueryClient();
export function AdminTestingView() {
  return (
    <QueryClientProvider client={client}>
      <div className="px-6 py-8"><AdminModerationPage /></div>
      <GlobalConfirmDialog />
    </QueryClientProvider>
  );
}
