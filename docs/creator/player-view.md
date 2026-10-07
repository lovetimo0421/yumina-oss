# Player interface

What the player sees is set on the **Player interface** tab at the top of the blueprint. The tab shows the card as a player opens it; the panel in the top-right edits it, and **Exit** in the top-left returns to the blueprint. Along the top: **Inspect**, **Look**, **Desktop / Phone**.

## Look: theme and layout

**Look** opens a panel in two parts.

**Layout** decides what is on the card: Conversation only, Portrait scene, Adventure HUD, Stat panel, Character sheet. Each one says which variables it adds — "Adventure HUD", for instance, adds location, day, time of day, stamina, energy, inventory and relationships. They are ordinary variables afterwards: visible on the board, editable, drivable by a behaviour.

When you switch layouts, variables the previous layout created, the new one does not use and nothing else references are not deleted behind your back. A pill appears at the bottom — "the previous layout left N variables nothing else uses" — and **Clear them** removes them, undoably. Close the pill to keep them.

**Theme** decides colour, type and corners: no theme (the platform's default look), Paper, Night, Terminal, Blossom. A theme changes only how the card looks, never anything you wrote.

## Inspect: click it, change it

Press **Inspect**, then click any part of the picture — the title, a meter, a button, the input box — and the right panel becomes its editor: text and size, weight, colour, position and dimensions; a meter can also add a status. Once a part is selected, clicking another part switches to it without pressing Inspect again; a click on empty space outside the card puts the selection down; Esc, or closing the panel, hands the card back to itself.

## Desktop and phone

**Desktop** and **Phone** at the top switch the preview width. Each width keeps its own positions and sizes, and you edit the one you are looking at.

## After saving

Save, and the playtest and the player both get this layout and theme. The embedded playtest renders the template without going full screen; when a player opens the card, the full-screen player view is exactly what you see here.
