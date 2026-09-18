// ─── Horror Narrative Renderer ───
// Message renderer that parses AI content for special markers and renders immersive horror UI.
// Pattern from production survival horror game. Customize CHARACTERS and parse markers for your world.
//
// AI Content Markers (instruct the AI to include these in its responses):
//   **NIGHT 3**        → renders a full-width phase banner
//   **DAY 3**          → same, different styling
//   [PEEP:Sarah]       → triggers peephole character reveal overlay
//   ***Thud thud***    → renders as knock sound indicator
//   **Suggested Choices:** → everything after is extracted as clickable choice buttons
//
// Required variables:
//   hp (number)          — player health
//   energy (number)      — action energy (e.g., 3/5)
//   energy-max (number)  — max energy
//   has-weapon (boolean) — weapon status indicator
//   day-count (number)   — current day (for display)

export default function HorrorNarrativeRenderer({ content, role, messageIndex, variables, renderMarkdown }) {
  var api = useYumina();

  // ─── CHARACTER IMAGE MAP ───
  // Map character names (lowercase) to image URLs or @asset:ID references
  // AI uses [PEEP:name] in content to trigger the reveal
  var CHARACTER_IMAGES = {
    sarah: null,     // Replace with @asset:ID or URL
    marcus: null,
    stranger: null,
    default: null    // Fallback silhouette
  };

  // Aliases: map alternate names to canonical keys
  var ALIASES = {
    "officer wilson": "wilson",
    "old man chen": "chen"
  };

  function normalizeId(raw) {
    var s = (raw || "").toLowerCase().trim();
    if (ALIASES[s]) return ALIASES[s];
    return s.replace(/[^a-z0-9]/g, "");
  }

  // ─── USER MESSAGES: simple render ───
  if (role === "user") {
    return React.createElement("div", { className: "text-foreground" }, content);
  }

  // ─── PARSE PHASE BANNER ───
  var nightMatch = content.match(/\*\*NIGHT\s*(\d+)\*\*/);
  var dayMatch = content.match(/\*\*DAY\s*(\d+)\*\*/);
  var phaseNum = nightMatch ? nightMatch[1] : (dayMatch ? dayMatch[1] : null);
  var phaseType = nightMatch ? "night" : (dayMatch ? "day" : null);

  // ─── PARSE KNOCK SOUNDS ───
  var knockMatches = [];
  var knockRe = /\*{3}([^*]+?)\*{3}/g;
  var km;
  while ((km = knockRe.exec(content)) !== null) {
    knockMatches.push(km[1]);
  }

  // ─── PARSE PEEPHOLE CHARACTER ───
  var peepMatch = content.match(/\[PEEP:([^\]]+)\]/);
  var peepActive = !!peepMatch;
  var peepName = peepMatch ? peepMatch[1].trim() : "";
  var peepKey = normalizeId(peepName);
  var peepUrl = CHARACTER_IMAGES[peepKey] || CHARACTER_IMAGES["default"];

  // ─── STRIP MARKERS FROM NARRATIVE ───
  var stripped = content;
  stripped = stripped.replace(/\*\*(?:NIGHT|DAY)\s*\d+\*\*/g, "");
  stripped = stripped.replace(/\*{3}[^*]+?\*{3}/g, "");
  stripped = stripped.replace(/\[PEEP:[^\]]+\]\s*/g, "");

  // ─── PARSE CHOICES ───
  var choices = [];
  var narrativeText = stripped;
  var choiceHeader = /\*\*Suggested Choices:?\*\*/i;
  var choiceMatch = choiceHeader.exec(stripped);
  if (choiceMatch) {
    narrativeText = stripped.slice(0, choiceMatch.index).trimEnd();
    var choiceBlock = stripped.slice(choiceMatch.index + choiceMatch[0].length);
    var choiceLines = choiceBlock.split("\n").filter(function(l) { return l.trim(); });
    choiceLines.forEach(function(line) {
      var cleaned = line.replace(/^[A-Z]\.\s*/, "").trim();
      if (cleaned) choices.push(cleaned);
    });
  }

  // ─── VARIABLE HUD ───
  var hp = typeof variables.hp === "number" ? variables.hp : 100;
  var energy = typeof variables.energy === "number" ? variables.energy : 3;
  var energyMax = typeof variables["energy-max"] === "number" ? variables["energy-max"] : 5;
  var hasWeapon = !!variables["has-weapon"];

  return (
    <div style={{ position: "relative" }}>
      {/* Phase Banner */}
      {phaseType && (
        <div style={{
          textAlign: "center", padding: "12px 0", marginBottom: 12,
          background: phaseType === "night"
            ? "linear-gradient(90deg, transparent, rgba(30,30,60,0.8), transparent)"
            : "linear-gradient(90deg, transparent, rgba(255,220,150,0.15), transparent)",
          borderTop: "1px solid " + (phaseType === "night" ? "#334" : "#554"),
          borderBottom: "1px solid " + (phaseType === "night" ? "#334" : "#554")
        }}>
          <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: "0.2em", color: phaseType === "night" ? "#8899bb" : "#ccaa66" }}>
            {phaseType === "night" ? "NIGHT" : "DAY"} {phaseNum}
          </span>
        </div>
      )}

      {/* Knock Sound Indicators */}
      {knockMatches.map(function(k, i) {
        return (
          <div key={i} style={{ textAlign: "center", padding: "8px 0", fontStyle: "italic", color: "#887766", letterSpacing: "0.15em", fontSize: 14 }}>
            {k}
          </div>
        );
      })}

      {/* Peephole Overlay */}
      {peepActive && (
        <div style={{
          display: "flex", justifyContent: "center", margin: "12px 0",
          position: "relative"
        }}>
          <div style={{
            width: 160, height: 160, borderRadius: "50%",
            background: "#0a0a0a", border: "6px solid #222",
            overflow: "hidden", position: "relative",
            boxShadow: "0 0 40px rgba(0,0,0,0.8), inset 0 0 30px rgba(0,0,0,0.5)"
          }}>
            {peepUrl ? (
              <img src={peepUrl} style={{ width: "100%", height: "100%", objectFit: "cover", filter: "brightness(0.6) contrast(1.2)" }} alt={peepName} />
            ) : (
              <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "#333", fontSize: 12 }}>
                {peepName || "???"}
              </div>
            )}
            {/* Vignette overlay */}
            <div style={{ position: "absolute", inset: 0, borderRadius: "50%", boxShadow: "inset 0 0 40px 20px rgba(0,0,0,0.7)" }} />
          </div>
          <div style={{ position: "absolute", bottom: -8, fontSize: 11, color: "#776655" }}>
            Through the peephole: {peepName}
          </div>
        </div>
      )}

      {/* Narrative Text */}
      <div dangerouslySetInnerHTML={{ __html: renderMarkdown(narrativeText) }} />

      {/* Choice Buttons */}
      {choices.length > 0 && (
        <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 8 }}>
          {choices.map(function(choice, i) {
            return (
              <button
                key={i}
                onClick={function() { api.sendMessage(choice); }}
                style={{
                  textAlign: "left", padding: "10px 14px",
                  background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: 6, color: "#ccc", fontSize: 13, cursor: "pointer",
                  transition: "all 0.2s"
                }}
                onMouseEnter={function(e) { e.currentTarget.style.background = "rgba(255,255,255,0.08)"; }}
                onMouseLeave={function(e) { e.currentTarget.style.background = "rgba(255,255,255,0.04)"; }}
              >
                {String.fromCharCode(65 + i)}. {choice}
              </button>
            );
          })}
        </div>
      )}

      {/* Game State HUD (bottom bar) */}
      <div style={{
        display: "flex", gap: 12, marginTop: 14, padding: "8px 12px",
        background: "rgba(0,0,0,0.3)", borderRadius: 6, fontSize: 11, color: "#999",
        alignItems: "center", flexWrap: "wrap"
      }}>
        <span><Icons.Heart size={12} style={{ color: hp > 50 ? "#4a9" : "#c44", marginRight: 4 }} />{hp}%</span>
        <span><Icons.Zap size={12} style={{ color: "#aa8", marginRight: 4 }} />{energy}/{energyMax}</span>
        {hasWeapon && <span style={{ color: "#c88" }}><Icons.Crosshair size={12} style={{ marginRight: 4 }} />Armed</span>}
        <span style={{ marginLeft: "auto", color: "#666" }}>Day {variables["day-count"] || "?"}</span>
      </div>
    </div>
  );
}
