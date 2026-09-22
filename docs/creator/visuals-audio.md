# Visuals & Audio

Every world comes with a clean chat interface out of the box. Here's how to go further.

In the editor, custom UI lives in **Custom UI**, audio tracks in **Audio**, and uploaded files in **Assets**.

## Character portraits

Give a character a face: in the simple editor, click the camera square next to the character's name; in Studio, open the character's entry in **Lorebook** and use **Portrait**. Pick an image from **Assets** or upload one on the spot. In chat, that image and the character's name appear above every line they speak. When several characters have portraits, the AI is asked to open every reply with a hidden `[speaker: Name]` tag, so the right face is on screen before the first word arrives. A reply tagged as narration shows no face; if a model skips the tag, the chat falls back to a `Name:` marker or a name in the first sentence.

## Pictures in the opening

An opening can carry a picture. Under the opening's text box, press **Insert image** and either upload a file or pick one from **Assets**; you can also drop a file onto the text box or paste one. The picture goes in at the cursor as `[image:@asset:…|alt=…]` and shows in chat where you put it. Options after the `|`: `alt=` (what the picture is), `caption=` (a line under it), `size=sm|md|lg|full`, `placement=left|center|right`. Plain markdown works too — `![](@asset:{id})` — and both accept an `https://` link instead of an asset.

## Custom UI

The default chat is enough for most worlds. Custom UI is how you go beyond it:

The horror world from earlier uses a CRT-style green-on-black interface with a status bar showing health, energy, and armed status. Studio AI generated it from a description like "post-apocalyptic horror UI, CRT monitor aesthetic, dark green glowing text, scanline effects."

<!-- screenshot: the horror world's custom UI showing the CRT-style interface -->

You don't need to know code. Describe the look and feel you want and let the Studio's AI assistant build it. Custom UI is a purely visual layer — it reads game state but never changes it.

For the full Custom UI guide → [Advanced: Custom UI Deep Dive](/creator/advanced/custom-ui-deep)

## Audio

| Type | Purpose | Example |
|------|---------|---------|
| **BGM** | Background music, loops continuously | Tavern theme, battle music, exploration track |
| **SFX** | One-shot sound effects | Sword clash, door creak, notification chime |
| **Ambient** | Environmental loops, layered with BGM | Rain, forest sounds, crowd murmur |

**BGM playlists** auto-rotate through tracks, and **conditional BGM** switches based on game state (e.g., battle music when the variable `location` is "arena").

Select a track in **Audio** to see its **Track ID**, then click **Copy ID**. Use that ID in custom UI calls such as `api.playAudio("track-id")`; renaming the track does not change its ID.

Turn off **Allow AI control** to prevent the narrator from playing, stopping, or changing that track. Your custom UI, scripts, behaviors, and playlists can still control it. Existing tracks keep AI control enabled unless you turn it off.

A horror world might play tense BGM during exploration, fire a sharp SFX when something lunges at the player, and run steady rain ambience in the background. Three layers, all at once.

For audio patterns and conditional BGM → [Advanced: Audio Design](/creator/advanced/audio-deep)

## Assets

You can upload images, audio files, fonts, and other media through the **Assets** section in the editor. Files are hosted on Yumina's CDN and can be referenced anywhere in your custom UI, entries, or audio tracks. No need to host files yourself.

## AI image generation

You can generate images inside Yumina instead of sourcing them elsewhere. Three entry points: the **AI Image Generation** card on the **Create** page, the **AI Generation** button at the top right of **Library → Assets**, and the **AI Generation** section of the editor.

Describe the picture, pick a model, an aspect ratio and how many images, then press **Generate**. The default model costs about 35 mushies per image, charged on actual usage once the image is delivered; nothing is charged if no image arrives. Delivery usually takes about 30 seconds, and a notification with a thumbnail tells you when it is done.

Generated images land in your asset library (you can choose a folder) and are referenced like any upload with `@asset:{id}`. You can also pick an existing image as a reference and describe how to change it.

At most 2 images generate at the same time, and you can submit up to 30 requests per hour. Prompts involving minors or face swaps of real people are rejected outright.
