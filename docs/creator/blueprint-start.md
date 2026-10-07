# Build your story on the blueprint

The blueprint is another way of looking at the editor: the whole card laid out on one board, every module a tile, and inside each tile a list of openings, settings, variables and behaviours, one per row. It is experimental for now. Open it from the menu in the top-right of the classic editor, **Blueprint · experimental**, and the arrow in the top-left takes you back. Both edit the same card.

The first time in you meet Mushie. **Start on the blueprint** is the 7-step tutorial; **I'll explore on my own** skips it, and **Learn blueprint** in the top bar brings it back whenever you want.

## 1. The board is a table of contents; the right column is where you write

The board shows names and a one-line preview, never the text itself. Click any row — the opening, a setting, a variable — and the right column becomes its editor. Click elsewhere or press Esc to put it away. The tile on the left is the cover and card details; the tile on the right, **Card content**, is the card itself: the first module, and every module you add later looks the same.


Set up two covers in Overview: a 2:3 portrait for phone cards and Library covers, and a 16:9 landscape for desktop Discover and opened Library details. Each has its own image and crop. Upload each separately, or reuse the portrait and confirm a landscape crop. If the landscape slot is empty, choose an upload or portrait reuse. Changing one crop leaves the other unchanged.

Check the title, creator avatar, save control and statistics area in the preview so faces stay clear. Statistics are placeholders, not actual counts. Featured slot previews show typical desktop and phone framing; cards adapt to screen width. Check each language version separately. Administrators can adjust its portrait and landscape crops in **Manage → Artwork** without changing the originals.

Drag empty space to pan, zoom with the + and − in the bottom-left, and **Fit everything** brings the whole board back.

## 2. Write the opening and a setting

A new card already has an opening and a **Character & world setting** tile; they are the two brightest things on the board. Click the opening row, write two or three sentences in the right column, and leave a question for the player:

> The lighthouse goes dark. A keeper knocks on your door, holding an old letter. "This is my handwriting. Where did you find it?"

Then click the **Setting** row and say who the AI plays and where the story is. Each setting's editor ends with **Adjust when this is used**: always on, by keyword, by condition. Keep the defaults on a new card.

## 3. The toolbar

Along the top of the board:

- **Add content** — opening, setting, variable, behaviour, interface, module, backstage writer. What you add lands in its tile, and the right column opens on it.
- **Wires** — who writes a variable, what gates an entry, where a behaviour chains to. They light up when you point at a row; click once to keep them all on. The palette icon beside it is the colour legend.
- **Detail / Simple** — simple mode keeps names only, for reading the shape of a card.
- **Modules** — appears once the card has modules. Lists them all; click one to focus it. **Open all** and **Shut all** at the top are what a card with twenty modules lives on.
- **Search** — names, text, ids. Enter jumps to the first hit and opens it.
- The speech-bubble icon is the **context estimate**: roughly how many tokens this card sends the AI each turn.

## 4. Selecting several rows

Hold Shift or Ctrl and click rows to pick up several; or hold Shift and drag a box on empty canvas, and every row inside it is selected. A bar appears at the bottom: **Move to…** puts them all into one module (or back to the card, shared), **Delete** removes them together. With a single row selected, Delete removes it, and Ctrl+Z brings it back.

## 5. Modules

A module is a place: a dungeon, a chapter, a branch. **Add content → Module** puts a new tile on the board with its own openings, settings, variables and behaviours inside. Whatever belongs to the card applies in every module too, so a module shows only a *shared* count rather than drawing the card's rows again. Click a tile's title for its settings: name, note, and when it opens (always, by keyword, by condition, bound to an opening, manual). A tile collapses to a small square when you are not working in it.

A module can also run its own AI with its own memory — see [Modules](/creator/modules).

## 6. Saving and playing

Changes autosave to the draft; the word **Unsaved** in the top bar is a button, and clicking it saves right away. Saving never publishes; publishing is under **Not live** in the top-right.

For a new submission, both the portrait and landscape artwork must be present and both fill crops confirmed in Overview. Existing published cards remain accessible even if they do not yet have dedicated landscape artwork.

**Play** at the top turns the right column into a playtest while the board stays on the left. Send a line, read the reply, and **Edit** takes you back to the board. While a playtest runs, the board shows live values and marks each module active or dormant. If a reply fails, read the notice first — usually no model chosen, or no credit — rather than sending again.

## 7. On a phone

A phone gets the content panels (opening, knowledge, test). You can edit and playtest there, but the full board, panning and wires need a wider screen.

What the player sees is set on the **Player interface** tab at the top: themes, layouts, and an inspector that edits whatever you click — see [Player interface](/creator/player-view).
