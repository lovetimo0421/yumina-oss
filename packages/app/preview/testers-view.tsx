/** Development-only harness view: the real tester dialog and Library strip, no account or API. */
import { useEffect, useState } from "react";
import { WorldTestersDialog } from "@/features/friends/world-testers-dialog";
import { TestingWorldsRow } from "@/features/friends/testing-worlds-row";
import { GlobalConfirmDialog } from "@/components/ui/global-confirm-dialog";

const params = new URLSearchParams(location.search);
const names = ["Mika", "Jun Okabe", "Rowan", "Sasha K.", "Ines", "Tobi", "Leila", "Noor", "Wren", "Pax", "Ume", "Dario", "Hana"];
const friends = names.slice(0, Number(params.get("friends") ?? names.length)).map((name, i) => ({ id: `u${i}`, name, image: null, alias: null }));
let testers = friends.slice(0, Number(params.get("testers") ?? 3));
const limit = 10;
const cover = (a: string, b: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="96" height="96" fill="url(#g)"/></svg>`)}`;
const invitedWorlds = [
  { id: "w1", name: "The Lantern Archive", thumbnailUrl: cover("#7a5cff", "#1b1440"), creatorName: "Mika" },
  { id: "w2", name: "Salt and Ash, a very long working title", thumbnailUrl: cover("#e0915a", "#3a1c12"), creatorName: "Jun Okabe" },
];

const reply = (data: unknown, status = 200) => new Response(JSON.stringify(status < 400 ? { data } : data), { status, headers: { "Content-Type": "application/json" } });
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  if (!/\/api\/(follows\/friends|world-testers)/.test(String(input))) return realFetch(input, init);
  const url = String(input);
  const method = init?.method ?? "GET";
  await new Promise((r) => setTimeout(r, 150));
  if (url.includes("/api/follows/friends")) return reply(friends);
  if (url.includes("/api/world-testers/mine")) return reply(params.get("invites") === "0" ? [] : invitedWorlds);
  if (url.includes("/api/world-testers/")) {
    if (method === "POST") {
      const { userId } = JSON.parse(String(init?.body));
      if (testers.length >= limit) return reply({ code: "LIST_FULL" }, 409);
      if (params.get("daily") === "1") return reply({ code: "DAILY_LIMIT" }, 429);
      testers = [...testers, friends.find((f) => f.id === userId)!];
    } else if (method === "DELETE") {
      testers = testers.filter((p) => !url.endsWith(`/${p.id}`));
    }
    return reply({ testers, limit, testable: params.get("testable") !== "0" });
  }
  return reply(null, 404);
};

export function TestersView() {
  const [open, setOpen] = useState(params.get("dialog") !== "0");
  // Dialogs portal to <body>, outside the harness frame that sets the ink colour.
  useEffect(() => {
    document.body.classList.add("text-main");
    return () => document.body.classList.remove("text-main");
  }, []);
  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <TestingWorldsRow />
      <button className="rounded-lg bg-white/10 px-3 py-1.5 text-sm" onClick={() => setOpen(true)}>Open tester list</button>
      <WorldTestersDialog worldId="w0" isOpen={open} onClose={() => setOpen(false)} />
      <GlobalConfirmDialog />
    </div>
  );
}
