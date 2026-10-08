import { getSmartImageCapabilities, SMART_IMAGE_MODEL, SMART_IMAGE_MODELS,
  SMART_IMAGE_ASPECTS, SMART_IMAGE_RESOLUTIONS, MAX_IMAGE_BATCH_ITEMS, IMAGE_ASPECTS,
  platformStylePrice, TTS_VOICES, type PlatformStyleInfo } from "@yumina/shared";
import type { ToolDefinition } from "../llm/types.js";

/** The assistant picks its own model, so the schema advertises the union across
 *  all of them and normalizeImageProposal narrows the pair down to what the
 *  chosen model really accepts. Advertising one model's list would hide shapes
 *  and sizes the others can do; advertising the union without narrowing would
 *  let a combination reach a provider that rejects it.
 *
 *  Read from the shared table rather than retyped, so a ratio or tier added
 *  there reaches the assistant in the same commit as the creator's own picker. */
/** One line of verifiable fact per model — price, sizes, shapes, seed support.
 *  Deliberately no claim about which draws better: nobody has measured that
 *  here, and inventing it would be spending the creator's money on a guess.
 *  The assistant weighs these and says out loud what it picked and why. */
const IMAGE_TOOL_MODELS = SMART_IMAGE_MODELS.map(model => {
  const caps = getSmartImageCapabilities(model.id);
  const facts = [
    `~${Math.round(model.estimatedCostUsd * 1000)} mushies/image`,
    caps.resolutions.length ? `sizes ${caps.resolutions.join("/")}` : "one fixed size",
    `${caps.aspectRatios.length} shapes`,
    model.supportsSeed ? "seed supported" : "no seed",
  ];
  return { id: model.id, name: model.name, line: `${model.id} — ${model.name}: ${facts.join(", ")}` };
});
const IMAGE_TOOL_CAPABILITIES = {
  aspectRatios: SMART_IMAGE_ASPECTS.filter(ratio =>
    SMART_IMAGE_MODELS.some(model => (model.aspectRatios as readonly string[]).includes(ratio))),
  resolutions: SMART_IMAGE_RESOLUTIONS,
};

/** The curated voice catalog, one compact line per voice, read from the same
 *  table the editor's voice picker uses so the two cannot drift. Any other
 *  fish.audio id (32 hex) the creator pastes works too. */
const VOICE_CATALOG_LINES = TTS_VOICES.map(v => `${v.id} ${v.labelKey}`).join("; ");

/** One line of verifiable fact per platform base model — derived from
 *  PLATFORM_STYLES and the same price function the generation route charges
 *  with. No quality claims: what each base draws best has not been measured
 *  here, so the assistant only gets the slug, the prompt dialect and the cost. */
export function customImageStyleLines(styles: readonly PlatformStyleInfo[]): string[] {
  return styles.map(style => {
    const sizes = IMAGE_ASPECTS.map(aspect => platformStylePrice(style.slug, aspect.id, 1));
    const low = Math.min(...sizes), high = Math.max(...sizes);
    const price = low === high ? `${low}` : `${low}-${high}`;
    return `${style.slug} — ${style.dialect === "danbooru" ? "prompt as comma-separated Danbooru tags" : "prompt as English natural-language prose"}, ${price} mushies/image`;
  });
}

/** generate_image, with or without 自定义生图. `customStyles` is the list of
 *  platform base models that are ready in this environment right now; null or
 *  empty means custom generation is off, and the schema does not mention it. */
export function generateImageTool(customStyles: readonly PlatformStyleInfo[] | null): ToolDefinition {
  const custom = customStyles && customStyles.length ? customStyles : null;
  const tool: ToolDefinition = {
    type: "function",
    function: {
      name: "generate_image",
      description:
        "Propose a new picture from Yumina's built-in image generator. Nothing is generated and nothing is charged until the creator presses Generate on the card this shows; they can edit the prompt there first. Use ONLY when the creator needs an image that does not exist yet (a map, a portrait, a scene, a cover) and asked for one or clearly wants one — never to decorate on your own initiative. Write `prompt` as a concrete visual description in English: subject, setting, style, lighting, composition. Never ask for text, letters or UI inside the picture. MUST NOT be combined with any other tool call in the same turn. After the creator confirms you receive the delivered @asset ref(s) and can place them with edit_custom_ui or write_entry (a cover is picked by the creator in the editor; no tool sets it).",
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "The visual description to generate from (English, concrete, no text in the image).",
          },
          model: {
            type: "string",
            enum: IMAGE_TOOL_MODELS.map(model => model.id),
            description:
              "Which generator to run. Judge it yourself from what the picture is for; these are the facts, not a ranking:\n"
              + IMAGE_TOOL_MODELS.map(model => `  ${model.line}`).join("\n")
              + `\nA size or shape a model does not list falls back to that model's default, so choose the size and shape the picture needs first, then a model that offers them. Default ${SMART_IMAGE_MODEL}. Give your reason in modelReason; the confirmation card shows it to the creator next to the price.`,
          },
          modelReason: {
            type: "string",
            description: "One short line, in the creator's language, saying why this generator for this picture (e.g. '要 512 的小图标，只有它能直接出' or '普通插画，选了最便宜的'). The confirmation card shows it beside the model name and price, so the creator can judge the spend before agreeing.",
          },
          purpose: {
            type: "string",
            description: "One short line, in the creator's language, saying what the image is for (e.g. 'Map of the northern kingdom for the travel panel'). Shown on the confirmation card.",
          },
          aspectRatio: {
            type: "string",
            // Derived, never hand-listed: this enum had drifted to seven ratios
            // while the generator had grown to thirteen, so the assistant could
            // not offer shapes the creator could pick themselves.
            enum: [...IMAGE_TOOL_CAPABILITIES.aspectRatios],
            description: "Picture shape. Portraits 2:3 or 3:4, maps and scenes 3:2 or 16:9, covers 3:4, icons 1:1, wide banners 21:9 or 2:1, tall side panels 9:21 or 1:2. Default 1:1.",
          },
          resolution: {
            type: "string",
            enum: [...IMAGE_TOOL_CAPABILITIES.resolutions],
            description: "Output size. 512 for icons and avatars, 1K for in-card art, 2K for covers and scene art; 4K only when the creator asks for print-scale detail, since it costs more and takes longer. Not every model offers every size — an unsupported pick falls back to that model's default. Default 2K.",
          },
          batchSize: {
            type: "integer",
            minimum: 1,
            maximum: 4,
            description: "How many variations to generate (each one is charged). Default 1; offer more only when the creator wants to choose.",
          },
        },
        required: ["prompt"],
      },
    },
  };
  if (!custom) return tool;
  const params = tool.function.parameters as { properties: Record<string, unknown> };
  tool.function.description += " Two modes: smart (描述生图, the default: the models listed under `model`) and custom (自定义生图: a platform base model on Yumina's own image workers, chosen with `style`). In custom mode the prompt is sent to the base model exactly as written — nothing rewrites it — so write it in that base model's prompt dialect.";
  params.properties = {
    mode: {
      type: "string",
      enum: ["smart", "custom"],
      description: "smart = 描述生图 (pick `model`); custom = 自定义生图 (pick `style`; `model` and `resolution` are ignored). Default smart.",
    },
    style: {
      type: "string",
      enum: custom.map(style => style.slug),
      description: "Custom mode only: the platform base model. Facts, not a ranking:\n"
        + customImageStyleLines(custom).map(line => `  ${line}`).join("\n")
        + `\nFor a Danbooru-tag base write \`prompt\` as comma-separated tags (e.g. "1girl, silver hair, school uniform, cherry blossoms, looking at viewer"); for a prose base write English sentences. Custom renders at fixed sizes (${IMAGE_ASPECTS.map(aspect => `${aspect.id} ${aspect.width}×${aspect.height}`).join(", ")}); aspectRatio snaps to the nearest one. Default ${custom[0]!.slug}.`,
    },
    ...params.properties,
  };
  return tool;
}

/** The toolset for one agent run: generate_image re-described for the base
 *  models this environment can actually run. */
export function withCustomImageTool(tools: ToolDefinition[], customStyles: readonly PlatformStyleInfo[] | null): ToolDefinition[] {
  if (!customStyles?.length) return tools;
  return tools.map(tool => tool.function.name === "generate_image" ? generateImageTool(customStyles) : tool);
}

// ── Studio AI: 8-tool agent (Claude Code pattern) ──
//
// The model makes multiple write_* calls in one response (parallel tool use).
// Server collects all calls, converts to SchemaChange[], validates atomically,
// and routes through the executeApplyChanges() pipeline.

// ── Read Tools (auto-execute, no approval) ──

export const READ_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "list_assets",
      description: "Browse/search the creator's asset library with folder bindings. Defaults to this card's bound folders (including descendants), or all owned assets if none are bound. Use scope=all to find other assets. Follow nextOffset until null before concluding a file is absent. Returns folder paths, stable @asset refs, exact filtered total, and pagination.",
      parameters: { type: "object", properties: {
        scope: { type: "string", enum: ["bound", "all"] },
        folderId: { type: "string", description: "Owned folder ID, including its descendants." },
        query: { type: "string", description: "Literal filename substring." },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      } },
    },
  },
  {
    type: "function",
    function: {
      name: "read_entities",
      description:
        "Read full details of one or more entities. The inventory in your context shows IDs, names, and metadata — use this tool to get complete content (entry text, TSX code, behavior effects, conditions, etc.) when you need it before making changes. Batch multiple reads in one call. For large TSX files, use offset_lines/limit_lines to read a specific range — the usual workflow is grep_world to find line numbers, then read_entities with offset_lines/limit_lines around the match.",
      parameters: {
        type: "object",
        properties: {
          ids: {
            type: "array",
            items: { type: "string" },
            description:
              'Array of entity IDs to read. Can mix entity types (entries, variables, behaviors, rules, customUI, audio). Special ID: "settings" returns world settings.',
          },
          offset_lines: {
            type: "number",
            description:
              "1-based starting line for TSX content (customUI / rootComponent files). Ignored for non-TSX entities. Default: return from the beginning.",
          },
          limit_lines: {
            type: "number",
            description:
              "Max lines of TSX content to return. Default: 2000. Max: 5000. Only applies when the requested entity is a TSX file.",
          },
        },
        required: ["ids"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep_world",
      description:
        "Grep across the world's text content for a literal string. Searches TSX code, entry content, variable behaviorRules, and behavior descriptions — optionally scoped to one entity type or one specific ID. Returns each match with the source entity (type + id + field) and ±context_lines of surrounding text, so you can build an exact `old_code` for `edit_custom_ui` or locate a concept across many entries at once. Literal search; capitalization must match. Returns up to 20 matches with ±5 lines of context by default.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Literal string to find (not a regex). Capitalization must match." },
          scope: {
            type: "string",
            enum: ["customUI", "entries", "variables", "behaviors", "all"],
            description: "Restrict search to one entity type, or 'all' (default). customUI searches tsxCode; entries searches content; variables searches behaviorRules+description; behaviors searches description.",
          },
          id: { type: "string", description: "Restrict search to a specific entity ID (works within any scope). For customUI scope: a component ID or rootComponent filename (e.g. 'homepage.tsx'). Omit to search all entities in the scope." },
          context_lines: { type: "number", description: "Lines of context before/after each match. Default 5, max 20." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "load_skill",
      description:
        "Load detailed domain knowledge for a specific topic. Call this BEFORE writing audio tracks, lore-heavy content, or editing the visual interface document (edit_ui_doc) — these domains have specific conventions not covered by tool definitions alone. Core skills (entries, variables, tsx, front-ui, world-design, rules) are already in your context.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: 'Skill name: "audio" (audio tracks), "lore" (advanced worldbuilding: codeification, layered faction systems, multiplayer canon) or "ui-doc" (visual interface document: part shapes + worked examples for edit_ui_doc). Core skills (entries, variables, tsx, front-ui, world-design, rules) are already loaded — do not reload them.',
          },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_ui_doc",
      description:
        "Read the card's visual interface document (uiDoc) — the no-code interface the visual editor and edit_ui_doc edit. Returns a compact summary: pages, every part (id, type, name, phone box x,y w×h, desktop box, key props, style keys, visibility), the theme, plus the card's variables (id/name/type), openings (switch-greeting index → title) and audio track ids that parts refer to. Pass parts:[ids] to also get those parts' full JSON (do this before a detailed restyle of an existing part).",
      parameters: {
        type: "object",
        properties: {
          page: { type: "string", description: "Only list this page (id or name)." },
          parts: { type: "array", items: { type: "string" }, description: "Part ids whose full JSON to return." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "validate_world",
      description:
        "Scan the current world for structural issues: undefined variable references in conditions/effects/macros, chat-history entries with no keywords that will never trigger, behaviors that can fire in infinite loops, duplicate IDs across entity types, and more. Returns a structured report with errors (definitely broken) and warnings (risky, may be intentional). Call this after a batch of writes for any system touching variables, behaviors, or entries — it catches reference breakage and logic bombs before the creator sees runtime bugs. Auto-executes, no approval needed, no parameters.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "analyze_token_cost",
      description:
        "Analyze the world's per-turn token cost, INCLUDING the keyword-triggered lore pool that the editor's \"per-turn\" estimate hides (the footer counts only always-send entries + variable rules). Returns: keyword-lore entry count + pool tokens, worst-case lore injected in one turn (bounded by lorebookBudgetCap / lorebookBudgetPercent), the always-send + variable-rule footprint for contrast, recursion/cap settings, and — when the keyword pool is heavy with no effective ceiling — a flood-risk advisory + fix priority. Call this when the creator asks about token cost / bloat / slimming, AFTER any batch of lore-heavy writes (report the headline number to the creator in one sentence), and as step 1 of any slimming pass (see the slim skill). Findings are advisory — never delete or rewrite content based on them without the creator's approval. Auto-executes, no approval needed, no parameters.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_source",
      description:
        "Search the source texts the creator attached to this card (e.g. the novel a fan-work is based on — listed under \"Source texts\" in your context). Literal search; several space-separated words must all appear close together (\"贝尔 艾丝 告白\" finds that scene). Returns matches with chapter index/title, character offset and a snippet. Use it for canon facts: names as this translation writes them, terms, places, who said what, when something happened. Then read_source the chapter for the full passage. Auto-executes.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Word(s) to find. Space-separated words must all occur within ~300 characters of each other." },
          source_id: { type: "string", description: "Which source (id from the list). Omit to search all of them." },
          max_results: { type: "number", description: "Hits to return, default 15, max 40." },
          context_chars: { type: "number", description: "Characters of context on each side of a hit, default 120, max 400." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_source",
      description:
        "Read part of a source text attached to this card: a chapter by index or by (part of) its title, a slice of a long chapter (offset relative to the chapter), or any absolute character offset (e.g. one search_source returned). At most 12000 characters per call; the result says how to read on. list_chapters:true returns the table of contents instead. Read what you need for the task at hand — do not page through a whole novel. Auto-executes.",
      parameters: {
        type: "object",
        properties: {
          source_id: { type: "string", description: "Which source (id from the list). May be omitted when the card has only one." },
          list_chapters: { type: "boolean", description: "Return the chapter list (300 at a time; offset pages it) instead of text." },
          chapter: { type: "string", description: "Chapter index (\"12\") or text in its title (\"第三卷 第二章\")." },
          offset: { type: "number", description: "With chapter: characters into that chapter. Without: absolute character offset in the source." },
          length: { type: "number", description: "Characters to return, default and max 12000." },
        },
      },
    },
  },
];

// ── Write Tools (collected, validated atomically, approval classified) ──

export const WRITE_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "write_entry",
      description:
        "Create or update a world entry (character, lore, plot, style, greeting, etc). If the ID already exists it updates only the provided fields; otherwise creates a new entry. Call multiple write_entry tools in parallel to create several entries at once. SIZE LIMIT: keep a single entry's content under ~4,000 CJK characters (~3,000 English words). For a large cast, write ONE ENTRY PER CHARACTER (shared keywords/conditions) instead of one giant group entry — per-character entries also let keyword gating load only who's on stage. When a task needs several large entries, write them across MULTIPLE turns (1-2 large writes per reply, then continue after seeing the tool results) — never batch all of them into one enormous reply.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Descriptive kebab-case ID (e.g. 'tavern-lore', 'alice-greeting')." },
          name: { type: "string" },
          content: { type: "string", description: "Entry text sent to the LLM. Supports {{char}}, {{user}}, {{variableId}} macros." },
          portrait: { type: "string", description: "Character portrait @asset reference (role 'character' only). Empty string removes the portrait." },
          voice: { type: "string", description: `Voice this character's dialogue is read aloud in when the player turns on voice readout (role 'character' only; the player's own voice pick yields to it). A fish.audio voice id, 32 lowercase hex. Curated: ${VOICE_CATALOG_LINES}. Match the character's gender/age/temperament and the card's language; set it only when the creator asks for voices or is setting up readout. Empty string removes it (the AI then casts one from the player's pool).` },
          role: { type: "string", enum: ["system", "character", "personality", "scenario", "lore", "plot", "style", "example", "greeting", "custom"], description: "'character' makes the entry a character: only then do portrait and voice apply (the editor's 「这是一个角色」 switch). Use it for every cast member's main entry." },
          section: { type: "string", enum: ["system-presets", "examples", "chat-history", "post-history"] },
          keywords: { type: "array", items: { type: "string" }, description: "Trigger words for chat-history entries." },
          enabled: { type: "boolean" },
          depth: { type: "number", description: "For chat-history: inject N messages from the end." },
          tags: { type: "array", items: { type: "string" } },
          apiRole: { type: "string", enum: ["system", "user", "assistant"] },
          conditions: { type: "array", items: { type: "object", properties: { variableId: { type: "string" }, operator: { type: "string" }, value: {} } }, description: "State conditions: [{ variableId, operator, value }]" },
          conditionLogic: { type: "string", enum: ["all", "any"] },
          alwaysSend: { type: "boolean" },
          matchWholeWords: { type: "boolean" },
          secondaryKeywords: { type: "array", items: { type: "string" } },
          secondaryKeywordLogic: { type: "string", enum: ["AND_ANY", "AND_ALL", "NOT_ANY", "NOT_ALL"] },
          useFuzzyMatch: { type: "boolean", description: "Enable fuzzy keyword matching for misspellings." },
          preventRecursion: { type: "boolean", description: "Stop this entry's content from triggering more entries." },
          excludeRecursion: { type: "boolean", description: "Don't trigger this entry during recursive scans." },
          folderId: { type: "string", description: "Folder ID for editor organization (UI-only, no prompt effect). If the folder doesn't exist it's auto-created with this id as its name; user can rename it later." },
          position: { type: "number", description: "Position in section (auto-calculated if omitted)." },
          worldbookId: { type: "string", description: "Knowledge base (worldbook) this entry belongs to (see write_worldbook). Omit or \"\" = the always-on Core book. Entries in a non-Core book are gated by that book's activation BEFORE their own alwaysSend/keyword/condition trigger — so alwaysSend means 'always while this book is active', not globally." },
          audience: { type: "string", enum: ["ai", "player", "both"], description: "Who receives this entry's content: 'ai' (prompt only — hidden director notes), 'player' (UI-facing only; the model is NOT told it), 'both' (default)." },
          initialVariables: { type: "object", description: "GREETING entries only: map of variableId → starting value seeded into session state when a player picks this opening (route/scenario preset). e.g. { \"route\": \"mayu\" }. Condition-mode worldbooks and conditional entries key off the seeded value." },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_variable",
      description:
        "Create or update a game variable (HP, gold, flags, inventory, etc). If the ID already exists it updates only the provided fields. behaviorRules is critical — it tells the AI when and how to modify this variable during gameplay.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Kebab-case ID used in {{id}} macros and [id: op value] directives." },
          name: { type: "string" },
          type: { type: "string", enum: ["number", "string", "boolean", "json"] },
          defaultValue: {
            description:
              "Default value, as a JSON value of the SAME type as `type` — never a quoted string wrapping it. number -> 0, boolean -> false, json -> [] or {}, string -> \"text\". Do NOT send \"0\", \"false\" or \"[]\".",
          },
          min: { type: "number" },
          max: { type: "number" },
          category: { type: "string", enum: ["stat", "inventory", "resource", "flag", "relationship", "custom"] },
          behaviorRules: { type: "string", description: "Detailed instructions for the AI: when to change it, by how much, edge cases." },
          description: { type: "string" },
          scope: { type: "string", enum: ["narrative", "setup"], description: "Lifecycle scope. Omit/'narrative' for ordinary game state (captured in per-message snapshots, restored on revert/branch/opening-switch). Use 'setup' for a once-at-start config choice written by a pre-game UI screen (e.g. the cast the player picked) that MUST survive an opening switch — without it the choice is wiped to default the moment the player picks an opening. See world-design Pattern 7." },
          internal: { type: "boolean", description: "Mark true for an engine-bookkeeping variable the player/AI should never see — e.g. the json history array a random list-pick uses for its cooldown. Internal vars persist normally but are hidden from the creator's Variables list AND never rendered into <game-state>. Use this for a random-pick's historyVar." },
          aiAccess: { type: "string", enum: ["write", "read", "none"], description: "What the AI may do with this variable. 'write' (default): in <game-state>, updatable via directives — for state only the AI can judge (affinity, mood). 'read': in <game-state> with a read-only marker; AI directives targeting it are DROPPED — for engine-owned state the AI should narrate but never change (phase, rating, settlement result); drive it from behaviors/UI. 'none': never sent to the AI at all — ledgers, counters, bookkeeping; still fully usable in conditions/behaviors/custom UI. Prefer 'read'/'none' over behaviorRules prose like \"don't touch this\" — the engine enforces it." },
          activation: { type: "object", description: "When the variable is 'in play' (same shape as a worldbook's activation). Omit = always. { mode:'manual' } — gated by `enabled` + runtime @vars.enabled.<id> toggles from behaviors. { mode:'conditions', conditions:[{variableId,operator,value}], conditionLogic:'all'|'any' } — active while conditions match (valueRef supported, incl. self-gating like 'show rage only while > 0'). { mode:'greeting', greetingIds:[...] } — active only in sessions on those openings. An INACTIVE variable leaves <game-state> and the player UI and rejects AI writes, but KEEPS its value — conditions/behaviors/custom UI still read it." },
          enabled: { type: "boolean", description: "Enable-gate default (default true). Mostly for activation mode 'manual': start disabled, then a behavior flips it on via a THEN effect on path '@vars.enabled.<id>'." },
          worldbookId: { type: "string", description: "Module (worldbook) this variable belongs to (see write_worldbook). Omit or empty string = Core (always on). While the module is INACTIVE the variable leaves <game-state>, the player UI, and rejects AI writes — its value is kept. Stacks with the variable's own activation/enabled gates (AND)." },
          precise: { type: "boolean", description: "Precise tracking (the editor's 「精准追踪」): after each reply a small decision model, not the narrator, sets this variable — so it reliably moves with the story. ON BY DEFAULT for a new number/boolean variable and for a string with `options`; pass false only for a value something else owns (a counter a behavior drives, a player's pick). Ignored for aiAccess 'read'/'none', internal and json variables." },
          deltaDown: { type: "number", description: "Precise tracking, numbers: the most it may fall in one turn (≥ 0). Default 15% of max−min, or 10 without a range." },
          deltaUp: { type: "number", description: "Precise tracking, numbers: the most it may rise in one turn (≥ 0). Default 15% of max−min, or 10 without a range." },
          options: { type: "array", items: { type: "string" }, description: "String variables: the fixed values it may take (e.g. mood: 平静/开心/生气). With options the variable is precise-tracked — the judge picks one each turn." },
          persist: { type: "string", enum: ["player"], description: "'player': kept for the player across every playthrough of the card (clears, unlocked endings, collected CGs) — a new chat starts from the saved value. Omit for ordinary per-chat state." },
          formula: { type: "string", description: "Number variables: a formula the engine works out after every change (公式数值), e.g. '基础攻击 * (1 + 等级 * 0.1)' or 'min(40, 40 - len({dead-names}))'. Names are variable names or ids ({name-with-symbols} braces); + - * / % ^, comparisons, && ||, and min max floor ceil round abs len sum clamp if. The AI reads it, never writes it. Use instead of asking the AI to keep a derived number in step." },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_behavior",
      description:
        "Create or update an event-driven behavior (reaction). Behaviors fire WHEN an event occurs, IF conditions are met, THEN apply effects. If the ID already exists it updates only the provided fields.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          when: {
            type: "object",
            description: "Event pattern: { eventType: 'turn:complete'|'message:user'|'message:ai'|'session:start'|'state:changed'|'state:crossed'|'action:fired'|'audio:track-ended'|'spatial:zone-enter'|'spatial:zone-leave'|'spatial:proximity-enter'|'spatial:interact'|'spatial:proximity-leave'|'spatial:scene-change'|'spatial:exit-overlap'|'clock:every', match?: { field: { operator, value } } }. 'clock:every' with match { seconds: { operator: 'eq', value: N } } runs every N seconds while the game is open. 'action:fired' events from a button may carry params (商品, 价格): read them anywhere in the behavior as {参数.名字} (condition values, effect values, notices).",
          },
          conditions: { type: "array", items: { type: "object", properties: { variableId: { type: "string" }, operator: { type: "string" }, value: {} } }, description: "State conditions: [{ variableId, operator, value }]" },
          conditionLogic: { type: "string", enum: ["all", "any"] },
          elseMessage: { type: "string", description: "A notice shown to the player when this behavior's event happens but its conditions do not hold ('金币不够，还差 {参数.价格}')." },
          custom: { type: "boolean", description: "自定义 — the behavior is a declared slot that code implements (its `code`, or api.executeAction(id) from the interface); its when/if/then are not what runs it. Set when the creator picked 自定义 on the canvas or asks for a behavior that only code can do; keep it when you implement one." },
          code: { type: "string", description: "代码行为 — the escape hatch: the creator's own JavaScript, run in the card's sandbox when the behavior fires (only while the game is open). It gets ctx: vars, get(name), set(name,v), add(name,n), push(name,x), toast(text), say(text), callAi(ai,input) → Promise, random(a,b), event. Use only for what conditions/effects cannot say (parsing, settling a game, multi-step logic)." },
          then: {
            type: "array",
            items: { type: "object", properties: { type: { type: "string" }, path: { type: "string" }, value: {}, operation: { type: "string" }, valueRef: { type: "string" }, valueRandom: { type: "object" } } },
            description: "Effects: [{ type:'set', path:'variableId', value:..., operation:'set'|'add'|'subtract'|'multiply'|'toggle'|'append' }]. The value can be a literal, valueRef (another variable's value), or valueRandom (a random draw resolved at fire time): { kind:'range', min, max, integer? } | { kind:'dice', count, sides, modifier? } | { kind:'list', candidates:[...], weights?:[...], cooldown?:N, historyVar?:'var', onExhausted?:'full'|'keep' }. For a list draw the operation must be 'set'. Also: { type:'emit', event:{ type:'ui:notification', message:'...' } }. System paths: '@vars.enabled.<variableId>' with a boolean value toggles that variable's enable gate (see write_variable activation); '@worldbooks.on.<worldbookId>' with a boolean value switches a manual- or keywords-mode scenario on/off for the session.",
          },
          priority: { type: "number" },
          enabled: { type: "boolean" },
          cooldownTurns: { type: "number" },
          maxFireCount: { type: "number" },
          chance: { type: "number", description: "0-100: probability this behavior fires when it otherwise would. Omit/100 = always. Use for 'sometimes it happens' random events." },
          description: { type: "string" },
          worldbookId: { type: "string", description: "Module (worldbook) this behavior belongs to (see write_worldbook). Omit or empty string = Core (always on). A behavior in an INACTIVE module never fires; activation is re-checked per chain hop, so a module switched on mid-chain joins the following hops." },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_custom_ui",
      description:
        "Create or update a file in the world's rootComponent. Every world has exactly one rootComponent — a multi-file virtual filesystem that renders the entire visual experience. `id` is the filename (e.g. 'index.tsx', 'homepage.tsx', 'bubble.tsx'); the `index.tsx` entry file is what actually mounts. Supports three languages: 'tsx' (default, React with useYumina() SDK + Chat/MessageList/MessageInput building blocks), 'html' (raw HTML/CSS/JS with window.yumina), 'markdown' (static). For small edits to existing code, prefer edit_custom_ui — it's faster and avoids output truncation.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Filename inside rootComponent.files (e.g. 'index.tsx', 'homepage.tsx'). Non-filename IDs write to the entry file." },
          name: { type: "string" },
          language: { type: "string", enum: ["tsx", "html", "markdown"], description: "Component language. 'tsx' (default): React with useYumina() hook. 'html': raw HTML/CSS/JS with window.yumina global. 'markdown': static content." },
          tsxCode: { type: "string", description: "Component source code. TSX for language='tsx', HTML for language='html', markdown for language='markdown'. Use useYumina() SDK only — never fetch/localStorage/window.location directly." },
          description: { type: "string" },
          visible: { type: "boolean" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_custom_ui",
      description:
        "Edit existing code in a rootComponent file via search-replace. PREFER this over write_custom_ui for modifications — sends only the changed section, not the whole file. The old_code string must appear EXACTLY ONCE in the current file. If it appears 0 or 2+ times, include more surrounding lines for a unique match.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Filename inside rootComponent.files (e.g. 'index.tsx', 'homepage.tsx'). Non-filename IDs target the entry file." },
          old_code: { type: "string", description: "Exact code snippet to find. Must appear exactly once. Include surrounding lines if needed for uniqueness." },
          new_code: { type: "string", description: "Replacement code snippet." },
        },
        required: ["id", "old_code", "new_code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_ui_knobs",
      description:
        "Set style knobs on a card whose hand-written frontend has been decomposed (uiDoc.base.groups). Each knob is a visual constant — a colour, display text, or a size — that the base code reads from a generated module. This is THE way to restyle a decomposed frontend: never edit its code for a colour/text/size change a knob already covers. Knob ids and current values appear in the world snapshot under 界面旋钮. Color knobs take any CSS color string; number knobs take a bare number (the unit is fixed in the code); text knobs take the display string.",
      parameters: {
        type: "object",
        properties: {
          knobs: {
            type: "array",
            description: "Knob edits to apply atomically.",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: 'Knob id, e.g. "night.title-color".' },
                value: { description: "New value: string for color/text knobs, number for number knobs." },
              },
              required: ["id", "value"],
            },
          },
        },
        required: ["knobs"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_ui_knob_groups",
      description:
        'Install the style-knob groups of a card\'s preserved base frontend — the 拆积木 (decompose) step that makes a hand-written frontend editable from the visual builder without reading code. Replaces any existing groups wholesale. WORKFLOW — everything in ONE reply so the batch applies atomically: (1) read the base file(s); (2) via edit_custom_ui calls, rewrite each chosen visual constant to read from the generated knobs module: import K from the generated root _knobs.tsx using a path relative to each file you touch (root file: `import K from "./_knobs";`; components/Hero.tsx: `import K from "../_knobs";`; deeper directories need another ../ per level), replace the literal with K["<knob-id>"] (JSX attribute position: attr={K["…"]}; JSX text position: {K["…"]}; inside a template literal: ${K["…"]}), and tag each visual region\'s outermost JSX element with data-knob-group="<group-id>"; (3) LAST in the same reply, call this tool with groups whose knob values are EXACTLY the literals you removed — at default values the rendered card must be pixel-identical to before the decomposition. Validation rejects the whole batch (nothing is applied) if: a knob id is never read as K["id"] in the code, a K["…"] reference has no matching knob, a file reads K[…] without importing the root knobs module through the correct relative path, or a group id never appears as data-knob-group. A card with no uiDoc yet is wrapped automatically (its current frontend becomes the preserved base — nothing is lost). Lift HIGH-VALUE constants only (theme colors, display strings, key font sizes/spacings): 3-8 groups matching the card\'s visible regions, a handful of knobs each, beats an exhaustive dump. number knobs: include unit ("em"/"px"/"rem") plus sensible min/max/step so the builder can offer a slider and the canvas drag-handle can scale them; unitless ratios (line-height) get NO unit.',
      parameters: {
        type: "object",
        properties: {
          groups: {
            type: "array",
            description: "The full decomposition — replaces existing groups. One group per visible region of the frontend.",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: 'Region id, kebab-case, used in data-knob-group="<id>" (e.g. "night").' },
                label: { type: "string", description: 'Human region name shown in the builder, in the card\'s language (e.g. "夜晚横幅").' },
                knobs: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "string", description: 'Knob id namespaced under the region with a dot: "night.title-color". The code reads K["<id>"].' },
                      label: { type: "string", description: "Human name shown beside the control (e.g. \"标题颜色\")." },
                      kind: { type: "string", enum: ["color", "text", "number"] },
                      value: { description: "Default value — EXACTLY the literal removed from the code (string for color/text, bare number for number)." },
                      min: { type: "number", description: "number knobs: slider lower bound." },
                      max: { type: "number", description: "number knobs: slider upper bound." },
                      step: { type: "number", description: "number knobs: slider step." },
                      unit: { type: "string", description: 'number knobs: the unit the CODE applies around the number ("em", "px", "rem"). Omit for unitless ratios.' },
                    },
                    required: ["id", "label", "kind", "value"],
                  },
                },
              },
              required: ["id", "label", "knobs"],
            },
          },
        },
        required: ["groups"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_ui_doc",
      description:
        'Edit the card\'s visual interface document (uiDoc) — no code; the creator can keep editing the result in the visual editor. PREFER this over write_custom_ui/edit_custom_ui for anything parts can express (load_skill "ui-doc" first for part shapes and examples; read_ui_doc for current ids). Ops run in order and apply atomically; the doc is validated against the engine schema (unknown fields, bad references and missing variables are rejected with the reason) and recompiled, so play updates immediately. A card with no document gets one (plain chat stays underneath; a hand-written frontend is kept as the base layer). Variables may be given by id or exact name. Ops: add_page{name,id?,height?,background?,copyFrom?} · update_page{page,patch} · rename_page{page,name} · remove_page{page} · set_entry_page{page} · add_part{page?,part,index?} (part without id → id minted and reported) · update_part{id,patch} (JSON merge patch: objects merge, null removes a field, arrays replace; desktop:null hides on wide screens, desktop:"same" follows the phone box) · remove_part{id} · move_part{id,to_page} · reorder{id, to:"front"|"back"|"forward"|"backward" or z} · set_theme{preset?:{id,accent?,font?,radius?}, tokens?:{"--yc-…":value|null}, fonts?, css?} · apply_look{id,look} (one-click style for a choice/field/popup/card list/button; only style fields change) · detach_to_code{} (only when the creator explicitly wants to leave the visual editor; alone in its call).',
      parameters: {
        type: "object",
        properties: {
          ops: {
            type: "array",
            items: {
              type: "object",
              properties: {
                op: { type: "string", enum: ["add_page", "update_page", "rename_page", "remove_page", "set_entry_page", "add_part", "update_part", "remove_part", "move_part", "reorder", "set_theme", "apply_look", "detach_to_code"] },
                page: { type: "string", description: "Page id or name (default: the entry page)." },
                id: { type: "string", description: "Part id (update_part/remove_part/move_part/reorder) or new page id (add_page)." },
                name: { type: "string" },
                part: { type: "object", description: "add_part: the full part JSON (type + x,y,w,h on the 375-wide phone canvas + type fields; optional desktop box on the 1024×640 canvas)." },
                patch: { type: "object", description: "update_part/update_page: JSON merge patch." },
                to_page: { type: "string" },
                to: { type: "string", enum: ["front", "back", "forward", "backward"] },
                z: { type: "number" },
                index: { type: "number" },
                height: { type: "number" },
                background: { type: "object" },
                copyFrom: { type: "string" },
                preset: { type: "object", description: "set_theme: { id, accent?, font?: sans|serif|mono|rounded, radius?: sharp|soft|round }" },
                tokens: { type: "object" },
                fonts: { type: "array", items: { type: "object" } },
                css: { type: "string" },
                look: { type: "string", description: "apply_look: a look id from read_ui_doc LOOKS (e.g. choice-glass, button-outline)." },
              },
              required: ["op"],
            },
          },
        },
        required: ["ops"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_audio",
      description:
        "Create or update an audio track (BGM, SFX, or ambient). Use @asset:{id} for uploaded audio URLs.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          type: { type: "string", enum: ["bgm", "sfx", "ambient"] },
          url: { type: "string", description: "Audio URL or @asset:{id} reference." },
          loop: { type: "boolean" },
          volume: { type: "number" },
          fadeIn: { type: "number" },
          fadeOut: { type: "number" },
          maxDuration: { type: "number", description: "Auto-stop after N seconds (useful for SFX)." },
          aiNote: { type: "string", description: "AI music pick (the editor's 「什么时候放」 / 「什么事发生时放一次」 field): one line saying when this track fits, e.g. 'tense fights and chases' / '夜里两人独处、气氛暧昧时'. A bgm/sfx track with a note joins smart tracking's pool — after each reply a decision model plays the BGM whose note fits the scene, and fires an SFX whose note matches what just happened. No note = only rules, playlists and the story model's own directives play it. Empty string removes it." },
          allowAiControl: { type: "boolean", description: "false reserves the track for behaviors/playlists/scripts: neither the story model nor smart tracking may play it (its aiNote is then ignored). Default true." },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_scene_image",
      description:
        "Create or update a scene image: a picture that appears on its own when the story reaches the moment `scene` describes (picked after the reply by default; an empty `scene` means it only appears where its [image: id] code is pasted). Use short ids like img1. url must be @asset:{id} (an uploaded picture) or an https URL — never a data: URI. The creator picks/uploads the actual picture in the editor; if you have no asset id, create the image with the scene text and leave url empty.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Short handle the AI reproduces, e.g. img1." },
          name: { type: "string" },
          url: { type: "string", description: "@asset:{id} or https URL. Empty until the creator uploads." },
          scene: { type: "string", description: "The sending CONDITION, one or two sentences. After every reply smart tracking asks, per image, whether this condition holds this turn; if it does the picture is shown (it can repeat whenever the condition holds again). So write it as a checkable condition: 'Aria first takes off her hood in front of {{user}}' — not a caption, and not 'always' unless it should appear every reply." },
          hint: { type: "string", description: "Optional teaser the player sees in the gallery before the picture is revealed." },
          greetingIds: { type: "array", items: { type: "string" }, description: "Restrict to these opening (greeting entry) ids. Empty = every opening." },
          allowAiControl: { type: "boolean", description: "false keeps it out of the AI's list (manual [image:…] use only)." },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_settings",
      description:
        "Update the card's name and one-line description, world-level generation settings, and player identity.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "The card's title as players see it in the library. Short and specific; never a template name such as 角色聊天 / 世界模拟." },
          description: { type: "string", description: "One or two sentences players read on the card before opening it: the hook, not a summary of every system." },
          maxTokens: { type: "number" },
          temperature: { type: "number" },
          playerName: { type: "string" },
          speakerBubbles: { type: "boolean", description: "The default chat splits one reply into a bubble per speaker when lines open with a character's name ('沈霏：…'). For group scenes / idol simulators." },
          replyRules: {
            type: "array",
            items: { type: "object" },
            description: "回复处理 — replaces the whole list. Rules that take tagged blocks out of the AI's reply: [{ id, name?, match: { tag: '状态' } (matches <状态>…</状态>, 【状态】…【/状态】, [状态]…[/状态]) | { pattern: 'regex, group 1 = content' }, hide?: true (the player does not see it), to?: [{ kind: 'fields' } (each 'name: value' line into the variable of that name/id) | { kind: 'variable', variableId, op?: 'set'|'append'|'push' } | { kind: 'event', name? } | { kind: 'channel', channel } (the card's interface hears it with api.onAiOutput(channel, cb))] }]. Use instead of telling the card's code to parse the reply; still tell the AI (in an entry) to write the block.",
          },
          topP: { type: "number" },
          frequencyPenalty: { type: "number" },
          presencePenalty: { type: "number" },
          topK: { type: "number" },
          minP: { type: "number" },
          lorebookScanDepth: { type: "number", description: "How many recent messages to scan for keyword triggers (default 2)." },
          lorebookRecursionDepth: {
            type: "number",
            description:
              "How many extra passes re-scan TRIGGERED entries' own text for more keywords (default 0). >0 makes lore entries trigger each other and can cascade into firing most of the lorebook every turn. Set 0 unless the card genuinely needs chained reveals.",
          },
          lorebookBudgetCap: {
            type: "number",
            description:
              "Hard ceiling (in tokens) on keyword-triggered lore injected per turn. 0 = no cap (default), meaning ALL matched entries inject — the #1 cause of runaway per-turn cost on lore-heavy cards. Set e.g. 20000-30000 as a safety ceiling.",
          },
          lorebookBudgetPercent: {
            type: "number",
            description:
              "Lore injection budget as a percent of maxContext (default 100). Lower it (e.g. 25) to bound lore as a fraction of the window. The effective ceiling is min(lorebookBudgetCap, lorebookBudgetPercent% of maxContext).",
          },
          narratorVoice: { type: "string", description: "Voice readout: the fish.audio voice id (32 hex, same catalog as write_entry.voice) narration is read in; a speaking character with no voice of its own falls to it too. Empty string removes it." },
          voiceInputMode: { type: "string", enum: ["confirm", "auto"], description: "Hold-to-talk voice input on release: 'confirm' (default) fills the input box for the player to review, 'auto' sends it as spoken. The player can override." },
          continuity: {
            type: "object",
            description: "Smart tracking (the editor's 「智能追踪」): after each reply a small decision model updates precise variables and picks music/SFX/scene images from the author's cues. Only pass the keys you change.",
            properties: {
              enabled: { type: "boolean", description: "Master switch, default true. false = no precise tracking, no AI music pick, and scene images fall back to the story model's [image: id]." },
              bgm: { type: "boolean", description: "false = BGM tracks' aiNote is ignored (default true)." },
              sfx: { type: "boolean", description: "false = SFX tracks' aiNote is ignored (default true)." },
              images: { type: "boolean", description: "false = the story model places scene images itself with [image: id] instead of the per-image condition check (default true)." },
              music: {
                type: "object",
                properties: {
                  overRules: { type: "boolean", description: "true = an AI music pick takes over even while a conditional-BGM rule is active. Default false (rules win)." },
                  once: { type: "boolean", description: "true = an AI-picked track plays once, then the default playlist resumes. Default false (loops until switched)." },
                  duck: { type: "boolean", description: "Lower BGM while an AI-picked SFX plays. Default true." },
                },
              },
            },
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_worldbook",
      description:
        "Create or update a MODULE (worldbook). The editor shows it to the creator as a 情境 (situation; older screens said knowledge base): when the creator asks for a 情境 / situation / 副本 — a place, chapter or mode that only applies at certain times (\"玩家说到阁楼时进入\") — this is the tool: make the module with its activation and put its entries inside it, NOT a single keyword entry in Core. A named, independently-activatable container. It holds entries (write_entry { worldbookId }) AND variables (write_variable { worldbookId }) AND behaviors (write_behavior { worldbookId }) AND openings (greeting entries with worldbookId). While a module is INACTIVE, its entries leave the prompt, its variables leave <game-state> (values kept), and its behaviors never fire — one activation rule gates the whole mechanic. Use one module per country/route/chapter/system so a big card stays organized and within budget; members with no worldbookId live in the always-on Core (you do NOT create a module for Core). On the Studio Blueprint canvas each module renders as a container node and your writes appear live as nodes and wires while the creator watches. If the ID exists it updates only the provided fields. See the lore skill (\"Modules — one card, many worlds\") for the two-layer gating rule.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Kebab-case worldbook ID, referenced by entry.worldbookId." },
          name: { type: "string" },
          note: {
            type: "string",
            description:
              "The module's sticky note (便签) — the shared blackboard between the creator and you. It states what this module IS and the working intent around it ('D级副本，通关后context要wipe，只留结算', 'TODO: 还缺结算行为'). READ the notes in your snapshot to understand the card's architecture before editing; WRITE/UPDATE a note when the creator explains a module's intent in chat or asks you to annotate ('把这个记在便签上'), and keep it current when your own edits change what the module is. Plain working prose, creator's language, concise (a sticky, not a spec). Pass \"\" to remove. Notes are studio-only: they NEVER enter the play prompt, so never put lore or player-facing text here.",
          },
          enabled: { type: "boolean", description: "Master on/off. false = never active regardless of activation mode. Default true." },
          frontendFile: {
            type: "string",
            description:
              "The file in rootComponent.files that is this module's scene — what the interface shows while the module is on (e.g. 'scenes/mine.tsx'). Tooling only: the entry file must itself route to that scene (typically by the same variable the module's activation reads), so setting this never changes play. Pass \"\" to unset.",
          },
          host: {
            type: "string",
            description:
              "Only with a station: WHERE THIS AI LIVES — how the creator adds an AI now. \"card\" = on the card itself: it answers after the narrator every turn (two voices = a group chat). A situation's id = in that situation: while it is on, the AIs living there answer the player one after another INSTEAD of the narrator (one AI = it takes over there; two or more = a group chat). \"unplaced\" = not put anywhere, so off. Its own activation is ignored once it has a host; give it {mode:'always'}. Omit for the older shape (a situation that is itself an AI and decides by its own activation). \"\" removes it.",
          },
          narratorHere: {
            type: "boolean",
            description: "On a SITUATION whose AIs answer the player: true keeps the card's own narrator talking there too, first, as one more voice of the group.",
          },
          station: {
            type: "object",
            description:
              "模块总控 — makes this module an AI STATION rather than a plain content module. OMIT for the normal case: a module without a station just contributes its entries and variables to whoever is narrating, which is what almost every module should be. Set it when the card needs SEVERAL AIs cooperating: one narrator per dungeon so each only knows its own context, plus background workers that read one module and brief another. Pass null to turn a station back into a plain module.",
            properties: {
              kind: {
                type: "string",
                enum: ["narrator", "worker", "custom"],
                description:
                  "narrator = while this module is active, ITS AI answers the player (its own model, its own context inputs). At most one narrator is active at a time; ties break by order. worker = never speaks to the player; runs when triggered and its written output becomes context other modules can drink. A '总结模块/史官' is a worker.",
              },
              model: {
                type: "string",
                description:
                  "Model id for this station's turns (e.g. a cheap fast one for a chronicler). Omit to follow the player's own choice. It is a REQUEST: a player who cannot run it falls back to their own model, so this can never make a card unplayable.",
              },
              inputs: {
                type: "array",
                description:
                  "What context flows INTO this station, in injection order. This is the wiring the creator sees as lines on the canvas. Omit or [] for a station that only knows its own module. Ignored by a worker with trigger { on: \"ui\" } (it sees what sees/variables/history give it) or { on: \"quiet\" } (it reads the story itself) — do not wire those.",
                items: {
                  type: "object",
                  properties: {
                    kind: {
                      type: "string",
                      enum: ["memory", "worker", "variables", "transcript"],
                      description:
                        "memory = the source module's ARCHIVED past runs (cheap, the default choice). worker = a worker module's written outputs. variables = a snapshot of the source module's variables, by name. transcript = the source module's raw messages (honest but expensive; requires limit, max 40).",
                    },
                    from: { type: "string", description: "Source module id. Only kind 'variables' may use \"core\" for the card's own variables." },
                    as: {
                      type: "string",
                      enum: ["history", "lore"],
                      description:
                        "history (default) = the protagonist lived this. lore = an archive or hearsay ABOUT it. A chronicler's briefing to a stranger is usually lore; carrying your own memories from dungeon 1 into dungeon 2 is history.",
                    },
                    limit: { type: "number", description: "Most-recent N items (memory/worker: default 5, max 20; transcript: required, max 40)." },
                  },
                  required: ["kind", "from"],
                },
              },
              onClose: {
                type: "string",
                enum: ["archive", "keep"],
                description:
                  "narrator only. archive (DEFAULT) = when this module deactivates, its span leaves the AI's context and becomes one auto-generated summary, while the player's transcript keeps every word; re-activation starts a clean run. This IS 副本模式 — it is a property of being a narrator station, not a separate switch. keep = the span stays in context.",
              },
              archivePrompt: {
                type: "string",
                description: "Extra instruction for the archive summariser, in the card's language ('务必记录死因、拿到的线索和欠下的人情').",
              },
              memoryPool: {
                type: "string",
                description:
                  "narrator only — which memory this AI shares. Omit for the card's own memory (the whole conversation, the default). Name a pool and every narrator naming the same pool remembers each other's runs and nothing spoken outside them: 'A and B share one memory, C and D another' is two names (e.g. 'pool-ab', 'pool-cd'). A name nobody else uses is the tower — an AI that has never heard of the town. Messages never leave the transcript; the card's own narrator still sees everything.",
              },
              trigger: {
                type: "object",
                description:
                  "worker only — when it runs. Omit and it never runs on its own. { on: 'module-closed', from: '<module id>' } is the usual one: a dungeon ends, this reads it and writes for the next module. Also { on: 'turns', every: N }, { on: 'conditions', conditions: [...] } (rising edge only), { on: 'after', from: '<module id>' } (right after that module's AI has answered the player — a recorder of one character's replies), and { on: 'quiet', seconds: N } (15–3600): while its module is active and nothing has happened for N seconds, it may step into the story itself with a line of narration and value directives, or answer [silent]. Use 'quiet' for anything the card says happens over time ('every moment you stay, the corrosion rises'). { on: 'ui' }: the player's screen calls it (a button whose step is run-ai, or api.callAi(id) in card code); it answers into the story like a quiet one.",
                properties: {
                  on: { type: "string", enum: ["module-closed", "conditions", "turns", "after", "quiet", "ui"] },
                  from: { type: "string", description: "For 'module-closed': the module whose close wakes this worker. For 'after': the module whose AI answering wakes it." },
                  every: { type: "number", description: "For 'turns': run every N turns (1-100)." },
                  seconds: { type: "number", description: "For 'quiet': seconds of nothing happening before it may speak (15-3600)." },
                  conditions: { type: "array", description: "For 'conditions': the same condition shape used everywhere else.", items: { type: "object" } },
                },
                required: ["on"],
              },
              task: {
                type: "string",
                description:
                  "worker only — the job, in the card's language. The module's own ENTRIES are who it is; this is what it does this time ('把刚打完的这一轮压成三行，只留因果和人情'). A worker with no task never runs.",
              },
              name: {
                type: "string",
                description: "What the creator calls this AI on the canvas, in the card's language ('老板娘', '记录'). Display only; omit and the module's name stands in.",
              },
              sees: {
                type: "object",
                description: "Custom AI (自定义): what it is shown besides the card's always-sent lore and its own entries. { variables: [variable ids], history: N recent chat messages (0-60), ownThread: true to remember its own past calls and answers (one thread per AI — a phone contact, a character) }.",
              },
              pieces: {
                type: "array",
                items: { type: "object" },
                description: "Custom AI: prompt pieces added only while their conditions hold: [{ conditions: [same condition shape as everywhere], conditionLogic?: 'all'|'any', text: '好感度高时语气更亲近' }].",
              },
              output: {
                type: "array",
                items: { type: "object" },
                description: "Custom AI: the answer's fields. Omit for plain text. Each { name, type: 'text'|'number'|'choice'|'list', options?: [allowed answers — use these for legal moves/items], min?, max?, hint?, to?: { kind: 'say' } (these are its spoken words) | { kind: 'variable', variableId, op?: 'set'|'add'|'push' } | { kind: 'event', name? } }. The runner asks for JSON, validates, retries, clamps numbers and rejects choices outside options.",
              },
              say: {
                type: "string",
                description: "Custom AI: where its words go — 'story' (a chat message, default), 'none' (only returned to the card), or a channel name the card's interface listens to with api.onAiOutput(channel, cb) (a phone thread, a forum, a bubble).",
              },
              onError: {
                type: "object",
                description: "Custom AI: { timeoutSec (5-120, default 25), retries (0-3, default 1), fallback: [lines, one picked at random when every try failed], randomChoice?: true (when every try failed, still answer: a random allowed option per choice field — an AI opponent always makes a legal move) }.",
              },
              cooldownSec: { type: "number", description: "Custom AI: seconds before it may be called again." },
              maxTokens: { type: "number", description: "Custom AI: most tokens one answer may take (default 800)." },
            },
            required: ["kind"],
          },
          order: { type: "number", description: "Sort order in the editor (default 0)." },
          color: { type: "string", description: "Optional editor color tag (hex or token)." },
          activation: {
            type: "object",
            description:
              "When this book is online. Five modes: 'always' (always on, like Core); 'conditions' (online while variable conditions pass — e.g. route=='mayu'); 'greeting' (online only when the player started on one of the listed openings); 'keywords' (switched on when the player says one of the words, and it STAYS on — a door, e.g. a dungeon entered by saying 「传送·医院」; exclusive:true closes the other exclusive keyword books when this one opens, which is how 'walk out of dungeon A into dungeon B' works); 'manual' (no rule; the card's frontend turns it on and off).",
            properties: {
              mode: { type: "string", enum: ["always", "conditions", "greeting", "keywords", "manual"] },
              keywords: { type: "array", items: { type: "string" }, description: "For mode 'keywords': the words that open this book." },
              exclusive: { type: "boolean", description: "For mode 'keywords': opening this book closes the other exclusive keyword books." },
              leaveKeywords: { type: "array", items: { type: "string" }, description: "For mode 'keywords': words that close this book again when the player says them while inside (e.g. 后仓 → ['回店里','出去']). Give a way out whenever the player can walk back." },
              conditions: { type: "array", items: { type: "object", properties: { variableId: { type: "string" }, operator: { type: "string" }, value: {} } }, description: "For mode 'conditions'." },
              conditionLogic: { type: "string", enum: ["all", "any"] },
              greetingIds: { type: "array", items: { type: "string" }, description: "For mode 'greeting': the greeting (opening) entry IDs that activate this book." },
            },
          },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_lore_binding",
      description:
        "Bind a frontend lore control to an entry: while a <LoreSlot id=slotId> / <LoreButton slotId=...> in the rootComponent TSX is active (mounted/toggled by the PLAYER), the bound entry becomes eligible for AI injection. Use for player-controlled lore (a \"show advanced rules\" toggle, a codex chip). Write the <LoreButton>/<LoreSlot> in TSX via write_custom_ui (see front-ui skill); this tool wires the slotId → entryId binding. Upserts by slotId.",
      parameters: {
        type: "object",
        properties: {
          slotId: { type: "string", description: "Slot id used in the TSX (<LoreSlot id> / <LoreButton slotId>). This is the binding key." },
          entryId: { type: "string", description: "ID of the entry that activates when this slot is active." },
          conditions: { type: "array", items: { type: "object", properties: { variableId: { type: "string" }, operator: { type: "string" }, value: {} } }, description: "Optional extra state conditions that must ALSO pass for the binding to activate." },
          conditionLogic: { type: "string", enum: ["all", "any"] },
        },
        required: ["slotId", "entryId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_entities",
      description:
        "Delete one or more entities by ID. Each ID is looked up across all entity types (entries, variables, behaviors, rules, customUI, audio, scene images, worldbooks, lore bindings). Always requires user approval.",
      parameters: {
        type: "object",
        properties: {
          ids: {
            type: "array",
            items: { type: "string" },
            description: "Entity IDs to delete.",
          },
        },
        required: ["ids"],
      },
    },
  },
];

// ── Control Tools (yield to user) ──
// Control tools don't read or mutate the world — they change run flow.
// `ask_user` ends the run in "awaiting_user" status so the user can reply.

const CONTROL_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "playtest",
      description:
        "Play the card yourself, the way a player does, to check that what you built works and reads well. Give 1-10 moves: exactly what a player would type, in the card's language. Each move goes through the real game (the card's own model replies, variables change, behaviors fire, lore is pulled in) in a fresh throwaway session that starts from the card's opening, and the creator watches it live in the playtest panel. You get back every reply with its variable changes, behaviors fired, notifications and lore used. Use it after building or changing something a player will feel; if a turn shows a problem, fix it and play again. You can only type: buttons and screens in the card's interface cannot be clicked here. Costs what the same turns cost a player. Call it alone.",
      parameters: {
        type: "object",
        properties: {
          moves: {
            type: "array",
            items: { type: "string" },
            description: "1-10 player messages, in order, written as a real player would type them.",
          },
          purpose: {
            type: "string",
            description: "What you are checking, in a few words in the creator's language (shown on the playtest panel).",
          },
        },
        required: ["moves"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "digest_source",
      description:
        "Read a whole source text attached to this card (a novel) and turn it into a canon reference (原著资料库): plot by arc with end-of-arc snapshots and entry points, character profiles with how they speak and when secrets are revealed, factions, world and terms, a timeline and a style guide — quotes checked against the book, contradictions checked against it too. It is stored with the card as one more source, which you then read with read_source like the book itself. Use it when the creator wants a card built from a long book and the card has no digest of it yet (sources ending in ·原著资料库.md are digests). The first call does not run it: the platform shows the creator the time and cost; when they start it, call digest_source again and it runs (many minutes; progress shows in the panel). Call it alone. Afterwards, read the parts of the reference you need before writing, and search the book for details.",
      parameters: {
        type: "object",
        properties: {
          source_id: { type: "string", description: "The source to digest (id from the Source texts list)." },
        },
        required: ["source_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_job",
      description:
        "Before a BIG piece of work, say how you will do it and let the creator start it. Big means building something across several parts of the card (a new opening flow, a character roster, a system with variables + behaviors + interface, a whole new card). When what you build is something a player will feel, end the plan with playing it yourself (the playtest tool) and fixing what you find. NOT for a small edit (rewrite one entry, add one variable, change a colour): just do those. Call it alone, with 3-7 short plan lines in the creator's language, written for the creator (what they will get, not tool names). The platform adds the time and cost and shows Start; when the creator starts it you will get the go-ahead and should then do the whole job without stopping to ask.",
      parameters: {
        type: "object",
        properties: {
          plan: {
            type: "array",
            items: { type: "string" },
            description: "3-7 short lines, each one thing the creator will get, in the creator's language.",
          },
          steps: {
            type: "number",
            description: "How many working steps you expect (each roughly one round of writing), including any playtesting.",
          },
        },
        required: ["plan"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_user",
      description:
        "Ask the user a clarifying question and yield control back to them. Call this INSTEAD OF ending your turn with a question in plain text — otherwise the run has no way to pause and the user can't answer. Use when you need a human decision (direction, scope, taste, destructive-action confirmation). MUST NOT be combined with any other tool call in the same turn.",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "The question to show the user. Include any options inline as a short list.",
          },
          rationale: {
            type: "string",
            description: "Optional one-line reason for asking instead of proceeding on your own.",
          },
        },
        required: ["question"],
      },
    },
  },
  generateImageTool(null),
  {
    type: "function",
    function: {
      name: "generate_images",
      description:
        "Prepare one batch of independently described images for ONE creator confirmation. Use for multiple characters, scenes, or freeform requests such as '10 women with different hair colors'. Write one item and distinct English prompt per requested output; these are separate pictures, not a collage or variations of a single prompt. No images are generated or billed before confirmation; assistant preparation still has its normal cost. Default to the least expensive suitable model. Omit target to save in the asset library. For character portraits use an existing entry_portrait target, or first wire custom UI once to the managed characterImages module and use component_image targets. Existing pictures are skipped. The backend generates, saves and binds the entire confirmed batch without calling you per image. Call this tool ALONE and end the turn; do not launch generate_image repeatedly or ask the creator to return for every picture. Maximum 30 images per batch; for a larger request clarify the first batch size rather than silently dropping items. Batches always use the smart models below; a platform base model (generate_image custom mode) is single-image only.",
      parameters: {
        type: "object",
        properties: {
          purpose: { type: "string", description: "Brief batch label in the creator's language." },
          model: { type: "string", enum: IMAGE_TOOL_MODELS.map(model => model.id),
            description: IMAGE_TOOL_MODELS.map(model => model.line).join("\n") + `\nDefault ${SMART_IMAGE_MODEL}.` },
          modelReason: { type: "string", description: "Brief reason for the selected model in the creator's language." },
          aspectRatio: { type: "string", enum: [...IMAGE_TOOL_CAPABILITIES.aspectRatios] },
          resolution: { type: "string", enum: [...IMAGE_TOOL_CAPABILITIES.resolutions] },
          items: {
            type: "array", minItems: 1, maxItems: MAX_IMAGE_BATCH_ITEMS,
            items: {
              type: "object", properties: {
                id: { type: "string", description: "Unique stable ID using letters, digits, hyphens or underscores; at most 80 characters." },
                label: { type: "string", description: "Short name shown on the confirmation card, e.g. 'Red hair' or 'Alice'." },
                prompt: { type: "string", maxLength: 2000, description: "Complete visual description for THIS picture, with the intended variation explicitly specified." },
                target: { type: "object", properties: {
                  kind: { type: "string", enum: ["entry_portrait", "component_image"] },
                  entryId: { type: "string", description: "Existing character entry ID, for entry_portrait." },
                  key: { type: "string", description: "Existing key in _generated/character-images.tsx, for component_image." },
                }, required: ["kind"] },
              }, required: ["id", "label", "prompt"],
            },
          },
        },
        required: ["items"],
      },
    },
  },
];

// ── Combined & Sets ──

export const STUDIO_TOOLS: ToolDefinition[] = [...READ_TOOLS, ...WRITE_TOOLS, ...CONTROL_TOOLS];

// save_brief (the advisor's, lib/studio-advisor.ts) auto-executes like a read: it writes no card data.
export const READ_TOOL_NAMES = new Set([...READ_TOOLS.map((t) => t.function.name), "save_brief"]);
// Note: load_skill is in READ_TOOLS (auto-executes) but NOT in WRITE_TOOLS
export const WRITE_TOOL_NAMES = new Set(WRITE_TOOLS.map((t) => t.function.name));
export const CONTROL_TOOL_NAMES = new Set(CONTROL_TOOLS.map((t) => t.function.name));
