// ─── Anime Battle UI Renderer ───
// Message renderer with character avatar detection, battle state indicators, scene transitions,
// and interactive choice/technique selection. Pattern from production anime RPG world.
//
// KEY PATTERN: Asset Manifest
// Define all character avatars, portraits, and scene images in one manifest object.
// The AI mentions character names in its text → this renderer detects the speaker
// and shows their avatar/portrait. No need for special markers — just name matching.
//
// AI Content Markers:
//   [SCENE:domain-expansion]  → triggers full-width scene image
//   <options>A|B|C</options>  → parsed as interactive choice buttons
//   <technique>Name</technique> → highlighted technique display
//
// Required variables:
//   hp (number), level (number), cursed-energy (number)
//   battle-state (string) — "normal" | "combat" | "domain-expansion"
//   scene-character (string) — ID of currently featured character
//   relationships (json) — array of { name, affinity, title }

export default function AnimeBattleRenderer({ content, role, messageIndex, variables, renderMarkdown }) {
  var api = useYumina();

  // ─── ASSET MANIFEST ───
  // Centralize all character assets here. Use @asset:ID for uploaded images.
  // The renderer looks up avatars by character ID when it detects their name in text.
  var MANIFEST = {
    avatars: {
      protagonist: null,  // @asset:ID — small circular avatar
      rival: null,
      mentor: null,
      villain: null
    },
    portraits: {
      protagonist: null,  // @asset:ID — larger portrait for featured scenes
      rival: null,
      mentor: null,
      villain: null
    },
    scenes: {
      "major-entrance": null,    // @asset:ID — full-width scene images
      "domain-expansion": null,
      "battle-aftermath": null
    }
  };

  // ─── CHARACTER METADATA ───
  // name: display name, color: accent color, aliases: alternate names AI might use
  var CHARACTERS = {
    protagonist: { name: "Hero", color: "#f472b6", aliases: ["hero", "mc", "protagonist"] },
    rival: { name: "Rival", color: "#818cf8", aliases: ["rival"] },
    mentor: { name: "Mentor", color: "#60a5fa", aliases: ["mentor", "sensei", "teacher"] },
    villain: { name: "Villain", color: "#ef4444", aliases: ["villain", "enemy", "boss"] }
  };

  // Build alias → ID lookup (runs once, no perf concern)
  var ALIAS_MAP = {};
  Object.keys(CHARACTERS).forEach(function(id) {
    var meta = CHARACTERS[id];
    ALIAS_MAP[id] = id;
    ALIAS_MAP[meta.name.toLowerCase()] = id;
    meta.aliases.forEach(function(a) { ALIAS_MAP[a.toLowerCase()] = id; });
  });

  // ─── USER MESSAGES ───
  if (role === "user") {
    return React.createElement("div", { className: "text-foreground" }, content);
  }

  // ─── DETECT SPEAKER FROM FIRST LINE ───
  // Tries to find a character name in the opening of the AI response
  var detectedSpeaker = null;
  var firstLine = content.split("\n")[0] || "";
  var nameMatch = firstLine.match(/^\*?\*?([^*:]+?)\*?\*?\s*[:：]/);
  if (nameMatch) {
    var candidate = nameMatch[1].toLowerCase().trim();
    if (ALIAS_MAP[candidate]) detectedSpeaker = ALIAS_MAP[candidate];
  }

  var speakerMeta = detectedSpeaker ? CHARACTERS[detectedSpeaker] : null;
  var avatarUrl = detectedSpeaker ? MANIFEST.avatars[detectedSpeaker] : null;

  // ─── PARSE SCENE MARKERS ───
  var sceneMatch = content.match(/\[SCENE:([^\]]+)\]/);
  var sceneId = sceneMatch ? sceneMatch[1].trim() : null;
  var sceneUrl = sceneId ? MANIFEST.scenes[sceneId] : null;

  // ─── PARSE CHOICES (XML-style) ───
  var choices = [];
  var optionsMatch = content.match(/<options>([\s\S]*?)<\/options>/);
  if (optionsMatch) {
    choices = optionsMatch[1].split("|").map(function(c) { return c.trim(); }).filter(Boolean);
  }

  // ─── PARSE TECHNIQUE HIGHLIGHTS ───
  var techniqueMatch = content.match(/<technique>([\s\S]*?)<\/technique>/);
  var technique = techniqueMatch ? techniqueMatch[1].trim() : null;

  // ─── STRIP MARKERS FROM DISPLAY TEXT ───
  var displayContent = content
    .replace(/\[SCENE:[^\]]+\]\s*/g, "")
    .replace(/<options>[\s\S]*?<\/options>/g, "")
    .replace(/<technique>[\s\S]*?<\/technique>/g, "");

  // ─── READ VARIABLES ───
  var hp = typeof variables.hp === "number" ? variables.hp : 100;
  var level = typeof variables.level === "number" ? variables.level : 1;
  var energy = typeof variables["cursed-energy"] === "number" ? variables["cursed-energy"] : 100;
  var battleState = variables["battle-state"] || "normal";
  var isInCombat = battleState === "combat" || battleState === "domain-expansion";

  return (
    <div>
      {/* Scene Image (full-width, cinematic) */}
      {sceneUrl && (
        <div style={{
          width: "100%", height: 200, marginBottom: 12, borderRadius: 8, overflow: "hidden",
          backgroundImage: "url(" + sceneUrl + ")", backgroundSize: "cover", backgroundPosition: "center",
          boxShadow: "0 4px 20px rgba(0,0,0,0.4)"
        }} />
      )}

      {/* Speaker header with avatar */}
      {speakerMeta && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          {avatarUrl ? (
            <img src={avatarUrl} style={{ width: 36, height: 36, borderRadius: "50%", border: "2px solid " + speakerMeta.color, objectFit: "cover" }} alt={speakerMeta.name} />
          ) : (
            <div style={{ width: 36, height: 36, borderRadius: "50%", background: speakerMeta.color + "33", border: "2px solid " + speakerMeta.color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 700, color: speakerMeta.color }}>
              {speakerMeta.name[0]}
            </div>
          )}
          <span style={{ fontSize: 14, fontWeight: 700, color: speakerMeta.color }}>{speakerMeta.name}</span>
          {isInCombat && (
            <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 4, background: "#ef444433", color: "#ef4444", fontWeight: 600 }}>
              {battleState === "domain-expansion" ? "DOMAIN" : "COMBAT"}
            </span>
          )}
        </div>
      )}

      {/* Technique Highlight */}
      {technique && (
        <div style={{
          textAlign: "center", padding: "10px 16px", margin: "8px 0",
          background: "linear-gradient(90deg, transparent, rgba(100,100,255,0.1), transparent)",
          borderLeft: "3px solid #818cf8", fontSize: 16, fontWeight: 700, color: "#c0c0ff",
          letterSpacing: "0.05em"
        }}>
          {technique}
        </div>
      )}

      {/* Narrative Content */}
      <div dangerouslySetInnerHTML={{ __html: renderMarkdown(displayContent) }} />

      {/* Interactive Choices */}
      {choices.length > 0 && (
        <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 6 }}>
          {choices.map(function(choice, i) {
            return (
              <button
                key={i}
                onClick={function() { api.sendMessage(choice); }}
                style={{
                  textAlign: "left", padding: "10px 14px",
                  background: "rgba(129,140,248,0.06)", border: "1px solid rgba(129,140,248,0.2)",
                  borderRadius: 6, color: "#c0c8e8", fontSize: 13, cursor: "pointer"
                }}
              >
                {choice}
              </button>
            );
          })}
        </div>
      )}

      {/* Battle HUD */}
      <div style={{
        display: "flex", gap: 10, marginTop: 12, padding: "8px 12px",
        background: isInCombat ? "rgba(239,68,68,0.06)" : "rgba(0,0,0,0.2)",
        border: isInCombat ? "1px solid rgba(239,68,68,0.15)" : "1px solid transparent",
        borderRadius: 6, fontSize: 11, color: "#999", alignItems: "center", flexWrap: "wrap"
      }}>
        <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 10, opacity: 0.7 }}>HP</span>
          <div style={{ flex: 1, height: 6, borderRadius: 3, background: "rgba(255,255,255,0.1)", overflow: "hidden" }}>
            <div style={{ height: "100%", width: hp + "%", background: hp > 30 ? "#10b981" : "#ef4444", borderRadius: 3, transition: "width 0.3s" }} />
          </div>
        </div>
        <span><Icons.Sparkles size={12} style={{ color: "#a78bfa", marginRight: 3 }} />Lv.{level}</span>
        <span><Icons.Flame size={12} style={{ color: "#f59e0b", marginRight: 3 }} />{energy}%</span>
      </div>
    </div>
  );
}
