<div v-pre>

# Player-Uploaded Images

> Let the player pick a picture from their device — an avatar, a custom background, a photo of their character — and have it appear inside the world immediately. The image is stored as a regular variable, persists across sessions, and travels with the bundle when you export.

---

## What you'll build

A small avatar uploader rendered next to chat:

- Player clicks the avatar slot → file picker opens
- Picks a `.png` / `.jpg` → image appears instantly in the slot
- Image survives reloads, session switches, and bundle exports
- Works completely offline — no network call, no asset upload to the server

The pattern generalises to anything image-shaped: backgrounds, NPC portrait overrides, item icons drawn by the player, screenshots they want the AI to react to.

::: info Player upload vs. creator asset
This recipe is for images **the player provides at play time**. If you (the creator) want to ship a fixed image with your world, upload it in the editor's **Assets** tab and reference it by `@asset:xxx` in your code or styles — that goes through the CDN and isn't stored in the player's session.
:::

### How it works

The whole thing is three browser primitives plus one SDK call:

```
Player picks file
  → <input type="file" accept="image/*"> change event
  → FileReader.readAsDataURL(file) → "data:image/png;base64,..."
  → api.setVariable("player-avatar", dataUrl)
  → variable updates → component re-renders → <img src={dataUrl}> shows the picture
```

The data URL is just a string. Because Yumina variables can hold any JSON, the string lives inside the variable like any other text — no separate upload pipeline.

---

## Step by step

### Step 1: Create the variable

Editor → sidebar → **Variables** tab → **Add Variable**:

| Field | Value | Why |
|-------|-------|-----|
| Display Name | Player Avatar | For your own reference |
| ID | `player-avatar` | The Root Component reads/writes this ID |
| Type | String | A data URL is just text |
| Default Value | *empty* | Empty = no avatar yet, show a placeholder |
| Category | Custom | Organisational |
| Behavior Rules | `Do not modify this variable. The player provides the image; the AI must never change it.` | Stops the AI from emitting `[player-avatar: set ...]` directives that would corrupt the image |

> **Why a String, not JSON?** A data URL is a single string like `data:image/png;base64,iVBORw...`. JSON would work too — useful when you have multiple slots like `{ avatar: "...", background: "..." }` — but a single image slot is simpler as a String.

---

### Step 2: Root Component

Editor → **Custom UI** section → open `index.tsx` → paste:

```tsx
export default function MyWorld() {
  const api = useYumina();
  const avatar = String(api.variables["player-avatar"] || "");

  function handlePick(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(ev) {
      const dataUrl = String(ev.target.result || "");
      api.setVariable("player-avatar", dataUrl);
    };
    reader.readAsDataURL(file);

    // Reset so picking the same file twice still fires onChange
    e.target.value = "";
  }

  return (
    <div style={{ display: "flex", height: "100vh" }}>
      {/* Left: avatar slot */}
      <div style={{ width: "200px", padding: "16px", borderRight: "1px solid #333" }}>
        <label style={{ display: "block", cursor: "pointer" }}>
          <div style={{
            width: "168px",
            height: "168px",
            borderRadius: "12px",
            background: avatar ? `url(${avatar}) center/cover` : "#1f2937",
            border: "1px solid #374151",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#9ca3af",
            fontSize: "13px",
          }}>
            {avatar ? "" : "Click to upload"}
          </div>
          <input
            type="file"
            accept="image/*"
            onChange={handlePick}
            style={{ display: "none" }}
          />
        </label>

        {avatar && (
          <button
            onClick={() => api.setVariable("player-avatar", "")}
            style={{
              marginTop: "12px",
              padding: "6px 12px",
              fontSize: "12px",
              background: "transparent",
              border: "1px solid #4b5563",
              borderRadius: "6px",
              color: "#9ca3af",
              cursor: "pointer",
              width: "100%",
            }}
          >
            Remove
          </button>
        )}
      </div>

      {/* Right: regular chat */}
      <div style={{ flex: 1 }}>
        <Chat />
      </div>
    </div>
  );
}
```

**Line-by-line:**

- `api.variables["player-avatar"]` — read the saved data URL (empty string when nothing has been uploaded)
- `<input type="file" accept="image/*">` — the standard browser file picker. `accept="image/*"` filters to image types in the OS dialog
- `FileReader.readAsDataURL` — reads the picked file and produces a `data:image/...;base64,...` string asynchronously; the result lands in `ev.target.result`
- `api.setVariable("player-avatar", dataUrl)` — saves the string into the variable. Because variables are part of the session, the avatar persists across reloads and is included when the player exports the session
- `e.target.value = ""` — without this, picking the same file twice in a row doesn't fire `onChange` (browsers dedupe identical values on file inputs)
- The avatar div uses CSS `background-image` rather than an `<img>` tag so we get `cover` cropping for free

---

### Step 3: (Optional) Compress before saving

A 4K phone photo can easily exceed 5 MB. Stored as base64 it's ~33% larger again. Loading and serialising a 7 MB string on every render is slow, and the export bundle bloats accordingly. For anything bigger than a thumbnail, downscale on the client first:

```tsx
function compressToDataUrl(file, maxDim = 512, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = () => { img.src = String(reader.result); };
    reader.onerror = reject;
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function handlePick(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const dataUrl = await compressToDataUrl(file, 512, 0.85);
  api.setVariable("player-avatar", dataUrl);
  e.target.value = "";
}
```

`canvas.toDataURL("image/jpeg", 0.85)` typically lands a 512×512 avatar in 40–80 KB. That's negligible for storage and instant to render.

> **Sanity rule of thumb**: keep any single image variable under ~200 KB once base64-encoded. A handful of avatars at that size is fine; a gallery of full-resolution photos is not — at that point use the editor's **Assets** tab and `@asset:xxx` references instead.

---

### Step 4: Save and test

1. Click **Save** at the top of the editor
2. Open or start a session
3. Click the avatar slot, pick a picture — it should appear immediately
4. Refresh the page — the avatar is still there
5. Click **Remove** — the slot returns to "Click to upload"

**If something goes wrong:**

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Picker doesn't open | The `<input>` isn't a child of the `<label>`, or `display: none` is on the label instead | Make sure `<input type="file">` is inside the `<label>` and the label has `cursor: pointer` |
| Image picks but doesn't show | `setVariable` not called, or the variable ID is misspelled | Confirm the ID in the variable definition matches `player-avatar` exactly |
| Same file twice doesn't trigger | Missing `e.target.value = ""` after reading | Always reset the input value at the end of the handler |
| Page feels sluggish after upload | The image is huge | Add the `compressToDataUrl` step from above |
| AI starts emitting nonsense `[player-avatar: ...]` directives | The behavior rule on the variable wasn't added | Re-open the variable and paste the rule from Step 1 |

---

## Quick reference

| What you want | How to do it |
|---------------|-------------|
| Player picks an image | `<input type="file" accept="image/*">` inside a `<label>` |
| File → string | `new FileReader(); reader.readAsDataURL(file)` |
| Persist the picked image | `api.setVariable("id", dataUrl)` — strings of any size go in like any other variable |
| Render it | `<img src={dataUrl}>` or `background: url(${dataUrl})` |
| Reset same-file picking | `e.target.value = ""` after handling |
| Keep storage small | Downscale via `canvas.toDataURL("image/jpeg", 0.85)` before saving |
| Player removes it | `api.setVariable("id", "")` |

---

## When **not** to use this pattern

| Situation | Use instead |
|-----------|-------------|
| The image is shipped with the world (always the same) | Editor's **Assets** tab + `@asset:xxx` reference |
| You need many large images and don't want them in every player's session bundle | **Assets** tab — uploaded once, served from CDN |
| The image needs to be visible to other players in a shared room | **Assets** tab — variables are per-session, assets are per-world |
| The AI needs to *see* the image (vision models) | Coming soon: chat-message attachments. For now, store a description in another variable and let the AI react to that |

The mental split is simple: **pre-baked content the creator chose** lives in Assets; **content the player produces at runtime** lives in variables.

---

::: tip This is Recipe #15
The pattern — *browser file API → string variable* — also works for short audio clips (`readAsDataURL` + `<audio src={dataUrl}>`), small text files (`readAsText`), and JSON imports. Whenever you need the player to bring data *into* the world, this is the shape.
:::

</div>
