import { useEffect, useState } from "react";
import { useYumina } from "../sandbox-context";

/**
 * <RoomParty />: the people at the table, for a card that draws its own
 * screen. One picture per player (the role's art, else their avatar, else
 * their initial), their role or name under it, a gold ring on whoever has
 * acted this round and dots on whoever is writing. Renders nothing outside a
 * story room, so a card can always include it.
 *
 *   <RoomParty />                          a row of portraits with names
 *   <RoomParty layout="column" size={56} />  a column down the side
 *   <RoomParty showNames={false} />        portraits only
 */
export interface RoomPartyProps {
  layout?: "row" | "column";
  /** Portrait size in px. */
  size?: number;
  showNames?: boolean;
  /** Ring colour for whoever has acted this round. */
  accent?: string;
  className?: string;
  style?: React.CSSProperties;
}

const TYPING_MS = 5_000;

function hueOf(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h % 360;
}

export function RoomParty({ layout = "row", size = 44, showNames = true, accent = "#C9A25E", className, style }: RoomPartyProps) {
  const api = useYumina();
  const room = api.storyRoom;
  const [now, setNow] = useState(() => Date.now());
  const typingAny = !!room && Object.keys(room.typingAt ?? {}).length > 0;
  useEffect(() => {
    if (!typingAny) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [typingAny]);
  if (!room) return null;

  const people = Object.entries(room.people);
  const column = layout === "column";
  return (
    <div
      className={className}
      data-room-party=""
      style={{ display: "flex", flexDirection: column ? "column" : "row", gap: showNames ? (column ? 10 : 12) : 6, alignItems: column ? "stretch" : "flex-start", flexShrink: 0, ...style }}
    >
      {people.map(([id, p]) => {
        const acted = room.actedIds.includes(id);
        const typing = !acted && now - (room.typingAt?.[id] ?? 0) < TYPING_MS;
        const label = p.roleName ?? p.name;
        const hue = hueOf(id);
        return (
          <div
            key={id}
            data-room-person={id}
            style={{ display: "flex", flexDirection: column ? "row" : "column", alignItems: "center", gap: column ? 10 : 4, width: column || !showNames ? undefined : size + 16 }}
          >
            <div style={{ position: "relative", flexShrink: 0 }}>
              {p.image ? (
                <img
                  src={p.image}
                  alt=""
                  draggable={false}
                  style={{ width: size, height: size, borderRadius: size * 0.22, objectFit: "cover", display: "block", boxShadow: acted ? `0 0 0 2px ${accent}` : "0 0 0 1px rgba(255,255,255,0.15)" }}
                />
              ) : (
                <div
                  style={{
                    width: size,
                    height: size,
                    borderRadius: size * 0.22,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontWeight: 700,
                    fontSize: size * 0.42,
                    color: "#F3E3BF",
                    background: `linear-gradient(150deg, hsl(${hue} 32% 34%), hsl(${(hue + 40) % 360} 38% 15%))`,
                    boxShadow: acted ? `0 0 0 2px ${accent}` : "0 0 0 1px rgba(255,255,255,0.15)",
                  }}
                >
                  {Array.from(p.name.trim())[0] ?? "?"}
                </div>
              )}
              {typing && (
                <span
                  style={{ position: "absolute", right: -4, bottom: -4, padding: "0 4px", borderRadius: 8, background: "rgba(0,0,0,0.75)", color: accent, fontSize: 11, fontWeight: 700, lineHeight: "14px" }}
                >
                  …
                </span>
              )}
            </div>
            {showNames && (
              <div style={{ minWidth: 0, textAlign: column ? "left" : "center", lineHeight: 1.2, width: column ? undefined : "100%" }}>
                <div style={{ fontSize: 12, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: acted ? accent : undefined }}>{label}</div>
                {p.roleName && <div style={{ fontSize: 10.5, opacity: 0.65, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
