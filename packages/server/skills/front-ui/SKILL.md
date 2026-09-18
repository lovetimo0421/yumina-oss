---
name: front-ui
description: Design the world's rootComponent — its visual layer. One React root, multi-file virtual filesystem, compositional building blocks. Use when the user wants HUD, dashboard, layout, theme, panel, widget, or any visual UI.
---

# Skill: Front UI Design

Every world's visual layer is a single **rootComponent** — a virtual filesystem of `.tsx` files rooted at an entry file (typically `index.tsx`). There's no message-vs-app distinction; you compose what you want inside the entry file using the platform's building blocks.

## Composition Patterns by Intent

| User wants... | Entry file pattern |
|---|---|
| Default chat with platform rendering | `<Chat />` |
| Custom message bubble styling | `<Chat renderBubble={Bubble} />` (put `Bubble` in a sibling file) |
| Chat + persistent widgets alongside | `<><Sidebar /><Chat /></>` or a flex/grid layout |
| Full takeover (no default chat) | Your own JSX — don't import `<Chat>`; render `api.messages` yourself |
| Custom messages + overlay widgets | `<><HUD /><Chat renderBubble={Bubble} /></>` |
| Interactive greeting / character creation | Custom bubble at `messageIndex === 0`; use `renderBubble` to branch |
| Tabbed dashboard / management sim | Custom app JSX (no `<Chat>`); read `api.variables` for state |

All UI is React-based TSX compiled at runtime. Components run inside a sandboxed iframe for security.

## Verify visible changes

Before fixing a missing widget, read the entry file and trace its imports and rendered JSX to the widget. Changing a sibling file does nothing unless the entry reaches and mounts it. Check the initial state too: a closed panel's opener must have its own active styles; placing those styles only inside the open panel leaves the opener unstyled.

`validate_world` checks source structure and syntax, not rendered visibility or interactions. Treat unreachable-file warnings as a wiring check, and do not describe a component as visible or working solely because validation reports zero errors. When a creator reports that a fix did not appear, recheck mounting and style placement before spending another turn changing size, position, or z-index.

## Chat Building Block

`<Chat />` renders the full built-in chat: message list, text input, streaming, message editing, swipes, checkpoints, auto-scroll, read-only mode. Customize with props:

- `<Chat renderBubble={function(msg) { return <div>{msg.contentHtml}</div>; }} />` — each message renders through your function. `msg` has: `contentHtml` (+ `content` alias), `rawContent`, `role`, `messageIndex`, `isStreaming`, `stateSnapshot`, `variables`, `renderMarkdown`
- `<Chat className="..." >` accepts `children` rendered above the message list (e.g. a header bar)
- For full control: use `<MessageList>` and `<MessageInput>` separately

This avoids rebuilding the entire chat UI from scratch. Use `<Chat />` alone when you just need widgets around the standard chat. Add `renderBubble` when you also need custom message styling.

## Full Takeover (no `<Chat>`)

To take over the viewport entirely — no platform chat at all — simply don't render `<Chat>` in the entry file. Handle all chat display yourself:

| Approach | What you get |
|---|---|
| `<Chat />` | Full chat experience out of the box — messages, input, streaming, editing, swipes, checkpoints. Add widgets around it. |
| `<Chat renderBubble={...} />` | Same, but with custom message styling per bubble. |
| Manual (no `<Chat />`) | You must handle everything yourself — see the table below. |

**Manual mode only** — what you must implement:

| Hidden element | What the component must do instead |
|---|---|
| MessageList | Read `api.messages` and render messages yourself |
| MessageInput | Provide your own `<input>` / `<textarea>`, call `api.sendMessage(text)` |
| Composer "Context" button (Session Memory & Story Summary) | Dropping the built-in composer removes it. If `api.memorySummaryEnabled`, re-add a button that opens `<SessionMemoryModal open onClose />` — see the tsx skill's **Pattern: Session Memory Button**. Do NOT rebuild it from `api.injectContext`. |
| Greeting display | The greeting is `api.messages[0]` (first assistant message) — render it. Multiple greetings are built-in: create multiple `role: "greeting"` entries and use `api.switchGreeting(index)` to navigate |
| Streaming text | Check `api.isStreaming`, render `api.streamingContent` |
| Session header | Optionally add your own title/controls |

## Platform Conventions (do NOT reimplement)

### State & persistence: pick the store by what the state IS

Most UI does NOT need persistence — it should just render every time. Choose a store by the **nature** of the state, not by a vague "should this survive":

| State is… | Use | Survives re-entry / reload? | In the LLM prompt? |
|---|---|---|---|
| **Player input or real progress** — entered name, chosen route/origin, starting stats, story flags the rules/branching depend on, day/sim counters | `api.setVariable(k,v)` / `api.variables[k]` | Yes — saved per-session, server-side | **YES** |
| **Transient / cosmetic UI** — open tab, scroll, hover, expand/collapse, whether a cutscene is currently playing | React `useState` | No (resets on remount) — and that's fine | No |
| **Non-critical cross-session UI cache** — remembered theme, last-open tab | `api.storage` (localStorage) | Per-browser, per-world; `set` can drop | No |

> ⚠️ **Every game variable is rendered into the `<game-state>` block sent to the model on every turn** (~10–20 tokens each, and it can echo into chat — only `ThinkingTagFilter` strips it). `setVariable` is NOT a quiet store. Keep the variable set small: variables are for state the **story / rules** care about, never for UI bookkeeping. Never mint per-animation / per-popup / per-tooltip "played" flags.

**The one real persistence bug to prevent: never re-collect what the player already gave you.** If the player typed a name or picked a route/origin, store it in a variable and gate that input screen on whether the variable is set — so re-entering the session never re-asks:

```js
// Onboarding / input — gate on a PERSISTED variable (reliable, survives re-entry)
if (!api.variables["player_name"] && Object.keys(api.variables).length) return <Setup onDone={save} />;
function save(name, routeIdx) {
  // ORDER MATTERS — write setup answers BEFORE switchGreeting, never after.
  // Choosing an opening resets the session to that opening's snapshot. The engine
  // carries a variable across that reset ONLY if (a) it has scope:"setup" AND
  // (b) it already exists in session state at the moment switchGreeting runs
  // (preserveSetupScopedVariables copies setup vars from the CURRENT state into
  // the adopted snapshot). So write first — give the engine something to preserve —
  // then switch. Writing after the switch + a setTimeout races the snapshot-persist
  // round-trip and intermittently loses, so the player's pick lands empty and the
  // AI acts like nothing was chosen. This is non-deterministic: the same card can
  // work one build and break the next.
  api.setVariable("player_name", name);              // 1. write FIRST — var MUST be scope:"setup"
  if (typeof routeIdx === "number" && api.switchGreeting) {
    api.switchGreeting(routeIdx);                     // 2. then switch — engine preserves the setup var
    setTimeout(function () { api.setVariable("player_name", name); }, 100); // 3. re-assert after reset settles
  }
}
```

> The variable you write here MUST carry `scope: "setup"` (see variables skill + world-design Pattern 7). Without it the engine wipes the pick on opening-switch regardless of ordering. With it, the **write-before-switch** order above is what actually makes the pick survive — a multi-character "pick your cast" gate (e.g. `selected-members`) breaks exactly this way when the frontend switches the greeting before writing the roster.

Do **not** gate player input on `useState` (resets on remount) or on `api.storage` + `api.sessionId` (`sessionId` is `""` on the first render so the key drifts, and `localStorage` writes can drop) — both cause the "re-asks every time you re-enter" bug.

**Cosmetic intros/animations are NOT this bug — replaying them is the author's choice.** A title splash or opening cinematic with no input should just live in `useState` and play per mount; replaying on reload is fine, and some authors want it. Only suppress it across re-entries if the author explicitly asks — and prefer deriving that from an answer you already store (e.g. "if `player_name` is set, skip the intro") over minting a dedicated flag. A single one-time boolean is acceptable if truly needed (it's per-session: a fresh session replays, re-entry doesn't); just don't let the pattern spread to every animation.

### Companion sub-chats: `api.ai.complete` uses the player's model

`api.ai.complete({ messages, includeLorebook, temperature, maxTokens })` runs a side LLM call (e.g. an in-world messenger/DM). It uses the **player's currently selected chat model** and defaults to `temperature: 1.0` — which causes OOC/off-topic replies on weaker models. For in-character side chats, pass an explicit `temperature` (~0.6–0.7) and a `maxTokens`, give a strong identity anchor in the system prompt ("You ARE <character>; stay in character; never refuse"), and feed enough recent main-story context so replies stay coherent.

### Frontend-controlled lore: `<LoreButton>` / `<LoreSlot>`

When the PLAYER should turn a piece of lore (or a whole knowledge base) on/off from the UI — a "show advanced rules" toggle, a route picker, a codex chip — use these **ambient globals** (no import; the sandbox injects them):

- `<LoreSlot id="slot-id" />` — invisible. While mounted, the entry bound to `slot-id` (bound in the editor's **Custom UI → Bindings**, or via `write_lore_binding`) becomes eligible for AI injection; unmounting deactivates it. Renders nothing — it's a pure switch. The other helpers below all render a `<LoreSlot>` internally when active, so you rarely write this directly.
- `<LoreButton slotId="combat-rules" label="Combat rules" icon="⚔️" description?="…" variant?="chip"|"card" />` — a single player-facing **toggle**: click to turn the slot on, click again to turn it off.
- `<LoreSwitch slotId="secret-codex" onLabel="Open" offLabel="Close" onIcon?="📖" offIcon?="📕" />` — **two explicit buttons** for one slot: one turns the lore ON, the other OFF (vs. LoreButton's single toggle). Use when you want a deliberate open/close pair.
- `<LorePanel title="Codex" slots={["a","b"]}>…</LorePanel>` — a collapsible group; put `<LoreButton>`/`<LoreSwitch>` inside; shows an active-count badge.
- `<LoreGroup slots={[{ id, label, icon }]} />` — an exclusive (radio) group: at most one slot active at a time. Good for mutually-exclusive routes the player toggles live.

All of these persist on/off in a `__lore_{slotId}` game variable, so a player's choice survives reloads and branch switches.

**Gating is real, not cosmetic.** The slot→entry wiring lives in `loreUiBindings` (a binding table set with `write_lore_binding`), separate from the TSX. A bound entry is **excluded from the prompt entirely until its slot is active** — even if the entry is `alwaysSend`. So a "secret" the player must unlock should be a bound entry behind a `<LoreButton>`/`<LoreSwitch>`; do NOT rely on prose like "only reveal after the player clicks" (the model would see it immediately). This complements worldbooks (which gate by activation mode); use these when the **player**, not a variable or opening, should control visibility. See the **lore** skill for the worldbook/route model.

### Fullscreen / immersive mode is automatic

Every rootComponent world auto-enters immersive mode on session load — browser Fullscreen API + hidden sidebar/header, in one go. ESC exits (first press drops immersive, second navigates away). Do NOT call `document.documentElement.requestFullscreen()`, `element.requestFullscreen()`, or track fullscreen state yourself from TSX — you will fight the platform's own state machine and cause the "video stops when I click" / "audio leaks after exit" class of bugs.

If a custom button in your UI needs to toggle immersive mode, call `window.__yuminaToggleImmersive?.()` — this is the platform-blessed path. Don't add your own "enter fullscreen" button unless the user explicitly asked for one.

### Binary assets: `api.fetchAsset()`, and why images are different

The sandbox cannot make network requests at all (`connect-src 'none'`). Images and media still work because the browser gives `<img>`/`<audio>`/`<video>` a privileged loading path that is not a fetch. There is no `<model>` tag, so binary formats have no equivalent.

So there are two rules, and mixing them up wastes a lot of time:

- **Images** — `<img src={api.resolveAssetUrl("@asset:...")}/>`. No fetch involved. If the image becomes a **WebGL texture** or you need `getImageData()`, set `img.crossOrigin = "anonymous"` — reading pixels from a cross-origin image requires CORS, and the sandbox is always cross-origin to the asset host.
- **Everything else** (`.glb`, large JSON, sprite atlas, binary tables) — `await api.fetchAsset(ref)`. The parent fetches and hands the bytes over.

```js
const r = await api.fetchAsset("@asset:...");
if (!r.ok) return;              // "bad-ref" | "http-404" | "too-large" | "unavailable"
loader.parse(r.bytes, "", onLoad);   // e.g. a GLB — parse(), never load(url)
```

It takes an asset id, never a URL — a card reads its own assets and nothing else. 32MB ceiling per call.

**Never let a missing asset be fatal.** Keep the flat colour / placeholder the material or component already had and carry on: a deleted asset or an offline moment should look worse, never render a black screen.

### Supporting the creator: `api.openSupport()`

The play header carries a heart button that opens the platform's tip dialog (dollar tip / mushie gift, attributed to this world). A fullscreen takeover **covers that header**, so on a takeover card the player has no way to support the creator unless you offer one.

Call `api.openSupport()` — same dialog, same attribution, no payment code of your own. **Never build your own tip/payment/donation UI**: you cannot take money, and a fake one is a scam surface.

It returns a promise, and you must `await` it:

```js
const r = await api.openSupport();
if (!r.opened) {
  // "self" = the viewer IS the creator · "signed-out" · "unavailable" = editor preview
  showNote(r.reason === "self" ? "You are the creator" : "Sign in to support");
}
```

The dialog cannot open for the creator (nobody tips themselves) — and **the creator is the first person who will ever press this button**, while testing their own card. A silent no-op reads as a broken button, so always surface the reason.

Keep the entry small and out of the way — a corner of a title/pause screen, never a modal mid-play, never during a loss. Only offer it where the player is already idle.

### Audio: prefer `api.playAudio()` over `<audio>` / `<video muted={false}>`

`api.playAudio(trackId, opts)` runs in the **parent window**, not your sandboxed iframe. It survives component re-mounts, won't leak on navigation, handles fade/chain/ducking, and is unaffected by browser autoplay policy nuances. Use it for BGM and SFX.

```js
React.useEffect(function() {
  api.playAudio("main-theme", { fadeDuration: 2 });
  return function() { api.stopAudio("main-theme", 1); };
}, []);
```

Define the audio track with the `write_audio` tool first.

### Video: muted autoplay + unmute-on-gesture + explicit cleanup

A `<video>` tag IS the right choice for cinematic visuals (menu backgrounds, cutscenes). Three rules to avoid bugs:

1. **Start muted** — `<video autoPlay muted loop playsInline>`. Chrome blocks unmuted autoplay without user engagement; sandboxed iframes have no engagement signal. Muted autoplay always works.
2. **Unmute on the first user gesture, never before** — any menu button's `onClick` can flip `videoRef.current.muted = false`. Do NOT try to unmute in `useEffect` / `loadedmetadata` / `onPlay`; the browser silently pauses the video when you do, and it looks like "the video is frozen."
3. **Clean up on unmount** — detached `<video>` elements keep their audio track alive in Chrome until GC runs. Always:

```js
React.useEffect(function() {
  var vid = videoRef.current;
  return function() {
    if (vid) { vid.pause(); vid.removeAttribute("src"); vid.load(); }
  };
}, []);
```

Without this cleanup, users hear ghost audio seconds after navigating away. This is the #1 reported "our video is buggy" symptom — fix it by default.
