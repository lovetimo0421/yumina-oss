// ─── Character Creation + Game HUD Renderer ───
// Two-phase message renderer:
//   Phase 1 (messageIndex === 0): Interactive character creation form with fields, selections, and submit
//   Phase 2 (messageIndex > 0): Game state HUD with tabbed panels below each AI message
//
// Pattern from production anime RPG. Customize CLASSES, ELEMENTS, and the form fields for your world.
//
// Required variables:
//   player-name (string)    — set by the creation form
//   player-class (string)   — set by class selection
//   element (string)        — set by element selection
//   hp (number)             — health
//   chakra (number)         — energy/mana
//   inventory (json)        — array of item strings
//   skills (json)           — array of skill strings

export default function CreationHudRenderer({ content, role, messageIndex, variables, renderMarkdown }) {
  var api = useYumina();

  if (role === "user") {
    return React.createElement("div", { className: "text-foreground" }, content);
  }

  // ═══════════════════════════════════════════
  // PHASE 1: CHARACTER CREATION (greeting only)
  // ═══════════════════════════════════════════
  if (messageIndex === 0) {
    return React.createElement(CreationForm, { content: content, renderMarkdown: renderMarkdown, api: api });
  }

  // ═══════════════════════════════════════════
  // PHASE 2: GAME HUD (all subsequent messages)
  // ═══════════════════════════════════════════
  return React.createElement(GameHud, { content: content, renderMarkdown: renderMarkdown, variables: variables, api: api });
}

// ─── CHARACTER CREATION FORM ───
function CreationForm({ content, renderMarkdown, api }) {
  // ─── CUSTOMIZABLE OPTIONS ───
  var CLASSES = [
    { id: "warrior", label: "Warrior", icon: "Sword", desc: "Frontline fighter with high HP" },
    { id: "mage", label: "Mage", icon: "Sparkles", desc: "Ranged caster with powerful techniques" },
    { id: "rogue", label: "Rogue", icon: "Eye", desc: "Fast and stealthy, critical strikes" },
    { id: "healer", label: "Healer", icon: "Heart", desc: "Support with restoration abilities" }
  ];

  var ELEMENTS = [
    { id: "fire", label: "Fire", color: "#ef4444", icon: "Flame" },
    { id: "water", label: "Water", color: "#3b82f6", icon: "Droplets" },
    { id: "thunder", label: "Thunder", color: "#a855f7", icon: "Zap" },
    { id: "earth", label: "Earth", color: "#a16207", icon: "Mountain" },
    { id: "wind", label: "Wind", color: "#22c55e", icon: "Wind" }
  ];

  var nameState = React.useState("");
  var charName = nameState[0];
  var setCharName = nameState[1];
  var classState = React.useState("");
  var selectedClass = classState[0];
  var setSelectedClass = classState[1];
  var elemState = React.useState("");
  var selectedElem = elemState[0];
  var setSelectedElem = elemState[1];
  var submitted = React.useState(false);
  var isSubmitted = submitted[0];
  var setSubmitted = submitted[1];

  function handleSubmit() {
    if (!charName.trim() || !selectedClass || !selectedElem) return;
    setSubmitted(true);
    api.setVariable("player-name", charName.trim());
    api.setVariable("player-class", selectedClass);
    api.setVariable("element", selectedElem);
    api.sendMessage("I am " + charName.trim() + ", a " + selectedElem + " " + selectedClass + ". Let's begin.");
  }

  var elemInfo = ELEMENTS.find(function(e) { return e.id === selectedElem; });

  return (
    <div style={{ position: "relative" }}>
      {/* Narrative intro */}
      <div dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />

      {isSubmitted ? (
        <div style={{ textAlign: "center", padding: 24, color: "#4ade80", fontSize: 16, fontWeight: 700 }}>
          Character created! Starting your adventure...
        </div>
      ) : (
        <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Name Input */}
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#ccc", marginBottom: 6, letterSpacing: "0.1em" }}>YOUR NAME</div>
            <input
              type="text"
              value={charName}
              onChange={function(e) { setCharName(e.target.value); }}
              placeholder="Enter your name..."
              style={{
                width: "100%", border: "none", borderBottom: "2px solid rgba(255,255,255,0.15)",
                background: "transparent", color: "#e0e0e0", fontSize: 18, padding: "8px 0", outline: "none",
                boxSizing: "border-box"
              }}
            />
          </div>

          {/* Class Selection */}
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#ccc", marginBottom: 8, letterSpacing: "0.1em" }}>CLASS</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {CLASSES.map(function(cls) {
                var isSelected = selectedClass === cls.id;
                var IconComponent = Icons[cls.icon] || Icons.Circle;
                return (
                  <button
                    key={cls.id}
                    onClick={function() { setSelectedClass(cls.id); }}
                    style={{
                      padding: "12px 14px", borderRadius: 8, border: isSelected ? "2px solid #818cf8" : "1px solid rgba(255,255,255,0.1)",
                      background: isSelected ? "rgba(129,140,248,0.1)" : "rgba(255,255,255,0.03)",
                      cursor: "pointer", textAlign: "left", transition: "all 0.2s"
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      {React.createElement(IconComponent, { size: 16, style: { color: isSelected ? "#818cf8" : "#888" } })}
                      <span style={{ fontSize: 14, fontWeight: 600, color: isSelected ? "#c0c8ff" : "#ccc" }}>{cls.label}</span>
                    </div>
                    <div style={{ fontSize: 11, color: "#888", marginTop: 4 }}>{cls.desc}</div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Element Selection */}
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#ccc", marginBottom: 8, letterSpacing: "0.1em" }}>ELEMENT</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {ELEMENTS.map(function(elem) {
                var isSelected = selectedElem === elem.id;
                var IconComponent = Icons[elem.icon] || Icons.Circle;
                return (
                  <button
                    key={elem.id}
                    onClick={function() { setSelectedElem(elem.id); }}
                    style={{
                      width: 64, height: 80, borderRadius: 8, display: "flex", flexDirection: "column",
                      alignItems: "center", justifyContent: "center", gap: 4, cursor: "pointer",
                      border: isSelected ? "2px solid " + elem.color : "1px solid rgba(255,255,255,0.1)",
                      background: isSelected ? elem.color + "15" : "rgba(255,255,255,0.03)",
                      transition: "all 0.25s"
                    }}
                  >
                    {React.createElement(IconComponent, { size: 20, style: { color: isSelected ? elem.color : "#888" } })}
                    <span style={{ fontSize: 11, color: isSelected ? elem.color : "#999" }}>{elem.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Submit Button */}
          <button
            onClick={handleSubmit}
            disabled={!charName.trim() || !selectedClass || !selectedElem}
            style={{
              padding: "12px 24px", borderRadius: 8, border: "none",
              background: (charName.trim() && selectedClass && selectedElem) ? "linear-gradient(135deg, #818cf8, #6366f1)" : "#333",
              color: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer",
              opacity: (charName.trim() && selectedClass && selectedElem) ? 1 : 0.4,
              transition: "all 0.2s", letterSpacing: "0.05em"
            }}
          >
            BEGIN ADVENTURE
          </button>
        </div>
      )}
    </div>
  );
}

// ─── GAME HUD (post-creation) ───
function GameHud({ content, renderMarkdown, variables, api }) {
  var tabState = React.useState("none");
  var activeTab = tabState[0];
  var setActiveTab = tabState[1];

  var hp = typeof variables.hp === "number" ? variables.hp : 100;
  var chakra = typeof variables.chakra === "number" ? variables.chakra : 100;
  var playerClass = variables["player-class"] || "???";
  var element = variables["element"] || "???";

  // Parse JSON variables
  var inventory = [];
  try { inventory = Array.isArray(variables.inventory) ? variables.inventory : JSON.parse(variables.inventory || "[]"); } catch(e) {}
  var skills = [];
  try { skills = Array.isArray(variables.skills) ? variables.skills : JSON.parse(variables.skills || "[]"); } catch(e) {}

  var TABS = [
    { id: "stats", label: "Stats", icon: Icons.BarChart3 },
    { id: "skills", label: "Skills", icon: Icons.Sparkles },
    { id: "inventory", label: "Items", icon: Icons.Package }
  ];

  return (
    <div>
      {/* Message content */}
      <div dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />

      {/* Compact stat bar */}
      <div style={{
        display: "flex", gap: 10, marginTop: 12, padding: "6px 10px",
        background: "rgba(0,0,0,0.25)", borderRadius: 6, fontSize: 11, color: "#999",
        alignItems: "center"
      }}>
        <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ fontSize: 10, opacity: 0.7 }}>HP</span>
          <div style={{ flex: 1, height: 6, borderRadius: 3, background: "rgba(255,255,255,0.1)", overflow: "hidden" }}>
            <div style={{ height: "100%", width: hp + "%", background: hp > 30 ? "#10b981" : "#ef4444", borderRadius: 3, transition: "width 0.3s" }} />
          </div>
        </div>
        <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ fontSize: 10, opacity: 0.7 }}>Energy</span>
          <div style={{ flex: 1, height: 6, borderRadius: 3, background: "rgba(255,255,255,0.1)", overflow: "hidden" }}>
            <div style={{ height: "100%", width: chakra + "%", background: "#3b82f6", borderRadius: 3, transition: "width 0.3s" }} />
          </div>
        </div>
        <span style={{ marginLeft: "auto", fontSize: 10, color: "#666" }}>{playerClass} / {element}</span>
      </div>

      {/* Tab buttons */}
      <div style={{ display: "flex", gap: 4, marginTop: 8 }}>
        {TABS.map(function(tab) {
          var isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={function() { setActiveTab(isActive ? "none" : tab.id); }}
              style={{
                display: "flex", alignItems: "center", gap: 4, padding: "4px 10px",
                borderRadius: 4, border: "none", fontSize: 11, cursor: "pointer",
                background: isActive ? "rgba(255,255,255,0.1)" : "transparent",
                color: isActive ? "#fff" : "#666"
              }}
            >
              {React.createElement(tab.icon, { size: 12 })}
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      {activeTab === "stats" && (
        <div style={{ padding: 10, background: "rgba(0,0,0,0.15)", borderRadius: 6, marginTop: 4, fontSize: 12, color: "#bbb" }}>
          <div>HP: {hp}/100</div>
          <div>Energy: {chakra}/100</div>
          <div>Class: {playerClass}</div>
          <div>Element: {element}</div>
          <div>Name: {variables["player-name"] || "Unknown"}</div>
        </div>
      )}
      {activeTab === "skills" && (
        <div style={{ padding: 10, background: "rgba(0,0,0,0.15)", borderRadius: 6, marginTop: 4, fontSize: 12, color: "#bbb" }}>
          {skills.length === 0 ? (
            <div style={{ color: "#666" }}>No skills learned yet</div>
          ) : skills.map(function(s, i) {
            return React.createElement("div", { key: i, style: { padding: "4px 0", borderBottom: "1px solid rgba(255,255,255,0.05)" } }, typeof s === "string" ? s : s.name || JSON.stringify(s));
          })}
        </div>
      )}
      {activeTab === "inventory" && (
        <div style={{ padding: 10, background: "rgba(0,0,0,0.15)", borderRadius: 6, marginTop: 4, fontSize: 12, color: "#bbb" }}>
          {inventory.length === 0 ? (
            <div style={{ color: "#666" }}>Inventory empty</div>
          ) : inventory.map(function(item, i) {
            return React.createElement("div", { key: i, style: { padding: "4px 0", borderBottom: "1px solid rgba(255,255,255,0.05)" } }, typeof item === "string" ? item : item.name || JSON.stringify(item));
          })}
        </div>
      )}
    </div>
  );
}
