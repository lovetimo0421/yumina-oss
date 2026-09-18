const SURVIVOR_ROOT_TSX = String.raw`
var {
  ChevronLeft,
  ChevronRight,
  Flame,
  Heart,
  MessageCircle,
  Moon,
  Pause,
  Play,
  RotateCcw,
  Shield,
  Sparkles,
  Swords,
  UserRound,
  Zap
} = Icons;

var ASSET_REFS = {
  battlefield: "@asset:238e1e5b-55e6-4679-97b3-308e648a071f",
  restCamp: "@asset:39ea44c4-304c-4a2e-baf8-2cf3f4b2734a",
  mira: "@asset:a85e6c63-28b8-4797-b9cd-2fb9e86aa1f8",
  kael: "@asset:50300b5e-8f49-4897-9801-c96a0967e78d",
  iona: "@asset:ee0ff964-4228-4d84-8f52-37b0d16a39c3"
};
var ASSETS = Object.assign({}, ASSET_REFS);
var IMAGE_CACHE = {};
var IMAGE_CACHE_SRC = {};

function fallbackAssetUrl(ref) {
  if (!ref) return ref;
  if (ref.indexOf("http://") === 0 || ref.indexOf("https://") === 0 || ref.indexOf("/cdn/") === 0) return ref;
  if (ref.indexOf("@asset:") === 0) return "/cdn/" + ref.slice(7);
  return ref;
}

function resolveAssetRef(api, ref) {
  try {
    if (api && typeof api.resolveAssetUrl === "function") return api.resolveAssetUrl(ref);
  } catch (error) {}
  return fallbackAssetUrl(ref);
}

function refreshAssets(api) {
  ASSETS = {
    battlefield: resolveAssetRef(api, ASSET_REFS.battlefield),
    restCamp: resolveAssetRef(api, ASSET_REFS.restCamp),
    mira: resolveAssetRef(api, ASSET_REFS.mira),
    kael: resolveAssetRef(api, ASSET_REFS.kael),
    iona: resolveAssetRef(api, ASSET_REFS.iona)
  };
}

function getAssetImage(key) {
  if (typeof Image === "undefined") return null;
  var src = ASSETS[key];
  if (!src) return null;
  if (!IMAGE_CACHE[key] || IMAGE_CACHE_SRC[key] !== src) {
    var img = new Image();
    img.crossOrigin = "anonymous";
    img.src = src;
    IMAGE_CACHE[key] = img;
    IMAGE_CACHE_SRC[key] = src;
  }
  return IMAGE_CACHE[key];
}

function drawCoverImage(ctx, img, x, y, w, h) {
  if (!img || !img.complete || !img.naturalWidth || !img.naturalHeight) return false;
  var scale = Math.max(w / img.naturalWidth, h / img.naturalHeight);
  var dw = img.naturalWidth * scale;
  var dh = img.naturalHeight * scale;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  return true;
}

function drawWorldCoverImage(ctx, img, camX, camY, screenW, screenH, mapW, mapH) {
  if (!img || !img.complete || !img.naturalWidth || !img.naturalHeight) return false;
  var scale = Math.max(mapW / img.naturalWidth, mapH / img.naturalHeight);
  var dw = img.naturalWidth * scale;
  var dh = img.naturalHeight * scale;
  var worldX = (mapW - dw) / 2;
  var worldY = (mapH - dh) / 2;
  ctx.drawImage(img, worldX - camX, worldY - camY, dw, dh);
  return true;
}

function refreshArena(run, canvas) {
  var mapW = Math.max(canvas.width * 3.2, 2480);
  var mapH = Math.max(canvas.height * 3.2, 1760);
  if (!run.arenaReady) {
    run.mapW = mapW;
    run.mapH = mapH;
    run.player.x = mapW / 2;
    run.player.y = mapH / 2;
  } else if (run.arenaW !== canvas.width || run.arenaH !== canvas.height) {
    run.mapW = mapW;
    run.mapH = mapH;
    run.player.x = clamp(run.player.x, 28, mapW - 28);
    run.player.y = clamp(run.player.y, 28, mapH - 28);
  }
  run.arenaReady = true;
  run.arenaW = canvas.width;
  run.arenaH = canvas.height;
  updateCamera(run, canvas);
}

function updateCamera(run, canvas) {
  var maxX = Math.max(0, run.mapW - canvas.width);
  var maxY = Math.max(0, run.mapH - canvas.height);
  run.cameraX = clamp(run.player.x - canvas.width / 2, 0, maxX);
  run.cameraY = clamp(run.player.y - canvas.height / 2, 0, maxY);
}

var NPCS = [
  {
    id: "mira",
    name: "Mira Voss",
    role: "Signal Witch",
    portraitKey: "mira",
    accent: "#f0b35b",
    bg: "rgba(240, 179, 91, 0.12)",
    line: "She hears patterns in enemy howls before they arrive.",
    effectTitle: "Omen Lens",
    effectText: "+46 pickup range, +18% spark XP, and a signal bolt every few seconds.",
    prompt: "You are Mira Voss, a sharp and tired signal witch in a survival camp. You speak with dry warmth, read battlefield omens, and care about the player more than you admit."
  },
  {
    id: "kael",
    name: "Kael Orro",
    role: "Field Medic",
    portraitKey: "kael",
    accent: "#69c8a6",
    bg: "rgba(105, 200, 166, 0.12)",
    line: "He keeps a ledger of wounds, jokes, and debts.",
    effectTitle: "Field Triage",
    effectText: "+24 max HP and periodic healing while you stay alive.",
    prompt: "You are Kael Orro, a field medic with calm hands and an honest tongue. You ask direct questions about pain, fear, and what the player is trying to protect."
  },
  {
    id: "iona",
    name: "Iona Vale",
    role: "Blade Saint",
    portraitKey: "iona",
    accent: "#d96c78",
    bg: "rgba(217, 108, 120, 0.12)",
    line: "She treats every quiet night as a duel with memory.",
    effectTitle: "Moon Blade",
    effectText: "Start each run with an orbiting blade and +4 spark damage.",
    prompt: "You are Iona Vale, a restrained sword master. You are poetic but concise, always testing whether the player has learned from the last battle."
  }
];

function getNpcPortrait(npc) {
  return ASSETS[npc.portraitKey] || "";
}

function getNpcById(id) {
  return NPCS.find(function(npc) { return npc.id === id; }) || NPCS[0];
}

function normalizeCompanionId(id) {
  return getNpcById(id).id;
}

function cycleCompanionId(id, delta) {
  var current = normalizeCompanionId(id);
  var index = NPCS.findIndex(function(npc) { return npc.id === current; });
  var next = (index + delta + NPCS.length) % NPCS.length;
  return NPCS[next].id;
}

var UPGRADE_POOL = [
  { id: "damage", title: "Sharper Shots", text: "+6 projectile damage", apply: function(run) { run.player.damage += 6; run.upgrades.damage += 1; } },
  { id: "rate", title: "Faster Pulse", text: "-12% attack cooldown", apply: function(run) { run.player.fireRate = Math.max(0.16, run.player.fireRate * 0.88); run.upgrades.rate += 1; } },
  { id: "speed", title: "Boot Charm", text: "+14 movement speed", apply: function(run) { run.player.speed += 14; run.upgrades.speed += 1; } },
  { id: "magnet", title: "Gravestone Magnet", text: "+34 pickup range", apply: function(run) { run.player.magnet += 34; run.upgrades.magnet += 1; } },
  { id: "maxhp", title: "Thicker Blood", text: "+16 max HP and heal 16", apply: function(run) { run.player.maxHp += 16; run.player.hp = Math.min(run.player.maxHp, run.player.hp + 16); run.upgrades.maxhp += 1; } },
  { id: "multishot", title: "Split Rune", text: "+1 extra projectile", apply: function(run) { run.player.projectiles += 1; run.upgrades.multishot += 1; } },
  { id: "orbit", title: "Moon Blade", text: "+1 orbiting blade", apply: function(run) { run.player.orbits += 1; run.upgrades.orbit += 1; } }
];

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function dist(a, b, c, d) {
  var dx = a - c;
  var dy = b - d;
  return Math.sqrt(dx * dx + dy * dy);
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function getRel(vars, id) {
  var key = id === "mira" ? "rel_mira" : id === "kael" ? "rel_kael" : "rel_iona";
  return Number(vars[key]) || 0;
}

function setRel(api, vars, id, delta) {
  var key = id === "mira" ? "rel_mira" : id === "kael" ? "rel_kael" : "rel_iona";
  var source = api && api.variables ? api.variables : vars;
  var current = Number(source[key]);
  if (!Number.isFinite(current)) current = Number(vars[key]);
  if (!Number.isFinite(current)) current = 0;
  var next = clamp(current + delta, -100, 100);
  api.setVariable(key, next);
  return next;
}

var BUILD_KEYS = ["damage", "rate", "speed", "magnet", "maxhp", "multishot", "orbit"];

function normalizeBuild(raw) {
  var source = raw && typeof raw === "object" ? raw : {};
  var build = {};
  for (var i = 0; i < BUILD_KEYS.length; i += 1) {
    var key = BUILD_KEYS[i];
    build[key] = Math.max(0, Number(source[key]) || 0);
  }
  return build;
}

function cloneBuild(build) {
  return normalizeBuild(build);
}

function applyBuild(run, build) {
  var saved = normalizeBuild(build);
  run.upgrades = saved;
  run.player.damage += saved.damage * 6;
  run.player.fireRate = Math.max(0.16, run.player.fireRate * Math.pow(0.88, saved.rate));
  run.player.speed += saved.speed * 14;
  run.player.magnet += saved.magnet * 34;
  run.player.maxHp += saved.maxhp * 16;
  run.player.hp = run.player.maxHp;
  run.player.projectiles += saved.multishot;
  run.player.orbits += saved.orbit;
}

function countBuild(build) {
  var saved = normalizeBuild(build);
  var total = 0;
  for (var i = 0; i < BUILD_KEYS.length; i += 1) total += saved[BUILD_KEYS[i]];
  return total;
}

function buildSummary(build) {
  var saved = normalizeBuild(build);
  var parts = [];
  if (saved.damage) parts.push("Damage +" + saved.damage);
  if (saved.rate) parts.push("Pulse +" + saved.rate);
  if (saved.speed) parts.push("Speed +" + saved.speed);
  if (saved.magnet) parts.push("Magnet +" + saved.magnet);
  if (saved.maxhp) parts.push("Blood +" + saved.maxhp);
  if (saved.multishot) parts.push("Split +" + saved.multishot);
  if (saved.orbit) parts.push("Moon +" + saved.orbit);
  return parts.length ? parts.join(" / ") : "No permanent skills yet";
}

function relationshipTone(rel) {
  if (rel >= 24) return "trusting and unusually open";
  if (rel >= 10) return "warmer than before";
  if (rel <= -10) return "guarded and careful";
  return "watchful but willing to talk";
}

function fallbackNpcReply(npc, rel, vars, text) {
  var wave = Number(vars.survivor_wave) || 1;
  var kills = Number(vars.survivor_last_kills) || 0;
  if (npc.id === "mira") {
    return "Mira studies the field static, then answers in a low voice. \"Wave " + wave + " left a pattern. " + kills + " sparks went dark around you, and you are still here. Say that again, but slower. I want to know which part frightened you, not which part you survived.\"";
  }
  if (npc.id === "kael") {
    return "Kael sets a cup beside you before replying. \"Your hands are still shaking. That is not failure, it is the body keeping records. Tell me what hurt, and I will tell you what can wait until morning.\"";
  }
  return "Iona looks toward the ash gate, then back to you. \"A blade does not remember every cut. It remembers the lesson. Speak plainly: what did the field teach you this time?\"";
}

function getWaveIntel(wave, scoutNote) {
  var tag = wave % 4;
  var scouted = scoutNote && scoutNote !== "none";
  if (tag === 1) {
    return {
      kind: "swarm",
      label: "Swarm pressure",
      text: (scouted ? "Scout confirms: " : "") + "Fast ash thralls will arrive in dense packs. Magnet range and rate upgrades pay off here."
    };
  }
  if (tag === 2) {
    return {
      kind: "brutes",
      label: "Elite breach",
      text: (scouted ? "Scout confirms: " : "") + "Heavier elites are pushing through the south veil. Burst damage and Moon Blade control are valuable."
    };
  }
  if (tag === 3) {
    return {
      kind: "night",
      label: "Blackout field",
      text: (scouted ? "Scout confirms: " : "") + "Visibility drops and enemies move faster. Kael's sustain and movement speed reduce the risk."
    };
  }
  return {
    kind: "balanced",
    label: "Mixed incursion",
    text: (scouted ? "Scout confirms: " : "") + "A mixed wave is forming. Bring the ally whose bond perk best fits your build."
  };
}

function makeScoutReport(vars, npc) {
  var wave = Math.max(1, Number(vars.survivor_wave) || 1);
  var intel = getWaveIntel(wave, "scouted");
  if (npc.id === "mira") return npc.name + " triangulates the omen static for wave " + wave + ": " + intel.text;
  if (npc.id === "kael") return npc.name + " checks casualty routes for wave " + wave + ": " + intel.text;
  return npc.name + " reads the ash gate stance for wave " + wave + ": " + intel.text;
}

function trainingForNpc(npcId) {
  if (npcId === "mira") return { key: "magnet", label: "Sensor Drill", text: "+1 Magnet training" };
  if (npcId === "kael") return { key: "maxhp", label: "Triage Drill", text: "+1 Blood training" };
  return { key: "damage", label: "Blade Drill", text: "+1 Damage training" };
}

function relationshipPerkText(run) {
  var rel = Number(run.companionRel) || 0;
  if (rel < 10) return "Bond perk locked at 10.";
  if (run.companionId === "mira") return rel >= 24 ? "Mira bond: rapid omen bolts and extra spark XP." : "Mira bond: sharper omen bolts and bonus spark XP.";
  if (run.companionId === "kael") return rel >= 24 ? "Kael bond: death ward and stronger field triage." : "Kael bond: one death ward per run.";
  return rel >= 24 ? "Iona bond: second vow blade and stronger orbit cuts." : "Iona bond: stronger orbit cuts.";
}

function applyRelationshipUnlocks(run, vars) {
  var rel = getRel(vars, run.companionId);
  run.companionRel = rel;
  run.deathSave = false;
  if (rel < 10) return;

  if (run.companionId === "mira") {
    run.player.magnet += 20;
    run.xpBonus += rel >= 24 ? 0.12 : 0.07;
    if (run.companion) run.companion.signalTimer = Math.min(run.companion.signalTimer || 1.2, rel >= 24 ? 0.65 : 1.0);
  }

  if (run.companionId === "kael") {
    run.deathSave = true;
    run.player.maxHp += rel >= 24 ? 16 : 8;
    run.player.hp = run.player.maxHp;
  }

  if (run.companionId === "iona") {
    run.player.damage += rel >= 24 ? 8 : 4;
    if (rel >= 24) run.player.orbits += 1;
  }
}

function applyCompanion(run, companionId) {
  var id = normalizeCompanionId(companionId);
  run.companionId = id;
  run.companion = {
    id: id,
    signalTimer: id === "mira" ? 2.1 : 0,
    healTimer: id === "kael" ? 1.8 : 0
  };
  run.xpBonus = 0;

  if (id === "mira") {
    run.player.magnet += 46;
    run.xpBonus = 0.18;
  }

  if (id === "kael") {
    run.player.maxHp += 24;
    run.player.hp = run.player.maxHp;
  }

  if (id === "iona") {
    run.player.orbits += 1;
    run.player.damage += 4;
  }
}

function makeRun(vars, companionId, buildOverride) {
  var wave = Math.max(1, Number(vars.survivor_wave) || 1);
  var savedBuild = normalizeBuild(buildOverride || vars.survivor_build);
  var run = {
    player: {
      x: 0,
      y: 0,
      hp: 100,
      maxHp: 100,
      speed: 188,
      fireRate: 0.52,
      fireTimer: 0.1,
      damage: 18,
      magnet: 95,
      projectiles: 1,
      orbits: 0,
      invuln: 0
    },
    wave: wave,
    time: 0,
    duration: 72,
    kills: 0,
    totalKills: Number(vars.survivor_total_kills) || 0,
    xp: 0,
    level: Math.max(1, Number(vars.survivor_level) || 1),
    spawnTimer: 1.15,
    enemies: [],
    shots: [],
    pickups: [],
    particles: [],
    texts: [],
    upgrades: normalizeBuild(savedBuild),
    companionId: normalizeCompanionId(companionId || vars.survivor_companion || "mira"),
    companion: null,
    companionRel: 0,
    deathSave: false,
    xpBonus: 0,
    waveIntel: getWaveIntel(wave, vars.survivor_scout),
    shake: 0,
    introTimer: 2.2,
    choiceSeed: 0,
    arenaReady: false,
    arenaW: 0,
    arenaH: 0,
    mapW: 0,
    mapH: 0,
    cameraX: 0,
    cameraY: 0
  };
  applyBuild(run, savedBuild);
  applyCompanion(run, run.companionId);
  applyRelationshipUnlocks(run, vars);
  return run;
}

function xpNeed(level) {
  return 44 + level * 18;
}

function getCompanionPosition(run) {
  var angle = run.time * 1.25 + (run.companionId === "mira" ? 2.8 : run.companionId === "kael" ? 2.05 : 1.35);
  return {
    x: run.player.x + Math.cos(angle) * 48,
    y: run.player.y + Math.sin(angle) * 38 + 10
  };
}

function nearestEnemy(run, x, y) {
  var best = null;
  var bestDist = Infinity;
  for (var i = 0; i < run.enemies.length; i += 1) {
    var enemy = run.enemies[i];
    var d = dist(x, y, enemy.x, enemy.y);
    if (d < bestDist) {
      best = enemy;
      bestDist = d;
    }
  }
  return best;
}

function updateCompanion(run, dt) {
  if (!run.companion) return;

  if (run.companionId === "mira") {
    run.companion.signalTimer -= dt;
    if (run.companion.signalTimer <= 0 && run.enemies.length > 0) {
      run.companion.signalTimer = run.companionRel >= 24 ? 2.15 : run.companionRel >= 10 ? 2.65 : 3.2;
      var pos = getCompanionPosition(run);
      var target = nearestEnemy(run, pos.x, pos.y);
      if (target) {
        var dx = target.x - pos.x;
        var dy = target.y - pos.y;
        var len = Math.sqrt(dx * dx + dy * dy) || 1;
        run.shots.push({
          x: pos.x,
          y: pos.y,
          vx: (dx / len) * 520,
          vy: (dy / len) * 520,
          life: 1.2,
          r: 8,
          damage: 30 + run.wave * 2 + (run.companionRel >= 24 ? 18 : run.companionRel >= 10 ? 10 : 0),
          kind: "omen"
        });
      }
    }
  }

  if (run.companionId === "kael") {
    run.companion.healTimer -= dt;
    if (run.companion.healTimer <= 0) {
      run.companion.healTimer = run.companionRel >= 24 ? 1.65 : 2.2;
      if (run.player.hp < run.player.maxHp) {
        run.player.hp = Math.min(run.player.maxHp, run.player.hp + 4 + Math.floor(run.wave / 3) + (run.companionRel >= 24 ? 4 : 0));
        run.particles.push({
          x: run.player.x,
          y: run.player.y,
          vx: 0,
          vy: -18,
          life: 0.8,
          r: 9,
          color: "#69c8a6"
        });
      }
    }
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function StatBar(props) {
  var pct = props.max > 0 ? clamp(props.value / props.max, 0, 1) : 0;
  return (
    <div style={{ minWidth: 120 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4, color: "rgba(248,250,252,0.72)", fontSize: 12 }}>
        <span>{props.label}</span>
        <span style={{ fontFamily: "monospace", color: "rgba(248,250,252,0.9)" }}>{Math.ceil(props.value)}/{Math.ceil(props.max)}</span>
      </div>
      <div style={{ height: 8, borderRadius: 999, background: "rgba(15,23,42,0.78)", overflow: "hidden", border: "1px solid rgba(255,255,255,0.07)" }}>
        <div style={{ height: "100%", width: pct * 100 + "%", background: props.color, borderRadius: 999, transition: "width 120ms linear" }} />
      </div>
    </div>
  );
}

function Pill(props) {
  return (
    <div style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
      padding: "7px 10px",
      borderRadius: 999,
      border: "1px solid rgba(255,255,255,0.12)",
      background: "rgba(8,13,18,0.62)",
      color: "rgba(248,250,252,0.86)",
      fontSize: 12,
      whiteSpace: "nowrap"
    }}>
      {props.children}
    </div>
  );
}

function ActionButton(props) {
  return (
    <button
      onClick={props.onClick}
      disabled={props.disabled}
      style={{
        border: "1px solid " + (props.border || "rgba(255,255,255,0.14)"),
        background: props.disabled ? "rgba(71,85,105,0.38)" : (props.bg || "rgba(240,179,91,0.18)"),
        color: props.disabled ? "rgba(226,232,240,0.38)" : (props.color || "#f8fafc"),
        minHeight: 42,
        padding: "10px 14px",
        borderRadius: 8,
        fontWeight: 700,
        cursor: props.disabled ? "not-allowed" : "pointer",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        boxShadow: props.disabled ? "none" : "0 10px 30px rgba(0,0,0,0.25)"
      }}
    >
      {props.icon}
      <span>{props.children}</span>
    </button>
  );
}

function Hud(props) {
  var hud = props.hud;
  var remaining = Math.max(0, Math.ceil(hud.duration - hud.time));
  return (
    <div style={{
      position: "absolute",
      left: 16,
      right: 16,
      top: 16,
      display: "flex",
      alignItems: "flex-start",
      justifyContent: "space-between",
      gap: 12,
      pointerEvents: "none",
      zIndex: 5
    }}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <Pill><Moon size={15} color="#f0b35b" /> Wave {hud.wave}</Pill>
        <Pill><Swords size={15} color="#d96c78" /> {hud.kills} kills</Pill>
        <Pill><Sparkles size={15} color="#69c8a6" /> Level {hud.level}</Pill>
        <Pill><Zap size={15} color="#e6d56a" /> {remaining}s</Pill>
        <Pill><UserRound size={15} color={hud.companionAccent || "#f8fafc"} /> {hud.companionName || "Ally"}</Pill>
      </div>
      <div style={{ width: 220, maxWidth: "38vw" }}>
        <StatBar label="HP" value={hud.hp} max={hud.maxHp} color="linear-gradient(90deg, #d96c78, #f0b35b)" />
        <div style={{ height: 8 }} />
        <StatBar label="XP" value={hud.xp} max={hud.nextXp} color="linear-gradient(90deg, #69c8a6, #87a9f4)" />
      </div>
    </div>
  );
}

function StartScreen(props) {
  var selectedNpc = getNpcById(props.selectedCompanionId);
  var build = normalizeBuild(props.build);
  var vars = props.variables || {};
  var intel = getWaveIntel(props.nextWave, vars.survivor_scout);
  var rel = getRel(vars, selectedNpc.id);
  var perk = relationshipPerkText({ companionId: selectedNpc.id, companionRel: rel });
  return (
    <div style={{
      position: "absolute",
      inset: 0,
      zIndex: 8,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: 24,
      backgroundImage: "radial-gradient(circle at 68% 42%, rgba(240,179,91,0.18), rgba(4,8,10,0) 38%), linear-gradient(90deg, rgba(2,4,8,0.96), rgba(4,8,10,0.76) 48%, rgba(4,8,10,0.38)), url(" + ASSETS.restCamp + ")",
      backgroundSize: "cover",
      backgroundPosition: "center"
    }}>
      <img src={ASSETS.restCamp} alt="" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", objectPosition: "center", opacity: 0.52, zIndex: 0 }} />
      <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, rgba(0,0,0,0.42), rgba(0,0,0,0) 18%, rgba(0,0,0,0) 76%, rgba(0,0,0,0.58)), linear-gradient(90deg, rgba(4,8,10,0.96), rgba(4,8,10,0.72) 46%, rgba(4,8,10,0.42))", zIndex: 0 }} />
      <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: 4, background: "linear-gradient(90deg, #d96c78, #f0b35b, #69c8a6)", zIndex: 1 }} />
      <div style={{ position: "relative", zIndex: 1, maxWidth: 1040, width: "100%", display: "grid", gap: 18 }}>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 16, alignItems: "end", borderBottom: "1px solid rgba(255,255,255,0.12)", paddingBottom: 14 }}>
          <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, color: "#f0b35b", fontWeight: 800, textTransform: "uppercase", letterSpacing: 0, fontSize: 12 }}>
            <Flame size={18} /> Operation Ashfall
          </div>
          <h1 style={{ margin: "10px 0 8px", color: "#fff7ed", fontSize: 64, lineHeight: 0.94, letterSpacing: 0, textShadow: "0 16px 50px rgba(0,0,0,0.72)" }}>
            Ashfall Survivors
          </h1>
          <p style={{ margin: 0, maxWidth: 620, color: "rgba(255,247,237,0.74)", fontSize: 16, lineHeight: 1.55 }}>
            Hold the ash field, harvest sparks, then return to camp where the people who matter remember what you survived.
          </p>
          </div>
          <div style={{ display: "grid", gap: 8, minWidth: 210 }}>
            <Pill><Moon size={15} color="#f0b35b" /> Wave {props.nextWave}</Pill>
            <Pill><Sparkles size={15} color="#69c8a6" /> {countBuild(build)} permanent skills</Pill>
            <Pill><UserRound size={15} color={selectedNpc.accent} /> Ally: {selectedNpc.name}</Pill>
            <Pill><Shield size={15} color="#87a9f4" /> {intel.label}</Pill>
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "58px minmax(0, 1fr) 58px", alignItems: "center", gap: 12, maxWidth: 940 }}>
          <button onClick={function() { props.onCycleCompanion(-1); }} aria-label="Previous ally" style={{ width: 52, height: 52, borderRadius: 999, border: "1px solid rgba(255,255,255,0.16)", background: "rgba(8,13,18,0.58)", color: "#f8fafc", cursor: "pointer", display: "grid", placeItems: "center" }}>
            <ChevronLeft size={26} />
          </button>
          <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 14, minHeight: 308, overflow: "hidden" }}>
          {NPCS.map(function(npc) {
            var selected = npc.id === selectedNpc.id;
            return (
              <button key={npc.id} onClick={function() { props.onSelectCompanion(npc.id); }} style={{
                width: selected ? 218 : 142,
                height: selected ? 300 : 206,
                border: "1px solid " + (selected ? npc.accent : "rgba(255,255,255,0.12)"),
                background: selected ? "linear-gradient(180deg, rgba(248,250,252,0.10), rgba(8,13,18,0.58))" : "rgba(8,13,18,0.42)",
                borderRadius: 8,
                padding: 0,
                overflow: "hidden",
                position: "relative",
                cursor: "pointer",
                color: "#f8fafc",
                boxShadow: selected ? "0 22px 70px rgba(0,0,0,0.42), 0 0 0 1px rgba(255,255,255,0.06) inset" : "0 10px 30px rgba(0,0,0,0.22)",
                transform: selected ? "translateY(-8px)" : "scale(0.92)",
                opacity: selected ? 1 : 0.62,
                transition: "width 180ms ease, height 180ms ease, transform 180ms ease, opacity 180ms ease"
              }}>
                <img src={getNpcPortrait(npc)} alt={npc.name} style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "top center", display: "block" }} />
                <div style={{ position: "absolute", inset: 0, background: selected ? "linear-gradient(0deg, rgba(4,8,10,0.92), rgba(4,8,10,0.08) 58%)" : "linear-gradient(0deg, rgba(4,8,10,0.88), rgba(4,8,10,0.20))" }} />
                <div style={{ position: "absolute", left: 12, right: 12, bottom: 12, textAlign: "left" }}>
                  <div style={{ color: npc.accent, fontWeight: 900, fontSize: selected ? 18 : 14 }}>{npc.name}</div>
                  <div style={{ color: "rgba(248,250,252,0.68)", fontSize: 12, marginTop: 3 }}>{npc.role}</div>
                </div>
              </button>
            );
          })}
          </div>
          <button onClick={function() { props.onCycleCompanion(1); }} aria-label="Next ally" style={{ width: 52, height: 52, borderRadius: 999, border: "1px solid rgba(255,255,255,0.16)", background: "rgba(8,13,18,0.58)", color: "#f8fafc", cursor: "pointer", display: "grid", placeItems: "center" }}>
            <ChevronRight size={26} />
          </button>
        </div>
        <div style={{ maxWidth: 860, border: "1px solid rgba(255,255,255,0.14)", background: "linear-gradient(180deg, rgba(248,250,252,0.08), rgba(8,13,18,0.54)), " + selectedNpc.bg, borderRadius: 8, padding: "14px 16px", display: "grid", gap: 8, boxShadow: "0 18px 60px rgba(0,0,0,0.28)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: selectedNpc.accent, fontWeight: 900, textTransform: "uppercase", fontSize: 12 }}>
            <Sparkles size={17} /> {selectedNpc.effectTitle}
          </div>
          <div style={{ color: "rgba(248,250,252,0.74)", lineHeight: 1.45, fontSize: 14 }}>{selectedNpc.effectText}</div>
          <div style={{ color: "rgba(226,232,240,0.55)", lineHeight: 1.45, fontSize: 12 }}>Loadout carried forward: {buildSummary(build)}</div>
          <div style={{ color: "rgba(135,169,244,0.78)", lineHeight: 1.45, fontSize: 12 }}>Next wave: {intel.text}</div>
          <div style={{ color: selectedNpc.accent, lineHeight: 1.45, fontSize: 12 }}>Bond {rel}: {perk}</div>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <ActionButton onClick={props.onStart} icon={<Play size={18} />} bg="linear-gradient(135deg, #d96c78, #f0b35b)" border="rgba(255,255,255,0.22)">
            Begin with {selectedNpc.name}
          </ActionButton>
          <ActionButton onClick={props.onRest} icon={<MessageCircle size={18} />} bg="rgba(105,200,166,0.16)" border="rgba(105,200,166,0.32)">
            Visit Camp
          </ActionButton>
        </div>
      </div>
    </div>
  );
}

function UpgradeOverlay(props) {
  return (
    <div style={{
      position: "absolute",
      inset: 0,
      zIndex: 10,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: 20,
      background: "rgba(4,8,10,0.74)",
      backdropFilter: "blur(8px)"
    }}>
      <div style={{ width: "min(820px, 100%)" }}>
        <div style={{ color: "#f0b35b", fontSize: 12, fontWeight: 800, textTransform: "uppercase", marginBottom: 8 }}>
          Level up
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 12 }}>
          {props.choices.map(function(choice) {
            return (
              <button key={choice.id} onClick={function() { props.onPick(choice); }} style={{
                textAlign: "left",
                border: "1px solid rgba(255,255,255,0.15)",
                background: "linear-gradient(180deg, rgba(248,250,252,0.09), rgba(248,250,252,0.035))",
                color: "#f8fafc",
                padding: 16,
                borderRadius: 8,
                minHeight: 134,
                cursor: "pointer"
              }}>
                <Sparkles size={20} color="#69c8a6" />
                <div style={{ fontSize: 17, fontWeight: 800, marginTop: 12 }}>{choice.title}</div>
                <div style={{ color: "rgba(226,232,240,0.68)", fontSize: 13, marginTop: 6, lineHeight: 1.4 }}>{choice.text}</div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function RestCamp(props) {
  var api = props.api;
  var vars = props.variables;
  var build = normalizeBuild(props.build || vars.survivor_build);
  var report = props.runReport || {};
  var deployedNpc = getNpcById(props.companionId || vars.survivor_companion || "mira");
  var activeState = React.useState(deployedNpc.id);
  var activeId = activeState[0];
  var setActiveId = activeState[1];
  var inputState = React.useState("");
  var input = inputState[0];
  var setInput = inputState[1];
  var chatState = React.useState([]);
  var chat = chatState[0];
  var setChat = chatState[1];
  var loadingState = React.useState(false);
  var loading = loadingState[0];
  var setLoading = loadingState[1];
  var errorState = React.useState("");
  var error = errorState[0];
  var setError = errorState[1];
  var modeState = React.useState("talk");
  var mode = modeState[0];
  var setMode = modeState[1];
  var actionsState = React.useState(2);
  var actions = actionsState[0];
  var setActions = actionsState[1];
  var noticeState = React.useState("");
  var notice = noticeState[0];
  var setNotice = noticeState[1];
  var scoutState = React.useState(String(vars.survivor_scout || "none"));
  var scoutNote = scoutState[0];
  var setScoutNote = scoutState[1];
  var npc = NPCS.find(function(item) { return item.id === activeId; }) || NPCS[0];
  var rel = getRel(vars, npc.id);
  var tone = relationshipTone(rel);
  var intel = getWaveIntel(Number(vars.survivor_wave) || 1, scoutNote);
  var training = trainingForNpc(npc.id);
  var reportKills = Math.max(Number(vars.survivor_last_kills) || 0, Number(report.kills) || 0);
  var reportLevel = Math.max(Number(vars.survivor_level) || 1, Number(report.level) || 1);
  var reportResult = String(vars.survivor_last_result || "staging");

  function setLastAssistant(text) {
    setChat(function(prev) {
      var next = prev.slice();
      for (var i = next.length - 1; i >= 0; i -= 1) {
        if (next[i].role === "assistant" && next[i].npc === npc.id) {
          next[i] = { role: "assistant", text: text, npc: npc.id };
          return next;
        }
      }
      return next.concat([{ role: "assistant", text: text, npc: npc.id }]);
    });
  }

  function send() {
    var text = input.trim();
    if (!text || loading) return;
    setInput("");
    setError("");
    var userLine = { role: "user", text: text, npc: npc.id };
    var assistantLine = { role: "assistant", text: "", npc: npc.id };
    setChat(function(prev) { return prev.concat([userLine, assistantLine]); });
    setLoading(true);

    var runSummary = "Next wave " + (Number(vars.survivor_wave) || 1) + ", level " + (Number(vars.survivor_level) || 1) + ", last kills " + (Number(vars.survivor_last_kills) || 0) + ", total kills " + (Number(vars.survivor_total_kills) || 0) + ", deployed ally " + deployedNpc.name + ", carried skills: " + buildSummary(build) + ". Next-wave intel: " + intel.text + ". Previous camp note: " + String(vars.camp_summary || "none");
    var recentCamp = chat.filter(function(line) { return line.npc === npc.id; }).slice(-6).map(function(line) {
      return (line.role === "user" ? "Player" : npc.name) + ": " + line.text;
    }).join("\n");
    var completion = api.ai && typeof api.ai.complete === "function"
      ? api.ai.complete({
      model: api.selectedModel || undefined,
      maxTokens: 520,
      temperature: 0.88,
      messages: [
        { role: "system", content: npc.prompt + " You are speaking inside the Yumina rest-camp UI after an action wave. Reply as the NPC, not as a narrator. Relationship tone toward the player is " + tone + " (bond " + rel + "). Acknowledge the current run state when it matters. Keep the reply under 120 words. Ask one concrete follow-up or offer one tactical/emotional response. Do not mention prompts, models, or being an AI." },
        { role: "user", content: "Current campaign state: " + runSummary + "\nRecent camp exchange:\n" + (recentCamp || "none") + "\nPlayer says: " + text }
      ],
      onDelta: function(delta) {
        setChat(function(prev) {
          var next = prev.slice();
          var last = next[next.length - 1];
          if (last && last.role === "assistant") {
            next[next.length - 1] = { role: "assistant", text: last.text + delta, npc: npc.id };
          }
          return next;
        });
      }
    })
      : Promise.resolve("");

    completion.then(function(full) {
      var reply = full && full.trim() ? full : fallbackNpcReply(npc, rel, vars, text);
      setChat(function(prev) {
        var next = prev.slice();
        for (var i = next.length - 1; i >= 0; i -= 1) {
          if (next[i].role === "assistant" && next[i].npc === npc.id && !next[i].text) {
            next[i] = { role: "assistant", text: reply, npc: npc.id };
            break;
          }
        }
        return next;
      });
      var nextRel = setRel(api, vars, npc.id, 2);
      var summary = npc.name + " spoke with the player before wave " + (Number(vars.survivor_wave) || 1) + ". Relationship is now " + nextRel + ". Carried skills: " + buildSummary(build) + ". Topic: " + text;
      api.setVariable("last_rest_npc", npc.name);
      api.setVariable("camp_summary", summary);
      api.injectContext(summary + "\nNPC reply: " + reply, { role: "system" });
    }).catch(function(e) {
      var reply = fallbackNpcReply(npc, rel, vars, text);
      setLastAssistant(reply);
      setError("");
      var nextRel = setRel(api, vars, npc.id, 1);
      var summary = npc.name + " answered locally after a comms interruption before wave " + (Number(vars.survivor_wave) || 1) + ". Relationship is now " + nextRel + ". Topic: " + text;
      api.setVariable("last_rest_npc", npc.name);
      api.setVariable("camp_summary", summary);
      api.injectContext(summary + "\nNPC reply: " + reply, { role: "system" });
    }).finally(function() {
      setLoading(false);
    });
  }

  function train() {
    if (actions <= 0) {
      setNotice("No prep actions remain. Deploy when ready.");
      return;
    }
    setActions(actions - 1);
    var plan = trainingForNpc(npc.id);
    if (typeof props.onTrain === "function") props.onTrain(npc.id);
    var nextRel = setRel(api, vars, npc.id, 1);
    var summary = npc.name + " ran " + plan.label + " before wave " + (Number(vars.survivor_wave) || 1) + ". " + plan.text + ". Relationship is now " + nextRel + ".";
    setNotice(plan.text + " added to the carried build.");
    setChat(function(prev) {
      return prev.concat([{ role: "assistant", text: npc.name + " runs the drill until your breathing matches the camp alarms. " + plan.text + " is now part of the next sortie.", npc: npc.id }]);
    });
    api.setVariable("last_rest_npc", npc.name);
    api.setVariable("camp_summary", summary);
    api.injectContext(summary, { role: "system" });
  }

  function scout() {
    if (actions <= 0) {
      setNotice("No prep actions remain. The field will not wait much longer.");
      return;
    }
    setActions(actions - 1);
    var reportText = makeScoutReport(vars, npc);
    setScoutNote(reportText);
    if (typeof props.onScout === "function") props.onScout(reportText);
    var nextRel = setRel(api, vars, npc.id, 1);
    var summary = npc.name + " scouted the next wave. " + reportText + " Relationship is now " + nextRel + ".";
    setNotice("Scout report locked for the next wave.");
    setChat(function(prev) {
      return prev.concat([{ role: "assistant", text: reportText, npc: npc.id }]);
    });
    api.setVariable("last_rest_npc", npc.name);
    api.setVariable("camp_summary", summary);
    api.injectContext(summary, { role: "system" });
  }

  return (
    <div style={{
      position: "absolute",
      inset: 0,
      zIndex: 9,
      display: "grid",
      gridTemplateColumns: "310px minmax(0, 1fr)",
      backgroundImage: "radial-gradient(circle at 64% 30%, rgba(105,200,166,0.16), rgba(4,8,10,0) 34%), linear-gradient(90deg, rgba(4,8,10,0.92), rgba(4,8,10,0.72)), url(" + ASSETS.restCamp + ")",
      backgroundSize: "cover",
      backgroundPosition: "center",
      color: "#f8fafc"
    }}>
      <img src={ASSETS.restCamp} alt="" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", objectPosition: "center", opacity: 0.5, zIndex: 0 }} />
      <div style={{ position: "absolute", inset: 0, background: "linear-gradient(90deg, rgba(4,8,10,0.9), rgba(4,8,10,0.68))", zIndex: 0 }} />
      <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: 4, background: "linear-gradient(90deg, #69c8a6, #f0b35b, #d96c78)", zIndex: 2 }} />
      <div style={{ position: "relative", zIndex: 1, borderRight: "1px solid rgba(255,255,255,0.12)", background: "rgba(4,8,10,0.58)", backdropFilter: "blur(10px)", padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "grid", gap: 4, marginBottom: 4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#f0b35b", fontWeight: 900, fontSize: 14, textTransform: "uppercase" }}>
            <Flame size={18} /> Field Camp
          </div>
          <div style={{ color: "rgba(226,232,240,0.54)", fontSize: 12 }}>Wave {Number(vars.survivor_wave) || 1} staging / carried build intact</div>
        </div>
        <div style={{ border: "1px solid rgba(255,255,255,0.10)", background: "rgba(8,13,18,0.48)", borderRadius: 8, padding: 10, display: "grid", gap: 7, marginBottom: 4 }}>
          <div style={{ color: "#f0b35b", fontWeight: 900, fontSize: 12, textTransform: "uppercase" }}>Battle Report</div>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, color: "rgba(248,250,252,0.72)", fontSize: 12 }}><span>Result</span><strong style={{ color: "#f8fafc" }}>{reportResult}</strong></div>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, color: "rgba(248,250,252,0.72)", fontSize: 12 }}><span>Kills / Level</span><strong style={{ color: "#f8fafc" }}>{reportKills} / {reportLevel}</strong></div>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, color: "rgba(248,250,252,0.72)", fontSize: 12 }}><span>Loadout</span><strong style={{ color: "#69c8a6" }}>{countBuild(build)} skills</strong></div>
          <div style={{ color: "rgba(226,232,240,0.52)", fontSize: 11, lineHeight: 1.35 }}>{buildSummary(build)}</div>
        </div>
        <div style={{ border: "1px solid rgba(135,169,244,0.20)", background: "rgba(8,13,18,0.48)", borderRadius: 8, padding: 10, display: "grid", gap: 9 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <strong style={{ color: "#87a9f4", fontSize: 12, textTransform: "uppercase" }}>Prep Actions</strong>
            <span style={{ color: "rgba(248,250,252,0.68)", fontSize: 12 }}>{actions} left</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 6 }}>
            {[
              { id: "talk", label: "Talk" },
              { id: "train", label: "Train" },
              { id: "scout", label: "Scout" }
            ].map(function(item) {
              var selected = mode === item.id;
              return (
                <button key={item.id} onClick={function() { setMode(item.id); }} style={{
                  border: "1px solid " + (selected ? npc.accent : "rgba(255,255,255,0.10)"),
                  background: selected ? npc.bg : "rgba(4,8,10,0.38)",
                  color: selected ? "#f8fafc" : "rgba(226,232,240,0.68)",
                  borderRadius: 7,
                  padding: "8px 6px",
                  fontWeight: 800,
                  fontSize: 12,
                  cursor: "pointer"
                }}>{item.label}</button>
              );
            })}
          </div>
          <div style={{ color: "rgba(226,232,240,0.56)", fontSize: 11, lineHeight: 1.35 }}>{notice || intel.text}</div>
        </div>
        {NPCS.map(function(item) {
          var selected = item.id === activeId;
          var deployed = item.id === deployedNpc.id;
          return (
            <button key={item.id} onClick={function() { setActiveId(item.id); }} style={{
              textAlign: "left",
              border: "1px solid " + (selected ? item.accent : "rgba(255,255,255,0.1)"),
              background: selected ? item.bg : "rgba(8,13,18,0.42)",
              color: "#f8fafc",
              padding: 10,
              borderRadius: 8,
              cursor: "pointer",
              display: "grid",
              gridTemplateColumns: "42px minmax(0, 1fr)",
              gap: 10,
              alignItems: "center"
            }}>
              <div style={{ width: 42, height: 54, borderRadius: 7, overflow: "hidden", border: "1px solid " + (selected ? item.accent : "rgba(255,255,255,0.12)"), background: "rgba(4,8,10,0.66)" }}>
                <img src={getNpcPortrait(item)} alt={item.name} style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "top center", display: "block" }} />
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <strong style={{ color: item.accent }}>{item.name}</strong>
                  <span style={{ fontFamily: "monospace", color: "rgba(248,250,252,0.55)" }}>{getRel(vars, item.id)}</span>
                </div>
                <div style={{ color: "rgba(226,232,240,0.58)", fontSize: 12, marginTop: 3 }}>{item.role}{deployed ? " / deployed" : ""}</div>
              </div>
            </button>
          );
        })}
        <div style={{ marginTop: "auto", display: "grid", gap: 8 }}>
          <ActionButton onClick={props.onNextRun} icon={<Play size={17} />} bg="linear-gradient(135deg, #69c8a6, #f0b35b)" border="rgba(255,255,255,0.18)">
            Deploy Wave {Number(vars.survivor_wave) || 1}
          </ActionButton>
          <ActionButton onClick={props.onTitle} icon={<Pause size={17} />} bg="rgba(248,250,252,0.08)">
            Hold Here
          </ActionButton>
        </div>
      </div>
      <div style={{ position: "relative", zIndex: 1, minWidth: 0, display: "grid", gridTemplateRows: "auto 1fr auto", padding: 20, gap: 14, background: "rgba(4,8,10,0.28)", backdropFilter: "blur(3px)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 14 }}>
          <div>
            <div style={{ color: npc.accent, fontSize: 28, fontWeight: 900 }}>{npc.name}</div>
            <div style={{ color: "rgba(226,232,240,0.62)", marginTop: 4 }}>{npc.line}</div>
            <div style={{ color: "rgba(248,250,252,0.42)", marginTop: 6, fontSize: 12, textTransform: "uppercase" }}>Relationship: {tone}</div>
          </div>
          <Pill><Heart size={15} color={npc.accent} /> Bond {rel}</Pill>
        </div>
        <div style={{ border: "1px solid rgba(255,255,255,0.12)", background: "linear-gradient(180deg, rgba(248,250,252,0.08), rgba(8,13,18,0.44)), " + npc.bg, borderRadius: 8, padding: 12, display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 12, alignItems: "center" }}>
          <div>
            <div style={{ color: npc.accent, fontWeight: 900, fontSize: 12, textTransform: "uppercase" }}>
              {mode === "train" ? training.label : mode === "scout" ? intel.label : "Camp Talk"}
            </div>
            <div style={{ color: "rgba(248,250,252,0.72)", fontSize: 13, lineHeight: 1.45, marginTop: 5 }}>
              {mode === "train" ? training.text + " for the persistent build. Training also nudges this ally's bond." : mode === "scout" ? intel.text : "Chat is freeform and AI-backed. The reply uses the current wave, build, last battle, and this ally's bond."}
            </div>
          </div>
          {mode === "train" && (
            <ActionButton onClick={train} disabled={actions <= 0} icon={<Sparkles size={17} />} bg="rgba(240,179,91,0.18)" border="rgba(240,179,91,0.30)">
              Run Drill
            </ActionButton>
          )}
          {mode === "scout" && (
            <ActionButton onClick={scout} disabled={actions <= 0} icon={<Shield size={17} />} bg="rgba(135,169,244,0.18)" border="rgba(135,169,244,0.30)">
              Scout Wave
            </ActionButton>
          )}
          {mode === "talk" && (
            <Pill><MessageCircle size={15} color={npc.accent} /> AI camp scene</Pill>
          )}
        </div>
        <div style={{ minHeight: 0, display: "grid", gridTemplateColumns: "minmax(220px, 34%) minmax(0, 1fr)", gap: 14 }}>
          <div style={{
            minHeight: 0,
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 8,
            overflow: "hidden",
            background: "rgba(8,13,18,0.52)",
            position: "relative"
          }}>
            <img src={getNpcPortrait(npc)} alt={npc.name} style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "top center", display: "block" }} />
            <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, padding: 12, background: "linear-gradient(0deg, rgba(4,8,10,0.92), rgba(4,8,10,0))" }}>
              <div style={{ color: npc.accent, fontWeight: 900 }}>{npc.role}</div>
              <div style={{ color: "rgba(248,250,252,0.62)", fontSize: 12, marginTop: 3 }}>Bond {rel}</div>
            </div>
          </div>
          <div style={{ overflowY: "auto", borderTop: "1px solid rgba(255,255,255,0.08)", borderBottom: "1px solid rgba(255,255,255,0.08)", padding: "12px 0", display: "flex", flexDirection: "column", gap: 10 }}>
            {chat.filter(function(line) { return line.npc === npc.id; }).length === 0 && (
              <div style={{ color: "rgba(226,232,240,0.58)", lineHeight: 1.58, maxWidth: 680 }}>
                The field quiets, but the run is not over. {npc.name} has the latest report open: {reportKills} kills, {buildSummary(build)}. Say something and they will answer from where the campaign actually is.
              </div>
            )}
            {chat.filter(function(line) { return line.npc === npc.id; }).map(function(line, idx) {
              var mine = line.role === "user";
              return (
                <div key={idx} style={{
                  alignSelf: mine ? "flex-end" : "flex-start",
                  maxWidth: "min(680px, 88%)",
                  border: "1px solid " + (mine ? "rgba(240,179,91,0.25)" : "rgba(105,200,166,0.24)"),
                  background: mine ? "rgba(240,179,91,0.10)" : "rgba(105,200,166,0.10)",
                  padding: "10px 12px",
                  borderRadius: 8,
                  color: "rgba(248,250,252,0.88)",
                  lineHeight: 1.55,
                  whiteSpace: "pre-wrap"
                }}>{line.text || "..."}</div>
              );
            })}
            {error && <div style={{ color: "#fda4af", fontSize: 13 }}>{error}</div>}
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 10 }}>
          <input
            value={input}
            onChange={function(e) { setInput(e.target.value); }}
            onKeyDown={function(e) { if (e.key === "Enter") send(); }}
            placeholder={"Speak to " + npc.name + " before deployment"}
            style={{
              minWidth: 0,
              border: "1px solid rgba(255,255,255,0.14)",
              background: "rgba(4,8,10,0.58)",
              color: "#f8fafc",
              borderRadius: 8,
              padding: "0 12px",
              outline: "none"
            }}
          />
          <ActionButton onClick={send} disabled={loading || !input.trim()} icon={<MessageCircle size={17} />} bg="rgba(240,179,91,0.18)" border="rgba(240,179,91,0.28)">
            {loading ? "Listening" : "Talk"}
          </ActionButton>
        </div>
      </div>
    </div>
  );
}

function drawCompanion(ctx, run, camX, camY) {
  var npc = getNpcById(run.companionId);
  var pos = getCompanionPosition(run);
  var sx = pos.x - camX;
  var sy = pos.y - camY;
  var img = getAssetImage(npc.portraitKey);
  var size = 42;

  ctx.save();
  ctx.beginPath();
  ctx.arc(sx, sy, size / 2, 0, Math.PI * 2);
  ctx.clip();
  if (img && img.complete && img.naturalWidth && img.naturalHeight) {
    var scale = Math.max(size / img.naturalWidth, size / img.naturalHeight);
    var dw = img.naturalWidth * scale;
    var dh = img.naturalHeight * scale;
    ctx.drawImage(img, sx - dw / 2, sy - dh * 0.24, dw, dh);
  } else {
    ctx.fillStyle = npc.accent;
    ctx.fillRect(sx - size / 2, sy - size / 2, size, size);
  }
  ctx.restore();

  ctx.strokeStyle = npc.accent;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(sx, sy, size / 2 + 1, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = "rgba(4,8,10,0.74)";
  roundRect(ctx, sx - 20, sy + 25, 40, 16, 8);
  ctx.fill();
  ctx.fillStyle = npc.accent;
  ctx.font = "700 10px ui-sans-serif, system-ui";
  ctx.textAlign = "center";
  ctx.fillText(npc.name.split(" ")[0], sx, sy + 37);

  if (run.companionId === "mira") {
    ctx.strokeStyle = "rgba(240,179,91,0.42)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(sx, sy, 30 + Math.sin(run.time * 5) * 4, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (run.companionId === "kael") {
    ctx.strokeStyle = "rgba(105,200,166,0.34)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(sx, sy, 28 + Math.sin(run.time * 3) * 5, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawGame(ctx, canvas, run) {
  var w = canvas.width;
  var h = canvas.height;
  refreshArena(run, canvas);
  var camX = run.cameraX || 0;
  var camY = run.cameraY || 0;
  var shake = run.shake || 0;
  if (shake > 0) {
    camX = clamp(camX + (Math.random() - 0.5) * shake, 0, Math.max(0, run.mapW - w));
    camY = clamp(camY + (Math.random() - 0.5) * shake, 0, Math.max(0, run.mapH - h));
  }
  ctx.clearRect(0, 0, w, h);

  var bg = getAssetImage("battlefield");
  if (!drawWorldCoverImage(ctx, bg, camX, camY, w, h, run.mapW, run.mapH)) {
    var grd = ctx.createLinearGradient(0, 0, w, h);
    grd.addColorStop(0, "#101417");
    grd.addColorStop(0.56, "#17221d");
    grd.addColorStop(1, "#281b1f");
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, w, h);
  }

  ctx.fillStyle = "rgba(3,7,10,0.24)";
  ctx.fillRect(0, 0, w, h);

  var vignette = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.18, w / 2, h / 2, Math.max(w, h) * 0.7);
  vignette.addColorStop(0, "rgba(4,8,10,0)");
  vignette.addColorStop(1, "rgba(4,8,10,0.62)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = "rgba(248,250,252,0.12)";
  ctx.lineWidth = 2;
  ctx.strokeRect(1 - camX, 1 - camY, run.mapW - 2, run.mapH - 2);

  ctx.strokeStyle = "rgba(240,179,91,0.08)";
  ctx.lineWidth = 1;
  var grid = 70;
  var startX = -((camX % grid) + grid) % grid;
  var startY = -((camY % grid) + grid) % grid;
  for (var x = startX; x < w; x += grid) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (var y = startY; y < h; y += grid) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  ctx.strokeStyle = "rgba(105,200,166,0.13)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.ellipse(run.mapW / 2 - camX, run.mapH / 2 - camY, Math.min(w, h) * 0.34, Math.min(w, h) * 0.22, 0, 0, Math.PI * 2);
  ctx.stroke();

  for (var ash = 0; ash < 34; ash += 1) {
    var ax = (ash * 91 + run.time * 18) % (w + 40) - 20;
    var ay = (ash * 47 + Math.sin(run.time + ash) * 18) % (h + 40) - 20;
    ctx.fillStyle = ash % 3 === 0 ? "rgba(240,179,91,0.42)" : "rgba(226,232,240,0.28)";
    ctx.fillRect(ax, ay, ash % 3 === 0 ? 2 : 1, ash % 3 === 0 ? 2 : 1);
  }

  for (var i = 0; i < run.pickups.length; i += 1) {
    var p = run.pickups[i];
    var sx = p.x - camX;
    var sy = p.y - camY;
    ctx.fillStyle = "#69c8a6";
    ctx.shadowColor = "#69c8a6";
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.arc(sx, sy, 4 + Math.sin((run.time + i) * 6) * 1.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  for (var e = 0; e < run.enemies.length; e += 1) {
    var enemy = run.enemies[e];
    var ex = enemy.x - camX;
    var ey = enemy.y - camY;
    ctx.fillStyle = enemy.elite ? "#d96c78" : "#b9565f";
    ctx.strokeStyle = enemy.elite ? "#f0b35b" : "rgba(255,255,255,0.22)";
    ctx.lineWidth = enemy.elite ? 3 : 1.5;
    ctx.beginPath();
    ctx.arc(ex, ey, enemy.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    var hpPct = clamp(enemy.hp / enemy.maxHp, 0, 1);
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillRect(ex - enemy.r, ey - enemy.r - 9, enemy.r * 2, 4);
    ctx.fillStyle = "#f0b35b";
    ctx.fillRect(ex - enemy.r, ey - enemy.r - 9, enemy.r * 2 * hpPct, 4);
  }

  for (var s = 0; s < run.shots.length; s += 1) {
    var shot = run.shots[s];
    ctx.fillStyle = shot.kind === "omen" ? "#f0b35b" : shot.kind === "blade" ? "#f0b35b" : "#e6d56a";
    ctx.shadowColor = ctx.fillStyle;
    ctx.shadowBlur = 14;
    ctx.beginPath();
    ctx.arc(shot.x - camX, shot.y - camY, shot.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  for (var o = 0; o < run.player.orbits; o += 1) {
    var angle = run.time * (2.2 + o * 0.22) + (Math.PI * 2 * o) / Math.max(1, run.player.orbits);
    var ox = run.player.x + Math.cos(angle) * 54;
    var oy = run.player.y + Math.sin(angle) * 54;
    ctx.fillStyle = "#f0b35b";
    ctx.shadowColor = "#f0b35b";
    ctx.shadowBlur = 16;
    ctx.beginPath();
    ctx.arc(ox - camX, oy - camY, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  var px = run.player.x - camX;
  var py = run.player.y - camY;
  ctx.fillStyle = "rgba(105,200,166,0.18)";
  ctx.beginPath();
  ctx.arc(px, py, 28 + Math.sin(run.time * 4) * 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = run.player.invuln > 0 ? "rgba(248,250,252,0.58)" : "#f8fafc";
  ctx.strokeStyle = "#69c8a6";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(px, py - 17);
  ctx.lineTo(px + 14, py + 12);
  ctx.lineTo(px, py + 7);
  ctx.lineTo(px - 14, py + 12);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#101417";
  ctx.beginPath();
  ctx.arc(px + 4, py - 2, 3, 0, Math.PI * 2);
  ctx.fill();

  drawCompanion(ctx, run, camX, camY);

  for (var q = run.particles.length - 1; q >= 0; q -= 1) {
    var part = run.particles[q];
    ctx.globalAlpha = clamp(part.life, 0, 1);
    ctx.fillStyle = part.color;
    ctx.beginPath();
    ctx.arc(part.x - camX, part.y - camY, part.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  for (var txt = run.texts.length - 1; txt >= 0; txt -= 1) {
    var floatText = run.texts[txt];
    ctx.globalAlpha = clamp(floatText.life, 0, 1);
    ctx.fillStyle = floatText.color || "#f8fafc";
    ctx.font = "900 " + (floatText.size || 16) + "px ui-sans-serif, system-ui";
    ctx.textAlign = "center";
    ctx.fillText(floatText.text, floatText.x - camX, floatText.y - camY);
    ctx.globalAlpha = 1;
  }

  if (run.introTimer > 0) {
    var alpha = clamp(run.introTimer / 2.2, 0, 1);
    ctx.fillStyle = "rgba(4,8,10," + (0.18 + alpha * 0.34) + ")";
    ctx.fillRect(0, 0, w, h);
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(248,250,252," + (0.72 + alpha * 0.22) + ")";
    ctx.font = "900 42px ui-sans-serif, system-ui";
    ctx.fillText("WAVE " + run.wave, w / 2, h / 2 - 26);
    ctx.fillStyle = "rgba(240,179,91,0.86)";
    ctx.font = "700 14px ui-sans-serif, system-ui";
    ctx.fillText(getNpcById(run.companionId).name + " deployed / " + buildSummary(run.upgrades), w / 2, h / 2 + 8);
    ctx.fillStyle = "rgba(135,169,244,0.82)";
    ctx.font = "700 12px ui-sans-serif, system-ui";
    ctx.fillText((run.waveIntel ? run.waveIntel.label : "Field report") + " / " + relationshipPerkText(run), w / 2, h / 2 + 34);
  }
}

function updateGame(run, input, dt, canvas, setScreen, setChoices, persistRun) {
  refreshArena(run, canvas);

  run.time += dt;
  run.introTimer = Math.max(0, (run.introTimer || 0) - dt);
  run.player.invuln = Math.max(0, run.player.invuln - dt);
  run.shake = Math.max(0, (run.shake || 0) - dt * 26);
  updateCompanion(run, dt);
  var vx = 0;
  var vy = 0;
  if (input.keys.ArrowLeft || input.keys.a) vx -= 1;
  if (input.keys.ArrowRight || input.keys.d) vx += 1;
  if (input.keys.ArrowUp || input.keys.w) vy -= 1;
  if (input.keys.ArrowDown || input.keys.s) vy += 1;
  if (input.pointer.down) {
    vx += input.pointer.x + run.cameraX - run.player.x;
    vy += input.pointer.y + run.cameraY - run.player.y;
  }
  var len = Math.sqrt(vx * vx + vy * vy) || 1;
  if (vx || vy) {
    run.player.x = clamp(run.player.x + (vx / len) * run.player.speed * dt, 28, run.mapW - 28);
    run.player.y = clamp(run.player.y + (vy / len) * run.player.speed * dt, 28, run.mapH - 28);
  }
  updateCamera(run, canvas);

  run.spawnTimer -= dt;
  if (run.spawnTimer <= 0 && run.introTimer <= 0) {
    var intelKind = run.waveIntel ? run.waveIntel.kind : "balanced";
    var spawnEvery = Math.max(0.18, 0.78 - run.wave * 0.035);
    if (intelKind === "swarm") spawnEvery *= 0.74;
    if (intelKind === "brutes") spawnEvery *= 1.12;
    run.spawnTimer = spawnEvery;
    var side = Math.floor(Math.random() * 4);
    var margin = 90;
    var left = run.cameraX;
    var top = run.cameraY;
    var x = side === 0 ? left - margin : side === 1 ? left + canvas.width + margin : left + Math.random() * canvas.width;
    var y = side === 2 ? top - margin : side === 3 ? top + canvas.height + margin : top + Math.random() * canvas.height;
    x = clamp(x, 24, run.mapW - 24);
    y = clamp(y, 24, run.mapH - 24);
    var eliteChance = Math.min(0.24, 0.04 + run.wave * 0.012) + (intelKind === "brutes" ? 0.11 : 0);
    var elite = Math.random() < Math.min(0.36, eliteChance);
    var hp = (elite ? 82 : 32) + run.wave * (elite ? 18 : 7);
    if (intelKind === "swarm" && !elite) hp *= 0.82;
    if (intelKind === "brutes" && elite) hp *= 1.16;
    var enemySpeed = (elite ? 58 : 76) + Math.random() * 22 + run.wave * 2;
    if (intelKind === "night") enemySpeed += elite ? 16 : 24;
    if (intelKind === "swarm" && !elite) enemySpeed += 10;
    run.enemies.push({
      x: x,
      y: y,
      hp: hp,
      maxHp: hp,
      r: elite ? 19 : 13,
      speed: enemySpeed,
      damage: elite ? 16 : 8,
      elite: elite
    });
  }

  for (var e = run.enemies.length - 1; e >= 0; e -= 1) {
    var enemy = run.enemies[e];
    var dx = run.player.x - enemy.x;
    var dy = run.player.y - enemy.y;
    var d = Math.sqrt(dx * dx + dy * dy) || 1;
    enemy.x += (dx / d) * enemy.speed * dt;
    enemy.y += (dy / d) * enemy.speed * dt;
    if (d < enemy.r + 14 && run.player.invuln <= 0) {
      run.player.hp -= enemy.damage;
      run.player.invuln = 0.42;
      run.shake = Math.max(run.shake || 0, enemy.elite ? 9 : 5);
      run.texts.push({ x: run.player.x, y: run.player.y - 26, text: "-" + enemy.damage, life: 0.72, vy: -28, color: "#fda4af", size: 15 });
      enemy.x -= (dx / d) * 30;
      enemy.y -= (dy / d) * 30;
    }
  }

  run.player.fireTimer -= dt;
  if (run.player.fireTimer <= 0) {
    run.player.fireTimer = run.player.fireRate;
    var targets = run.enemies.slice().sort(function(a, b) {
      return dist(a.x, a.y, run.player.x, run.player.y) - dist(b.x, b.y, run.player.x, run.player.y);
    }).slice(0, run.player.projectiles);
    for (var t = 0; t < targets.length; t += 1) {
      var target = targets[t];
      var tx = target.x - run.player.x;
      var ty = target.y - run.player.y;
      var td = Math.sqrt(tx * tx + ty * ty) || 1;
      var spread = (t - (targets.length - 1) / 2) * 0.18;
      var cos = Math.cos(spread);
      var sin = Math.sin(spread);
      var nx = (tx / td) * cos - (ty / td) * sin;
      var ny = (tx / td) * sin + (ty / td) * cos;
      run.shots.push({ x: run.player.x, y: run.player.y, vx: nx * 430, vy: ny * 430, life: 1.4, r: 6, damage: run.player.damage, kind: "spark" });
    }
  }

  for (var s = run.shots.length - 1; s >= 0; s -= 1) {
    var shot = run.shots[s];
    shot.x += shot.vx * dt;
    shot.y += shot.vy * dt;
    shot.life -= dt;
    var consumed = shot.life <= 0;
    for (var h = run.enemies.length - 1; h >= 0 && !consumed; h -= 1) {
      var targetEnemy = run.enemies[h];
      if (dist(shot.x, shot.y, targetEnemy.x, targetEnemy.y) < shot.r + targetEnemy.r) {
        targetEnemy.hp -= shot.damage;
        consumed = true;
      }
    }
    if (consumed) run.shots.splice(s, 1);
  }

  if (run.player.orbits > 0) {
    var orbitDamage = run.companionId === "iona" ? 72 : 46;
    if (run.companionId === "iona" && run.companionRel >= 10) orbitDamage += run.companionRel >= 24 ? 34 : 18;
    for (var ob = 0; ob < run.player.orbits; ob += 1) {
      var angle = run.time * (2.2 + ob * 0.22) + (Math.PI * 2 * ob) / Math.max(1, run.player.orbits);
      var bx = run.player.x + Math.cos(angle) * 54;
      var by = run.player.y + Math.sin(angle) * 54;
      for (var oe = run.enemies.length - 1; oe >= 0; oe -= 1) {
        var orbitEnemy = run.enemies[oe];
        if (dist(bx, by, orbitEnemy.x, orbitEnemy.y) < 10 + orbitEnemy.r) {
          orbitEnemy.hp -= orbitDamage * dt;
        }
      }
    }
  }

  for (var dead = run.enemies.length - 1; dead >= 0; dead -= 1) {
    var dying = run.enemies[dead];
    if (dying.hp <= 0) {
      run.kills += 1;
      run.totalKills += 1;
      run.pickups.push({ x: dying.x, y: dying.y, value: dying.elite ? 18 : 7 });
      run.texts.push({ x: dying.x, y: dying.y - 16, text: dying.elite ? "+18" : "+7", life: 0.82, vy: -32, color: dying.elite ? "#f0b35b" : "#69c8a6", size: dying.elite ? 18 : 14 });
      if (dying.elite) run.shake = Math.max(run.shake || 0, 5);
      for (var p = 0; p < 4; p += 1) {
        run.particles.push({ x: dying.x, y: dying.y, vx: (Math.random() - 0.5) * 120, vy: (Math.random() - 0.5) * 120, life: 0.55, r: 2 + Math.random() * 2, color: dying.elite ? "#f0b35b" : "#d96c78" });
      }
      run.enemies.splice(dead, 1);
    }
  }

  for (var pu = run.pickups.length - 1; pu >= 0; pu -= 1) {
    var pickup = run.pickups[pu];
    var pd = dist(pickup.x, pickup.y, run.player.x, run.player.y);
    if (pd < run.player.magnet) {
      var pull = clamp(1 - pd / run.player.magnet, 0.1, 1) * 420;
      pickup.x += ((run.player.x - pickup.x) / (pd || 1)) * pull * dt;
      pickup.y += ((run.player.y - pickup.y) / (pd || 1)) * pull * dt;
    }
    if (pd < 22) {
      run.xp += pickup.value * (1 + (run.xpBonus || 0));
      run.pickups.splice(pu, 1);
    }
  }

  for (var pr = run.particles.length - 1; pr >= 0; pr -= 1) {
    var part = run.particles[pr];
    part.x += part.vx * dt;
    part.y += part.vy * dt;
    part.life -= dt * 1.8;
    if (part.life <= 0) run.particles.splice(pr, 1);
  }

  for (var ft = run.texts.length - 1; ft >= 0; ft -= 1) {
    var label = run.texts[ft];
    label.y += (label.vy || -24) * dt;
    label.life -= dt * 1.35;
    if (label.life <= 0) run.texts.splice(ft, 1);
  }

  if (run.xp >= xpNeed(run.level)) {
    run.xp -= xpNeed(run.level);
    run.level += 1;
    run.texts.push({ x: run.player.x, y: run.player.y - 42, text: "LEVEL " + run.level, life: 1.1, vy: -18, color: "#f0b35b", size: 22 });
    run.shake = Math.max(run.shake || 0, 4);
    var options = [];
    var used = {};
    while (options.length < 3) {
      var next = pick(UPGRADE_POOL);
      if (!used[next.id]) {
        used[next.id] = true;
        options.push(next);
      }
    }
    setChoices(options);
    setScreen("upgrade");
    return;
  }

  if (run.player.hp <= 0) {
    if (run.deathSave) {
      run.deathSave = false;
      run.player.hp = Math.max(28, Math.floor(run.player.maxHp * 0.36));
      run.player.invuln = 1.8;
      run.shake = Math.max(run.shake || 0, 13);
      run.texts.push({ x: run.player.x, y: run.player.y - 54, text: "KAEL WARD", life: 1.3, vy: -18, color: "#69c8a6", size: 22 });
      return;
    }
    run.player.hp = 0;
    persistRun("defeat");
    setScreen("gameover");
    return;
  }

  if (run.time >= run.duration) {
    if (run.extracting == null) {
      run.extracting = 1.1;
      run.shake = Math.max(run.shake || 0, 9);
      run.texts.push({ x: run.player.x, y: run.player.y - 64, text: "EXTRACTION", life: 1.25, vy: -10, color: "#f0b35b", size: 24 });
    }
    run.extracting -= dt;
    if (run.extracting <= 0) {
      persistRun("rest");
      setScreen("rest");
    }
  }
}

function SurvivorGame() {
  var api = useYumina();
  refreshAssets(api);
  var variables = api.variables || {};
  var companionState = React.useState(normalizeCompanionId(variables.survivor_companion || "mira"));
  var selectedCompanionId = companionState[0];
  var setSelectedCompanionId = companionState[1];
  var apiRef = React.useRef(api);
  apiRef.current = api;
  var varsRef = React.useRef(variables);
  varsRef.current = variables;
  var canvasRef = React.useRef(null);
  var inputRef = React.useRef({ keys: {}, pointer: { down: false, x: 0, y: 0 } });
  var runRef = React.useRef(null);
  if (!runRef.current) runRef.current = makeRun(variables, selectedCompanionId);

  var screenState = React.useState("title");
  var screen = screenState[0];
  var setScreen = screenState[1];
  var choicesState = React.useState([]);
  var choices = choicesState[0];
  var setChoices = choicesState[1];
  var hudState = React.useState({
    wave: runRef.current.wave,
    time: 0,
    duration: runRef.current.duration,
    kills: 0,
    totalKills: runRef.current.totalKills,
    level: runRef.current.level,
    xp: 0,
    nextXp: xpNeed(runRef.current.level),
    hp: runRef.current.player.hp,
    maxHp: runRef.current.player.maxHp,
    companionName: getNpcById(runRef.current.companionId).name,
    companionAccent: getNpcById(runRef.current.companionId).accent
  });
  var hud = hudState[0];
  var setHud = hudState[1];

  function snapshot() {
    var run = runRef.current;
    var companionNpc = getNpcById(run.companionId);
    setHud({
      wave: run.wave,
      time: run.time,
      duration: run.duration,
      kills: run.kills,
      totalKills: run.totalKills,
      level: run.level,
      xp: run.xp,
      nextXp: xpNeed(run.level),
      hp: run.player.hp,
      maxHp: run.player.maxHp,
      companionName: companionNpc.name,
      companionAccent: companionNpc.accent
    });
  }

  function persistRun(reason) {
    var run = runRef.current;
    var nextWave = reason === "rest" ? run.wave + 1 : run.wave;
    apiRef.current.setVariable("survivor_wave", nextWave);
    apiRef.current.setVariable("survivor_level", run.level);
    apiRef.current.setVariable("survivor_total_kills", run.totalKills);
    apiRef.current.setVariable("survivor_last_kills", run.kills);
    apiRef.current.setVariable("survivor_last_result", reason);
    apiRef.current.setVariable("survivor_runs", (Number(varsRef.current.survivor_runs) || 0) + (reason === "rest" || reason === "defeat" ? 1 : 0));
    apiRef.current.setVariable("rest_available", reason === "rest");
    apiRef.current.setVariable("survivor_companion", run.companionId);
    apiRef.current.setVariable("survivor_build", cloneBuild(run.upgrades));
    apiRef.current.setVariable("survivor_snapshot", {
      wave: run.wave,
      level: run.level,
      kills: run.kills,
      totalKills: run.totalKills,
      result: reason,
      companion: run.companionId,
      intel: run.waveIntel,
      build: cloneBuild(run.upgrades),
      upgrades: run.upgrades
    });
  }

  function resetRun(nextWave, companionId) {
    var vars = Object.assign({}, varsRef.current);
    vars.survivor_wave = nextWave || Math.max(1, Number(vars.survivor_wave) || 1);
    vars.survivor_companion = normalizeCompanionId(companionId || selectedCompanionId);
    vars.survivor_build = cloneBuild(runRef.current ? runRef.current.upgrades : vars.survivor_build);
    if (runRef.current && runRef.current.pendingScout) vars.survivor_scout = runRef.current.pendingScout;
    runRef.current = makeRun(vars, vars.survivor_companion, vars.survivor_build);
    runRef.current.wave = vars.survivor_wave;
    snapshot();
  }

  function startCombat(nextWave, companionId) {
    var nextCompanion = normalizeCompanionId(companionId || selectedCompanionId);
    setSelectedCompanionId(nextCompanion);
    apiRef.current.setVariable("survivor_companion", nextCompanion);
    apiRef.current.setVariable("rest_available", false);
    resetRun(nextWave, nextCompanion);
    setChoices([]);
    setScreen("combat");
  }

  React.useEffect(function() {
    function resize() {
      var canvas = canvasRef.current;
      if (!canvas) return;
      var rect = canvas.parentElement.getBoundingClientRect();
      canvas.width = Math.max(320, Math.floor(rect.width));
      canvas.height = Math.max(320, Math.floor(rect.height));
    }
    resize();
    window.addEventListener("resize", resize);
    return function() { window.removeEventListener("resize", resize); };
  }, []);

  React.useEffect(function() {
    function down(e) {
      inputRef.current.keys[e.key] = true;
    }
    function up(e) {
      inputRef.current.keys[e.key] = false;
    }
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return function() {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  React.useEffect(function() {
    var canvas = canvasRef.current;
    if (!canvas) return;
    function pos(e) {
      var rect = canvas.getBoundingClientRect();
      inputRef.current.pointer.x = e.clientX - rect.left;
      inputRef.current.pointer.y = e.clientY - rect.top;
    }
    function onDown(e) {
      inputRef.current.pointer.down = true;
      pos(e);
      canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
    }
    function onMove(e) {
      if (inputRef.current.pointer.down) pos(e);
    }
    function onUp(e) {
      inputRef.current.pointer.down = false;
      canvas.releasePointerCapture && canvas.releasePointerCapture(e.pointerId);
    }
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    return function() {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
    };
  }, []);

  React.useEffect(function() {
    var canvas = canvasRef.current;
    if (!canvas || screen !== "combat") return;
    var ctx = canvas.getContext("2d");
    var raf = 0;
    var last = performance.now();
    var hudClock = 0;
    function frame(now) {
      var dt = Math.min(0.034, (now - last) / 1000);
      last = now;
      updateGame(runRef.current, inputRef.current, dt, canvas, setScreen, setChoices, persistRun);
      drawGame(ctx, canvas, runRef.current);
      hudClock += dt;
      if (hudClock > 0.08) {
        hudClock = 0;
        snapshot();
      }
      if (screen === "combat") raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    return function() { cancelAnimationFrame(raf); };
  }, [screen]);

  React.useEffect(function() {
    var canvas = canvasRef.current;
    if (!canvas) return;
    var ctx = canvas.getContext("2d");
    drawGame(ctx, canvas, runRef.current);
  });

  function pickUpgrade(choice) {
    choice.apply(runRef.current);
    apiRef.current.setVariable("survivor_level", runRef.current.level);
    apiRef.current.setVariable("survivor_last_upgrade", choice.title);
    apiRef.current.setVariable("survivor_build", cloneBuild(runRef.current.upgrades));
    snapshot();
    setScreen("combat");
  }

  function applyCampTraining(npcId) {
    var plan = trainingForNpc(npcId);
    var choice = UPGRADE_POOL.find(function(item) { return item.id === plan.key; });
    if (choice) {
      choice.apply(runRef.current);
      apiRef.current.setVariable("survivor_last_upgrade", "Camp: " + plan.label);
      apiRef.current.setVariable("survivor_build", cloneBuild(runRef.current.upgrades));
      apiRef.current.setVariable("survivor_snapshot", {
        wave: runRef.current.wave,
        level: runRef.current.level,
        kills: runRef.current.kills,
        totalKills: runRef.current.totalKills,
        result: "camp-training",
        companion: runRef.current.companionId,
        intel: runRef.current.waveIntel,
        build: cloneBuild(runRef.current.upgrades),
        upgrades: runRef.current.upgrades
      });
      snapshot();
    }
  }

  function applyScout(reportText) {
    runRef.current.pendingScout = reportText;
    runRef.current.waveIntel = getWaveIntel(Math.max(1, Number(variables.survivor_wave) || runRef.current.wave || 1), reportText);
    apiRef.current.setVariable("survivor_scout", reportText);
  }

  var nextWave = Math.max(1, Number(variables.survivor_wave) || runRef.current.wave || 1);

  return (
    <div style={{
      width: "100%",
      height: "100%",
      position: "relative",
      overflow: "hidden",
      background: "#101417",
      color: "#f8fafc",
      fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    }}>
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block", touchAction: "none" }} />
      {screen === "combat" && <Hud hud={hud} />}
      {screen === "title" && (
        <StartScreen
          selectedCompanionId={selectedCompanionId}
          nextWave={nextWave}
          variables={variables}
          build={runRef.current.upgrades}
          onSelectCompanion={function(id) { setSelectedCompanionId(normalizeCompanionId(id)); }}
          onCycleCompanion={function(delta) {
            setSelectedCompanionId(function(current) {
              return cycleCompanionId(current, delta);
            });
          }}
          onStart={function() { startCombat(nextWave, selectedCompanionId); }}
          onRest={function() { setScreen("rest"); }}
        />
      )}
      {screen === "upgrade" && <UpgradeOverlay choices={choices} onPick={pickUpgrade} />}
      {screen === "rest" && (
        <RestCamp
          api={api}
          variables={variables}
          build={runRef.current.upgrades}
          runReport={runRef.current}
          companionId={runRef.current.companionId || selectedCompanionId}
          onTrain={applyCampTraining}
          onScout={applyScout}
          onNextRun={function() {
            var completed = runRef.current.time >= runRef.current.duration || variables.rest_available === true || variables.survivor_last_result === "rest";
            var targetWave = completed
              ? Math.max(runRef.current.wave + 1, Number(variables.survivor_wave) || 1)
              : Math.max(1, Number(variables.survivor_wave) || runRef.current.wave || 1);
            startCombat(targetWave, runRef.current.companionId || selectedCompanionId);
          }}
          onTitle={function() { setScreen("title"); }}
        />
      )}
      {screen === "gameover" && (
        <div style={{ position: "absolute", inset: 0, zIndex: 12, display: "flex", alignItems: "center", justifyContent: "center", padding: 22, background: "rgba(4,8,10,0.76)", backdropFilter: "blur(8px)" }}>
          <div style={{ width: "min(560px, 100%)", border: "1px solid rgba(217,108,120,0.34)", background: "rgba(40,27,31,0.86)", padding: 20, borderRadius: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#d96c78", fontWeight: 900, fontSize: 18 }}>
              <Shield size={20} /> The field takes you
            </div>
            <p style={{ color: "rgba(248,250,252,0.72)", lineHeight: 1.55 }}>
              You reached wave {hud.wave}, level {hud.level}, and cut down {hud.kills} enemies before the ash closed in.
            </p>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <ActionButton onClick={function() { startCombat(Math.max(1, Number(variables.survivor_wave) || 1), runRef.current.companionId || selectedCompanionId); }} icon={<RotateCcw size={17} />} bg="rgba(240,179,91,0.18)" border="rgba(240,179,91,0.28)">
                Retry
              </ActionButton>
              <ActionButton onClick={function() { setScreen("rest"); }} icon={<MessageCircle size={17} />} bg="rgba(105,200,166,0.16)" border="rgba(105,200,166,0.28)">
                Recover at Camp
              </ActionButton>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default SurvivorGame;
`;

export const SURVIVOR_WORLD_DEFINITION = {
  id: "ashfall-survivors",
  version: "25.0.0",
  name: "Ashfall Survivors",
  description:
    "A real-time survival action prototype for Yumina. Fight through a moonlit ash-field arena, level up, then return to camp for AI-driven NPC conversations, training, and scouting.",
  author: "Yumina Demo",
  entries: [
    {
      id: "ashfall-system",
      name: "System",
      content: `You are the camp narrator for Ashfall Survivors, a real-time survival game with quiet character scenes between combat runs.

The action game handles movement, enemies, damage, upgrades, and rewards. Never pretend to resolve real-time combat in chat. Your job is to make camp scenes emotionally responsive, keep NPC voices consistent, and acknowledge session variables when the player debriefs.

NPCS:
- Mira Voss, Signal Witch: dry warmth, omen-reader, protects people through information.
- Kael Orro, Field Medic: calm, direct, gentle but unsentimental.
- Iona Vale, Blade Saint: concise, disciplined, poetic, tests whether lessons were learned.

Use the variables survivor_wave, survivor_level, survivor_total_kills, survivor_last_result, survivor_companion, survivor_build, survivor_scout, last_rest_npc, camp_summary, rel_mira, rel_kael, and rel_iona as ground truth. Do not output code. If you change story state, use Yumina variable directives only at the end.`,
      role: "system",
      alwaysSend: true,
      keywords: [],
      conditions: [],
      conditionLogic: "all",
      enabled: true,
      position: 0,
      section: "system-presets" as const,
    },
    {
      id: "ashfall-greeting",
      name: "Greeting",
      content:
        "The ash field waits beyond the wire. Mira listens to the static, Kael checks your pulse, and Iona watches the blade of the moon. The run begins when you step out.",
      role: "greeting",
      alwaysSend: false,
      keywords: [],
      conditions: [],
      conditionLogic: "all",
      enabled: true,
      position: 0,
      section: "chat-history" as const,
    },
  ],
  variables: [
    {
      id: "survivor_wave",
      name: "Current Wave",
      type: "number",
      defaultValue: 1,
      min: 1,
      category: "stat",
      behaviorRules: "The next combat wave number. The real-time root component updates this after each successful run.",
    },
    {
      id: "survivor_level",
      name: "Survivor Level",
      type: "number",
      defaultValue: 1,
      min: 1,
      category: "stat",
      behaviorRules: "Player level earned through combat XP.",
    },
    {
      id: "survivor_total_kills",
      name: "Total Kills",
      type: "number",
      defaultValue: 0,
      min: 0,
      category: "stat",
      behaviorRules: "Lifetime enemies defeated across runs.",
    },
    {
      id: "survivor_last_kills",
      name: "Last Run Kills",
      type: "number",
      defaultValue: 0,
      min: 0,
      category: "stat",
      behaviorRules: "Enemies defeated in the latest run.",
    },
    {
      id: "survivor_runs",
      name: "Runs Completed",
      type: "number",
      defaultValue: 0,
      min: 0,
      category: "stat",
      behaviorRules: "Counts completed or failed combat runs.",
    },
    {
      id: "survivor_last_result",
      name: "Last Result",
      type: "string",
      defaultValue: "none",
      category: "flag",
      behaviorRules: "Latest combat result: rest, defeat, or none.",
    },
    {
      id: "survivor_last_upgrade",
      name: "Last Upgrade",
      type: "string",
      defaultValue: "none",
      category: "flag",
      behaviorRules: "Most recent level-up choice.",
    },
    {
      id: "survivor_companion",
      name: "Selected Companion",
      type: "string",
      defaultValue: "mira",
      category: "flag",
      behaviorRules: "The ally selected for the current combat run: mira, kael, or iona.",
    },
    {
      id: "survivor_build",
      name: "Persistent Build",
      type: "json",
      defaultValue: {},
      category: "stat",
      behaviorRules: "Permanent skill counts carried across rest phases and later waves.",
    },
    {
      id: "survivor_scout",
      name: "Scout Report",
      type: "string",
      defaultValue: "none",
      category: "flag",
      behaviorRules: "Latest camp scout report used to brief and slightly tune the next wave.",
    },
    {
      id: "rest_available",
      name: "Rest Available",
      type: "boolean",
      defaultValue: false,
      category: "flag",
      behaviorRules: "True after a successful wave until the next run begins.",
    },
    {
      id: "rel_mira",
      name: "Mira Bond",
      type: "number",
      defaultValue: 0,
      min: -100,
      max: 100,
      category: "relationship",
      behaviorRules: "Relationship with Mira Voss.",
    },
    {
      id: "rel_kael",
      name: "Kael Bond",
      type: "number",
      defaultValue: 0,
      min: -100,
      max: 100,
      category: "relationship",
      behaviorRules: "Relationship with Kael Orro.",
    },
    {
      id: "rel_iona",
      name: "Iona Bond",
      type: "number",
      defaultValue: 0,
      min: -100,
      max: 100,
      category: "relationship",
      behaviorRules: "Relationship with Iona Vale.",
    },
    {
      id: "last_rest_npc",
      name: "Last Rest NPC",
      type: "string",
      defaultValue: "none",
      category: "relationship",
      behaviorRules: "Name of the NPC the player last spoke with in camp.",
    },
    {
      id: "camp_summary",
      name: "Camp Summary",
      type: "string",
      defaultValue: "none",
      category: "custom",
      behaviorRules: "Short memory of recent camp conversation. The root component injects this into the next main AI turn.",
    },
    {
      id: "survivor_snapshot",
      name: "Survivor Snapshot",
      type: "json",
      defaultValue: {},
      category: "custom",
      behaviorRules: "Structured summary of the latest real-time run.",
    },
  ],
  rules: [],
  reactions: [],
  systems: [],
  scenes: [],
  components: [],
  audioTracks: [],
  customUI: [],
  rootComponent: {
    id: "ashfall-survivors-root",
    name: "Ashfall Survivors Root",
    entryFile: "index.tsx",
    files: {
      "index.tsx": SURVIVOR_ROOT_TSX,
    },
    updatedAt: new Date().toISOString(),
  },
  customTags: ["action", "survival", "npc-chat"],
  editorMode: "advanced" as const,
  settings: {
    maxTokens: 4000,
    maxContext: 64000,
    temperature: 0.9,
    playerName: "Runner",
    layoutMode: "immersive" as const,
    uiMode: "persistent" as const,
  },
  multiplayerSettings: {
    availability: "disabled" as const,
    defaultChatPolicy: "free" as const,
    defaultAiTriggerMode: "manual" as const,
    defaultRoundTimerSeconds: 15,
  },
};
