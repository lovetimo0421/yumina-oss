# Publishing, Exporting & Bundles

## The short version

When your world is done, click **Not live** in the top right of the canvas and publish it.

Before you do, click **Cover & blurb** on the right of the canvas and make sure **Card settings** has:

- **Card title and description** — title up to 50 characters, description up to 10,000. Players decide whether to open your card from these two.
- **Cover Image** — the first thing players see on Discover. You need a portrait **Phone · 2:3** and a landscape **Desktop · 16:9** version. Cards without a cover get sent back by review.

**Not live** runs through a short checklist (a name, a cover, an opening, at least one playtest). Then click **Publish**. In the publish dialog, add **Tags** (players search and filter by them), set the **Content Mode** (Limited or Limitless), visibility, and whether others may make editable copies, confirm your rights to the content, and publish. After review, your world appears in **Discover** for others to search, browse, play, or copy and modify.

Don't want to use the platform's publish system? Download your world as a JSON file and send it to friends directly. Or export just part of your world's content — like a battle system — as a Bundle to share with other creators.

---

## The detailed version

### Publication status

The publish button in the top right shows where a world stands:

| Status | Meaning | Visible to others? |
|--------|---------|-------------------|
| Draft (**Not live**) | Still being worked on, only you can see it | No |
| **In review** | Submitted, waiting for review | No |
| Published (**LIVE**) | Live, appears on the Discover page | Yes |
| **Rejected** | Sent back by review, with the reason | No |
| Unpublished | Was published, but you took it down | No |

A draft, a rejected world and an unpublished world can all be submitted for review. While a world is in review you can't edit it; **Stop review request** takes it back to a draft. A published world can be unpublished from the publish menu.

When you unpublish a world, players who've added it to their library get a notification, and players with existing sessions see it as "No longer available" and can't keep playing. When you re-publish, they're notified again.

After a world is live, edits you save become **Unpublished changes**. Players keep seeing the live version until you submit the changes and they pass review. See [Publishing](/creator/publishing#updating-a-published-world).

### Publish settings

These are set in the **publish dialog** (from **Publish** in the publish menu), not in Card settings.

**Content mode**

| UI label | Meaning |
|----------|---------|
| **Limited** | Standard content boundaries — visible to everyone |
| **Limitless** | Expanded content boundaries — available to eligible accounts |

If you don't pick anything, publishing defaults to **Limited**.

**Visibility**

```
Public          — everyone can find and play it on Discover
Followers Only  — only your followers can see it, good for limited testing or sharing with your circle
```

Defaults to **Public**.

**Derivative Works (`allowEdit`)**

Defaults to **Allow**. When allowed, others can create editable copies of your world to modify. **Not Allowed** means nobody else can.

**Tags**

Up to 50 tags. Very useful for search and filtering on the Discover page — the platform tracks tag usage frequency across all published worlds, and players can browse and search by tag. Auto-complete suggests popular tags as you type.

**Everything else in the dialog**

- **Cover Thumbnail** — **Blurred** or **Clear** in listings
- **Target Audience** — For Everyone, For Men, For Women
- **Custom API Keys** — whether players may play with their own API key, or only the official API
- **Reviews** — open or closed
- **Community Citations** — whether others can cite your work in community posts
- **Announcement** and **Approx. Play Time** — shown on the card's page
- **Lore Shift** — see [Publishing](/creator/publishing#lore-shift)

**Cover image**

Upload it in **Card settings** (**Cover & blurb** on the canvas). Used on Discover cards, search results, and in **My Library**.

### Forking

When a world is published and allows derivative works, other users can make their own copy:

1. A complete copy is created, owned by the forker
2. The name is auto-incremented — if the original is "Dark Forest," your copy is "Dark Forest (1)"; fork again and it's "Dark Forest (2)"
3. The copy starts as a draft and isn't published automatically
4. Preserves all original tags, description, cover, schema, and content
5. Original world's `downloadCount` increases by 1
6. The copy's `sourceWorldId` points back to the original for traceability
7. Any referenced assets (like images) are copied over too

### Bundle system

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

Click **⋮ → Export Bundle** in the canvas top bar. Fill in a name, description and tags, then tick what to include under **Entries**, **Variables** and **Behaviors**. When you tick a behavior, the variables it reads or changes are marked "suggested", so you don't accidentally leave them out.

If the card has its own interface code, a **Visual layer** checkbox includes it. Audio tracks are always included.

Click **Save to Library**. The bundle is saved to your bundle library (**Panels → Marketplace → My Library**).

**Conflict handling on import**

When importing a Bundle into an existing world, content is **merged**, not overwritten. Specific conflict resolution:

- **Same variable ID**: skip, use existing variable
- **Same variable name but different ID**: create new variable with a suffix (e.g. `HP (1)`)
- **Entries**: always generate new IDs, append to existing entry list
- **Behaviors**: same — create new IDs and append
- **Visual layer**: its files merge into the world's interface code

Variable IDs referenced in behaviors are auto-remapped to preserve relationships after import. Without that, an imported combat system's behaviors wouldn't find their "HP" variable.

**Sharing Bundles**

A saved Bundle is private by default. Set it to **Public** in the bundle editor and other creators can search, preview, and install it from **Panels → Marketplace → Hub**.

You can also click **Download JSON** on a bundle and send the file to friends for manual import (**⋮ → Import Bundle**, or **Import from file** in **Panels → Marketplace**).

To share a single [scenario](/creator/modules), use **Share this scenario** in its settings. It's saved to your bundles the same way.

### Full world export

Beyond the "partial export" of Bundles, you can also export a complete world JSON: open **My Library → My Projects**, select the card, and click **Download**. The exported file contains everything in `WorldDefinition`:

- All entries (`entries`) and entry folder structure (`entryFolders`)
- All variables (`variables`)
- Behaviors (`reactions`, and `rules` on older cards)
- Scenarios (`worldbooks`)
- Root Component (`rootComponent`) — the entire world UI entry, including `index.tsx` and all its sibling files
- The player interface built in the Player interface editor (`uiDoc`)
- Custom UI TSX components (`customUI`, older cards)
- Audio tracks (`audioTracks`), BGM playlist (`bgmPlaylist`), conditional BGM (`conditionalBGM`)
- Scene images (`sceneImages`) and reply processing rules (`replyRules`)
- Spatial systems (`systems`) and scenes (`scenes`)
- Editor mode (`editorMode: "simple" | "advanced"`)
- World settings (`settings`) — temperature, token limits, layout mode, scan depth, etc.

Note: the sharing variant grouping key (`languageGroupId`) is stored on the world record itself (for Hub matching), not inside `WorldDefinition`, so it doesn't appear in the exported JSON.

Uses for full export:
- **Backup** — export periodically as a local copy.
- **Version control** — commit to a git repo to track changes. Export before major revisions as a manual save point.
- **Collaborating** — send the JSON to a collaborator and they can import it and work on their own account.
- **Migration** — the planned offline version uses the same format.

To import, use **Import File** in **Card settings** (this replaces the current card's content), or **⋮ → Import Bundle** for bundles. The importer recognizes Yumina world JSON, SillyTavern character cards (including PNG-embedded V2 cards), and Bundle JSON.

### Multi-language support: variants

To let players play your world in their own language, with the AI replying in that language too, make a **variant**: a full copy of the world in another language. Open **Panels → Languages & variants** (the variants also sit at the top of **Card settings**), add a language version, and translate it. A banner on the new version offers **Ask the assistant to translate into …** if you'd rather the Creation assistant did the first pass.

Each variant is separate content: lore, openings, variables, behavior text and interface text all need translating. The engine recognizes variants as "different language versions of the same world." Players see the version in their own language on Discover and can switch to the others after opening the card. One version per language is marked ★ **Main**, the one people see when browsing. In the community listing the variant group counts as a single world; view stats are merged.

#### Supported languages

| Code | Language |
|------|---------|
| `en` | English |
| `zh` | 中文 |
| `ja` | 日本語 |
| `ko` | 한국어 |
| `es` | Español |
| `fr` | Français |
| `de` | Deutsch |
| `pt` | Português |
| `ru` | Русский |
| `ar` | العربية |

---

## Practical examples

### Example 1: Pre-publish checklist

Your world is done and you're ready to go live. Go through this checklist first:

```
[ ] Name — is it compelling? Can someone tell what kind of world it is at a glance?
[ ] Description — did you write one? At least two sentences telling players what they'll experience.
[ ] Cover image — both formats uploaded and cropped? Does it still look clear when thumbnail-sized on Discover?
[ ] Tags — added relevant tags? Think about what players would search for.
[ ] Content mode — pick **Limitless** for expanded content boundaries, otherwise **Limited**. Mis-labelling is a guidelines violation.
[ ] Visibility — public if you want everyone to see it. Followers-only for limited testing first.
[ ] Derivative works — allow if you want others to copy and modify it. Disallow to protect your original work.
[ ] Opening — what's the first message players see? Is it set up properly?
[ ] Self-test — did you play through it yourself from start to finish? Do variables change? Do behaviors fire?
```

Once verified, click **Save**, then **Not live** → **Publish**, and complete the publish dialog. Once it passes review, check how it looks on Discover.

### Example 2: Creating a combat system Bundle to share with the community

Say you built a turn-based combat system in your RPG world containing:

- Variables: `HP` (number, 0–100), `MP` (number, 0–50), `ATK`, `DEF`, `battlePhase` (text)
- Behaviors: `trigger death settlement when HP hits zero`, `MP naturally recovers 5 per turn at turn start`
- Interface: an HP and MP bar in the card's interface code
- Audio: battle BGM (loop), hit sound effect (sfx)

Packaging steps:

1. Click **⋮ → Export Bundle** in the canvas top bar
2. Name it "Turn-Based Combat System v1.0," write a clear description of its usage
3. Tick the 2 behaviors — the variables they use are marked "suggested"
4. Tick the 5 variables
5. Tick **Visual layer** if you want the HP/MP bars to come along (audio tracks are always included)
6. Add tags: `combat`, `rpg`, `turn-based`
7. Click **Save to Library**

To share it, set the bundle to **Public** so it shows up in the Hub, or click **Download JSON** and send the file.

Someone who has the Bundle opens their own card and installs it from **Panels → Marketplace**, or clicks **⋮ → Import Bundle** for a file. Variable name conflicts are handled automatically.

---

## See also

- [Custom UI Guide](/creator/advanced/custom-ui-deep) — building the visual experience players see when they play your world
