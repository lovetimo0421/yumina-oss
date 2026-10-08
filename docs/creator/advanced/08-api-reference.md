# API Reference

> Everything a card's interface code can use: sandbox globals, components, every field and method on `useYumina()`, type definitions, and the replacements for blocked browser APIs.

Interface code lives in **Panels → Front End Code**. For an introduction, read the [Custom UI Guide](./custom-ui-deep.md) first; this page is for looking up signatures.

---

## Sandbox globals

These names are **available everywhere in your interface code with no import statement**:

| Name | Kind | What it is |
|------|------|------------|
| `React` | module | Full React (`useState`, `useEffect`, `useRef`, `useMemo`, `useCallback`, `useLayoutEffect`, `Fragment`, ...) |
| `useYumina` | hook | Platform SDK — see [`useYumina()` SDK](#useyumina-sdk) |
| `useAssetFont` | hook | Load a custom font from the asset library — see [`useAssetFont()`](#useassetfont) |
| `Icons` | object | Every Lucide icon as a component: `<Icons.Heart />`, `<Icons.Sword />`. Full catalog: <https://lucide.dev/icons> |
| `Chat` | component | Full chat building block — see [`<Chat>`](#chat) |
| `MessageList` | component | Messages without input — see [`<MessageList>`](#messagelist) |
| `MessageInput` | component | Input bar only — see [`<MessageInput>`](#messageinput) |
| `ChatCanvas` | component | Older alias for `<Chat />` — see [`<ChatCanvas>`](#chatcanvas) |
| `ModelTrigger`, `ModelPickerModal` | component | The chat's model button and model picker — see [Model picker components](#model-picker-components) |
| `SessionMemoryModal` | component | The chat's session memory dialog — see [Model picker components](#model-picker-components) |
| `LoreSlot`, `LoreButton`, `LorePanel`, `LoreGroup`, `LoreSwitch` | component | Controls that send a lore entry to the AI only while they're on — see [Lore controls](#lore-controls) |
| `exports`, `module` | object | CJS-style export fallback; you typically ignore these |

**Do NOT import React or any of the names above** — they are injected by the sandbox. Import statements are stripped at compile time, so `import { useState } from "react"` leaves `useState` undefined. Use `React.useState`.

**Your own files CAN be imported** — multi-file interface code uses ES module syntax: `import StatBar from "./stat-bar"`. Extensions `.tsx`, `.ts`, `.jsx`, `.js` can be omitted.

---

## `useYumina()` SDK

Call it inside your component function:

```tsx
function MyWorld() {
  const api = useYumina()
  // api.variables, api.sendMessage(...), ...
}
```

Full surface, grouped by purpose:

### State reads (synchronous)

Read the latest game state. The component re-renders whenever any of these change.

| Field | Type | Meaning |
|-------|------|---------|
| `variables` | `Record<string, unknown>` | Session-scope game variables, keyed by the variable's **ID**. Its **display name** also works as a read key (`api.variables.hunger` finds the variable named `hunger` even when its ID is a UUID). Example: `{ health: 80, gold: 150 }`. See [ID vs display name](#id-vs-display-name) |
| `globalVariables` | `Record<string, unknown>` | In play this holds the same values as `variables`. Same ID-or-name lookup |
| `worldName` | `string` | Name of the current card |
| `worldCover` | `string \| null` | The card's cover image as an absolute URL, `null` when unset. Tracks cover edits automatically — use it for character avatars / headers / splash art instead of re-uploading the cover as an asset |
| `background` | `{ id, url, blur, dim, opacity, position } \| null` | The picture the host paints behind the default chat, already resolved (`url` is final, `blur` in px, `dim` and `opacity` 0–1, `position` `"center" \| "top" \| "bottom"`). `null` when the card has none. A full-screen interface can paint the same backdrop or ignore it |
| `worldId` | `string` | UUID of the current card |
| `sessionId` | `string` | UUID of the current play session |
| `currentUser` | `{ id, name?, image? } \| null` | Raw account: id, display name, account avatar. `null` when logged out. Use for **account-level** UI like "view profile". For **role-play** rendering inside the world, use `user` instead |
| `user` | `{ name: string; avatar: string \| null }` | The role-played player — same persona-vs-account branching as the `{{user}}` macro. When the player has a persona active, `user.name` is the persona name and `user.avatar` is the persona avatar; otherwise it falls back to the account. Use this for in-world chat bubbles, character cards and profile panels |
| `mode` | `"session" \| "guest-preview"` | `"session"` is a real play session. `"guest-preview"` is a logged-out hub preview — actions that mutate state are no-ops and surface a sign-in prompt to the parent |
| `capabilities` | `{ canSendMessage, canPersistSession, canUseSessionApis, requiresAuth }` | What the current `mode` allows. Read these to disable buttons that would no-op (e.g. the Send button in guest preview), or to render an inline "Sign in to continue" CTA |
| `language` | `string` | Active i18n language code from the host (`"en"`, `"zh"`, ...). Use this to pick translations inside the card without depending on the host's i18next instance |
| `messages` | `Array<Record<string, unknown>>` | Message history (the loaded window; see `hasEarlierMessages`) — see [`SandboxMessage`](#sandboxmessage) |
| `hasEarlierMessages` | `boolean` | Older messages exist on the server but aren't loaded yet. Call `loadEarlierMessages()` to fetch them |
| `isLoadingEarlier` | `boolean` | `true` while an older page is being fetched |
| `isStreaming` | `boolean` | `true` while the AI is generating a reply |
| `streamingContent` | `string` | Live streaming text from the AI (updates frequently) |
| `streamingReasoning` | `string` | Live "thinking" / reasoning text from the AI (only for reasoning models) |
| `pendingChoices` | `string[]` | Choice button labels emitted by rules |
| `error` | `string \| null` | Current error message (API failure, generation error) or `null` |
| `errorCode` | `string \| null` | Machine code for `error` (e.g. `"CONTENT_FILTER"`); `null` when unknown |
| `sendFailureNonce` | `number` | Goes up by one every time a send fails for good, including failures that only show a toast and never set `error`. Watch it to put the player's text back into your own input box |
| `composerSendKey` | `"enter" \| "mod-enter"` | The player's "Press Enter to send" setting. `"enter"`: Enter sends, Shift+Enter is a new line. `"mod-enter"`: Ctrl/⌘+Enter sends, Enter is a new line. A hand-built input box should follow it |
| `readOnly` | `boolean` | `true` when viewing someone else's session — `<Chat />` hides the input automatically. Starts `true` until the host sends the first state |
| `checkpoints` | `Array<Checkpoint>` | Saved checkpoints — see [`Checkpoint`](#checkpoint) |
| `greetingContent` | `string \| null` | Opening text computed from the card's entries (used by `<Chat />` as empty-state content) |
| `canvasMode` | `"chat" \| "custom" \| "fullscreen"` | Current canvas mode |
| `speakerBubbles` | `boolean \| undefined` | The card has **A bubble per speaker** turned on in [Reply processing](/creator/reply-rules) |
| `selectedModel` | `string` | Currently selected AI model ID |
| `userPlan` | `string` | User's subscription plan (`"free"`, `"go"`, `"plus"`, `"pro"`, `"ultra"`, `"internal"`) |
| `preferredProvider` | `"official" \| "private"` | Official API vs. user's own key |
| `balance` | `number \| null` | The player's mushie balance, `null` when unknown |
| `entries` | `ReadonlyArray<SandboxEntry>` | The card's lore entries — enabled only, sorted by `position`. See [Lorebook lookups](#lorebook-lookups) and [`SandboxEntry`](#sandboxentry) |
| `worldbooks` | `ReadonlyArray<Worldbook>` | The card's scenarios (`id`, `name`, `description?`, `enabled?`, `activation`, ...). `SandboxEntry.worldbookId` points at these IDs |
| `loreUiBindings` | `ReadonlyArray<LoreUiBinding>` | Which lore entry each `<LoreSlot>` id sends. See [Lore controls](#lore-controls) |

### ID vs display name

Every variable has two labels:

- **ID** — the key the game state is actually stored under. New variables get a
  random UUID like `a8c5a685-1317-40b2-8f11-baccd39f9042` until you change it.
  Use the card's actual ID; imported or older cards may retain mixed-case IDs.
- **Display name** — what you call it (`hunger`, `Love meter`, `zombieKills`).

`api.variables` is keyed by ID, and also resolves a display name:

```jsx
api.variables.hunger        // works whether "hunger" is the ID or the display name
api.variables["Love meter"] // display names with spaces work too
api.setVariable("hunger", 50)  // writes to that variable's ID
```

The ID wins when both exist. If one variable's ID is `hp` and another's display
name is also `hp`, `api.variables.hp` reads the one whose **ID** is `hp`.
If multiple variables share a display name, the last definition wins, matching
the engine's name lookup. Prefer unique names to avoid ambiguity.

`Object.keys(api.variables)` still returns the stored keys, without extra display-name
aliases. Enumerating the bag does not add duplicate rows for the aliases.

### Game actions

| Method | What it does |
|--------|--------------|
| `sendMessage(text, attachments?)` | Send a message as the player, triggering an AI reply. `attachments` is an optional array of images from `pickChatImage()`. Fire-and-forget |
| `pickChatImage()` | Open the host's image picker for a chat attachment. Resolves `{ type: "image", mimeType, name, data }` (`data` is base64) or `null` when cancelled or unavailable. Pass the result to `sendMessage(text, [image])` |
| `setVariable(id, value, options?)` | Set a variable. `id` is the variable's ID, or its display name. Fire-and-forget: the value shows in `api.variables` right away and is saved in the background. `options` (`{ scope?, targetUserId? }`) is accepted for older cards; the host ignores it |
| `patchVariables(values)` | Save several variables in one write: `values` is `{ variableId: value, ... }`, keyed by **ID** (display names aren't looked up here). Returns `Promise<void>` that resolves once the server has confirmed the write and rejects on failure (read-only views, a changed session, a server error). Use it when the next step depends on the value having been saved |
| `executeAction(actionId)` | Set off the behaviors whose trigger is **The player presses a button** with this **Button** name (e.g. `"attack"`). Fire-and-forget, and it can't pass values; use `executeActionAndWait` for that |
| `await executeActionAndWait(actionId, params?)` | Same, but waits for the result and can pass values in. `params` is a plain object such as `{ price: 5, item: "Mushroom ale" }`; the behavior reads them as `{param.price}` in a condition value, an effect value or a notice ([Behaviors · Passing a value from a button](/creator/automation#passing-a-value-from-a-button)). Values must be text, numbers or true/false; up to 30 of them, names up to 60 characters, text up to 500 characters. Resolves `{ applied: true, variables, firedIds }` after host state, runtime records, notifications and audio effects are applied. Rejects failures, timeout, unavailable views (guest preview, read-only, replays), empty/non-string IDs and stale sessions. `variables` is the confirmed server snapshot; newer optimistic writes remain in `api.variables` |
| `callAi(ai, input?)` | Run one of the card's [AIs](/creator/ais) by name or ID — usually a **UI-based** AI with an **Answer format**. `input` is anything you want to hand it (a string or a small object). Resolves `{ text, fields, fallback }`: `text` is its words, `fields` the values it filled in, `fallback` is `true` when it failed and a backup line was used. Resolves `null` when it couldn't run (not in play here, cooling down, busy, or this view can't call AIs). Where its words and fields go is set in its **Answer format**; with **Into the story** its line is also added to the chat |
| `onAiOutput(channel?, cb)` | Listen for words sent to an **interface channel**: from an AI whose **Where its words go** is **An interface channel**, or from a [Reply processing](/creator/reply-rules) rule set to **An interface channel**. `cb({ channel, id, name, text, fields })`. Pass a channel name to hear only that channel, or just `cb` to hear all of them. For a Reply processing rule, `id` is `"reply"`, `name` is the rule and `fields` is `{}`. Returns an unsubscribe function |
| `setScene(scene, options?)` | Tell the AIs what the screen shows right now. `scene` is a short text or a small object (`{ room: "kitchen", onCamera: false }`); `null` clears it. Every AI call after this (replies, regenerations, behind-the-scenes AIs) gets it as its own block; it isn't saved. `options.events` is `[{ name, when? }]`: events the AI is allowed to set off by writing `[event: name]` |
| `onStoryEvent(cb)` | Listen for story events: an AI writing `[event: name]`, or a [Reply processing](/creator/reply-rules) rule set to **A story event**. `cb({ id, name })`. Only fires in a live session. Returns an unsubscribe function |
| `switchGreeting(index)` | Switch the first message to opening number `index` (0 = the first opening). Returns `Promise<void>` that resolves once the switch has been applied. The switch resets variables to that opening's starting values, so set your own variables **after** awaiting it |
| `clearPendingChoices()` | Dismiss pending choice buttons without picking one |
| `setComposerDraft(text)` | Drop `text` into the chat composer and focus it. **Does not send.** Use when you want the player to review or edit the message before hitting Send (e.g. an NPC interaction button that primes a conversation starter). Sandbox-local — no parent round-trip — so it only works alongside the bundled `<MessageInput>` / `<Chat>` components |

```tsx
// A shop button that runs the "buy" behavior with this item's price
async function buy() {
  try {
    await api.executeActionAndWait("buy", { item: "Mushroom ale", price: 5 })
  } catch (e) {
    api.showToast("Couldn't buy that right now", "error")
  }
}

// A fortune-teller button that calls a UI-based AI
async function askFortune() {
  const answer = await api.callAi("Fortune Mushroom", { question: "Will I find the key?" })
  if (answer) setFortune(answer.fields.Fortune)
}
```

### Chat control

Everything the default chat bar can do, exposed so your custom UI can do it too.

| Method | What it does |
|--------|--------------|
| `editMessage(messageId, content, options?)` | Edit an existing message. Returns `Promise<boolean>`; `true` on success. `options.swipeIndex` names the swipe the edit was opened on; the save is refused (`false`) if a different swipe is active by then |
| `deleteMessage(messageId)` | Delete a message. Returns `Promise<boolean>` |
| `regenerateMessage(messageId)` | Ask the AI to regenerate the given reply (fire-and-forget) |
| `continueLastMessage()` | Continue generating from the last AI message (fire-and-forget) |
| `stopGeneration()` | Interrupt the current stream (fire-and-forget) |
| `restartChat()` | Clear all messages, reset state, start fresh |
| `swipeMessage(messageId, "left" \| "right")` | Switch between AI alternatives (swipes) for a message. Returns `Promise<Record<string, unknown>>` |
| `loadEarlierMessages()` | Fetch the previous page of history; the rows are added to the front of `messages`. Returns `Promise<boolean>` |

### Sessions & branching

| Method | What it does |
|--------|--------------|
| `revertToMessage(messageId)` | Rewind the conversation to just before `messageId`. Returns `Promise<void>` |
| `branchFromMessage(messageId)` | Fork a new session at the given message (clones messages up to and including it plus the state snapshot). Returns `Promise<string \| null>` — new session ID, or `null` on failure (while streaming, multiplayer rooms, missing messages all fail) |
| `getBranchContext()` | Fetch the current branch slice (self, parent, siblings, children). Returns `Promise<BranchContext>`. Re-fetched every call; no client cache. See [`BranchContext`](#branchcontext) |
| `createSession(worldId)` | Start a new session for a world. Returns `Promise<string>` with the new session ID |
| `deleteSession(sessionId)` | Delete a session. Returns `Promise<void>` |
| `listSessions(worldId)` | List all sessions for a world. Returns `Promise<Array<Record<string, unknown>>>` |

### Checkpoints

A checkpoint is a named snapshot inside the current session you can rewind to.

| Method | What it does |
|--------|--------------|
| `saveCheckpoint()` | Save the current session state as a new checkpoint. Returns `Promise<void>` (the `checkpoints` field is pushed back afterwards) |
| `loadCheckpoints()` | Ask the parent to refresh the `checkpoints` array. Returns `Promise<void>` |
| `restoreCheckpoint(checkpointId)` | Restore the session to a saved checkpoint. Returns `Promise<void>` |
| `deleteCheckpoint(checkpointId)` | Delete a checkpoint. Returns `Promise<void>` |

### Audio

`trackId` is the track's **Track ID**: click the track in **Panels → Audio** and use **Copy ID**. Renaming a track doesn't change it.

| Method | What it does |
|--------|--------------|
| `playAudio(trackId, opts?)` | Play one of the card's audio tracks. `opts`: `{ volume?, fadeDuration?, chainTo?, maxDuration?, duckBgm?, loop? }` — durations are in **seconds**; `chainTo` picks the next trackId to play; `duckBgm` lowers BGM during playback; `loop` overrides the track's loop setting for this playback |
| `stopAudio(trackId?, fadeDuration?)` | Stop a track (omit `trackId` to stop everything). `fadeDuration` in seconds. **Destroys** the element — use `pauseAudio` if you want to resume from the same position |
| `pauseAudio(trackId)` | Pause a track in place, keeping its playback position |
| `resumeAudio(trackId)` | Resume a track paused with `pauseAudio` |
| `onAudioEnded(cb)` | Subscribe to "a non-looping track finished playing" — `cb(trackId)`. Returns an unsubscribe function. Use it to auto-advance a custom playlist |
| `setAudioVolume(type, volume)` | `type` is `"bgm"` or `"sfx"`, `volume` is 0–1 |
| `getAudioVolume(type)` | Synchronously returns the current volume (0–1) |

### Voice readout (TTS)

Speak text aloud through the platform voice pipeline (Fish Audio via OpenRouter). Billed per character to the player; replaying the same text+voice is a free cache hit. One voice plays at a time. Inline `[whisper]` / `[excited]`-style tags in the text control the delivery.

Voice readout is **opt-in**: players turn it on in Settings › Display. Until they do, `ttsState.enabled` is `false`, `tts.speak` / `tts.preview` resolve `{ ok: false, reason: "disabled" }` without synthesizing or charging, and `tts.setPrefs` changes nothing. Hide your voice UI while `enabled` is false.

| Method / field | What it does |
|--------|--------------|
| `tts.speak(opts)` | `opts`: `{ messageId?, text?, key?, voice?, waitForEnd? }`. Pass `messageId` to read a chat message (honors the player's reading-mode setting), or `text` for arbitrary card lines (`key` gives it a stable playback identity). `voice` optionally overrides the player's voice with a fish.audio marketplace id (32-hex) so cards can voice their own characters. With `waitForEnd: true`, success means all audio clips actually ended; cancellation, blocked playback, media error and timeout return `ok: false`. Without it, success means playback was queued. Returns `Promise<{ok, reason?}>` — `reason` is `"disabled"` (the player hasn't turned readout on), `"unavailable"` (preview/replay), `"insufficient"` (not enough mushies), `"rate-limited"`, `"empty"`, `"timeout"`, or an error |
| `tts.stop()` | Stop the current readout (also cancels a pending synthesis and the auto read-along queue) |
| `tts.onPlaybackFrame(cb)` | Subscribe to measured output frames (about 15 per second) while a line plays. Match the frame's key to the line you started. Returns an unsubscribe function; unsubscribe on unmount |
| `tts.setPrefs(prefs)` | Update the player's readout preferences: `{ enabled?, autoPlay?, mode?, voice?, voicePool?, volume? }` (`mode` is `"full"` or `"dialogue"`; `volume` 0–100; `voicePool` is the list of voice ids AI casting may give characters, `[]` = all; `voice` sets a pool of one, "" = all). Persists to the account; new values flow back via `ttsState`. Only works once the player has opted in; `enabled: true` is ignored (only Settings turns readout on), `enabled: false` switches it off |
| `tts.preview(voice)` | Play a short sample of a voice (`""` = the auto voice). Billed like any synth on first listen, cached for everyone after. Returns `Promise<{ok, reason?}>` |
| `ttsState` | Read-only: `{ available, enabled, voice, voicePool, mode, autoPlay, volume, playback }`. `available` is false outside real sessions (guest preview, replay) — hide ALL voice UI then; `enabled` is the player's opt-in (false until they turn readout on in Settings). `playback` is `{ key, status: "loading" \| "playing" \| "blocked", progress?, level? }` or `null` (`progress` 0–1 at ~2Hz), `playing` follows actual playback. `waitForEnd` conversations may include a real output `level` (0–1, about 15Hz); it is absent when unsupported. A custom UI can render per-line speaker states and progress rings |

### Voice input (hold-to-talk)

Let the player speak instead of type. The platform records (the card never touches the microphone) and hands back the words. Free to the player. The default chat composer already has a mic; use these to build your own talk button, e.g. a werewolf speaking podium.

| Method / field | What it does |
|--------|--------------|
| `voice.prepare(opts?)` | Checks browser microphone permission, then releases the microphone without recording or transcription. Set `{ requireLevels: true }` for automatic silence detection; returns `{ ok: false, reason: "levels-unavailable" }` if the analyser cannot run. Call before paid speech so a blocked microphone does not strand the conversation. Cancel with `voice.cancel()`. |
| `voice.record(opts?)` | Start recording — call it when your talk button goes down. Automatic silence detection should also set `opts.requireLevels: true`; ordinary hold-to-talk can omit it. `opts.onLevel(level)` gets the live input loudness (0–1, ~15×/s) for a waveform. Resolves after `voice.stop()` with `{ ok: true, text }`, or `{ ok: false, reason }` — `reason` is `"cancelled"`, `"too-short"` (a tap, not a hold), `"denied"` (microphone blocked), `"empty"`, `"rate-limited"`, `"unavailable"` (preview/replay), `"timeout"` or `"error"`. Pauses any voice readout so the AI isn't recorded |
| `voice.stop()` | Finish the clip and transcribe it (talk button released) |
| `voice.cancel()` | Throw the clip away |
| `voice.setPrefs(prefs)` | Update the player's voice-input preferences: `{ enabled?, mode?, key? }`. `mode` is `""` (follow the card), `"confirm"` or `"auto"`; `key` is the `KeyboardEvent.code` to hold |
| `voiceInputState` | Read-only: `{ available, enabled, mode, cardMode, playerMode, key }`. `mode` is what the player wants on release — `"auto"` (send it as spoken) or `"confirm"` (let them review it). It is your card's `settings.voiceInputMode` unless the player overrode it. `key` is the `KeyboardEvent.code` they hold to talk |

Set the default for your card in **Card settings → Sound → Player voice input**: **Review first** is `"confirm"`, **Send right away** is `"auto"`. In the world JSON it's `settings.voiceInputMode: "auto" | "confirm"`.

### Continuous live voice (OpenAI Realtime)

`api.realtimeVoice` provides a continuous microphone conversation in an editable saved session. Call `getConfig()` to learn actual availability and funding; object existence does not prove access. The host asks for affirmative microphone consent before capture. Funding may be a saved OpenAI key, enabled testing sponsorship or an explicitly enabled ordinary Yumina balance policy. Balance consent identifies the server's temporary reservation and measured usage charge. Microphone audio and world context go to OpenAI; transcripts may be saved in the story. No webcam is requested. See the [native balance contract](../../development/balance-voice-sdk.md) for durable receipts and reload recovery.

| Method | Contract |
|--------|----------|
| `realtimeVoice.getConfig()` | Zero arguments, no spend/capture. Balance reports `transport: "server-ws-v1"`, `funding: "balance"`, server `reservationCredits`, and `finishAcknowledged: true`; legacy reports false. Disabled views return unavailable. |
| `realtimeVoice.finish()` | Zero arguments. Balance silences locally and drains exact-attempt durable finals before `finished`; pending, incomplete, unavailable and atomic not-started remain distinct. Pending has no terminal cursor. Legacy returns unsupported without changing stop behavior. |
| `realtimeVoice.prepare({ avatar? }?)` | Call it from the player's click, before any slow work (building context, saving). Resolves `{ intent }`; pass that `intent` to `start`. Rejects when voice is unavailable in this view |
| `realtimeVoice.start({ instructions, intent?, context?, voice?, avatar?, tools?, interruptionMode? })` | Resolves `{ status: "connected" }`; instructions contain 1–12,000 characters. `context` takes the same shapes as `updateContext`. `voice` is `"marin"` (default) or `"cedar"`. Uses `gpt-realtime-2.1`, medium semantic VAD and host-managed responses. `interruptionMode` is `"automatic"` (default) or `"manual"`; invalid modes reject before capture. `tools` is `[]` (no inspection tool) or `["request_inspection_focus"]`; omitted keeps the default. Optional `avatar: true` requires the host's configured testing LiveAvatar service and waits for its media connection; it rejects visibly when unavailable. Surface rejected promises to the player. |
| `realtimeVoice.interrupt()` | Balance immediately flushes current output and sends the actual rendered offset while continuous capture continues. Legacy retains its input-clear/turn-taking behavior. Keeps the call connected. |
| `realtimeVoice.stop()` | Immediately closes host capture/playback and requests server hangup for funded calls. Local silence is distinct from acknowledged finish. |
| `realtimeVoice.setMuted({ input, output })` | Independently mutes capture and playback. Assistant speech does not mute the microphone. |
| `realtimeVoice.updateContext(context)` | Updates witnessed scene context: a string or `{ state: Record<string, string>, events: Array<{ id: string, text: string }> }`. Flattened text must fit 4,000 characters. |
| `realtimeVoice.updateInstructions(text)` | Legacy replaces initial direction (1–12,000 characters) at a quiet boundary. Balance instructions are fixed; this operation emits a nonfatal unsupported hint. Balance `updateContext` coalesces witnessed updates and emits revision-correlated pending/configuring/applied acknowledgments. |
| `realtimeVoice.reactToScene(notice)` | Sends an already committed public scene event as observation, without executing its action. See bounded notices below. Never include private notebook/page text. |
| `realtimeVoice.cancelSceneReaction(id?)` | Removes a queued or playing notice by ID. Omit the ID to cancel outstanding follow-ups only, preserving physical event announcements. Does not stop the call or clear microphone input. |
| `realtimeVoice.resolveTool(callId, { accepted, focus?, reason? })` | World validates the bounded inspection request before accepting it; the provider does not execute code or apply state effects. |
| `realtimeVoice.setSpatial({ x, z, yaw, sourceX, sourceZ })` | Updates spatial playback pose. |
| `realtimeVoice.onEvent(callback)` | Subscribe; returns an unsubscribe function. |

Avatar mode routes the AI's audio through the server-selected LiveAvatar and plays only the synchronized returned audio. It does not request a webcam or send microphone audio directly to LiveAvatar. The host adds `video-status` events (`connecting`, `live`, `stopped`) and `video-frame` events containing an `ImageBitmap`. Copy each bitmap **synchronously** into your own canvas inside the event listener; the sandbox closes it immediately afterward and acknowledges delivery. Do not retain the bitmap, put frames in React state, or persist them. Restore a still image on `video-status: stopped`. The host owns session tokens, interruption, spatial playback, frame backpressure and cleanup; cards cannot choose arbitrary avatar credentials or endpoints. Avatar playback activity follows the returned stream, so a finished AI generation does not prematurely end an on-screen spoken turn.

Use manual interruption when a character should finish each line unless the player presses an explicit control:

```tsx
// In the click handler that starts the call:
const { intent } = await api.realtimeVoice.prepare();
await api.realtimeVoice.start({ intent, instructions: "Your character direction.", interruptionMode: "manual" });
// In the player's Interrupt button/key handler:
api.realtimeVoice.interrupt();
```

Manual mode keeps the microphone open between lines. Input beginning or continuing through pending generation, pending avatar audio, audible output or its echo tail is excluded from user transcript events and native conversation history, even if its final ASR arrives later or differs from the character's words. Expected protected input does not emit the overlapping-words hint. Native deletion acknowledgements still fence subsequent replies. An explicit interrupt admits a fresh capture only after the input-buffer clear acknowledgement; speak again after that boundary. Input that finished before a new output turn retains its existing settlement behavior. Mute, pause and disconnect keep their normal authority over capture/playback. This option changes admission policy, not microphone hardware, VAD, voice or the acoustic model.

Events include `status` (`connecting`, `connected`, `stopped`, `error`), `transcript` (`role`, stable `id`, cumulative `text`, `final`), and bounded inspection `tool` requests. `input` uses transcript IDs with `speaking`, `transcribing`, or `discarded`; clear pending statement state on `discarded` so failed transcription cannot leave a submission waiting forever. `activity` is `listening`, `thinking`, or `speaking`; speaking follows actual output buffer playback, not generation completion. `input-level` is measured microphone loudness (0–1), while `level` is measured output loudness (0–1). Use the appropriate meter for each participant. `input-hint` carries a short message for the player, and `capture-settings` reports which echo cancellation the browser applied.

Calls stop when the player leaves, hides the tab, loses permission, stops explicitly, or reaches five minutes. Sponsored testing additionally enforces server hangup, one concurrent call per account, and rolling 24-hour start budgets of 12 per player and 60 globally. This API remains separate from `api.voice` hold-to-talk and `api.tts` readout.

Audio output is unlocked in the consent click and checked before microphone capture. Resume failure, continued suspension or a two-second unlock timeout rejects start and closes resources. This confirms browser output readiness; hardware volume remains controlled by the player.

Scene notices have `id` (1–160 letters, digits, underscores, colons or hyphens) and `kind`, with exactly these additional fields:

| Kind | Additional fields |
|------|-------------------|
| `return`, `seen`, `overdue`, `writing`, `caught`, `knock`, `power-restored`, `clearance` | None |
| `bulletin` | `text`: nonempty broadcast text, at most 600 characters |
| `power-cut` | `seconds`: finite number from 3 through 12; observer temporarily cannot see |
| `begin-inspection` | `focus`: `desk`, `door` or `bed`; `line`: nonempty public announcement, at most 240 characters |
| `search` | `focus`: `desk`, `door` or `bed` |
| `follow-up` | `evidenceId`: a prior public resident statement ID; `line`: one nonempty question, at most 240 characters |

Extra fields are rejected. Notices are deduplicated per connection and bounded to eight accepted events per ten seconds and 128 IDs. Output mute suppresses new notices; active speech and pending responses retain their normal ordering. Broadcast text is performed as a public bulletin; other events receive a brief acknowledgement of that specific committed event. Native `start` still allows at most 12,000 instruction characters and `updateContext` at most 4,000 characters.

`start({ instructions, context })` accepts the same context shape. Use a structured snapshot for a changing physical scene: stable `state` keys describe current public facts; immutable event IDs identify recorded observations. A changed fact supersedes its old value. Omitting an event means it was left out of the history budget, not that it never happened. Do not reuse an ID for corrected or new testimony. Include only information this actor is allowed to know; this API does not filter private pages or unseen actions for you.

The host sends the full snapshot at connection/reconnection. On the host-enabled GPT-Live path, subsequent snapshots send only changed facts and previously undelivered event IDs at a quiet playback boundary. Pending events survive state coalescing, and changing an excerpt does not replay an old event. Legacy strings and the Realtime path retain full context replacement. Bounds: 16 state fields, 64 events per snapshot, 4,000 flattened characters, and 12,000 characters for combined startup instructions plus the context separator and text. Keys and IDs are transport metadata, not spoken content. A producer exceeding the pending-event or connection-history capacity ends the call visibly rather than silently losing events.

The SDK forwards only the notice ID and kind. Existing cards without an `unperson-room` variable may continue sending the fixed, text-free `return`, `seen`, `overdue`, `writing`, and `caught` notices. These are card-reported observations; the host does not establish their fictional truth. For the Unperson room schema, the host hydrates every supported event from confirmed saved state; supplying text to the SDK is not permission to invent evidence. A follow-up must cite earlier received resident speech in the same attempt. It expires after 45 seconds of room time, a phase/attempt change, or newer received speech. New microphone speech also invalidates outstanding follow-ups immediately. Other room schemas need a host adapter for rich notice references such as bulletins, inspections and evidence-linked follow-ups.

### UI / navigation

| Method | What it does |
|--------|--------------|
| `toggleImmersive()` | Toggle immersive (full-screen) mode |
| `openPersonaManager()` | Open the player's persona manager — switch / create / edit personas without leaving the world (the same panel the composer "+" menu opens). In play, a switch changes this session's saved persona and takes effect on the next message |
| `getPersonaProfile()` | Read the session's selected persona when the player chooses to import it. Returns `Promise<{ name, appearance, personality, backstory, entries? } \| null>` (`entries` is `[{ title, content }]`); `null` when no persona is selected; failures reject. Private notes are never included. Save a copy in your own data if the identity must stay fixed for the run |
| `openModelPicker(options?)` | Open the chat's model picker. Pass `{ purpose: "side-completion" }` when the choice is for your own `ai.complete` calls; chat-only trial models are left out then |
| `openSessionManager()` | Open the session / branch manager (switch, rename, delete branches) |
| `sharePlaythrough()` | Open the share dialog to publish this session as a shared playthrough |
| `openSupport()` | Open the "support the creator" dialog (tip in dollars or gift mushies), attributed to the world being played. For fullscreen custom-UI cards, whose own canvas covers the play header's heart button. Returns `Promise<{opened, reason}>` — `reason` is `"self"` (you are the creator), `"signed-out"`, or `"unavailable"` (editor preview). Await it and show the reason: the creator testing their own card is the first person to press this button, and a silent no-op looks broken |
| `openCreditTopUp()` | Open the mushie top-up popup |
| `fetchAsset(ref)` | Read one of your assets as raw bytes. Takes an asset id (`"@asset:<uuid>"` or the bare uuid), **never a URL**. Returns `Promise<{ok, bytes?, contentType?, error?}>`; `error` is `"bad-ref"`, `"http-404"`, `"too-large"` (32MB cap), `"unavailable"`, or a network message. The sandbox cannot fetch anything itself, and the browser only gives images and media a privileged loading path — there is no `<model>` tag — so this is the only way a `.glb`, a large JSON table or a sprite atlas gets in. Check `ok` before touching `bytes`. Works in the editor preview too |
| `copyToClipboard(text)` | Copy to clipboard (replaces `navigator.clipboard.writeText`) |
| `navigate(path)` | Ask the parent to route to a path like `"/app/hub"` (replaces `window.location = ...`) |
| `showToast(message, type?)` | Show a toast in the parent UI. `type`: `"success"`, `"error"`, `"info"` (default) |

### Browser-local storage (per-world)

Replacement for localStorage. Scoped by `worldId`; worlds cannot read each other's keys. This is device-local preference/cache storage: it does not sync across devices or enter checkpoints, branches, or shared snapshots. The browser's `sessionStorage` alias also uses this local API; it is distinct from `api.sessionStorage` below.

| Method | What it does |
|--------|--------------|
| `storage.get(key)` | Read. Returns `Promise<string \| null>` |
| `storage.set(key, value)` | Write (strings only). Returns `Promise<void>` |
| `storage.remove(key)` | Delete. Returns `Promise<void>` |

Need complex data? `JSON.stringify` / `JSON.parse` on the way in/out.

### Cloud JSON storage (per-session)

Use `api.sessionStorage` for small JSON records that belong to a play session and should follow it across devices. Values remain separate from AI game variables. All methods return a promise containing `{ value, version, exists }`. A never-written key returns `{ value: null, version: 0, exists: false }`; a removed key retains a version, so check `exists` rather than assuming `null` means absent.

| Method | What it does |
|--------|--------------|
| `sessionStorage.get(key)` | Read the current record, or the frozen record in a shared replay |
| `sessionStorage.set(key, value, { expectedVersion })` | Save a JSON value only if its current version matches; options are required |
| `sessionStorage.remove(key, { expectedVersion })` | Remove the value, retaining a versioned tombstone; options are required |

```tsx
const previous = await api.sessionStorage.get("journal");
const saved = await api.sessionStorage.set(
  "journal", { notes: ["Reached the village"] },
  { expectedVersion: previous.version }
);
// Keep saved.version for the next change, including remove().
```

On `SESSION_STORAGE_CONFLICT`, retain the player's draft, reload the record, and reconcile the changes before submitting again. Do not blindly retry stale values. Await a successful response before showing a saved state. Respect `api.readOnly`; shared replays cannot write. Reads and writes require a real session or an authorized shared replay, not editor or guest preview.

Keys use 1–128 ASCII letters, digits, `_`, `.`, `:`, or `-`, starting with a letter or digit. Limits: 32 KiB of serialized UTF-8 JSON per value, 256 KiB of current values per session, 128 keys including tombstones, 16 MiB of value history per session, and 1,000 mutations per hour across the owner's sessions. Keep records bounded; this is not a file store.

Checkpoint restores that change JSON share these capacity and rate limits. Exceeding the 16 MiB history limit or another quota returns HTTP 413; exceeding the hourly mutation limit returns 429. The whole restore rolls back, including media and story state, without a partial restore. Existing history is retained. When values are unchanged, restore does not duplicate history and can proceed even at these JSON limits.

JSON and media references are captured together in checkpoints, same-account branches, and shared snapshots. Restoring a checkpoint restores both. Private live-session data is accessible only to its owner; being the world's creator does not grant access to it. A shared snapshot follows the existing visibility, world publication status, hidden/moderation status, and content-level rules. Under those rules, the sharer and the card's creator are privileged readers of the snapshot, including hidden, unpublished, or sensitive snapshots. Other viewers must pass the applicable checks; unlisted shares are accessible by link. Do not store secrets in records included in a share. There is no automatic migration of arbitrary browser-storage keys.

### Player images (per-session)

Use `api.media` for private player images. Creator assets still use `@asset:`. With server S3 storage configured, uploads are enabled for all worlds unless the operator pauses new uploads.

| Method | What it does |
|--------|--------------|
| `media.list(offset?)` | Returns `{ items, hasMore, uploadsEnabled }`; load further pages when `hasMore` is true |
| `media.pick({ entryId?, metadata? }?)` | Opens the picker and uploads; resolves to `{ mediaId, entryId }`, or `null` if canceled |
| `media.upload(file, { entryId?, filename?, metadata?, uploadId? }?)` | Uploads a `Blob`/`File`; returns `{ mediaId, entryId }`. Reuse `uploadId` for a retry of the same request |
| `media.remove(entryId, version)` | Removes the current session association using the item's version; returns `{ removed }` |

Listed items include `{ id, entryId, filename, metadata, version, sizeBytes, url, thumbnailUrl, deleted }`; `id` is the media ID. Persist `entryId`/`mediaId` in JSON, never signed display URLs or base64 bytes. Refresh URLs with `list()` when reopening and before their five-minute expiry. Deleted items can have null URLs. Removing a session association does not permanently delete the file or release capacity while other references remain.

Static JPEG/PNG/WebP input is limited to 16 MiB and 40 million decoded pixels. The server produces WebP display images up to 2048 pixels plus thumbnails; this is not an original-file backup. Images use the account's shared asset capacity. See the [player image recipe](./recipes/player-images.md) for persistence and migration guidance.

### Lorebook lookups

Read-only access to the card's lore entries and scenarios from inside your interface. Useful for inspecting or hand-picking entries when assembling a side LLM prompt, building an in-game journal viewer, or wiring a debug panel.

| Field / method | What it does |
|----------------|--------------|
| `entries` | `ReadonlyArray<SandboxEntry>` — every enabled entry, already sorted by `position`. See [`SandboxEntry`](#sandboxentry) |
| `getEntry(name)` | Find one entry by **exact name** (case-sensitive). Returns `SandboxEntry \| null`. On `localhost`, a missing lookup logs a one-time warning with the available names — handy when you rename an entry and forget to update the card |
| `worldbooks` | The card's scenarios. Match `entry.worldbookId` against `worldbook.id` to group entries by scenario |

For most cases you don't need to touch these directly: pass `includeLorebook: "matched"` to `ai.complete()` and the server assembles the lore for you (see below). Reach for `entries` / `getEntry` when you need exact control — e.g. *"this NPC only knows entries tagged `tavern`"*.

### Calling the card's AIs vs. raw completions

There are two ways to get words out of a model from your interface:

- **`api.callAi(name, input)`** runs one of the card's [AIs](/creator/ais), set up on the canvas: its model, what it sees, its **Answer format** fields, retries, cooldown and backup lines are all in its settings, and the answer is checked before you get it. Prefer this when the call is part of the game (a fortune teller, a shopkeeper's haggling, an NPC who answers a button). See [Game actions](#game-actions).
- **`api.ai.complete(...)`** below is a raw model call: you write the whole prompt in code, and nothing is checked for you.

### Raw AI completions

Call the LLM **outside** the main chat pipeline. Use for "NPC inner monologue in a side panel", "AI-generated item descriptions", "in-card phone chats", and so on. **Does not** write to message history, does not trigger state updates, does not consume greetings.

```tsx
const api = useYumina()
const text = await api.ai.complete({
  messages: [
    { role: "system", content: "You are a surly merchant." },
    { role: "user", content: "Price me an iron sword." },
  ],
  onDelta: (chunk) => setStreaming((s) => s + chunk),  // optional, per-token
  model: "anthropic/claude-sonnet-4.6",                 // optional, defaults to selectedModel
  maxTokens: 500,                                       // optional, default 2048, max 8192
  temperature: 0.7,                                     // optional
  includeLorebook: "matched",                           // optional — see below
})
```

Returns `Promise<string>` with the full response. When the call fails (rate limit, invalid request, provider error, no session), the promise still **resolves**, with a string of the form `"[Error: <message>]"`; check for that prefix before using the text. It rejects only after the 120-second client-side timeout. In guest preview it resolves `""`.

A message's `content` can also be an array of `{ type: "text", text }` and `{ type: "image_url", image_url: { url } }` parts, or the message can carry `attachments` (images from `pickChatImage()`), for models that read images.

For machine-readable responses, pass `responseFormat: { type: "json_object" }`
and explicitly request JSON in your messages. The SDK forwards this option to
the provider. Support depends on the chosen provider/model; this does not enforce
your game schema. Parse the result and validate every action before applying it.
Omitting the option preserves ordinary text completion. Other format shapes are
rejected with HTTP 400 before inference.

#### `context: "session"` — shared narrative context

Opt in to the authenticated session's current persona, enabled narrative prompts,
and the player's current generation settings:

```tsx
const result = await api.ai.complete({
  context: "session",
  includeLorebook: "matched",
  responseFormat: { type: "json_object" },
  messages: [
    { role: "system", content: 'Return JSON with only {"actions":[],"line":""}.' },
    { role: "user", content: sceneObservation },
  ],
})
```

Persona selection follows the account unless the session is locked, including an
explicit no-persona lock. Public persona description fields are resolved on the
server; private persona notes are never included. Narrative prompts use the same
enabled-folder, selected-model and account-eligibility rules as ordinary chat.

In session context, omitted `includeLorebook` means `"matched"`; `false` excludes
world entries while retaining persona and user prompts. `true`/`"all"` bypasses
keyword selection but still respects state conditions, active scenarios and UI
lore bindings. Matching uses **all supplied user messages**, so a final repair
instruction does not erase the original scene. Native macros use saved session
state and the current persona; last-message macros refer to the supplied history.
System sections, dialogue examples, depth entries and post-history roles retain
their native placement around that history. Caller system messages follow those
narrative sections, and JSON mode adds a final instruction protecting the requested
object protocol. Continue validating the returned schema in your card.

`worldbookIds` (session context only) limits native lore to the listed scenarios
plus entries that aren't in any scenario. Omitted keeps the normal selection; `[]`
means only the entries outside scenarios. The IDs must exist; enabled, activation
and entry conditions still apply. Passing `worldbookIds` without `context: "session"`
returns HTTP 400.

The parent app supplies current player settings; cards cannot supply an arbitrary
preferences object. Explicit call `maxTokens`/`temperature` win, followed by player
settings, world settings, then the raw defaults below. The 8192 output-token cap
and 0–2 temperature range still apply. Supported sampling, reasoning and streaming
preferences follow ordinary chat forwarding (including model-specific repetition
penalty). Invalid session settings return HTTP 400.

Only the supplied side-call history is used: saved chat, summaries and pending
chat effects are not imported. `maxContext` and world lore budgets limit optional
matched entries; they do not truncate required lore, presets or the caller's
protocol, or guarantee that the complete prompt fits every provider's window.
Returned text does not automatically apply effects or persist messages. Leaving
`context` omitted preserves the existing raw behavior described below.

#### Optional structured output

Pass `responseFormat` to request JSON output. Omit it for the existing text behavior, or use `{ type: "json_object" }` for the existing provider-specific JSON mode. Strict schema output currently requires an OpenRouter connection (official or BYOK):

```tsx
const text = await api.ai.complete({
  messages: [{ role: "user", content: "Choose an action: wait." }],
  responseFormat: {
    type: "json_schema",
    json_schema: {
      name: "decision_v1",
      strict: true,
      schema: {
        type: "object",
        properties: { action: { type: "string", enum: ["wait"] } },
        required: ["action"],
        additionalProperties: false,
      },
    },
  },
})
```

The wrapper accepts exactly the fields shown. Schema names must match `/^[A-Za-z0-9_-]{1,64}$/`, `strict` must be `true`, and the schema root must be an object with `type: "object"`. The full serialized format is limited to 16,384 UTF-8 bytes, traversal depth 16 (format root at depth zero), and 2,048 visited values. Use plain JSON values; cycles, accessors and serialization hooks are rejected. Schema characters count toward the existing 50,000-character content limit and prompt affordability estimate.

Other provider adapters reject `json_schema` with HTTP 400 and code `UNSUPPORTED_RESPONSE_FORMAT`: “This provider does not support JSON Schema side completions.” OpenRouter sends the entire schema and requires an endpoint that supports the requested parameters, preserving official routing preferences and BYOK account routing. Endpoint-specific schema errors come back as an `"[Error: …]"` result, never as an empty success or a weaker format. Check for it and provide an appropriate fallback.

A schema constrains response structure, not permission to act. Parse and validate returned content, current state, allowed actions and evidence before applying any state change. Provider-specific schema keywords are checked upstream.

#### Limits and costs

| Limit | Value | Source |
|-------|-------|--------|
| Max messages per call | 50 | Server rejects with HTTP 400 |
| Max total content | 50,000 characters across all messages | Server rejects with HTTP 400 |
| `maxTokens` default | 2048 | Raw default; session context inherits settings first |
| `maxTokens` ceiling | 8192 | Larger values are clamped silently |
| `temperature` range | 0–2, default 1.0 | Out-of-range values are clamped |
| Default model | Player's `selectedModel`, falling back to `anthropic/claude-sonnet-4.6` if neither `model` nor `selectedModel` is set | |
| Rate limit | **Dedicated side-call pool** — 100 side calls per minute, independent of the main chat's per-minute budget | Returns HTTP 429 + `RATE_LIMITED` code and a `Retry-After` header on overflow |
| Credits | Same per-token billing as the main chat. **BYOK users skip server credit deduction** but still pay their own provider | Logged with endpoint `"side-completion"` |
| Auth | The session must belong to the current player; otherwise the call fails with HTTP 404 | |

#### `ai.decide` — choice questions

`await api.ai.decide({ state, questions })` asks a model to pick one option per question and returns probabilities instead of prose. `state` is a small JSON object describing the situation. `questions` maps a question name to `{ type: "choice", instructions, criteria }`, where `criteria` maps each option label to a description of when it applies:

```tsx
const { answers } = await api.ai.decide({
  state: { suspect: "Vex", lastLine: playerText },
  questions: {
    lying: {
      type: "choice",
      instructions: "Is the player lying to the guard?",
      criteria: { yes: "The statement contradicts what they did", no: "The statement fits what they did" },
    },
  },
})
// answers.lying → { choice: "yes", probabilities: { yes: 0.8, no: 0.2 }, confidence: 0.8 }
```

Up to 8 questions per call, up to 64 options per question, option labels up to 128 characters, about 32,000 characters in total. It uses the server's decision model; official use is paid by the platform, and an OpenRouter BYOK key may bill the player's provider. It changes nothing in the story or the state. A failure rejects (there's a 15-second limit); don't fill in a missing answer yourself. Needs a real session.

#### `ai.context` — assemble side-actor direction

`await api.ai.context({ actor: "voice" | "director", model?, recentMessages? })` returns `{ instructions, receipt }` for the current editable saved session. It assembles active world direction and applicable user presets without generating text, billing a model call, or changing state. Pass the actual target model explicitly: a realtime voice model and a text model can match different entry conditions. The SDK does not substitute the selected chat model for this method.

`recentMessages` contains only public actor-witnessed `{ role: "user" | "assistant", content }` records: at most 24 messages, 4,000 characters each and 12,000 total. No ordinary chat history or account persona profile is imported. `{{user}}` uses the card's fictional player name; private variables cannot expand into instructions. Actor tags scope entries; shared active style/system presets apply to both actors. Normal entry activation, lore matching and macros still apply. Ordinary `ai.complete` defaults are unchanged.

The receipt identifies included and omitted entry IDs, omission reasons and applicable user prompt IDs, plus model, persona/history policy and instruction character counts. It contains no entry contents. Instructions are capped at 9,000 characters; excess direction rejects instead of silently truncating. Catch failures and keep the prior confirmed direction visible as stale until a successful refresh. For a legacy live call, pass a successful replacement to `realtimeVoice.updateInstructions`; balance calls keep initial instructions fixed. `updateContext` alone does not replace initial direction.

#### `includeLorebook` — auto-inject world lore

Without `context: "session"`, side calls bypass the main chat's prompt assembly. Pass `includeLorebook` and the server prepends a system message built from the world's entries:

| Value | Behavior |
|-------|----------|
| omitted / `false` | No injection (default). Use for translations, summaries, classification — anything that doesn't need world context |
| `true` / `"all"` | Inject every enabled non-greeting entry, sorted by `position`. Predictable, larger token cost |
| `"matched"` | Run the same keyword matcher the main chat uses against the **last user message** in `messages`. `alwaysSend` entries are always included; keyword-triggered entries are added only when relevant. **Recommended for in-character side calls** |

Without it, an in-character side call only knows what your messages tell it, so a character's voice drifts away from the main chat. With `"matched"`, a phone chat with an NPC sees the same world lore + character profile the main chat sees.

```tsx
// A phone chat that stays in canon
api.ai.complete({
  messages: [
    { role: "system", content: "Stay strictly in character as Balder. Reply in one or two short lines." },
    ...history,
    { role: "user", content: userText },
  ],
  includeLorebook: "matched",  // server pulls Balder's profile + relevant world lore
})
```

If you need finer control — inject a specific entry by name, or only entries with a specific tag — iterate `api.entries` and assemble the system message yourself instead of using `includeLorebook`:

```tsx
const tavernLore = api.entries
  .filter((e) => e.tags?.includes("tavern"))
  .map((e) => `【${e.name}】\n${e.content}`)
  .join("\n\n")

api.ai.complete({
  messages: [
    { role: "system", content: `You are the tavern keeper.\n\n${tavernLore}` },
    { role: "user", content: userText },
  ],
})
```

**`"matched"` mode caveats**: it only scans the last user message for keywords (not full history), and condition-gated entries that depend on game variables don't fire on side calls (the matcher sees an empty state stub). Use `true` to force-include everything if precision matters more than tokens.

### Context injection

Inject a **one-shot** context message into the **next** main-chat AI turn. Consumed after one use; **no** visible chat message is created. Use it for things the main AI should know about but the player shouldn't see as a chat bubble: a phone message, offstage NPC dialogue, a change in the surroundings.

```tsx
api.injectContext("You just received a cryptic text: 'Tonight, 9pm, usual place.'", { role: "system" })
// On the player's next message, the main AI will see this as a system message.
```

`options`: `{ role?: "system" \| "user" }` (defaults to `"system"`).

For something the AI should see on **every** call while it stays true (which room the player is in, what's on screen), use `setScene` instead.

### Model picker

| Field / method | What it does |
|----------------|--------------|
| `selectedModel` | Current model ID |
| `userPlan` | User's plan tier |
| `preferredProvider` | `"official"` or `"private"` |
| `setPreferredProvider(provider)` | Switch between `"official"` and `"private"`. Returns `Promise<{ ok, provider?, error? }>` |
| `setModel(modelId)` | Switch models (fire-and-forget) |
| `getModels(provider?)` | Returns `Promise<{ models, pinnedModels, recentlyUsed }>` where `models` is `Array<{ id, name, provider, contextLength, supportsImages? }>`. Pass `"private"` for the models on the player's own key |
| `pinModel(modelId)` / `unpinModel(modelId)` | Pin / unpin a model. Returns `Promise<{ pinnedModels, accepted }>`; `accepted` is `false` when the pin was refused because the list is full |
| `modelFallback` | When the chosen model can't be used and the host is offering a replacement: the notice to show, otherwise `null`. `<Chat>` and `<MessageInput>` already handle it |

The API also carries the fields and methods the built-in chat uses for its own panels: model mixing (`mixMode`, `modelPool`, `setMixMode`, `addToPool`, `removeFromPool`, `setPoolWeight`, `togglePoolLock`), a local model on the player's machine (`localBridge`, `reconnectLocalBridge`, `resolveModelFallback`, `cancelModelFallback`), the player's prompts (`playerPrompts`, `togglePlayerPrompt`), session memory and summaries (`memorySummaryEnabled`, `getSessionMemory`, `getSessionSummary` and the related setters), Lore Shift (`getLiveCanon` and related) and the state guard (`getStateGuardSettings`, `setStateGuardSettings`). Their shapes follow the built-in UI and aren't covered here.

### Assets

| Method | What it does |
|--------|--------------|
| `resolveAssetUrl(ref)` | Turn an `@asset:<id>` reference into its `/cdn/<id>` URL. Pure string transform, no network. HTTP/HTTPS URLs pass through unchanged. `<img src="@asset:…">` and `@asset:` inside inline styles and `<style>` tags are resolved for you; call this when you need the URL as a string |

### Markdown

| Method | What it does |
|--------|--------------|
| `renderMarkdown(text)` | Turn markdown into **safe HTML** (HTML entities escaped, dangerous tags stripped, formatting preserved). Feed the result to `dangerouslySetInnerHTML` inside a custom bubble — see example below |

```tsx
<div dangerouslySetInnerHTML={{ __html: api.renderMarkdown(msg.rawContent) }} />
```

---

## Components

### `<Chat>`

The platform's full chat experience. With no props, it's the default chat.

Includes: message list, auto-scroll, streaming cursor, swipe controls, message actions (edit/delete/regenerate), input bar, choice buttons, model picker, read-only mode, greeting placeholder.

```tsx
<Chat renderBubble={(msg) => <MyBubble {...msg} />} />
```

#### Props

| Prop | Type | Description |
|------|------|-------------|
| `renderBubble?` | `(props: BubbleProps) => ReactNode` | Customize how each message bubble looks. Falls back to default markdown rendering if omitted |
| `className?` | `string` | Extra CSS class on the outer container |
| `children?` | `ReactNode` | Content rendered **above** the message list (e.g. a fixed HUD header) |
| `design?`, `fontMap?` | object | The message look from the [Player interface](/creator/player-view) editor (**Message look** and its fine-tuning). Used only when there's no `renderBubble`. The visual editor fills these in; you normally don't |

#### BubbleProps

The `msg` object your `renderBubble` callback receives:

| Field | Type | Meaning |
|-------|------|---------|
| `contentHtml` | `string` | **Pre-rendered safe HTML** (markdown already converted). Usually piped to `dangerouslySetInnerHTML` |
| `content` | `string` | The markdown text with `[var: op value]` directives removed. Use it for your own regex matches, or pass a slice of it to `renderMarkdown` |
| `rawContent` | `string` | Raw markdown text before rendering (directive text included) |
| `role` | `"user" \| "assistant" \| "system"` | Message origin |
| `messageIndex` | `number` | Position in the list (0 = first, usually the greeting) |
| `isStreaming` | `boolean` | `true` while this message is being streamed |
| `stateSnapshot` | `Record<string, unknown> \| null` | Game state at the moment this message was generated (useful for "what were HP/location back then") |
| `variables` | `Record<string, unknown>` | Current (latest) game variables |
| `renderMarkdown` | `(text) => string` | Helper: turn any markdown text into safe HTML |

### `<MessageList>`

Just the message stream (with scroll, streaming cursor, swipe controls). **No** input bar.

```tsx
<MessageList />
```

Does not take `renderBubble` — to customize bubbles use `<Chat renderBubble={...} />`, or skip `<MessageList>` entirely and read `api.messages` directly (the visual-novel pattern).

### `<MessageInput>`

Just the input bar (with model picker, choice buttons, continue/restart menu, streaming state).

```tsx
<MessageInput />
```

Auto-hides when `api.readOnly` is `true`.

### `<ChatCanvas>`

An alias for `<Chat />`, kept so older cards keep working. Use `<Chat />` in new code.

### Model picker components

| Component | What it does |
|-----------|--------------|
| `<ModelTrigger onClick={...} />` | The model button from the chat composer: current model name and the player's balance. Props: `onClick` (required), `model?`, `provider?`, `showBalance?` (default `true`), `compactBalance?`, `className?` |
| `<ModelPickerModal open={...} onClose={...} />` | The model picker. With only `open` and `onClose` in a live session it opens the same picker as the chat (you can also call `api.openModelPicker()`). Pass `onSelectModel(modelId)`, `title` or `subtitle` to use it for a choice of your own instead of the chat model |
| `<SessionMemoryModal open={...} onClose={...} />` | The chat's session memory dialog. Needs the session memory extension; check `api.memorySummaryEnabled` before showing a button for it |

A full-screen interface without `<MessageInput>` has no model button unless you add one:

```tsx
var [pickerOpen, setPickerOpen] = React.useState(false)
// ...
<ModelTrigger onClick={function () { setPickerOpen(true) }} />
<ModelPickerModal open={pickerOpen} onClose={function () { setPickerOpen(false) }} />
```

### Lore controls

These send a lore entry to the AI only while a control in your interface is on. The player never sees the entry's text.

| Component | What it does |
|-----------|--------------|
| `<LoreSlot id="slot-id" />` | Renders nothing. While it's mounted, the entry bound to `slot-id` goes to the AI; unmount it and the entry stops. Mount it conditionally (`{open && <LoreSlot id="x" />}`) |
| `<LoreButton slotId label icon? description? variant? className? />` | One button that switches a slot on and off. `variant`: `"chip"` (small pill, default) or `"card"` (full-width row with a toggle and `description`) |
| `<LoreSwitch slotId onLabel? offLabel? onIcon? offIcon? className? />` | Two buttons for one slot: one turns it on, the other off. The labels default to Chinese (开启 / 关闭), so pass your own |
| `<LoreGroup slots={[{ id, label, icon?, description? }]} variant? className? />` | A row of options where at most one slot is on at a time. Picking the active one again turns it off |
| `<LorePanel title? slots? defaultOpen? className?>…</LorePanel>` | A collapsible panel to hold lore buttons. `slots` lists the slot ids to count in its "how many are on" badge. `title` defaults to Chinese (知识库), so pass your own |

`LoreButton`, `LoreSwitch` and `LoreGroup` remember their state in a variable named `__lore_<slotId>`, so the choice survives reloads, checkpoints and branches.

Put a control in your code and a matching entry is created for its slot id; it's listed under **Frontend lore** in the Lorebook (**Panels → Lorebook**). Write what the AI should read there. You can stack variable conditions on the binding too: then the control has to be on **and** the conditions have to hold. `api.loreUiBindings` lists the bindings.

---

## Behavior code (`ctx`)

A [behavior](/creator/automation#code-behaviors) can include a piece of **Code** among its effects. It runs inside the card's sandbox, against the live API, when the behavior fires, and only while the player has the game open. The code body is an async function, so `await` works. It gets one object, `ctx`:

| Field / method | What it does |
|----------------|--------------|
| `ctx.vars` | A copy of the current values, keyed by variable ID |
| `ctx.get(name)` | One value, by display name or ID |
| `ctx.set(name, value)` | Write a value |
| `ctx.add(name, n)` | Add `n` to a number |
| `ctx.push(name, item)` | Add an item to a list |
| `ctx.toast(text)` | Show the player a notice |
| `ctx.say(text)` | Send a line as the player |
| `ctx.callAi(ai, input?)` | Call one of the card's AIs; resolves like `api.callAi` |
| `ctx.random(a, b)` | A whole number from `a` to `b`, inclusive |
| `ctx.event` | `{ reactionId }`: the behavior that fired |

Writes collect while the code runs and are saved together when it finishes (through `patchVariables`). If the code throws, the error is logged to the browser console and the values it wrote before the error are still saved.

```js
// Draw two cards from the deck
const deck = [...(ctx.get("deck") || [])]
const hand = []
for (let i = 0; i < 2 && deck.length; i++) {
  hand.push(deck.splice(ctx.random(0, deck.length - 1), 1)[0])
}
ctx.set("deck", deck)
ctx.set("hand", hand)
ctx.toast("You drew " + hand.join(" and "))
```

---

## `useAssetFont()`

Load an uploaded font asset as an `@font-face` and get back a string ready to drop into a CSS `font-family` value.

```tsx
const fontFamily = useAssetFont("@asset:my-font-id", {
  family: "Cinzel",
  fallback: "serif",
})
return <div style={{ fontFamily }}>Ancient runes</div>
```

### Signature

```ts
useAssetFont(
  assetRef: string | null | undefined,
  options?: AssetFontOptions
): string
```

The font loads asynchronously. While loading, the hook returns `options.fallback` (defaulting to `"serif"`); when ready, a re-render fires with the full family string (scoped with a suffix to avoid name clashes).

### `AssetFontOptions`

| Field | Type | Description |
|-------|------|-------------|
| `family?` | `string` | Font family name. Inferred from filename or `assetRef` if omitted |
| `fallback?` | `string` | Fallback font shown during load. Default `"serif"` |
| `filename?` | `string \| null` | Original filename, used to guess format |
| `mimeType?` | `string \| null` | MIME type, used to guess format |
| `format?` | `"opentype" \| "truetype" \| "woff" \| "woff2" \| null` | Explicit format override |
| `weight?` | `string \| number` | `font-weight` |
| `style?` | `string` | `font-style` (e.g. `"italic"`) |
| `stretch?` | `string` | `font-stretch` |
| `display?` | `FontDisplay` | `font-display` (default `"swap"`) |

---

## Types

### `SandboxMessage`

Shape of each entry in `api.messages`:

```ts
interface SandboxMessage {
  id: string
  sessionId: string
  role: "user" | "assistant" | "system"
  content: string
  status?: "complete" | "streaming" | "failed"
  errorMessage?: string | null
  stateChanges?: Record<string, unknown> | null   // diff of variable updates from this message
  stateSnapshot?: Record<string, unknown> | null  // full state at message generation
  swipes?: Array<{ content?, rawContent?, createdAt, model?, tokenCount?, refusal? }>
                                                  // alternative AI replies; only the active one keeps its text
  activeSwipeIndex?: number
  model?: string | null
  tokenCount?: number | null
  generationTimeMs?: number | null
  creditCost?: number | null
  compacted?: boolean                   // hidden in the "older messages" section
  attachments?: Array<{ type, mimeType, name, url }> | null
  createdAt: string                     // ISO-8601
}
```

Swipes don't carry their own `stateSnapshot` in the sandbox, and swipes other than the active one have no `content` or `rawContent`.

### `Checkpoint`

```ts
interface Checkpoint {
  id: string
  name: string
  messageCount: number
  createdAt: string   // ISO-8601
}
```

### `SandboxEntry`

A single read-only lore entry, exposed via `api.entries` and `api.getEntry()`:

```ts
interface SandboxEntry {
  id: string
  name: string
  content: string
  keywords: string[]
  position: number
  section: "system-presets" | "examples" | "chat-history" | "post-history"
  enabled: boolean
  role: string                            // "system" | "character" | "lore" | etc.
  tags?: string[]
  worldbookId?: string                    // the scenario it belongs to; matches api.worldbooks IDs
  folderId?: string                       // the folder you filed it in, if any
  audience?: "ai" | "player" | "both"
  conditions?: Condition[]                // variable conditions, if it's conditional lore
  conditionLogic?: "all" | "any"
  portrait?: string | null                // character portrait as an absolute URL
  portraitVideo?: { idle: string | null; speaking: string | null } | null
}
```

This is a slim view of the engine's internal `WorldEntry` — only the fields a card needs for prompt assembly and display. The runtime pre-filters disabled entries and pre-sorts by `position`, so cards never need to do either themselves.

### `BranchContext`

```ts
interface BranchNode {
  id: string
  name: string | null
  parentSessionId: string | null
  branchedFromMessageId: string | null
  messageCount: number
  updatedAt: string   // ISO-8601
  createdAt: string   // ISO-8601
}

interface BranchContext {
  current: BranchNode          // the session you're in
  parent: BranchNode | null    // the branch you forked from, or null at the root
  siblings: BranchNode[]       // other branches forked from the same parent, oldest first
  children: BranchNode[]       // branches forked off `current`, oldest first
}
```

---

## Blocked browser APIs

Your code runs inside a cross-origin `sandbox="allow-scripts"` iframe with **no** `allow-same-origin`, and its content security policy has `connect-src 'none'`. That means:

- No access to parent-app cookies / localStorage
- No network requests of your own (`fetch`, `XMLHttpRequest`, WebSocket)
- No direct `window.parent` manipulation

Some browser APIs are replaced by the sandbox so older code doesn't crash:

### Replacements

| What you wrote | What actually happens |
|----------------|----------------------|
| `fetch('/api/...')` | The host doesn't serve it: the promise resolves with an empty response that carries no data. Use the SDK methods below |
| `fetch('/cdn/...')` | Passed to the browser, which blocks it (`connect-src 'none'`). Use `api.fetchAsset()` to read an asset's bytes |
| `fetch('any other URL')` | **Rejected** (throws) |
| `localStorage.getItem/setItem/removeItem/clear` | Writes are saved per world through the host, but `getItem` only sees values written since the page loaded. Use `api.storage` to read saved values |
| `sessionStorage.*` | Same |
| `navigator.clipboard.writeText()` | Equivalent to `api.copyToClipboard()` |
| `navigator.clipboard.readText() / read() / write()` | **Rejected** (throws) |
| `window.location.pathname / href / assign / replace` | Synthetic object; `pathname` is always `/app/chat/{sessionId}`; assigning / calling `assign` / `replace` triggers navigation |
| `window.location.reload()` | Bridged to reload the session |
| `window.__yuminaToggleImmersive()` | Equivalent to `api.toggleImmersive()` |

### Use the SDK instead

| Don't write | Write |
|------------|-------|
| `fetch('/api/sessions', { method: 'POST' })` | `api.createSession(worldId)` |
| `fetch('/api/sessions/' + sid, { method: 'DELETE' })` | `api.deleteSession(sid)` |
| `localStorage.getItem("k")` | `await api.storage.get("k")` |
| `window.location = "/app/hub"` | `api.navigate("/app/hub")` |
| `navigator.clipboard.writeText(t)` | `api.copyToClipboard(t)` |

### Browser APIs that ARE available

Anything that doesn't reach the network or the parent's origin works as in any browser, with no SDK wrapper needed:

| API | Typical use in cards |
|-----|----------------------|
| `<input type="file">` + `FileReader` | Read a file the player picks. To keep a player's image, upload it with `api.media` — see [Recipe: Player-Uploaded Images](./recipes/player-images.md) |
| `URL.createObjectURL` / `revokeObjectURL` | Generate a temporary in-memory URL for a `Blob` (e.g. preview before save) |
| `<canvas>` + `getContext("2d")` + `toDataURL` / `toBlob` | Resize, crop, or composite images before uploading |
| `<img>`, `<audio>`, `<video>` | Render `https:` URLs, `@asset:...` references, `data:`/`blob:` URLs |
| `<iframe>` | Embed pages hosted on `*.pages.dev`, `*.vercel.app`, `*.netlify.app` or `*.github.io` |
| `IntersectionObserver`, `ResizeObserver`, `matchMedia`, `requestAnimationFrame` | Standard layout / animation primitives |
| `crypto.randomUUID`, `crypto.subtle` | Hashing and ID generation for client-side state |
| `WebAudio` (`AudioContext`) | Lightweight audio synthesis or analysis |
| Pointer lock | First-person controls (`requestPointerLock`) |

---

## At-a-glance: the whole API

One table, scan once.

```
useYumina()
├── State reads
│   ├── variables, globalVariables
│   ├── worldName, worldId, worldCover, background, sessionId
│   ├── currentUser (account), user (persona-aware)
│   ├── mode, capabilities, language
│   ├── messages, hasEarlierMessages, isLoadingEarlier
│   ├── isStreaming, streamingContent, streamingReasoning
│   ├── pendingChoices, error, errorCode, sendFailureNonce, composerSendKey
│   ├── readOnly, greetingContent, canvasMode, speakerBubbles
│   ├── checkpoints
│   ├── entries, worldbooks, loreUiBindings
│   └── selectedModel, userPlan, preferredProvider, balance
├── Game actions
│   ├── sendMessage(text, attachments?)
│   ├── pickChatImage() → Promise<image | null>
│   ├── setVariable(id, value)
│   ├── patchVariables(values) → Promise<void>
│   ├── executeAction(actionId)
│   ├── executeActionAndWait(actionId, params?) → Promise<{applied, variables, firedIds}>
│   ├── callAi(ai, input?) → Promise<{text, fields, fallback} | null>
│   ├── onAiOutput(channel?, cb) → unsubscribe
│   ├── setScene(scene, { events? })
│   ├── onStoryEvent(cb) → unsubscribe
│   ├── switchGreeting(index) → Promise<void>
│   ├── clearPendingChoices()
│   └── setComposerDraft(text)              // prefill, no send
├── Chat control
│   ├── editMessage(id, content, options?) → Promise<boolean>
│   ├── deleteMessage(id) → Promise<boolean>
│   ├── regenerateMessage(id)
│   ├── continueLastMessage()
│   ├── stopGeneration()
│   ├── restartChat()
│   ├── swipeMessage(id, direction) → Promise
│   └── loadEarlierMessages() → Promise<boolean>
├── Sessions / branching
│   ├── revertToMessage(id) → Promise<void>
│   ├── branchFromMessage(id) → Promise<string | null>
│   ├── getBranchContext() → Promise<BranchContext>
│   ├── createSession(worldId) → Promise<string>
│   ├── deleteSession(id) → Promise<void>
│   └── listSessions(worldId) → Promise<Array>
├── Checkpoints
│   ├── saveCheckpoint() → Promise<void>
│   ├── loadCheckpoints() → Promise<void>
│   ├── restoreCheckpoint(id) → Promise<void>
│   └── deleteCheckpoint(id) → Promise<void>
├── Audio
│   ├── playAudio(trackId, opts?)
│   ├── stopAudio(trackId?, fadeDuration?)
│   ├── pauseAudio(trackId)
│   ├── resumeAudio(trackId)
│   ├── onAudioEnded(cb) → unsubscribe
│   ├── setAudioVolume(type, volume)
│   └── getAudioVolume(type) → number
├── Voice
│   ├── tts.speak / stop / onPlaybackFrame / setPrefs / preview, ttsState
│   ├── voice.prepare / record / stop / cancel / setPrefs, voiceInputState
│   └── realtimeVoice.getConfig / finish / prepare / start / interrupt / stop / setMuted / updateContext /
│       updateInstructions / reactToScene / cancelSceneReaction / resolveTool /
│       setSpatial / onEvent
├── UI / navigation
│   ├── toggleImmersive()
│   ├── openPersonaManager(), getPersonaProfile() → Promise
│   ├── openModelPicker(options?), openSessionManager(), sharePlaythrough()
│   ├── openSupport() → Promise<{opened, reason}>, openCreditTopUp()
│   ├── fetchAsset(ref) → Promise<{ok, bytes?, contentType?, error?}>
│   ├── copyToClipboard(text)
│   ├── navigate(path)
│   └── showToast(message, type?)
├── Storage
│   ├── storage.get(key) → Promise<string | null>
│   ├── storage.set(key, value) → Promise<void>
│   └── storage.remove(key) → Promise<void>
├── Cloud session JSON
│   ├── sessionStorage.get(key) → Promise<{value, version, exists}>
│   ├── sessionStorage.set(key, value, {expectedVersion}) → Promise<{value, version, exists}>
│   └── sessionStorage.remove(key, {expectedVersion}) → Promise<{value, version, exists}>
├── Session images
│   ├── media.list(offset?) → Promise<{items, hasMore, uploadsEnabled}>
│   ├── media.pick(options?) → Promise<{mediaId, entryId} | null>
│   ├── media.upload(file, options?) → Promise<{mediaId, entryId}>
│   └── media.remove(entryId, version) → Promise<{removed}>
├── Lorebook
│   ├── entries (ReadonlyArray<SandboxEntry>)  // sorted by position, enabled only
│   ├── worldbooks
│   └── getEntry(name) → SandboxEntry | null
├── AI
│   ├── ai.complete({ messages, onDelta?, model?, maxTokens?, temperature?, context?, worldbookIds?, includeLorebook?, responseFormat? }) → Promise<string>
│   │    // includeLorebook: true | "all" | "matched" — auto-inject world lore
│   ├── ai.decide({ state, questions }) → Promise<{ answers }>
│   └── ai.context({ actor, model?, recentMessages? }) → Promise<{ instructions, receipt }>
├── Context injection
│   └── injectContext(message, { role? })
├── Model picker
│   ├── setModel(modelId), setPreferredProvider(provider) → Promise
│   ├── getModels(provider?) → Promise<{ models, pinnedModels, recentlyUsed }>
│   ├── pinModel(id), unpinModel(id) → Promise<{ pinnedModels, accepted }>
│   └── modelFallback
├── Assets
│   └── resolveAssetUrl(ref) → string
└── Markdown
    └── renderMarkdown(text) → string   // safe HTML

Sandbox globals (no import)
├── React
├── useYumina, useAssetFont
├── Icons  (every Lucide icon)
├── Chat, MessageList, MessageInput, ChatCanvas (alias of Chat)
├── ModelTrigger, ModelPickerModal, SessionMemoryModal
├── LoreSlot, LoreButton, LoreSwitch, LoreGroup, LorePanel
└── Tailwind utility classes (CSS-level)

Behavior code (ctx)
└── vars, get, set, add, push, toast, say, callAi, random, event

Blocked / replaced
├── fetch(...) → blocked; use SDK methods / fetchAsset
├── localStorage / sessionStorage → write-through only; read with api.storage
├── window.location → synthetic + navigate
└── navigator.clipboard → copyToClipboard

Browser APIs that work as-is
├── <input type="file"> + FileReader      // then api.media.upload
├── <canvas>, URL.createObjectURL          // image processing
├── IntersectionObserver, ResizeObserver, matchMedia, rAF
├── crypto.randomUUID, crypto.subtle
└── WebAudio (AudioContext)
```

---

**Next**: the [Custom UI Guide](./custom-ui-deep.md) has worked examples, and the [Recipes](./recipes/scene-jumping.md) have complete builds to start from.
