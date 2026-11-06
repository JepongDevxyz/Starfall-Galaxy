'use strict';
/* Starfall Galaxy — game engine (Canvas, no dependencies)
 * Modes: 'solo' | 'local' | 'host' (online, authoritative) | 'guest' (online, renders host state)
 * Virtual world: 1280 x 720, scaled to fit the screen.
 */
const VW = 1280, VH = 720;
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
let CW = 0, CH = 0, DPR = 1;

function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  CW = window.innerWidth; CH = window.innerHeight;
  canvas.width = Math.round(CW * DPR); canvas.height = Math.round(CH * DPR);
}
window.addEventListener('resize', resize); resize();

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const rand = (a, b) => a + Math.random() * (b - a);
const fmtTime = (s) => { s = Math.max(0, s); const base = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(Math.floor(s % 60)).padStart(2, '0'); return s < 60 ? base : base + ':' + String(Math.floor((s * 100) % 100)).padStart(2, '0'); };
const isTouch = (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) || 'ontouchstart' in window;

let toastTimer = null;
function toast(msg, ms) {
  const t = $('toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), ms || 2400);
}

/* ------------------------------------------------------------------ audio */
let audioCtx = null, muted = false, lastShootSnd = 0;
function ensureAudio() {
  if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) {} }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}
function beep(freq, dur, type, vol, slideTo) {
  if (!audioCtx || muted) return;
  const t = audioCtx.currentTime, o = audioCtx.createOscillator(), g = audioCtx.createGain();
  o.type = type || 'square'; o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(30, slideTo), t + dur);
  g.gain.setValueAtTime(vol || 0.05, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(audioCtx.destination); o.start(t); o.stop(t + dur);
}
function sndShoot() { const n = performance.now(); if (n - lastShootSnd < 110) return; lastShootSnd = n; beep(880, 0.07, 'square', 0.018, 420); }
function sndBoom(big) {
  if (!audioCtx || muted) return;
  const dur = big ? 0.45 : 0.22, sr = audioCtx.sampleRate, buf = audioCtx.createBuffer(1, sr * dur, sr);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
  const src = audioCtx.createBufferSource(); src.buffer = buf;
  const f = audioCtx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = big ? 700 : 1200;
  const g = audioCtx.createGain(); g.gain.value = big ? 0.22 : 0.12;
  src.connect(f); f.connect(g); g.connect(audioCtx.destination); src.start();
}
function sndPickup() { beep(660, 0.09, 'sine', 0.06); setTimeout(() => beep(990, 0.12, 'sine', 0.06), 70); }
function sndCrystal() { beep(1180, 0.08, 'triangle', 0.06); setTimeout(() => beep(1560, 0.14, 'triangle', 0.06), 60); }
function sndHurt() { beep(200, 0.25, 'sawtooth', 0.09, 70); }
function sndNova() { beep(180, 0.5, 'sawtooth', 0.1, 1400); sndBoom(true); }
function sndCount(final) { beep(final ? 880 : 440, final ? 0.35 : 0.15, 'sine', 0.07); }

/* ------------------------------------------------------------------ input */
const keys = {};
const JOY_DEAD_ZONE = 0.12;
function isFormTarget(e) {
  const t = e.target;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}
window.addEventListener('keydown', (e) => {
  if (isFormTarget(e)) return;
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  if (e.repeat) return;
  keys[e.code] = true;
  if (e.code === 'Space' || e.code === 'KeyE') queueSkill(0);
  if (e.code === 'Slash' || e.code === 'Period') queueSkill(1);
  if (e.code === 'KeyP' || e.code === 'Escape') { if (G.phase === 'running') pauseGame(); else if (G.phase === 'paused') resumeGame(); }
});
window.addEventListener('keyup', (e) => { if (!isFormTarget(e)) keys[e.code] = false; });

function makeJoystick(el, side) {
  const knob = el.querySelector('.knob');
  let returnTimer = null;
  const joy = { x: 0, y: 0, active: false, id: null, el, side };
  function setKnob(dx, dy) { knob.style.transform = 'translate(calc(-50% + ' + dx + 'px), calc(-50% + ' + dy + 'px))'; }
  function size() {
    const r = el.getBoundingClientRect();
    return r.width || Math.min(230, Math.max(96, window.innerWidth * 0.12));
  }
  joy.setBasePosition = (left, top) => {
    el.classList.remove('returning');
    el.style.left = clamp(left, 0, Math.max(0, window.innerWidth - size())) + 'px';
    el.style.top = clamp(top, 0, Math.max(0, window.innerHeight - size())) + 'px';
    el.style.right = 'auto'; el.style.bottom = 'auto';
  };
  joy.resetBase = (animate) => {
    const s = size(), margin = side === 0 ? 18 : 18;
    const left = side === 0 ? margin : window.innerWidth - s - margin;
    const top = window.innerHeight - s - 22;
    if (animate) {
      el.classList.add('returning');
      clearTimeout(returnTimer);
      returnTimer = setTimeout(() => el.classList.remove('returning'), 220);
    } else {
      el.classList.remove('returning');
    }
    el.style.left = left + 'px'; el.style.top = top + 'px';
    el.style.right = 'auto'; el.style.bottom = 'auto';
  };
  joy.start = (pointerId, clientX, clientY) => {
    if (joy.active) return false;
    ensureAudio();
    clearTimeout(returnTimer);
    joy.active = true; joy.id = pointerId;
    const s = size();
    joy.setBasePosition(clientX - s / 2, clientY - s / 2);
    joy.moveTo(clientX, clientY);
    return true;
  };
  joy.moveTo = (clientX, clientY) => {
    const r = el.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    let dx = clientX - cx, dy = clientY - cy;
    const max = Math.max(1, r.width / 2 - 8), len = Math.hypot(dx, dy);
    if (len > max) { dx = dx / len * max; dy = dy / len * max; }
    joy.x = dx / max; joy.y = dy / max; setKnob(dx, dy);
  };
  joy.end = (pointerId) => {
    if (!joy.active || pointerId !== joy.id) return;
    joy.active = false; joy.id = null; joy.x = 0; joy.y = 0; setKnob(0, 0);
    joy.resetBase(true);
  };
  joy.resetBase(false);
  return joy;
}
const joy1 = makeJoystick($('joy1'), 0);
const joy2 = makeJoystick($('joy2'), 1);

/* Touch controls are OPTIONAL on PC/laptop (Jepong's order): Auto = shown on
   touch devices only, On = always, Off = never. The keyboard always works. */
let touchMode = 'auto';
try { touchMode = localStorage.getItem('sg_touch') || 'auto'; } catch (_) {}
function touchControlsOn() {
  if (touchMode === 'on') return true;
  if (touchMode === 'off') return false;
  return ('ontouchstart' in window) || (window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
}
function refreshTouchUI() {
  const label = 'Touch Controls: ' + touchMode.charAt(0).toUpperCase() + touchMode.slice(1);
  document.querySelectorAll('.touchModeBtn').forEach((b) => { b.textContent = label; });
  if ($('hud').classList.contains('on')) showControls();
}
function cycleTouchMode() {
  touchMode = touchMode === 'auto' ? 'on' : touchMode === 'on' ? 'off' : 'auto';
  try { localStorage.setItem('sg_touch', touchMode); } catch (_) {}
  refreshTouchUI();
}

function resetJoystickBases() {
  if (!joy1.active) joy1.resetBase(false);
  if (!joy2.active) joy2.resetBase(false);
}
window.addEventListener('resize', resetJoystickBases);

function isInteractiveTarget(target) {
  return !!target && !!target.closest && !!target.closest('button, input, textarea, select, a, [contenteditable="true"], .screen, #netBanner');
}
function routePointerDown(e) {
  if (G.phase !== 'running' && G.phase !== 'countdown') return;
  if (!touchControlsOn()) return; // PC/laptop with touch controls off: keyboard only
  if (isInteractiveTarget(e.target)) return;
  const leftZone = e.clientX < window.innerWidth * 0.45;
  const joy = leftZone ? joy1 : (mode === 'local' ? joy2 : null);
  if (!joy || joy.active) return;
  e.preventDefault();
  joy.start(e.pointerId, e.clientX, e.clientY);
}
function routePointerMove(e) {
  for (const joy of [joy1, joy2]) if (joy.active && e.pointerId === joy.id) joy.moveTo(e.clientX, e.clientY);
}
function routePointerEnd(e) {
  for (const joy of [joy1, joy2]) joy.end(e.pointerId);
}
window.addEventListener('pointerdown', routePointerDown, { passive: false });
window.addEventListener('pointermove', routePointerMove, { passive: false });
window.addEventListener('pointerup', routePointerEnd);
window.addEventListener('pointercancel', routePointerEnd);

function joystickVector(joy) {
  return Math.hypot(joy.x, joy.y) < JOY_DEAD_ZONE ? { x: 0, y: 0 } : { x: joy.x, y: joy.y };
}
function keyVec(p) {
  let x = 0, y = 0;
  if (p === 0) {
    if (keys['KeyA']) x -= 1; if (keys['KeyD']) x += 1;
    if (keys['KeyW']) y -= 1; if (keys['KeyS']) y += 1;
    const j = joystickVector(joy1);
    if (Math.hypot(j.x, j.y) > JOY_DEAD_ZONE) { x = j.x; y = j.y; }
  } else {
    if (keys['ArrowLeft']) x -= 1; if (keys['ArrowRight']) x += 1;
    if (keys['ArrowUp']) y -= 1; if (keys['ArrowDown']) y += 1;
    const j = joystickVector(joy2);
    if (Math.hypot(j.x, j.y) > JOY_DEAD_ZONE) { x = j.x; y = j.y; }
  }
  const l = Math.hypot(x, y); if (l > 1) { x /= l; y /= l; }
  return { x, y };
}

/* ------------------------------------------------------------------ state */
let mode = 'solo'; // solo | local | host | guest
let nextId = 1;
const G = {
  phase: 'menu', // menu | countdown | running | paused | over
  players: [], bullets: [], enemies: [], particles: [], powerups: [], crystals: [],
  rings: [], floaters: [], boss: null, orbs: [],
  points: 0, crystalCount: 0, totalCrystals: 0, kills: 0,
  elapsed: 0, spawnT: 0, powerT: 10, shake: 0, // first Power-up Orb enters at ~10s — the reference opening is clean (no orbs in the first seconds)
  wave: 0, waveT: 0, spawnQueue: [], waveState: 'idle', interT: 0, bossDown: false,
  countT: 0, overT: -1, overReason: '', bgScroll: 0, pendingEvents: []
};

function makePlayer(idx, x, y) {
  return {
    idx, x, y, vx: 0, vy: 0, r: 24, hearts: 3, charges: 0, killProgress: 0,
    fireT: idx * 0.12, invT: 0, shieldT: 0, rapidT: 0, splitT: 0, dead: false, deadT: 0, faceT: 0
  };
}
function resetGame() {
  nextId = 1;
  G.players = [makePlayer(0, 170, VH / 2)];
  if (mode === 'local' || mode === 'host' || mode === 'guest') G.players.push(makePlayer(1, 170, VH / 2 + 130));
  G.bullets = []; G.enemies = []; G.particles = []; G.powerups = []; G.crystals = [];
  G.rings = []; G.floaters = []; G.boss = null; G.orbs = [];
  G.points = 0; G.crystalCount = 0; G.totalCrystals = 0; G.kills = 0;
  G.elapsed = 0; G.spawnT = 1.1; G.powerT = 10; G.shake = 0;
  G.wave = 0; G.waveT = 0; G.spawnQueue = []; G.waveState = 'idle'; G.interT = 0; G.bossDown = false;
  G.overT = -1; G.overReason = ''; G.pendingEvents = [];
  guestInput = { x: 0, y: 0, skill: false };
  updateHeartsUI(); updateSkillUI();
}

/* Stars (screen space) */
const stars = [];
for (let i = 0; i < 150; i++) stars.push({ x: Math.random(), y: Math.random(), z: rand(0.25, 1), tw: rand(0, 6.28) });

/* ------------------------------------------------------------------ skills */
function queueSkill(pIdx) {
  if (mode === 'guest') { if (pIdx === 0) { guestSkillQueued = true; sendGuestInput(true); } return; }
  if (mode !== 'local' && pIdx === 1) return;
  trySkill(pIdx);
}
function trySkill(pIdx) {
  if (G.phase !== 'running') return;
  const p = G.players[pIdx]; if (!p || p.dead) return;
  if (p.charges <= 0) { if (pIdx === 0 || mode === 'local') toast('Star Orb has no charges — earn charges from meteor kills'); return; }
  p.charges--;
  // the skill in the reference video launches a giant ringed star-orb that
  // rolls across the field crushing everything, then bursts
  G.orbs.push({ id: nextId++, x: p.x + 60, y: p.y + 10, vx: 540, r: 92, t: 0, ang: rand(0, 6.28), owner: pIdx, hit: new Set(), dead: false });
  G.rings.push({ x: p.x + 60, y: p.y + 10, r: 10, maxR: 190, life: 0.35, t: 0, color: pIdx === 0 ? '#ff8ac2' : '#2ee6c8' });
  G.shake = Math.max(G.shake, 6);
  sndNova();
  updateSkillUI();
}
function explodeOrb(o) {
  if (o.dead) return;
  o.dead = true;
  explode(o.x, o.y, '#ff8ac2', 42, true); explode(o.x, o.y, '#ffd76a', 26, true);
  G.shake = Math.max(G.shake, 9);
  sndBoom(true);
  for (const e of [...G.enemies]) {
    const dx = e.x - o.x, dy = e.y - o.y;
    if (dx * dx + dy * dy < 190 * 190) damageEnemy(e, 5, o.owner);
  }
  if (G.boss && Math.abs(o.x - G.boss.x) < G.boss.w / 2 + 170 && Math.abs(o.y - G.boss.y) < G.boss.h / 2) damageBoss(10, o.owner);
  if (mode === 'host') G.pendingEvents.push({ k: 'boom', x: Math.round(o.x), y: Math.round(o.y), c: '#ff8ac2', n: 30, big: true });
}
function updateOrbs(dt) {
  for (const o of G.orbs) {
    o.t += dt; o.x += o.vx * dt; o.ang += dt * 2.2;
    for (const e of G.enemies) {
      if (e.gone || o.hit.has(e.id)) continue;
      const dx = e.x - o.x, dy = e.y - o.y, rr = o.r + e.r * 0.7;
      if (dx * dx + dy * dy < rr * rr) { o.hit.add(e.id); damageEnemy(e, 8, o.owner); explode(e.x, e.y, '#ffd76a', 8, false); }
    }
    if (G.boss && !o.hit.has(-1)) {
      const b = G.boss;
      if (Math.abs(o.x - b.x) < b.w / 2 + o.r * 0.6 && Math.abs(o.y - b.y) < b.h / 2) { o.hit.add(-1); damageBoss(18, o.owner); explodeOrb(o); }
    }
    if (!o.dead && (o.x > VW + 130 || o.t > 3.4)) explodeOrb(o);
  }
  G.orbs = G.orbs.filter((o) => !o.dead);
}

/* ------------------------------------------------------------------ combat */
function explode(x, y, color, n, big) {
  for (let i = 0; i < n; i++) {
    const a = rand(0, Math.PI * 2), sp = rand(40, big ? 420 : 260);
    G.particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rand(0.3, big ? 0.9 : 0.6), t: 0, r: rand(2, big ? 7 : 5), color });
  }
  if (mode === 'host') G.pendingEvents.push({ k: 'boom', x: Math.round(x), y: Math.round(y), c: color, n, big: !!big });
}
function addFloater(x, y, text, color) {
  G.floaters.push({ x, y, text, color: color || '#fff', t: 0, life: 1.6 });
  if (mode === 'host') G.pendingEvents.push({ k: 'float', x: Math.round(x), y: Math.round(y), text, c: color || '#fff' });
}
function awardKill(pIdx, e) {
  G.kills++;
  const p = G.players[pIdx];
  if (p) {
    p.killProgress++;
    if (p.killProgress >= 12 && p.charges < 2) { p.charges++; p.killProgress = 0; if (pIdx === 0 || mode === 'local') toast('Star Orb charge ready! (' + p.charges + '/2)'); updateSkillUI(); }
  }
  // crystal drops
  const chance = e.type === 2 ? 0.35 : e.type === 1 ? 0.12 : 0.05; // reference pace: 10 crystals take ~2-3 minutes of kills
  if (Math.random() < chance) G.crystals.push({ id: nextId++, x: e.x, y: e.y, vx: -70, t: rand(0, 6) });
}
function damageEnemy(e, dmg, pIdx) {
  e.hp -= dmg;
  G.points += 20; // reference scoring: +20 per hit landed (read from the score ticks), kills pay nothing extra
  e.flash = 0.08;
  if (e.hp <= 0 && !e.gone) {
    e.gone = true;
    explode(e.x, e.y, e.type === 2 ? '#c084fc' : e.type === 1 ? '#ffb020' : '#7dd3fc', e.type === 2 ? 30 : 18, e.type === 2);
    sndBoom(e.type === 2);
    awardKill(pIdx, e);
  }
}
function damageBoss(dmg, pIdx) {
  const b = G.boss; if (!b) return;
  b.hp -= dmg; b.flash = 0.06;
  G.points += 20; // +20 per hit, as with meteors
  if (b.hp <= 0) {
    explode(b.x, b.y, '#c084fc', 70, true); explode(b.x, b.y - 140, '#ff8ac2', 40, true); explode(b.x, b.y + 140, '#ffb020', 40, true);
    sndBoom(true); G.shake = 16;
    G.kills++;
    addFloater(b.x - 60, b.y, 'PILLAR DOWN!', '#4ade80');
    for (let i = 0; i < 2; i++) G.crystals.push({ id: nextId++, x: b.x - 30, y: b.y + rand(-90, 90), vx: -60, t: rand(0, 6) });
    G.boss = null; G.bossDown = true;
    updateBossUI();
  }
}
function hurtPlayer(p, cause) {
  if (p.invT > 0 || p.shieldT > 0 || p.dead || G.phase !== 'running') return;
  p.hearts--; p.invT = 2; G.shake = Math.max(G.shake, 8); sndHurt();
  explode(p.x, p.y, '#ff4d6d', 16, false);
  updateHeartsUI();
  if (p.hearts <= 0) {
    p.dead = true; p.deadT = 5;
    explode(p.x, p.y, p.idx === 0 ? '#ff8ac2' : '#2ee6c8', 46, true); sndBoom(true);
    const partner = G.players[1 - p.idx];
    const soloLike = G.players.length === 1;
    if (soloLike || !partner || partner.dead) {
      G.overReason = cause || 'Your glider was destroyed.';
      G.overT = 1.4;
    } else {
      addFloater(p.x, p.y - 44, (p.idx === 0 ? 'P1' : 'P2') + ' DOWN — respawn in 5s', '#ff8fa3');
    }
  }
}

/* ------------------------------------------------------------------ spawns */
const ENEMY_TYPES = [
  { r: 30, hp: 0.8, score: 0, speed: 460 },  // small dark-blue meteor — fixed speed measured from the reference video (~690 px/s at 1920w); hp 0.8 so Split side-shots (0.8 dmg) still one-shot it
  { r: 36, hp: 3, score: 0, speed: 275 },  // medium orange-flame — measured ~412 px/s at 1920w
  { r: 52, hp: 16, score: 0, speed: 95 }    // large purple crystal rock — measured ~142 px/s at 1920w; soaks ~13+ point-blank hits in the reference before breaking
];
function spawnEnemyOf(type, x, y) {
  const t = ENEMY_TYPES[type];
  G.enemies.push({
    id: nextId++, type, x, y,
    r: t.r, hp: t.hp, maxHp: t.hp, score: t.score,
    vx: -t.speed,
    wob: 0, wobSp: 0, rot: 0, rotSp: 0, flash: 0, gone: false,
    seed: Math.random() * 1000
  });
}
function spawnEnemy() { // random single (boss-fight trickle)
  const roll = Math.random();
  spawnEnemyOf(roll < 0.55 ? 0 : roll < 0.85 ? 1 : 2, VW + 50, rand(50, VH - 50));
}
// formations, as seen in the reference video: rows fly in together on one lane
function spawnRow(type, n, y, gap) { for (let i = 0; i < n; i++) spawnEnemyOf(type, VW + 60 + i * (gap || 74), y); }
function spawnStack(n, y) { for (let i = 0; i < n; i++) spawnEnemyOf(2, VW + 60 + (i % 2) * 40, clamp(y + (i - (n - 1) / 2) * 122, 60, VH - 60)); }
function spawnPair(type) { const y = rand(90, VH - 90); spawnEnemyOf(type, VW + 60, y); spawnEnemyOf(type, VW + 60, clamp(y + (Math.random() < 0.5 ? -120 : 120), 60, VH - 60)); }
function spawnPowerup() {
  if (G.powerups.length >= 2) return; // the reference field holds up to two orbs at once
  // the Power-up Orbs documented in the reference's own How-to-Play guide
  const roll = Math.random();
  const kind = roll < 0.30 ? 'split' : roll < 0.60 ? 'pierce' : roll < 0.80 ? 'shield' : 'energy';
  G.powerups.push({ id: nextId++, kind, x: VW + 40, y: rand(70, VH - 70), vx: -45, t: rand(0, 6) }); // orbs drift in slowly, as in the reference
}
function spawnBoss(hp, targetX) {
  G.boss = { x: VW + 120, y: VH / 2, w: 320, h: 680, hp: hp || 42, maxHp: hp || 42, flash: 0, seed: Math.random() * 1000, enterT: 0, targetX: targetX || 1024 };
  addFloater(VW - 320, 90, '⚠ PILLAR OF CREATION ⚠', '#d8b4fe');
  toast('A Pillar of Creation has appeared! Shoot it down!');
  updateBossUI();
}
/* ------------------------------------------------------------ wave director
   The reference run is wave-based: scripted formations roll in, a Pillar
   anchors the end of each wave, and clearing a wave raises the
   "Wave N Cleared!" banner (with the character cut-in from Wave 2 on). */
function buildWave(n) {
  const q = [];
  const ev = (at, fn) => q.push({ at, fn });
  const lane = () => rand(90, VH - 90);
  if (n === 1) {
    ev(0.8, () => spawnEnemyOf(0, VW + 50, lane()));
    ev(3, () => spawnEnemyOf(1, VW + 50, lane()));
    ev(6, () => spawnPair(0));
    ev(9, () => spawnEnemyOf(1, VW + 50, lane()));
    ev(12, () => spawnRow(0, 3, lane()));
    ev(15, () => spawnEnemyOf(1, VW + 50, lane()));
    ev(18, () => spawnRow(1, 4, lane()));
    ev(22, () => spawnStack(2, VH / 2));
    ev(26, () => spawnPair(1));
    ev(30, () => { spawnEnemyOf(0, VW + 50, lane()); spawnEnemyOf(1, VW + 50, lane()); });
    ev(34, () => spawnRow(0, 3, lane()));
    ev(38, () => spawnBoss(42));
  } else if (n === 2) {
    ev(0.8, () => spawnRow(1, 4, lane()));
    ev(4, () => spawnStack(2, lane()));
    ev(8, () => spawnPair(0));
    ev(11, () => spawnRow(0, 4, lane()));
    ev(15, () => spawnStack(3, VH / 2));
    ev(19, () => spawnPair(1));
    ev(23, () => spawnRow(1, 5, lane()));
    ev(27, () => { spawnEnemyOf(2, VW + 50, lane()); spawnPair(0); });
    ev(31, () => { spawnStack(2, lane()); spawnPair(1); });
    ev(36, () => spawnBoss(58));
  } else {
    const hp = 85 + (n - 3) * 15;
    ev(0.8, () => spawnStack(3, VH / 2));
    ev(4, () => spawnRow(0, 5, lane()));
    ev(8, () => { spawnPair(1); spawnStack(2, lane()); });
    ev(12, () => spawnRow(1, 5, lane()));
    ev(16, () => spawnStack(3, lane()));
    ev(20, () => { spawnEnemyOf(0, VW + 50, lane()); spawnEnemyOf(1, VW + 50, lane()); spawnEnemyOf(2, VW + 50, lane()); });
    ev(24, () => spawnRow(1, 4, lane()));
    ev(28, () => spawnBoss(hp, 820)); // later Pillars advance into the field, burning
  }
  return q;
}
function startWave(n) {
  G.wave = n; G.waveT = 0; G.bossDown = false;
  G.spawnQueue = buildWave(n);
  G.waveState = 'active';
}
function showWaveClear(n) {
  const b = $('waveBanner');
  $('waveBannerText').textContent = 'Wave ' + n + ' Cleared!';
  b.classList.add('on');
  setTimeout(() => b.classList.remove('on'), 2400);
  if (n >= 2) {
    const c = $('cutin');
    c.classList.remove('on'); void c.offsetWidth; c.classList.add('on');
    setTimeout(() => c.classList.remove('on'), 1750);
  }
}
function waveTick(dt) {
  if (G.waveState === 'idle') { startWave(G.wave + 1); return; }
  if (G.waveState === 'inter') {
    G.interT -= dt;
    if (G.interT <= 0) G.waveState = 'idle';
    return;
  }
  // active
  G.waveT += dt;
  while (G.spawnQueue.length && G.spawnQueue[0].at <= G.waveT) G.spawnQueue.shift().fn();
  if (G.boss) { // slow meteor trickle while the Pillar is up, as in the reference
    G.spawnT -= dt;
    if (G.spawnT <= 0) { spawnEnemy(); G.spawnT = 1.9; }
  }
  if (!G.spawnQueue.length && !G.boss && !G.enemies.length) {
    G.waveState = 'inter'; G.interT = 2.6;
    showWaveClear(G.wave);
    if (mode === 'host') G.pendingEvents.push({ k: 'wc', n: G.wave });
    sndCount(true);
  }
}

/* ------------------------------------------------------------------ update */
function update(dt) {
  G.bgScroll += dt * 25 * (CW / 1920);
  for (const s of stars) { s.x -= dt * 0.028 * s.z; if (s.x < -0.01) { s.x = 1.01; s.y = Math.random(); } }
  if (G.phase === 'countdown') {
    G.countT -= dt;
    const n = Math.ceil(G.countT);
    if (n !== update._lastCount && n >= 1) { update._lastCount = n; setCount(n); sndCount(false); }
    if (G.countT <= 0) { G.phase = 'running'; $('countdown').classList.remove('on'); sndCount(true); }
    updateParticles(dt);
    return;
  }
  if (G.phase !== 'running') { updateParticles(dt); return; }

  G.elapsed += dt;
  if (G.shake > 0) G.shake = Math.max(0, G.shake - dt * 26);

  // game over delay (last explosion plays out)
  if (G.overT > 0) {
    G.overT -= dt;
    if (G.overT <= 0) { endGame(); return; }
  }

  // ---- players
  for (const p of G.players) {
    if (p.invT > 0) p.invT -= dt;
    if (p.shieldT > 0) p.shieldT -= dt;
    if (p.rapidT > 0) p.rapidT -= dt;
    if (p.splitT > 0) p.splitT -= dt;
    p.faceT += dt;
    if (p.dead) {
      p.vx = 0; p.vy = 0;
      p.deadT -= dt;
      const partner = G.players[1 - p.idx];
      if (p.deadT <= 0 && partner && !partner.dead) {
        p.dead = false; p.hearts = 2; p.invT = 2.5; p.x = 170; p.y = VH / 2 + (p.idx === 1 ? 120 : -40); p.vx = 0; p.vy = 0;
        addFloater(p.x, p.y - 40, (p.idx === 0 ? 'P1' : 'P2') + ' IS BACK!', '#4ade80');
        updateHeartsUI();
      }
      continue;
    }
    let mv;
    if (mode === 'host' && p.idx === 1) { mv = { x: guestInput.x, y: guestInput.y }; if (guestInput.skill) { guestInput.skill = false; trySkill(1); } }
    else mv = keyVec(p.idx);
    const SPEED = 800; // measured from the reference video: sustained joystick runs hit ~1150-1300 px/s at 1920w ≈ 800 world/s
    const ease = 1 - Math.exp(-14 * dt);
    p.vx += (mv.x * SPEED - p.vx) * ease;
    p.vy += (mv.y * SPEED - p.vy) * ease;
    p.x = clamp(p.x + p.vx * dt, 36, VW - 90);
    p.y = clamp(p.y + p.vy * dt, 36, VH - 36);
    // auto-fire
    p.fireT -= dt;
    const interval = p.rapidT > 0 ? 0.17 : 0.33; // measured from the reference: base 0.33s, rapid stream spacing = 0.17s
    while (p.fireT <= 0) {
      p.fireT += interval;
      // bullets leave from the broom/gun tip itself, as in the reference video:
      // tip sits at (+88, +24) from the player centre (measured frame-by-frame), plus the sprite bob
      const bob = Math.sin(p.faceT * 3 + p.idx) * 2.5;
      G.bullets.push({ id: nextId++, x: p.x + 88, y: p.y + 24 + bob, vx: 1000, owner: p.idx, hit: new Set(), r: 9, dmg: 1 });
      // Starshot Split (from the reference guide): additional shots above and
      // below the primary Starshot, dealing slightly less damage (0.8)
      if (p.splitT > 0) {
        G.bullets.push({ id: nextId++, x: p.x + 88, y: p.y + 24 + bob - 30, vx: 1000, owner: p.idx, hit: new Set(), r: 9, dmg: 0.8 });
        G.bullets.push({ id: nextId++, x: p.x + 88, y: p.y + 24 + bob + 30, vx: 1000, owner: p.idx, hit: new Set(), r: 9, dmg: 0.8 });
      }
      sndShoot();
    }
    // engine trail
    if (Math.random() < 0.55) G.particles.push({ x: p.x - 36, y: p.y + rand(-5, 9), vx: -rand(90, 170), vy: rand(-14, 14), life: 0.34, t: 0, r: rand(2, 4.5), color: p.idx === 0 ? '#ffb3d9' : '#9ff5e6' });
  }

  // ---- waves (scripted formations + Pillar, as in the reference)
  waveTick(dt);
  G.powerT -= dt;
  if (G.powerT <= 0) { spawnPowerup(); G.powerT = rand(8, 13); }
  if (G.boss) {
    const b = G.boss;
    const tx = b.targetX || 1024;
    if (b.enterT < 1) { b.enterT += dt * 0.7; b.x = (VW + 120) - ((VW + 120) - tx) * Math.min(1, b.enterT); }
    if (b.flash > 0) b.flash -= dt;
  }
  updateOrbs(dt);
  enemyTrail(G, dt);

  // ---- bullets
  for (const bl of G.bullets) {
    bl.x += bl.vx * dt;
    if (G.boss && !bl.hit.has(-1)) {
      const b = G.boss;
      if (Math.abs(bl.x - b.x) < b.w / 2 + bl.r && Math.abs(bl.y - b.y) < b.h / 2) { bl.hit.add(-1); damageBoss(1, bl.owner); }
    }
    for (const e of G.enemies) {
      if (e.gone || bl.hit.has(e.id)) continue;
      const dx = bl.x - e.x, dy = bl.y - e.y;
      if (dx * dx + dy * dy < (e.r + bl.r) * (e.r + bl.r)) { bl.hit.add(e.id); damageEnemy(e, bl.dmg || 1, bl.owner); explode(bl.x, bl.y, '#ffd1e8', 3, false); }
    }
  }
  G.bullets = G.bullets.filter((b) => b.x < VW + 40);

  // ---- enemies
  for (const e of G.enemies) {
    e.x += e.vx * dt; // reference video: enemies fly perfectly straight — constant speed, no wobble, no rotation
    if (e.flash > 0) e.flash -= dt;
    if (e.x < -60) { e.gone = true; }
    if (!e.gone) {
      for (const p of G.players) {
        if (p.dead || p.invT > 0 || p.shieldT > 0) {
          if (!p.dead && p.shieldT > 0) { /* shield blocks below via dist check */ } else continue;
        }
        const dx = p.x - e.x, dy = p.y - e.y, rr = p.r + e.r - 6;
        if (dx * dx + dy * dy < rr * rr) {
          e.gone = true;
          explode(e.x, e.y, '#ffb020', 18, false); sndBoom(false);
          if (p.shieldT > 0) { awardKill(p.idx, e); addFloater(p.x, p.y - 36, 'SHIELD BLOCK!', '#7dd3fc'); }
          else hurtPlayer(p, 'A meteor smashed your glider.');
        }
      }
    }
  }
  G.enemies = G.enemies.filter((e) => !e.gone);

  // ---- boss vs player contact
  if (G.boss) {
    const b = G.boss;
    for (const p of G.players) {
      if (p.dead) continue;
      if (Math.abs(p.x - b.x) < b.w / 2 + p.r - 8 && Math.abs(p.y - b.y) < b.h / 2) {
        p.x = b.x - b.w / 2 - p.r - 10;
        hurtPlayer(p, 'You crashed into the Pillar of Creation.');
      }
    }
    updateBossUI();
  }

  // ---- power-up bubbles
  for (const pu of G.powerups) {
    pu.x += pu.vx * dt; pu.t += dt * 2;
    if (pu.x < -40) pu.gone = true;
    for (const p of G.players) {
      if (pu.gone || p.dead) continue;
      const dx = p.x - pu.x, dy = p.y - pu.y;
      if (dx * dx + dy * dy < 52 * 52) {
        pu.gone = true; sndPickup();
        if (pu.kind === 'split') { p.splitT = 12; addFloater(pu.x, pu.y, 'Starshot Split!', '#a5b4fc'); }
        if (pu.kind === 'pierce') { p.rapidT = 12; addFloater(pu.x, pu.y, 'Increases Attack Speed', '#ff8ac2'); }
        if (pu.kind === 'shield') { p.shieldT = Math.min((p.shieldT || 0) + 15, 45); addFloater(pu.x, pu.y, 'Stellar Shield!', '#7dd3fc'); }
        if (pu.kind === 'energy') {
          if (p.charges < 2) { p.charges++; updateSkillUI(); addFloater(pu.x, pu.y, 'Provides Stellar Energy', '#ffd76a'); }
          else { G.points += 300; addFloater(pu.x, pu.y, 'Provides Stellar Energy  +300', '#ffd76a'); }
        }
      }
    }
  }
  G.powerups = G.powerups.filter((p) => !p.gone);

  // ---- crystals
  for (const c of G.crystals) {
    c.x += c.vx * dt; c.t += dt * 3; c.y += Math.sin(c.t) * 12 * dt;
    if (c.x < -30) c.gone = true;
    for (const p of G.players) {
      if (c.gone || p.dead) continue;
      const dx = p.x - c.x, dy = p.y - c.y;
      if (dx * dx + dy * dy < 50 * 50) {
        c.gone = true; sndCrystal();
        G.totalCrystals++; G.crystalCount = Math.min(10, G.crystalCount + 1); // the reference counter fills to 10/10 and stays
        explode(c.x, c.y, '#c9a7ff', 8, false);
      }
    }
  }
  G.crystals = G.crystals.filter((c) => !c.gone);

  updateParticles(dt);
  for (const r of G.rings) r.t += dt;
  G.rings = G.rings.filter((r) => r.t < r.life);
  for (const f of G.floaters) { f.t += dt; f.y -= dt * 26; }
  G.floaters = G.floaters.filter((f) => f.t < f.life);

  updateHUD();
  if (mode === 'host') hostSnapshotTick(dt);
}
function updateParticles(dt) {
  for (const pt of G.particles) { pt.t += dt; pt.x += pt.vx * dt; pt.y += pt.vy * dt; pt.vx *= (1 - dt * 1.6); pt.vy *= (1 - dt * 1.6); }
  G.particles = G.particles.filter((p) => p.t < p.life);
  for (const f of G.floaters) { if (G.phase !== 'running') { f.t += dt; } }
  G.floaters = G.floaters.filter((f) => f.t < f.life);
}

/* ------------------------------------------------------------------ drawing */
/* Sprite assets extracted from the reference video (see public/assets/).
 * If an image has not loaded yet, drawing falls back to the vector version. */
const SPR = {};
function loadSpr(name, src) { const i = new Image(); i.src = src; SPR[name] = i; }
loadSpr('char1', 'assets/char_p1.png');
loadSpr('char2', 'assets/char_p2.png');
loadSpr('orange', 'assets/meteor_orange.png');
loadSpr('blue', 'assets/meteor_blue.png');
loadSpr('rock', 'assets/rock_purple.png');
loadSpr('boss', 'assets/boss_pillar.png');
loadSpr('nebula', 'assets/nebula.jpg');
loadSpr('bullet', 'assets/bullet.png');
loadSpr('crystal', 'assets/crystal.png');
loadSpr('bubEnergy', 'assets/bubble_energy.png');
loadSpr('bubRapid', 'assets/bubble_rapid.png');
function sprReady(i) { return !!i && i.complete && i.naturalWidth > 0; }

function drawSparkle(x, y, r, rot, fill, alpha) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.moveTo(0, -r); ctx.quadraticCurveTo(r * 0.16, -r * 0.16, r, 0);
  ctx.quadraticCurveTo(r * 0.16, r * 0.16, 0, r);
  ctx.quadraticCurveTo(-r * 0.16, r * 0.16, -r, 0);
  ctx.quadraticCurveTo(-r * 0.16, -r * 0.16, 0, -r);
  ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); ctx.restore();
}

function drawBackground() {
  const t = performance.now() / 1000;
  const img = SPR.nebula;
  if (sprReady(img)) {
    // cover-fit the reference nebula and scroll it; ping-pong tiling —
    // alternate copies are mirrored horizontally so shared edges always
    // match (world-anchored tile parity keeps the scroll continuous)
    const sc = Math.max(CW / img.naturalWidth, CH / img.naturalHeight);
    const iw = img.naturalWidth * sc, ih = img.naturalHeight * sc, y = (CH - ih) / 2;
    const startTile = Math.floor(G.bgScroll / iw);
    const off = G.bgScroll - startTile * iw;
    for (let x = -off, i = 0; x < CW; x += iw, i++) {
      const worldIdx = startTile + i;
      if (((worldIdx % 2) + 2) % 2 === 0) {
        ctx.drawImage(img, x, y, iw, ih);
      } else {
        ctx.save(); ctx.translate(x + iw, y); ctx.scale(-1, 1);
        ctx.drawImage(img, 0, 0, iw, ih);
        ctx.restore();
      }
    }
  } else {
    const g = ctx.createLinearGradient(0, 0, CW, CH);
    g.addColorStop(0, '#16206e'); g.addColorStop(0.55, '#2a1a78'); g.addColorStop(1, '#120a45');
    ctx.fillStyle = g; ctx.fillRect(0, 0, CW, CH);
  }
  // ambient 4-point sparkles only — the dot stars are baked into the nebula
  // image itself (extracted from the reference video); drawing a second dot
  // field on top would double them up.
  for (let i = 0; i < stars.length; i++) {
    if (i % 37 !== 0) continue;
    const s = stars[i];
    const a = 0.35 + 0.65 * Math.abs(Math.sin(t * 1.4 + s.tw));
    drawSparkle(s.x * CW, s.y * CH, 4 + s.z * 6, 0, i % 74 === 0 ? '#ffd1e8' : '#ffffff', a);
  }
  ctx.globalAlpha = 1;
}

function worldTransform() {
  const s = Math.min(CW / VW, CH / VH);
  return { s, ox: (CW - VW * s) / 2, oy: (CH - VH * s) / 2 };
}

function drawStar(x, y, r, rot, fill) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const rr = i % 2 === 0 ? r : r * 0.45, a = (i / 10) * Math.PI * 2 - Math.PI / 2;
    if (i === 0) ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr); else ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); ctx.restore();
}

/* Players are told apart by heart colour: P1 pink, P2 cyan. */
const HEART_P1 = { hi: '#ffc7e3', base: '#ff9ecb', edge: 'rgba(255,220,240,0.85)', off: 'rgba(255,158,207,0.4)' };
const HEART_P2 = { hi: '#d9fbff', base: '#7fe7ff', edge: 'rgba(220,250,255,0.85)', off: 'rgba(127,231,255,0.4)' };
function drawHeartShape(cx, cy, s, filled, pal) {
  pal = pal || HEART_P1;
  ctx.save(); ctx.translate(cx, cy); ctx.scale(s / 24, s / 24); ctx.translate(-12, -12);
  ctx.beginPath();
  ctx.moveTo(12, 21.35); ctx.lineTo(10.55, 20.03);
  ctx.bezierCurveTo(5.4, 15.36, 2, 12.28, 2, 8.5);
  ctx.bezierCurveTo(2, 5.42, 4.42, 3, 7.5, 3);
  ctx.bezierCurveTo(9.24, 3, 10.91, 3.81, 12, 5.09);
  ctx.bezierCurveTo(13.09, 3.81, 14.76, 3, 16.5, 3);
  ctx.bezierCurveTo(19.58, 3, 22, 5.42, 22, 8.5);
  ctx.bezierCurveTo(22, 12.28, 18.6, 15.36, 13.45, 20.03);
  ctx.closePath();
  if (filled) {
    const g = ctx.createLinearGradient(0, 3, 0, 21);
    g.addColorStop(0, pal.hi); g.addColorStop(1, pal.base);
    ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = pal.edge; ctx.lineWidth = 1.1; ctx.stroke();
  } else {
    ctx.fillStyle = 'rgba(10,6,30,0.55)'; ctx.fill();
    ctx.strokeStyle = pal.off; ctx.lineWidth = 1.1; ctx.stroke();
  }
  ctx.restore();
}

function drawPlayer(p) {
  if (p.dead) {
    if (p.deadT !== undefined) {
      ctx.fillStyle = '#ff8fa3'; ctx.font = '800 15px Georgia,serif'; ctx.textAlign = 'center';
      ctx.fillText('DOWN ' + Math.max(0, Math.ceil(p.deadT || 0)) + 's', p.x, p.y);
    }
    return;
  }
  const img = p.idx === 0 ? SPR.char1 : SPR.char2;
  if (!sprReady(img)) { drawPlayerFallback(p); return; }
  const isP1 = p.idx === 0;
  const blink = p.invT > 0 && Math.floor(p.invT * 12) % 2 === 0;
  const bob = Math.sin(p.faceT * 3 + p.idx) * 2.5;
  const charW = VW * 0.14, charH = charW * (img.naturalHeight / img.naturalWidth);
  ctx.save();
  if (blink) ctx.globalAlpha = 0.35;
  // the character sprite
  ctx.drawImage(img, p.x - charW / 2, p.y - charH / 2 + bob, charW, charH);
  ctx.restore();
  // shield bubble
  if (p.shieldT > 0) {
    ctx.save(); ctx.translate(p.x, p.y + bob);
    const R = charW * 0.52;
    const rg = ctx.createRadialGradient(0, 0, R * 0.4, 0, 0, R);
    rg.addColorStop(0, 'rgba(125,211,252,0.05)'); rg.addColorStop(0.85, 'rgba(125,211,252,0.20)'); rg.addColorStop(1, 'rgba(125,211,252,0.5)');
    ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(186,230,253,0.8)'; ctx.lineWidth = 2; ctx.stroke();
    ctx.restore();
  }
  // hearts float above the player and follow their x (as in the reference);
  // colour identifies the player — P1 pink, P2 cyan (no name tags)
  const hs = 28, gap = 7, totalW = 3 * hs + 2 * gap;
  const hy = p.y + bob - charH / 2 - hs * 0.75;
  for (let k = 0; k < 3; k++) drawHeartShape(p.x - totalW / 2 + hs / 2 + k * (hs + gap), hy, hs, k < p.hearts, isP1 ? HEART_P1 : HEART_P2);
  if (p.rapidT > 0) { ctx.fillStyle = '#ffd76a'; ctx.font = '700 10px system-ui'; ctx.textAlign = 'center'; ctx.fillText('PIERCING', p.x, p.y + charH / 2 + 24); }
}

function drawPlayerFallback(p) {
  if (p.dead) return;
  const blink = p.invT > 0 && Math.floor(p.invT * 12) % 2 === 0;
  ctx.save(); ctx.translate(p.x, p.y);
  if (blink) ctx.globalAlpha = 0.35;
  const isP1 = p.idx === 0;
  const main = isP1 ? '#ff5da2' : '#14b8a6', dark = isP1 ? '#be185d' : '#0f766e', light = isP1 ? '#ffd1e8' : '#99f6e4';
  const bob = Math.sin(p.faceT * 3 + p.idx) * 2;
  ctx.translate(0, bob);
  // glider: broom-star (P1 golden) / silver comet glider (P2)
  ctx.save(); ctx.rotate(0.06);
  ctx.fillStyle = isP1 ? '#f59e0b' : '#cbd5e1';
  ctx.beginPath(); ctx.moveTo(-52, 14); ctx.lineTo(26, 8); ctx.lineTo(34, 13); ctx.lineTo(26, 18); ctx.lineTo(-52, 20); ctx.closePath(); ctx.fill();
  drawStar(40, 13, 11, p.faceT * 1.2, isP1 ? '#fbbf24' : '#e2e8f0');
  // bristles / fins
  ctx.fillStyle = isP1 ? '#fbbf24' : '#94a3b8';
  ctx.beginPath(); ctx.moveTo(-52, 10); ctx.lineTo(-68, 4); ctx.lineTo(-62, 17); ctx.lineTo(-68, 28); ctx.lineTo(-52, 23); ctx.closePath(); ctx.fill();
  ctx.restore();
  // rainbow trail (P1) / cyan sparkle trail (P2)
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = isP1 ? ['#f87171', '#fbbf24', '#34d399'][i] : 'rgba(45,230,200,' + (0.5 - i * 0.13) + ')';
    ctx.beginPath(); ctx.ellipse(-56 - i * 7, 8 + i * 5, 9 - i * 2, 3.4, 0.2, 0, Math.PI * 2); ctx.fill();
  }
  // robe / cloak
  ctx.fillStyle = main;
  ctx.beginPath(); ctx.moveTo(-14, 12); ctx.quadraticCurveTo(-20, -8, -2, -14); ctx.quadraticCurveTo(16, -10, 15, 12); ctx.quadraticCurveTo(6, 18, -14, 12); ctx.closePath(); ctx.fill();
  ctx.fillStyle = dark; ctx.fillRect(-13, 8, 27, 5);
  // scarf
  ctx.strokeStyle = light; ctx.lineWidth = 4; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(-6, -8); ctx.quadraticCurveTo(-20, -4 + Math.sin(p.faceT * 5) * 2, -30, 2); ctx.stroke();
  // head
  ctx.fillStyle = '#ffd9b3'; ctx.beginPath(); ctx.arc(2, -20, 9.5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = isP1 ? '#7c2d12' : '#134e4a';
  ctx.beginPath(); ctx.arc(0, -24, 9.5, Math.PI, Math.PI * 2); ctx.fill(); // hair cap
  // pointed star hat
  ctx.fillStyle = main;
  ctx.beginPath(); ctx.moveTo(-12, -24); ctx.quadraticCurveTo(2, -26, 12, -24); ctx.quadraticCurveTo(6, -38, 14, -48); ctx.quadraticCurveTo(2, -44, -6, -34); ctx.closePath(); ctx.fill();
  ctx.fillStyle = dark; ctx.fillRect(-12, -26, 24, 4);
  drawStar(13, -47, 5, 0.4, '#fde68a');
  // wand arm + wand star
  ctx.strokeStyle = '#ffd9b3'; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.moveTo(10, -4); ctx.lineTo(24, -12); ctx.stroke();
  ctx.strokeStyle = isP1 ? '#f59e0b' : '#cbd5e1'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(24, -12); ctx.lineTo(32, -19); ctx.stroke();
  drawStar(35, -22, 7, p.faceT * 2, '#fde68a');
  ctx.restore();
  // shield bubble
  if (p.shieldT > 0) {
    ctx.save(); ctx.translate(p.x, p.y);
    const rg = ctx.createRadialGradient(0, 0, 20, 0, 0, 46);
    rg.addColorStop(0, 'rgba(125,211,252,0.05)'); rg.addColorStop(0.85, 'rgba(125,211,252,0.20)'); rg.addColorStop(1, 'rgba(125,211,252,0.5)');
    ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(0, 0, 46, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(186,230,253,0.8)'; ctx.lineWidth = 2; ctx.stroke();
    ctx.restore();
  }
  // hearts above the glider — colour identifies the player (P1 pink, P2 cyan)
  const fhs = 28, fgap = 7, ftotalW = 3 * fhs + 2 * fgap;
  for (let k = 0; k < 3; k++) drawHeartShape(p.x - ftotalW / 2 + fhs / 2 + k * (fhs + fgap), p.y - 64, fhs, k < p.hearts, isP1 ? HEART_P1 : HEART_P2);
  if (p.rapidT > 0) { ctx.fillStyle = '#ffd76a'; ctx.font = '700 10px system-ui'; ctx.textAlign = 'center'; ctx.fillText('PIERCING', p.x, p.y + 52); }
}

const ENEMY_SPRITES = [
  { key: 'blue', frac: 0.153 },   // small fast dark-blue meteor (frac includes the sprite's soft-glow padding; body = 0.078 of width)
  { key: 'orange', frac: 0.157 }, // medium orange-flame meteor (body = 0.086)
  { key: 'rock', frac: 0.174 }    // large purple crystal rock (body = 0.104)
];
// living-fire trail: embers stream behind each meteor (cosmetic only —
// spawn positions/movement stay exactly as measured from the reference)
function enemyTrail(state, dt) {
  for (const e of state.enemies) {
    e.trailT = (e.trailT || 0) - dt;
    if (e.trailT <= 0) {
      e.trailT = 0.03 + Math.random() * 0.03;
      const col = e.type === 0 ? '#60a5fa' : e.type === 1 ? '#fb923c' : '#c084fc';
      state.particles.push({ x: e.x + e.r * rand(0.5, 1.0), y: e.y + rand(-e.r, e.r) * 0.55, vx: rand(60, 130), vy: rand(-16, 16), life: rand(0.28, 0.5), t: 0, r: rand(2, 5.2), color: col });
    }
  }
}
function drawEnemy(e) {
  const spec = ENEMY_SPRITES[e.type] || ENEMY_SPRITES[0];
  const img = SPR[spec.key];
  if (!sprReady(img)) { drawEnemyFallback(e); return; }
  const w = VW * spec.frac, h = w * (img.naturalHeight / img.naturalWidth);
  ctx.save(); ctx.translate(e.x, e.y);
  // living fire: a soft flame glow pulses behind the sprite and the body
  // shimmers faintly, so the art reads as a burning meteor in the scene —
  // not a pasted cut-out (position and movement are untouched)
  const t = performance.now() / 1000;
  const flick = 0.82 + Math.sin(t * 17 + e.seed * 3.1) * 0.18;
  const glowCol = e.type === 0 ? '59,130,246' : e.type === 1 ? '255,120,30' : '192,110,255';
  const gr = Math.max(w, h) * 0.74;
  const gg = ctx.createRadialGradient(0, 0, gr * 0.15, 0, 0, gr);
  gg.addColorStop(0, 'rgba(' + glowCol + ',' + (0.30 * flick).toFixed(3) + ')'); gg.addColorStop(1, 'rgba(' + glowCol + ',0)');
  ctx.fillStyle = gg; ctx.beginPath(); ctx.arc(0, 0, gr, 0, Math.PI * 2); ctx.fill();
  const sh = 1 + Math.sin(t * 13 + e.seed * 5.7) * 0.018;
  ctx.scale(sh, sh);
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
  if (e.flash > 0) { // hit flash
    ctx.globalAlpha = 0.75;
    try { ctx.filter = 'brightness(2.8) saturate(0.15)'; } catch (_) {}
    ctx.drawImage(img, -w / 2, -h / 2, w, h);
    try { ctx.filter = 'none'; } catch (_) {}
  }
  ctx.restore();
  // no HP bars on regular meteors — the reference shows only hit flashes
}

function drawEnemyFallback(e) {
  ctx.save(); ctx.translate(e.x, e.y);
  const t = performance.now() / 1000;
  // flame trail (behind, to the right since it flies left)
  const flick = 1 + Math.sin(t * 22 + e.seed) * 0.18;
  let flameCols;
  if (e.type === 0) flameCols = ['rgba(59,130,246,0.85)', 'rgba(37,99,235,0.0)'];
  else if (e.type === 1) flameCols = ['rgba(249,115,22,0.9)', 'rgba(234,88,12,0.0)'];
  else flameCols = ['rgba(192,132,252,0.9)', 'rgba(147,51,234,0.0)'];
  const fl = e.r * 2.1 * flick;
  const fg = ctx.createLinearGradient(e.r * 0.4, 0, e.r * 0.4 + fl, 0);
  fg.addColorStop(0, flameCols[0]); fg.addColorStop(1, flameCols[1]);
  ctx.fillStyle = fg;
  ctx.beginPath();
  ctx.moveTo(e.r * 0.3, -e.r * 0.55);
  ctx.quadraticCurveTo(e.r * 0.6 + fl, 0, e.r * 0.3, e.r * 0.55);
  ctx.quadraticCurveTo(e.r * 0.75, 0, e.r * 0.3, -e.r * 0.55);
  ctx.closePath(); ctx.fill();
  // rock body (jagged polygon)
  ctx.rotate(e.rot);
  const base = e.type === 0 ? '#334155' : e.type === 1 ? '#7c2d12' : '#4c1d95';
  const hi = e.type === 0 ? '#64748b' : e.type === 1 ? '#c2410c' : '#7e22ce';
  ctx.beginPath();
  const n = 8;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rr = e.r * (0.78 + 0.3 * Math.abs(Math.sin(e.seed + i * 2.7)));
    if (i === 0) ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr); else ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  ctx.closePath();
  const rg = ctx.createRadialGradient(-e.r * 0.3, -e.r * 0.3, e.r * 0.2, 0, 0, e.r * 1.15);
  rg.addColorStop(0, e.flash > 0 ? '#ffffff' : hi); rg.addColorStop(1, base);
  ctx.fillStyle = rg; ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 2; ctx.stroke();
  // crystal shards on the large rock
  if (e.type === 2) {
    ctx.fillStyle = '#e9d5ff';
    for (let i = 0; i < 3; i++) {
      const a = i * 2.1 + 0.5;
      ctx.save(); ctx.rotate(a); ctx.beginPath();
      ctx.moveTo(e.r * 0.55, -4); ctx.lineTo(e.r * 0.95, 0); ctx.lineTo(e.r * 0.55, 4); ctx.closePath(); ctx.fill(); ctx.restore();
    }
  }
  // core glow
  ctx.fillStyle = e.type === 0 ? '#93c5fd' : e.type === 1 ? '#fdba74' : '#d8b4fe';
  ctx.beginPath(); ctx.arc(0, 0, e.r * 0.22, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  // hp mini-bar for tanky enemies
  if (e.maxHp > 1 && e.hp < e.maxHp) {
    ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(e.x - e.r, e.y - e.r - 13, e.r * 2, 5);
    ctx.fillStyle = '#f87171'; ctx.fillRect(e.x - e.r, e.y - e.r - 13, e.r * 2 * (e.hp / e.maxHp), 5);
  }
}

function drawBoss(b) {
  const img = SPR.boss;
  if (!sprReady(img)) { drawBossFallback(b); return; }
  const h = VH, w = h * (img.naturalWidth / img.naturalHeight);
  const cx = b.x; // sprite is centered on the boss hitbox center
  ctx.save();
  ctx.drawImage(img, cx - w / 2, b.y - h / 2, w, h);
  if (b.flash > 0) {
    ctx.globalAlpha = 0.7;
    try { ctx.filter = 'brightness(2.6) saturate(0.2)'; } catch (_) {}
    ctx.drawImage(img, cx - w / 2, b.y - h / 2, w, h);
    try { ctx.filter = 'none'; } catch (_) {}
  }
  ctx.restore();
  // burning state: below 65% HP the Pillar catches fire along its left
  // flank — the lava look it has in the reference's later waves
  if (b.hp < b.maxHp * 0.65) {
    const t = performance.now() / 1000;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const fg = ctx.createRadialGradient(cx - b.w * 0.3, b.y, 30, cx - b.w * 0.25, b.y, b.h * 0.62);
    fg.addColorStop(0, 'rgba(255,120,20,0.20)'); fg.addColorStop(1, 'rgba(255,80,0,0)');
    ctx.fillStyle = fg; ctx.fillRect(cx - b.w / 2 - 90, b.y - b.h / 2, b.w + 120, b.h);
    for (let i = 0; i < 8; i++) {
      const fx = cx - b.w * 0.44 + ((i * 53 + Math.floor(b.seed)) % 56);
      const fy = b.y - b.h / 2 + (i + 0.5) * (b.h / 8);
      const fh = 46 + Math.sin(t * 11 + i * 2.3 + b.seed) * 16;
      const fl = ctx.createLinearGradient(fx - fh, fy, fx, fy);
      fl.addColorStop(0, 'rgba(255,90,0,0)'); fl.addColorStop(0.7, 'rgba(255,140,20,0.55)'); fl.addColorStop(1, 'rgba(255,210,90,0.85)');
      ctx.fillStyle = fl;
      ctx.beginPath(); ctx.moveTo(fx, fy - 13); ctx.lineTo(fx - fh, fy); ctx.lineTo(fx, fy + 13); ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }
  // HP bar across the pillar, as in the reference (dark bar, green fill)
  const barW = 234, bx = clamp(cx - barW / 2, 8, VW - barW - 8), by = b.y - VH * 0.29;
  ctx.fillStyle = 'rgba(2,6,18,0.78)'; ctx.fillRect(bx - 2, by - 2, barW + 4, 19);
  ctx.strokeStyle = 'rgba(220,235,255,0.4)'; ctx.lineWidth = 1; ctx.strokeRect(bx - 2, by - 2, barW + 4, 19);
  ctx.fillStyle = '#101828'; ctx.fillRect(bx, by, barW, 15);
  ctx.fillStyle = '#37d67a'; ctx.fillRect(bx, by, barW * clamp(b.hp / b.maxHp, 0, 1), 15);
}

function drawBossFallback(b) {
  ctx.save(); ctx.translate(b.x, b.y);
  const t = performance.now() / 1000;
  // purple flame aura
  for (let i = 0; i < 7; i++) {
    const fy = -b.h / 2 + (i + 0.5) * (b.h / 7);
    const len = (46 + Math.sin(t * 13 + i * 1.7 + b.seed) * 14);
    const fg = ctx.createLinearGradient(b.w / 2, 0, b.w / 2 + len, 0);
    fg.addColorStop(0, 'rgba(192,132,252,0.75)'); fg.addColorStop(1, 'rgba(147,51,234,0)');
    ctx.fillStyle = fg;
    ctx.beginPath(); ctx.moveTo(b.w / 2 - 4, fy - 16); ctx.lineTo(b.w / 2 + len, fy); ctx.lineTo(b.w / 2 - 4, fy + 16); ctx.closePath(); ctx.fill();
  }
  // pillar body
  const g = ctx.createLinearGradient(-b.w / 2, 0, b.w / 2, 0);
  g.addColorStop(0, b.flash > 0 ? '#ffffff' : '#6d28d9'); g.addColorStop(0.55, '#4c1d95'); g.addColorStop(1, '#2e1065');
  ctx.fillStyle = g;
  ctx.beginPath();
  const seg = 9;
  ctx.moveTo(-b.w / 2, -b.h / 2);
  for (let i = 1; i <= seg; i++) ctx.lineTo(-b.w / 2 + Math.sin(i * 3.3 + b.seed) * 9, -b.h / 2 + (b.h / seg) * i);
  for (let i = seg; i >= 0; i--) ctx.lineTo(b.w / 2 - Math.cos(i * 2.9 + b.seed) * 9, -b.h / 2 + (b.h / seg) * i);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = 'rgba(216,180,254,0.5)'; ctx.lineWidth = 2; ctx.stroke();
  // embedded crystals
  for (let i = 0; i < 6; i++) {
    const cy = -b.h / 2 + 40 + i * (b.h - 80) / 5, cx = Math.sin(i * 4.1 + b.seed) * 18;
    drawStar(cx, cy, 11 + (i % 3) * 3, i, '#e9d5ff');
    ctx.fillStyle = 'rgba(233,213,255,0.25)'; ctx.beginPath(); ctx.arc(cx, cy, 20, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

function drawPickupBubble(x, y, r, inner) {
  ctx.save(); ctx.translate(x, y);
  // translucent blue bubble with a bright rim and a glass highlight (as in the reference)
  const g = ctx.createRadialGradient(-r * 0.32, -r * 0.38, r * 0.1, 0, 0, r);
  g.addColorStop(0, 'rgba(190,220,255,0.42)');
  g.addColorStop(0.55, 'rgba(110,160,255,0.16)');
  g.addColorStop(1, 'rgba(90,140,255,0.30)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(205,228,255,0.8)'; ctx.lineWidth = 1.8; ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.beginPath(); ctx.ellipse(-r * 0.36, -r * 0.42, r * 0.20, r * 0.11, -0.6, 0, Math.PI * 2); ctx.fill();
  inner();
  ctx.restore();
}
function drawPowerup(pu) {
  const bobY = pu.y + Math.sin(pu.t) * 5;
  // all orbs share one size: ~3.2% of screen width (diameter)
  const bw = VW * 0.032, br = bw / 2;
  // Piercing Barrage uses the real wave-glyph bubble sprite from the reference
  if (pu.kind === 'pierce' && sprReady(SPR.bubEnergy)) {
    const bh = bw * (SPR.bubEnergy.naturalHeight / SPR.bubEnergy.naturalWidth);
    ctx.drawImage(SPR.bubEnergy, pu.x - bw / 2, bobY - bh / 2, bw, bh);
    return;
  }
  if (pu.kind === 'energy') {
    // Stellar Energy drops as a solid glowing GOLD orb, as in the reference
    ctx.save(); ctx.translate(pu.x, bobY);
    const pulse = 0.85 + Math.sin(pu.t * 2.2) * 0.15;
    const gg = ctx.createRadialGradient(0, 0, br * 0.2, 0, 0, br * 2.1);
    gg.addColorStop(0, 'rgba(255,214,90,' + (0.55 * pulse) + ')'); gg.addColorStop(1, 'rgba(255,170,20,0)');
    ctx.fillStyle = gg; ctx.beginPath(); ctx.arc(0, 0, br * 2.1, 0, Math.PI * 2); ctx.fill();
    const core = ctx.createRadialGradient(-br * 0.3, -br * 0.35, br * 0.1, 0, 0, br);
    core.addColorStop(0, '#fff6d8'); core.addColorStop(0.45, '#ffd76a'); core.addColorStop(1, '#e8930c');
    ctx.fillStyle = core; ctx.beginPath(); ctx.arc(0, 0, br * 0.92, 0, Math.PI * 2); ctx.fill();
    drawStar(0, 0, br * 0.52, pu.t * 0.4, 'rgba(122,72,0,0.85)');
    ctx.restore();
    return;
  }
  if (pu.kind === 'split') drawPickupBubble(pu.x, bobY, br, () => {
    // Starshot Split glyph: three petals (the guide's own icon)
    ctx.fillStyle = '#e0e7ff';
    for (const dx of [-8, 0, 8]) {
      ctx.beginPath(); ctx.ellipse(dx, 0, 3.4, 10, dx * 0.045, 0, Math.PI * 2); ctx.fill();
    }
  });
  else if (pu.kind === 'shield') drawPickupBubble(pu.x, bobY, br, () => {
    // shield glyph, as in the guide's orb icon
    ctx.fillStyle = '#bae6fd';
    ctx.beginPath();
    ctx.moveTo(0, -11); ctx.lineTo(9, -7); ctx.lineTo(9, 1); ctx.quadraticCurveTo(9, 9, 0, 12);
    ctx.quadraticCurveTo(-9, 9, -9, 1); ctx.lineTo(-9, -7); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#0369a1'; drawStar(0, 0, 4.6, 0, '#0369a1');
  });
  else drawPickupBubble(pu.x, bobY, br, () => {
    // Piercing Barrage fallback glyph: wave lines + arrow
    ctx.strokeStyle = '#c7d2fe'; ctx.lineWidth = 3; ctx.lineCap = 'round';
    for (const dy of [-7, 0, 7]) { ctx.beginPath(); ctx.moveTo(-10, dy); ctx.lineTo(4, dy); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(4, -6); ctx.lineTo(12, 0); ctx.lineTo(4, 6); ctx.stroke();
  });
}
function drawCrystal(c) {
  ctx.save(); ctx.translate(c.x, c.y + Math.sin(c.t) * 4);
  ctx.fillStyle = 'rgba(192,132,252,0.25)'; ctx.beginPath(); ctx.arc(0, 0, 20, 0, Math.PI * 2); ctx.fill();
  const cimg = SPR.crystal;
  if (sprReady(cimg)) { // real crystal diamond from the reference (~2.2% of screen width)
    const cw2 = VW * 0.022, ch2 = cw2 * (cimg.naturalHeight / cimg.naturalWidth);
    ctx.drawImage(cimg, -cw2 / 2, -ch2 / 2, cw2, ch2);
    ctx.restore();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(0, -15); ctx.lineTo(10, -4); ctx.lineTo(0, 16); ctx.lineTo(-10, -4); ctx.closePath();
  const g = ctx.createLinearGradient(0, -15, 0, 16);
  g.addColorStop(0, '#e9d5ff'); g.addColorStop(1, '#9333ea');
  ctx.fillStyle = g; ctx.fill(); ctx.strokeStyle = '#d8b4fe'; ctx.lineWidth = 1.4; ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-10, -4); ctx.lineTo(10, -4); ctx.moveTo(0, -15); ctx.lineTo(0, 16); ctx.stroke();
  ctx.restore();
}

function drawOrb(o) {
  ctx.save(); ctx.translate(o.x, o.y);
  // outer glow
  let g = ctx.createRadialGradient(0, 0, o.r * 0.2, 0, 0, o.r * 1.9);
  g.addColorStop(0, 'rgba(255,120,170,0.50)'); g.addColorStop(0.55, 'rgba(255,60,110,0.20)'); g.addColorStop(1, 'rgba(255,60,110,0)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, o.r * 1.9, 0, Math.PI * 2); ctx.fill();
  // molten star core
  g = ctx.createRadialGradient(-o.r * 0.25, -o.r * 0.3, o.r * 0.08, 0, 0, o.r);
  g.addColorStop(0, '#ffffff'); g.addColorStop(0.3, '#ffe9a8'); g.addColorStop(0.62, '#ff9ecf'); g.addColorStop(0.88, '#ff4d7e'); g.addColorStop(1, 'rgba(214,32,90,0.92)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, o.r, 0, Math.PI * 2); ctx.fill();
  // saturn ring, tilted like the reference orbs
  ctx.save(); ctx.rotate(Math.sin(o.ang || 0) * 0.5); ctx.scale(1, 0.34);
  ctx.strokeStyle = 'rgba(255,170,215,0.95)'; ctx.lineWidth = 7;
  ctx.beginPath(); ctx.arc(0, 0, o.r * 1.45, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = 'rgba(255,230,160,0.8)'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(0, 0, o.r * 1.62, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
  for (let i = 0; i < 5; i++) { const a = (o.ang || 0) * 1.7 + i * 2.4; drawSparkle(Math.cos(a) * o.r * 1.15, Math.sin(a) * o.r * 0.8, 7, a, '#ffe9a8', 0.9); }
  ctx.restore();
}

function drawWorld(state) {
  drawBackground();
  // countdown: the reference shows an empty field — background only,
  // no players / enemies / bullets until the run starts (HUD stays up)
  if (G.phase === 'countdown') return;
  const { s, ox, oy } = worldTransform();
  ctx.save();
  ctx.translate(ox, oy); ctx.scale(s, s);
  if (G.shake > 0) ctx.translate(rand(-G.shake, G.shake) * 0.5, rand(-G.shake, G.shake) * 0.5);
  ctx.beginPath(); ctx.rect(0, 0, VW, VH); ctx.clip();

  for (const c of state.crystals) drawCrystal(c);
  for (const pu of state.powerups) drawPowerup(pu);
  if (state.boss) drawBoss(state.boss);
  for (const e of state.enemies) drawEnemy(e);
  for (const o of state.orbs || []) drawOrb(o);
  // bullets: the real petal sprite from the reference (~2.3% of screen
  // width); until it loads, the drawn petal below is the fallback —
  // elongated pale petal, white core, light pink mid, pink edge,
  // with only a faint glow (no saturated orbs)
  for (const b of state.bullets) {
    const bimg = SPR.bullet;
    if (sprReady(bimg)) {
      const bw2 = VW * 0.023, bh2 = bw2 * (bimg.naturalHeight / bimg.naturalWidth);
      ctx.drawImage(bimg, b.x - bw2 / 2, b.y - bh2 / 2, bw2, bh2);
      continue;
    }
    ctx.save(); ctx.translate(b.x, b.y);
    const gg = ctx.createRadialGradient(0, 0, 1, 0, 0, 15);
    gg.addColorStop(0, 'rgba(255,183,224,0.16)'); gg.addColorStop(1, 'rgba(255,183,224,0)');
    ctx.fillStyle = gg; ctx.beginPath(); ctx.arc(0, 0, 15, 0, Math.PI * 2); ctx.fill();
    const lg = ctx.createLinearGradient(-14, 0, 14, 0);
    lg.addColorStop(0, '#ff9ed2'); lg.addColorStop(0.30, '#ffd7ec');
    lg.addColorStop(0.52, '#ffffff'); lg.addColorStop(0.74, '#ffd7ec');
    lg.addColorStop(1, '#ff9ed2');
    ctx.fillStyle = lg;
    ctx.beginPath(); ctx.ellipse(0, 0, 14, 4.2, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  for (const p of state.players) drawPlayer(p);
  // particles: orange/gold star-burst sparks
  for (const pt of state.particles) {
    const a = 1 - pt.t / pt.life;
    drawSparkle(pt.x, pt.y, pt.r * 2.1, pt.x * 0.7 + pt.t * 5, pt.color, a);
  }
  ctx.globalAlpha = 1;
  // nova rings
  for (const r of state.rings) {
    const k = r.t / r.life;
    ctx.globalAlpha = 1 - k;
    ctx.strokeStyle = r.color; ctx.lineWidth = 10 * (1 - k) + 2;
    ctx.beginPath(); ctx.arc(r.x, r.y, 10 + (r.maxR - 10) * k, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  // floaters
  ctx.textAlign = 'center';
  for (const f of state.floaters) {
    ctx.globalAlpha = 1 - f.t / f.life;
    ctx.font = '800 15px system-ui'; ctx.fillStyle = f.color;
    ctx.fillText(f.text, f.x, f.y);
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

/* ------------------------------------------------------------------ HUD / UI */
function heartSVG(off) {
  return '<svg class="heart' + (off ? ' off' : '') + '" viewBox="0 0 24 24" fill="#ff5da2"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';
}
function renderHearts(players) {
  for (let i = 0; i < 2; i++) {
    const row = $('heartsRow' + (i + 1)), cell = $('heartsP' + (i + 1)), p = players[i];
    if (!p) { row.style.display = 'none'; continue; }
    row.style.display = 'flex';
    if (p.dead) cell.innerHTML = '<span class="heart downed-txt">DOWN ' + Math.max(0, Math.ceil(p.deadT || 0)) + 's</span>';
    else { let h = ''; for (let k = 0; k < 3; k++) h += heartSVG(k >= p.hearts); cell.innerHTML = h; }
  }
}
function updateHeartsUI() { renderHearts(G.players); }
function setSkillBtn(btn, label, charges) {
  const txt = charges + '/2';
  if (label.textContent !== txt) label.textContent = txt;
  btn.classList.toggle('empty', charges <= 0);
  btn.classList.toggle('ready', charges > 0); // glowing ring when a charge is ready, as in the reference
}
function renderSkills(players) {
  if (mode === 'local') {
    if (players[0]) setSkillBtn($('skill1'), $('skill1Charges'), players[0].charges);
    if (players[1]) setSkillBtn($('skill2'), $('skill2Charges'), players[1].charges);
  } else if (mode === 'guest') {
    if (players[1]) setSkillBtn($('skill1'), $('skill1Charges'), players[1].charges);
  } else if (players[0]) setSkillBtn($('skill1'), $('skill1Charges'), players[0].charges);
}
function updateSkillUI() { renderSkills(G.players); }
// HUD numbers are drawn with digit sprites extracted from the reference
// video itself (assets/digits_gold, assets/digits_white) — the game's own
// glyphs, including the gold-to-cream gradient on the score.
function digitHTML(str, set) {
  let out = '';
  for (const ch of str) {
    const name = ch === ':' ? 'colon' : ch === '/' ? 'slash' : ch;
    out += `<img src="assets/digits_${set}/${name}.png" alt="${ch}">`;
  }
  return out;
}
function setDigits(el, str, set) {
  if (el.dataset.v === str) return;
  el.dataset.v = str;
  el.innerHTML = digitHTML(str, set);
}
function setHUD(points, crystalCount, elapsed) {
  setDigits($('hudPoints'), String(points), 'gold');
  setDigits($('hudCrystals'), crystalCount + '/10', 'white');
  // reference timer: blank during the countdown, counts DOWN 00:59 -> 00:00
  // through the first minute, then flips to a count-up stopwatch (MM:SS:HH)
  setDigits($('hudTimer'), elapsed <= 0.05 ? '' : fmtTime(elapsed < 60 ? 60 - elapsed : elapsed), 'white');
}
function updateHUD() { setHUD(G.points, G.crystalCount, G.elapsed); }
function updateBossUI() {
  // HP is drawn in-canvas across the pillar (like the reference) — the old DOM bar stays hidden to avoid a duplicate.
  $('bossWrap').classList.remove('on');
}

// countdown numbers are the reference's own ring sprites (assets/cd_1..3.png)
function setCount(n) {
  const img = $('countImg'); if (!img) return;
  if (img.dataset.n != String(n)) {
    img.dataset.n = String(n);
    img.src = 'assets/cd_' + n + '.png';
    img.classList.remove('pulse'); void img.offsetWidth; img.classList.add('pulse');
  }
}

/* ------------------------------------------------------------------ flow */
function showControls() {
  $('hud').classList.add('on');
  // touch controls (joysticks + skill buttons) are optional on PC/laptop:
  // Auto shows them on touch devices only; On/Off forces the choice
  const tc = touchControlsOn();
  $('skill1').classList.toggle('on', tc);
  $('joy1').classList.toggle('on', tc);
  const local = mode === 'local';
  document.body.classList.toggle('local2p', local);
  $('skill2').classList.toggle('on', local && tc);
  $('joy2').classList.toggle('on', local && tc);
  resetJoystickBases();
}
function hideControls() {
  $('hud').classList.remove('on');
  for (const id of ['joy1', 'joy2', 'skill1', 'skill2']) $(id).classList.remove('on');
  $('bossWrap').classList.remove('on');
}
function startGame(m) {
  mode = m;
  ensureAudio();
  resetGame();
  if (m === 'guest') { RG.players = []; RG.bullets = []; RG.enemies = []; RG.powerups = []; RG.crystals = []; RG.particles = []; RG.floaters = []; RG.boss = null; RG.orbs = []; RG.points = 0; RG.crystalCount = 0; RG.elapsed = 0; }
  $('menuScreen').classList.remove('on');
  $('overScreen').classList.remove('on');
  $('pauseScreen').classList.remove('on');
  $('netBanner').classList.remove('on');
  showControls();
  updateHUD();
  G.phase = 'countdown'; G.countT = 3.2; update._lastCount = 4;
  setCount(3);
  $('countdown').classList.add('on');
  if (mode === 'host' && ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'start' }));
}
function pauseGame() {
  if (mode === 'guest') { toast('Pause is controlled by the host'); return; }
  if (G.phase !== 'running' && G.phase !== 'countdown') return;
  G.phase = 'paused';
  $('pauseScreen').classList.add('on');
  if (mode === 'host' && ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'peer-pause' }));
}
function resumeGame() {
  if (G.phase !== 'paused') return;
  $('pauseScreen').classList.remove('on');
  G.phase = 'running';
  if (mode === 'host' && ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'peer-resume' }));
}
// lobby records, like the reference lobby's Highest Points / Longest Time card
function refreshBest() {
  let best = { points: 0, time: 0 };
  try { best = JSON.parse(localStorage.getItem('ss_best') || '{"points":0,"time":0}'); } catch (_) {}
  if ($('bestPoints')) $('bestPoints').textContent = Number(best.points || 0).toLocaleString('en-US');
  if ($('bestTime')) $('bestTime').textContent = fmtTime(best.time || 0);
}
function saveBest() {
  let best = { points: 0, time: 0 };
  try { best = JSON.parse(localStorage.getItem('ss_best') || '{"points":0,"time":0}'); } catch (_) {}
  best.points = Math.max(best.points || 0, G.points);
  best.time = Math.max(best.time || 0, Math.floor(G.elapsed));
  try { localStorage.setItem('ss_best', JSON.stringify(best)); } catch (_) {}
  refreshBest();
}
function endGame() {
  G.phase = 'over';
  saveBest();
  $('finalPoints').textContent = G.points.toLocaleString('en-US');
  $('finalTime').textContent = fmtTime(G.elapsed);
  $('finalKills').textContent = G.kills;
  $('finalCrystals').textContent = G.totalCrystals;
  $('overReason').textContent = G.overReason || 'Your glider was destroyed.';
  $('overScreen').classList.add('on');
  hideControls(); $('hud').classList.add('on'); // keep final HUD visible behind panel
  if (mode === 'host' && ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'peer-event', kind: 'gameover', points: G.points, elapsed: Math.round(G.elapsed), kills: G.kills, totalCrystals: G.totalCrystals, reason: 'Both pilots are down. Mission over!' }));
  }
}
function quitToMenu() {
  G.phase = 'menu';
  refreshBest();
  closeWS();
  $('lobbyBox').classList.remove('on');
  $('pauseScreen').classList.remove('on');
  $('overScreen').classList.remove('on');
  $('countdown').classList.remove('on');
  $('netBanner').classList.remove('on');
  hideControls();
  $('menuScreen').classList.add('on');
  document.body.classList.remove('local2p');
}

/* ------------------------------------------------------------------ online */
let ws = null, roomCode = null, guestSkillQueued = false, snapT = 0, inputT = 0;
let guestInput = { x: 0, y: 0, skill: false };
const RG = { players: [], bullets: [], enemies: [], particles: [], powerups: [], crystals: [], rings: [], floaters: [], boss: null, orbs: [], points: 0, crystalCount: 0, totalCrystals: 0, elapsed: 0, kills: 0 };

function wsURL() { return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host; }
function closeWS() { if (ws) { try { ws.onclose = null; ws.close(); } catch (_) {} ws = null; } roomCode = null; }
function lobbyShow(status, code) {
  $('lobbyBox').classList.add('on');
  if (code !== undefined) $('roomCodeBig').textContent = code || '····';
  if (status) $('lobbyStatus').textContent = status;
}
function connectWS(onOpen) {
  closeWS();
  lobbyShow('Connecting to server…');
  try { ws = new WebSocket(wsURL()); } catch (_) { lobbyShow('Could not connect. Is the game server running?'); return; }
  ws.onopen = onOpen;
  ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch (_) { return; } handleNet(m); };
  ws.onclose = () => {
    if (mode === 'host' || mode === 'guest') {
      if (G.phase === 'running' || G.phase === 'countdown') showDisconnect('Connection to the game server was lost.');
      else lobbyShow('Connection closed. Create or join a room to play online.');
    }
  };
  ws.onerror = () => { lobbyShow('Connection error. Check that the server is running, then try again.'); };
}
function createRoom() {
  ensureAudio();
  connectWS(() => ws.send(JSON.stringify({ type: 'create' })));
}
function joinRoom() {
  ensureAudio();
  const code = $('joinCode').value.trim().toUpperCase();
  if (code.length !== 4) { toast('Enter the 4-letter room code first'); return; }
  connectWS(() => ws.send(JSON.stringify({ type: 'join', code })));
}
function showDisconnect(msg) {
  const b = $('netBanner'); b.textContent = msg + ' Returning to menu…'; b.classList.add('on');
  if (G.phase === 'running') G.phase = 'paused';
  $('pauseScreen').classList.remove('on');
  setTimeout(() => { if (mode === 'host' || mode === 'guest') quitToMenu(); }, 4000);
}
function handleNet(m) {
  switch (m.type) {
    case 'created':
      roomCode = m.code;
      lobbyShow('Waiting for Player 2… Give them this code, on any device on the same server. The game starts automatically when they join.', m.code);
      toast('Room created: ' + m.code);
      break;
    case 'joined':
      roomCode = m.code;
      lobbyShow('Connected! Waiting for the host to start the game…', m.code);
      toast('Joined room ' + m.code);
      break;
    case 'error':
      lobbyShow(m.message || 'Something went wrong.');
      toast(m.message || 'Error');
      break;
    case 'guest-joined':
      lobbyShow('Player 2 connected! Starting…', roomCode);
      toast('Player 2 joined!');
      setTimeout(() => { if (ws) startGame('host'); }, 700);
      break;
    case 'start':
      if (mode !== 'host') startGame('guest');
      break;
    case 'state':
      if (mode === 'guest') applyState(m);
      break;
    case 'input':
      if (mode === 'host') { guestInput.x = m.x || 0; guestInput.y = m.y || 0; if (m.skill) guestInput.skill = true; }
      break;
    case 'peer-pause':
      $('netBanner').textContent = 'Host paused the game.'; $('netBanner').classList.add('on');
      break;
    case 'peer-resume':
      $('netBanner').classList.remove('on');
      break;
    case 'peer-event':
      if (m.kind === 'gameover' && mode === 'guest') {
        RG.points = m.points; RG.elapsed = m.elapsed; RG.kills = m.kills; RG.totalCrystals = m.totalCrystals;
        G.points = m.points; G.elapsed = m.elapsed; G.kills = m.kills; G.totalCrystals = m.totalCrystals;
        G.overReason = m.reason || 'Mission over!';
        endGame();
      }
      break;
    case 'peer-disconnected':
      showDisconnect(m.role === 'host' ? 'The host left the game.' : 'Player 2 left the game.');
      break;
  }
}

/* ---- host -> guest snapshot (~18/sec) */
function buildSnapshot() {
  return {
    type: 'state',
    p: G.players.map((p) => [Math.round(p.x), Math.round(p.y), p.hearts, p.charges, p.dead ? 1 : 0, p.shieldT > 0 ? 1 : 0, p.rapidT > 0 ? 1 : 0, p.invT > 0 ? 1 : 0, Math.round(p.deadT * 10) / 10, Math.round(p.faceT * 10) / 10]),
    b: G.bullets.map((b) => [Math.round(b.x), Math.round(b.y), b.owner]),
    e: G.enemies.map((e) => [Math.round(e.x), Math.round(e.y), e.r, e.type, e.hp, e.maxHp, Math.round(e.rot * 100) / 100, e.flash > 0 ? 1 : 0, Math.round(e.seed)]),
    pu: G.powerups.map((p) => [Math.round(p.x), Math.round(p.y), p.kind, Math.round(p.t * 10) / 10]),
    cr: G.crystals.map((c) => [Math.round(c.x), Math.round(c.y), Math.round(c.t * 10) / 10]),
    boss: G.boss ? [Math.round(G.boss.x), Math.round(G.boss.y), G.boss.w, G.boss.h, G.boss.hp, G.boss.maxHp, G.boss.flash > 0 ? 1 : 0, Math.round(G.boss.seed)] : null,
    o: G.orbs.map((o) => [Math.round(o.x), Math.round(o.y), o.r, Math.round((o.ang || 0) * 100) / 100]),
    pts: G.points, cc: G.crystalCount, tc: G.totalCrystals, el: Math.round(G.elapsed * 10) / 10, k: G.kills,
    ph: G.phase, ev: G.pendingEvents.splice(0, G.pendingEvents.length)
  };
}
function hostSnapshotTick(dt) {
  snapT -= dt;
  if (snapT <= 0 && ws && ws.readyState === 1) { snapT = 0.055; try { ws.send(JSON.stringify(buildSnapshot())); } catch (_) {} }
}

/* ---- guest side */
function guestParticles(x, y, color, n, big) {
  for (let i = 0; i < n; i++) {
    const a = rand(0, Math.PI * 2), sp = rand(40, big ? 420 : 260);
    RG.particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rand(0.3, big ? 0.9 : 0.6), t: 0, r: rand(2, big ? 7 : 5), color });
  }
}
function applyState(m) {
  RG.players = m.p.map((a, i) => ({ idx: i, x: a[0], y: a[1], hearts: a[2], charges: a[3], dead: !!a[4], shieldT: a[5] ? 1 : 0, rapidT: a[6] ? 1 : 0, invT: a[7] ? 0.5 : 0, deadT: a[8], faceT: a[9], r: 24 }));
  RG.bullets = m.b.map((a) => ({ x: a[0], y: a[1], owner: a[2] }));
  RG.enemies = m.e.map((a) => ({ x: a[0], y: a[1], r: a[2], type: a[3], hp: a[4], maxHp: a[5], rot: a[6], flash: a[7] ? 0.08 : 0, seed: a[8], wob: 0, wobSp: 0 }));
  RG.powerups = m.pu.map((a) => ({ x: a[0], y: a[1], kind: a[2], t: a[3] }));
  RG.crystals = m.cr.map((a) => ({ x: a[0], y: a[1], t: a[2] }));
  RG.boss = m.boss ? { x: m.boss[0], y: m.boss[1], w: m.boss[2], h: m.boss[3], hp: m.boss[4], maxHp: m.boss[5], flash: m.boss[6] ? 0.06 : 0, seed: m.boss[7] } : null;
  RG.orbs = (m.o || []).map((a) => ({ x: a[0], y: a[1], r: a[2], ang: a[3] }));
  RG.points = m.pts; RG.crystalCount = m.cc; RG.totalCrystals = m.tc; RG.elapsed = m.el; RG.kills = m.k;
  for (const ev of m.ev || []) {
    if (ev.k === 'boom') { guestParticles(ev.x, ev.y, ev.c, ev.n, ev.big); if (ev.big) G.shake = 10; }
    if (ev.k === 'float') RG.floaters.push({ x: ev.x, y: ev.y, text: ev.text, color: ev.c, t: 0, life: 1.6 });
    if (ev.k === 'wc') showWaveClear(ev.n);
  }
  renderHearts(RG.players); renderSkills(RG.players);
  setHUD(RG.points, RG.crystalCount, RG.elapsed);
  updateBossUI();
}
function sendGuestInput(force) {
  if (!ws || ws.readyState !== 1) return;
  const v = keyVec(0);
  const payload = { type: 'input', x: Math.round(v.x * 100) / 100, y: Math.round(v.y * 100) / 100, skill: guestSkillQueued };
  guestSkillQueued = false;
  try { ws.send(JSON.stringify(payload)); } catch (_) {}
}
function guestTick(dt) {
  G.bgScroll += dt * 25 * (CW / 1920);
  for (const s of stars) { s.x -= dt * 0.028 * s.z; if (s.x < -0.01) { s.x = 1.01; s.y = Math.random(); } }
  if (G.phase === 'countdown') {
    G.countT -= dt;
    const n = Math.ceil(G.countT);
    if (n !== update._lastCount && n >= 1) { update._lastCount = n; setCount(n); sndCount(false); }
    if (G.countT <= 0) { G.phase = 'running'; $('countdown').classList.remove('on'); sndCount(true); }
  }
  if (G.shake > 0) G.shake = Math.max(0, G.shake - dt * 26);
  enemyTrail(RG, dt);
  for (const pt of RG.particles) { pt.t += dt; pt.x += pt.vx * dt; pt.y += pt.vy * dt; pt.vx *= (1 - dt * 1.6); pt.vy *= (1 - dt * 1.6); }
  RG.particles = RG.particles.filter((p) => p.t < p.life);
  for (const f of RG.floaters) { f.t += dt; f.y -= dt * 26; }
  RG.floaters = RG.floaters.filter((f) => f.t < f.life);
  if (G.phase === 'running' || G.phase === 'countdown') { inputT -= dt; if (inputT <= 0) { inputT = 0.04; sendGuestInput(false); } }
}

/* ------------------------------------------------------------------ wiring */
refreshBest();
$('btnSolo').addEventListener('click', () => startGame('solo'));
$('btnLocal').addEventListener('click', () => startGame('local'));
$('btnCreate').addEventListener('click', createRoom);
$('btnJoin').addEventListener('click', joinRoom);
$('joinCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });
$('btnCancelLobby').addEventListener('click', () => { closeWS(); $('lobbyBox').classList.remove('on'); toast('Online lobby closed'); });
$('btnPause').addEventListener('click', () => { ensureAudio(); pauseGame(); });
document.querySelectorAll('.touchModeBtn').forEach((b) => b.addEventListener('click', () => { ensureAudio(); cycleTouchMode(); }));
refreshTouchUI();
{ const ra = $('rotateAnyway'); if (ra) ra.addEventListener('click', () => document.body.classList.add('no-rotate')); }
$('btnResume').addEventListener('click', resumeGame);
$('btnRestart').addEventListener('click', () => { if (mode === 'guest') { toast('Only the host can restart'); return; } startGame(mode); });
$('btnQuit').addEventListener('click', quitToMenu);
$('btnAgain').addEventListener('click', () => { if (mode === 'guest') { toast('Waiting for the host to start a new game…'); return; } startGame(mode); });
$('btnOverMenu').addEventListener('click', quitToMenu);
$('btnMute').addEventListener('click', () => {
  muted = !muted;
  $('icoSoundOn').style.display = muted ? 'none' : '';
  $('icoSoundOff').style.display = muted ? '' : 'none';
  if (!muted) { ensureAudio(); sndPickup(); }
});
$('skill1').addEventListener('pointerdown', (e) => { e.preventDefault(); ensureAudio(); queueSkill(0); });
$('skill2').addEventListener('pointerdown', (e) => { e.preventDefault(); ensureAudio(); queueSkill(1); });
document.addEventListener('contextmenu', (e) => { if (G.phase === 'running') e.preventDefault(); });
document.addEventListener('pointerdown', ensureAudio, { once: true });

/* ------------------------------------------------------------------ loop */
let lastTs = 0;
function loop(ts) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.033, lastTs ? (ts - lastTs) / 1000 : 0.016);
  lastTs = ts;
  if (mode === 'guest' && G.phase !== 'menu') {
    guestTick(dt);
    // guest still needs its own nova rings/particles visuals from RG only
    drawWorld(RG);
    if (G.phase === 'running') renderSkills(RG.players);
  } else {
    update(dt);
    if (mode === 'host' && G.phase !== 'running') hostSnapshotTick(dt);
    drawWorld(G);
    if (G.phase === 'running' || G.phase === 'countdown') { renderHearts(G.players); renderSkills(G.players); }
  }
}
requestAnimationFrame(loop);
