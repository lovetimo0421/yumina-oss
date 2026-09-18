import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ── Skill Loading ──

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// In dev: __dirname is src/lib/studio-skills/ → go up 3 levels to packages/server/skills/
// In prod (tsup bundle): __dirname is dist/ → go up 1 level to packages/server/skills/
const SKILLS_DIR = fs.existsSync(path.resolve(__dirname, "../../../skills"))
  ? path.resolve(__dirname, "../../../skills")
  : path.resolve(__dirname, "../skills");

/** Parsed skill: metadata (always loaded) + content (loaded on demand via load_skill) */
interface SkillEntry {
  name: string;
  description: string;
  /** Full SKILL.md content (body after frontmatter) */
  content: string;
}

const skillCache = new Map<string, SkillEntry>();
let templateCatalog: TemplateCatalogEntry[] = [];

interface TemplateCatalogEntry {
  id: string;
  path: string;
  type: "renderer" | "component" | "world" | "pattern";
  name: string;
  description: string;
  tags: string[];
}

/**
 * Parse YAML frontmatter from a skill file.
 * Returns { name, description, content } where content is the body after frontmatter.
 */
function parseFrontmatter(raw: string, fallbackName: string): SkillEntry {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith("---")) {
    // No frontmatter — use the full content as body, derive description from first paragraph
    const firstParagraph = raw.split("\n\n")[1]?.trim().slice(0, 200) ?? "";
    return { name: fallbackName, description: firstParagraph, content: raw };
  }

  const endIdx = trimmed.indexOf("---", 3);
  if (endIdx === -1) {
    return { name: fallbackName, description: "", content: raw };
  }

  const frontmatter = trimmed.slice(3, endIdx).trim();
  const content = trimmed.slice(endIdx + 3).trim();

  // Simple YAML key: value parser (no nested structures needed)
  let name = fallbackName;
  let description = "";
  for (const line of frontmatter.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key === "name") name = value;
    if (key === "description") description = value;
  }

  return { name, description, content };
}

/**
 * Load skills from disk. Supports two layouts:
 *   - Directory-based: skills/<name>/SKILL.md  (preferred)
 *   - Flat fallback:   skills/<name>.md         (legacy compat)
 *
 * Parses YAML frontmatter for metadata (name, description).
 * Also loads _catalog.json if present (template index).
 */
function loadSkills() {
  try {
    for (const entry of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith("_")) {
        // Directory-based skill: read <name>/SKILL.md
        const skillFile = path.join(SKILLS_DIR, entry.name, "SKILL.md");
        if (fs.existsSync(skillFile)) {
          const raw = fs.readFileSync(skillFile, "utf-8");
          skillCache.set(entry.name, parseFrontmatter(raw, entry.name));
        }
      } else if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "GUIDELINES.md") {
        // Flat fallback: read <name>.md (only if no directory version exists)
        const name = entry.name.replace(".md", "");
        if (!skillCache.has(name)) {
          const raw = fs.readFileSync(path.join(SKILLS_DIR, entry.name), "utf-8");
          skillCache.set(name, parseFrontmatter(raw, name));
        }
      }
    }

    // Load template catalog
    const catalogPath = path.join(SKILLS_DIR, "_catalog.json");
    if (fs.existsSync(catalogPath)) {
      const raw = fs.readFileSync(catalogPath, "utf-8");
      const parsed = JSON.parse(raw);
      templateCatalog = parsed.templates ?? [];
    }
  } catch {
    console.warn("Studio skills directory not found at", SKILLS_DIR);
  }
}
loadSkills();

// ── Skill Metadata (for system prompt — always loaded, compact) ──

/**
 * Get all skill metadata for the system prompt.
 * Compact format: "name — keywords" (~100 tokens total for all skills).
 * Full content loaded on demand via load_skill tool.
 */
export function getSkillMetadataSummary(): string {
  if (skillCache.size === 0) return "";

  const lines: string[] = [];
  for (const [name, skill] of skillCache) {
    lines.push(`- ${name}: ${skill.description}`);
  }
  return lines.join("\n");
}

/**
 * Get available skill names (for the load_skill tool enum).
 */
export function getSkillNames(): string[] {
  return Array.from(skillCache.keys());
}

// ── Skill Content (all skills pre-loaded into system prompt) ──

/** Get all skill content concatenated as XML sections. Cached with 1h TTL on system prompt breakpoint. */
export function getAllSkillContent(): string {
  if (skillCache.size === 0) return "";
  const sections: string[] = [];
  for (const [name, skill] of skillCache) {
    sections.push(`<skill name="${name}">\n${skill.content}\n</skill>`);
  }
  return sections.join("\n\n");
}

// ── Hybrid Skill Loading (V2) ──

/** Skills always loaded in the system prompt (used in 90%+ of requests).
 *  world-design holds compositional patterns (stat system, relationships, combat, choice branching,
 *  inventory, time cycles) that the agent reaches for whenever a request spans multiple entities —
 *  keep it in the cached prefix so pattern lookup costs nothing per iteration.
 *  rules is here because behaviors are the single most common write operation a non-trivial world
 *  needs; paying ~2.5K cached tokens is cheaper than an extra load_skill round-trip on every
 *  behavior-building conversation. */
const ALWAYS_LOAD_SKILLS = new Set(["entries", "variables", "tsx", "front-ui", "world-design", "rules"]);

/**
 * Get core skills (entries + variables) that are always in the system prompt,
 * plus a catalog of on-demand skills the model can load via load_skill.
 *
 * Returns: { coreSkills: string, onDemandCatalog: string }
 */
export function getHybridSkillContent(): { coreSkills: string; onDemandCatalog: string } {
  const coreSections: string[] = [];
  const onDemandLines: string[] = [];

  for (const [name, skill] of skillCache) {
    if (ALWAYS_LOAD_SKILLS.has(name)) {
      coreSections.push(`<skill name="${name}">\n${skill.content}\n</skill>`);
    } else {
      onDemandLines.push(`- ${name}: ${skill.description}`);
    }
  }

  return {
    coreSkills: coreSections.join("\n\n"),
    onDemandCatalog: onDemandLines.length > 0
      ? `Available skills (call load_skill to get full instructions before using):\n${onDemandLines.join("\n")}`
      : "",
  };
}

// ── Skill Selector (utility for future use when skills grow larger) ──

const PANEL_MAP: Record<string, string[]> = {
  lorebook: ["lore", "entries"],
  entries: ["entries"],
  canvas: ["front-ui", "tsx"],
  "code-view": ["front-ui", "tsx"],
  variables: ["variables"],
  rules: ["rules"],
  audio: ["audio"],
  "first-message": ["entries"],
};

// Ordered by priority for keyword-only selection (no panel)
const KEYWORD_MAP: [string, RegExp][] = [
  ["slim", /精简|冗余|冗杂|臃肿|瘦身|去重|太[大长]了|\b(slim|bloat\w*|redundan\w*|dedup\w*|token\s*(cost|usage)|too\s+(big|long|heavy))\b/i],
  ["lore", /\b(lore|worldbuilding|faction|timeline|history|canon|codif\w*|discoverable)\b/i],
  ["front-ui", /\b(hud|dashboard|layout|theme|widget|full.?screen|header|sidebar)\b|\bui\b/i],
  ["tsx", /\b(tsx|jsx|react|renderer|component|code|interactive|visual|custom\s*ui)\b/i],
  ["entries", /\b(character|entry|entries|npc|persona|lorebook|greeting|scenario|example\s*dialogue|system\s*prompt)\b/i],
  ["variables", /\b(variable|stat|hp|health|gold|inventory|score|flag|counter|track|behavior.?rule)\b/i],
  ["rules", /\b(behavior|reaction|trigger|rule|automation|event|when.*then|conditional|mechanic|timer)\b/i],
  ["audio", /\b(audio|music|bgm|sfx|sound|ambient|track)\b/i],
];

/**
 * Select up to 3 relevant skills based on active panel and user message.
 * Used by tests and available for future selective injection if skills grow larger.
 */
export function selectSkills(panel?: string, userMessage?: string): string[] {
  // Panel-based selection (strong signal — sufficient on its own)
  if (panel && PANEL_MAP[panel]) {
    return [...PANEL_MAP[panel]];
  }

  // No panel — keyword-based selection from user message
  if (!userMessage) return [];

  const selected: string[] = [];
  const seen = new Set<string>();
  for (const [skill, pattern] of KEYWORD_MAP) {
    if (selected.length >= 3) break;
    if (!seen.has(skill) && pattern.test(userMessage)) {
      seen.add(skill);
      selected.push(skill);
    }
  }

  return selected;
}

// ── Template Catalog ──

/** Get the template catalog summary for the system prompt. */
export function getTemplateCatalogSummary(): string {
  if (templateCatalog.length === 0) return "";

  const lines = templateCatalog.map(
    (t) => `  - ${t.id} (${t.type}): ${t.name} — ${t.description} [${t.tags.join(", ")}]`
  );
  return `\n## Available Templates (${templateCatalog.length})\n${lines.join("\n")}\nUse these as starting points. Use list_templates to explore before installing.`;
}

/** Read a template file by catalog ID. Returns the file content or null. */
export function readTemplateContent(templateId: string): string | null {
  const entry = templateCatalog.find((t) => t.id === templateId);
  if (!entry) return null;

  const templateDir = path.join(SKILLS_DIR, entry.path);

  // Try reading the main artifact
  for (const filename of ["renderer.tsx", "component.tsx", "template.json"]) {
    const filePath = path.join(templateDir, filename);
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, "utf-8");
    }
  }

  return null;
}

/** Read template metadata by catalog ID. */
export function readTemplateMeta(templateId: string): Record<string, unknown> | null {
  const entry = templateCatalog.find((t) => t.id === templateId);
  if (!entry) return null;

  const metaPath = path.join(SKILLS_DIR, entry.path, "meta.json");
  if (!fs.existsSync(metaPath)) return null;

  try {
    return JSON.parse(fs.readFileSync(metaPath, "utf-8"));
  } catch {
    return null;
  }
}

// ── Skill Content Access ──

/** Get the full content of a skill by name (for load_skill tool). Returns null if not found. */
export function getSkillContent(skillName: string): string | undefined {
  return skillCache.get(skillName)?.content;
}
