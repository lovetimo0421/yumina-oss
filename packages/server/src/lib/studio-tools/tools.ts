import { getSmartImageCapabilities, SMART_IMAGE_MODEL, SMART_IMAGE_MODELS,
  SMART_IMAGE_ASPECTS, SMART_IMAGE_RESOLUTIONS } from "@yumina/shared";
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
        "Load detailed domain knowledge for a specific topic. Call this BEFORE writing audio tracks or lore-heavy content — these domains have specific conventions not covered by tool definitions alone. Core skills (entries, variables, tsx, front-ui, world-design, rules) are already in your context.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: 'Skill name: "audio" (audio tracks) or "lore" (advanced worldbuilding: codeification, layered faction systems, multiplayer canon). Core skills (entries, variables, tsx, front-ui, world-design, rules) are already loaded — do not reload them.',
          },
        },
        required: ["name"],
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
          role: { type: "string", enum: ["system", "character", "personality", "scenario", "lore", "plot", "style", "example", "greeting", "custom"] },
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
            description: "Event pattern: { eventType: 'turn:complete'|'message:user'|'message:ai'|'session:start'|'state:changed'|'state:crossed'|'action:fired'|'audio:track-ended'|'spatial:zone-enter'|'spatial:zone-leave'|'spatial:proximity-enter'|'spatial:interact'|'spatial:proximity-leave'|'spatial:scene-change'|'spatial:exit-overlap', match?: { field: { operator, value } } }",
          },
          conditions: { type: "array", items: { type: "object", properties: { variableId: { type: "string" }, operator: { type: "string" }, value: {} } }, description: "State conditions: [{ variableId, operator, value }]" },
          conditionLogic: { type: "string", enum: ["all", "any"] },
          then: {
            type: "array",
            items: { type: "object", properties: { type: { type: "string" }, path: { type: "string" }, value: {}, operation: { type: "string" }, valueRef: { type: "string" }, valueRandom: { type: "object" } } },
            description: "Effects: [{ type:'set', path:'variableId', value:..., operation:'set'|'add'|'subtract'|'multiply'|'toggle'|'append' }]. The value can be a literal, valueRef (another variable's value), or valueRandom (a random draw resolved at fire time): { kind:'range', min, max, integer? } | { kind:'dice', count, sides, modifier? } | { kind:'list', candidates:[...], weights?:[...], cooldown?:N, historyVar?:'var', onExhausted?:'full'|'keep' }. For a list draw the operation must be 'set'. Also: { type:'emit', event:{ type:'ui:notification', message:'...' } }. System paths: '@vars.enabled.<variableId>' with a boolean value toggles that variable's enable gate (see write_variable activation).",
          },
          priority: { type: "number" },
          enabled: { type: "boolean" },
          cooldownTurns: { type: "number" },
          maxFireCount: { type: "number" },
          chance: { type: "number", description: "0-100: probability this behavior fires when it otherwise would. Omit/100 = always. Use for 'sometimes it happens' random events." },
          description: { type: "string" },
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
        "Update world-level generation settings and player identity.",
      parameters: {
        type: "object",
        properties: {
          maxTokens: { type: "number" },
          temperature: { type: "number" },
          playerName: { type: "string" },
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
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_worldbook",
      description:
        "Create or update a worldbook (the editor calls it a \"knowledge base\") — a named, independently-activatable group of entries. Only ACTIVE worldbooks' entries reach the AI, so one card can hold multiple routes/scenarios/chapters within budget. Assign entries to it with write_entry { worldbookId }; entries with no worldbookId live in the always-on Core book (you do NOT create a worldbook for Core). If the ID exists it updates only the provided fields. See the lore skill (\"Worldbooks — one card, many routes\") for the two-layer gating rule.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Kebab-case worldbook ID, referenced by entry.worldbookId." },
          name: { type: "string" },
          enabled: { type: "boolean", description: "Master on/off. false = never active regardless of activation mode. Default true." },
          order: { type: "number", description: "Sort order in the editor (default 0)." },
          color: { type: "string", description: "Optional editor color tag (hex or token)." },
          activation: {
            type: "object",
            description:
              "When this book is online. Only THREE modes exist: 'always' (always on, like Core); 'conditions' (online while variable conditions pass — e.g. route=='mayu'); 'greeting' (online only when the player started on one of the listed openings).",
            properties: {
              mode: { type: "string", enum: ["always", "conditions", "greeting"] },
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
        "Delete one or more entities by ID. Each ID is looked up across all entity types (entries, variables, behaviors, rules, customUI, audio, worldbooks, lore bindings). Always requires user approval.",
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
  {
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
  },
];

// ── Combined & Sets ──

export const STUDIO_TOOLS: ToolDefinition[] = [...READ_TOOLS, ...WRITE_TOOLS, ...CONTROL_TOOLS];

export const READ_TOOL_NAMES = new Set(READ_TOOLS.map((t) => t.function.name));
// Note: load_skill is in READ_TOOLS (auto-executes) but NOT in WRITE_TOOLS
export const WRITE_TOOL_NAMES = new Set(WRITE_TOOLS.map((t) => t.function.name));
export const CONTROL_TOOL_NAMES = new Set(CONTROL_TOOLS.map((t) => t.function.name));
