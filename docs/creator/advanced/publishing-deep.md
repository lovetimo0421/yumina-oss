---
title: "Bundles, forking and export"
description: "How others fork your card, how to bundle one system (variables, behaviors, interface, audio) for another card, and what the full JSON export contains."
---
# Bundles, forking and export

Publishing itself is on [Publishing](/creator/publishing). This page is about the three ways a card leaves your account in parts or whole: others making editable copies, bundles that carry one system into another card, and the full JSON export.

## Forking

When a world is published and allows derivative works, other users can make their own copy:

1. A complete copy is created, owned by the forker
2. The name is auto-incremented: if the original is "Dark Forest," your copy is "Dark Forest (1)"; fork again and it's "Dark Forest (2)"
3. The copy starts as a draft and isn't published automatically
4. Preserves all original tags, description, cover, schema, and content
5. Original world's `downloadCount` increases by 1
6. The copy's `sourceWorldId` points back to the original for traceability
7. Any referenced assets (like images) are copied over too

## Bundles

Say you spent two weeks building a polished combat system: variables, behaviors, interface, sound effects. A friend is building a world and needs a combat system. You don't need to give them your whole world. **Bundle** the combat-related parts and send that over.

A Bundle is a package of selected parts of your world.

**What a Bundle contains:**

| Section | What's included | Required? |
|---------|----------------|-----------|
| **Name & description** | Bundle name, description, tags, cover, language, creation date | Name required |
| **Entries** | Character profiles, plot, style directives, lore | Can be empty |
| **Variables** | HP, gold, affection, flags, JSON state | Can be empty |
| **Behaviors** | Triggers, conditions and effects | Can be empty |
| **Audio tracks** | BGM, SFX, ambient tracks | Always included |
| **Visual layer** | The interface code (`index.tsx` and sibling files) | Optional |
| **Organization** | The scenarios and entry folders the selected entries use | Included automatically |

Plug it into another world and it works there.

**Creating a Bundle**

Click **⋮ → Save as template or pack** in the canvas top bar. Fill in a name, description and tags, then tick what to include under **Entries**, **Variables** and **Behaviors**. When you tick a behavior, the variables it reads or changes are marked "suggested", so you don't accidentally leave them out.

If the card has its own interface code, a **Visual layer** checkbox includes it. Once it's checked, **When others install it** appears below, listing which samples get swapped when someone installs the interface; see [Making an interface others can use](#shareable-interface). Audio tracks are always included.

Click **Save to Library**. The bundle is saved to your bundle library (**Panels → Marketplace → My Library**).

**Choices on import**

When you install a Bundle into an existing world, its content is **merged** in, never overwritten. Before it goes in you choose:

- **Parts to install**: you can leave out entries, behaviors or audio. Variables always come along, since the other parts use them.
- **Same variable ID**: the bundle shares the variable your card already has.
- **Same variable name, different ID**: for each one, pick **Merge into one** (the bundle uses your variable) or **Keep both** (the bundle's copy gets another name).
- **Its interface** (when the bundle has interface code): **Keep both screens**, **Replace the current screen**, or **Leave its screen out**. Replacing keeps your own interface; remove the bundle to get it back.

Entries and behaviors always get new IDs, and variable IDs referenced in behaviors are remapped, so relationships survive the import.

<a id="interface-templates"></a>

**Interface templates: use someone else's interface**

The market has a category called **Interface**: complete interfaces other creators made, such as status bars, inventories, relationships and maps. You can use one as your card's interface and swap its samples for your card's own as you install it.

1. On the canvas, press **Resource market** next to **Add** and filter the market by **Interface** (or press **Switch interface** on **Player interface** and then **More interfaces in the Resource market** at the bottom). Interfaces marked **Uses your characters** put your card's characters in as you install them.
2. Open one to preview it, then press **Use on this card**.
3. **Fit to this card** in the install dialog swaps the samples right away, with no assistant and no credits:
   - People in the interface (the board's characters, the phone's contacts) become **This card's characters** by default. Names, bios and portraits come from your card's character entries; click a name to leave that character out. Sample messages and posts from the sample people are emptied with them.
   - Other samples, such as the example items in a bag, can be kept (**Keep samples**) or emptied (**Empty**).
   - A single value the interface brings (like bag capacity) can point at one of your card's variables of the same type instead of adding a new one.
4. A full-screen interface that draws its own chat replaces your current screen by default; one that sits on top of the screen, like a status bar or a side drawer, keeps both by default, or your card would be left without a chat.
5. To also replace other text hard-coded in the interface's code, check **Have the assistant fit it to this card**. It starts unchecked when your card has characters to match. The assistant reads your card's variables and lore and replaces hard-coded numbers, characters, places and text with yours, keeping the layout, panels and features. If the interface needs something your card doesn't have (a map needs locations), it asks whether to add it or remove that panel.

The assistant's fitting uses your own assistant credits. If you don't like the result, press **Undo this turn** under the assistant's message, or remove the bundle to get your old interface back.

<a id="shareable-interface"></a>

**Making an interface others can use**

For your interface to show someone else's characters once they install it, what it shows has to live in variables, not in the code:

1. Put the people in one JSON variable whose ID says they are people, like `npcs`, `characters` or `contacts`. Make it an object keyed by person ID; each person has a `name`, and can have a `bio` and an `avatar` (an asset, a URL or one letter). Numbers like affinity or trust can go in there too.

   ```json
   {
     "aria": { "name": "Aria", "bio": "A squire in the royal city", "avatar": "A", "affinity": 30 },
     "ken": { "name": "Ken", "bio": "Runs the tavern", "avatar": "K", "affinity": 10 }
   }
   ```

2. Anything that belongs to a person (messages, posts, events) stores that person's ID, like `"from": "aria"`. When someone installs the interface, these are emptied along with the sample people.
3. Other samples, like items or places, also go in JSON variables, each item with a `name`. Whoever installs it can keep or empty them.
4. The interface code only reads these variables to draw them.

When you export the bundle with **Visual layer** checked, **When others install it** lists each list and what will happen to it: a list of people shows **Their characters**, other lists show **Kept or emptied**. If it says **No list of people**, the people are still written in the code, or their variable isn't checked. Once published to the market, an interface like this is marked **Uses your characters**.

You can also tell the assistant "I'll share this interface, keep the people in a variable", and it writes it this way.

**Sharing Bundles**

A saved Bundle is private by default. Set it to **Public** in the bundle editor and other creators can search, preview, and install it from **Panels → Marketplace → Hub**.

You can also click **Download JSON** on a bundle and send the file to friends for manual import (**⋮ → Import Bundle**, or **Import from file** in **Panels → Marketplace**).

To share a single [scenario](/creator/modules), use **Share this scenario** in its settings. It's saved to your bundles the same way.

## Full world export

Beyond the "partial export" of Bundles, you can also export a complete world JSON: open **My Library → My Projects**, select the card, and click **Download**. The exported file contains everything in `WorldDefinition`:

- All entries (`entries`) and entry folder structure (`entryFolders`)
- All variables (`variables`)
- Behaviors (`reactions`, and `rules` on older cards)
- Scenarios (`worldbooks`)
- Root Component (`rootComponent`): the entire world UI entry, including `index.tsx` and all its sibling files
- The player interface built in the Player interface editor (`uiDoc`)
- Custom UI TSX components (`customUI`, older cards)
- Audio tracks (`audioTracks`), BGM playlist (`bgmPlaylist`), conditional BGM (`conditionalBGM`)
- Scene images (`sceneImages`) and reply processing rules (`replyRules`)
- Spatial systems (`systems`) and scenes (`scenes`)
- Editor mode (`editorMode: "simple" | "advanced"`)
- World settings (`settings`): temperature, token limits, layout mode, scan depth, etc.

Note: the sharing variant grouping key (`languageGroupId`) is stored on the world record itself (for Hub matching), not inside `WorldDefinition`, so it doesn't appear in the exported JSON.

Uses for full export:
- **Backup.** Export periodically as a local copy.
- **Version control.** Commit to a git repo to track changes. Export before major revisions as a manual save point.
- **Collaborating.** Send the JSON to a collaborator and they can import it and work on their own account.
- **Migration.** The planned offline version uses the same format.

To import, use **Import File** in **Card settings** (this replaces the current card's content), or **⋮ → Import Bundle** for bundles. The importer recognizes Yumina world JSON, SillyTavern character cards (including PNG-embedded V2 cards), and Bundle JSON.

## Example: a combat system bundle for the community

Say you built a turn-based combat system in your RPG world containing:

- Variables: `HP` (number, 0–100), `MP` (number, 0–50), `ATK`, `DEF`, `battlePhase` (text)
- Behaviors: `trigger death settlement when HP hits zero`, `MP naturally recovers 5 per turn at turn start`
- Interface: an HP and MP bar in the card's interface code
- Audio: battle BGM (loop), hit sound effect (sfx)

Packaging steps:

1. Click **⋮ → Save as template or pack** in the canvas top bar
2. Name it "Turn-Based Combat System v1.0," write a clear description of its usage
3. Tick the 2 behaviors. The variables they use are marked "suggested"
4. Tick the 5 variables
5. Tick **Visual layer** if you want the HP/MP bars to come along (audio tracks are always included)
6. Add tags: `combat`, `rpg`, `turn-based`
7. Click **Save to Library**

To share it, set the bundle to **Public** so it shows up in the Hub, or click **Download JSON** and send the file.

Someone who has the Bundle opens their own card and installs it from **Panels → Marketplace**, or clicks **⋮ → Import Bundle** for a file. Variable name conflicts are handled automatically.

---

## See also

- [Custom UI Guide](/creator/advanced/custom-ui-deep): building the visual experience players see when they play your world
