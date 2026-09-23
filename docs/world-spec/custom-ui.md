# Custom UI (rootComponent)

The `rootComponent` is a virtual filesystem of React/TSX files that run in a sandboxed iframe. It provides the world's visual layer and has full access to game state, chat control, session management, AI completions, and audio.

## rootComponent Schema

```json
{
  "rootComponent": {
    "id": "uuid",
    "name": "My World UI",
    "entryFile": "index.tsx",
    "files": {
      "index.tsx": "export default function App() { ... }",
      "bubble.tsx": "export default function Bubble({ content, role }) { ... }"
    },
    "updatedAt": "2024-01-01T00:00:00Z"
  }
}
```

## Entry Point

`index.tsx` must export a default component:

```tsx
export default function App() {
  return <Chat />;
}
```

With custom message bubbles:

```tsx
import Bubble from "./bubble";

export default function App() {
  return <Chat renderBubble={Bubble} />;
}
```

Full app mode:

```tsx
export default function App() {
  var api = useYumina();
  
  return (
    <div style={ {display: "flex", flexDirection: "column", height: "100vh"} }>
      <header>HP: {api.variables.health}</header>
      <MessageList />
      <MessageInput />
    </div>
  );
}
```

## useYumina() — Complete API Reference

### State Reads

```typescript
interface SandboxedYuminaAPI {
  // Game state
  variables: Record<string, unknown>;
  globalVariables: Record<string, unknown>;
  
  // World info
  worldName: string;
  worldId: string;
  sessionId: string;
  
  // User identity
  currentUser: { id: string; name?: string; image?: string | null } | null;
  user: { name: string; avatar: string | null };  // Persona-aware
  
  // Chat state
  messages: SandboxMessage[];
  isStreaming: boolean;
  streamingContent: string;
  streamingReasoning: string;
  pendingChoices: string[];
  error: string | null;
  readOnly: boolean;
  
  // Lorebook
  entries: ReadonlyArray<SandboxEntry>;
  getEntry(name: string): SandboxEntry | null;
  
  // Session
  checkpoints: Array<{ id: string; name: string; messageCount: number; createdAt: string }>;
  greetingContent: string | null;
  mode: "session" | "guest-preview";
  capabilities: {
    canSendMessage: boolean;
    canPersistSession: boolean;
    canUseSessionApis: boolean;
    requiresAuth: boolean;
  };
  
  // UI state
  canvasMode: "chat" | "custom" | "fullscreen";
  selectedModel: string;
  userPlan: string;
  preferredProvider: "official" | "private";
  language: string;
  // Audio volumes are not exposed as direct properties — read them via
  //   getAudioVolume("bgm"): number
  //   getAudioVolume("sfx"): number
}
```

### Chat Actions

```typescript
type ChatImageInput = { type: "image"; mimeType: string; name: string; data: string };
sendMessage(text: string, attachments?: ChatImageInput[]): void;
editMessage(messageId: string, content: string): Promise<boolean>;
deleteMessage(messageId: string): Promise<boolean>;
regenerateMessage(messageId: string): void;
continueLastMessage(): void;
stopGeneration(): void;
restartChat(): void;
swipeMessage(messageId: string, direction: "left" | "right"): Promise<Record<string, unknown>>;
setComposerDraft(text: string): void;
clearPendingChoices(): void;
```

### Session Management

```typescript
revertToMessage(messageId: string): Promise<void>;
branchFromMessage(messageId: string): Promise<string | null>;
getBranchContext(): Promise<BranchContext>;
createSession(worldId: string): Promise<string>;
deleteSession(sessionId: string): Promise<void>;
listSessions(worldId: string): Promise<Array<Record<string, unknown>>>;
navigate(path: string): void;
```

### Checkpoints

```typescript
saveCheckpoint(): Promise<void>;
loadCheckpoints(): Promise<void>;
restoreCheckpoint(checkpointId: string): Promise<void>;
deleteCheckpoint(checkpointId: string): Promise<void>;
```

### AI Completions

```typescript
ai.complete(params: {
  messages: Array<{
    role: string;
    content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
    attachments?: ChatImageInput[];
  }>;
  onDelta?: (text: string) => void;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  includeLorebook?: boolean | "all" | "matched";
}): Promise<string>;
```

Make raw LLM calls with optional streaming and lorebook injection. Use for NPC generators, dynamic descriptions, hint systems, or any AI logic outside the main chat flow.

User messages can include images through `attachments` in either API. Pass bare base64 in `data` (remove the `data:...;base64,` prefix); `sendMessage("", attachments)` sends images without text. A request accepts up to four PNG/JPEG/WebP/GIF images, 8 MB each and 16 MB total. For `ai.complete`, ordered `text`/`image_url` parts also work; image URLs must be data URLs or Yumina's public `/cdn/key/` URLs. Rendering an `<img>` or placing its URL in plain text does not send the image to the model. Use an image-capable model, handle failures and retain the draft. `supportsImages` is present only when capability is known; an omitted value does not establish support.

### Game Actions

```typescript
setVariable(id: string, value: unknown, options?: {
  scope?: string;
  targetUserId?: string;
}): void;
executeAction(actionId: string): void;
injectContext(message: string, options?: { role?: "system" | "user" }): void;
patchVariables(values: Record<string, unknown>): Promise<void>;
```

`patchVariables` saves a partial map of variable IDs in one session-state request and resolves after the server confirms the saved state. It shares the queue used by ordinary variable writes and rejects on save failure, timeout, a changed session, or a read-only/guest view. It has no scope or target-player options. Await it before starting an action that depends on the saved values, for example `await api.patchVariables({ "player-setup": setup }); api.sendMessage("Begin");`. Catch failures and preserve the form so the player can retry; a timeout does not prove the server discarded the write.

If newer state arrives while the request is pending, the host reconciles independent requested variables only when safe. It withholds stale confirmations after rewinds, restarts, or other replaced history; a server acknowledgment does not guarantee that its full snapshot replaces the current local state.

### Audio

```typescript
playAudio(trackId: string, opts?: {
  volume?: number;
  fadeDuration?: number;   // seconds
  chainTo?: string;
  maxDuration?: number;    // seconds
  duckBgm?: boolean;
  loop?: boolean;          // override the track's loop for this playback
}): void;
stopAudio(trackId?: string, fadeDuration?: number): void;  // fade in seconds; destroys the element
pauseAudio(trackId: string): void;   // pause in place, keep position
resumeAudio(trackId: string): void;  // resume a track paused with pauseAudio
onAudioEnded(cb: (trackId: string) => void): () => void;  // fires when a non-looping track ends; returns unsubscribe
setAudioVolume(type: "bgm" | "sfx", volume: number): void;
getAudioVolume(type: "bgm" | "sfx"): number;
```

### Storage (World-Scoped, Persistent)

```typescript
storage.get(key: string): Promise<string | null>;
storage.set(key: string, value: string): Promise<void>;
storage.remove(key: string): Promise<void>;
```

### UI Controls

```typescript
toggleImmersive(): void;
openPersonaManager(): void;
getPersonaProfile(): Promise<{ name: string; appearance: string; personality: string; backstory: string; entries?: Array<{ title: string; content: string }> } | null>;
openSupport(): Promise<{ opened: boolean; reason?: "self" | "signed-out" | "unavailable" }>;
fetchAsset(ref: string): Promise<{ ok: boolean; bytes?: ArrayBuffer; contentType?: string; error?: string }>;
switchGreeting(index: number): void;
copyToClipboard(text: string): void;
showToast(message: string, type?: "success" | "error" | "info"): void;
resolveAssetUrl(ref: string): string;
renderMarkdown(text: string): string;
```

`getPersonaProfile()` explicitly imports a copy of the current session's selected persona, including custom entries and excluding private notes. It returns `null` for No persona and rejects on failure. Call it when the player chooses to import, let them review the result and save their copy per run. An already imported copy changes only when the card imports again; older hosts may omit `entries` or the method itself. These persona entries are separate from the world's lorebook `api.entries`.

### Model Selection

```typescript
setModel(modelId: string): void;
getModels(): Promise<{
  models: Array<{ id: string; name: string; provider: string; contextLength: number; supportsImages?: boolean }>;
  pinnedModels: string[];
  recentlyUsed: string[];
}>;
pinModel(modelId: string): void;
unpinModel(modelId: string): void;
setPreferredProvider(provider: "official" | "private"): Promise<{
  ok: boolean;
  provider?: string;
  error?: string;
}>;
```

## Built-In Components

Available as globals — no imports needed. Import statements are silently stripped at compile time, so both styles work, but the components are injected into scope automatically:

```tsx
// These are already in scope — just use them directly:
// Chat, MessageList, MessageInput, ChatCanvas,
// ModelPickerModal, ModelTrigger, useAssetFont, Icons

// Import statements are harmless (stripped at compile time) but unnecessary:
// import { Chat } from "yumina/Chat";  ← works but not needed
```

### Chat Props

```typescript
interface ChatProps {
  renderBubble?: (props: BubbleProps) => React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}
```

### BubbleProps

```typescript
interface BubbleProps {
  contentHtml: string;
  content: string;
  rawContent: string;
  role: "user" | "assistant" | "system";
  messageIndex: number;
  isStreaming: boolean;
  stateSnapshot: Record<string, unknown> | null;
  variables: Record<string, unknown>;
  renderMarkdown: (text: string) => string;
}
```

### SandboxMessage

```typescript
interface SandboxMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  status?: "complete" | "streaming" | "failed";
  errorMessage?: string | null;
  stateChanges?: Record<string, unknown> | null;
  stateSnapshot?: Record<string, unknown> | null;
  swipes?: Array<{ content: string; stateSnapshot?: Record<string, unknown> | null }>;
  activeSwipeIndex?: number;
  model?: string | null;
  tokenCount?: number | null;
  generationTimeMs?: number | null;
  compacted?: boolean;
  attachments?: Array<{ type: string; mimeType: string; name: string; url: string }> | null;
  createdAt: string;
}
```

### SandboxEntry

```typescript
interface SandboxEntry {
  id: string;
  name: string;
  content: string;
  keywords: string[];
  position: number;
  section: "system-presets" | "examples" | "chat-history" | "post-history";
  enabled: boolean;
  role: string;
  tags?: string[];
}
```

## Global API (Non-React)

```js
window.yumina              // Same API as useYumina()
window.yumina.onChange(cb)  // Subscribe to state changes, returns unsubscribe fn
window.yumina.offChange(cb) // Unsubscribe
// Also dispatches "yumina:statechange" event on window
```

## Sandbox Environment

React is available globally (no import needed). Use `React.useState`, `React.useEffect`, etc.

### Restrictions

- No `fetch` / `XMLHttpRequest`
- No direct `localStorage` / `sessionStorage` (use `storage.*` API instead)
- No `window.location` manipulation (use `navigate()`)
- No `window.parent` access
- No `eval` / `new Function`
- No cookie access

### Compatibility Shims

Old world code without the SDK can still use:

- `fetch('/api/*')` → proxied through parent with credentials
- `localStorage` / `sessionStorage` → world-scoped, proxied to parent
- `navigator.clipboard.writeText()` → proxied
- `window.location` → synthetic object

### Styling

Tailwind CSS is fully available in the sandbox — use any utility classes (`flex`, `gap-4`, `text-white`, `bg-[#1a1a2e]`, etc.). Inline styles also work:

```tsx
// Tailwind classes (preferred)
<div className="flex flex-col gap-4 p-4 bg-[#1a1a2e] text-[#e0e0e0] font-serif">

// Inline styles (also fine)
var style = {
  background: "#1a1a2e",
  color: "#e0e0e0",
  fontFamily: '"Noto Serif SC", serif',
  padding: "16px",
};
```

### Multi-File Structure

```tsx
// index.tsx
import StatusPanel from "./status-panel";
import MapView from "./map-view";

export default function App() {
  return (
    <>
      <StatusPanel />
      <Chat />
      <MapView />
    </>
  );
}
```
