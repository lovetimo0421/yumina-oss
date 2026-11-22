---
title: "3D, panoramas & binary assets"
description: "What the sandbox can load, how three.js comes built in, how fetchAsset gets you the bytes, and a cheap 3D world made by teleporting between panoramas."
---

<div v-pre>

# 3D, Panoramas & Binary Assets

> Your card's interface code runs inside a locked-down iframe. Images and audio load normally; a `.glb` model doesn't, and nothing tells you why. Below: what loads, what fails silently, and a cheap way to build 3D worlds by teleporting between places instead of walking through them.

---

## What the sandbox can load

Custom UI runs in a sandboxed iframe with its own Content Security Policy. The policy stops a card from attacking the site or sending a player's data anywhere. It also means some perfectly normal web code does nothing at all in a published card.

| You write | What happens |
|---|---|
| `<img src="/cdn/…">`, CSS `background-image`, `<video>`, `<audio>`, web fonts | **Works.** Images, media and fonts have a privileged loading path |
| `THREE.TextureLoader().load(url)` | **Works** — it loads through an `<img>` under the hood |
| `fetch(...)`, `XMLHttpRequest`, `WebSocket`, `EventSource` | **Blocked outright.** The policy is `connect-src 'none'` |
| `GLTFLoader().load(url)`, `.bin`, `.ply`, a big `.json` table | **Blocked** — these load through `fetch`, not `<img>` |
| `new Worker(URL.createObjectURL(blob))` | **Blocked.** Assume no workers |
| `SharedArrayBuffer`, multi-threaded WASM | **Unavailable** — the page is not cross-origin isolated |
| `api.fetchAsset("<asset-id>")` | **The way in for bytes.** The platform fetches the asset and hands your code an `ArrayBuffer` |

::: warning The trap
`loader.load(url)` for a model does not throw a clear error. The load just never completes, so the card shows an empty scene or your own "still loading" state forever. If a 3D card works in a local experiment and shows nothing once published, this is almost always why.
:::

### Two ways to reference your own assets

Upload art in **My Library → Assets** (or **Panels → Assets** in the editor), then use the asset's id:

```tsx
var api = useYumina()

// Images / audio / fonts — resolve to a URL and let the browser load it.
var url = api.resolveAssetUrl("@asset:2ec02221-2664-4f31-9d31-03b2db7570ab")
// → "/cdn/2ec02221-…", a normal URL you can put in <img src>, CSS, or a THREE texture

// Anything binary — ask the platform for the bytes.
var res = await api.fetchAsset("2ec02221-2664-4f31-9d31-03b2db7570ab")
if (res.ok) {
  var bytes = res.bytes // ArrayBuffer
}
```

`fetchAsset` takes an **asset id, never a URL**. That is what makes it safe to expose. It caps out at **32 MB** per asset, and returns `{ ok: false, error }` for `"bad-ref"`, `"http-404"`, `"too-large"` or a network failure. Check `ok` before touching `bytes`.

### Sizes worth knowing

- **32 MB.** Ceiling for one `fetchAsset` call.
- **10 MB.** Ceiling on a world save. Your card's *source files* live inside the world, so a base64-inlined model or a wall of embedded audio will eventually make your world unsaveable. Art belongs in the asset library; code belongs in the card.
- `/cdn` intentionally serves assets with `max-age=0`. The browser will re-validate an image you loaded five minutes ago unless **you are still holding a reference to it**. For anything you want to appear instantly (a teleport target, a character portrait), keep the loaded `Image` or `Texture` in a `Map` for the life of the session.

---

## The pattern: teleporting between places

The cheapest convincing 3D world on Yumina is one where the camera **never walks**. The player stands in a place, looks around, and picks the next place from a list. No collision, no navigation mesh, no streaming, and every new location costs you one image instead of one level.

Each place is a 360° equirectangular panorama mapped onto the inside of a sphere with the camera at the centre. Teleporting swaps the texture on that same sphere: one renderer, one sphere, one draw call, for a world of any size.

### Step 1 — the current place is a variable, not React state

Game variables are sent to the model every turn, so if the current place lives in a variable, **the AI always knows where the player is standing**, and it can move them itself.

Add a **Text** variable on the canvas with the starting value `atrium`, and set its **ID** to `location` (under **Advanced** in its settings; new variables get a random ID, and the code below reads `api.variables.location`). Then:

```tsx
export default function World() {
  var api = useYumina()
  var here = String(api.variables.location || "atrium")

  function goTo(id) {
    api.setVariable("location", id)
    api.sendMessage("I step through into the " + PLACES[id].name + ".")
  }

  return (
    <div className="relative h-full w-full">
      <Stage place={here} />
      <div className="absolute bottom-4 left-4 flex gap-2">
        {PLACES[here].exits.map(function (id) {
          return (
            <button key={id} onClick={() => goTo(id)}
              className="rounded bg-black/60 px-3 py-1.5 text-sm text-white">
              {PLACES[id].name}
            </button>
          )
        })}
      </div>
      <Chat />
    </div>
  )
}
```

Use `api.sendMessage` when you want the AI to react to the move immediately, or `api.setComposerDraft` when you would rather the player write their own entrance line first.

### Step 2 — one lorebook entry per place

Give every place an entry that's only sent while `location` is that place: on the canvas, drag `location` onto the entry and set the condition (**Conditional lore**). Now only the room the player is standing in spends context, and the AI describes the greenhouse's cracked glass because the greenhouse entry is in front of it, instead of guessing.

### Step 3 — let the AI teleport the player

Because `location` is an ordinary variable, the model can write it:

```
[location: set greenhouse]
```

Your UI is already watching `api.variables.location`, so the scene changes when the story says it changes. A door the player is dragged through by the narrative and a door they clicked are the same code path.

If you give `location` **Allowed values** (one per place), Precise tracking can move the player instead: after each reply it picks the place the story has reached, and directives for `location` are ignored.

### Step 4 — the sphere

```js
// stage.js — one scene, one sphere, swap the texture to teleport.
import * as THREE from "./three-lib"

var renderer, scene, camera, sphere
var textures = new Map()   // keep panoramas alive; /cdn will not cache them for us

export function mount(canvas) {
  renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: false })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
  scene = new THREE.Scene()
  camera = new THREE.PerspectiveCamera(70, 1, 0.1, 100)
  var geo = new THREE.SphereGeometry(10, 48, 32)
  geo.scale(-1, 1, 1)                       // flip the normals so we see the inside
  sphere = new THREE.Mesh(geo, new THREE.MeshBasicMaterial())
  scene.add(sphere)
}

export function show(url) {
  var tex = textures.get(url)
  if (!tex) {
    tex = new THREE.TextureLoader().load(url)   // an <img> under the hood: allowed
    tex.colorSpace = THREE.SRGBColorSpace
    textures.set(url, tex)
  }
  sphere.material.map = tex
  sphere.material.needsUpdate = true
}
```

Preload the panoramas for every exit out of the current place while the player is reading, and a teleport is instantaneous.

### Where panoramas come from

Any equirectangular 2:1 image works: a render out of Blender, a photo from a 360 camera, or an AI-generated panorama. 2048×1024 JPEG is plenty for a backdrop you look around in; that is ~300 KB, so a twelve-room world is smaller than one character model.

---

## A world to walk into: `loadWorld()`

For a place the player walks around in first person (a room, a shop, a library), card code has `loadWorld(el, options)`, in scope like `useYumina`. You describe the place in a few calls (rooms with doors and windows, furniture, lamps, a sun, the view outside, rain or dust in the air) and it handles the rest: surfaces textured in code, lights you can see, shadows, light shafts through windows, fog, a film-like grade, walking with collision, a thumbstick on phones, "press E / tap" on things, captions and a pause menu. Nothing to download or draw.

```tsx
export default function Shop() {
  var api = useYumina()
  var mount = React.useRef(null)

  React.useEffect(function () {
    var world = null, stopped = false
    loadWorld(mount.current, { api: api, look: "night", player: { at: [1.5, 1.5], facing: "north" } }).then(function (w) {
      if (stopped) { w.dispose(); return }
      world = w
      w.room({ size: [7, 2.9, 5.6], walls: "plaster", floor: "tile",
        openings: [{ wall: "south", kind: "window", width: 3, bottom: 0.85 }] })
      w.outside({ kind: "night-city" })
      w.air({ kind: "rain", at: [0, 0, 5], size: [12, 5, 3] })
      w.add("counter", { at: [0, -1.2], size: [5, 1.05, 0.6] })
      w.add("stool", { at: [-1, -0.5] })
      w.lamp({ kind: "lantern", at: [0, 2.1, -1], power: "dim" })
      w.add("sign", { at: [3.45, 2, 0], facing: "west", text: "営業中", neon: true })
      w.start()
    })
    return function () { stopped = true; if (world) world.dispose() }
  }, [])

  return <div ref={mount} style={{ position: "fixed", inset: 0 }} />
}
```

Pictures (a face on a TV, a painting) come from your assets: `w.screen({ image: "@asset:<id>" })`, `w.picture({ ... })`. A `.glb` model goes in with `w.model({ asset: "<id>" })`. The Studio assistant knows all of this: say "做一个下雨夜的拉面店，能走进去" and it builds the world with `loadWorld()`.

## three.js is built in

You don't have to bundle three.js yourself any more. Card code has `loadThree()` in scope, the same way it has `useYumina`. It returns a Promise of `{ THREE, OrbitControls, PointerLockControls, GLTFLoader, parseGLB }` (three.js r180). The library downloads the first time a card calls it, so cards without 3D never pay for it.

```tsx
export default function World() {
  var api = useYumina()
  var mount = React.useRef(null)

  React.useEffect(function () {
    var stop = function () {}
    loadThree().then(async function (kit) {
      var THREE = kit.THREE
      var renderer = new THREE.WebGLRenderer({ antialias: true })
      mount.current.appendChild(renderer.domElement)
      // scene, camera, lights, your render loop

      // a .glb from your asset library, pictures included
      var res = await api.fetchAsset("<asset-id>")
      if (res.ok) scene.add((await kit.parseGLB(res.bytes)).scene)

      stop = function () { renderer.setAnimationLoop(null); renderer.dispose() } // undo everything when the card closes
    })
    return function () { stop() }
  }, [])

  return <div ref={mount} style={{ width: "100%", height: "100dvh" }} />
}
```

`parseGLB` takes the bytes from `api.fetchAsset` and returns the loaded model. Use it instead of `GLTFLoader().parse`: it also loads the pictures packed inside the .glb, which the plain loader cannot do in the sandbox (that was the "model renders pure white" problem).

The Studio assistant and an outside AI connected to your card know this too. Ask for "a room I can walk around in, where I walk up to a character to talk" and they build on `loadThree()`.

The rest of this section is for bringing in a library other than three.js.

## Bringing three.js (or any library) into a card

There is no npm inside a card and no CDN script tag. Bundle the library yourself, once, and add the result as a card file in **Panels → Interface code**:

```bash
# three-entry.js — re-export only what you actually use, so tree-shaking can work
npx esbuild three-entry.js --bundle --format=esm --minify --outfile=three-lib.js
```

A focused entry point (a couple of dozen classes) comes out around 500 KB. Add it as a file named `three-lib.js` and import it with a binding:

```tsx
import * as THREE from "./three-lib"
```

**Import it with a binding, always.** A side-effect-only `import "./three-lib"` registers no dependency, so the bundler quietly leaves the file out and your card fails with `THREE is not defined`.

::: warning Tree-shaken builds and missing symbols
A trimmed build contains only the classes your entry file names. Reach for one it left out, say `THREE.RingGeometry`, and you get `THREE.RingGeometry is not a constructor` at scene-build time. Card code usually catches that in the same `try/catch` that handles "no WebGL here" and shows the player *"your device doesn't support 3D"*, which sends you hunting for a hardware problem that does not exist. Probe WebGL separately with a throwaway canvas, and when the probe passes, show the real `error.message` instead of the fallback text.
:::

### File names and import syntax

Every file in a card is compiled the same way no matter what it is called, and imports resolve without an extension: `import * as THREE from "./three-lib"` finds `three-lib.tsx`, `three-lib.ts`, `three-lib.jsx` or `three-lib.js`. Name the vendor bundle `.js` because that is what it is. Nothing in the pipeline cares either way.

Three syntax rules are not optional, because imports and exports are stripped by pattern before the bundle runs:

- **Keep every `import` on one line.** A multi-line `import { a, b } from "./x"` is left in the output and the card dies with `Cannot use import statement outside a module`.
- **Export with `export function` / `export const` / `export class` / `export default` / `export { a as b }`.** `export * from "./x"` is not recognised, survives into the bundle, and throws `Unexpected token 'export'`.
- **Don't import the platform globals.** `React`, `useYumina`, `Icons`, `Chat`, `MessageList`, `MessageInput` are already in scope.

---

## Loading a model

```tsx
import { GLTFLoader } from "./three-lib"   // include it in the bundle's entry point

var res = await api.fetchAsset(ASSETS.dealerGlb)
if (!res.ok) { /* show something honest, don't spin forever */ return }

var loader = new GLTFLoader()
loader.parse(res.bytes, "", function (gltf) {
  scene.add(gltf.scene)
}, function (err) {
  console.error(err)
})
```

`parse`, not `load`: you already have the bytes, and `load` would try to fetch.

If the model renders pure white, its textures did not come along: GLB-embedded texture decoding can fail quietly in the sandbox. Upload the texture as a separate image asset and assign it yourself:

```tsx
var tex = new THREE.TextureLoader().load(api.resolveAssetUrl("@asset:" + ASSETS.dealerTex))
tex.colorSpace = THREE.SRGBColorSpace
mesh.material.map = tex
```

---

## Making it survive a phone

Many players are on phones. A 3D card that overheats a phone just gets closed, and you never hear about it.

- **Cap the pixel ratio.** `renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))`, or 1 on a low-end device. An uncapped 3× ratio on a tall phone screen is millions of extra pixels a frame for no visible gain.
- **No real-time shadows on mobile.** In a shipped card they measured as ~85% of the frame's GPU time, for a soft edge nobody looks at.
- **Watch real frame intervals and back off.** Sample every couple of seconds; if frames keep coming in slow, drop the pixel ratio a notch, then drop effects. Give players an explicit quality switch too.
- **Never jitter the camera with per-frame randomness.** `Math.random()` shake reverses direction dozens of times a second, which causes motion sickness. Use a sum of two slow sines, and hold the canvas height steady when the soft keyboard opens instead of recomputing the field of view.
- **Cache and dispose deliberately.** Keep textures you will return to; `dispose()` the ones you won't.

---

## When something doesn't work

| Symptom | Cause |
|---|---|
| Model never appears, no error | `loader.load(url)` — use `fetchAsset` + `parse` |
| Model appears pure white | Embedded textures didn't decode — load the model with `parseGLB` from `loadThree()` |
| `THREE is not defined` | Side-effect-only import; give it a binding |
| `THREE.X is not a constructor` | Symbol missing from your tree-shaken build |
| Card white-screens: `Unexpected token 'export'` | `export * from "./x"` in a card file |
| Card white-screens: `Cannot use import statement outside a module` | A multi-line `import` |
| "This device doesn't support 3D" on a good device | A real error swallowed by the WebGL fallback branch |
| Teleports stutter the second time | Textures were garbage-collected — hold references |
| World won't save | The card's own files exceed the 10 MB world body — move data into assets |

---

Related: [Custom UI Guide](/creator/advanced/custom-ui-deep) · [API Reference](/creator/advanced/08-api-reference) · [Scene Jumping](/creator/advanced/recipes/scene-jumping)

</div>
