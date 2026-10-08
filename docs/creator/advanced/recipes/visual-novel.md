<div v-pre>

# Visual Novel Mode

> A full-screen visual novel: scene backgrounds, character sprites, a dialogue box and choice buttons, driven by variables the AI changes as the story moves. The interface code (`index.tsx`) draws the whole screen without `<Chat />` and puts `<MessageInput />` where the player types. Plain Tailwind and inline styles, no component library.

---

## Without code

Several parts of a visual novel no longer need interface code:

- **Character portraits**: on the canvas, right-click a character's lore entry and pick **Portrait…**. In chat, that picture and the character's name appear above every line they speak. See [Visuals & audio](/creator/visuals-audio#character-portraits)
- **A book-like text style**: in the [Player interface](/creator/player-view), select the **Conversation** block and set **Message look** to **Novel**
- **A background or sprite that follows a variable**: in the Player interface, add an **Image** part and set its **Picture** to **Follows "&lt;variable&gt;"**. It shows whatever `@asset:` reference the variable holds, so when the AI changes the variable, the picture changes
- **Pictures at story moments**: [scene images](/creator/visuals-audio#scene-images) show up by themselves when their **When to show it** sentence holds
- **Choice buttons**: Player interface buttons with a **Say a line for the player** step

The rest of this page builds the whole screen in code, for when you want a dialogue box that reads the reply and splits narration from dialogue, choice buttons taken from the reply text, and full control over the layout.

---

## What you'll build

A fullscreen visual novel interface:

- **Scene backgrounds** — the AI switches background images by changing a variable (classroom, street, night sky...), and the interface code shows it as a fullscreen `background-image`
- **Character sprites** — the AI sets the current speaker and emotion, and the interface code shows the matching sprite in the center of the screen
- **Dialogue box** — a semi-transparent box at the bottom of the screen shows the character name and dialogue. *Italic text* is treated as narration/inner monologue; plain text is character dialogue
- **Choice buttons** — when the AI offers choices, the interface code overlays clickable buttons on screen
- **Fullscreen mode** — the interface code returns its own fullscreen layout without nesting `<Chat />`, so there are no regular chat bubbles at all

### How it works

The AI controls the screen with directives in every response:

```
AI's response:
[current_bg: set "@asset:your-classroom-reference"]
[current_speaker: set "Yuki"]
[speaker_emotion: set "happy"]

*The classroom is bathed in morning light. Cherry blossom petals occasionally drift in through the window.*

Yuki turns to face you with a smile:

Good morning! You're here early today.
```

After the engine parses these directives:
1. `current_bg` becomes the classroom picture → the interface code swaps `background-image` to the classroom
2. `current_speaker` becomes `"Yuki"` → the dialogue box displays the name "Yuki"
3. `speaker_emotion` becomes `"happy"` → the interface code looks up Yuki's happy sprite and shows it
4. The interface code parses the latest message's text — *italic* sections render as narration, plain text renders as character dialogue

```
Engine processing flow:
  AI response → engine extracts directives → updates variables → interface code reads variables and redraws
    → background layer: <div style={{ backgroundImage: ... }} />
    → sprite layer: <img src={SPRITES[speaker + "_" + emotion]} />
    → dialogue box layer: distinguishes narration (gray italic) vs. dialogue (white upright)
    → choice layer: buttons appear when show_choices = true
```

---

## Step by step

### Step 1: Create the variables

You need 4 variables to control the visual novel display.

On the canvas, click **＋ Variable** in the **Add** row at the bottom of the card, once for each. Give each the name below; the interface code and the AI both find a variable by its name.

#### Variable 1: Current Background

| Field | Value | Why |
|-------|-------|-----|
| Variable name | `current_bg` | The AI writes `[current_bg: set "..."]` to switch backgrounds; the code reads `api.variables.current_bg` |
| Type | Text | The value is an `@asset:` reference or an image URL |
| Starts at | The `@asset:` reference of your first scene's background | What a new session shows before the AI changes anything. Fill it in after Step 3 |
| Behavior Rules | `The scene's background picture. Change it whenever the scene moves to a different place, using the matching reference from the asset table.` | Tells the AI when to change it and which values to use |

#### Variable 2: Current Speaker

| Field | Value | Why |
|-------|-------|-----|
| Variable name | `current_speaker` | The AI writes `[current_speaker: set "name"]` to switch speakers |
| Type | Text | The value is a character name |
| Starts at | `Narrator` | Starts in narration mode — no specific character speaking |
| Behavior Rules | `Who is speaking right now. Set it to the character's name when a character speaks, and to "Narrator" for narration or inner monologue.` | Tells the AI the usage rules |

#### Variable 3: Speaker Emotion

| Field | Value | Why |
|-------|-------|-----|
| Variable name | `speaker_emotion` | The AI writes `[speaker_emotion: set "happy"]` to switch expressions |
| Type | Text | The value is an emotion keyword |
| Starts at | `neutral` | Starts with a neutral expression |
| Behavior Rules | `The speaking character's expression. Only one of: neutral, happy, sad, angry, surprised, shy. Update it whenever the expression changes.` | Listing the emotions stops the AI from inventing expressions you have no sprite for |

#### Variable 4: Show Choices

| Field | Value | Why |
|-------|-------|-----|
| Variable name | `show_choices` | The AI writes `[show_choices: set true]` to show choice buttons |
| Type | Switch | Only two states: show/hide |
| Starts at | Off | Choice buttons are hidden by default |
| Behavior Rules | `Switch it on when you offer the player a choice. Keep it off otherwise.` | Tells the AI to only enable this when a player choice is needed |

You don't need to teach the AI the `[name: set value]` format; the engine does that. The Behavior Rules only say when each value changes.

::: info The AI never runs code
The AI writes directives, the engine applies them to variables, and the interface code reads the variables and redraws: AI writes directives → engine parses → variables update → interface code re-renders.
:::

---

### Step 2: Add a lore entry with the VN instructions

The AI needs to know it's writing for a visual novel screen and how to format its text.

In the **Character and world** block on the canvas (sent every turn), click the **＋** in the block's top right and add an entry:

| Field | Value | Why |
|-------|-------|-----|
| Name | Visual Novel System Instructions | For your own reference |
| When the AI sees this | Character and world (every turn) | The format rules apply to every reply |

Content:

```
[Visual Novel Mode]
You are generating content for a visual novel engine. Every response must include directives to control the screen.

Format rules:
1. Set the scene with directives at the start of your response:
   [current_bg: set "backgroundReference"]
   [current_speaker: set "characterName"]
   [speaker_emotion: set "emotion"]

2. Text formatting:
   - *Italic text* = narration or inner monologue. Use for describing environments, character actions, inner thoughts.
   - Plain text (no formatting) = character dialogue/speech.
   - Do not wrap dialogue in quotation marks — just write plain text.

3. When you want to give the player a choice:
   - Use [show_choices: set true]
   - List choices at the end of the text in this format:
     A) Choice text
     B) Choice text
     C) Choice text

4. Each response should contain only one scene fragment (3-5 sentences). Keep the pacing tight, like a real visual novel.

5. Available emotions: neutral, happy, sad, angry, surprised, shy

6. Always update current_bg when switching scenes. Always update current_speaker and speaker_emotion when a character speaks.
```

The AI doesn't know how your interface code reads its text, so spell out the format: italic for narration, plain text for dialogue. Otherwise it may format freely and the code can't tell narration from dialogue.

---

### Step 3: Prepare and upload assets

A visual novel needs background images and character sprites. Two ways to provide them:

- **Option A (recommended)**: Upload them to Yumina's asset library and use `@asset:` references. They're stable and won't expire
- **Option B**: Use external `https://` image URLs (your own server, an image host). Simpler, but the link can break

#### Uploading assets to Yumina

1. Open **Panels → Assets**
2. **Drag and drop** your image files into it, or click **Upload**
3. Each uploaded file gets an `@asset:` reference (like `@asset:a1b2c3d4-e5f6-7890`)
4. Use **Copy ref** on an asset to copy its reference

> **What is an `@asset:` reference?** It's Yumina's internal asset identifier. In interface code, `<img src="@asset:xxx" />` and `@asset:` inside inline styles are turned into real CDN URLs when they're drawn, and `api.resolveAssetUrl("@asset:xxx")` gives you the URL as a string. Variables can hold `@asset:` values too.

#### Recommended assets to prepare

**Backgrounds (16:9 ratio recommended, 1920×1080 or higher):**

| Scene | Suggested filename | Purpose |
|-------|--------------------|---------|
| Classroom (daytime) | `classroom_morning.jpg` | Class, conversation scenes |
| School hallway | `hallway.jpg` | Transition scenes |
| Street (evening) | `street_evening.jpg` | After-school scenes |
| Bedroom (night) | `room_night.jpg` | Nighttime scenes |

After uploading, note each background's `@asset:` reference. You'll put these in the lore entry so the AI knows which reference goes with which scene.

**Character sprites (transparent PNG recommended, 1000px+ height):**

Prepare one sprite per character and expression. Name them consistently, `characterName_emotion.png`, so they're easy to match up in Step 5.

| Character | Example filename | Example reference |
|-----------|------------------|-------------------|
| Yuki (happy) | `yuki_happy.png` | `@asset:abc123...` |
| Yuki (sad) | `yuki_sad.png` | `@asset:def456...` |
| Teacher (neutral) | `teacher_neutral.png` | `@asset:ghi789...` |

#### Tell the AI which backgrounds to use

Add a reference table to the VN instructions entry from Step 2, so the AI knows which `@asset:` reference goes with which scene. Sprites don't go here: the AI only sets the speaker and emotion, and your code picks the sprite.

```
[Background Reference Table]
- Classroom daytime: @asset:your-classroom-reference
- School hallway: @asset:your-hallway-reference
- Street evening: @asset:your-street-reference
- Bedroom night: @asset:your-bedroom-reference

When switching backgrounds, use the references above as values. For example:
[current_bg: set "@asset:your-classroom-reference"]
```

Now go back to `current_bg` and set **Starts at** to the classroom reference.

::: tip No assets yet? You can still test
The interface code shows a solid color background when there's no image. Get the logic working first and add assets later. Stock image `https://` URLs work for quick prototyping.
:::

---

### Step 4: Write the opening

The opening is the visual novel's first scene. On the canvas, click the opening's row and write it:

```
*The first day of April. The tail end of cherry blossom season.*

*You push open the classroom door. The familiar smell of chalk dust and wood hits you. Most seats are still empty — ten minutes until class starts.*

*In the seat by the window, a girl you've never seen before is quietly gazing outside.*

*A transfer student? You don't remember anyone like her in your class.*
```

The opening doesn't set variables with directives. A new session starts from each variable's **Starts at** value, which is why `current_bg` already points at the classroom. If you add more openings that start somewhere else, drag an opening onto a variable on the canvas to give it its own starting value for that opening (see [Openings and lore](/creator/entries#openings)).

---

### Step 5: Write the visual novel interface code

The interface code takes over the entire screen. Instead of nesting `<Chat />`, it paints its own background, sprites, dialogue box, and choice buttons. Player input is handled by `<MessageInput />` placed at the bottom of the screen.

Open **Panels → Front End Code** → `index.tsx` and replace its contents with the following. Fill in `SPRITES` with your own references from Step 3:

```tsx
// Sprite for each "name_emotion" (lowercase name). Copy the refs from Panels → Assets.
const SPRITES = {
  yuki_neutral: "@asset:your-yuki-neutral-reference",
  yuki_happy: "@asset:your-yuki-happy-reference",
  yuki_sad: "@asset:your-yuki-sad-reference",
  teacher_neutral: "@asset:your-teacher-reference",
};

export default function MyWorld() {
  const api = useYumina();
  const renderMarkdown = api.renderMarkdown;
  const msgs = api.messages || [];
  const lastMsg = msgs[msgs.length - 1];
  const content = lastMsg ? String(lastMsg.content || "") : "";

  // ---- Read variables ----
  const bgRef = String(api.variables.current_bg || "");
  const bgUrl = bgRef ? api.resolveAssetUrl(bgRef) : "";
  const speaker = String(api.variables.current_speaker || "Narrator");
  const emotion = String(api.variables.speaker_emotion || "neutral");
  const showChoices = Boolean(api.variables.show_choices);

  // ---- Clean content: strip directive lines, keep only narrative text ----
  const cleanContent = content
    .split("\n")
    .filter((line) => !line.trim().match(/^\[.+:\s*(set|add|subtract|multiply|toggle|append|merge|push|delete)\s+.+\]$/) && !line.trim().match(/^\[.+:\s*[+-]?\d+\]$/))
    .join("\n")
    .trim();

  // ---- Parse text: distinguish narration (italic) from dialogue (plain text) ----
  // Split text into paragraphs and classify each one
  const paragraphs = cleanContent
    .split("\n\n")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const parsed = paragraphs.map((p) => {
    // If the entire paragraph is wrapped in *, or every line starts with *, it's narration
    const isNarration = /^\*[^*].*[^*]\*$/.test(p.trim())
      || p.trim().startsWith("*");
    // Check if it's a choice line (A) B) C) format)
    const isChoice = /^[A-Z]\)\s/.test(p.trim());
    return { text: p, isNarration, isChoice };
  });

  // ---- Sprite (looked up from the character name and emotion) ----
  const spriteRef = speaker !== "Narrator"
    ? SPRITES[`${speaker.toLowerCase()}_${emotion}`]
    : null;
  const spriteUrl = spriteRef ? api.resolveAssetUrl(spriteRef) : null;

  // ---- Extract choices ----
  const choices = parsed
    .filter((p) => p.isChoice)
    .map((p) => p.text.replace(/^[A-Z]\)\s*/, ""));

  // ---- Render ----
  return (
    <div style={{
      position: "relative",
      width: "100%",
      minHeight: "500px",
      borderRadius: "12px",
      overflow: "hidden",
      background: "#000",
    }}>
      {/* ===== Background layer ===== */}
      <div style={{
        position: "absolute",
        inset: 0,
        backgroundImage: bgUrl ? `url(${bgUrl})` : "linear-gradient(135deg, #1e293b, #0f172a)",
        backgroundSize: "cover",
        backgroundPosition: "center",
        filter: "brightness(0.7)",
        transition: "background-image 0.8s ease",
      }} />

      {/* ===== Character sprite layer ===== */}
      {spriteUrl && (
        <div style={{
          position: "absolute",
          bottom: "120px",
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 2,
          transition: "opacity 0.5s ease",
        }}>
          <img
            src={spriteUrl}
            alt={`${speaker} - ${emotion}`}
            style={{
              maxHeight: "350px",
              objectFit: "contain",
              filter: "drop-shadow(0 4px 12px rgba(0,0,0,0.5))",
            }}
            onError={(e) => { e.target.style.display = "none"; }}
          />
        </div>
      )}

      {/* ===== Dialogue box layer ===== */}
      <div style={{
        position: "absolute",
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 3,
        background: "linear-gradient(transparent, rgba(0,0,0,0.85) 30%)",
        padding: "60px 24px 24px",
      }}>
        {/* Character name label */}
        {speaker !== "Narrator" && (
          <div style={{
            display: "inline-block",
            padding: "4px 16px",
            marginBottom: "8px",
            background: "rgba(99,102,241,0.8)",
            borderRadius: "6px 6px 0 0",
            color: "#e0e7ff",
            fontSize: "14px",
            fontWeight: "bold",
            letterSpacing: "0.05em",
          }}>
            {speaker}
          </div>
        )}

        {/* Text content */}
        <div style={{
          background: "rgba(15,23,42,0.9)",
          borderRadius: speaker !== "Narrator" ? "0 12px 12px 12px" : "12px",
          padding: "16px 20px",
          border: "1px solid rgba(148,163,184,0.2)",
          minHeight: "80px",
        }}>
          {parsed
            .filter((p) => !p.isChoice)
            .map((p, i) => (
              <p key={i} style={{
                margin: i > 0 ? "10px 0 0" : "0",
                color: p.isNarration ? "#94a3b8" : "#e2e8f0",
                fontStyle: p.isNarration ? "italic" : "normal",
                fontSize: "15px",
                lineHeight: 1.8,
              }}
              dangerouslySetInnerHTML={{
                __html: renderMarkdown(
                  p.isNarration
                    ? p.text.replace(/^\*|\*$/g, "")
                    : p.text
                ),
              }}
              />
            ))
          }
        </div>
      </div>

      {/* ===== Choice button layer ===== */}
      {showChoices && choices.length > 0 && (
        <div style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          zIndex: 4,
          display: "flex",
          flexDirection: "column",
          gap: "10px",
          width: "80%",
          maxWidth: "400px",
        }}>
          {choices.map((choice, i) => (
            <button
              key={i}
              onClick={() => {
                api.setVariable("show_choices", false);
                api.sendMessage(choice);
              }}
              style={{
                padding: "14px 20px",
                background: "rgba(30,27,75,0.9)",
                border: "1px solid rgba(99,102,241,0.6)",
                borderRadius: "10px",
                color: "#c7d2fe",
                fontSize: "15px",
                fontWeight: "600",
                cursor: "pointer",
                textAlign: "left",
                transition: "all 0.2s ease",
                backdropFilter: "blur(8px)",
              }}
              onMouseEnter={(e) => {
                e.target.style.background = "rgba(67,56,202,0.8)";
                e.target.style.borderColor = "#818cf8";
              }}
              onMouseLeave={(e) => {
                e.target.style.background = "rgba(30,27,75,0.9)";
                e.target.style.borderColor = "rgba(99,102,241,0.6)";
              }}
            >
              {choice}
            </button>
          ))}
        </div>
      )}

      {/* ===== Player input layer ===== */}
      {/* No <Chat /> wrapper — drop <MessageInput /> in directly so the player can still type */}
      <div style={{
        position: "absolute",
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 5,
      }}>
        <MessageInput />
      </div>
    </div>
  );
}
```

**Block-by-block explanation:**

- **Clean content** — `cleanContent` filters out directive lines like `[current_bg: set "xxx"]` (matching all operation types: set/add/subtract/multiply/toggle/append/merge/push/delete, plus shorthand directives like `[hp: -10]`). Directives have already been parsed by the engine, so the component doesn't need to display them
- **Parse paragraphs** — splits text on blank lines into paragraphs, classifying each as narration (starts with `*`), dialogue (plain text), or a choice (starts with `A)` format)
- **Background layer** — uses `backgroundImage` to display the current scene background. `filter: brightness(0.7)` darkens it slightly to keep foreground text readable. `transition` adds a crossfade animation when switching backgrounds
- **Sprite layer** — looks up the sprite in `SPRITES` by `speaker` and `emotion`. `onError` hides images that fail to load. No sprite is shown in Narrator mode or when there's no entry for that name and emotion
- **Dialogue box layer** — a semi-transparent box at the bottom. When `speaker` is not "Narrator", a character name label appears above the dialogue box. Narration text is gray and italic; dialogue text is white and upright
- **Choice button layer** — when `show_choices` is `true` and the text contains choices in `A)` `B)` `C)` format, buttons appear centered on screen. Clicking a button hides the choices (`show_choices` set to `false`) and sends the player's selection

::: tip Sprite lookup
`SPRITES` keys are the lowercase character name, an underscore, and the emotion: `yuki_happy`. Add a row for every sprite you uploaded. If a character name isn't plain ASCII, use any key you like and tell the AI to write that exact name in `current_speaker`. A value can also be an `https://` URL.
:::

---

### Step 6: Full-screen layout or chat with custom bubbles

The code above returns its own layout, so it fills the screen. The root element uses `width: "100%"` and `minHeight: "500px"`; use `100vh` if you want it to always fill the window. There's no separate fullscreen switch.

Two patterns side by side:
- **Normal chat + custom bubble**: `return <Chat renderBubble={...} />` — keep the platform's chat shell, just restyle the bubbles
- **Pure visual novel (this recipe)**: `return <div>...all VN elements...<MessageInput /></div>` — no `<Chat />` at all; your code draws everything

> **Switching between chat and VN**: for "normal chat most of the time, VN during special moments", branch inside the interface code on a variable (say `vn_mode`). Return `<Chat />` when it's off and the VN layout when it's on. The AI or a behavior flips the variable, and the screen swaps mid-session.

---

### Step 7: How the AI drives the screen — directive examples

Here is how the AI's replies change the screen during play.

**Scene 1: Opening (Narrator mode)**

AI's response:
```
[current_bg: set "@asset:your-classroom-reference"]
[current_speaker: set "Narrator"]
[speaker_emotion: set "neutral"]

*An April morning. The air carries the sweet scent of cherry blossoms.*

*You walk into the classroom and find a girl you don't recognize sitting by the window. She's resting her chin on her hand, staring outside, lost in thought.*
```

Rendered result: classroom background + no sprite + gray italic narration text.

**Scene 2: Character dialogue**

AI's response:
```
[current_speaker: set "Yuki"]
[speaker_emotion: set "surprised"]

*She seems to notice you looking and turns her head.*

Oh, hello. Are you in this class too?

[speaker_emotion: set "shy"]

Sorry, I just transferred here today... I don't really know anyone yet.
```

Rendered result: background unchanged (no `current_bg` directive means it keeps the previous value) + Yuki's sprite with the last expression in the reply (shy) + dialogue box displays the name "Yuki" + italic narration and upright dialogue alternate.

**Scene 3: Giving the player a choice**

AI's response:
```
[current_speaker: set "Narrator"]
[show_choices: set true]

*Yuki looks at you, a hint of expectation in her eyes.*

*What do you do?*

A) Introduce yourself and start a conversation
B) Nod briefly and head back to your seat
C) Offer to show her around the classroom and school
```

Rendered result: narration text + three clickable buttons appear in the center of the screen. When the player clicks one, the buttons disappear and the selected text is sent as the player's reply to the AI.

**Scene 4: Scene transition**

AI's response:
```
[current_bg: set "@asset:your-hallway-reference"]
[current_speaker: set "Narrator"]

*The bell rings. The hallway instantly comes alive as students stream out in pairs and small groups.*

[current_speaker: set "Yuki"]
[speaker_emotion: set "happy"]

Want to have lunch on the rooftop together? I found a really nice spot.
```

Rendered result: background transitions to the hallway (with a crossfade animation) + narration + Yuki's happy sprite + dialogue.

---

### Step 8: Italic narration vs. plain dialogue — parsing rules

The interface code distinguishes two types of text with a simple rule:

| Format | Recognized As | Display Style | Purpose |
|--------|--------------|---------------|---------|
| `*This is italic text*` | Narration | Gray (#94a3b8), italic | Environment descriptions, character actions, inner monologue |
| `This is plain text` | Dialogue | White (#e2e8f0), upright | What the character says |
| `A) Choice text` | Choice | Button | Clickable player selection |

The AI has already been told these rules in the lore entry. If it occasionally gets the format wrong (e.g., uses italic for dialogue), anything that doesn't start with `*` is treated as dialogue, so nothing breaks.

> **Why italics rather than `>` blockquotes or `**bold**`?** Most models already use italics for narration and actions in roleplay, so it's the format they follow most reliably.

---

### Step 9: Save and test

1. Click **Save** in the top bar
2. Click **Play** to start a playtest (playtests use credits)
3. You should see a fullscreen VN display — background + dialogue box + opening narration
4. Type a message in the input box (e.g., "Say hello to her")
5. The AI's response should include directives — the background might change, a character appears, and dialogue shows in the box
6. If the AI offers choices, buttons appear in the center of the screen. Click one to try it
7. Continue the conversation and watch whether the AI updates `current_bg` when switching scenes, and `current_speaker` and `speaker_emotion` when characters speak. **This turn** in the playtest shows why a value changed or didn't

**If something goes wrong:**

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Background is black or a plain gradient | `current_bg` is empty or not a valid image reference | Check the variable's value in the playtest. It should be an `@asset:` reference from **Panels → Assets** or an `https://` URL |
| No sprite visible | No `SPRITES` entry for that name and emotion | Check that the key is the lowercase name + `_` + emotion (`yuki_happy`) and that the reference is right |
| Directive lines show on screen | Directive format is non-standard and the regex didn't match | Confirm the format is `[variableName: set "value"]` — note the space after the colon |
| All text is narration / all text is dialogue | The AI isn't following the format rules | Check that the lore entry's format instructions are clear. You can reinforce them in the Behavior Rules |
| Choice buttons don't appear | `show_choices` wasn't set to `true`, or there are no `A)` format choices | Check that the AI's response includes `[show_choices: set true]` and choices in `A)` format |
| Screen isn't fullscreen | The root element doesn't fill the visible area | Add `minHeight: "100vh"` or `height: "100%"` to the outermost div |
| Nothing renders | A compile error | **Panels → Front End Code** shows **Error** with the message; fix the line it points to |

---

## Advanced tips

### Multi-character dialogue

You can switch between multiple characters in the same response:

```
[current_speaker: set "Yuki"]
[speaker_emotion: set "happy"]
The weather is so nice today!

[current_speaker: set "Teacher"]
[speaker_emotion: set "neutral"]
Alright everyone, class is starting. Please take your seats.

[current_speaker: set "Narrator"]
*The classroom falls silent in an instant.*
```

The engine applies these in order, so the screen ends up showing the sprite of the last `current_speaker`. To show each segment with its own character's sprite, change the code to read the nearest preceding `[current_speaker: set ...]` directive for each paragraph (from the message's raw text).

### Transition effects

The background layer's CSS includes `transition: background-image 0.8s ease`, giving background switches a crossfade effect. You can also use different transitions for different scene types:

- Normal switch: crossfade (already implemented)
- Flashback/memory: add a white flash overlay
- Tense scene: add a screen shake animation

### Pairing with sound and BGM

Give each scene its own music. Either use **Conditional BGM** on the audio tracks (play the hallway theme while `current_bg` is the hallway reference; see [Audio Design](../audio-deep.md)), or add a behavior: **When it fires** → **Variable changes** on `current_bg`, **ONLY IF** `current_bg` equals the scene's reference, effect **Play music**. The [day/night cycle recipe](./day-night.md) uses the same idea for time of day.

---

## Quick reference

| What you want | How to do it |
|---------------|-------------|
| Switch background | AI sends `[current_bg: set "@asset:..."]` |
| Switch speaker | AI sends `[current_speaker: set "characterName"]` |
| Switch expression | AI sends `[speaker_emotion: set "emotion"]` |
| Show choice buttons | AI sends `[show_choices: set true]` + choices in `A) B) C)` format |
| Distinguish narration from dialogue | `*italic*` = narration, plain text = dialogue |
| Fullscreen VN experience | `index.tsx` returns the VN layout directly (no `<Chat />`), with `<MessageInput />` at the bottom for player input |
| Character sprites | Upload them to **Panels → Assets** and list their refs in `SPRITES` as `name_emotion` |
| Send message when player clicks a choice | Button `onClick` calls `api.sendMessage(choiceText)` |
| Portraits, a background that follows a variable, choice buttons, without code | Lore entry → **Portrait…**; Player interface **Image** part set to **Follows** a variable; Player interface buttons |

</div>
