

// ── Message Renderer TSX ─────────────────────────────────────────────
// Mode A: Character Creation form (game_started === false)
// Mode B: War Report HUD wrapping each assistant message (game_started === true)
const MESSAGE_RENDERER_TSX = [
  'var { Swords, Shield, Crown, Flame, Wind, MapPin, Coins, Wheat, Users, Heart, Brain, Star, ChevronUp, ChevronDown, CloudRain, Sun, Snowflake, Leaf } = Icons;',
  '',
  'function ProgressBar({ value, max, color, label, showValue }) {',
  '  var pct = max > 0 ? Math.min(100, Math.max(0, ((value + max) / (max * 2)) * 100)) : 50;',
  '  if (typeof showValue === "undefined") showValue = true;',
  '  return (',
  '    <div className="w-full">',
  '      {label && <div className="flex justify-between text-[10px] mb-0.5"><span className="text-zinc-400">{label}</span>{showValue && <span className="text-zinc-300 font-mono">{value}</span>}</div>}',
  '      <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">',
  '        <div className={"h-full rounded-full transition-all duration-500 " + color} style={{ width: pct + "%" }} />',
  '      </div>',
  '    </div>',
  '  );',
  '}',
  '',
  'function ResourceBar({ value, max, color, label }) {',
  '  var pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;',
  '  return (',
  '    <div className="w-full">',
  '      {label && <div className="flex justify-between text-[10px] mb-0.5"><span className="text-zinc-400">{label}</span><span className="text-zinc-300 font-mono">{value}{max ? "/" + max : ""}</span></div>}',
  '      <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">',
  '        <div className={"h-full rounded-full transition-all duration-500 " + color} style={{ width: pct + "%" }} />',
  '      </div>',
  '    </div>',
  '  );',
  '}',
  '',
  'function StatRow({ label, value, onInc, onDec, min, max }) {',
  '  return (',
  '    <div className="flex items-center justify-between py-1">',
  '      <span className="text-sm text-zinc-300 w-28">{label}</span>',
  '      <div className="flex items-center gap-2">',
  '        <button onClick={onDec} disabled={value <= min} className="w-6 h-6 rounded bg-zinc-800 hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center text-zinc-300 text-xs transition-colors">',
  '          <ChevronDown className="w-3 h-3" />',
  '        </button>',
  '        <span className="text-sm font-mono text-zinc-100 w-6 text-center">{value}</span>',
  '        <button onClick={onInc} disabled={value >= max} className="w-6 h-6 rounded bg-zinc-800 hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center text-zinc-300 text-xs transition-colors">',
  '          <ChevronUp className="w-3 h-3" />',
  '        </button>',
  '      </div>',
  '    </div>',
  '  );',
  '}',
  '',
  'function FactionCard({ id, name, leader, color, borderColor, desc, bonus, selected, onSelect }) {',
  '  var isSelected = selected === id;',
  '  return (',
  '    <button onClick={function() { onSelect(id); }} className={"flex-1 p-3 rounded-lg border-2 transition-all text-left " + (isSelected ? borderColor + " bg-zinc-900/80 shadow-lg" : "border-zinc-700 bg-zinc-900/40 hover:border-zinc-500")}>',
  '      <div className={"text-sm font-bold " + color}>{name}</div>',
  '      <div className="text-[10px] text-zinc-500 mt-0.5">{leader}</div>',
  '      <div className="text-xs text-zinc-400 mt-1.5">{desc}</div>',
  '      <div className={"text-[10px] mt-1.5 " + color}>{bonus}</div>',
  '    </button>',
  '  );',
  '}',
  '',
  'function CharacterCreation({ setVariable, sendMessage }) {',
  '  var factionState = React.useState("wei");',
  '  var faction = factionState[0];',
  '  var setFaction = factionState[1];',
  '',
  '  var nameState = React.useState("");',
  '  var charName = nameState[0];',
  '  var setCharName = nameState[1];',
  '',
  '  var statsState = React.useState({ martial: 5, intelligence: 5, charisma: 5, leadership: 5 });',
  '  var stats = statsState[0];',
  '  var setStats = statsState[1];',
  '',
  '  var submittedState = React.useState(false);',
  '  var submitted = submittedState[0];',
  '  var setSubmitted = submittedState[1];',
  '',
  '  var remaining = 20 - stats.martial - stats.intelligence - stats.charisma - stats.leadership;',
  '',
  '  function adjustStat(stat, delta) {',
  '    setStats(function(prev) {',
  '      var val = prev[stat] + delta;',
  '      if (val < 1 || val > 10) return prev;',
  '      var newRemaining = 20 - (prev.martial + prev.intelligence + prev.charisma + prev.leadership) - delta;',
  '      if (newRemaining < 0) return prev;',
  '      var next = {};',
  '      next.martial = prev.martial;',
  '      next.intelligence = prev.intelligence;',
  '      next.charisma = prev.charisma;',
  '      next.leadership = prev.leadership;',
  '      next[stat] = val;',
  '      return next;',
  '    });',
  '  }',
  '',
  '  function handleSubmit() {',
  '    if (submitted) return;',
  '    if (!charName.trim()) return;',
  '    setSubmitted(true);',
  '',
  '    var factionBonuses = {',
  '      wei: { gold: 1500, provisions: 500, troops: 6000 },',
  '      shu: { gold: 1000, provisions: 800, troops: 5000 },',
  '      wu: { gold: 1200, provisions: 600, troops: 5500 }',
  '    };',
  '    var bonus = factionBonuses[faction];',
  '',
  '    setVariable("game_started", true);',
  '    setVariable("protagonist_name", charName.trim());',
  '    setVariable("faction", faction);',
  '    setVariable("stat_martial", stats.martial);',
  '    setVariable("stat_intelligence", stats.intelligence);',
  '    setVariable("stat_charisma", stats.charisma);',
  '    setVariable("stat_leadership", stats.leadership);',
  '    setVariable("gold", bonus.gold);',
  '    setVariable("provisions", bonus.provisions);',
  '    setVariable("troops", bonus.troops);',
  '    setVariable("turn", 1);',
  '    setVariable("year", 190);',
  '    setVariable("season", "Spring");',
  '    setVariable("location", faction === "wei" ? "Luoyang" : faction === "shu" ? "Chengdu" : "Jianye");',
  '',
  '    var factionNames = { wei: "Wei", shu: "Shu", wu: "Wu" };',
  '    var msg = "I am " + charName.trim() + ", warlord of " + factionNames[faction] + ". My stats: Martial " + stats.martial + ", Intelligence " + stats.intelligence + ", Charisma " + stats.charisma + ", Leadership " + stats.leadership + ". Begin the campaign. It is Spring, 190 AD.";',
  '    sendMessage(msg);',
  '  }',
  '',
  '  var factionColors = { wei: "text-blue-400", shu: "text-emerald-400", wu: "text-red-400" };',
  '',
  '  return (',
  '    <div className="max-w-2xl mx-auto p-4 space-y-5">',
  '      {/* Phase timeline */}',
  '      <div className="flex items-center justify-center gap-2 text-[10px] text-zinc-500 uppercase tracking-widest">',
  '        <span className="text-amber-400 font-bold">Character Creation</span>',
  '        <span>\\u2192</span>',
  '        <span>Campaign Start</span>',
  '        <span>\\u2192</span>',
  '        <span>Unification</span>',
  '      </div>',
  '',
  '      {/* Title */}',
  '      <div className="text-center space-y-1">',
  '        <div className="text-2xl font-bold text-amber-400" style={{ fontFamily: "serif" }}>\\u4e09\\u56fd\\u6f14\\u4e49</div>',
  '        <div className="text-sm text-zinc-400">Romance of the Three Kingdoms \\u00b7 190 AD</div>',
  '      </div>',
  '',
  '      {/* Faction cards */}',
  '      <div>',
  '        <div className="text-xs text-zinc-500 uppercase tracking-widest mb-2">Choose Your Kingdom</div>',
  '        <div className="flex gap-2">',
  '          <FactionCard id="wei" name="\\u9b4f Wei" leader="Cao Cao" color="text-blue-400" borderColor="border-blue-500" desc="Northern powerhouse" bonus="+Gold +Troops" selected={faction} onSelect={setFaction} />',
  '          <FactionCard id="shu" name="\\u8700 Shu" leader="Liu Bei" color="text-emerald-400" borderColor="border-emerald-500" desc="Righteous defenders" bonus="+Provisions +Morale" selected={faction} onSelect={setFaction} />',
  '          <FactionCard id="wu" name="\\u5434 Wu" leader="Sun Quan" color="text-red-400" borderColor="border-red-500" desc="Southern strategists" bonus="Balanced start" selected={faction} onSelect={setFaction} />',
  '        </div>',
  '      </div>',
  '',
  '      {/* Name input */}',
  '      <div>',
  '        <div className="text-xs text-zinc-500 uppercase tracking-widest mb-2">Your Name</div>',
  '        <input type="text" value={charName} onChange={function(e) { setCharName(e.target.value); }} placeholder="Enter your warlord name..." className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-zinc-100 text-sm placeholder-zinc-600 focus:outline-none focus:border-amber-500/50" />',
  '      </div>',
  '',
  '      {/* Stat allocation */}',
  '      <div>',
  '        <div className="flex items-center justify-between mb-2">',
  '          <span className="text-xs text-zinc-500 uppercase tracking-widest">Allocate Stats</span>',
  '          <span className={"text-xs font-mono " + (remaining > 0 ? "text-amber-400" : "text-zinc-500")}>{remaining} pts remaining</span>',
  '        </div>',
  '        <div className="bg-zinc-900/60 rounded-lg p-3 border border-zinc-800">',
  '          <StatRow label="\\u2694\\ufe0f Martial" value={stats.martial} min={1} max={10} onInc={function() { adjustStat("martial", 1); }} onDec={function() { adjustStat("martial", -1); }} />',
  '          <StatRow label="\\ud83e\\udde0 Intelligence" value={stats.intelligence} min={1} max={10} onInc={function() { adjustStat("intelligence", 1); }} onDec={function() { adjustStat("intelligence", -1); }} />',
  '          <StatRow label="\\ud83d\\udc51 Charisma" value={stats.charisma} min={1} max={10} onInc={function() { adjustStat("charisma", 1); }} onDec={function() { adjustStat("charisma", -1); }} />',
  '          <StatRow label="\\ud83c\\udff4 Leadership" value={stats.leadership} min={1} max={10} onInc={function() { adjustStat("leadership", 1); }} onDec={function() { adjustStat("leadership", -1); }} />',
  '        </div>',
  '      </div>',
  '',
  '      {/* Submit */}',
  '      <button onClick={handleSubmit} disabled={submitted || !charName.trim()} className={"w-full py-3 rounded-lg font-bold text-sm transition-all " + (submitted || !charName.trim() ? "bg-zinc-800 text-zinc-600 cursor-not-allowed" : "bg-amber-600 hover:bg-amber-500 text-white shadow-lg shadow-amber-900/30")}>',
  '        {submitted ? "Marshaling forces..." : "Begin Campaign"}',
  '      </button>',
  '    </div>',
  '  );',
  '}',
  '',
  'function cleanContent(text) {',
  '  if (!text) return "";',
  '  var cleaned = text.replace(/<sum>[\\s\\S]*?<\\/sum>/g, "");',
  '  cleaned = cleaned.replace(/\\[\\w+:\\s*(?:set|add|subtract|multiply|toggle|append)\\s+[^\\]]*\\]/g, "");',
  '  cleaned = cleaned.replace(/(\\n\\s*){3,}/g, "\\n\\n");',
  '  return cleaned.trim();',
  '}',
  '',
  'function WarReportHUD({ content, variables }) {',
  '  var year = Number(variables.year) || 190;',
  '  var season = String(variables.season || "Spring");',
  '  var turn = Number(variables.turn) || 0;',
  '  var weather = String(variables.weather || "Clear");',
  '  var wind = String(variables.wind || "East");',
  '  var location = String(variables.location || "Capital");',
  '  var gold = Number(variables.gold) || 0;',
  '  var provisions = Number(variables.provisions) || 0;',
  '  var troops = Number(variables.troops) || 0;',
  '  var morale = Number(variables.army_morale) || 0;',
  '  var discipline = Number(variables.army_discipline) || 0;',
  '  var fatigue = Number(variables.army_fatigue) || 0;',
  '  var faction = String(variables.faction || "wei");',
  '  var relWei = Number(variables.rel_wei) || 0;',
  '  var relShu = Number(variables.rel_shu) || 0;',
  '  var relWu = Number(variables.rel_wu) || 0;',
  '  var cmd1 = String(variables.commander_1 || "None");',
  '  var cmd2 = String(variables.commander_2 || "None");',
  '',
  '  var factionAccent = faction === "shu" ? "text-emerald-400" : faction === "wu" ? "text-red-400" : "text-blue-400";',
  '  var factionBorder = faction === "shu" ? "border-emerald-800/40" : faction === "wu" ? "border-red-800/40" : "border-blue-800/40";',
  '  var factionBg = faction === "shu" ? "bg-emerald-950/20" : faction === "wu" ? "bg-red-950/20" : "bg-blue-950/20";',
  '',
  '  var seasonIcon = season === "Summer" ? "\\u2600\\ufe0f" : season === "Autumn" ? "\\ud83c\\udf42" : season === "Winter" ? "\\u2744\\ufe0f" : "\\ud83c\\udf38";',
  '',
  '  var narrative = cleanContent(content);',
  '',
  '  var otherFactions = [];',
  '  if (faction !== "wei") otherFactions.push({ name: "Wei", rel: relWei, color: "bg-blue-500" });',
  '  if (faction !== "shu") otherFactions.push({ name: "Shu", rel: relShu, color: "bg-emerald-500" });',
  '  if (faction !== "wu") otherFactions.push({ name: "Wu", rel: relWu, color: "bg-red-500" });',
  '',
  '  return (',
  '    <div className={"rounded-lg border " + factionBorder + " " + factionBg + " overflow-hidden"}>',
  '      {/* Header strip */}',
  '      <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-900/60 border-b border-zinc-800 text-[10px]">',
  '        <div className="flex items-center gap-3">',
  '          <span className={factionAccent + " font-bold"}>{seasonIcon} {year} {season}</span>',
  '          <span className="text-zinc-500">Turn {turn}</span>',
  '          <span className="text-zinc-500">{weather}</span>',
  '          <span className="text-zinc-500">Wind: {wind}</span>',
  '        </div>',
  '        <div className="flex items-center gap-1">',
  '          <MapPin className="w-3 h-3 text-zinc-500" />',
  '          <span className="text-zinc-300">{location}</span>',
  '        </div>',
  '      </div>',
  '',
  '      {/* Resource strip */}',
  '      <div className="flex items-center gap-4 px-3 py-1 bg-zinc-900/30 border-b border-zinc-800/50 text-[10px]">',
  '        <span className="text-yellow-400"><Coins className="w-3 h-3 inline mr-1" />{gold}</span>',
  '        <span className="text-amber-300"><Wheat className="w-3 h-3 inline mr-1" />{provisions}</span>',
  '        <span className="text-zinc-300"><Users className="w-3 h-3 inline mr-1" />{troops.toLocaleString()}</span>',
  '      </div>',
  '',
  '      {/* Narrative */}',
  '      <div className="p-4 text-sm text-zinc-200 leading-relaxed whitespace-pre-wrap">{narrative}</div>',
  '',
  '      {/* Bottom panels */}',
  '      <div className="grid grid-cols-2 gap-px bg-zinc-800/50">',
  '        {/* Army Status */}',
  '        <div className="p-3 bg-zinc-950/60 space-y-2">',
  '          <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-semibold flex items-center gap-1"><Shield className="w-3 h-3" /> Army Status</div>',
  '          <ResourceBar label="Morale" value={morale} max={100} color="bg-emerald-500" />',
  '          <ResourceBar label="Discipline" value={discipline} max={100} color="bg-blue-500" />',
  '          <ResourceBar label="Fatigue" value={fatigue} max={100} color="bg-orange-500" />',
  '        </div>',
  '',
  '        {/* Diplomacy + Commanders */}',
  '        <div className="p-3 bg-zinc-950/60 space-y-2">',
  '          <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-semibold flex items-center gap-1"><Crown className="w-3 h-3" /> Diplomacy</div>',
  '          {otherFactions.map(function(f) {',
  '            return <ProgressBar key={f.name} label={f.name} value={f.rel} max={100} color={f.color} />;',
  '          })}',
  '          <div className="border-t border-zinc-800 pt-1.5 mt-1.5">',
  '            <div className="text-[10px] text-zinc-500 mb-1">Commanders</div>',
  '            <div className="text-xs text-zinc-400">{cmd1 !== "None" ? cmd1 : "\\u2014"}{cmd2 !== "None" ? ", " + cmd2 : ""}</div>',
  '          </div>',
  '        </div>',
  '      </div>',
  '    </div>',
  '  );',
  '}',
  '',
  'function MyComponent(props) {',
  '  var { variables, setVariable, sendMessage } = useYumina();',
  '  var gameStarted = variables.game_started === true || variables.game_started === "true";',
  '  var role = props.role;',
  '  var content = props.content || "";',
  '',
  '  if (role === "user") {',
  '    return <div className="text-sm text-zinc-200 whitespace-pre-wrap">{content}</div>;',
  '  }',
  '',
  '  if (!gameStarted) {',
  '    return <CharacterCreation setVariable={setVariable} sendMessage={sendMessage} />;',
  '  }',
  '',
  '  return <WarReportHUD content={content} variables={variables} />;',
  '}',
  '',
  'export default MyComponent;',
].join("\n");

// ── Sidebar HUD TSX ──────────────────────────────────────────────────
const SIDEBAR_HUD_TSX = [
  'var { Swords, Shield, Crown, MapPin, Coins, Wheat, Users, Brain, Star } = Icons;',
  '',
  'function MyComponent() {',
  '  var { variables } = useYumina();',
  '  var gameStarted = variables.game_started === true || variables.game_started === "true";',
  '',
  '  if (!gameStarted) {',
  '    return (',
  '      <div className="flex flex-col items-center justify-center h-full p-6 text-center">',
  '        <Swords className="w-8 h-8 text-zinc-600 mb-3" />',
  '        <div className="text-sm text-zinc-500">Create your character to begin the campaign</div>',
  '      </div>',
  '    );',
  '  }',
  '',
  '  var name = String(variables.protagonist_name || "Warlord");',
  '  var faction = String(variables.faction || "wei");',
  '  var title = String(variables.title || "Aspiring Warlord");',
  '  var location = String(variables.location || "Capital");',
  '  var year = Number(variables.year) || 190;',
  '  var season = String(variables.season || "Spring");',
  '  var turn = Number(variables.turn) || 0;',
  '  var martial = Number(variables.stat_martial) || 5;',
  '  var intelligence = Number(variables.stat_intelligence) || 5;',
  '  var charisma = Number(variables.stat_charisma) || 5;',
  '  var leadership = Number(variables.stat_leadership) || 5;',
  '  var gold = Number(variables.gold) || 0;',
  '  var provisions = Number(variables.provisions) || 0;',
  '  var troops = Number(variables.troops) || 0;',
  '  var cmd1 = String(variables.commander_1 || "None");',
  '  var cmd2 = String(variables.commander_2 || "None");',
  '',
  '  var factionLabel = faction === "shu" ? "\\u8700 Shu" : faction === "wu" ? "\\u5434 Wu" : "\\u9b4f Wei";',
  '  var factionColor = faction === "shu" ? "text-emerald-400" : faction === "wu" ? "text-red-400" : "text-blue-400";',
  '  var borderColor = faction === "shu" ? "border-emerald-800/40" : faction === "wu" ? "border-red-800/40" : "border-blue-800/40";',
  '',
  '  return (',
  '    <div className="flex flex-col gap-3 p-4 h-full bg-zinc-950 text-zinc-100 overflow-y-auto">',
  '      {/* Header */}',
  '      <div className="flex items-center justify-between">',
  '        <div className="flex items-center gap-2">',
  '          <Crown className={"w-4 h-4 " + factionColor} />',
  '          <span className={"text-sm font-bold " + factionColor}>{factionLabel}</span>',
  '        </div>',
  '        <span className="text-[10px] text-zinc-500">{year} {season} \\u00b7 Turn {turn}</span>',
  '      </div>',
  '',
  '      {/* Name & title */}',
  '      <div className={"border-b pb-2 " + borderColor}>',
  '        <div className="text-sm font-semibold text-zinc-100">{name}</div>',
  '        <div className="text-[10px] text-zinc-500">{title}</div>',
  '      </div>',
  '',
  '      {/* Location */}',
  '      <div className="flex items-center gap-1.5 text-xs text-zinc-400">',
  '        <MapPin className="w-3 h-3 text-zinc-500" />',
  '        <span>{location}</span>',
  '      </div>',
  '',
  '      {/* Stats */}',
  '      <div className={"border-t pt-3 " + borderColor}>',
  '        <div className="text-[10px] uppercase tracking-widest text-zinc-500 mb-2">Stats</div>',
  '        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">',
  '          <div className="flex justify-between"><span className="text-zinc-400">\\u2694\\ufe0f Martial</span><span className="text-zinc-200 font-mono">{martial}</span></div>',
  '          <div className="flex justify-between"><span className="text-zinc-400">\\ud83e\\udde0 Intelligence</span><span className="text-zinc-200 font-mono">{intelligence}</span></div>',
  '          <div className="flex justify-between"><span className="text-zinc-400">\\ud83d\\udc51 Charisma</span><span className="text-zinc-200 font-mono">{charisma}</span></div>',
  '          <div className="flex justify-between"><span className="text-zinc-400">\\ud83c\\udff4 Leadership</span><span className="text-zinc-200 font-mono">{leadership}</span></div>',
  '        </div>',
  '      </div>',
  '',
  '      {/* Resources */}',
  '      <div className={"border-t pt-3 " + borderColor}>',
  '        <div className="text-[10px] uppercase tracking-widest text-zinc-500 mb-2">Resources</div>',
  '        <div className="space-y-1 text-xs">',
  '          <div className="flex items-center justify-between"><span className="text-yellow-400 flex items-center gap-1"><Coins className="w-3 h-3" /> Gold</span><span className="text-zinc-200 font-mono">{gold}</span></div>',
  '          <div className="flex items-center justify-between"><span className="text-amber-300 flex items-center gap-1"><Wheat className="w-3 h-3" /> Provisions</span><span className="text-zinc-200 font-mono">{provisions}</span></div>',
  '          <div className="flex items-center justify-between"><span className="text-zinc-300 flex items-center gap-1"><Users className="w-3 h-3" /> Troops</span><span className="text-zinc-200 font-mono">{troops.toLocaleString()}</span></div>',
  '        </div>',
  '      </div>',
  '',
  '      {/* Commanders */}',
  '      <div className={"border-t pt-3 " + borderColor}>',
  '        <div className="text-[10px] uppercase tracking-widest text-zinc-500 mb-2">Commanders</div>',
  '        <div className="space-y-1 text-xs text-zinc-400">',
  '          {cmd1 !== "None" ? <div className="flex items-center gap-1.5"><Swords className="w-3 h-3 text-zinc-500" />{cmd1}</div> : null}',
  '          {cmd2 !== "None" ? <div className="flex items-center gap-1.5"><Shield className="w-3 h-3 text-zinc-500" />{cmd2}</div> : null}',
  '          {cmd1 === "None" && cmd2 === "None" ? <div className="text-zinc-600 italic">No commanders recruited</div> : null}',
  '        </div>',
  '      </div>',
  '    </div>',
  '  );',
  '}',
  '',
  'export default MyComponent;',
].join("\n");

// ── World Definition ─────────────────────────────────────────────────
// Typed loosely — this is v8 seed data that goes through the migration chain on load
export const THREE_KINGDOMS_WORLD_DEFINITION = {
  id: "three-kingdoms",
  version: "8.0.0",
  name: "Three Kingdoms: Rise of the Warlord",
  description:
    "A strategic campaign set in the Three Kingdoms era of ancient China (190 AD). Create your warlord, choose a faction, and fight to unify the land through military conquest, diplomacy, and cunning strategy.",
  author: "Yumina Demo",

  messageRenderer: {
    id: "tk-message-renderer",
    name: "War Report Renderer",
    tsxCode: MESSAGE_RENDERER_TSX,
    description:
      "Character creation form (pre-game) and War Report HUD (in-game) wrapping each message",
    order: 0,
    visible: true,
    updatedAt: new Date().toISOString(),
  },

  entries: [
    // ─── Entry 1: System Prompt ──────────────────────────────────────
    {
      id: "tk-system",
      name: "System Prompt",
      content: `You are the Game Master of "Three Kingdoms: Rise of the Warlord" — a strategic campaign set in ancient China, 190 AD. The Han Dynasty crumbles as warlords vie for supremacy. The player commands one of three factions and must navigate warfare, diplomacy, and internal affairs to unify the realm.

CORE RULES:
- You narrate the world, control all NPCs, rival factions, events, weather, and historical context
- Never break character or acknowledge this is a game
- Maintain epic, dramatic tone befitting a historical war saga
- Each turn represents one season (Spring → Summer → Autumn → Winter)
- Advance the year after Winter
- Present 3-5 strategic choices at the end of each response (labeled A-E)
- Wrap system/GM notes in <sum> tags
- Output variable directives at the very end of every response using [var: op value] format

RESPONSE STRUCTURE:
1. Narrative description of events, battles, court intrigue, or diplomacy
2. Consequences of the player's last action
3. Current situation summary
4. Strategic options (A-E choices)
5. <sum> GM notes </sum>
6. Variable directives [var: op value]`,
      role: "system",
      alwaysSend: true,
      keywords: [],
      conditions: [],
      conditionLogic: "all",
      enabled: true,
      position: 0,
      section: "system-presets" as const,
    },

    // ─── Entry 2: Variable Output Format ─────────────────────────────
    {
      id: "tk-var-format",
      name: "Variable Output Format",
      content: `VARIABLE DIRECTIVE REFERENCE:
Use [variable: operation value] syntax at the END of every response.

Available directives:
[turn: add 1] — advance turn counter
[season: set "Summer"] — set to Spring/Summer/Autumn/Winter
[year: set 191] — update year (after Winter → Spring)
[location: set "Luoyang"] — current territory/city
[gold: add 500] / [gold: subtract 200] — treasury changes
[provisions: add 300] / [provisions: subtract 100] — food supply
[troops: add 1000] / [troops: subtract 500] — army size
[army_morale: add 10] / [army_morale: subtract 15] — morale (0-100)
[army_discipline: add 5] / [army_discipline: subtract 10] — discipline (0-100)
[army_fatigue: add 15] / [army_fatigue: subtract 10] — fatigue (0-100)
[rel_wei: add 10] / [rel_wei: subtract 20] — Wei relations (-100 to 100)
[rel_shu: add 10] / [rel_shu: subtract 20] — Shu relations
[rel_wu: add 10] / [rel_wu: subtract 20] — Wu relations
[weather: set "Rain"] — Clear/Rain/Storm/Fog/Snow
[wind: set "North"] — wind direction (affects fire attacks)
[title: set "General of the East"] — player title progression
[commander_1: set "Zhao Yun"] — first commander slot
[commander_2: set "Zhuge Liang"] — second commander slot
[stat_martial: add 1] — rare stat increases from events/training
[stat_intelligence: add 1] — rare stat increases
[stat_charisma: add 1] — rare stat increases
[stat_leadership: add 1] — rare stat increases

IMPORTANT: You MUST output variable directives at the end of EVERY response to keep game state synchronized.

Example:
[turn: add 1]
[season: set "Summer"]
[gold: subtract 200]
[troops: add 2000]
[army_morale: add 5]
[rel_shu: subtract 10]`,
      role: "system",
      alwaysSend: true,
      keywords: [],
      conditions: [],
      conditionLogic: "all",
      enabled: true,
      position: 0,
      section: "post-history" as const,
    },

    // ─── Entry 3: Current State ──────────────────────────────────────
    {
      id: "tk-state",
      name: "Current State",
      content: `CURRENT GAME STATE:
Faction: {{faction}} | Name: {{protagonist_name}} | Title: {{title}}
Year: {{year}} | Season: {{season}} | Turn: {{turn}}
Location: {{location}} | Weather: {{weather}} | Wind: {{wind}}

Stats — Martial: {{stat_martial}} | Intelligence: {{stat_intelligence}} | Charisma: {{stat_charisma}} | Leadership: {{stat_leadership}}

Resources — Gold: {{gold}} | Provisions: {{provisions}} | Troops: {{troops}}
Army — Morale: {{army_morale}}/100 | Discipline: {{army_discipline}}/100 | Fatigue: {{army_fatigue}}/100

Diplomacy — Wei: {{rel_wei}} | Shu: {{rel_shu}} | Wu: {{rel_wu}}
Commanders: {{commander_1}}, {{commander_2}}`,
      role: "system",
      alwaysSend: true,
      keywords: [],
      conditions: [],
      conditionLogic: "all",
      enabled: true,
      position: 1,
      section: "post-history" as const,
    },

    // ─── Entry 4: Game Mechanics ─────────────────────────────────────
    {
      id: "tk-mechanics",
      name: "Game Mechanics",
      content: `GAME MECHANICS:

TURN STRUCTURE: 1 turn = 1 season. Each turn the player chooses ONE major action + optional minor actions.

AVAILABLE ACTIONS:

Military:
- Attack territory — requires troops, provisions consumed; outcome based on martial/leadership vs enemy + terrain + weather
- Defend position — fortify current location, costs less provisions
- Train army — [army_discipline: add 10] [army_fatigue: add 5] [provisions: subtract 50]
- Recruit soldiers — [gold: subtract X] [troops: add Y], rate depends on charisma + location

Diplomacy:
- Send envoy — attempt to improve relations with another faction [rel_X: add 5-15], depends on charisma
- Propose alliance — requires rel > 30, creates mutual defense pact
- Declare war — [rel_X: set -100], enables attacks on that faction
- Sue for peace — requires negotiation, may cost gold/territory

Internal Affairs:
- Farm/harvest — [provisions: add X] based on season (Spring/Summer best)
- Collect taxes — [gold: add X] but [army_morale: subtract 5]
- Build fortifications — [gold: subtract X] improves defense
- Recruit commander — [gold: subtract 500] chance to recruit famous general; depends on charisma + faction

Special Actions:
- Fire attack — devastating in dry weather + favorable wind; requires intelligence > 7
- Ambush — surprise attack on moving army; requires martial > 7
- Espionage — spy on enemy faction; requires intelligence > 6
- Inspire troops — [army_morale: add 15] requires charisma > 6

COMBAT RESOLUTION:
- Compare attacker (martial + leadership + troops + morale) vs defender
- Weather modifiers: Rain -20% attack, Snow -30% attack, Fog +20% ambush
- Wind affects fire attacks dramatically
- Fatigue > 70 gives -25% combat effectiveness
- Low morale (< 30) causes desertion risk

SEASON EFFECTS:
- Spring: farming bonus, balanced weather, troop recruitment bonus
- Summer: heat fatigue, fire attack bonus, provisions spoil faster
- Autumn: harvest season, provisions +50% from farming, clear weather
- Winter: troop attrition, snow penalties, provisions consumed 2x`,
      role: "lore",
      alwaysSend: true,
      keywords: [],
      conditions: [],
      conditionLogic: "all",
      enabled: true,
      position: 1,
      section: "system-presets" as const,
    },

    // ─── Entry 5: Historical Context ─────────────────────────────────
    {
      id: "tk-history",
      name: "Historical Context",
      content: `HISTORICAL CONTEXT — THREE KINGDOMS ERA:

The year is 190 AD. The once-mighty Han Dynasty crumbles under the weight of corruption, eunuch influence, and the devastating Yellow Turban Rebellion (184 AD). Emperor Xian is a puppet. Dong Zhuo, the tyrant, seized the capital Luoyang and rules through terror.

A coalition of warlords formed to oppose Dong Zhuo but quickly fractured due to internal rivalries. Now, the land fractures into competing powers:

KEY EVENTS:
- 184: Yellow Turban Rebellion devastates the countryside
- 189: Dong Zhuo seizes control of the capital, deposes the emperor
- 190: Coalition against Dong Zhuo forms then dissolves — our story begins here
- Historical trajectory: decades of warfare leading to three kingdoms (Wei, Shu, Wu)

GEOGRAPHY:
- North (Wei territory): Luoyang, Xuchang, Ye — plains, rivers, cold winters
- West (Shu territory): Chengdu, Hanzhong — mountainous, defensible, fertile valleys
- South/East (Wu territory): Jianye, Chibi — rivers, lakes, naval power, subtropical
- Central: contested territory, key battle sites

The player's choices will diverge from history. They may ally with historical enemies, conquer in different order, or forge entirely new paths.`,
      role: "lore",
      alwaysSend: true,
      keywords: [],
      conditions: [],
      conditionLogic: "all",
      enabled: true,
      position: 2,
      section: "system-presets" as const,
    },

    // ─── Entry 6: Faction Details ────────────────────────────────────
    {
      id: "tk-factions",
      name: "Faction Details",
      content: `FACTION DETAILS:

=== WEI (魏) — Northern Kingdom ===
Color: Blue | Capital: Luoyang/Xuchang
Leader: Cao Cao — brilliant strategist, ruthless pragmatist
Starting Advantages: Largest territory, most gold, biggest army
Key Generals: Xiahou Dun (loyal warrior), Xu Chu (mighty berserker), Zhang Liao (tactical genius)
Key Advisors: Xun Yu (administration), Guo Jia (strategy), Jia Xu (cunning schemes)
Weakness: Many enemies, internal court politics, high troop maintenance costs
Playstyle: Military dominance, economic power, political manipulation

=== SHU (蜀) — Western Kingdom ===
Color: Green | Capital: Chengdu
Leader: Liu Bei — benevolent ruler, inspires fierce loyalty
Starting Advantages: High morale, defensible terrain, loyal subjects
Key Generals: Guan Yu (God of War), Zhang Fei (fierce warrior), Zhao Yun (perfect knight)
Key Advisors: Zhuge Liang (the Sleeping Dragon — greatest strategist alive), Pang Tong (the Phoenix)
Weakness: Smallest territory, limited resources, isolated geography
Playstyle: Righteous cause, strong alliances, defensive warfare, morale advantage

=== WU (吴) — Southern Kingdom ===
Color: Red | Capital: Jianye
Leader: Sun Quan — young, balanced, naval supremacy
Starting Advantages: Naval power, rich trade, balanced resources
Key Generals: Zhou Yu (brilliant naval commander), Lu Xun (fire tactics), Gan Ning (river pirate)
Key Advisors: Lu Su (diplomacy), Zhang Zhao (administration)
Weakness: Succession disputes, relies heavily on river defense, weaker land army
Playstyle: Naval warfare, trade, diplomacy, fire attacks on water`,
      role: "lore",
      alwaysSend: true,
      keywords: [],
      conditions: [],
      conditionLogic: "all",
      enabled: true,
      position: 3,
      section: "system-presets" as const,
    },

    // ─── Entry 7: Display Format ─────────────────────────────────────
    {
      id: "tk-display",
      name: "Display Format",
      content: `RESPONSE FORMAT:

Structure every response as:
1. **Narrative section** — vivid, dramatic prose describing events. Use markdown: *italics* for atmosphere, **bold** for emphasis.
2. **Consequences** — what happened as a result of the player's action
3. **Strategic choices** — always end with:

**Strategic Options:**
A. First option — brief description
B. Second option — brief description
C. Third option — brief description
D. Fourth option — brief description
E. Other — describe your own strategy

4. **System notes** in <sum> tags (hidden from player):
<sum>GM notes about hidden mechanics, faction movements, etc.</sum>

5. **Variable directives** at the very end (hidden from player):
[var: op value]

Keep responses dramatic and engaging. Reference historical events, famous battles, and legendary figures. The player should feel like they are living through an epic saga.`,
      role: "style",
      depth: 0,
      alwaysSend: true,
      keywords: [],
      conditions: [],
      conditionLogic: "all",
      enabled: true,
      position: 0,
      section: "chat-history" as const,
    },

    // ─── Entry 8: Greeting ───────────────────────────────────────────
    {
      id: "tk-greeting",
      name: "Greeting",
      content: `The year is 190 AD. The Han Dynasty, once the jewel of civilization, crumbles to dust.

Emperor Xian sits powerless on the Dragon Throne while tyrants and warlords tear the empire apart. The Yellow Turban Rebellion left the countryside in ashes. Dong Zhuo's tyranny ignited a coalition — but even that fragile alliance has shattered.

Now, from the chaos, three powers rise. In the north, Cao Cao consolidates his iron grip. In the west, Liu Bei rallies the righteous to his banner. In the south, Sun Quan commands the rivers and seas.

*The mandate of heaven waits for no one. Choose your path, warlord.*`,
      role: "greeting",
      alwaysSend: true,
      keywords: [],
      conditions: [],
      conditionLogic: "all",
      enabled: true,
      position: 4,
      section: "system-presets" as const,
    },
  ],

  variables: [
    // Meta
    { id: "game_started", name: "Game Started", type: "boolean", defaultValue: false, description: "Whether character creation is complete", category: "flag", behaviorRules: "Set to true when the player submits the character creation form" },
    { id: "turn", name: "Turn", type: "number", defaultValue: 0, description: "Current turn number", min: 0, category: "stat", behaviorRules: "Add 1 each season. Game ends at turn 40." },
    { id: "season", name: "Season", type: "string", defaultValue: "Spring", description: "Current season", category: "stat", behaviorRules: "Cycle: Spring → Summer → Autumn → Winter → Spring. Advance year after Winter." },
    { id: "year", name: "Year", type: "number", defaultValue: 190, description: "Current year AD", min: 190, category: "stat", behaviorRules: "Increment by 1 when season cycles from Winter back to Spring" },

    // Character
    { id: "protagonist_name", name: "Protagonist Name", type: "string", defaultValue: "", description: "Player's warlord name", category: "custom", behaviorRules: "Set during character creation. Do not change." },
    { id: "faction", name: "Faction", type: "string", defaultValue: "", description: "Player's faction (wei/shu/wu)", category: "custom", behaviorRules: "Set during character creation. Do not change." },
    { id: "title", name: "Title", type: "string", defaultValue: "Aspiring Warlord", description: "Player's current title", category: "custom", behaviorRules: "Upgrade as the player gains power: Aspiring Warlord → General → Governor → King → Emperor" },
    { id: "location", name: "Location", type: "string", defaultValue: "Capital", description: "Current territory or city", category: "custom", behaviorRules: "Update when the player moves or conquers new territory" },

    // Stats
    { id: "stat_martial", name: "Martial", type: "number", defaultValue: 5, description: "Combat prowess", min: 1, max: 10, category: "stat", behaviorRules: "Rarely increase through training events or special encounters. Affects combat." },
    { id: "stat_intelligence", name: "Intelligence", type: "number", defaultValue: 5, description: "Strategic wisdom", min: 1, max: 10, category: "stat", behaviorRules: "Rarely increase. Affects espionage, fire attacks, planning." },
    { id: "stat_charisma", name: "Charisma", type: "number", defaultValue: 5, description: "Leadership appeal", min: 1, max: 10, category: "stat", behaviorRules: "Rarely increase. Affects recruitment, diplomacy, morale." },
    { id: "stat_leadership", name: "Leadership", type: "number", defaultValue: 5, description: "Command ability", min: 1, max: 10, category: "stat", behaviorRules: "Rarely increase. Affects troop efficiency, discipline." },

    // Resources
    { id: "gold", name: "Gold", type: "number", defaultValue: 1000, description: "Treasury", min: 0, category: "resource", behaviorRules: "Add from taxes/trade/conquest. Subtract for recruitment, construction, diplomacy gifts." },
    { id: "provisions", name: "Provisions", type: "number", defaultValue: 500, description: "Food supply", min: 0, category: "resource", behaviorRules: "Add from farming/harvest. Subtract for army upkeep, campaigns. 0 = starvation." },
    { id: "troops", name: "Troops", type: "number", defaultValue: 5000, description: "Army size", min: 0, category: "resource", behaviorRules: "Add from recruitment. Subtract from battles, desertion, attrition. 0 = defeat." },

    // Army
    { id: "army_morale", name: "Army Morale", type: "number", defaultValue: 70, description: "Troop morale", min: 0, max: 100, category: "stat", behaviorRules: "Add after victories, inspiration. Subtract after defeats, starvation, harsh taxes. < 20 = desertion risk." },
    { id: "army_discipline", name: "Army Discipline", type: "number", defaultValue: 60, description: "Troop discipline", min: 0, max: 100, category: "stat", behaviorRules: "Add from training. Subtract from long campaigns, low morale. Affects combat effectiveness." },
    { id: "army_fatigue", name: "Army Fatigue", type: "number", defaultValue: 20, description: "Troop exhaustion", min: 0, max: 100, category: "stat", behaviorRules: "Add from marching, combat, winter. Subtract from rest. > 70 = combat penalty." },

    // Diplomacy
    { id: "rel_wei", name: "Wei Relations", type: "number", defaultValue: 0, description: "Relations with Wei (-100 to 100)", min: -100, max: 100, category: "stat", behaviorRules: "Add from diplomacy, alliances. Subtract from attacks, insults, rivalry." },
    { id: "rel_shu", name: "Shu Relations", type: "number", defaultValue: 0, description: "Relations with Shu (-100 to 100)", min: -100, max: 100, category: "stat", behaviorRules: "Add from diplomacy, alliances. Subtract from attacks, insults, rivalry." },
    { id: "rel_wu", name: "Wu Relations", type: "number", defaultValue: 0, description: "Relations with Wu (-100 to 100)", min: -100, max: 100, category: "stat", behaviorRules: "Add from diplomacy, alliances. Subtract from attacks, insults, rivalry." },

    // Environment
    { id: "weather", name: "Weather", type: "string", defaultValue: "Clear", description: "Current weather conditions", category: "custom", behaviorRules: "Set each turn: Clear, Rain, Storm, Fog, Snow. Affects combat and movement." },
    { id: "wind", name: "Wind", type: "string", defaultValue: "East", description: "Wind direction", category: "custom", behaviorRules: "Set each turn: North, South, East, West. Critical for fire attacks." },

    // Commanders
    { id: "commander_1", name: "Commander 1", type: "string", defaultValue: "None", description: "First recruited commander", category: "custom", behaviorRules: "Set when a famous general joins the player. Name only (e.g., 'Zhao Yun')." },
    { id: "commander_2", name: "Commander 2", type: "string", defaultValue: "None", description: "Second recruited commander", category: "custom", behaviorRules: "Set when a second general joins. Name only." },
  ],

  rules: [
    {
      id: "tk-defeat",
      name: "Total Defeat",
      description: "Campaign lost — no troops and no gold",
      trigger: { type: "state-change" },
      conditions: [
        { variableId: "troops", operator: "lte", value: 0 },
        { variableId: "gold", operator: "lte", value: 0 },
      ],
      conditionLogic: "all",
      actions: [{ type: "send-context", message: "Your army is destroyed and your treasury is empty. The campaign has ended in defeat. Describe the fall of this warlord." }],
      priority: 100,
      enabled: true,
    },
    {
      id: "tk-low-morale",
      name: "Low Morale",
      description: "Troops on the verge of desertion",
      trigger: { type: "state-change" },
      conditions: [
        { variableId: "army_morale", operator: "lte", value: 20 },
      ],
      conditionLogic: "all",
      actions: [{ type: "send-context", message: "Army morale is critically low! Troops are on the verge of desertion. Address morale immediately or face mass abandonment." }],
      priority: 80,
      enabled: true,
    },
    {
      id: "tk-starvation",
      name: "Starvation",
      description: "Army starving — morale drops",
      trigger: { type: "state-change" },
      conditions: [
        { variableId: "provisions", operator: "lte", value: 0 },
      ],
      conditionLogic: "all",
      actions: [
        { type: "modify-variable", variableId: "army_morale", operation: "subtract", value: 15 },
        { type: "send-context", message: "The army has run out of provisions! Soldiers are starving. Morale plummets as hunger grips the camp." },
      ],
      priority: 90,
      enabled: true,
    },
    {
      id: "tk-campaign-end",
      name: "Campaign End",
      description: "10 years have passed — determine ending",
      trigger: { type: "state-change" },
      conditions: [
        { variableId: "turn", operator: "gte", value: 40 },
      ],
      conditionLogic: "all",
      actions: [{ type: "send-context", message: "Ten years have passed since you began your campaign. The era draws to a close. Based on territory, power, and alliances, determine the final outcome of this warlord's legacy." }],
      priority: 100,
      enabled: true,
    },
  ],

  components: [],
  audioTracks: [],

  customComponents: [
    {
      id: "tk-sidebar-hud",
      name: "War Council",
      tsxCode: SIDEBAR_HUD_TSX,
      description: "Sidebar showing faction, stats, resources, and commanders",
      order: 0,
      visible: true,
      updatedAt: new Date().toISOString(),
    },
  ],

  settings: {
    playerName: "Strategist",
    lorebookScanDepth: 4,
    lorebookRecursionDepth: 0,
  },
};
