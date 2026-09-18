<div v-pre>

# Dynamic AI Personality Switching

> Make a few buttons that swap the AI's personality, speaking style, or language with one click. Use "Tell AI" and "Stop Telling AI" to dynamically change the AI's system prompt — no need to restart the session, switch seamlessly mid-conversation.

---

## What you'll build

A personality switcher embedded right in the chat:

- **Three modes** — Normal Narrator, Comedy Mode, Horror Mode
- **One-click switching** — tap a button to change the AI's speaking style, effective immediately
- **Visual feedback** — the currently active mode button is highlighted so the player always knows what mode they're in
- **Seamless transitions** — switching doesn't interrupt the conversation; the AI's very next reply uses the new style

### How it works

Yumina's behavior system has two powerful actions: "Tell AI" and "Stop Telling AI."

- **Tell AI** (`inject-directive`) — Injects a directive into the AI's system prompt. As long as the directive is present, the AI sees it and follows it on every reply. You can specify where it appears in the prompt, whether it's permanent, and how many turns before it auto-expires.
- **Stop Telling AI** (`remove-directive`) — Removes a previously injected directive by its ID. Once removed, the AI no longer sees that directive.

Using these two actions together, we can do this:

```
Player clicks "Comedy Mode" button
  → Behavior fires: first remove the old personality directive (if any)
  → Then inject the new comedy-style directive
  → The AI's system prompt now includes: "Narrate everything in a humorous, funny tone..."
  → The AI's next reply shifts to comedy style
```

**How is this different from lore entries?** Lore entries (enable entry / disable entry) are great for large blocks of world-building text. Directives injected via "Tell AI" are lighter and more flexible — they're not entries, but small snippets of text inserted directly into the system prompt. Perfect for short style instructions, temporary rules, or one-off hints. You can use both together.

---

## Step by step

### Step 1: Create a variable

We need one variable to track which mode is currently active. The Root Component reads it to decide which button to highlight.

Editor → sidebar → **Variables** tab → click "Add Variable"

| Field | Value | Why |
|-------|-------|-----|
| Display Name | Current Mode | For your own reference |
| ID | `current_mode` | Behaviors and the Root Component read/write using this ID |
| Type | String | Because the values are text (`"normal"`, `"comedy"`, `"horror"`) |
| Default Value | `normal` | New sessions start in normal mode |
| Category | Custom | Dedicated category for the personality system |
| Behavior Rules | `Do not modify this variable. It is controlled by the player's UI buttons.` | Tells the AI not to change this on its own — only player buttons can |

---

### Step 2: Create behaviors

We need 3 behaviors — one per mode. Each behavior's logic is: **remove old directive → inject new directive → update variable → notify player**.

Editor → **Behaviors** tab → add behaviors one by one

#### Behavior 1: Switch to Comedy Mode

**WHEN (trigger):**

| Field | Value | Why |
|-------|-------|-----|
| Trigger Type | Action | Fires when code calls `executeAction("mode-comedy")` |
| Action ID | `mode-comedy` | The button in the Root Component calls this ID |

**DO (actions):**

Add the following actions in order:

| # | Action Type | Settings | Purpose |
|---|-------------|----------|---------|
| 1 | Stop Telling AI | Directive ID: `personality-override` | Remove the previous personality directive (if any). If none exists, nothing happens — no error |
| 2 | Tell AI | Directive ID: `personality-override`, content below, position: After Character | Inject the comedy-style directive |
| 3 | Modify Variable | `current_mode` set to `comedy` | Update the variable so the Root Component knows the current mode |
| 4 | Show Notification | Message: `Switched to Comedy Mode`, style: info | Give the player visual feedback |

**"Tell AI" directive content:**

```
[Narration Style: Comedy Mode]
From now on, narrate everything in a humorous, comedic tone. You may:
- Use exaggerated metaphors and absurd analogies
- Occasionally break the fourth wall and whisper asides to the reader
- Have NPCs deliver hilariously ill-timed lines
- Describe serious scenes in a lighthearted voice for comedic contrast
Keep the story moving — don't just tell jokes. Humor should be woven into the narration, not replace it.
```

> **Why "Stop Telling AI" before "Tell AI"?** Because both directives use the same ID (`personality-override`). If the player switches from Horror to Comedy, not removing the old directive first would rely on `injectDirective` auto-replacing the same ID — which it does — but explicitly removing then re-injecting is a better habit. The logic is clearer, and it avoids potential edge cases.

---

#### Behavior 2: Switch to Horror Mode

**WHEN:**

| Field | Value |
|-------|-------|
| Trigger Type | Action |
| Action ID | `mode-horror` |

**DO:**

| # | Action Type | Settings | Purpose |
|---|-------------|----------|---------|
| 1 | Stop Telling AI | Directive ID: `personality-override` | Remove the old personality directive |
| 2 | Tell AI | Directive ID: `personality-override`, content below, position: After Character | Inject the horror-style directive |
| 3 | Modify Variable | `current_mode` set to `horror` | Update the variable |
| 4 | Show Notification | Message: `Switched to Horror Mode`, style: danger | Use a danger-style notification — red fits the horror vibe |

**"Tell AI" directive content:**

```
[Narration Style: Horror Mode]
From now on, narrate everything with a dark, unsettling atmosphere. You should:
- Use slow, oppressive pacing for scene descriptions, focusing on sensory details (sounds, smells, textures)
- Hint that something is watching the character from the shadows, but never reveal it directly
- Make the environment itself feel wrong — doors close on their own, shadows move the wrong way, reflections in mirrors lag by half a beat
- Give NPCs dialogue with subtle wrongness, as if they know something they shouldn't
- Occasionally use second person to describe the character's physiological reactions (neck hairs standing up, heartbeat quickening, pupils dilating)
Build sustained tension, but don't throw a monster into every paragraph. True horror lives in the unknown.
```

---

#### Behavior 3: Switch back to Normal Mode

**WHEN:**

| Field | Value |
|-------|-------|
| Trigger Type | Action |
| Action ID | `mode-normal` |

**DO:**

| # | Action Type | Settings | Purpose |
|---|-------------|----------|---------|
| 1 | Stop Telling AI | Directive ID: `personality-override` | Remove the custom personality directive. Once removed, the system prompt no longer has a style override — the AI falls back to its default narration style |
| 2 | Modify Variable | `current_mode` set to `normal` | Update the variable |
| 3 | Show Notification | Message: `Restored Normal Mode`, style: info | Feedback |

> **Note:** Normal mode doesn't inject any directive. Just removing the previous override is enough — the AI reverts to whatever default style you defined in your character entries and system instructions.

---

### Step 3: Understand directive position and persistence

When configuring a "Tell AI" action, you'll see two important settings: **position** and **persistence / turn duration**. Here's what they mean.

#### Directive position

Position controls where the injected directive appears in the system prompt.

| Position | Label | Description | When to use |
|----------|-------|-------------|-------------|
| `auto` | Auto | Engine picks the best spot (usually after the character definition) | Good enough for most cases |
| `top` | Top | At the very beginning of the system prompt, highest priority | Urgent global rules (e.g., "From now on reply only in English") |
| `before_char` | Before Character | Before the character definition | Global settings that affect how the AI interprets the character |
| `after_char` | After Character | After the character definition | Style directives, tone adjustments (this recipe uses this one) |
| `bottom` | Bottom | At the very end of the system prompt | Last-minute reminders, "jailbreak"-style instructions |
| `depth` | Depth | Inserted by depth (before the Nth most recent message) | Directives that need to appear mid-conversation rather than in the system prompt |

**Why does this recipe use "After Character"?** Because personality-switching directives are style overrides for narration. Placed after the character definition, the AI reads "who I am" (character) first, then "how I should speak" (style directive). The order feels natural and produces the best results.

#### Persistence vs. temporary directives

| Setting | Description | Usage |
|---------|-------------|-------|
| Persistent (default) | Directive stays in the system prompt until explicitly removed by "Stop Telling AI" | This recipe uses this — mode stays active until the player switches again |
| Temporary (set turn duration) | Directive auto-expires after the specified number of turns | Good for one-off effects, e.g., "For the next 3 turns, the character is drunk and slurs their words" |

**Example:** If you set the turn duration to `3` in the "Tell AI" action, the directive automatically disappears at the end of the 3rd turn after injection — no manual removal needed.

---

### Step 4: Add mode-switching buttons to the Root Component

Show three mode buttons below the last message in the chat. The currently active mode button is highlighted.

Editor → **Custom UI** section → open `index.tsx` → paste the following (replace the default `return <Chat />`):

```tsx
export default function MyWorld() {
  const api = useYumina();

  // ---- Read current mode ----
  const currentMode = String(api.variables.current_mode || "normal");

  // ---- Three mode configs ----
  const modes = [
    {
      id: "normal",
      label: "Normal",
      actionId: "mode-normal",
      color: "#94a3b8",
      activeColor: "#e2e8f0",
      activeBg: "rgba(148,163,184,0.2)",
      border: "#475569",
      activeBorder: "#94a3b8",
    },
    {
      id: "comedy",
      label: "Comedy",
      actionId: "mode-comedy",
      color: "#fbbf24",
      activeColor: "#fef3c7",
      activeBg: "rgba(251,191,36,0.2)",
      border: "#a16207",
      activeBorder: "#fbbf24",
    },
    {
      id: "horror",
      label: "Horror",
      actionId: "mode-horror",
      color: "#f87171",
      activeColor: "#fecaca",
      activeBg: "rgba(248,113,113,0.2)",
      border: "#991b1b",
      activeBorder: "#f87171",
    },
  ];

  // ---- Message list, used to find the last one ----
  const msgs = api.messages || [];

  return (
    <Chat renderBubble={(msg) => {
      const isLastMsg = msg.messageIndex === msgs.length - 1;
      return (
    <div>
      {/* Render message text normally (platform already produced HTML — just use contentHtml) */}
      <div
        style={{ color: "#e2e8f0", lineHeight: 1.7 }}
        dangerouslySetInnerHTML={{ __html: msg.contentHtml }}
      />

      {/* Mode-switching buttons — only on the last message */}
      {isLastMsg && (
        <div style={{
          display: "flex",
          gap: "8px",
          marginTop: "16px",
          flexWrap: "wrap",
        }}>
          {modes.map((mode) => {
            const isActive = currentMode === mode.id;
            return (
              <button
                key={mode.id}
                onClick={() => {
                  if (!isActive) {
                    api.executeAction(mode.actionId);
                  }
                }}
                style={{
                  padding: "8px 16px",
                  background: isActive ? mode.activeBg : "transparent",
                  border: `2px solid ${isActive ? mode.activeBorder : mode.border}`,
                  borderRadius: "8px",
                  color: isActive ? mode.activeColor : mode.color,
                  fontSize: "13px",
                  fontWeight: isActive ? "700" : "500",
                  cursor: isActive ? "default" : "pointer",
                  opacity: isActive ? 1 : 0.7,
                  transition: "all 0.2s ease",
                }}
              >
                {isActive ? "● " : ""}{mode.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
      );
    }} />
  );
}
```

**Line-by-line breakdown:**

- `api.variables.current_mode` — reads the current mode variable's value
- `modes` — an array defining each mode's ID, display label, corresponding behavior action ID, and color configs
- `isActive` — checks whether the current mode matches this button's mode. If it matches, the button is highlighted; otherwise it's grayed out and semi-transparent
- `api.executeAction(mode.actionId)` — triggers the behavior we created in Step 2. Note it only fires when `!isActive` — if you're already in this mode, clicking does nothing
- `"● "` — the active button gets a small dot prefix as a visual indicator
- `transition: "all 0.2s ease"` — smooth animation when button state changes

::: tip Don't want to write code yourself? Use Studio AI
Editor top bar → click "Enter Studio" → AI Assistant panel → describe what you want in plain language, and the AI will generate the code for you.
:::

---

### Step 5: Save and test

1. Click **Save** at the top of the editor
2. Click **Start Game** or go back to the home page and start a new session
3. Chat normally with the AI for a few turns — you're in Normal mode
4. Click the **Comedy** button — the button highlights in gold, a notification says "Switched to Comedy Mode"
5. Send a message — the AI's reply should turn humorous, exaggerated, and might break the fourth wall
6. Click the **Horror** button — the button turns red-highlighted
7. Send another message — the AI's reply becomes dark, tense, and filled with unsettling hints
8. Click the **Normal** button — back to default style
9. Send one more message — confirm the AI has returned to normal narration

**If something goes wrong:**

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Can't see the mode buttons | Root Component code wasn't saved or has a syntax error | Check the compile status at the bottom of the Custom UI panel — it should show green "OK" |
| Clicking a button does nothing | Behavior action ID doesn't match the code | Confirm the behavior action IDs are `mode-comedy`, `mode-horror`, `mode-normal`, matching the `executeAction()` parameters in the code |
| Button state doesn't change | Variable isn't being updated by the behavior | Check that each behavior's "Modify Variable" action correctly sets `current_mode` |
| AI style doesn't change after switching | Directive content is empty or position is wrong | Check that the "Tell AI" action has directive content filled in, and position is set to "After Character" |
| Style sticks after switching back to Normal | "Stop Telling AI" directive ID doesn't match | Confirm all three behaviors use the same directive ID: `personality-override` |

---

## Advanced usage

### Adding more modes

Want to add a "Poetic Mode"? Just:

1. Add an entry to the `modes` array (ID, label, colors)
2. Create a new behavior with action ID `mode-poetic`, same action pattern as comedy/horror (remove old directive → inject new directive → update variable → notify)
3. Done. The button appears automatically in the Root Component

### Temporary "personality bursts" with turn-limited directives

Say you want a "Drunk Button" — click it and the AI talks in a drunken stupor for 3 turns, then automatically reverts:

In the "Tell AI" action, set the turn duration to `3`. The directive auto-expires after 3 turns — no need for the player to click again to cancel.

### Language switching

The same pattern works for switching the AI's reply language. Change the directive content to "From now on reply entirely in English" or "From now on reply in Japanese" and you've got a language switcher.

---

## Quick reference

| What you want | How to do it |
|---------------|-------------|
| Dynamically modify the AI's system prompt | Use "Tell AI" (`inject-directive`) in a behavior action — fill in directive ID, content, and position |
| Remove a previously injected directive | Use "Stop Telling AI" (`remove-directive`) — fill in the directive ID to remove |
| Auto-expire a directive after N turns | Set the turn duration in "Tell AI" |
| Keep a directive permanently (until manual removal) | Don't set a turn duration in "Tell AI" (default behavior) |
| Place a style directive after the character definition | Set position to "After Character" (`after_char`) |
| Put an urgent rule override at the top | Set position to "Top" (`top`) |
| Put a last-minute reminder at the end | Set position to "Bottom" (`bottom`) |
| Remove old directive before switching | Use the same directive ID — "Stop Telling AI" first, then "Tell AI" |
| Highlight the active button | Read the variable inside the Root Component and use conditional styles (`isActive`) to control highlighting |

---

## Try it yourself — importable demo world

Download this JSON and import it as a new world to see everything in action:

<a href="/recipe-11-demo.json" download>recipe-11-demo.json</a>

**How to import:**
1. Go to Yumina → **My Worlds** → **Create New World**
2. In the editor, click **More Actions** → **Import Package**
3. Select the downloaded `.json` file
4. A new world is created with all variables, behaviors, and the Root Component pre-configured
5. Start a new session and try it out

**What's included:**
- 1 variable (`current_mode` tracking the active personality mode)
- 3 behaviors (switch to Comedy / switch to Horror / restore Normal)
- A Root Component (three mode-switching buttons with highlight indicators)

---

::: tip This is Recipe #11
This recipe demonstrates the core usage of "Tell AI" / "Stop Telling AI" — dynamically injecting and removing directives in the system prompt. The same pattern can be used for language switching, difficulty adjustment, narrative perspective toggling (first person / third person), or even "gradual AI personality drift" (auto-injecting directives of varying intensity every few turns).
:::

</div>
