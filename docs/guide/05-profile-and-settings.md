# Profile & Settings

## Your profile

Your public profile shows your avatar, banner, bio, playtime stats, recently played worlds, published creations, favorites, and achievements. Edit it from the profile page -- you can customize your avatar, banner (recommended 1500x500px), display name, username, bio, location, and website link.

## Your Personas

Personas let you step into worlds as a character you've designed, not just your account name. Each persona has a **name**, **avatar**, **appearance**, **personality**, and **backstory** — and all of it gets sent to the AI every time you play.

When a persona is active, the AI knows who you are. It reads your appearance when describing how characters look at you. It reads your personality when deciding how NPCs react to you. It reads your backstory when weaving your history into the narrative. Without a persona, the AI only knows your username.

### Creating a persona

On your profile page, find the persona carousel. Click **Create** to open the editor:

- **Name** — What the AI and other characters call you. This replaces `{{user}}` in all worlds.
- **Avatar** — Your character portrait, visible in chat and multiplayer.
- **Appearance** (optional, up to 1,000 characters) — Physical description. The AI uses this when narrating interactions. "Tall, dark-haired, wears a long black coat with silver clasps. A faded scar runs across the left cheek."
- **Personality** (optional, up to 1,000 characters) — How you act. The AI weaves this into your dialogue and behavior. "Calm and measured, rarely raises voice. Dry humor. Fiercely loyal but slow to trust."
- **Backstory** (optional, up to 2,000 characters) — Your history. The AI draws from this for narrative connections. "Former military medic who left the service after a friendly-fire incident. Now drifts between cities, taking odd jobs."

At the bottom of the editor, **Add entry** adds a title and content for details such as abilities, weapons or rules. Edit or remove entries there, then save. Saved entries join the selected persona's AI context; private notes remain private. Blank rows are ignored, but a partly completed row needs both fields before saving.

You can save up to 20 entries, with 100 characters per title, 5,000 per content field and 20,000 across all titles and content.

You can create multiple personas and switch between them. Only one can be **active** at a time — the one with the gold ring in the carousel.

### How personas affect gameplay

For each new response, the engine loads the session's selected persona, or your profile persona when the session follows your profile, and injects it into the AI's prompt as a player character block. The AI sees:

```
[The user is roleplaying as Your Persona Name]
Appearance: (your appearance text)
Personality: (your personality text)
Backstory: (your backstory text)
```

This means the same world feels different depending on which persona you bring. A horror world plays differently when you're a scared teenager vs. a hardened detective. A romance world shifts tone when you're a shy introvert vs. a confident extrovert.

Switching personas in your profile or the world's session picker changes the account-wide selection. New chats and existing sessions without a persona lock follow it from the next request. Selecting a persona inside a chat automatically switches to **Persona locked** and changes only that save, including an explicit **No persona** selection. Turn the lock off to return to **Following global persona**. Editing the selected persona updates later prompts in either mode. A response already generating keeps the identity it started with. Old messages and memories are not rewritten, and private notes are never sent to the AI.

### No persona? That's fine too

If you don't create a persona or select **No persona**, the AI uses your display name in new chats and unlocked sessions. A session can also lock an explicit no-persona choice. Personas are for players who want deeper immersion or who roleplay across many worlds with the same character identity.

### Tips

- **Keep it concise.** The AI reads your entire persona every turn. A few vivid sentences beat a novel-length backstory.
- **Leave room for the world.** Don't over-specify. If your backstory says "I am the chosen one who will save the kingdom," you're fighting the world's own narrative. Give the AI hooks to build on, not a finished story.
- **Match the world's tone.** A goofy persona in a serious horror world (or vice versa) can create tonal whiplash. Some players use different personas for different genres.

## Following

Follow creators to see their new worlds in the Hub's Following tab. Click Follow on anyone's profile, click again to unfollow.

## Reviews

Ratings and comments are separate. To rate a world, select 1–5 stars and click **Save rating**. To comment, write your message and click **Post comment**; no rating is required. Saving either form leaves the other draft untouched. Reviews appear on the world's detail page and on your profile.

## Settings overview

The settings page has these sections:

### Account
Username, email (read-only), password change, connected accounts (Google, Discord, X), sign out.

### AI Configuration
Model selection, context size, temperature, reasoning effort, streaming, sampling parameters, BYOK keys, custom prompts, and prompt presets. See [AI Settings](./04-ai-settings) for the full breakdown.

When a model cannot reply, a compact notice in the conversation lets you retry, choose a backup model, or cancel. Open **Options & pricing** to find **Don't ask again; automatically use this backup model**, which is unchecked by default. Check it and select **Save & continue** to save automatic switching for future failures; otherwise, your choice applies only to this turn.

In **Settings → Generation → Backup model**, choose **Ask every time**, **Use my backup automatically**, or **Stop and notify me**, and select your backup model. Automatic mode tries one backup per turn. Your original model remains selected for the next turn, and the conversation shows when a backup was used. Charges follow the backup model's actual token usage; displayed averages are not a quote for your turn. With BYOK, usage is paid through your API key, and automatic authorization applies only to that key.

### Content & Safety
- **Content mode:** **Limited** (default) or **Limitless** (available to eligible accounts)
- **Audience preference:** **For Everyone** / **For Men** / **For Women** -- filters Hub recommendations
- **Blur Limitless media:** Toggle thumbnail blurring for Limitless worlds

### Privacy
- **Private account** -- only followers can see your activity
- **Allow DMs** -- toggle direct messages
- **Show recent play** -- toggle visibility of your recently played worlds

### Notifications
Granular toggles for engagement (favorites, reviews), social (followers, followed creators publishing), library (world updates), and community (thread replies, likes, room invites) notifications.

### Display
- **Font size:** Small / Default / Large / X-Large
- **Language:** English, Chinese (Simplified), Japanese, Korean

### Wallpaper
Set different wallpapers for Hub, Profile, Settings, and Library pages. Two built-in presets (Starry Night, Library Canvas) plus upload your own. Three sliders for opacity, gradient strength, and glass effect intensity.
