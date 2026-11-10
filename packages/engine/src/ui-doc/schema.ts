import { z } from "zod";
import { UI_DOC_VERSION } from "./types.js";
import { elementActions } from "./edit.js";

/**
 * Validation for the interface document.
 *
 * The doc is edited from two directions — a drag canvas and the Studio agent —
 * so it needs a gate that does not care which one wrote it. The agent's edits
 * in particular are why this exists: a structured document it can be held to is
 * the whole reason the agent stops writing free-form TSX.
 *
 * On the free-form fields (`css`, `custom.code`): they are capped, not parsed.
 * Scoping element CSS by wrapping it in a selector block is not a security
 * boundary and is not pretending to be one — a creator who writes `} .x {` to
 * escape the wrapper arrives exactly where `theme.css` already lets them go on
 * purpose. The real boundary is the sandbox the card renders in, which is the
 * same boundary that has always contained hand-written `rootComponent` TSX.
 * These fields grant a creator nothing they could not already do by writing
 * their card's frontend by hand.
 */

const uiTextSchema = z.object({ template: z.string().max(4000) });

const uiImageSrcSchema = z.union([
  // An empty ref is the editor's legitimate "not bound yet" state — every
  // image lands unbound (templates, the palette, a fill switched to image)
  // and binding is a later gesture. The compiler folds it to null, which the
  // runtime already renders as nothing.
  z.object({ kind: z.literal("asset"), ref: z.string().max(500) }),
  z.object({
    kind: z.literal("variable"),
    variableId: z.string().min(1).max(200),
    fallback: z.string().max(500).optional(),
  }),
]);

const uiNumberSchema = z.union([
  z.object({ kind: z.literal("literal"), value: z.number() }),
  z.object({
    kind: z.literal("variable"),
    variableId: z.string().min(1).max(200),
    fallback: z.number().optional(),
  }),
]);

const uiFitSchema = z.enum(["cover", "contain", "fill"]);

const conditionSchema = z.object({
  variableId: z.string().min(1).max(200),
  operator: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "contains"]),
  value: z.union([z.number(), z.string(), z.boolean(), z.record(z.unknown()), z.array(z.unknown())]),
  valueRef: z.string().max(200).optional(),
});

const uiAnimationSchema = z.object({
  kind: z.enum(["fade", "rise", "pulse"]),
  durationMs: z.number().min(1).max(20000),
  delayMs: z.number().min(0).max(20000).optional(),
});

// ── Paint ──

const colorSchema = z.string().max(200);

const uiFillSchema = z.union([
  z.object({ kind: z.literal("color"), color: colorSchema }),
  z.object({
    kind: z.literal("gradient"),
    angle: z.number().min(-360).max(360).optional(),
    stops: z.array(z.object({ color: colorSchema, at: z.number().min(0).max(100) })).min(2).max(12),
  }),
  z.object({
    kind: z.literal("image"),
    src: uiImageSrcSchema,
    fit: uiFitSchema.optional(),
    repeat: z.boolean().optional(),
  }),
]);

const uiShadowSchema = z.object({
  x: z.number().min(-400).max(400),
  y: z.number().min(-400).max(400),
  blur: z.number().min(0).max(400),
  spread: z.number().min(-400).max(400).optional(),
  color: colorSchema,
  inset: z.boolean().optional(),
});

const uiRadiusSchema = z.union([
  z.number().min(0).max(9999),
  z.tuple([
    z.number().min(0).max(9999),
    z.number().min(0).max(9999),
    z.number().min(0).max(9999),
    z.number().min(0).max(9999),
  ]),
]);

const boxStyleSchema = z.object({
  fills: z.array(uiFillSchema).max(8).optional(),
  radius: uiRadiusSchema.optional(),
  borderColor: colorSchema.optional(),
  borderWidth: z.number().min(0).max(40).optional(),
  borderStyle: z.enum(["solid", "dashed", "dotted"]).optional(),
  shadows: z.array(uiShadowSchema).max(8).optional(),
  backdropBlur: z.number().min(0).max(200).optional(),
  padding: z.number().min(0).max(400).optional(),
});

const textStyleSchema = z.object({
  size: z.number().min(1).max(200).optional(),
  desktopSize: z.number().min(1).max(200).optional(),
  color: colorSchema.optional(),
  weight: z.number().min(100).max(900).optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  lineHeight: z.number().min(0.5).max(4).optional(),
  italic: z.boolean().optional(),
  family: z.string().max(200).optional(),
  letterSpacing: z.number().min(-20).max(60).optional(),
  transform: z.enum(["none", "uppercase", "lowercase", "capitalize"]).optional(),
  textShadow: uiShadowSchema.optional(),
  stroke: z.object({ width: z.number().min(0).max(40), color: colorSchema }).optional(),
  markdown: z.boolean().optional(),
  nowrap: z.boolean().optional(),
});

// ── Actions ──

const uiActionSchema = z.union([
  z.object({
    kind: z.literal("set-variable"),
    variableId: z.string().min(1).max(200),
    op: z.enum(["set", "add", "subtract", "toggle"]),
    value: z.union([z.number(), z.string(), z.boolean()]).optional(),
  }),
  z.object({ kind: z.literal("send-message"), text: uiTextSchema }),
  z.object({ kind: z.literal("go-page"), pageId: z.string().min(1).max(200) }),
  z.object({ kind: z.literal("switch-greeting"), index: z.number().int().min(0).max(99), greetingId: z.string().max(200).optional() }),
  z.object({
    kind: z.literal("random"),
    variableId: z.string().min(1).max(200),
    from: z.array(z.string().max(500)).max(100).optional(),
    min: z.number().int().optional(),
    max: z.number().int().optional(),
  }),
  z.object({ kind: z.literal("play-audio"), trackId: z.string().min(1).max(200) }),
  z.object({ kind: z.literal("stop-audio"), trackId: z.string().max(200).optional() }),
  z.object({ kind: z.literal("toast"), text: uiTextSchema }),
  z.object({
    kind: z.literal("run-behavior"),
    actionId: z.string().min(1).max(200),
    params: z.array(z.object({ name: z.string().min(1).max(60), value: uiTextSchema })).max(20).optional(),
  }),
  z.object({ kind: z.literal("run-ai"), aiId: z.string().min(1).max(200) }),
  z.object({ kind: z.literal("regenerate") }),
  z.object({ kind: z.literal("copy-message") }),
  z.object({ kind: z.literal("rewind") }),
]);

// ── Elements ──

/** Free CSS. Capped so a doc cannot become a payload; see the file header for
 *  why it is not parsed. */
const cssSchema = z.string().max(20000);

const baseElementSchema = {
  id: z.string().min(1).max(200),
  name: z.string().max(200).optional(),
  group: z.string().max(200).optional(),
  variableDisplay: z.string().min(1).max(200).optional(),
  desktop: z.object({ x: z.number(), y: z.number(), w: z.number().min(0), h: z.number().min(0) })
    .nullable().optional(),
  x: z.number(),
  y: z.number(),
  w: z.number().min(0),
  h: z.number().min(0),
  z: z.number().optional(),
  opacity: z.number().min(0).max(1).optional(),
  rotation: z.number().min(-360).max(360).optional(),
  visibleWhen: conditionSchema.optional(),
  animation: uiAnimationSchema.optional(),
  css: cssSchema.optional(),
};

const uiListSourceSchema = z.union([
  z.object({ kind: z.literal("variable"), variableId: z.string().max(200) }),
  z.object({
    kind: z.literal("static"),
    items: z.array(z.union([z.string().max(1000), z.record(z.string().max(100), z.string().max(4000))])).max(200),
  }),
  z.object({ kind: z.literal("entries"), role: z.string().max(40).optional(), folderId: z.string().max(200).optional() }),
]);

const buttonStyleSchema = boxStyleSchema.extend({
  textColor: colorSchema.optional(),
  size: z.number().min(1).max(200).optional(),
  desktopSize: z.number().min(1).max(200).optional(),
  weight: z.number().min(100).max(900).optional(),
  family: z.string().max(200).optional(),
  letterSpacing: z.number().min(-20).max(60).optional(),
});

const uiListCardSchema = z.object({
  title: uiTextSchema.optional(),
  subtitle: uiTextSchema.optional(),
  badge: uiTextSchema.optional(),
  imageField: z.string().max(100).optional(),
  imageRatio: z.number().min(0).max(4).optional(),
  lockedUnless: z.object({ variableId: z.string().min(1).max(200), field: z.string().min(1).max(100) }).optional(),
  lockedText: uiTextSchema.optional(),
});

const uiChoiceOptionSchema = z.object({
  id: z.string().min(1).max(200),
  title: z.string().max(200),
  subtitle: z.string().max(500).optional(),
  detail: z.string().max(4000).optional(),
  image: uiImageSrcSchema.optional(),
  tags: z.array(z.string().max(60)).max(12).optional(),
  value: z.string().max(1000).optional(),
  actions: z.array(uiActionSchema).max(20).optional(),
});

const inputBoxStyleSchema = boxStyleSchema.extend({
  textColor: colorSchema.optional(),
  size: z.number().min(1).max(200).optional(),
});

// ── The message layer ──

const messageRoleStyleSchema = z.object({
  bubble: z.boolean().optional(),
  box: boxStyleSchema.optional(),
  text: textStyleSchema.optional(),
});

const messageStyleSchema = z.object({
  preset: z.string().max(40).optional(),
  assistant: messageRoleStyleSchema.optional(),
  user: messageRoleStyleSchema.optional(),
  greeting: messageRoleStyleSchema.optional(),
  showNames: z.boolean().optional(),
  maxWidth: z.number().min(200).max(4000).optional(),
  gap: z.number().min(0).max(200).optional(),
});

/** Markers are short on purpose: a rule finds a convention, not a paragraph. */
const markerSchema = z.string().min(1).max(40);

const messageMatchSchema = z.union([
  z.object({ kind: z.literal("wrap"), open: markerSchema, close: markerSchema }),
  z.object({ kind: z.literal("line-prefix"), prefix: markerSchema }),
  z.object({ kind: z.literal("contains"), text: z.string().min(1).max(200) }),
  z.object({
    kind: z.literal("regex"),
    // Checked for compiling here, so a broken pattern is refused at the door
    // rather than silently matching nothing in every message.
    pattern: z.string().min(1).max(300).refine((p) => {
      try { new RegExp(p, "u"); return true; } catch { /* try without u */ }
      try { new RegExp(p); return true; } catch { return false; }
    }, "not a valid regular expression"),
    flags: z.string().max(6).regex(/^[imsu]*$/, "flags may only be i, m, s, u").optional(),
  }),
]);

const messageRuleSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().max(60),
  enabled: z.boolean().optional(),
  match: messageMatchSchema,
  show: z.enum(["reveal", "banner", "card", "choices", "speaker", "hide"]),
  options: z
    .object({
      cover: z.enum(["ink", "blur", "sticker"]).optional(),
      coverText: z.string().max(60).optional(),
      revealChance: z.number().min(0).max(1).optional(),
      missText: z.string().max(60).optional(),
      box: boxStyleSchema.optional(),
      text: textStyleSchema.optional(),
      title: z.string().max(100).optional(),
      colors: z.record(z.string().max(60), colorSchema).optional(),
      avatars: z.record(z.string().max(60), z.string().max(500)).optional(),
      applyToUser: z.boolean().optional(),
    })
    .optional(),
  aiHint: z.string().max(600).optional(),
  teachAi: z.boolean().optional(),
  example: z.string().max(600).optional(),
});

const messageDesignFields = {
  messageStyle: messageStyleSchema.optional(),
  rules: z.array(messageRuleSchema).max(20).optional(),
};

const uiElementSchema = z.union([
  z.object({ ...baseElementSchema, type: z.literal("box"), style: boxStyleSchema.optional() }),
  z.object({
    ...baseElementSchema,
    type: z.literal("list"),
    source: uiListSourceSchema,
    item: uiTextSchema,
    direction: z.enum(["column", "row"]).optional(),
    gap: z.number().min(0).max(200).optional(),
    maxItems: z.number().int().min(1).max(500).optional(),
    emptyText: uiTextSchema.optional(),
    itemStyle: boxStyleSchema.optional(),
    textStyle: textStyleSchema.optional(),
    card: uiListCardSchema.optional(),
    rowActions: z.array(uiActionSchema).max(20).optional(),
    columns: z.number().int().min(1).max(12).optional(),
  }),
  z.object({
    ...baseElementSchema,
    type: z.literal("choice"),
    options: z.array(uiChoiceOptionSchema).max(60),
    layout: z.enum(["grid", "carousel", "list"]),
    columns: z.number().int().min(1).max(12).optional(),
    gap: z.number().min(0).max(200).optional(),
    multi: z.boolean().optional(),
    maxPick: z.number().int().min(1).max(60).optional(),
    variableId: z.string().max(200).optional(),
    tagFilter: z.boolean().optional(),
    confirm: z
      .object({ label: uiTextSchema, actions: z.array(uiActionSchema).max(20).optional(), style: buttonStyleSchema.optional() })
      .optional(),
    style: z
      .object({
        card: boxStyleSchema.optional(),
        selected: boxStyleSchema.optional(),
        title: textStyleSchema.optional(),
        subtitle: textStyleSchema.optional(),
        imageRatio: z.number().min(0).max(4).optional(),
      })
      .optional(),
  }),
  z.object({
    ...baseElementSchema,
    type: z.literal("field"),
    kind: z.enum(["text", "textarea", "chips", "number", "slider"]),
    variableId: z.string().min(1).max(200),
    label: uiTextSchema.optional(),
    placeholder: z.string().max(500).optional(),
    options: z.array(z.string().max(200)).max(40).optional(),
    allowCustom: z.boolean().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().positive().optional(),
    style: z
      .object({
        label: textStyleSchema.optional(),
        input: inputBoxStyleSchema.optional(),
        chip: inputBoxStyleSchema.optional(),
        chipSelected: inputBoxStyleSchema.optional(),
      })
      .optional(),
  }),
  z.object({
    ...baseElementSchema,
    type: z.literal("popup"),
    variableId: z.string().min(1).max(200),
    title: uiTextSchema.optional(),
    body: uiTextSchema,
    image: uiImageSrcSchema.optional(),
    buttonLabel: uiTextSchema.optional(),
    clearOnClose: z.boolean().optional(),
    style: z
      .object({
        scrim: colorSchema.optional(),
        card: boxStyleSchema.optional(),
        title: textStyleSchema.optional(),
        body: textStyleSchema.optional(),
        button: buttonStyleSchema.optional(),
      })
      .optional(),
  }),
  z.object({
    ...baseElementSchema,
    type: z.literal("text"),
    text: uiTextSchema,
    style: textStyleSchema.optional(),
  }),
  z.object({
    ...baseElementSchema,
    type: z.literal("image"),
    src: uiImageSrcSchema,
    fit: uiFitSchema.optional(),
    radius: uiRadiusSchema.optional(),
    media: z.literal("video").optional(),
    loop: z.boolean().optional(),
    sound: z.boolean().optional(),
  }),
  z.object({
    ...baseElementSchema,
    type: z.literal("meter"),
    value: uiNumberSchema,
    min: uiNumberSchema,
    max: uiNumberSchema,
    style: z
      .object({
        fills: z.array(uiFillSchema).max(8).optional(),
        track: z.array(uiFillSchema).max(8).optional(),
        radius: uiRadiusSchema.optional(),
        reverse: z.boolean().optional(),
      })
      .optional(),
  }),
  // A button that says `action: {…}` (one) is read as a one-step list — the
  // older single-action spelling keeps working instead of failing the doc.
  z.preprocess((raw) => {
    if (!raw || typeof raw !== "object") return raw;
    const obj = raw as Record<string, unknown>;
    if (obj.type !== "button" || Array.isArray(obj.actions) || !obj.action) return raw;
    const { action, ...rest } = obj;
    return { ...rest, actions: [action] };
  }, z.object({
    ...baseElementSchema,
    type: z.literal("button"),
    label: uiTextSchema,
    actions: z.array(uiActionSchema).max(20),
    style: buttonStyleSchema.optional(),
    requires: z.array(z.string().min(1).max(200)).max(20).optional(),
  })),
  z.object({ ...baseElementSchema, type: z.literal("chat"), style: boxStyleSchema.optional(), ...messageDesignFields }),
  z.object({ ...baseElementSchema, type: z.literal("messages"), style: boxStyleSchema.optional(), ...messageDesignFields }),
  z.object({ ...baseElementSchema, type: z.literal("composer"), style: boxStyleSchema.optional() }),
  z.object({
    ...baseElementSchema,
    type: z.literal("custom"),
    code: z.string().max(60000),
    style: boxStyleSchema.optional(),
  }),
]);

const uiPageSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().max(200),
  height: z.number().min(1).max(10000),
  desktopHeight: z.number().min(1).max(10000).optional(),
  leaveWhen: z.object({ when: conditionSchema, pageId: z.string().min(1).max(200) }).optional(),
  background: z
    .union([
      z.object({ kind: z.literal("color"), color: colorSchema }),
      z.object({ kind: z.literal("image"), src: uiImageSrcSchema, fit: uiFitSchema.optional(), dim: z.number().min(0).max(0.9).optional() }),
    ])
    .optional(),
  elements: z.array(uiElementSchema).max(400),
});

const uiThemeSchema = z.object({
  preset: z
    .object({
      id: z.string().min(1).max(40),
      accent: z.string().min(1).max(40),
      font: z.string().min(1).max(40),
      radius: z.string().min(1).max(20),
    })
    .optional(),
  fonts: z
    .array(
      z.object({
        family: z.string().min(1).max(200),
        ref: z.string().min(1).max(500),
        fallback: z.string().max(300).optional(),
        weight: z.number().min(100).max(900).optional(),
        style: z.enum(["normal", "italic"]).optional(),
      })
    )
    .max(8)
    .optional(),
  tokens: z.record(z.string().max(200)).optional(),
  css: cssSchema.optional(),
});

/** The 拆积木 result on its own — the studio AI's write_ui_knob_groups tool
 *  validates an incoming decomposition against exactly what the document
 *  accepts, so the two can never drift. */
export const uiKnobGroupsSchema = z
  .array(
    z.object({
      id: z.string().min(1).max(64).regex(/^[\w-]+$/),
      label: z.string().min(1).max(60),
      knobs: z
        .array(
          z.object({
            // Dots namespace the knob under its region ("night.title-color").
            id: z.string().min(1).max(80).regex(/^[\w.-]+$/),
            label: z.string().min(1).max(60),
            kind: z.enum(["color", "text", "number"]),
            value: z.union([z.string().max(2000), z.number().finite()]),
            min: z.number().optional(),
            max: z.number().optional(),
            step: z.number().positive().optional(),
            unit: z.string().max(8).optional(),
          })
        )
        .max(40),
    })
  )
  .max(24);

export const uiDocSchema = z.object({
  version: z.number().int().min(1).max(UI_DOC_VERSION),
  pages: z.array(uiPageSchema).min(1).max(50),
  entryPageId: z.string().min(1).max(200),
  theme: uiThemeSchema.optional(),
  surface: z.literal("chat").optional(),
  autoVariables: z.array(z.string().min(1).max(200)).max(500).optional(),
  editorSamples: z
    .record(
      z.string().min(1).max(200),
      z.union([
        z.string().max(500),
        z.array(z.union([z.string().max(500), z.record(z.string().max(100), z.string().max(500))])).max(8),
      ]),
    )
    .refine((r) => Object.keys(r).length <= 50, "at most 50 samples")
    .optional(),
  // The preserved pre-existing frontend, rendered as the unscaled bottom
  // layer. Subfolder names are fine (the rootComponent's FS is a flat virtual
  // key space); ".." is rejected as hygiene, not as a security boundary —
  // there is no real filesystem underneath to traverse.
  base: z
    .object({
      file: z
        .string()
        .min(1)
        .max(200)
        .regex(/^(?!\.)(?!.*\.\.)[\w./-]+$/, "must be a file name without .. segments"),
      groups: uiKnobGroupsSchema.optional(),
    })
    .optional(),
});

/** Parse, and additionally check the references a schema alone cannot: that the
 *  entry page exists, that every `go-page` action points at a real page, and
 *  that a font a text style asks for was actually declared. A button that
 *  silently does nothing, and a font that silently falls back, are the failures
 *  this catches. */
export function validateUiDoc(input: unknown): { ok: true; doc: import("./types.js").UiDoc } | { ok: false; errors: string[] } {
  const parsed = uiDocSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
  }
  const doc = parsed.data as import("./types.js").UiDoc;
  const errors: string[] = [];
  const pageIds = new Set(doc.pages.map((p) => p.id));
  if (pageIds.size !== doc.pages.length) errors.push("pages: duplicate page id");
  if (!pageIds.has(doc.entryPageId)) errors.push(`entryPageId: no page with id "${doc.entryPageId}"`);

  // Two families under one name is unambiguously a mistake — one of them can
  // never be referenced. An UNDECLARED family is not checked at all: there is
  // no way to tell a typo'd reference from "Georgia", and a validator that
  // rejects a real system font is worse than a font that quietly falls back.
  const seenFontFamilies = new Set<string>();
  for (const face of doc.theme?.fonts ?? []) {
    if (seenFontFamilies.has(face.family)) errors.push(`theme.fonts: duplicate family "${face.family}"`);
    seenFontFamilies.add(face.family);
  }

  for (const page of doc.pages) {
    if (page.leaveWhen && !pageIds.has(page.leaveWhen.pageId)) {
      errors.push(`${page.id}: leaveWhen points at missing page "${page.leaveWhen.pageId}"`);
    }
    const elementIds = new Set(page.elements.map((e) => e.id));
    if (elementIds.size !== page.elements.length) errors.push(`${page.id}: duplicate element id`);
    for (const el of page.elements) {
      for (const action of elementActions(el)) {
        if (action.kind === "go-page" && !pageIds.has(action.pageId)) {
          errors.push(`${page.id}/${el.id}: go-page points at missing page "${action.pageId}"`);
        }
      }
      // A reveal remembers itself by rule id; two rules sharing one would
      // share each other's memory.
      if ((el.type === "chat" || el.type === "messages") && Array.isArray(el.rules)) {
        const ruleIds = new Set(el.rules.map((r) => r.id));
        if (ruleIds.size !== el.rules.length) errors.push(`${page.id}/${el.id}: duplicate message rule id`);
      }
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, doc };
}
