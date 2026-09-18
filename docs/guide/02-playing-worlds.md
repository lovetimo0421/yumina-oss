# Playing Worlds

## Finding worlds

**Discover** (left nav) is Yumina's world browser. Three tabs at the top:

- **Recommended** -- trending and recommended worlds (default view)
- **Following** -- worlds from creators you follow
- **Bundles** -- asset packs for creators (you can ignore this)

Use the **Filters** button to sort by Recommended / Popular / Newest, filter by tags, and toggle Limitless content visibility.

Click any world card to see the full description, gallery, ratings, and reviews. Hit **Start Playing** to jump in.

## Sessions

Every time you start a world, you create a **session** -- an independent save. You can have multiple sessions for the same world, each with its own story and state. The session picker shows your existing sessions with message count and last played time.

If a world supports multiple languages, language tabs appear at the top of the session picker.

## The chat interface

Once you're in a session:

- **AI messages** are labeled as the narrator (or character names). Hover to see token count and model used.
- **Your messages** go in the input box at the bottom. Enter sends, Shift+Enter adds a new line. You can describe any action -- there are no fixed choices.
- **Game panel** appears on the right if the creator built a custom UI (health bars, inventories, maps, etc.).

### Swiping (regenerating responses)

At the bottom of the last AI message you'll see a `< 1/1 >` control. Click **>** to generate a new response, **<** to go back to a previous version. You can generate several and pick your favorite.

### Message actions

Hover over any message (long-press on mobile) for action buttons:

| Action | What it does |
|--------|-------------|
| **Copy** | Copy message text |
| **Branch from here** | Fork a new session at this message (see below) |
| **Edit** | Modify the message in place |
| **Regenerate** | Re-generate this AI message (only on the last AI message) |
| **Revert to here** | Delete everything after this message (with confirmation) |
| **Delete** | Remove this message (with confirmation) |

### Input box extras

The **+** menu next to the input box:
- **Continue** -- have the AI keep writing without you saying anything
- **Restart Chat** -- clear all messages and start over
- **Attach Image** -- send an image to the AI

### Fullscreen and exit

Most modern worlds run in **fullscreen Custom UI** by default, so there's no top control bar. Move your mouse to the top of the screen (or tap the top edge on mobile) and a small floating bar appears with:

- **Back to library** -- return to your world library
- **Enter/exit fullscreen** -- on desktop you can also press **F11**; pressing **Esc** once also exits

### Exporting chats

Export lives in the **Library** -- open the world detail panel and hit the "Export" button on the session row to download as Markdown or JSON. There's no separate Export button inside the chat anymore.

## Branching

Branching lets you explore "what if" paths without losing your current progress. Click **Branch from here** on any message to fork a new session at that point; the new branch shares the full history up to that message and diverges from there.

The relationships between branches (parent / siblings / children) show up as the full branch tree in the **session switcher**.

## Checkpoints

Checkpoints are save points you create manually. Use the bookmark icon next to the input box to:
- **Save Checkpoint** -- snapshot your current progress
- **Load Checkpoint** -- restore a previous snapshot

Use these before big decisions so you can always come back.

## Multiplayer

Some worlds support multiplayer rooms. If a world supports it, you'll see a **ROOM** button in the library detail panel.

**Creating a room:**
1. Click ROOM on a supported world
2. Choose an AI trigger mode (when the AI responds)
3. Share the invite link with friends

**AI trigger modes:**
- **Host Submit** -- host clicks a button to trigger AI response
- **Timed Response** -- AI responds after a set interval
- **End of Round Response** -- AI responds after everyone has sent a message
- **Instant Response** -- AI responds immediately to any message

**Speech modes** (host can switch):
- **Free speech** -- everyone sends messages freely; AI responds to them all together
- **Turn-based** -- one person at a time, host designates who goes next

**Roles:** Host (full control), Player (can send messages), Spectator (watch only).

## When a world gets taken down

If a creator unpublishes their world, your existing sessions stay. You can read the history and export the chat log, but you can't send new messages.
