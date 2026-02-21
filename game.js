// ========================
// Dino Spawner (Canvas) + v9 "Commit-Plan Planner AI"
// Fix for: "two cacti back-to-back and it doesn't jump"
// Root cause in v8:
// - Planner returned only the immediate action at t=0.
// - If best strategy was "jump after 140ms", it returned NONE now,
//   but because we re-planned every tick, the delayed jump could be missed / shift too late.
// v9 fix:
// - Keep (commit) to the best plan for a short window and execute its timed commands.
// - Re-plan when obstacles change (signature) or after a small replanning period.
// - Slightly longer horizon to see tighter combos.
// ========================

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");

// ---------- Pixel Art Sprites (render-only; gameplay logic unchanged) ----------
const SPRITE_SCALE = 1; // visual scale only
ctx.imageSmoothingEnabled = false;

const SPRITES = {
  dino0: null,
  dino1: null,
  bird: null,
  cactus: null,
  ground: null,
};

let spritesReady = false;
let groundPattern = null;

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

(async function preloadSprites() {
  try {
    const [d0, d1, bird, cactus, ground] = await Promise.all([
      loadImage("assets/dino_0.png"),
      loadImage("assets/dino_1.png"),
      loadImage("assets/bird.png"),
      loadImage("assets/cactus.png"),
      loadImage("assets/ground.png"),
    ]);
    SPRITES.dino0 = d0;
    SPRITES.dino1 = d1;
    SPRITES.bird = bird;
    SPRITES.cactus = cactus;
    SPRITES.ground = ground;
    // Pattern is optional; if it fails for any reason we just draw stretched ground.
    try { groundPattern = ctx.createPattern(ground, "repeat"); } catch(e) { groundPattern = null; }
    spritesReady = true;
  } catch (e) {
    // Keep the baseline rectangles if assets fail to load.
    spritesReady = false;
  }
})();


function resizeCanvas() {
  // Ensure the canvas drawing buffer matches its displayed size.
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(300, Math.floor(rect.width));
  const h = Math.max(220, Math.floor(rect.height));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  // Ground is always near the bottom of the canvas.
  GROUND_Y = canvas.height - 60;
}

window.addEventListener("resize", resizeCanvas);

const ui = {
  distance: document.getElementById("distance"),
  best: document.getElementById("best"),
  eps: document.getElementById("eps"),
  lives: document.getElementById("lives"),
  pu: document.getElementById("pu"),
  milestone: document.getElementById("milestone"),
  milestoneLog: document.getElementById("milestoneLog"),
  hearts: document.getElementById("hearts"),
  activePowers: document.getElementById("activePowers"),
  lblLivesInline: document.getElementById("lblLivesInline"),
  lblPowerInline: document.getElementById("lblPowerInline"),
  // language toggle removed (English-only)
  langToggle: document.getElementById("langToggle"),
  lblDistance: document.getElementById("lblDistance"),
  lblBest: document.getElementById("lblBest"),
  lblLives: document.getElementById("lblLives"),
  lblPower: document.getElementById("lblPower"),
  lblStatus: document.getElementById("lblStatus"),
  status: document.getElementById("status"),
  cityPanelTitle: document.getElementById("cityPanelTitle"),
  cityCol: document.getElementById("cityCol"),
  statusCol: document.getElementById("statusCol"),
  cityTbody: document.getElementById("cityTbody"),
};

// English-only UI strings (gameplay logic unchanged)
const TEXT = {
  run: "RUN",
  crash: "CRASH",
  destroyed: "City destroyed: ",

  citiesTitle: "Cities",
  cityCol: "City",
  statusCol: "Status",
  statusAlive: "OK",
  statusDestroyed: "Destroyed",
  gameOver: "All Cities Destroyed — Press Restart (R)",
  distance: "Distance",
  best: "Best",
  lives: "Lives",
  power: "Power",
  status: "Status",
  restart: "Restart",
  resetPlan: "Reset Plan",
  spawnBird: "Spawn Bird",
  spawnCactus: "Spawn Cactus",
  note: "Shortcuts: (C) Cactus — (B) Bird — (R) Restart — (X) Reset.\nPowerups spawn randomly: 🛡️ Shield (3s immunity) — ⛔ Spawn Lock (blocks your spawn for 2s) — ❤️ Heart (extra life).\nMilestones: every 5000 score shows a message + spawns pause for 2s.",
  cities: ["Cairo", "Alexandria", "Giza", "Mansoura", "Tanta", "Port Said", "Suez", "Assiut", "Luxor", "Aswan", "Neon City", "Arcadia", "Verdant", "Nova Haven", "Citadel"],
};

function T(key){ return TEXT[key] || key; }

function getCityName(idx){
  const arr = Array.isArray(TEXT.cities) ? TEXT.cities : [];
  if (!arr.length) return "City";
  return arr[idx % arr.length];
}

function applyLanguage(){
  // lock document language/direction
  document.documentElement.lang = "en";
  document.documentElement.dir = "ltr";

  if (ui.lblDistance) ui.lblDistance.textContent = T("distance");
  if (ui.lblBest) ui.lblBest.textContent = T("best");
  if (ui.lblLives) ui.lblLives.textContent = T("lives");
  if (ui.lblPower) ui.lblPower.textContent = T("power");
  if (ui.lblStatus) ui.lblStatus.textContent = T("status");
  if (ui.lblLivesInline) ui.lblLivesInline.textContent = T("lives");
  if (ui.lblPowerInline) ui.lblPowerInline.textContent = T("power");

  if (btnRestart) btnRestart.textContent = T("restart");
  if (btnResetAI) btnResetAI.textContent = T("resetPlan");
  if (btnBird) btnBird.textContent = T("spawnBird");
  if (btnCactus) btnCactus.textContent = T("spawnCactus");

  const noteEl = document.getElementById("noteText");
  if (noteEl) noteEl.textContent = T("note");
  rebuildCityPanel();

}


// Cities side panel (UI-only; does not affect gameplay logic)
let cityDestroyedFlags = [];

function getCitiesArray(){
  const arr = TEXT.cities;
  return Array.isArray(arr) ? arr : [];
}

function resetCityFlags(){
  const cities = getCitiesArray();
  cityDestroyedFlags = new Array(cities.length).fill(false);
}

function rebuildCityPanel(){
  if (!ui.cityTbody) return;

  // Ensure flags are sized correctly.
  const cities = getCitiesArray();
  if (!Array.isArray(cityDestroyedFlags) || cityDestroyedFlags.length !== cities.length) {
    cityDestroyedFlags = new Array(cities.length).fill(false);
  }

  if (ui.cityPanelTitle) ui.cityPanelTitle.textContent = T('citiesTitle');
  if (ui.cityCol) ui.cityCol.textContent = T('cityCol');
  if (ui.statusCol) ui.statusCol.textContent = T('statusCol');

  ui.cityTbody.innerHTML = '';
  for (let i = 0; i < cities.length; i++) {
    const tr = document.createElement('tr');
    const tdCity = document.createElement('td');
    const tdStatus = document.createElement('td');

    tdCity.textContent = cities[i];

    const badge = document.createElement('span');
    const destroyed = !!cityDestroyedFlags[i];
    badge.className = 'cityBadge ' + (destroyed ? 'bad' : 'ok');
    badge.textContent = destroyed ? T('statusDestroyed') : T('statusAlive');
    tdStatus.appendChild(badge);

    if (destroyed) tr.classList.add('cityRowDestroyed');

    tr.appendChild(tdCity);
    tr.appendChild(tdStatus);
    ui.cityTbody.appendChild(tr);
  }
}


const btnCactus = document.getElementById("spawnCactus");
const btnBird = document.getElementById("spawnBird");
const btnRestart = document.getElementById("restart");
const btnResetAI = document.getElementById("resetAI");

// ---------- Game constants ----------
let GROUND_Y = 260;
const GRAVITY = 2400;
const JUMP_V = 820;

const DUCK_H = 26;
const STAND_H = 44;

const BASE_SPEED = 360;
const SPEED_RAMP = 8;
const OB_SPAWN_X = () => canvas.width + 40;

// Decision tick
const DECISION_DT = 0.035; // 35ms

// Fast drop behavior (duck in air)
const FAST_FALL_GRAV_MULT = 3.2;
const FAST_DROP_MIN_VY = 1150;

// Planner simulation config
const SIM_HORIZON = 3.20;   // longer horizon for triple-cactus sequences   // longer horizon for double-cactus + multi-jump
const SIM_DT = 1 / 200;     // sim timestep
const CLEAR_MARGIN = 2.0;

// Plan commitment config
const REPLAN_EVERY = 0.105; // seconds (3 ticks) minimum between replans unless obstacles changed

// ---------- State ----------
let obstacles = [];
let powerups = [];
let gameOver = false;
let t = 0;
let distance = 0;
let best = 0;
try { best = Number(localStorage.getItem("dino_spawner_best") || "0"); } catch (e) { best = 0; }

// Powerups / lives
let lives = 1;
let invincibleUntil = 0;      // seconds (game time t)
let spawnLockUntil = 0;       // seconds (game time t)
let nextPowerupAt = 0.35;      // seconds (game time t)
let lastPU = "-";

// Milestones / targets
const MILESTONE_STEP = 5000;
const MILESTONE_PAUSE = 2.0; // seconds
let nextMilestone = MILESTONE_STEP;
let cityIndex = 0;
let milestoneUntil = 0; // spawn pause window
let milestoneLog = [];  // last items


// Dino
const dino = {
  x: 120,
  y: GROUND_Y,
  vy: 0,
  w: 34,
  h: STAND_H,
  ducking: false,
  grounded: true,
};

// Dino sprite animation (render-only)
let dinoAnimT = 0;
let dinoFrame = 0; // 0 or 1

// ---------- Actions ----------
const ACTIONS = ["NONE", "JUMP", "DUCK"]; // 0,1,2

// ---------- Spawner ----------
function spawnCactus() {
  if (t < spawnLockUntil || t < milestoneUntil) return;
  const last = obstacles[obstacles.length - 1];
  if (last && last.x > canvas.width - 150) return;

  obstacles.push({
    type: "CACTUS",
    x: canvas.width + 10,
    y: GROUND_Y,
    w: 18,
    h: 42,
    passed: false,
    birdLevel: 0,
  });
}

function spawnBird() {
  if (t < spawnLockUntil || t < milestoneUntil) return;

  // 3 heights:
  // 0 = LOW  -> jump over it
  // 1 = MID  -> duck under it
  // 2 = HIGH -> duck under it (slightly higher)
  const level = (Math.random() < 0.34) ? 0 : (Math.random() < 0.52 ? 1 : 2);

  const w = 28, h = 18;

  // y here is the obstacle "bottom" (same convention as cactus)
  // Put LOW close to ground so jumping clears it; MID/HIGH float above dino head so duck is required.
  const yLow  = GROUND_Y - 10;   // almost on ground
  const yMid  = GROUND_Y - 55;   // around dino head level
  const yHigh = GROUND_Y - 80;   // higher than mid but still blocks standing run

  const y = (level === 0) ? yLow : (level === 1 ? yMid : yHigh);

  obstacles.push({
    type: "BIRD",
    x: OB_SPAWN_X(),
    y,
    w,
    h,
    birdLevel: level,
  });
}

function spawnPowerup(type) {
  // Powerups are collectibles above ground (require jump)
  const y = GROUND_Y - 90; // jump height required
  const w = 20, h = 20;
  powerups.push({
    type, // SHIELD | LOCK | HEART
    x: canvas.width + 10,
    y,
    w, h,
    taken: false,
  });
}

function scheduleNextPowerup() {
  // random interval (in seconds), scaled a bit by speed
  const base = 1.6 + Math.random() * 2.2; // 1.6..3.8
  nextPowerupAt = t + base;
}

function maybeSpawnPowerup() {
  if (t < nextPowerupAt) return;

  // Weighted random
  const r = Math.random();
  let type = "SHIELD";
  if (r < 0.40) type = "SHIELD";
  else if (r < 0.72) type = "LOCK";
  else type = "HEART";

  spawnPowerup(type);
  scheduleNextPowerup();
}

// ---------- Input ----------
// (English-only) language toggle removed

btnCactus && btnCactus.addEventListener("click", spawnCactus);
btnBird && btnBird.addEventListener("click", spawnBird);
btnRestart && btnRestart.addEventListener("click", restart);
btnResetAI && btnResetAI.addEventListener("click", () => restart());

window.addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (k === "c") spawnCactus();
  if (k === "b") spawnBird();
  if (k === "r") restart();
  if (k === "x") restart();
});

// ---------- Helpers ----------
function rectsOverlap(a, b) {
  return (
    a.x < b.x + b.w &&
    a.x + a.w > b.x &&
    (a.y - a.h) < b.y &&
    a.y > (b.y - b.h)
  );
}

function currentSpeed() {
  return BASE_SPEED + SPEED_RAMP * t;
}

function getAheadObstacles() {
  const ahead = [];
  for (const o of obstacles) {
    const dx = o.x - (dino.x + dino.w);
    if (dx >= -10) ahead.push({ o, dx });
  }
  ahead.sort((a, b) => a.dx - b.dx);
  return ahead;
}

// Signature to know if obstacle set changed materially

function pushMilestoneLog(text) {
  milestoneLog.unshift(text);
  milestoneLog = milestoneLog.slice(0, 5);
  if (!ui.milestoneLog) return;
  ui.milestoneLog.innerHTML = milestoneLog.map(t => `<div class="item">${t}</div>`).join("");
}


function renderTopLeftUI(){
  // Hearts
  if (ui.hearts){
    let html = "";
    for (let i=0;i<lives;i++){
      html += '<span class="heart" title="life"></span>';
    }
    ui.hearts.innerHTML = html || "-";
  }

  // Active powers
  if (ui.activePowers){
    const shieldLeft = Math.max(0, invincibleUntil - t);
    const lockLeft = Math.max(0, spawnLockUntil - t);
    const milestoneLeft = Math.max(0, milestoneUntil - t);

    const parts = [];
    if (shieldLeft > 0.01) parts.push(`🛡️ ${shieldLeft.toFixed(1)}s`);
    if (lockLeft > 0.01) parts.push(`⛔ ${lockLeft.toFixed(1)}s`);
    if (milestoneLeft > 0.01) parts.push(`⏸️ ${milestoneLeft.toFixed(1)}s`);

    if (parts.length === 0) parts.push("-");
    ui.activePowers.textContent = parts.join(" | ");
  }
}

function showMilestone(text) {
  if (!ui.milestone) return;
  ui.milestone.textContent = text;
  ui.milestone.classList.remove("hidden");
  // hide after 1.6s
  const localStamp = t;
  setTimeout(() => {
    // only hide if game time advanced (avoid hiding after restart)
    if (t >= localStamp) ui.milestone.classList.add("hidden");
  }, 1600);
}

function obstaclesSignature() {
  // only first few obstacles matter for planning
  const ahead = getAheadObstacles().slice(0, 3).map(({ o }) => ({
    t: o.type,
    x: Math.round(o.x),
    y: Math.round(o.y),
    w: o.w, h: o.h,
    b: o.birdLevel || 0
  }));
  const pus = powerups.slice(0, 3).map(p => ({ t: p.type, x: Math.round(p.x), y: Math.round(p.y) }));
  return JSON.stringify({ ahead, pus });
}

// ---------- Apply action to real dino ----------
function applyAction(aIdx) {
  const action = ACTIONS[aIdx];

  if (action === "JUMP") {
    if (dino.grounded) {
      dino.vy = -JUMP_V;
      dino.grounded = false;
      dino.ducking = false;
      dino.h = STAND_H;
    }
  } else if (action === "DUCK") {
    dino.ducking = true;
    dino.h = DUCK_H;

    if (!dino.grounded) {
      if (dino.vy < FAST_DROP_MIN_VY) dino.vy = FAST_DROP_MIN_VY;
    }
  } else {
    dino.ducking = false;
    dino.h = STAND_H;
  }
}

// ---------- Planner simulation ----------
function simulateStrategy(strategy, speedNow) {
  const sd = {
    x: dino.x,
    y: dino.y,
    vy: dino.vy,
    w: dino.w,
    h: dino.h,
    ducking: dino.ducking,
    grounded: dino.grounded,
  };

  const sobs = obstacles.map(o => ({
    type: o.type,
    x: o.x,
    y: o.y,
    w: o.w,
    h: o.h,
    birdLevel: o.birdLevel || 0,
  }));

  const spus = powerups.map(p => ({
    type: p.type,
    x: p.x,
    y: p.y,
    w: p.w,
    h: p.h,
    taken: false,
  }));

  let time = 0;
  let cmdIndex = 0;

  // Risk metric: minimize number of near contacts; prefer larger min clearance in x for close calls
  let minDx = Infinity;
  let nearCount = 0;

  while (time < SIM_HORIZON) {
    // Apply commands whose time has come
    while (cmdIndex < strategy.length && strategy[cmdIndex].t <= time + 1e-9) {
      const a = strategy[cmdIndex].a;

      if (a === 1) {
        if (sd.grounded) {
          sd.vy = -JUMP_V;
          sd.grounded = false;
          sd.ducking = false;
          sd.h = STAND_H;
        }
      } else if (a === 2) {
        sd.ducking = true;
        sd.h = DUCK_H;
        if (!sd.grounded) {
          if (sd.vy < FAST_DROP_MIN_VY) sd.vy = FAST_DROP_MIN_VY;
        }
      } else {
        sd.ducking = false;
        sd.h = STAND_H;
      }
      cmdIndex++;
    }

    // Physics
    const gravMult = (!sd.grounded && sd.ducking) ? FAST_FALL_GRAV_MULT : 1.0;
    sd.vy += (GRAVITY * gravMult) * SIM_DT;
    sd.y += sd.vy * SIM_DT;

    if (sd.y >= GROUND_Y) {
      sd.y = GROUND_Y;
      sd.vy = 0;
      sd.grounded = true;
    } else {
      sd.grounded = false;
    }

    // Move obstacles
    for (const o of sobs) o.x -= speedNow * SIM_DT;
    for (const p of spus) p.x -= speedNow * SIM_DT;

    // Collect powerups
  const dRectPU = { x: dino.x, y: dino.y, w: dino.w, h: dino.h };
  for (const p of powerups) {
    const pRect = { x: p.x, y: p.y, w: p.w, h: p.h };
    if (!p.taken && rectsOverlap(dRectPU, pRect)) {
      p.taken = true;
      if (p.type === "SHIELD") { invincibleUntil = Math.max(invincibleUntil, t + 3.0); lastPU = "🛡️"; }
      else if (p.type === "LOCK") { spawnLockUntil = Math.max(spawnLockUntil, t + 2.0); lastPU = "⛔"; }
      else if (p.type === "HEART") { lives = Math.min(5, lives + 1); lastPU = "❤️"; }
    }
  }

  // Collision
    const dRect = { x: sd.x, y: sd.y, w: sd.w, h: sd.h };
    for (const o of sobs) {
      const oRect = { x: o.x, y: o.y, w: o.w, h: o.h };
      const inflated = {
        x: oRect.x - CLEAR_MARGIN,
        y: oRect.y + CLEAR_MARGIN,
        w: oRect.w + 2 * CLEAR_MARGIN,
        h: oRect.h + 2 * CLEAR_MARGIN
      };
      if (rectsOverlap(dRect, inflated)) return { ok: false, score: -1e9 };

      // track near-miss in x when overlap in y band might occur soon
      const dx = o.x - (sd.x + sd.w);
      if (dx >= -25 && dx < minDx) minDx = dx;
      if (dx >= -10 && dx <= 10) nearCount++;
    }

    // Collect powerups (rewarded)
    for (const p of spus) {
      if (p.taken) continue;
      const pRect = { x: p.x, y: p.y, w: p.w, h: p.h };
      if (rectsOverlap(dRect, pRect)) p.taken = true;
    }

    time += SIM_DT;
  }

  // Score:
  // - survive (ok)
  // - fewer commands is better
  // - fewer near contacts is better
  // - larger minDx is better
  const cmdPenalty = strategy.length * 0.35;
  const nearPenalty = nearCount * 0.002;
  const dxScore = isFinite(minDx) ? minDx : 200;
  let puBonus = 0;
  for (const p of spus) if (p.taken) puBonus += (p.type === "HEART" ? 6.0 : (p.type === "SHIELD" ? 4.5 : 3.5));
  const score = dxScore - cmdPenalty - nearPenalty + puBonus;

  return { ok: true, score };
}

function buildCandidateStrategies(ahead, speedNow) {
  const candidates = [];

  candidates.push([{ t: 0, a: 0 }]); // do nothing baseline

  const jumpDelays = [0, 0.05, 0.10, 0.14, 0.18, 0.22, 0.26, 0.30, 0.34, 0.38, 0.42, 0.50, 0.58];
  const duckDelays = [0, 0.05, 0.10, 0.14, 0.18, 0.22, 0.26, 0.30, 0.36, 0.42];

  const n = ahead[0]?.o || null;
  const nDx = ahead[0]?.dx ?? Infinity;
  const nTTC = isFinite(nDx) ? (nDx / Math.max(1, speedNow)) : 9.99;

  const s = ahead[1]?.o || null;
  const sDx = ahead[1]?.dx ?? Infinity;
  const sTTC = isFinite(sDx) ? (sDx / Math.max(1, speedNow)) : 9.99;

  const t3 = ahead[2]?.o || null;
  const t3Dx = ahead[2]?.dx ?? Infinity;
  const t3TTC = isFinite(t3Dx) ? (t3Dx / Math.max(1, speedNow)) : 9.99;

  const wantDuck = (n && n.type === "BIRD" && (n.birdLevel ?? 0) >= 1);
  const wantJumpBird = (n && n.type === "BIRD" && (n.birdLevel ?? 0) === 0);

  const wantJump = ((n && n.type === "CACTUS") ||
    (s && s.type === "CACTUS" && nTTC > 0.9) ||
    (t3 && t3.type === "CACTUS" && nTTC > 1.4) ||
    wantJumpBird);

  const tripleCactus = (n && s && t3 && n.type==="CACTUS" && s.type==="CACTUS" && t3.type==="CACTUS");

  if (dino.grounded) {
    // --- Jump plans ---
    if (wantJump) {
      for (const dly of jumpDelays) {
        if (dly > nTTC + 0.65) continue;

        // 1) Single jump
        candidates.push([{ t: dly, a: 1 }]);

        // 2) Jump -> (optional) fast-drop -> stand
        for (const dropAt of [dly + 0.20, dly + 0.28, dly + 0.36, dly + 0.44, dly + 0.52]) {
          const standAt = dropAt + 0.18;
          candidates.push([{ t: dly, a: 1 }, { t: dropAt, a: 2 }, { t: standAt, a: 0 }]);

          // 3) Double jump sequence: jump -> drop -> stand -> jump2
          if (n && s && n.type === "CACTUS" && s.type === "CACTUS" && sTTC > 0.50 && sTTC < 2.10) {
            for (const j2 of [standAt + 0.16, standAt + 0.24, standAt + 0.32, standAt + 0.40, standAt + 0.48, standAt + 0.56]) {
              candidates.push([
                { t: dly, a: 1 },
                { t: dropAt, a: 2 },
                { t: standAt, a: 0 },
                { t: j2, a: 1 },
              ]);

              // 4) Triple cactus: jump -> drop -> stand -> jump2 -> drop2 -> stand2 -> jump3
              if (tripleCactus && t3TTC < 2.90) {
                for (const drop2 of [j2 + 0.18, j2 + 0.26, j2 + 0.34, j2 + 0.42]) {
                  const stand2 = drop2 + 0.18;
                  for (const j3 of [stand2 + 0.16, stand2 + 0.24, stand2 + 0.32, stand2 + 0.40, stand2 + 0.48]) {
                    candidates.push([
                      { t: dly, a: 1 },
                      { t: dropAt, a: 2 },
                      { t: standAt, a: 0 },
                      { t: j2, a: 1 },
                      { t: drop2, a: 2 },
                      { t: stand2, a: 0 },
                      { t: j3, a: 1 },
                    ]);
                  }
                }
              }
            }
          }
        }

        // 5) One-arc clearance attempts for very close cacti (late jump)
        if (n && s && n.type === "CACTUS" && s.type === "CACTUS" && sTTC < 0.95) {
          for (const late of [0.10, 0.14, 0.18, 0.22, 0.26, 0.30]) candidates.push([{ t: late, a: 1 }]);
        }
      }
    } else {
      candidates.push([{ t: 0.18, a: 1 }]);
    }

    // --- Duck plans ---
    if (wantDuck) {
      for (const dly of duckDelays) {
        if (dly > nTTC + 0.45) continue;
        candidates.push([{ t: dly, a: 2 }, { t: dly + 0.30, a: 0 }]);
      }
    } else {
      candidates.push([{ t: 0.14, a: 2 }, { t: 0.28, a: 0 }]);
    }
  } else {
    // In air: allow immediate or timed fast-drop
    candidates.push([{ t: 0, a: 2 }, { t: 0.20, a: 0 }]);
    candidates.push([{ t: 0.07, a: 2 }, { t: 0.25, a: 0 }]);
    candidates.push([{ t: 0.14, a: 2 }, { t: 0.30, a: 0 }]);
  }

  return candidates;
}


function buildBeamPlan(speedNow) {
  // Beam-search MPC planner (render/physics logic unchanged).
  // Produces a timeline of actions [{t,a}] compatible with existing plannerTick/applyAction.
  const DT_STEP = 0.05;                 // control step (seconds)
  const horizon = Math.min(3.6, Math.max(2.2, 2.2 + speedNow / 600)); // adaptive horizon
  const STEPS = Math.max(1, Math.floor(horizon / DT_STEP));
  const BEAM = 24;

  // Keep only "relevant" obstacles/powerups within horizon distance (+padding)
  const maxDist = speedNow * horizon + 260;
  const sobs0 = obstacles
    .filter(o => (o.x - dino.x) < maxDist)
    .map(o => ({
      type: o.type,
      x: o.x,
      y: o.y,
      w: o.w,
      h: o.h,
      birdLevel: o.birdLevel || 0,
    }));

  const spus0 = powerups
    .filter(p => (p.x - dino.x) < maxDist)
    .map(p => ({
      type: p.type,
      x: p.x,
      y: p.y,
      w: p.w,
      h: p.h,
      taken: false,
    }));

  const root = {
    t: 0,
    sd: {
      x: dino.x,
      y: dino.y,
      vy: dino.vy,
      w: dino.w,
      h: dino.h,
      ducking: dino.ducking,
      grounded: dino.grounded,
    },
    sobs: sobs0,
    spus: spus0,
    minDx: Infinity,
    nearCount: 0,
    switches: 0,
    jumps: 0,
    lastHold: 0,     // last "hold" action: 0 (stand) or 2 (duck)
    actions: [],     // per-step hold action (0/2); jump events recorded separately
    events: [],      // [{t,a}] including jumps and holds
    dead: false,
  };

  function nodeScore(n, final=false) {
    const dxScore = isFinite(n.minDx) ? n.minDx : 200;
    const nearPenalty = n.nearCount * 0.002;
    const switchPenalty = n.switches * 0.25;
    const jumpPenalty = n.jumps * 0.45;
    let puBonus = 0;
    for (const p of n.spus) if (p.taken) puBonus += (p.type === "HEART" ? 6.0 : (p.type === "SHIELD" ? 4.5 : 3.5));
    const surviveBonus = final ? 40.0 : 0.0;
    return dxScore - nearPenalty - switchPenalty - jumpPenalty + puBonus + surviveBonus;
  }

  function cloneNode(n) {
    return {
      t: n.t,
      sd: { ...n.sd },
      sobs: n.sobs.map(o => ({ ...o })),
      spus: n.spus.map(p => ({ ...p })),
      minDx: n.minDx,
      nearCount: n.nearCount,
      switches: n.switches,
      jumps: n.jumps,
      lastHold: n.lastHold,
      actions: n.actions.slice(),
      events: n.events.slice(),
      dead: n.dead,
    };
  }

  function applyHold(sd, a) {
    if (a === 2) {
      sd.ducking = true;
      sd.h = DUCK_H;
      if (!sd.grounded) {
        if (sd.vy < FAST_DROP_MIN_VY) sd.vy = FAST_DROP_MIN_VY;
      }
    } else {
      sd.ducking = false;
      sd.h = STAND_H;
    }
  }

  function applyJump(sd) {
    if (sd.grounded) {
      sd.vy = -JUMP_V;
      sd.grounded = false;
      sd.ducking = false;
      sd.h = STAND_H;
      return true;
    }
    return false;
  }

  function stepSim(n, stepDur) {
    const subSteps = Math.max(1, Math.floor(stepDur / SIM_DT));
    for (let i = 0; i < subSteps; i++) {
      // physics
      const gravMult = (!n.sd.grounded && n.sd.ducking) ? FAST_FALL_GRAV_MULT : 1.0;
      n.sd.vy += (GRAVITY * gravMult) * SIM_DT;
      n.sd.y += n.sd.vy * SIM_DT;

      if (n.sd.y >= GROUND_Y) {
        n.sd.y = GROUND_Y;
        n.sd.vy = 0;
        n.sd.grounded = true;
      } else {
        n.sd.grounded = false;
      }

      // move obstacles/powerups
      for (const o of n.sobs) o.x -= speedNow * SIM_DT;
      for (const p of n.spus) p.x -= speedNow * SIM_DT;

      // collision + risk
      const dRect = { x: n.sd.x, y: n.sd.y, w: n.sd.w, h: n.sd.h };
      for (const o of n.sobs) {
        const oRect = { x: o.x, y: o.y, w: o.w, h: o.h };
        const inflated = {
          x: oRect.x - CLEAR_MARGIN,
          y: oRect.y + CLEAR_MARGIN,
          w: oRect.w + 2 * CLEAR_MARGIN,
          h: oRect.h + 2 * CLEAR_MARGIN
        };
        if (rectsOverlap(dRect, inflated)) {
          n.dead = true;
          return;
        }
        const dx = o.x - (n.sd.x + n.sd.w);
        if (dx >= -25 && dx < n.minDx) n.minDx = dx;
        if (dx >= -10 && dx <= 10) n.nearCount++;
      }

      // powerups (rewarded)
      for (const p of n.spus) {
        if (p.taken) continue;
        const pRect = { x: p.x, y: p.y, w: p.w, h: p.h };
        if (rectsOverlap(dRect, pRect)) p.taken = true;
      }
    }
  }

  // Beam search loop
  let beam = [root];
  for (let si = 0; si < STEPS; si++) {
    const nextBeam = [];

    for (const n of beam) {
      if (n.dead) continue;

      // Branching options:
      // 1) Keep/Set stand (0)
      // 2) Keep/Set duck (2)
      // 3) Jump now (1) + default stand hold for this step
      const options = [];

      options.push({ kind: "HOLD", a: 0 });
      options.push({ kind: "HOLD", a: 2 });

      if (n.sd.grounded) options.push({ kind: "JUMP" });

      for (const opt of options) {
        const c = cloneNode(n);

        // record time at step start
        const t0 = c.t;

        if (opt.kind === "HOLD") {
          const holdA = opt.a;
          // count switches for hold actions only
          if (holdA !== c.lastHold) c.switches += 1;
          c.lastHold = holdA;

          applyHold(c.sd, holdA);

          // record events for holds when they change
          const lastEv = c.events[c.events.length - 1];
          if (!lastEv || lastEv.a !== holdA) c.events.push({ t: t0, a: holdA });

        } else { // JUMP
          const ok = applyJump(c.sd);
          if (!ok) continue;
          c.jumps += 1;
          c.lastHold = 0;
          // record jump event
          c.events.push({ t: t0, a: 1 });
          // after jump, default to stand during this step
          applyHold(c.sd, 0);
          const lastEv = c.events[c.events.length - 1];
          if (!lastEv || lastEv.a !== 0) c.events.push({ t: t0 + 0.0001, a: 0 });
        }

        // simulate forward one control step
        stepSim(c, DT_STEP);
        c.t += DT_STEP;

        if (!c.dead) nextBeam.push(c);
      }
    }

    if (nextBeam.length === 0) break;

    // keep top BEAM nodes
    nextBeam.sort((a, b) => nodeScore(b, false) - nodeScore(a, false));
    beam = nextBeam.slice(0, BEAM);
  }

  // pick best surviving node (or best partial)
  beam.sort((a, b) => nodeScore(b, true) - nodeScore(a, true));
  const best = beam[0] || root;

  // Ensure plan is non-empty and sorted
  const plan = (best.events.length ? best.events : [{ t: 0, a: 0 }]).slice().sort((a,b)=>a.t-b.t);

  // de-duplicate extremely close events
  const out = [];
  for (const e of plan) {
    const prev = out[out.length - 1];
    if (!prev) { out.push(e); continue; }
    if (Math.abs(prev.t - e.t) < 1e-4 && prev.a === e.a) continue;
    out.push(e);
  }
  return out;
}

function planBestStrategy() { 
  const speedNow = currentSpeed();
  const ahead = getAheadObstacles();
  if (ahead.length === 0) return [{ t: 0, a: 0 }];
  return buildBeamPlan(speedNow);
}


// ---------- Plan commitment (the main fix) ----------
let activePlan = [{ t: 0, a: 0 }];
let planElapsed = 0;           // seconds since plan start
let planSig = "";
let sinceReplan = 0;

function plannerTick(dt) {
  planElapsed += dt;
  sinceReplan += dt;

  const sig = obstaclesSignature();

  const needReplan = (sig !== planSig) || (sinceReplan >= REPLAN_EVERY) || gameOver;

  if (needReplan) {
    activePlan = planBestStrategy();
    planElapsed = 0;
    planSig = sig;
    sinceReplan = 0;
  }

  // Execute any commands whose t <= planElapsed (in order)
  // We execute only the latest command at this moment (so NONE can override DUCK, etc.)
  let chosen = null;
  for (const cmd of activePlan) {
    if (cmd.t <= planElapsed + 1e-9) chosen = cmd;
    else break;
  }
  applyAction(chosen ? chosen.a : 0);
}

// ---------- Game loop ----------
let last = performance.now();
let decisionAcc = 0;

function restart() {
  resizeCanvas();
  resetCityFlags();
  obstacles = [];
  powerups = [];
  gameOver = false;
  t = 0;
  distance = 0;


  lives = 1;
  invincibleUntil = 0;
  spawnLockUntil = 0;
  lastPU ="-";
  nextPowerupAt = t + 0.35;
  dino.y = GROUND_Y;
  dino.vy = 0;
  dino.grounded = true;
  dino.ducking = false;
  dino.h = STAND_H;

  decisionAcc = 0;
  activePlan = [{ t: 0, a: 0 }];
  planElapsed = 0;
  planSig = "";
  sinceReplan = 0;

  ui.status.textContent = T("run");
  applyLanguage();
}

function respawnDino() {
  // Render/flow only: keep physics + AI logic intact, just reset the player state.
  dino.y = GROUND_Y;
  dino.vy = 0;
  dino.grounded = true;
  dino.ducking = false;
  dino.h = STAND_H;

  // Brief invincibility to prevent immediate re-collision on the same obstacle pack.
  invincibleUntil = Math.max(invincibleUntil, t + 1.0);

  // Reset animation to a sane frame.
  dinoAnimT = 0;
  dinoFrame = 0;

  // Status feedback only.
  ui.status.textContent = T("run");
}
function softResetAfterCrash() {
  // UI/render-only flow: restart the run without touching destroyed cities.
  // Keeps: cityDestroyedFlags, best
  obstacles = [];
  powerups = [];
  gameOver = false;

  t = 0;
  distance = 0;

  lives = 1;
  invincibleUntil = 0;
  spawnLockUntil = 0;
  lastPU = "-";
  nextPowerupAt = t + 0.35;

  // Reset player state + grant brief invincibility
  respawnDino();

  // Reset planner commit window (same baseline behavior as restart(), minus city reset)
  decisionAcc = 0;
  activePlan = [{ t: 0, a: 0 }];
  planElapsed = 0;
  planSig = "";
  sinceReplan = 0;

  ui.status.textContent = T("run");
}


function update(dt) {
  if (gameOver) return;

  t += dt;
  const speed = currentSpeed();


  // Sprite animation tick (render-only)
  if (dino.grounded && !dino.ducking && speed > 10) {
    dinoAnimT += dt;
    if (dinoAnimT >= 0.12) {
      dinoAnimT = 0;
      dinoFrame = 1 - dinoFrame;
    }
  } else {
    dinoAnimT = 0;
    dinoFrame = 0;
  }
  distance += speed * dt;

  // Milestone check (every 5000)
  while (distance >= nextMilestone) {
    const citiesArr = getCitiesArray();
    if (citiesArr.length) cityDestroyedFlags[cityIndex % citiesArr.length] = true;
    const city = getCityName(cityIndex);
    const msg = `${T("destroyed")}${city}`;
    rebuildCityPanel();
    showMilestone(msg);
    pushMilestoneLog(msg);
    milestoneUntil = Math.max(milestoneUntil, t + MILESTONE_PAUSE);
    nextMilestone += MILESTONE_STEP;
    cityIndex++;

    // End condition: lose only when all cities are destroyed.
    const allDestroyed = cityDestroyedFlags.length > 0 && cityDestroyedFlags.every(Boolean);
    if (allDestroyed) {
      gameOver = true;
      ui.status.textContent = T("gameOver");

      const runDist = Math.floor(distance);
      if (runDist > best) {
        best = runDist;
        try { localStorage.setItem("dino_spawner_best", String(best)); } catch(e) {}
      }
      break;
    }
  }

  ui.distance.textContent = Math.floor(distance).toString();
  ui.best.textContent = best.toString();
  if (ui.lives) ui.lives.textContent = String(lives);
  if (ui.pu) {
    const shieldLeft = Math.max(0, invincibleUntil - t);
    const lockLeft = Math.max(0, spawnLockUntil - t);
    const nextIn = Math.max(0, nextPowerupAt - t);
    const parts = [];
    if (shieldLeft > 0.01) parts.push(`🛡️ ${shieldLeft.toFixed(1)}s`);
    if (lockLeft > 0.01) parts.push(`⛔ ${lockLeft.toFixed(1)}s`);
    parts.push(`next ${nextIn.toFixed(1)}s`);
    parts.push(`onScreen ${powerups.length}`);
    ui.pu.textContent = parts.join(" | ");
  }
  renderTopLeftUI();

  ui.eps.textContent = `Planner v11 | horizon ${SIM_HORIZON.toFixed(2)}s | tick 35ms`;

  // Decisions
  decisionAcc += dt;
  while (decisionAcc >= DECISION_DT) {
    decisionAcc -= DECISION_DT;
    plannerTick(DECISION_DT);
  }

  // Physics
  const gravMult = (!dino.grounded && dino.ducking) ? FAST_FALL_GRAV_MULT : 1.0;
  dino.vy += (GRAVITY * gravMult) * dt;
  dino.y += dino.vy * dt;

  if (dino.y >= GROUND_Y) {
    dino.y = GROUND_Y;
    dino.vy = 0;
    dino.grounded = true;
  } else {
    dino.grounded = false;
  }

  maybeSpawnPowerup();

  // Move obstacles and pass
  for (const o of obstacles) {
    o.x -= speed * dt;
    if (!o.passed && o.x + o.w < dino.x) o.passed = true;
  }
  obstacles = obstacles.filter(o => o.x > -80);

  // Move powerups
  for (const p of powerups) p.x -= speed * dt;
  powerups = powerups.filter(p => p.x > -80 && !p.taken);

  // Collect powerups
  const dRectPU = { x: dino.x, y: dino.y, w: dino.w, h: dino.h };
  for (const p of powerups) {
    const pRect = { x: p.x, y: p.y, w: p.w, h: p.h };
    if (!p.taken && rectsOverlap(dRectPU, pRect)) {
      p.taken = true;
      if (p.type === "SHIELD") { invincibleUntil = Math.max(invincibleUntil, t + 3.0); lastPU = "🛡️"; }
      else if (p.type === "LOCK") { spawnLockUntil = Math.max(spawnLockUntil, t + 2.0); lastPU = "⛔"; }
      else if (p.type === "HEART") { lives = Math.min(5, lives + 1); lastPU = "❤️"; }
    }
  }

  // Collision
  const dRect = { x: dino.x, y: dino.y, w: dino.w, h: dino.h };
  for (const o of obstacles) {
    const oRect = { x: o.x, y: o.y, w: o.w, h: o.h };
    if (rectsOverlap(dRect, oRect)) {
      // Shield active => ignore collisions
      if (t < invincibleUntil) {
        // push obstacle away to avoid re-colliding in consecutive frames
        o.x += 60;
        continue;
      }


      // Crash: reset the run (score + obstacles) and auto-respawn. Loss condition is cities only.
      ui.status.textContent = T("crash");

      // Remove the obstacle that hit us to avoid repeated hits.
      o.x = -999; // mark for removal

      softResetAfterCrash();
      continue;
    }
  }
}


function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Ground line (keep baseline)
  ctx.strokeStyle = "#223246";
  ctx.beginPath();
  ctx.moveTo(0, GROUND_Y + 1);
  ctx.lineTo(canvas.width, GROUND_Y + 1);
  ctx.stroke();

  const groundTop = GROUND_Y + 1;
  const groundH = Math.max(0, canvas.height - groundTop);

  // Ground sprite (render-only)
  if (spritesReady && SPRITES.ground) {
    if (groundPattern) {
      ctx.save();
      // Pattern space should not be blurred
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = groundPattern;
      ctx.fillRect(0, groundTop, canvas.width, groundH);
      ctx.restore();
    } else {
      // Fallback: stretch across the ground area
      ctx.drawImage(SPRITES.ground, 0, groundTop, canvas.width, groundH);
    }
  }

  // Dino
  if (spritesReady && SPRITES.dino0) {
    const img = (dinoFrame === 1 && SPRITES.dino1) ? SPRITES.dino1 : SPRITES.dino0;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      img,
      dino.x,
      dino.y - dino.h * SPRITE_SCALE,
      dino.w * SPRITE_SCALE,
      dino.h * SPRITE_SCALE
    );
  } else {
    ctx.fillStyle = "#d7ffe9";
    ctx.fillRect(dino.x, dino.y - dino.h, dino.w, dino.h);
  }

  // Obstacles
  for (const o of obstacles) {
    if (spritesReady) {
      const img = (o.type === "CACTUS") ? SPRITES.cactus : SPRITES.bird;
      if (img) {
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(
          img,
          o.x,
          o.y - o.h * SPRITE_SCALE,
          o.w * SPRITE_SCALE,
          o.h * SPRITE_SCALE
        );
        continue;
      }
    }

    // Baseline fallback rectangles
    if (o.type === "CACTUS") ctx.fillStyle = "#8ef6c7";
    else ctx.fillStyle = "#ffd36b";
    ctx.fillRect(o.x, o.y - o.h, o.w, o.h);
  }

  if (gameOver) {
    ctx.fillStyle = "#e7eef7";
    ctx.font = "bold 20px system-ui";
    ctx.fillText(T("gameOver"), 320, 90);
  }
}


function loop(now) {
  const dt = Math.min(0.033, (now - last) / 1000);
  last = now;

  update(dt);
  draw();
  requestAnimationFrame(loop);
}

console.log("Dino Spawner boot");

// Init
ui.best.textContent = best.toString();
  if (ui.lives) ui.lives.textContent = String(lives);
  if (ui.pu) {
    const shieldLeft = Math.max(0, invincibleUntil - t);
    const lockLeft = Math.max(0, spawnLockUntil - t);
    const parts = [];
    if (shieldLeft > 0.01) parts.push(`🛡️ ${shieldLeft.toFixed(1)}s`);
    if (lockLeft > 0.01) parts.push(`⛔ ${lockLeft.toFixed(1)}s`);
    const nextIn = Math.max(0, nextPowerupAt - t);
    parts.push(`next ${nextIn.toFixed(1)}s`);
    parts.push(`onScreen ${powerups.length}`);
    if (parts.length === 0) parts.push(lastPU);
    ui.pu.textContent = parts.join(" | ");
  }
renderTopLeftUI();

  ui.eps.textContent = `Planner v11 | horizon ${SIM_HORIZON.toFixed(2)}s | tick 35ms`;
resizeCanvas();
applyLanguage();
restart();
requestAnimationFrame(loop);
