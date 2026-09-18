# Publishing, Exporting & Bundles

## The short version

When your world is done, how do you get it to other players? Simple: **hit Publish in the editor's top bar.**

Before you click "publish," make sure these are ready in the **Overview** section of the editor:

- **Name and description** — name up to 200 characters, description up to 10,000. A good name is your storefront; a good description is your guide.
- **Cover image** — the first thing players see in the community listing. A world without a cover is like a movie theater without a poster — nobody knows what's playing inside.
- **Tags** — up to 10. Tags help players discover your world: "fantasy," "romance," "battle royale," "multiplayer," and so on.

Once ready, save the world and click the **Publish** button in the editor's top bar (right next to **Save**). In the publish dialog, set the **content mode** (Limited or Limitless), visibility, and edit permission, check the terms agreement, and publish. Your world appears in **Discover** for others to search, browse, play directly, or fork and modify.

Don't want to use the platform's publish system? Export your world as a JSON file and send it to friends directly. Or export just part of your world's content — like a battle system — as a Bundle to share with other creators.

---

## The detailed version

### Publication status

A world has three states, like a traffic light controlling its visibility:

| Status | Meaning | Visible to others? |
|--------|---------|-------------------|
| `draft` | Still being worked on, only you can see it | No |
| `published` | Live, appears on the Discover page | Yes |
| `unpublished` | Was published, but you pulled it | No |

A draft can be published; a published world can be unpublished; an unpublished world can be re-published or returned to draft. You can't skip steps (e.g., a draft can't go directly to "unpublished").

When you unpublish a world, the system automatically notifies all players who've added it to their library: "This world has been unpublished." When you re-publish, they get another notification: "It's back." Pretty thoughtful.

### Publish settings

The following settings are configured in the **publish dialog** (opened from the editor's **Publish** button) — not in the Overview form itself.

**Content mode**

Two tiers in the UI:

| UI label | Meaning |
|----------|---------|
| **Limited** | Standard content boundaries — visible to everyone |
| **Limitless** | Expanded content boundaries — available to eligible accounts |

Choosing **Limitless** automatically enables the compatibility flag behind the scenes — you don't need to set it manually. If you don't pick anything, publishing defaults to **Limited**. The system handles consistency so you won't end up with a mismatched mode.

> **Legacy note:** older stored values are normalized automatically. Creators only need to choose **Limited** or **Limitless**.

**Visibility (`visibility`)**

```
public     — public, everyone can see it on Discover
followers  — followers-only, good for limited testing or sharing with your circle
```

Defaults to `public` if not specified at publish time.

**Allow editing (`allowEdit`)**

Defaults to `true`. When on, other creators can fork your world to modify it. Off means only you can fork your own world.

Like open-source vs. closed-source: with allowEdit on, your world might inspire interesting variations; off and your content can be played but not modified. Your call.

**Allow multiplayer (`allowMultiplayer`)**

Defaults to `false`. This flag tells the platform whether the world is designed for multiplayer. If you set `multiplayerSettings.availability` to `enabled` in the world definition's schema, the system also infers this value automatically. Specific multiplayer behavior config is in "Multiplayer settings" below.

**Tags (`tags`)**

Up to 10 tags. Very useful for search and filtering on the Discover page — the platform tracks tag usage frequency across all published worlds, and players can browse and search by tag. Auto-complete suggests popular tags as you type.

**Cover image (`thumbnailUrl`)**

Upload in the **Overview** section of the editor. Used on Discover cards, search results, and in **My Library**. Worlds without covers almost never get clicked. Strongly recommend adding one.

### Forking

When a world is published and `allowEdit` is `true`, other users can "fork" it:

1. A complete copy is created, owned by the forker
2. The name is auto-incremented — if the original is "Dark Forest," your copy is "Dark Forest (1)"; fork again and it's "Dark Forest (2)"
3. The copy starts as a draft and isn't published automatically
4. Preserves all original tags, description, cover, schema, and content
5. Original world's `downloadCount` increases by 1
6. The copy's `sourceWorldId` points back to the original for traceability
7. Any referenced assets (like images) are copied over too

### Bundle system

What is a Bundle? Here's the analogy: you spent two weeks building a polished combat system — variables, rules, UI components, sound effects, the full package. A friend is also building a world and needs a combat system. You don't need to give them your whole world — just **bundle** the combat-related parts and send it over.

A Bundle is a "component pack" containing selected parts of your world.

**What a Bundle contains:**

| Section | What's included | Required? |
|---------|----------------|-----------|
| **Name & description** | Bundle name, description, tags, creation date | Yes |
| **Entries** | Character profiles, plot, style directives, lore | Yes (can be empty) |
| **Variables** | HP, gold, affection, flags, JSON state | Yes (can be empty) |
| **Rules** | Trigger conditions and actions | Yes (can be empty) |
| **Custom UI** | TSX components | Yes (can be empty) |
| **Audio tracks** | BGM, SFX, ambient tracks | Yes (can be empty) |
| **Root Component** | The full multi-file TSX app (index.tsx and sibling files). Including this upgrades the Bundle to a "full template" | Optional |
| **Organization** | Custom tag definitions, entry folder structure | Optional |

::: tip Two ways to use a Bundle
- **Partial bundle** — entries / variables / rules / audioTracks only, no `rootComponent`. **Merges** into an existing world. Great for sharing a combat system or a character card.
- **Full template** — same plus a `rootComponent`. **Forks** into a brand-new world. Great for "VN skeleton," "card-battle shell," etc. — anyone importing it starts a fresh world built on your template.

The seven official Resource Templates work exactly this way.
:::

Think of it as a "module" — plug it into another world and it works.

**Creating a Bundle**

Click **Export Bundle** in the editor's top menu. You get four checkable sections:

1. **Entries** — entries (character profiles, plot, style directives, etc.)
2. **Variables** — variables (HP, gold, affection, etc.)
3. **Rules** — rules (trigger conditions + actions)
4. **Custom UI** — the TSX components array

A thoughtful feature: when you check a rule, the system automatically highlights the variables it depends on and marks them as "suggested" so you don't accidentally leave them out.

Two things are **auto-included** (no checkbox):

- **Audio tracks** (`audioTracks`) — the full list is always bundled.
- **Root Component** (`rootComponent`) — if your world has one, it's attached automatically. Including a Root Component upgrades the Bundle into a "full template" — instead of merging into an existing world, importers can fork it into a brand-new world built on your template.

**Conflict handling on import**

When importing a Bundle into an existing world, content is **merged**, not overwritten. Specific conflict resolution:

- **Same variable ID**: skip, use existing variable
- **Same variable name but different ID**: create new variable with a suffix (e.g. `HP (1)`)
- **Entries**: always generate new UUIDs, append to existing entry list
- **Rules and components**: same — create new IDs and append

Variable IDs referenced in rules and components are auto-remapped to preserve relationships after import. This matters — if you import a combat system and the rules' "HP" variable doesn't match up, the import is useless.

**Publishing Bundles to Hub**

A saved Bundle defaults to private. After publishing, other creators can search, preview, and install it on the Discover page.

You can also download the Bundle as a `.bundle.json` file and send it to friends for manual import.

### Full world export

Beyond the "partial export" of Bundles, you can also export a complete world JSON. This is available in the **Overview** section of the editor, or in **My Library → My Projects**. The exported file contains everything in `WorldDefinition`:

- All entries (`entries`) and entry folder structure (`entryFolders`)
- All variables (`variables`)
- All rules (`rules`) and compiled reactions (`reactions`)
- Root Component (`rootComponent`) — the entire world UI entry, including `index.tsx` and all its sibling files
- Custom UI TSX components (`customUI`)
- Audio tracks (`audioTracks`), BGM playlist (`bgmPlaylist`), conditional BGM (`conditionalBGM`)
- Spatial systems (`systems`) and scenes (`scenes`)
- Editor mode (`editorMode: "simple" | "advanced"`)
- UI blueprint (`uiBlueprint`)
- World settings (`settings`) — temperature, token limits, layout mode, scan depth, etc.
- Multiplayer settings (`multiplayerSettings`)

Note: the sharing variant grouping key (`languageGroupId`) is stored on the world record itself (for Hub matching), not inside `WorldDefinition`, so it doesn't appear in the exported JSON.

Uses for full export:
- **Backup** — export periodically as a local copy. Your data is safe in the cloud, but local backups give peace of mind.
- **Version control** — commit to a git repo to track changes. Export before major revisions as a manual save point.
- **Collaborating** — send the JSON to a collaborator and they can import it and work on their own account.
- **Migration** — the future Tauri offline version uses the same format, so switching will be seamless.

On import, the system automatically recognizes Yumina world JSON, SillyTavern character cards (including PNG-embedded V2 cards), and Bundle JSON — each processed differently. You don't need to pick the format; just drag and drop.

### Multi-language support: two systems

Yumina has two multi-language mechanisms, **with completely different goals — pick whichever fits**:

| Mechanism | What gets translated | When to use |
|-----------|----------------------|-------------|
| **Hub Translations** | Only the "storefront info" shown on Discover / your profile — title, description, cover image, gallery, tags | Your game content is single-language, but you want global players to see localized titles and descriptions while browsing |
| **Variants** | An entire copy of the world, fully translated — entries, rules, component text, all of it | You want players to play your world in their own language, with the AI replying in that language too |

#### Hub Translations

Find it in the editor's left navigation under **Hub Translations**.

How to set it up:

1. Go to the **Hub Translations** section
2. Click **Add Language**
3. Pick the target language from the dropdown (10 languages supported)
4. The current world's name, description, cover, gallery, and tags are copied as a starting point
5. Edit each field directly in the UI — translate them into the target language
6. Upload a language-specific cover image if you want to
7. Save — translations are stored as part of your world, no separate files generated

When players browse the Discover page, Yumina automatically picks the best matching translation for their UI language. **The content players see in-game stays in the world's original language** — Hub Translations don't affect gameplay text.

#### Variants

If you want the in-game content translated too, you need the **Variant** system — create a new variant in the Variant Tab Bar at the top of the editor, picking the target language. The editor creates a full copy of your world in the new language, which you then translate.

The engine recognizes variants as "different language versions of the same world." On the world detail page, players switch between them with one click. In the community listing the variant group counts as a single world; view stats are merged.

#### Supported languages

Both mechanisms support the same 10 languages:

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

::: tip Which one?
- Just want a **decent cover and description** for overseas players → Hub Translations
- Want **fully localized gameplay** → Variants
- The two **can be combined**: variant A (Chinese version) with Chinese + English Hub Translations, variant B (English version) with English + Japanese Hub Translations — covers three audiences total
:::

---

## Multiplayer settings (MultiplayerSettings)

If your world supports multiplayer, configure the following settings in the editor. These are optional — without them, multiplayer is disabled by default.

| Setting | Options | Default | Purpose |
|---------|---------|---------|---------|
| **Availability** | Disabled / Enabled | Disabled | Master switch for multiplayer |
| **Chat policy** | Free / Active speaker only | Free | Who can send messages and when |
| **AI trigger mode** | Instant / Timer / Round / Manual | Manual | When the AI responds |
| **Round timer** | 5-120 seconds | 15 | Countdown duration (timer mode) |
| **Author notes** | Free text | Empty | Instructions visible to the room host |

Breaking these down:

**availability** — the master switch. `disabled` = single-player only. `enabled` = rooms can be created for multiplayer. Also remember to set `allowMultiplayer` to `true` in the world's database layer — there's a separate toggle in the editor.

**defaultChatPolicy** — chat policy.
- `free`: free-form, everyone can send messages at any time, like a group chat. Great for casual, social worlds.
- `active_speaker_only`: turn-based, only one person can speak at a time, like a board game. Great for TRPG tabletop sessions.

**defaultAiTriggerMode** — when does the AI respond? Four modes for different pacing:
- `instant`: AI responds immediately when someone speaks. Fastest pace, good for dialogue-driven worlds.
- `timer`: AI responds when the countdown timer runs out (using `defaultRoundTimerSeconds`). Leaves a window for others to chime in.
- `round`: AI responds after everyone has sent a message. Like TRPG where the DM speaks after everyone has taken their turn — every action gets considered.
- `manual`: host manually triggers the AI. Most flexible, host controls the pacing entirely.

**defaultRoundTimerSeconds** — timer duration, 5–120 seconds, default 15. Mainly active in `timer` mode.

**authorNotes** — notes visible to whoever creates the room. E.g., "Best with 2–4 players," "Host please read rules before starting," "Each player picks a class before beginning." These aren't sent to the AI — purely a human-readable instruction guide.

These are all **default values** — the room host can adjust them for the actual session. What you're setting is the "recommended config."

---

## Practical examples

### Example 1: Pre-publish checklist

Your world is done and you're ready to go live. Don't rush to click — go through this checklist first:

```
[ ] Name — is it compelling? Can someone tell what kind of world it is at a glance?
[ ] Description — did you write one? Don't leave it blank. At least two sentences telling players what they'll experience.
[ ] Cover image — uploaded? Does it still look clear when thumbnail-sized on Discover?
[ ] Tags — added 3–10 relevant tags? Think about what players would search for.
[ ] Content mode — pick **Limitless** for expanded content boundaries, otherwise **Limited**. Don't get this wrong — mis-labelling is a guidelines violation.
[ ] Visibility — public if you want everyone to see it. Followers-only for limited testing first.
[ ] allowEdit — open if you want others to fork and modify. Close to protect your original work.
[ ] Greeting — what's the first message players see? Is it set up properly? First impressions matter.
[ ] Self-test — did you play through it yourself from start to finish? Do variables work? Do rules trigger correctly?
```

Once verified, click **Save** in the editor's top bar, then click the **Publish** button right next to it, and complete the publish dialog flow.

Your world is live. Go check out how it looks on Discover.

### Example 2: Creating a combat system Bundle to share with the community

Say you built a turn-based combat system in your RPG world containing:

- Variables: `HP` (number, 0–100, stat), `MP` (number, 0–50, resource), `ATK`, `DEF`, `battlePhase` (string, flag)
- Rules: `trigger death settlement when HP hits zero`, `MP naturally recovers 5 per turn at turn start`
- Components: one stat-bar for HP, one stat-bar for MP
- Audio: battle BGM (loop), hit sound effect (sfx)

Packaging steps:

1. Click **Export Bundle** in the editor's top menu
2. Name it "Turn-Based Combat System v1.0," write a clear description of its usage
3. Check the 5 variables — when you check the rules, the system highlights related variables
4. Check the 2 rules and 2 components
5. Check the audio tracks
6. Add tags: `combat`, `rpg`, `turn-based`
7. Export and save

The exported Bundle file contains all the selected content — entries, variables, rules, UI components, and audio tracks — packaged as a single JSON file.

Once someone has the Bundle file, they click **Import Bundle** in their editor's top menu, choose which world to install it into, and the combat system is ready to go. Variable name conflicts are handled automatically.

### Example 3: Multiplayer settings — 4-player co-op RPG

You built a 4-player dungeon adventure world. Each person plays a class (warrior, mage, rogue, healer), they take turns acting, and after everyone has acted the AI as DM advances the story.

In the editor, set:

- **Availability**: Enabled
- **Chat policy**: Active speaker only
- **AI trigger mode**: Round
- **Round timer**: 60 seconds
- **Author notes**: "Recommended 4 players, each choosing a class: warrior, mage, rogue, or healer. Each round, every player describes their action, then the AI advances the story once all players have acted. 60-second timer — if someone is idle too long, the AI moves on anyway."

Why these settings?

- `active_speaker_only` — turn-based speaking prevents four people typing simultaneously and leaving the AI confused about who to respond to. This is a TRPG session, so it should be one at a time.
- `round` — AI waits for everyone before responding, ensuring every player's action gets considered. Nobody gets skipped because "the DM already moved on."
- `60-second timer` — enough time to think about strategy, but not so long it drags. If someone went to get a drink, the AI still moves forward after 60 seconds without locking everyone else in place.
- `authorNotes` — a "manual" for the host, letting them know how to run the session and what to tell players.

Also don't forget to set `allowMultiplayer` to `true` at the world level — otherwise, even if multiplayerSettings is perfectly configured, the platform won't show it as a multiplayer world.

---

## See also

- [Custom UI Guide](/creator/advanced/custom-ui-deep) — building the visual experience players see when they play your world
