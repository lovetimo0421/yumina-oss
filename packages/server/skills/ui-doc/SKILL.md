---
name: ui-doc
description: Edit the card's no-code visual interface document (uiDoc) with read_ui_doc / edit_ui_doc — part shapes, layout rules, worked examples (opening cards, character-creation form, unlock collection, restyling). Load before your first edit_ui_doc.
---

# Skill: Interface document (uiDoc)

The uiDoc is the card's interface as a document: pages of positioned **parts**. The visual editor and edit_ui_doc edit the same document, and it compiles to the card's frontend on every change. Anything you build here stays editable by the creator without code, so for interface requests **use edit_ui_doc, not TSX**. Use a `custom` part only for what no part can express (a radar chart, a mini-game); never write the files marked "compiled from the interface document".

## Workflow
1. `read_ui_doc` (skip if it is already in this conversation) — part ids, variables, openings.
2. Create any variables the parts need with write_variable **earlier in the same reply** (then refer to them by id or exact name).
3. One `edit_ui_doc` call with all ops. Rejected → the error names the part and field; fix just that and resend the whole call (nothing was applied).
4. Say what changed in one sentence. Don't paste the JSON back.

## Canvas
- Phone canvas: 375 wide, page height usually 812. `x,y,w,h` are design px on it.
- Wide screens: optional `desktop: {x,y,w,h}` on the 1024×640 canvas; absent = same numbers as the phone; `null` = hidden on wide screens.
- Pages: `leaveWhen: {when: Condition, pageId}` makes a page give way by itself — an opening/form page with `leaveWhen {when:{variableId:"$chat.started",operator:"eq",value:true}, pageId:"chat"}` is shown only until the player's first message, then the card opens on the chat page (set it with update_page). Never applied in the editor.
- `z` stacks (higher on top). `visibleWhen: {variableId, operator: eq|neq|gt|gte|lt|lte|contains, value}` shows a part only while it holds. `"$chat.started"` is a built-in subject: `{variableId:"$chat.started", operator:"eq", value:false}` = before the player's first message.
- Cards with `surface: chat` or a base layer: the chat/old frontend stays underneath; parts float over it. Keep overlays out of the bottom ~90px (composer) unless they hide once play starts.
- Text templates: `{template: "HP {{hp}}"}` — `{{variableId}}`; in lists `{{item}}`, `{{item.field}}`, `{{index}}`; in popups `{{value}}`; in choice actions `{{choice}}`.

## Parts (all have id, x, y, w, h; optional name, z, opacity, rotation, visibleWhen, animation {kind: fade|rise|pulse, durationMs}, css)
- `box` {style}
- `text` {text:{template}, style: TextStyle}
- `image` {src, fit: cover|contain|fill, radius}
- `meter` {value, min, max: {kind:"literal",value} | {kind:"variable",variableId}; style {fills, track, radius}}
- `button` {label:{template}, actions:[Action…] (run in order), requires:[variableIds that must be filled], style: ButtonStyle}
- `choice` {options:[{id?, title, subtitle?, detail?, image?, tags?, value?, actions?}], layout: grid|carousel|list, columns? (cards per row, held on phone AND desktop; omit it for 2 on phone and auto-fit on desktop), gap?, multi?, maxPick?, variableId? (gets the picked value), tagFilter?, confirm?: {label, actions?, style?}, style?: {card, selected, title, subtitle, imageRatio}}. Without confirm a tap runs that option's actions at once.
- `field` {kind: text|textarea|chips|number|slider, variableId, label?, placeholder?, options? (chips), allowCustom?, min/max/step?, style?: {label, input, chip, chipSelected}} — writes the variable as the player types.
- `popup` {variableId, body:{template}, title?, image?, buttonLabel?, clearOnClose? (default true), style?: {scrim, card, title, body, button}} — shows over everything while the variable is non-empty; closing clears it.
- `list` {source: {kind:"variable",variableId} | {kind:"static",items:[string | {field:value}]}, item:{template}, direction: column|row, columns?, gap?, maxItems?, emptyText?, itemStyle?, textStyle?, card?: {title, subtitle, badge, imageField, imageRatio, lockedUnless:{variableId, field}, lockedText}, rowActions?}
- `chat` / `messages` / `composer` {style} — the platform conversation (whole, or transcript and input separately).
- `chat` / `messages` also take the **message layer** (how each message is drawn):
  - `messageStyle` {assistant, user, greeting: {bubble: bool, box: BoxStyle, text: TextStyle}, showNames (default true), maxWidth, gap}
  - `rules` [{id, name, match, show, options?, aiHint?, teachAi?, example?, enabled?}] — **特殊写法**: find a convention in the reply and draw it differently.
    match: `{kind:"wrap",open,close}` | `{kind:"line-prefix",prefix}` | `{kind:"contains",text}` | `{kind:"regex",pattern,flags?}` (speaker: groups = name, then line).
    show: `reveal` (tap-to-reveal cover; options cover ink|blur|sticker, coverText, revealChance 0–1, missText) · `banner` (full-width line; a wrap banner must be the whole line) · `card` (whole message as a card; options title, box, text) · `choices` (lines become buttons that send themselves; newest AI message only) · `speaker` (名字：台词 lines get a name label; options colors {name: color}, avatars {name: "@asset:…"}) · `hide`. options.applyToUser also runs it on the player's lines. Earlier rules win overlaps.
    The AI is taught automatically: every rule with `teachAi` ≠ false becomes a line in the lorebook entry 「界面约定」 (post-history, always sent), synced on every edit — write `aiHint` for a better sentence than the default, `example` for the sample it is shown. Don't also write your own entry for the same rule.
  Example — inner thoughts + choices: `{"op":"update_part","id":"messages-1","patch":{"rules":[{"id":"thought","name":"心里话","match":{"kind":"wrap","open":"♡","close":"♡"},"show":"reveal","options":{"cover":"ink"},"aiHint":"角色有没说出口的心里话时，用 ♡…♡ 包起来。"},{"id":"opts","name":"选项","match":{"kind":"line-prefix","prefix":"※"},"show":"choices"}]}}`
- `custom` {code} — a component BODY ending in `return …;` (no imports; hooks as `React.useState`; `api`, `vars`, `go(pageId)` in scope).

Actions: `{kind:"set-variable", variableId, op: set|add|subtract|toggle, value}` · `{kind:"send-message", text:{template}}` · `{kind:"go-page", pageId}` · `{kind:"switch-greeting", index}` (index from read_ui_doc OPENINGS) · `{kind:"play-audio", trackId}` · `{kind:"stop-audio"}` · `{kind:"toast", text}` · `regenerate` · `copy-message` · `rewind`.

Images: `{kind:"asset", ref:"@asset:<id>"}` (list_assets for ids; `""` = not bound yet) or `{kind:"variable", variableId, fallback?}`.

**Looks (fastest restyle):** `{op:"apply_look", id, look}` gives a choice / field / popup / card list / button a finished style in one op — ids are listed under LOOKS in read_ui_doc (e.g. `choice-glass` 玻璃卡片, `choice-bookmark` 纸本书签, `choice-neon` 霓虹框, `choice-cover` 大图封面, `field-underline`, `popup-letter` 信笺, `popup-reward` 获得, `list-ledger` 账簿, `button-outline` 描边; `<part>-default` = back to the theme). Only style fields (and a marked block in the part's css) change; tweak further with update_part afterwards. Prefer a look over hand-writing fills when the creator asks for "好看点/换个风格".

Style: BoxStyle `{fills:[Fill…] (index 0 on top), radius (number or [tl,tr,br,bl]), borderColor, borderWidth, borderStyle, shadows:[{x,y,blur,spread?,color,inset?}], backdropBlur, padding}`; Fill = `{kind:"color",color}` | `{kind:"gradient",angle,stops:[{color,at:0-100}]}` | `{kind:"image",src,fit}`. ButtonStyle = BoxStyle + `textColor, size, weight, family, letterSpacing`. TextStyle `{size, color, weight, align, lineHeight, italic, family, letterSpacing, textShadow, stroke, nowrap}`. Card-wide: `set_theme` (preset + tokens such as `--yc-bg`, `--yc-font`); frosted glass = translucent color fill + backdropBlur.

## Worked examples

**"做一个开局选择：三张卡片，每张对应一个开局"** — a string variable `opening` (scope "setup", aiAccess "none", default "") first; then:
```json
{"op":"add_part","part":{"type":"choice","name":"开局卡片","x":16,"y":120,"w":343,"h":560,"layout":"grid","columns":1,"gap":12,"variableId":"opening",
 "visibleWhen":{"variableId":"opening","operator":"eq","value":""},
 "options":[{"title":"雨夜初遇","subtitle":"在便利店门口","actions":[{"kind":"switch-greeting","index":0}]},
            {"title":"重逢","actions":[{"kind":"switch-greeting","index":1}]},
            {"title":"契约之后","actions":[{"kind":"switch-greeting","index":2}]}],
 "style":{"card":{"fills":[{"kind":"color","color":"rgba(20,16,30,0.85)"}],"radius":16}}}}
```
The variable being set hides the picker; setup scope keeps it through the opening switch.

**"把开局卡片改成整屏大图、边框换粉色"** — update, don't rebuild:
```json
{"op":"update_part","id":"choice-1","patch":{"x":0,"y":0,"w":375,"h":812,"layout":"carousel",
 "style":{"imageRatio":1.4,"card":{"borderColor":"#ff8fc7","borderWidth":2,"radius":20}}}}
```
(options need `image` to show a picture — bind assets or say which ones are missing.)

**"加一个填名字的开局表单"** — variables `player_name` (string) and `player_role` (string) first; then a backdrop box, two fields and a button, all with `visibleWhen {"$chat.started" eq false}`:
```json
{"op":"add_part","part":{"type":"field","kind":"text","variableId":"player_name","label":{"template":"你的名字"},"placeholder":"输入名字","x":32,"y":260,"w":311,"h":72,"visibleWhen":{"variableId":"$chat.started","operator":"eq","value":false}}},
{"op":"add_part","part":{"type":"field","kind":"chips","variableId":"player_role","options":["剑士","法师","盗贼"],"allowCustom":true,"x":32,"y":350,"w":311,"h":90,"visibleWhen":{"variableId":"$chat.started","operator":"eq","value":false}}},
{"op":"add_part","part":{"type":"button","label":{"template":"开始"},"requires":["player_name","player_role"],
 "actions":[{"kind":"send-message","text":{"template":"我叫{{player_name}}，是一名{{player_role}}。"}}],
 "x":32,"y":470,"w":311,"h":52,"visibleWhen":{"variableId":"$chat.started","operator":"eq","value":false}}}
```
The first message starts the chat, which hides the form. The same flow as two pages: put the form on its own entry page with `leaveWhen` (above) and add a `go-page` to the button — the page then disappears for good once the chat has started, even after a reload.

**"做个图鉴，没收集到的显示问号，拿到新东西弹个提示"** — `found` (json array of ids, default []) and `new_item` (string, aiAccess write, behaviorRules telling the AI to set it when an item is obtained):
```json
{"op":"add_part","part":{"type":"list","x":16,"y":80,"w":343,"h":600,"direction":"row","columns":3,"gap":10,
 "source":{"kind":"static","items":[{"id":"moon","name":"月之泪","img":"@asset:…"},{"id":"key","name":"铜钥匙","img":""}]},
 "item":{"template":"{{item.name}}"},
 "card":{"title":{"template":"{{item.name}}"},"imageField":"img","imageRatio":1,"lockedUnless":{"variableId":"found","field":"id"},"lockedText":{"template":"？？？"}}}},
{"op":"add_part","part":{"type":"popup","variableId":"new_item","title":{"template":"获得新物品"},"body":{"template":"{{value}}"},"x":40,"y":300,"w":295,"h":200}}
```

**Restyle ("按钮做成粉色渐变、圆一点、加阴影，标题换衬线字")**:
```json
{"op":"update_part","id":"button-1","patch":{"style":{"fills":[{"kind":"gradient","angle":135,"stops":[{"color":"#ff9ac8","at":0},{"color":"#c86bff","at":100}]}],"radius":26,"shadows":[{"x":0,"y":6,"blur":18,"color":"rgba(255,120,200,0.45)"}],"textColor":"#ffffff"}}},
{"op":"update_part","id":"text-1","patch":{"style":{"family":"Georgia, \"Songti SC\", serif","size":26}}}
```
Whole card look (chat bubbles, background, font): `set_theme` with a preset from read_ui_doc, or tokens.

**Colour restyle ("粉色可爱风", "改成浅色") = a FULL palette, never one or two tokens.** A preset's other tokens stay in place, so changing only `--yc-bg` and `--yc-text` leaves the old dark bubble and dark composer under your new text. Always send every surface with its ink, as pairs:
`--yc-bg` + `--yc-bg-solid` (page) · `--yc-bubble-bg` + `--yc-text` · `--yc-user-bubble-bg` + `--yc-user-text` · `--yc-input-bg` + `--yc-input-fg` (+ `--yc-input-border`) · `--yc-send-bg` + `--yc-send-fg` · `--yc-chip-bg` + `--yc-chip-fg` · `--yc-name`.
Each ink must read on its surface at 4.5:1 (light ground → dark ink, e.g. `#ffe4ef` with `#4a2436`). The compiler moves any ink below that toward black/white as a safety net, but pick readable pairs yourself so the result looks designed.

## Rules
- Patch only what the creator asked for; merge patch keeps everything else. Replacing `fills`/`options`/`actions` arrays replaces the whole list — resend all items you keep.
- New parts: give real `x,y,w,h` that fit the page and don't cover the composer by accident; add a `desktop` box when the card is also played on wide screens and the part shouldn't just scale.
- Pictures: never invent asset ids — leave `ref:""` and tell the creator which to upload/bind.
- A preserved base layer with knobs (界面旋钮) is restyled with set_ui_knobs, not by parts.
- Tell the creator what changed the way they see it on screen ("开场卡片改成三列，标题换成金色"), never the ops, part ids, field names (`columns=3`), or hex codes.
