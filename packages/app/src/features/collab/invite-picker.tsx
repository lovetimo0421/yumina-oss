import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import type { CollabRole } from "./collab-api";
import { RoleMenu } from "./role-menu";

const apiBase = import.meta.env?.VITE_API_URL || "";

export interface InviteCandidate {
  id: string;
  name: string;
  username: string | null;
  image: string | null;
  /** Mutual follow: listed before anyone typed. */
  friend?: boolean;
}

/**
 * Who to invite: your friends right away, anyone by name or @username as you
 * type. People already on the card are left out.
 */
export function InvitePicker({
  excludeIds,
  busyId,
  onInvite,
}: {
  excludeIds: ReadonlySet<string>;
  busyId: string | null;
  onInvite: (person: InviteCandidate, role: CollabRole) => void;
}) {
  const { t } = useTranslation("editor");
  const [query, setQuery] = useState("");
  const [role, setRole] = useState<CollabRole>("editor");
  const [friends, setFriends] = useState<InviteCandidate[]>([]);
  const [results, setResults] = useState<InviteCandidate[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    fetch(`${apiBase}/api/follows/friends`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : { data: [] }))
      // The username shows when the friends list carries one.
      .then((body: { data?: Array<{ id: string; name: string; image: string | null; alias: string | null; username?: string | null; displayUsername?: string | null }> }) =>
        setFriends((body.data ?? []).map((f) => ({ id: f.id, name: f.alias || f.name, username: f.displayUsername || f.username || null, image: f.image, friend: true }))))
      .catch(() => setFriends([]));
  }, []);

  useEffect(() => {
    const q = query.trim().replace(/^@/, "");
    if (!q) { setResults([]); setSearching(false); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`${apiBase}/api/users/search?${new URLSearchParams({ q, limit: "8" })}`, { credentials: "include", signal: controller.signal });
        const body = res.ok ? await res.json() : { data: [] };
        setResults(Array.isArray(body.data) ? body.data.map((u: { id: string; name: string; username?: string | null; displayUsername?: string | null; image?: string | null }) => ({
          id: u.id, name: u.name, username: u.displayUsername || u.username || null, image: u.image ?? null,
        })) : []);
      } catch { /* aborted or offline: keep the last list */ } finally {
        setSearching(false);
      }
    }, 250);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [query]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^@/, "");
    return q
      ? [...friends.filter((f) => f.name.toLowerCase().includes(q) || !!f.username?.toLowerCase().includes(q)), ...results.filter((r) => !friends.some((f) => f.id === r.id))]
      : friends;
  }, [friends, results, query]);
  const shown = useMemo(() => matches.filter((p) => !excludeIds.has(p.id)).slice(0, 8), [matches, excludeIds]);
  const allOnCard = matches.length > 0 && shown.length === 0;

  return (
    <div className="grid gap-2">
      <div className="flex gap-2">
        <input
          id="collab-invite-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("collab.searchPlaceholder", "Name or @username")}
          aria-label={t("collab.searchPlaceholder", "Name or @username")}
          className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary/60"
        />
        <RoleMenu
          value={role}
          options={[
            { value: "editor" as CollabRole, label: t("collab.role.editor", "Can edit") },
            { value: "viewer" as CollabRole, label: t("collab.role.viewer", "Can view") },
          ]}
          onChange={setRole}
          label={t("collab.roleLabel", "Role")}
          className="rounded-lg border border-border px-2.5"
        />
      </div>
      <div className="max-h-56 overflow-y-auto rounded-lg border border-border/60">
        {!query.trim() && shown.length > 0 && (
          <div className="px-3 pt-2 text-[11px] font-medium text-muted-foreground">{t("collab.friends", "Your friends")}</div>
        )}
        {shown.map((person) => (
          <div key={person.id} className="flex items-center gap-3 px-3 py-2 hover:bg-accent/40">
            <Avatar className="h-7 w-7">
              {person.image ? <AvatarImage src={person.image} alt="" /> : null}
              <AvatarFallback className="bg-primary/15 text-[11px] font-semibold text-primary">{person.name.slice(0, 1).toUpperCase()}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm">{person.name}</div>
              {person.username && <div className="truncate text-[11px] text-muted-foreground">@{person.username}</div>}
            </div>
            <button
              type="button"
              disabled={busyId !== null}
              onClick={() => { onInvite(person, role); setQuery(""); }}
              className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs font-semibold text-primary-foreground disabled:opacity-50"
            >
              {busyId === person.id && <Loader2 className="h-3 w-3 animate-spin" />}
              {t("collab.invite", "Invite")}
            </button>
          </div>
        ))}
        {shown.length === 0 && (searching || allOnCard || query.trim()) && (
          <p className="px-3 py-3 text-xs text-muted-foreground">
            {searching ? t("collab.searching", "Searching…")
              : allOnCard ? t("collab.alreadyOnCard", "Already on this card")
              : t("collab.noMatch", "No one by that name")}
          </p>
        )}
      </div>
    </div>
  );
}
