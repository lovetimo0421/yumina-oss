---
name: multiplayer
description: Let friends play one card together (联机). Story mode (一起讲故事, the card's AI narrates merged rounds, optional roles) or rules mode (按规则对局, a pure rules file runs the game on the server, the card's interface is the table, empty seats can be AI). Use when the creator wants a card friends can play together, a party game, a board/card game table, PvP, roles for several players, a rules file, AI seats, or check_rules.
---

# Skill: Multiplayer (联机)

A card is single-player until its author turns multiplayer on. Off, the card shows no multiplayer entry anywhere. On, the card page and the chat menu offer 和好友一起玩 and friends join by invite (friends list, link or short code; nobody can wander in).

The setting is `update_settings({ multiplayer: {...} })`:

```json
{ "enabled": true, "mode": "story", "minSeats": 2, "maxSeats": 6,
  "roles": [{ "name": "骑士", "entryId": "knight", "note": "守城门的人" }], "rolesRequired": false }
{ "enabled": true, "mode": "rules", "minSeats": 2, "maxSeats": 4, "rulesFile": "rules.js",
  "ai": { "names": ["老崩", "素梨"], "model": "<catalog model id>" } }
```

- Seats: 2 to 12; default 2 to 6. Only the keys you pass change; `multiplayer: null` turns it off and keeps the rest.
- Who pays is the host's choice per room: the host treats (pays every AI call), or the room splits each story round equally among the players who acted in it (public rooms default to split). AI seat moves in a rules game are the host's. Adult cards: every player must be 18+ with their birth year on file.
- A story room lives as long as its host: the host leaving, or being gone over 2 minutes, closes it. On a published card, players can open public rooms that anyone can join from the card page. These are platform features; the card does nothing for them.
- Ask the creator before turning it on; never turn it on as a side effect of other work.

## Story or rules: which one

| The card is... | Mode |
|---|---|
| A story, adventure, RP, TRPG-style scene: the AI is the narrator / GM | `story` |
| A game with exact rules a computer can judge: cards, board, bluffing, voting, dice, a race | `rules` |

Story mode needs no code: the existing card works as it is, read by several people. Rules mode needs a rules file and an interface that draws the table. If the creator wants both (an AI narrator on top of a rules game), build the rules game; the card's interface can still call the AI for flavour.

## Story mode (一起讲故事)

How a round works: the host's session is shared. Every player types what they do; the actions wait in a round strip until everyone is ready, the merge window runs out (auto) or the host presses send (host mode). Then they reach the AI as ONE user turn, one line per action, oldest first:

```
[Mira · 骑士]: I hold the gate and shout for the others.
[Tao]: I slip around the back of the inn.
```

`Name · Role` when that player holds a role, `Name` when not. The first round of a room, and the first round after someone joins, leaves or changes role, also carries one roster line naming every player and the role they hold. The reply streams to everyone. Variables, behaviors and the interface run as in a single-player session, on the host's session.

A card with its own interface keeps it: every player sees it, and it runs on the host's session. The card's own input works for everyone: `api.sendMessage(text)` joins the round as that player's action. Every player's presses on the interface (`api.setVariable`, actions) change the shared game and every screen follows; a clock (`every N seconds` behaviors) runs for the host only. The platform shows the round in a thin strip above the interface, so the card needs no round UI of its own. `api.room.invite()` (no roomId, from a click) opens this chat's invite sheet.

To show the party inside a card's own interface, drop in `<RoomParty />` (see the tsx skill): it draws every player's picture and role and rings whoever acted, and renders nothing outside a room. For anything it does not cover, read `api.storyRoom` yourself; it is the room, or null outside one:
- `people[userId]` = `{ name, image, roleName }`; `image` is the role's picture (else the player's avatar, else null).
- `meId`, `isHost`; `actedIds` (acted this round, in order), `typingAt[userId]` (epoch ms of their last keystroke).
- `round.status` = `idle | counting | held | writing | failed | waiting`; `round.dueAt` (epoch ms) while counting, with `round.windowMs`.
- `talk`: the players-only lines, oldest first (the AI never sees them).

```tsx
const room = api.storyRoom;
{room && Object.entries(room.people).map(([id, p]) => (
  <div key={id} className={room.actedIds.includes(id) ? "ring-2 ring-amber-400" : ""}>
    {p.image ? <img src={p.image} /> : <span>{p.name[0]}</span>}
    <span>{p.roleName ?? p.name}</span>
  </div>
))}
```

Roles (optional): `roles` are the parts a joiner can pick. `entryId` links a character entry, so the AI knows that character is now a person. `image` (`@asset:` ref) is the role's picture on the join page and in the party; a linked character's portrait is used when it has none. Give every role a picture when the card has art for it: players pick roles by their pictures. `rolesRequired: true` makes joiners pick a free role (a table then fills at the number of roles). Without roles, everyone plays themselves.

Writing entries for several players:
- Address the players by the names in the `[Name]` lines; never assume one {{user}}. {{user}} is the host.
- Tell the narrator (a system-presets entry) to answer every line of the round, give each player a beat, keep scenes together unless players split up, and never act or speak for a character a player holds.
- A role's character entry describes the character (look, ties, what they know), not how the AI should play them.
- Per-player state: one `json` variable keyed by player name (`players.Mira.hp`), see the variables skill. Shared state stays in ordinary variables.
- Keep replies a little longer than single-player, but cap them: several people wait on each one.

## Rules mode (按规则对局)

The game's rules live in one plain JS file among the interface files (e.g. `rules.js`). The game server (game-rt) runs it in a sandbox for every table: it is the only judge of what happened, every seat sees only its own `view`, and AI seats are played server-side by a model the host pays for.

### The rules file

```js
module.exports = {          // or: export default { ... }
  minSeats: 2, maxSeats: 4, // the file's own range; the card's setting narrows it

  setup(seats, opts, rng) { /* seats: [{ id, name, ai }] in seat order; opts from the host's start command */ return state; },
  turn(state)  { return { seats: ["<seat id>", ...], deadlineMs: 30000 }; /* or null = game over */ },
  legal(state, seat) { return ["keep", "swap"]; /* a list of moves, or any hint object */ },
  apply(state, seat, action, rng) { /* validate! */ return { state, events: [{ to: ["<seat id>"], name: "your-card", body: {...} }] }; /* or { error: "bad-move" } */ },
  timeout(state, seat, rng) { return "keep"; /* the move made for a seat whose deadline passed */ },
  view(state, seat) { /* what this seat may see; seat === null is a spectator */ return {...}; },
  result(state) { return { winners: ["<seat id>"], summary: "..." }; /* or null while playing */ },
  aiPrompt(view, seat) { return "How to play well, in a few lines"; },
};
```

Required: `setup`, `turn`, `apply`, `view`, `minSeats`, `maxSeats`. The rest is optional but expected: without `timeout()` a deadline plays a random move from `legal()`, which then has to be a list; without `result()` the end screen has no winners.

Rules for the file:
- Pure: no timers, fetch, DOM, console or clock. State in, state out. `state` must be plain JSON (no functions, Maps, Dates, undefined in arrays), under 1 MB.
- Random only through the `rng` argument (setup, apply, timeout). `Math.random` is the same seeded stream, so a replay is identical.
- Each call has 250 ms and the sandbox 24 MB. A file is at most 256 KB.
- `apply` must validate everything: the seat, the phase, the move's shape. Anything a client can send will be sent. Return `{ error }` and leave the state as it was.
- `turn()` names who may move now: one seat for turn order, several for simultaneous moves (votes, sealed bids). Give `deadlineMs` whenever a person is on turn (1 s to 1 h), or a player who walks away stalls the table.
- Seat ids: people's ids are their account ids, AI seats are `ai-1`, `ai-2`... Never show raw ids; use the `name` from setup.
- Hidden information lives in `state` and only reaches a seat through `view(state, seat)`. Each seat's view holds its own secrets and the public facts, nothing else. Reveals (the showdown, the end of the game) are part of the view once they happen. `events` with `to` reach only those seats; events without `to` reach everyone, so never put secrets there.
- A person who is kicked mid-game keeps their seat as an AI seat, so every seat must be playable from `view` + `legal`.

### AI seats

For an AI seat on turn the server sends the model: the seat's `view`, `legal(state, seat)`, and `aiPrompt(view, seat)` (cut at 4000 characters). The model must reply with JSON only: `{"action": <move>}`. If `legal` returned a non-empty list, the action must be exactly one of its items. A move that fails (bad JSON, illegal, `apply` refused it, a timeout) falls back to `timeout()`, then to a random `legal()` move. An AI seat's view must stay under 24,000 characters and `legal` under 8,000.

Write `aiPrompt` as the rules in a few lines, what the view's fields mean, and a sensible strategy. If `legal` is a hint object rather than a list, put the exact move shape in `aiPrompt` (e.g. `{"action":{"type":"play","cards":[0,2]}}`). AI seat names and the model come from `multiplayer.ai`.

### The card's interface (the table)

A table is a room `rules:<CODE>` on game-rt (CODE = 2 to 10 letters/digits the card makes up). The first person to join creates it and is the host; the host pays.

```tsx
const api = useYumina();
const r = await api.room.join("rules:" + code);       // { ok, seatId, snap } or { ok: false, reason }
const off = api.room.onFrame((f) => {
  if (f.t === "snap") setTable(f.body);                // see below
  if (f.t === "event") onEvent(f.name, f.body);        // events from apply()
  if (f.t === "bye") leaveScreen(f.reason);            // e.g. "kicked"
});
await api.room.sendCommand("addAi", { name: "素梨" }); // host, before start
await api.room.sendCommand("removeAi", { seatId });    // host, before start
await api.room.sendCommand("start", { aiSeats: 0, opts: { target: 3 } }); // host: setup() runs
await api.room.act({ type: "play", cards: [0, 2] });   // same as sendCommand("act", { action })
await api.room.sendCommand("kick", { seatId });        // host
await api.room.sendCommand("sync");                    // ask for a fresh snapshot
api.room.invite({ roomId: "rules:" + code });          // the platform's invite sheet: friends, link, code (call it from a click)
const invited = await api.room.pendingTable();         // on load: the table code this player was invited to, read once, or null
api.room.leave();
```

Every change sends each seat its own snapshot frame:

```
{ t: "snap", tick, body: { kind: "rules", phase: "lobby" | "play" | "over", you, host,
  seats: [{ id, name, ai, online }], turn: { seats, deadlineAt } | null, view, result, error? } }
```

`you` is your seat id (null for a spectator, e.g. someone who joined after the start). `view` is `view(state, you)`; it is null in the lobby. `turn.deadlineAt` is an epoch ms for a countdown. A command answers `{ ok: false, reason }` on refusal (`not-your-turn`, `host-only`, `not-enough-seats`, `already-started`, or the `error` your `apply` returned): show the reason as one short line.

Build the lobby (seats, add/remove AI, start, an invite button), the table drawn from `view`, and the end screen from `result`. The invite link opens the card's page with the table code; when the friend presses Play, `pendingTable()` returns it: join that table instead of showing the lobby. Joining with a code nobody uses creates an empty table with you as host: if that was a typo, leave and say there is no such table.

## Workflow

1. Story mode: write or adjust the entries for several players, then `update_settings({ multiplayer: { enabled: true, mode: "story", ... } })`.
2. Rules mode:
   1. Write the rules file with `write_custom_ui` (path e.g. `rules.js`).
   2. `check_rules` (free): plays 200 random games in the server's sandbox and reports games finished, the longest game, errors with their phase, junk moves rejected, the rules' own moves `apply` refused, possible leaks (one seat's view showing another seat's hidden data) and the largest view / aiPrompt sizes. Fix every error and leak and run it again until it is clean.
   3. Build the table in the interface (the section above).
   4. `update_settings({ multiplayer: { enabled: true, mode: "rules", rulesFile: "rules.js", minSeats, maxSeats } })`. It is refused until the file exists.
3. Tell the creator to try a table with a friend (or a second account) and AI seats. The assistant's `playtest` plays the story alone; it cannot sit at a multiplayer table.

`check_rules` cannot judge whether the game is fun, whether the AI seats play well, or what a person may legitimately learn (a peek power, a partner's role): read each reported leak's key and view before changing the rules.
