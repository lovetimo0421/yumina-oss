<div v-pre>

# Player-Uploaded Images

Save player pictures with `api.media`, and small related JSON with `api.sessionStorage`. Both belong to the current play session and can be read on another device signed into the same account. Creator-supplied images still use the editor's **Assets** tab and `@asset:` references.

## Choose where data belongs

| Data | API |
|------|-----|
| Player image bytes and gallery metadata | `api.media` |
| A selected image ID, bounded notes, or other save-specific JSON | `api.sessionStorage` |
| Browser-only preferences and expendable cache | `api.storage` |
| Game state that the rules or AI should use | Declared game variables |

Do not put image base64 into JSON, game variables, or browser storage. Cloud saves require a connection. Session images are separate from a world's export bundle; do not promise that exporting a world downloads players' private files.

## Upload and display

In a component, obtain `const api = useYumina()`. Load the list on opening, after changes, and before temporary display URLs expire (five minutes):

```tsx
const page = await api.media.list(0);
// page.items contains { id, entryId, metadata, version, url, thumbnailUrl, deleted, ... }.
// Load subsequent pages when page.hasMore is true.

if (!api.readOnly && page.uploadsEnabled) {
  const result = await api.media.pick({
    metadata: { title: "Character portrait" }
  });
  if (result) {
    // result is { mediaId, entryId }; null means the player canceled.
    // Reload the list to obtain its temporary display URL.
  }
}
```

Render a non-deleted item's `url` or `thumbnailUrl`. An item may have a null URL if its file was permanently deleted. Catch rejected requests, keep an error state, and show success only after the promise resolves. Honor `api.readOnly` and `uploadsEnabled` when enabling upload controls.

For an existing file input, call `api.media.upload(file, { entryId, uploadId, metadata })`. Keep the selected `File` after a failed request and reuse the same `uploadId` when retrying that file/request. Never fall back to local storage while claiming it was saved to the cloud.

## Save a selected image

Keep a stable entry ID in JSON, then resolve it against `media.list()` for display. Do not persist `url` or `thumbnailUrl`:

```tsx
const previous = await api.sessionStorage.get("selected-portrait");
const saved = await api.sessionStorage.set(
  "selected-portrait",
  { entryId: selectedItem.entryId, mediaId: selectedItem.id },
  { expectedVersion: previous.version }
);
// Keep saved.version for later changes.
```

All JSON methods return `{ value, version, exists }`. Check `exists` when loading. Every `set` and `remove` requires `{ expectedVersion }`; if another device changed the record, `SESSION_STORAGE_CONFLICT` rejects the write. Keep the draft, reload, and reconcile before resubmitting. Do not blindly retry a stale selection.

To clear only the selection, use `api.sessionStorage.remove("selected-portrait", { expectedVersion })` with its latest version. To remove an image from the current session, use `api.media.remove(item.entryId, item.version)`. These are separate actions; clearing the selection does not delete the image. Permanent file deletion is managed in **Library → Assets → Save images** and can affect other saves, checkpoints, and shares.

## Limits and saved copies

- Images: static JPEG/PNG/WebP, up to 16 MiB input and 40 million decoded pixels. The server creates a WebP display image up to 2048 pixels plus a thumbnail. This is not an original-file backup. Images use the account's existing asset capacity.
- JSON: 32 KiB per serialized UTF-8 value; 256 KiB current values, 128 keys including tombstones, and 16 MiB value history per session; 1,000 mutations/hour across the owner's sessions.
- A checkpoint restore that changes JSON shares these limits. A quota failure returns HTTP 413 and an hourly rate failure returns 429; the entire restore, including media and story state, rolls back. History is retained. Restoring unchanged values does not duplicate history and can proceed even at these JSON limits.
- Checkpoints, same-account branches, and shared snapshots capture JSON and media references together. A checkpoint restore restores both. A share retains only its creation-time snapshot and does not receive later private additions.
- Shared replays are read-only and follow existing visibility, world publication status, hidden/moderation status, and content-level rules. The sharer and card creator are privileged snapshot readers, including for hidden, unpublished, or sensitive snapshots; other viewers must pass the applicable checks. Unlisted shares are accessible by link. This does not grant the creator access to the owner's private live-session data, which remains owner-only.

## Existing browser galleries

The compatibility adapter recognizes validated current Oncin v2/v3/v4 and `gallery_data` formats in any world. Migration runs from the browser that holds the original images and retains its old data. It does not guess from corrupt or ambiguous journals/backups, recover data from another device's browser, fetch remote URLs, or automatically convert arbitrary localStorage keys.

New cards should use the explicit SDK APIs above. For other legacy formats, keep the local originals until both upload and cloud save are confirmed.

## Verify the integration

1. Upload a small supported image, wait for confirmation, and reload the session.
2. Open the same session from another device on the same account and confirm the image and selection.
3. Save a checkpoint, change the selection, then restore it; confirm the image references and JSON return together.
4. Create a same-account branch and a shared snapshot; verify their captured state and read-only replay behavior.
5. Exercise canceled selection, failed upload, quota errors, and a conflicting JSON change from another device. Retain the draft and show the failure.

See the [API reference](../08-api-reference.md) for signatures. AI image input is a separate chat-attachment feature; displaying an image does not send its pixels to the model.

</div>
