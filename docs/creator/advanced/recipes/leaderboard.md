---
title: "Leaderboards"
description: "Give a card its own high-score boards with api.leaderboard: the platform stores scores and ranks them, and the card draws the board."
---
<div v-pre>

# Leaderboards

Give your card a high-score board, the way Steam games do it: the card names a board and submits scores, and the platform keeps each player's best and ranks them. **The board looks however the card draws it**: where it sits, its colors, fonts, avatars, trophies and the animation when you place. The platform never adds a board of its own outside the card.

It fits any card with a score, a time, a streak or a floor reached: pinball, runners, quizzes, days survived, puzzle times.

## Ask the Studio assistant

The easiest way is to just say it, for example:

- "Add a leaderboard that shows my rank and the top ten when a run ends"
- "Make a fastest-clear board, quickest first, and show it on the title screen too"
- "Add a friends tab to the board, with gold, silver and bronze for the top three"

The assistant writes the submit and read code and draws the board to match the card's current look. To change how it looks, ask the way you would for any other part of the interface.

## Writing it yourself

In interface code (**Panels → Interface code**), get `api` from `useYumina()`:

- `api.leaderboard.submit(board, score, { details?, order? })`: submit when a run ends. Each player keeps only their best per board; it returns `{ ok, best, rank, total, improved }`.
- `api.leaderboard.get(board, { range?, limit? })`: read the board. `range` is `"top"`, `"around"` (the places around you) or `"friends"` (you and your friends). Each row is `{ rank, name, image, score, details, me }`; the row with `me: true` is the player. `board.me` is the player's own place even when it is not on this page.

```tsx
const BOARD = "High score";

export default function Game() {
  const api = useYumina();
  const [range, setRange] = React.useState("top");
  const [board, setBoard] = React.useState(null);
  const [result, setResult] = React.useState(null);

  const load = React.useCallback(async (r) => {
    setBoard(await api.leaderboard.get(BOARD, { range: r, limit: 10 }));
  }, [api]);
  React.useEffect(() => { void load(range); }, [range, load]);

  // call this when a run ends
  const finish = async (score) => {
    const r = await api.leaderboard.submit(BOARD, score, { details: { hero: "steel ball" } });
    setResult(r);           // { ok, best, rank, total, improved }
    void load(range);
  };

  return (
    <div>
      {/* The board looks however you draw it: colors, fonts, avatars, trophies and animations all follow the card */}
      {result?.ok && <div>{result.improved ? "New record!" : `Your best ${result.best}`} · #{result.rank} / {result.total}</div>}
      {["top", "around", "friends"].map((r) => <button key={r} onClick={() => setRange(r)}>{r}</button>)}
      {board?.ok && board.entries.map((e) => (
        <div key={e.rank + e.name} style={{ fontWeight: e.me ? 800 : 400 }}>
          {e.rank}. {e.name} {e.score}
        </div>
      ))}
      {board && !board.ok && board.reason === "sign-in" && <div>Sign in to join the board</div>}
    </div>
  );
}
```

## Design tips

- **Show it where the run ends**: the score, whether it's a new record, and the rank. A small board on the title screen works too.
- **Highlight the player's row** (`me`). When they are outside the top ten, add a line below with `board.me`.
- **Use `details` for small notes next to a score**: which character, which level, taps per second. Up to 500 characters of JSON.
- **For lower-is-better boards** (times, moves), pass `{ order: "asc" }` with the first score; that board sorts low to high from then on.
- **Guests** get `{ ok: false, reason: "sign-in" }`. Show "Sign in to join the board" and keep the game going.
- A card can have several boards, say "High score" and "Fastest clear", up to 20.

## Rules

- Every language version of a card shares the same boards.
- A player can submit 30 times a minute; board names are 1 to 40 characters; scores stay within ±1e15.
- Only published cards have live boards; the author can also test on their own unpublished card.
- Scores are computed by the card in the player's browser, so don't hand out rewards or prizes by rank.
- The Studio preview shows a sample board so you can check the layout; the real board appears when you play.

Method signatures are in the [API Reference](../08-api-reference.md).

</div>
