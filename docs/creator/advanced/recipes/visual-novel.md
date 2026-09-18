<div v-pre>

# Visual Novel Mode

> Turn the chat interface into a full visual novel — scene backgrounds, character sprites, dialogue boxes, choice buttons, all driven by AI directives. The Root Component (`index.tsx`) takes over the entire screen: no more `<Chat />`, just your own fullscreen layout with `<MessageInput />` embedded wherever the player needs to speak. Plain Tailwind + inline styles — no prebuilt component library required.

---

## What you'll build

A fullscreen visual novel interface:

- **Scene backgrounds** — the AI switches background images via directives (classroom, street, night sky...), and the Root Component displays them as a fullscreen `background-image`
- **Character sprites** — the AI sets the current speaker and emotion via directives, and the Root Component renders the matching `<img>` sprite in the center of the screen
- **Dialogue box** — a semi-transparent box at the bottom of the screen shows the character name and dialogue. *Italic text* is automatically treated as narration/inner monologue; plain text is character dialogue
- **Choice buttons** — when the AI offers choices, the Root Component overlays clickable buttons on screen
- **Fullscreen mode** — the Root Component returns its own fullscreen layout without nesting `<Chat />`, so there are no regular chat bubbles at all

### How it works

The AI controls the screen with directives in every response:

```
AI's response:
[current_bg: set "classroom_morning.jpg"]
[current_speaker: set "Yuki"]
[speaker_emotion: set "happy"]

*The classroom is bathed in morning light. Cherry blossom petals occasionally drift in through the window.*

Yuki turns to face you with a smile:

Good morning! You're here early today.
```

After the engine parses these directives:
1. `current_bg` becomes `"classroom_morning.jpg"` → the Root Component swaps `background-image` to a classroom
2. `current_speaker` becomes `"Yuki"` → the dialogue box displays the name "Yuki"
3. `speaker_emotion` becomes `"happy"` → the Root Component assembles the sprite path from `speaker + emotion` and renders it
4. The Root Component parses the latest message's text — *italic* sections render as narration, plain text renders as character dialogue

```
Engine processing flow:
  AI response → engine extracts directives → updates variables → Root Component reads variables and redraws
    → background layer: <div style={{ backgroundImage: ... }} />
    → sprite layer: <img src={`/sprites/${speaker}_${emotion}.png`} />
    → dialogue box layer: distinguishes narration (gray italic) vs. dialogue (white upright)
    → choice layer: buttons appear when show_choices = true
```

---

## Step by step

### Step 1: Create the variables

You need 4 variables to control the visual novel display.

Editor → sidebar → **Variables** tab → click "Add Variable" for each one

#### Variable 1: Current Background

| Field | Value | Why |
|-------|-------|-----|
| Name | Current Background | For your own reference |
| ID | `current_bg` | The AI uses `[current_bg: set "xxx"]` to switch backgrounds |
| Type | String | The value is an image URL or filename |
| Default Value | `default_bg.jpg` | The default background when a new session starts. Replace with your own image URL |
| Category | Custom | Dedicated VN system category |
| Behavior Rules | `Use [current_bg: set "imageURL"] to switch the scene background. Update this variable whenever the scene changes.` | Tells the AI when and how to change this variable |

#### Variable 2: Current Speaker

| Field | Value | Why |
|-------|-------|-----|
| Name | Current Speaker | For your own reference |
| ID | `current_speaker` | The AI uses `[current_speaker: set "name"]` to switch speakers |
| Type | String | The value is a character name |
| Default Value | `Narrator` | Defaults to narration mode — no specific character speaking |
| Category | Custom | Dedicated VN system category |
| Behavior Rules | `Use [current_speaker: set "characterName"] to set the current speaker. Set to "Narrator" for narration or inner monologue.` | Tells the AI the usage rules |

#### Variable 3: Speaker Emotion

| Field | Value | Why |
|-------|-------|-----|
| Name | Speaker Emotion | For your own reference |
| ID | `speaker_emotion` | The AI uses `[speaker_emotion: set "happy"]` to switch expressions |
| Type | String | The value is an emotion keyword |
| Default Value | `neutral` | Defaults to a neutral expression |
| Category | Custom | Dedicated VN system category |
| Behavior Rules | `Use [speaker_emotion: set "emotion"] to change the character's expression. Available emotions: neutral, happy, sad, angry, surprised, shy. Update whenever the character's emotion changes.` | Listing available emotions prevents the AI from inventing nonexistent expressions |

#### Variable 4: Show Choices

| Field | Value | Why |
|-------|-------|-----|
| Name | Show Choices | For your own reference |
| ID | `show_choices` | The AI uses `[show_choices: set true]` to show choice buttons |
| Type | Boolean | Only two states: show/hide |
| Default Value | `false` | Choice buttons are hidden by default |
| Category | Custom | Dedicated VN system category |
| Behavior Rules | `Use [show_choices: set true] when you want to offer the player a choice. Keep it false otherwise.` | Tells the AI to only enable this when a player choice is needed |

::: info Why let the AI control the screen with directives?
This is Yumina's core design — the AI doesn't execute code. Instead, it uses structured directives to tell the engine what to do. The engine parses directives, updates variables, and the Root Component reads variables to update the screen. The full chain is: AI writes directives → engine parses → variables update → Root Component re-renders.
:::

---

### Step 2: Create a knowledge entry — VN system instructions

The AI needs to know it's in a visual novel environment and how to use directives to control the screen.

Editor → **Lorebook** tab → create a new entry

| Field | Value | Why |
|-------|-------|-----|
| Name | Visual Novel System Instructions | For your own reference |
| Section | Presets | Entries in the Presets section are sent to the AI every time |
| Enabled | **Yes** (toggle on) | Always active |

Content:

```
[Visual Novel Mode]
You are generating content for a visual novel engine. Every response must include directives to control the screen.

Format rules:
1. Set the scene with directives at the start of your response:
   [current_bg: set "backgroundImageURL"]
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

> **Why so detailed?** Because the AI doesn't know how your Root Component works. You have to explicitly tell it "italic = narration, plain text = dialogue" — otherwise the AI might use random formatting, and the component won't be able to distinguish narration from dialogue correctly.

---

### Step 3: Prepare and upload assets

A visual novel needs background images and character sprites. Two ways to provide them:

- **Option A (recommended)**: Upload to Yumina's asset system, get `@asset:` references — stable, won't expire
- **Option B**: Use external image URLs (imgur, your own server) — simpler but may break

#### Uploading assets to Yumina

1. Open the editor → sidebar → **Assets** tab
2. **Drag and drop** your image files into the upload area (or click to browse)
3. After upload, each file gets an `@asset:` reference (like `@asset:a1b2c3d4-e5f6-7890`)
4. Click an uploaded asset to **copy its reference**

> **What is an `@asset:` reference?** It's Yumina's internal asset identifier. In the Root Component's TSX code, `<img src="@asset:xxx" />` is automatically resolved to a real CDN URL at render time. You don't need to convert it manually — the component handles it. Variables can also store `@asset:xxx` values and they'll be auto-resolved too.

#### Recommended assets to prepare

**Backgrounds (16:9 ratio recommended, 1920×1080 or higher):**

| Scene | Suggested filename | Purpose |
|-------|--------------------|---------|
| Classroom (daytime) | `classroom_morning.jpg` | Class, conversation scenes |
| School hallway | `hallway.jpg` | Transition scenes |
| Street (evening) | `street_evening.jpg` | After-school scenes |
| Bedroom (night) | `room_night.jpg` | Nighttime scenes |

After uploading, note each background's `@asset:` reference. You'll put these in a knowledge entry so the AI knows which reference goes with which scene.

**Character sprites (transparent PNG recommended, 1000px+ height):**

Prepare multiple expression sprites per character. Use a consistent naming format: `characterName_emotion.png`.

| Character | Example filenames | Example reference |
|-----------|-------------------|-------------------|
| Yuki (happy) | `yuki_happy.png` | `@asset:abc123...` |
| Yuki (sad) | `yuki_sad.png` | `@asset:def456...` |
| Teacher (neutral) | `teacher_neutral.png` | `@asset:ghi789...` |

#### Tell the AI which assets to use

After uploading, add an asset reference table to the VN system instruction entry you created in Step 2. This tells the AI which `@asset:` reference corresponds to which scene or character:

```
[Asset Reference Table]
Backgrounds:
- Classroom daytime: @asset:your-classroom-reference
- School hallway: @asset:your-hallway-reference
- Street evening: @asset:your-street-reference

Character sprites (format: @asset:reference):
- Yuki happy: @asset:your-yuki-happy-reference
- Yuki sad: @asset:your-yuki-sad-reference
- Teacher neutral: @asset:your-teacher-reference

When using directives, use the @asset: references above as values. For example:
[current_bg: set "@asset:your-classroom-reference"]
```

> The AI reads this table and uses the correct `@asset:` references in its directives. The Root Component automatically converts `@asset:` to real image URLs when displaying.

::: tip No assets yet? You can still test
The Root Component shows a solid color background when images fail to load. Get the logic working first — add assets later. You can also use free stock image URLs instead of `@asset:` references for quick prototyping.
:::

---

### Step 4: Write the first message

The first message is the visual novel's opening. It needs directives to set up the initial screen.

Editor → **First Message** tab → create a first message

```
[current_bg: set "classroom_morning.jpg"]
[current_speaker: set "Narrator"]
[speaker_emotion: set "neutral"]

*The first day of April. The tail end of cherry blossom season.*

*You push open the classroom door. The familiar smell of chalk dust and wood hits you. Most seats are still empty — ten minutes until class starts.*

*In the seat by the window, a girl you've never seen before is quietly gazing outside.*

[current_speaker: set "Narrator"]
*A transfer student? You don't remember anyone like her in your class.*
```

> **Why put directives in the first message too?** Because the Root Component relies on variables to decide what to display. The first message's directives get parsed by the engine, setting up the initial background and character state. Without directives, the defaults kick in (`default_bg.jpg` + `Narrator` + `neutral`), but the screen might not match the opening scene.

---

### Step 5: Write the visual novel Root Component

This is the core step. The Root Component takes over the entire screen — instead of nesting `<Chat />`, it paints its own background, sprites, dialogue box, and choice buttons. Player input is handled by `<MessageInput />` placed at the bottom of the screen.

Editor → **Custom UI** section → open `index.tsx` → paste the following (replace the default `return <Chat />`):

```tsx
export default function MyWorld() {
  const api = useYumina();
  const renderMarkdown = api.renderMarkdown;
  const msgs = api.messages || [];
  const lastMsg = msgs[msgs.length - 1];
  const content = lastMsg ? String(lastMsg.content || "") : "";

  // ---- Read variables ----
  const bgUrl = String(api.variables.current_bg || "default_bg.jpg");
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

  // ---- Sprite URL (assembled from character name and emotion) ----
  const spriteUrl = speaker !== "Narrator"
    ? `/sprites/${speaker.toLowerCase()}_${emotion}.png`
    : null;

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
        backgroundImage: `url(${bgUrl})`,
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
- **Sprite layer** — assembles the sprite file path from `speaker` and `emotion`. `onError` handles missing images (silently hides them). No sprite is shown in Narrator mode
- **Dialogue box layer** — a semi-transparent box at the bottom. When `speaker` is not "Narrator", a character name label appears above the dialogue box. Narration text is gray and italic; dialogue text is white and upright
- **Choice button layer** — when `show_choices` is `true` and the text contains choices in `A)` `B)` `C)` format, buttons appear centered on screen. Clicking a button automatically hides the choices (`show_choices` set to `false`) and sends the player's selection

::: tip Customizing sprite paths
The code uses `/sprites/${speaker.toLowerCase()}_${emotion}.png` to assemble sprite paths. You can change this to any URL format — CDN links, local file paths, or a lookup table. If your character names contain non-ASCII characters, remember to URL-encode them or use English IDs.
:::

---

### Step 6: No toggle needed — the Root Component is already fullscreen

A visual novel naturally fills the screen. As long as your `index.tsx` root element uses `width: "100%"` + `minHeight: "500px"` (or `100vh`) — which the code above already does — your TSX takes over the whole canvas. **There's no separate "fullscreen" switch to flip**, because the Root Component *is* the world's UI entry point.

Two patterns side by side:
- **Normal chat + custom bubble**: `return <Chat renderBubble={...} />` — keep the platform's chat shell, just restyle the bubbles
- **Pure visual novel (this recipe)**: `return <div>...all VN elements...<MessageInput /></div>` — no `<Chat />` at all; every pixel is yours

> **Want to toggle between chat and VN?** If you want the "normal chat most of the time, VN during special moments" experience, branch inside the Root Component on a variable (say `vn_mode`). Return `<Chat />` when it's off and the VN fullscreen layout when it's on. The AI flips the variable with a directive and you swap between modes mid-session.

---

### Step 7: How the AI drives the screen — directive examples

Let's look at how the AI naturally controls the visual novel screen during an actual conversation.

**Scene 1: Opening (Narrator mode)**

AI's response:
```
[current_bg: set "classroom_morning.jpg"]
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

Rendered result: background unchanged (no `current_bg` directive means it keeps the previous value) + Yuki's sprite shows surprised expression then switches to shy + dialogue box displays the name "Yuki" + italic narration and upright dialogue alternate.

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
[current_bg: set "hallway.jpg"]
[current_speaker: set "Narrator"]

*The bell rings. The hallway instantly comes alive as students stream out in pairs and small groups.*

[current_speaker: set "Yuki"]
[speaker_emotion: set "happy"]

Want to have lunch on the rooftop together? I found a really nice spot.
```

Rendered result: background transitions to the hallway (with a crossfade animation) + narration + Yuki's happy sprite + dialogue.

---

### Step 8: Italic narration vs. plain dialogue — parsing rules

The Root Component distinguishes two types of text with a simple rule:

| Format | Recognized As | Display Style | Purpose |
|--------|--------------|---------------|---------|
| `*This is italic text*` | Narration | Gray (#94a3b8), italic | Environment descriptions, character actions, inner monologue |
| `This is plain text` | Dialogue | White (#e2e8f0), upright | What the character says |
| `A) Choice text` | Choice | Button | Clickable player selection |

The AI has already been told these rules in the knowledge entry. But if the AI occasionally gets the format wrong (e.g., uses italic for dialogue), the fallback logic treats uncertain text as dialogue — so at least nothing breaks.

> **Why not use Markdown's `>` blockquotes or `**bold**` to distinguish?** Because `*italic*` is the most natural markup — most AI models in roleplay scenarios already default to using italic for narration and action descriptions without extra training. Pick a format the AI is most likely to follow consistently, and save yourself the headache of fighting the model.

---

### Step 9: Save and test

1. Click **Save** at the top of the editor
2. Click **Start Game** or go back to the home page and start a new session
3. You should see a fullscreen VN display — background + dialogue box + opening narration
4. Type a message in the input box (e.g., "Say hello to her")
5. The AI's response should include directives — the background might change, a character appears, and dialogue shows in the box
6. If the AI offers choices, buttons appear in the center of the screen. Click one to try it
7. Continue the conversation and observe whether the AI naturally updates `current_bg` when switching scenes, and `current_speaker` and `speaker_emotion` when characters speak

**If something goes wrong:**

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Background is black | Image URL is incorrect or image doesn't exist | Check that the `current_bg` value is a valid image URL. Try opening the URL directly in a browser to confirm the image loads |
| No sprite visible | Sprite file path doesn't match | Check that the `/sprites/characterName_emotion.png` path is correct. `onError` silently hides images that fail to load |
| Directive lines show on screen | Directive format is non-standard and the regex didn't match | Confirm the format is `[variableName: set "value"]` — note the space after the colon |
| All text is narration / all text is dialogue | The AI isn't following the format rules | Check that the knowledge entry's format instructions are clear. You can reinforce them in the behavior rules |
| Choice buttons don't appear | `show_choices` wasn't set to `true`, or there are no `A)` format choices | Check that the AI's response includes `[show_choices: set true]` and choices in `A)` format |
| Screen isn't fullscreen | The root element doesn't fill the visible area | Add `minHeight: "100vh"` or `height: "100%"` to the outermost div in the Root Component, and make sure the parent container has a height |

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

The Root Component processes these in order; the final screen shows the sprite of the last `current_speaker`. If you want each dialogue segment to display its corresponding character's sprite, you can modify the component to parse the nearest preceding `[current_speaker: set ...]` directive for each paragraph.

### Transition effects

The background layer's CSS includes `transition: background-image 0.8s ease`, giving background switches a crossfade effect. You can also use different transitions for different scene types:

- Normal switch: crossfade (already implemented)
- Flashback/memory: add a white flash overlay
- Tense scene: add a screen shake animation

### Pairing with sound and BGM

Combined with Recipe #9 (day-night cycle)'s audio system, you can assign BGM to different scenes. Add to your behavior rules: when `current_bg` changes, play the corresponding scene's BGM.

---

## Quick reference

| What you want | How to do it |
|---------------|-------------|
| Switch background | AI sends `[current_bg: set "imageURL"]` |
| Switch speaker | AI sends `[current_speaker: set "characterName"]` |
| Switch expression | AI sends `[speaker_emotion: set "emotion"]` |
| Show choice buttons | AI sends `[show_choices: set true]` + choices in `A) B) C)` format |
| Distinguish narration from dialogue | `*italic*` = narration, plain text = dialogue |
| Fullscreen VN experience | Root Component `index.tsx` returns the VN fullscreen layout directly (no `<Chat />`), with `<MessageInput />` at the bottom for player input |
| Character sprites | Prepare `characterName_emotion.png` files in the `/sprites/` directory |
| Send message when player clicks a choice | Button `onClick` calls `api.sendMessage(choiceText)` |

---

## Try it yourself — importable demo world

Download this JSON file and import it to experience the full effect:

<a href="/recipe-10-demo.json" download>recipe-10-demo.json</a>

**How to import:**
1. Go to Yumina → **My Worlds** → **Create New World**
2. In the editor, click **More Actions** → **Import Package**
3. Select the downloaded `.json` file
4. A new world is created with all variables, entries, behaviors, and the Root Component pre-configured
5. Start a new session and try it out

**What's included:**
- 4 variables (`current_bg` background, `current_speaker` speaker, `speaker_emotion` emotion, `show_choices` choice toggle)
- 1 knowledge entry (visual novel system instructions telling the AI how to use directives and text formatting)
- 1 first message (VN opening with initial directives)
- A Root Component (complete VN interface: background + sprites + dialogue box + choice buttons + `<MessageInput />`)

---

::: tip This is Recipe #10
Visual novel mode showcases Yumina at its most powerful — the AI isn't just a chat partner, it's a narrative engine. By driving the screen with directives, using format conventions to distinguish text types, and letting the Root Component reshape the entire interface, you can turn an ordinary chat box into any interactive experience you can imagine. The same approach works for adventure games, interactive comics, or even management sims.
:::

</div>
