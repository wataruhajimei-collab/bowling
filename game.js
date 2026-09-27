/* =============================================
   Strike Lane  —  game.js
   All game logic, physics, rendering, audio
   ============================================= */
'use strict';

// Cloudflare WorkerのAPI URL
const API_URL = 'https://bowling-api.wataruhajimei.workers.dev';

// ISO 3166-1 alpha-2 国コード → 国旗絵文字
function _countryFlag(code) {
  if (!code || code.length !== 2) return '🌐';
  return String.fromCodePoint(
    ...code.toUpperCase().split('').map(c => 0x1F1E6 + c.charCodeAt(0) - 65)
  );
}

// 名前ごとに独立したplayerIdを取得（名前ごとに一意のIDを管理）
function _getOrCreatePlayerId(currentName = '') {
  const normName = (currentName || localStorage.getItem('strike_lane_name') || 'Anonymous').trim();
  const KEY = `strike_lane_pid_${normName}`;
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'xxxx-xxxx-xxxx'.replace(/x/g, () => Math.random().toString(16)[2]);
    localStorage.setItem(KEY, id);
  }
  return id;
}

/* ─────────────────────────────────────────────
   INTERNATIONALIZATION (i18n)
───────────────────────────────────────────── */
const I18N = {
  ja: {
    subTitle: 'スマホボウリング',
    step1: '左右スライドで<strong>ねらいを定める</strong>',
    step2: 'ラインを<strong>下から上へなぞって投球！</strong>',
    step2Sub: 'まっすぐなぞると直球、ズレるとカーブ',
    throwBtn: '投球！',
    guideStart: 'ここから',
    guideSwipe: '上へスワイプ！',
    hintAim: '左右にスライドして照準を合わせよう',
    hintTrace: '照準ラインを下から上へなぞれ！',
    hintSwipeFirmly: '「ここから」から上へしっかりスワイプ！',
    hintSwipeQuickly: '上に向かってすばやくスワイプ！',
    nameAlert: '名前を入力してください！',
    playersHeader: '人数',
    gamesHeader: '試合',
    playersUnit: '{count}人',
    comment300: '完璧なゲーム！パーフェクト達成！',
    comment200: '素晴らしいスコア！プロ級の実力！',
    comment150: 'とても良いゲームでした！',
    comment100: '良い調子です！練習を続けよう！',
    commentUnder100: 'また挑戦しよう！上達間違いなし！'
  },
  en: {
    subTitle: 'Mobile Bowling',
    step1: 'Slide left / right to <strong>aim</strong>',
    step2: 'Trace the line <strong>bottom-to-top to throw!</strong>',
    step2Sub: 'Trace straight for a direct ball, curve for a hook',
    throwBtn: 'THROW!',
    guideStart: 'Start here',
    guideSwipe: 'Swipe Up!',
    hintAim: 'Slide left or right to aim',
    hintTrace: 'Trace the guide line from bottom to top!',
    hintSwipeFirmly: 'Swipe firmly upward from "Start here"!',
    hintSwipeQuickly: 'Swipe upward quickly!',
    nameAlert: 'Please enter your name!',
    playersHeader: 'PLAYERS',
    gamesHeader: 'GAMES',
    playersUnit: '{count} players',
    comment300: 'Perfect Game! 300 Achievement!',
    comment200: 'Incredible score! Pro-level bowling!',
    comment150: 'Great game! Well played!',
    comment100: 'Nice effort! Keep practicing!',
    commentUnder100: "Keep trying! You'll get better!"
  }
};

let currentLang = localStorage.getItem('strike_lane_lang') || 'ja';

function t(key, params = {}) {
  const dict = I18N[currentLang] || I18N.ja;
  let str = dict[key] || (I18N.ja[key] || '');
  for (const k in params) {
    str = str.replace(`{${k}}`, params[k]);
  }
  return str;
}

function updateStaticText() {
  const subTitle = document.getElementById('sub-title');
  if (subTitle) subTitle.textContent = t('subTitle');

  const step1 = document.getElementById('how-step-1');
  if (step1) step1.innerHTML = t('step1');

  const step2 = document.getElementById('how-step-2');
  if (step2) {
    step2.innerHTML = `${t('step2')}<br><small id="how-step-2-sub">${t('step2Sub')}</small>`;
  }

  const throwBtn = document.getElementById('throw-btn');
  if (throwBtn) throwBtn.textContent = t('throwBtn');

  const colPlayers = document.getElementById('col-header-players');
  if (colPlayers) colPlayers.textContent = t('playersHeader');

  const colGames = document.getElementById('col-header-games');
  if (colGames) colGames.textContent = t('gamesHeader');

  const btnJa = document.getElementById('lang-ja');
  const btnEn = document.getElementById('lang-en');
  if (btnJa) btnJa.classList.toggle('active', currentLang === 'ja');
  if (btnEn) btnEn.classList.toggle('active', currentLang === 'en');
}

// Initial static text update
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', updateStaticText);
  } else {
    updateStaticText();
  }
}

/* ─────────────────────────────────────────────
   CONSTANTS
───────────────────────────────────────────── */
const STATE = {
  TITLE:'TITLE', AIM:'AIM', GUIDE:'GUIDE',
  THROWING:'THROWING', ROLLING:'ROLLING',
  SETTLE:'SETTLE', PROCESSING:'PROCESSING', GAMEOVER:'GAMEOVER',
};

// Lane perspective config (fractions of canvas)
const LANE = {
  topY: 0.20,        // y position of back (pins)
  botY: 0.905,       // y position of front (player)
  topW: 0.36,        // total lane width at top
  botW: 0.92,        // total lane width at bottom
};

// Pin layout: col/row → normalized lane position
// nx: -0.5 (left) to 0.5 (right), center=0
// ny:  0 (player bottom) to 1 (pins top)
const PIN_DEFS = [
  // Row 1 (head pin) - nearest to player
  { id:1,  nx:  0,        ny: 0.855 },
  // Row 2
  { id:2,  nx: -0.085,   ny: 0.888 },
  { id:3,  nx:  0.085,   ny: 0.888 },
  // Row 3
  { id:4,  nx: -0.170,   ny: 0.920 },
  { id:5,  nx:  0,       ny: 0.920 },
  { id:6,  nx:  0.170,   ny: 0.920 },
  // Row 4 - furthest from player
  { id:7,  nx: -0.255,   ny: 0.950 },
  { id:8,  nx: -0.085,   ny: 0.950 },
  { id:9,  nx:  0.085,   ny: 0.950 },
  { id:10, nx:  0.255,   ny: 0.950 },
];

const BALL_HIT_RADIUS  = 0.09;  // match visual contact radius
const PIN_HIT_RADIUS = 0.035; // realistic radius for thin cylindrical pins (prevents overlapping initial state)

/* ─────────────────────────────────────────────
   UTILITIES
───────────────────────────────────────────── */
const clamp  = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp   = (a, b, t) => a + (b - a) * t;
const easeOut3 = t => 1 - (1 - t) ** 3;
const easeOut5 = t => 1 - (1 - t) ** 5;

/* ─────────────────────────────────────────────
   AUDIO MANAGER  (Web Audio API synthesis)
───────────────────────────────────────────── */
class AudioManager {
  constructor() {
    this.actx = null;
    this.masterGain = null;
    this.ready = false;
  }

  init() {
    if (this.ready) return;
    try {
      this.actx = new (window.AudioContext || window.webkitAudioContext)();
      this.masterGain = this.actx.createGain();
      this.masterGain.gain.value = 0.7;

      // Echo / Delay effect
      const delay = this.actx.createDelay();
      delay.delayTime.value = 0.18; // 180ms delay time (rebound reflection off walls)

      const feedback = this.actx.createGain();
      feedback.gain.value = 0.42; // Feedback feedback gain

      const echoFilter = this.actx.createBiquadFilter();
      echoFilter.type = 'lowpass';
      echoFilter.frequency.value = 1800; // Dampen high-pitched reflections on echo

      // Master output connection
      this.masterGain.connect(this.actx.destination);

      // Loop routing
      this.masterGain.connect(delay);
      delay.connect(echoFilter);
      echoFilter.connect(feedback);
      feedback.connect(delay);
      delay.connect(this.actx.destination);

      this.ready = true;
    } catch(e) { console.warn('Audio unavailable', e); }
  }

  _resume() {
    if (this.actx && this.actx.state === 'suspended') {
      this.actx.resume();
    }
  }

  // White noise buffer (cached)
  _noiseBuffer(duration = 1.0) {
    const sr = this.actx.sampleRate;
    const n  = Math.floor(sr * duration);
    const buf = this.actx.createBuffer(1, n, sr);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  // Envelope helper
  _env(gainNode, t, attack, decay, sustain, release) {
    const g = gainNode.gain;
    g.setValueAtTime(0, t);
    g.linearRampToValueAtTime(1, t + attack);
    g.linearRampToValueAtTime(sustain, t + attack + decay);
    g.linearRampToValueAtTime(0, t + attack + decay + release);
  }

  // ---- Bowling ball rolling rumble ----
  playRoll(duration = 1.8) {
    if (!this.ready) return null;
    this._resume();
    const ac = this.actx;
    const now = ac.currentTime;

    // Low rumble: band-pass filtered noise
    const bufSrc = ac.createBufferSource();
    bufSrc.buffer = this._noiseBuffer(Math.ceil(duration) + 0.5);
    bufSrc.loop = false;

    const filt = ac.createBiquadFilter();
    filt.type = 'bandpass';
    filt.frequency.setValueAtTime(90, now);
    filt.frequency.linearRampToValueAtTime(160, now + duration * 0.7);
    filt.Q.value = 1.5;

    const gainNode = ac.createGain();
    gainNode.gain.setValueAtTime(0, now);
    gainNode.gain.linearRampToValueAtTime(0.35, now + 0.25);
    gainNode.gain.setValueAtTime(0.35, now + duration - 0.25);
    gainNode.gain.linearRampToValueAtTime(0, now + duration);

    // Subtle pitch vibration (rumble)
    const lfo = ac.createOscillator();
    lfo.frequency.value = 14;
    const lfoGain = ac.createGain();
    lfoGain.gain.value = 15;
    lfo.connect(lfoGain);
    lfoGain.connect(filt.frequency);
    lfo.start(now);
    lfo.stop(now + duration);

    bufSrc.connect(filt);
    filt.connect(gainNode);
    gainNode.connect(this.masterGain);
    bufSrc.start(now);
    bufSrc.stop(now + duration + 0.1);

    // Return stop function
    return () => {
      try {
        gainNode.gain.cancelScheduledValues(ac.currentTime);
        gainNode.gain.linearRampToValueAtTime(0, ac.currentTime + 0.1);
      } catch(e) {}
    };
  }

  // ---- Single pin knock (realistic hollow clack) ----
  playPinHit(delay = 0, strength = 1.0) {
    if (!this.ready) return;
    this._resume();
    const ac = this.actx;
    const now = ac.currentTime + delay;
    const vol = clamp(strength, 0.3, 1.0);

    // 1. High Resonant Hollow Clack (Bandpass noise with high Q around 1100Hz)
    const nSrc = ac.createBufferSource();
    nSrc.buffer = this._noiseBuffer(0.2);

    const bpf = ac.createBiquadFilter();
    bpf.type = 'bandpass';
    bpf.frequency.setValueAtTime(1100 + Math.random() * 300, now);
    bpf.Q.value = 10; // High Q gives a hollow, ringing "clack" quality

    const nGain = ac.createGain();
    nGain.gain.setValueAtTime(vol * 0.9, now);
    nGain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);

    nSrc.connect(bpf);
    bpf.connect(nGain);
    nGain.connect(this.masterGain);
    nSrc.start(now);
    nSrc.stop(now + 0.20);

    // 2. Tonal Wood Resonance (Triangle sweep for solid pin body body)
    const osc1 = ac.createOscillator();
    osc1.type = 'triangle';
    osc1.frequency.setValueAtTime(950 + Math.random() * 150, now);
    osc1.frequency.exponentialRampToValueAtTime(450, now + 0.08);

    const osc1Gain = ac.createGain();
    osc1Gain.gain.setValueAtTime(vol * 0.35, now);
    osc1Gain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);

    osc1.connect(osc1Gain);
    osc1Gain.connect(this.masterGain);
    osc1.start(now);
    osc1.stop(now + 0.12);

    // 3. High-pitch click/ping (Sine oscillator for surface contact crack)
    const osc2 = ac.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(2400 + Math.random() * 400, now);
    const osc2Gain = ac.createGain();
    osc2Gain.gain.setValueAtTime(vol * 0.20, now);
    osc2Gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);

    osc2.connect(osc2Gain);
    osc2Gain.connect(this.masterGain);
    osc2.start(now);
    osc2.stop(now + 0.07);

    // 4. Low-frequency floor thud (Wood floor resonance)
    const osc3 = ac.createOscillator();
    osc3.type = 'sine';
    osc3.frequency.setValueAtTime(140 + Math.random() * 30, now);
    osc3.frequency.exponentialRampToValueAtTime(55, now + 0.15);

    const osc3Gain = ac.createGain();
    osc3Gain.gain.setValueAtTime(vol * 0.75, now);
    osc3Gain.gain.exponentialRampToValueAtTime(0.001, now + 0.16);

    osc3.connect(osc3Gain);
    osc3Gain.connect(this.masterGain);
    osc3.start(now);
    osc3.stop(now + 0.20);
  }

  // ---- Multiple pins scatter ----
  playPinScatter(count = 5) {
    if (!this.ready) return;
    this._resume();

    const ac = this.actx;
    const now = ac.currentTime;

    // Sub-bass cabinet thump (reverberating deck resonance)
    const subOsc = ac.createOscillator();
    subOsc.type = 'sine';
    subOsc.frequency.setValueAtTime(85, now);
    subOsc.frequency.linearRampToValueAtTime(35, now + 0.35);

    const subGain = ac.createGain();
    subGain.gain.setValueAtTime(1.35, now);
    subGain.gain.exponentialRampToValueAtTime(0.001, now + 0.38);

    subOsc.connect(subGain);
    subGain.connect(this.masterGain);
    subOsc.start(now);
    subOsc.stop(now + 0.45);

    // Denser clattering timings for real scattering feel
    const delays = [];
    for (let i = 0; i < count; i++) {
      // First 3 pins hit almost instantly, others scatter out
      if (i < 3) {
        delays.push(i * 0.015 + Math.random() * 0.01);
      } else {
        delays.push(0.045 + (i - 3) * 0.06 + Math.random() * 0.05);
      }
    }
    delays.sort((a, b) => a - b);
    for (let i = 0; i < Math.min(count, 8); i++) {
      this.playPinHit(delays[i], 0.75 + Math.random() * 0.25);
    }
  }

  // ---- Strike! ----
  playStrike(streak = 1) {
    if (!this.ready) return;
    this._resume();
    const ac = this.actx;
    const now = ac.currentTime + 0.08;

    // Triumphant chord (base)
    let freqs = [220, 330, 440, 550]; // A major 7th
    if (streak === 2) {
      freqs = [261.63, 329.63, 392.00, 523.25, 659.25]; // C major 9 (brighter)
    } else if (streak >= 3) {
      freqs = [293.66, 370.0, 440.0, 587.33, 740.0, 880.0]; // D major (very bright)
    }

    freqs.forEach((f, i) => {
      const osc = ac.createOscillator();
      osc.type = streak >= 3 ? 'sawtooth' : 'triangle';
      osc.frequency.value = f;
      
      const filter = ac.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(f * (streak >= 3 ? 4 : 2), now);

      const g = ac.createGain();
      g.gain.setValueAtTime(0, now + i * 0.06);
      g.gain.linearRampToValueAtTime(0.12, now + i * 0.06 + 0.05);
      g.gain.exponentialRampToValueAtTime(0.001, now + i * 0.06 + (0.8 + streak * 0.2));
      
      osc.connect(filter);
      filter.connect(g);
      g.connect(this.masterGain);
      osc.start(now + i * 0.06);
      osc.stop(now + i * 0.06 + 2.0);
    });

    // Bass boom
    const boom = ac.createOscillator();
    boom.type = 'sine';
    boom.frequency.setValueAtTime(80, now);
    boom.frequency.exponentialRampToValueAtTime(30, now + 0.5);
    const boomG = ac.createGain();
    boomG.gain.setValueAtTime(0.5, now);
    boomG.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
    boom.connect(boomG);
    boomG.connect(this.masterGain);
    boom.start(now);
    boom.stop(now + 0.7);
  }

  // ---- Spare ----
  playSpare() {
    if (!this.ready) return;
    this._resume();
    const ac = this.actx;
    const now = ac.currentTime + 0.1;
    [330, 440].forEach((f, i) => {
      const osc = ac.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      const g = ac.createGain();
      g.gain.setValueAtTime(0, now + i * 0.08);
      g.gain.linearRampToValueAtTime(0.15, now + i * 0.08 + 0.05);
      g.gain.exponentialRampToValueAtTime(0.001, now + i * 0.08 + 0.5);
      osc.connect(g);
      g.connect(this.masterGain);
      osc.start(now + i * 0.08);
      osc.stop(now + i * 0.08 + 0.6);
    });
  }

  // ---- Gutter ----
  playGutter() {
    if (!this.ready) return;
    this._resume();
    const ac = this.actx;
    const now = ac.currentTime;
    const osc = ac.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(120, now);
    osc.frequency.exponentialRampToValueAtTime(40, now + 0.35);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.3, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
    osc.connect(g);
    g.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.45);
  }

  // ---- Swoosh (throw) ----
  playSwoosh() {
    if (!this.ready) return;
    this._resume();
    const ac = this.actx;
    const now = ac.currentTime;
    const buf = ac.createBufferSource();
    buf.buffer = this._noiseBuffer(0.4);
    const lpf = ac.createBiquadFilter();
    lpf.type = 'bandpass';
    lpf.frequency.setValueAtTime(4000, now);
    lpf.frequency.exponentialRampToValueAtTime(800, now + 0.35);
    lpf.Q.value = 2;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0, now);
    g.gain.linearRampToValueAtTime(0.35, now + 0.04);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.38);
    buf.connect(lpf);
    lpf.connect(g);
    g.connect(this.masterGain);
    buf.start(now);
    buf.stop(now + 0.45);
  }
}

/* ─────────────────────────────────────────────
   PIN  (physical object)
───────────────────────────────────────────── */
class Pin {
  constructor(def) {
    Object.assign(this, def);
    this.standing = true;
    this.knockT = 0;      // 0-1 fade out progress
    this.px = this.nx;    // simulated 3D position x
    this.py = this.ny;    // simulated 3D position y
    this.pz = 0;          // simulated 3D position z (height)
    this.vx = 0;          // velocity x
    this.vy = 0;          // velocity y
    this.vz = 0;          // velocity z
    this.rz = 0;          // rotation angle
    this.wz = 0;          // spin angular velocity
    this.wobble  = 0;     // small wobble when near-miss
    this.wobbleDec = 0.88;
    this.chainDelay = 0;
  }

  applyImpulse(vx, vy, wz) {
    if (this.standing) {
      this.standing = false;
      this.knockT = 0;
      this.px = this.nx;
      this.py = this.ny;
      this.pz = 0;
      // Calculate total horizontal velocity applied
      const speed = Math.hypot(vx, vy);
      // Give a strong upward pop based on the impact speed, making pins fly!
      this.vz = 0.45 + speed * 0.8 + Math.random() * 0.3; 
      this.rz = Math.random() * Math.PI * 2;
    }
    this.vx += vx;
    this.vy += vy;
    this.wz += wz;
  }

  knock(fromNx, fromNy) {
    if (!this.standing) return false;
    // Calculate explosion trajectory direction
    const dx = this.nx - fromNx;
    const dy = this.ny - fromNy;
    const dist = Math.hypot(dx, dy) || 1;
    const dirX = dx / dist;
    const dirY = dy / dist;

    // Set physical initial velocities
    const force = 0.82 + Math.random() * 0.75;
    const vx = dirX * force * 0.54 + (Math.random() - 0.5) * 0.16;
    const vy = Math.max(0.12, dirY * force * 0.65 + 0.12);
    const wz = (Math.random() - 0.5) * 16;
    this.applyImpulse(vx, vy, wz);
    return true;
  }

  nearMissWobble(amount = 0.06) {
    if (!this.standing) return;
    this.wobble = amount * (Math.random() > 0.5 ? 1 : -1);
  }

  update(dt) {
    if (!this.standing) {
      if (this.knockT < 1) {
        this.knockT = Math.min(1, this.knockT + dt * 0.65); // slow fadeout
      }

      // Gravitational pull down (reduced slightly to let pins float/fly longer)
      const gravity = -3.8;
      this.vz += gravity * dt;

      // Update positions
      this.px += this.vx * dt;
      this.py += this.vy * dt;
      this.pz += this.vz * dt;

      // Bounce off floor deck
      if (this.pz < 0) {
        this.pz = 0;
        this.vz = -this.vz * 0.42; // bounce coefficient (heavy, slightly inelastic bounce)
        // High friction on bounce to roll heavily
        this.vx *= 0.58;
        this.vy *= 0.58;
        this.wz *= 0.58;
      }

      // Spin rotation
      this.rz += this.wz * dt;
    }

    if (this.wobble !== 0) {
      this.wobble *= this.wobbleDec;
      if (Math.abs(this.wobble) < 0.001) this.wobble = 0;
    }
  }
}

/* ─────────────────────────────────────────────
   PIN SET
───────────────────────────────────────────── */
class PinSet {
  constructor() { this.reset(); }

  reset() {
    this.pins = PIN_DEFS.map(d => new Pin({ ...d }));
    this._chainPending = [];
  }

  resetStanding() {
    // Keep fallen pins, only reset standing ones (for 10th frame)
    this.pins = this.pins.map(p => {
      if (p.standing) {
        return new Pin({ id: p.id, nx: p.nx, ny: p.ny });
      }
      return p;
    });
  }

  update(dt, audio) {
    // 1. Update individual pin physics (positions, velocities, gravity, bounces)
    this.pins.forEach(p => p.update(dt));

    // 2. Real-time elastic collisions between all pins
    const PIN_MASS = 1.0;
    const RESTITUTION = 0.35; // Lower restitution prevents pins from bouncing violently backward
    const HIT_RAD = PIN_HIT_RADIUS * 2;

    for (let i = 0; i < this.pins.length; i++) {
      const p1 = this.pins[i];
      for (let j = i + 1; j < this.pins.length; j++) {
        const p2 = this.pins[j];
        if (p1.standing && p2.standing) continue;

        const x1 = p1.standing ? p1.nx : p1.px;
        const y1 = p1.standing ? p1.ny : p1.py;
        const x2 = p2.standing ? p2.nx : p2.px;
        const y2 = p2.standing ? p2.ny : p2.py;

        const dx = x2 - x1;
        const dy = (y2 - y1) * 1.5; // aspect ratio correction for tall screens
        const d = Math.hypot(dx, dy);

        if (d > 0 && d < HIT_RAD) {
          const nx = dx / d;
          const ny = dy / d;

          // Positional correction
          const overlap = HIT_RAD - d;
          const correction = overlap / 2;
          if (!p1.standing) {
             p1.px -= nx * correction;
             p1.py -= (ny / 1.5) * correction;
          }
          if (!p2.standing) {
             p2.px += nx * correction;
             p2.py += (ny / 1.5) * correction;
          }

          const v1x = p1.standing ? 0 : p1.vx;
          const v1y = p1.standing ? 0 : (p1.vy * 1.5);
          const v2x = p2.standing ? 0 : p2.vx;
          const v2y = p2.standing ? 0 : (p2.vy * 1.5);

          const vrx = v2x - v1x;
          const vry = v2y - v1y;
          const vn = vrx * nx + vry * ny;

          if (vn > 0) continue; 

          const j_impulse = -(1 + RESTITUTION) * vn / (1/PIN_MASS + 1/PIN_MASS);
          const jx = j_impulse * nx;
          const jy = j_impulse * ny;

          const cross = nx * vry - ny * vrx;
          const wz_impulse = cross * -6.0; 

          if (p1.standing) {
             p1.applyImpulse(-jx, -jy / 1.5, -wz_impulse);
          } else {
             p1.vx -= jx;
             p1.vy -= jy / 1.5;
             p1.wz -= wz_impulse;
          }

          if (p2.standing) {
             p2.applyImpulse(jx, jy / 1.5, wz_impulse);
          } else {
             p2.vx += jx;
             p2.vy += jy / 1.5;
             p2.wz += wz_impulse;
          }

          if (audio && Math.abs(j_impulse) > 0.1) {
            audio.playPinHit(0, clamp(Math.abs(j_impulse)*2, 0.3, 1.0));
          }
        }
      }
    }
  }

  // Ball hits pins → direct hit
  checkBallCollision(ball, audio) {
    const BALL_MASS = 14.0; // Ball is much heavier to prevent losing too much momentum
    const PIN_MASS = 1.0;
    const RESTITUTION = 0.45;
    const HIT_RAD = BALL_HIT_RADIUS + PIN_HIT_RADIUS;

    let directHits = [];
    const bx = ball.nx;
    const by = ball.ny;
    const bvx = ball.vx;
    const bvy = ball.vy * 1.5; // aspect ratio mapped velocity

    for (const p of this.pins) {
      if (!p.standing) continue; // Ignore pins that are already knocked down to prevent the ball from getting trapped

      const px = p.nx;
      const py = p.ny;
      const dx = px - bx;
      const dy = (py - by) * 1.5; // aspect ratio correction
      const d = Math.hypot(dx, dy);

      if (d > 0 && d < HIT_RAD) {
        const nx = dx / d;
        const ny = dy / d;
        
        const pvx = p.standing ? 0 : p.vx;
        const pvy = p.standing ? 0 : (p.vy * 1.5);
        const vrx = pvx - bvx;
        const vry = pvy - bvy;
        
        const vn = vrx * nx + vry * ny;
        if (vn > 0) continue; 

        // Positional correction
        const overlap = HIT_RAD - d;
        const totalMass = BALL_MASS + PIN_MASS;
        const b_corr = overlap * (PIN_MASS / totalMass);
        
        ball.nx -= nx * b_corr;
        ball.ny -= (ny / 1.5) * b_corr;

        // Elastic impulse
        const j_impulse = -(1 + RESTITUTION) * vn / (1/PIN_MASS + 1/BALL_MASS);
        const jx = j_impulse * nx;
        const jy = j_impulse * ny;
        
        ball.vx -= jx / BALL_MASS;
        ball.vy -= (jy / 1.5) / BALL_MASS;

        // Angular momentum
        const cross = nx * vry - ny * vrx;
        const wz = cross * -6.0;

        p.applyImpulse(jx / PIN_MASS, (jy / 1.5) / PIN_MASS, wz);
        directHits.push(p);
      } else if (p.standing && d < HIT_RAD * 1.4) {
        p.nearMissWobble();
      }
    }
    
    if (directHits.length > 0) {
      if (audio) audio.playPinScatter(Math.min(directHits.length + 1, 5));
    }
    return directHits.length > 0;
  }

  get standing() { return this.pins.filter(p => p.standing).length; }
  get fallen()   { return this.pins.filter(p => !p.standing).length; }
  get allDown()  { return this.pins.every(p => !p.standing); }
}

/* ─────────────────────────────────────────────
   BALL
───────────────────────────────────────────── */
class Ball {
  constructor() { this.reset(); }

  reset() {
    this.nx = 0; this.ny = 0.03;
    this.vx = 0; this.vy = 0;
    this.curve = 0;
    this.active = false;
    this.inGutter = false;
    this.hitPins  = false;
  }

  // aimNx: where user aimed (-0.5…0.5)
  // speed: normalized 0.3–2.0
  // dev:   J-guide deviation -1…1 (right = +1)
  launch(aimNx, speed, dev, hookCurve = 0) {
    this.nx = aimNx;
    this.ny = 0.03;
    // Initial vx: direct course shift from finger lateral deviation + aim
    this.vx = dev * 0.35 + aimNx * 0.05;
    this.vy = clamp(speed * 0.52, 0.22, 0.95);
    // Curve: direct spin hook from finger curvature trajectory
    this.curve = hookCurve * 0.48;
    this.active = true;
    this.inGutter = false;
    this.hitPins  = false;
  }

  update(dt, pinSet, audio) {
    if (!this.active) return false;

    // Apply curve (gradually changes vx) if not in the gutter
    if (!this.inGutter) {
      this.vx += this.curve * dt;
      this.nx  += this.vx * dt;
    }
    
    // Always force ball to keep rolling forward (prevent bouncing backwards into gutter)
    this.vy = Math.max(0.2, this.vy);
    this.ny  += this.vy * dt;

    // Gutter check
    if (Math.abs(this.nx) > 0.50) {
      if (!this.inGutter) {
        this.inGutter = true;
        this.vx = 0;
        this.curve = 0;
        // Align ball exactly in the gutter center (left -0.51, right 0.51)
        this.nx = Math.sign(this.nx) * 0.51;
        if (audio) audio.playGutter();
      }
    }

    // Gutter sliding (ensure ball stays aligned in gutter channel)
    if (this.inGutter) {
      this.nx = Math.sign(this.nx) * 0.51;
      this.vx = 0;
    }

    // Pin collision (continuous checking)
    if (!this.inGutter && this.ny >= 0.78) {
      const hit = pinSet.checkBallCollision(this, audio);
      if (hit) this.hitPins = true;
    }

    // Ball exits lane
    if (this.ny >= 1.08) {
      this.active = false;
      return true;
    }
    return false;
  }
}

/* ─────────────────────────────────────────────
   BOWLING SCORE
───────────────────────────────────────────── */
class BowlingScore {
  constructor() {
    this.rolls = [];   // flat array of pins knocked per roll
    this.frames = [];  // parsed frames (updated on each roll)
  }

  addRoll(pins) {
    this.rolls.push(pins);
    this._parse();
  }

  _parse() {
    this.frames = [];
    let ri = 0;
    for (let f = 0; f < 10 && ri < this.rolls.length; f++) {
      const r = this.rolls;
      if (f === 9) {
        // 10th frame
        const t = [];
        for (let k = 0; k < 3 && ri + k < r.length; k++) t.push(r[ri + k]);
        let score = null;
        const isStrike = t[0] === 10;
        const isSpare  = !isStrike && t.length >= 2 && (t[0] + t[1]) === 10;
        if (isStrike && t.length === 3) score = t[0] + t[1] + t[2];
        if (isSpare  && t.length === 3) score = t[0] + t[1] + t[2];
        if (!isStrike && !isSpare && t.length === 2) score = t[0] + t[1];
        this.frames.push({ rolls: t, score, type: isStrike ? 'strike' : isSpare ? 'spare' : 'normal', f10: true });
        break;
      }

      if (r[ri] === 10) {
        // Strike
        const b1 = r[ri + 1] ?? null;
        const b2 = r[ri + 2] ?? null;
        const score = (b1 !== null && b2 !== null) ? 10 + b1 + b2 : null;
        this.frames.push({ rolls: [10], score, type: 'strike' });
        ri += 1;
      } else if (ri + 1 < r.length && (r[ri] + r[ri + 1]) === 10) {
        // Spare
        const b = r[ri + 2] ?? null;
        const score = b !== null ? 10 + b : null;
        this.frames.push({ rolls: [r[ri], r[ri+1]], score, type: 'spare' });
        ri += 2;
      } else {
        const s = (ri + 1 < r.length) ? r[ri] + r[ri+1] : null;
        this.frames.push({ rolls: [r[ri], r[ri+1] ?? null], score: s, type: 'normal' });
        ri += 2;
      }
    }
  }

  getTotal() {
    return this.frames.reduce((s, f) => s + (f.score ?? 0), 0);
  }

  getCumulative() {
    let acc = 0;
    return this.frames.map(f => {
      if (f.score !== null) { acc += f.score; return acc; }
      return null;
    });
  }

  get frameCount() { return this.frames.length; }

  isGameOver() {
    if (this.frames.length < 10) return false;
    const last = this.frames[9];
    if (!last) return false;
    if (last.type === 'strike' || last.type === 'spare') return last.rolls.length >= 3;
    return last.rolls.filter(r => r !== null).length >= 2;
  }
}

/* ─────────────────────────────────────────────
   STRAIGHT SWIPE GUIDE & TRACE TRACKER
   Straight guide line with user finger trajectory display
───────────────────────────────────────────── */
class JGuide {
  constructor(cw = window.innerWidth, ch = window.innerHeight) {
    this.points    = [];   // { x, y } guide path in screen space
    this.userTrace = [];   // { x, y } actual user finger path
    this.dists     = [];   // cumulative arc length
    this.totalLen  = 0;

    this.visible   = false;
    this.progress  = 0;    // 0–1 progress along path

    this.tracking   = false;
    this.recentPos  = [];  // { x, y, t }
    this.deviations = [];  // signed lateral deviations (px)

    // 遠近法導入用
    this._aimNx = 0;
    this._w2s   = null;  // Renderer.w2sの参照

    this._build(cw, ch);
  }

  _build(cw, ch) {
    if (!cw || !ch) return;
    // 初期ビルド：w2s未接続時は画面円直線（旧動作）
    const stemX = cw * 0.50;
    const botY  = ch * 0.80;
    const topY  = ch * 0.28;

    this.points = [];
    const SEGS = 50;
    for (let i = 0; i <= SEGS; i++) {
      const t = i / SEGS;
      this.points.push({
        x: stemX,
        y: lerp(botY, topY, t),
      });
    }

    this._rebuildDists();
    this.startPt = this.points[0];
    this.endPt   = this.points[this.points.length - 1];
    this.stemX   = stemX;
  }

  _rebuildDists() {
    this.dists = [0];
    for (let i = 1; i < this.points.length; i++) {
      const dx = this.points[i].x - this.points[i-1].x;
      const dy = this.points[i].y - this.points[i-1].y;
      this.dists.push(this.dists[i-1] + Math.hypot(dx, dy));
    }
    this.totalLen = this.dists[this.dists.length - 1];
  }

  // 遠近法対応: w2s関数でレーンパースに従ったポイントを構築
  setAim(aimNx, w2sFunc) {
    if (!w2sFunc || !this.points.length) return;
    this._aimNx = aimNx;
    this._w2s   = w2sFunc;

    const BOT_NY = 0.02;   // プレイヤー側（ボール付近）
    const TOP_NY = 0.82;   // ピン側
    const SEGS   = this.points.length - 1;

    for (let i = 0; i <= SEGS; i++) {
      const t  = i / SEGS;
      const ny = lerp(BOT_NY, TOP_NY, t);
      const sp = w2sFunc(aimNx, ny);
      this.points[i].x = sp.x;
      this.points[i].y = sp.y;
    }

    this._rebuildDists();
    this.startPt = this.points[0];
    this.endPt   = this.points[this.points.length - 1];
    this.stemX   = this.points[0].x;  // 最下点X（僵倒し用）
  }

  resize(cw, ch) {
    this._build(cw, ch);
    // リサイズ後に遠近法を再適用
    if (this._w2s) this.setAim(this._aimNx, this._w2s);
  }

  // 画面Y座標からガイドライン上の期待Xを補間
  expectedXAtY(sy) {
    const pts = this.points;
    // ポイントは botY(大) → topY(小) 順
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i];
      const p1 = pts[i + 1];
      if (sy <= p0.y && sy >= p1.y) {
        const t = (p0.y - sy) / (p0.y - p1.y);
        return p0.x + (p1.x - p0.x) * t;
      }
    }
    // 範囲外は直近の端点X
    return sy > pts[0].y ? pts[0].x : pts[pts.length - 1].x;
  }

  // 旧互換性のためsetXも残す（内部使用のみ）
  setX(screenX) {
    if (!this.points || this.points.length === 0) return;
    this.stemX = screenX;
    for (const pt of this.points) pt.x = screenX;
    this.startPt = this.points[0];
    this.endPt   = this.points[this.points.length - 1];
  }

  isNearStart(tx, ty, radius = 110) {
    return Math.hypot(tx - this.startPt.x, ty - this.startPt.y) < radius;
  }

  touchStart(tx, ty) {
    if (!this.isNearStart(tx, ty)) return false;
    this.tracking  = true;
    this.progress  = 0;
    this.userTrace = [{ x: tx, y: ty }];
    this.recentPos = [{ x: tx, y: ty, t: Date.now() }];
    // 遠近法ラインからの偶差で初期化
    this.deviations = [tx - this.expectedXAtY(ty)];
    return true;
  }

  touchMove(tx, ty) {
    if (!this.tracking) return;
    const now = Date.now();
    this.userTrace.push({ x: tx, y: ty });
    this.recentPos.push({ x: tx, y: ty, t: now });
    if (this.recentPos.length > 20) this.recentPos.shift();

    // 遠近法ライン上の期待Xからの偶差（ラインに沿っているならdev=0→ボール直進）
    const dev = tx - this.expectedXAtY(ty);
    this.deviations.push(dev);

    // Upward progress
    const startY = this.startPt.y;
    const endY   = this.endPt.y;
    const prog   = clamp((startY - ty) / (startY - endY), 0, 1);
    this.progress = Math.max(this.progress, prog);
  }

  touchEnd() {
    if (!this.tracking) return null;
    this.tracking = false;

    // 1. Calculate Swipe Speed (upward velocity)
    const pos = this.recentPos;
    let speed = 0.4;
    if (pos.length >= 2) {
      const a = pos[Math.max(0, pos.length - 8)];
      const b = pos[pos.length - 1];
      const dt = b.t - a.t;
      if (dt > 0) {
        const dy = a.y - b.y; // upward = positive
        speed = Math.max(dy / dt, 0.1);
      }
    }
    const speedFactor = clamp(speed / 0.65, 0.25, 2.2);

    // 2. Calculate Course Deviation (overall average lateral offset)
    const devs = this.deviations;
    const avgDev = devs.length ? devs.reduce((s, v) => s + v, 0) / devs.length : 0;
    const deviationFactor = clamp(avgDev / 32, -1.2, 1.2);

    // 3. Calculate Finger Trajectory Curvature / Hook Spin
    let hookCurve = 0;
    if (devs.length >= 3) {
      const startDev = devs[0];
      const endDev   = devs[devs.length - 1];
      const midDev   = devs[Math.floor(devs.length / 2)];

      // Curvature: if finger arc curves to the left -> strong left hook; if right -> right hook
      const deltaEnd = endDev - startDev;
      const arcMid   = midDev - (startDev + endDev) / 2;
      hookCurve = clamp((deltaEnd * 1.3 + arcMid * 1.6) / 25, -1.5, 1.5);
    }

    return { speedFactor, deviationFactor, hookCurve, progress: this.progress };
  }
}

/* ─────────────────────────────────────────────
   RENDERER  (Canvas 2D)
───────────────────────────────────────────── */
class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext('2d');
  }

  get cw() { return this.canvas.width; }
  get ch() { return this.canvas.height; }

  // Normalized lane → screen
  w2s(nx, ny) {
    const { cw, ch } = this;
    const topY  = ch * LANE.topY;
    const botY  = ch * LANE.botY;
    const topHW = cw * LANE.topW / 2;
    const botHW = cw * LANE.botW / 2;

    const sy  = botY  + (topY - botY)   * ny;
    const hw  = Math.max(0, botHW + (topHW - botHW) * ny);
    const sx  = cw / 2 + nx * hw / 0.5;  // nx range is -0.5…0.5
    const sc  = 1.0 - ny * 0.50;

    return { x: sx, y: sy, scale: Math.max(sc, 0.35), hw };
  }

  clear() {
    this.ctx.clearRect(0, 0, this.cw, this.ch);
  }

  drawBackground(t) {
    const { ctx, cw, ch } = this;

    // Deep dark gradient
    const bg = ctx.createLinearGradient(0, 0, 0, ch);
    bg.addColorStop(0, '#06061a');
    bg.addColorStop(0.5, '#090920');
    bg.addColorStop(1, '#0c0c24');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, cw, ch);

    // Stars
    ctx.save();
    for (let i = 0; i < 50; i++) {
      const seed = i * 127.3;
      const x = (Math.sin(seed * 0.73) * 0.5 + 0.5) * cw;
      const y = (Math.cos(seed * 0.47) * 0.5 + 0.5) * ch * 0.7;
      const a = 0.25 + 0.2 * Math.sin(t * 1.5 + i);
      const r = 0.7 + 0.5 * Math.abs(Math.sin(seed));
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(180,210,255,${a})`;
      ctx.fill();
    }
    ctx.restore();
  }

  drawLane(t) {
    const { ctx, cw, ch } = this;
    const topY  = ch * LANE.topY;
    const botY  = ch * LANE.botY;
    const topHW = cw * LANE.topW / 2;
    const botHW = cw * LANE.botW / 2;
    const topLX = cw/2 - topHW, topRX = cw/2 + topHW;
    const botLX = cw/2 - botHW, botRX = cw/2 + botHW;

    ctx.save();

    // Main lane surface
    ctx.beginPath();
    ctx.moveTo(botLX, botY);
    ctx.lineTo(botRX, botY);
    ctx.lineTo(topRX, topY);
    ctx.lineTo(topLX, topY);
    ctx.closePath();
    const lg = ctx.createLinearGradient(cw/2, topY, cw/2, botY);
    lg.addColorStop(0, '#1a1305');
    lg.addColorStop(0.35, '#241808');
    lg.addColorStop(0.7, '#2e1e09');
    lg.addColorStop(1, '#362410');
    ctx.fillStyle = lg;
    ctx.fill();

    // Center gloss stripe
    const gloss = ctx.createLinearGradient(cw/2 - 40, 0, cw/2 + 40, 0);
    gloss.addColorStop(0, 'rgba(255,230,150,0)');
    gloss.addColorStop(0.5, 'rgba(255,230,150,0.045)');
    gloss.addColorStop(1, 'rgba(255,230,150,0)');
    ctx.fillStyle = gloss;
    ctx.fill();

    // Gutter strips
    const drawGutter = (lx, rx, fromTop, toTop) => {
      ctx.beginPath();
      ctx.moveTo(lx, botY);
      ctx.lineTo(rx, botY);
      ctx.lineTo(fromTop, topY);
      ctx.lineTo(toTop, topY);
      ctx.closePath();
    };

    // Left gutter
    drawGutter(botLX - cw*0.06, botLX, topLX - cw*0.02, topLX);
    const lgg = ctx.createLinearGradient(botLX - cw*0.06, 0, botLX, 0);
    lgg.addColorStop(0, 'rgba(0,150,220,0.0)');
    lgg.addColorStop(1, 'rgba(0,150,220,0.1)');
    ctx.fillStyle = lgg;
    ctx.fill();

    // Right gutter
    drawGutter(botRX, botRX + cw*0.06, topRX, topRX + cw*0.02);
    const rgg = ctx.createLinearGradient(botRX, 0, botRX + cw*0.06, 0);
    rgg.addColorStop(0, 'rgba(0,150,220,0.1)');
    rgg.addColorStop(1, 'rgba(0,150,220,0.0)');
    ctx.fillStyle = rgg;
    ctx.fill();

    // Lane divider lines (perspective)
    ctx.strokeStyle = 'rgba(255,200,100,0.10)';
    ctx.lineWidth = 0.8;
    for (let nx = -0.36; nx <= 0.36; nx += 0.12) {
      const top = this.w2s(nx, 0.15);
      const bot = this.w2s(nx, 0.87);
      ctx.beginPath();
      ctx.moveTo(top.x, top.y);
      ctx.lineTo(bot.x, bot.y);
      ctx.stroke();
    }

    // Aim markers (arrow dots row)
    const markerNYs = [0.28, 0.36, 0.43, 0.50, 0.57];
    for (const mny of markerNYs) {
      for (let mx = -0.36; mx <= 0.36; mx += 0.12) {
        const sp = this.w2s(mx, mny);
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, 3 * sp.scale, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,190,80,0.38)';
        ctx.fill();
      }
    }

    // Foul line
    const foulL = this.w2s(-0.5, 0.045);
    const foulR = this.w2s( 0.5, 0.045);
    ctx.strokeStyle = 'rgba(255,55,55,0.75)';
    ctx.lineWidth = 2;
    ctx.setLineDash([9, 5]);
    ctx.beginPath();
    ctx.moveTo(foulL.x, foulL.y);
    ctx.lineTo(foulR.x, foulR.y);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.restore();
  }

  drawPinDeck() {
    const { ctx } = this;
    // Pin deck floor (slightly lighter area behind pins)
    const tl = this.w2s(-0.5, 0.84);
    const tr = this.w2s( 0.5, 0.84);
    const bl = this.w2s(-0.5, 1.00);
    const br = this.w2s( 0.5, 1.00);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(tl.x, tl.y);
    ctx.lineTo(tr.x, tr.y);
    ctx.lineTo(br.x, br.y);
    ctx.lineTo(bl.x, bl.y);
    ctx.closePath();
    const dg = ctx.createLinearGradient(this.cw/2, tl.y, this.cw/2, bl.y);
    dg.addColorStop(0, 'rgba(40,28,8,0.4)');
    dg.addColorStop(1, 'rgba(60,42,12,0.35)');
    ctx.fillStyle = dg;
    ctx.fill();
    ctx.restore();
  }

  drawPins(pinSet, t) {
    // Render back-to-front (painter's algorithm: higher py first)
    const sorted = [...pinSet.pins].sort((a, b) => b.py - a.py);
    for (const pin of sorted) {
      const sp = this.w2s(pin.px, pin.py);
      this._drawPin(pin, sp, t);
    }
  }

  _drawPin(pin, sp, t) {
    const { ctx } = this;
    const s  = sp.scale;
    
    // Scale relative to lane width at this depth (sp.hw) to prevent overlapping on narrow screens
    const baseUnit = sp.hw * 0.115 * s;
    const bw = baseUnit;          // base half-width
    const h  = baseUnit * 8.2;    // total height (scaled to realistic tall bowling pin proportions)
    const nw = baseUnit * 0.48;   // neck half-width
    const hw = baseUnit * 0.68;   // head radius

    ctx.save();
    
    // Lift screen position y upwards based on height pz (increased to 3.6 for high visible parabolic arcs)
    const altitude = pin.pz * sp.hw * 3.6;
    ctx.translate(sp.x, sp.y - altitude);

    if (!pin.standing) {
      ctx.rotate(pin.rz); // Spin rotation
      ctx.globalAlpha = Math.max(0, 1.0 - pin.knockT * 0.85); // Fade out near end of timer
    } else if (Math.abs(pin.wobble) > 0.001) {
      ctx.rotate(pin.wobble * Math.PI * 0.08 * Math.sin(t * 30));
    }

    // Volumetric soft shadow under pin
    ctx.beginPath();
    ctx.ellipse(0, 2*s, bw * 0.95, bw * 0.32, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.38)';
    ctx.fill();

    // Body path
    const drawBody = (fillStyle) => {
      ctx.beginPath();
      ctx.moveTo(-bw, 0);
      ctx.bezierCurveTo(-bw, -h*0.28, -nw*1.1, -h*0.52, -nw, -h*0.60);
      ctx.bezierCurveTo(-nw, -h*0.65, -hw, -h*0.67, -hw, -h*0.75);
      ctx.arc(0, -h*0.75 - hw, hw, Math.PI*0.5, Math.PI*1.5, true); // head top
      ctx.arc(0, -h*0.75 - hw, hw, Math.PI*1.5, Math.PI*0.5, false);// head arc
      ctx.bezierCurveTo(hw, -h*0.67, nw, -h*0.65, nw, -h*0.60);
      ctx.bezierCurveTo(nw*1.1, -h*0.52, bw, -h*0.28, bw, 0);
      ctx.closePath();
      ctx.fillStyle = fillStyle;
      ctx.fill();
    };

    // 1. Realistic 3D Cylindrical Cylinder Shading (Linear Gradient with highlights/shadows)
    const cylinderGrad = ctx.createLinearGradient(-bw, 0, bw, 0);
    cylinderGrad.addColorStop(0,    '#686868'); // Ambient occlusion / dark left side
    cylinderGrad.addColorStop(0.18, '#bcbcbc'); // Mid tone
    cylinderGrad.addColorStop(0.38, '#ffffff'); // Specular light reflection band
    cylinderGrad.addColorStop(0.55, '#f0f0f0'); // Base white plastic
    cylinderGrad.addColorStop(0.85, '#cccccc'); // Soft diffuse shadow right
    cylinderGrad.addColorStop(1,    '#808080'); // Dark edge shadow right
    drawBody(cylinderGrad);

    // 2. Volumetric Curved Red Stripes (wrap around the 3D body cylinder)
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(-bw, 0);
    ctx.bezierCurveTo(-bw, -h*0.28, -nw*1.1, -h*0.52, -nw, -h*0.60);
    ctx.bezierCurveTo(-nw, -h*0.65, -hw, -h*0.67, -hw, -h*0.75);
    ctx.arc(0, -h*0.75 - hw, hw, Math.PI*0.5, Math.PI*1.5, true);
    ctx.arc(0, -h*0.75 - hw, hw, Math.PI*1.5, Math.PI*0.5, false);
    ctx.bezierCurveTo(hw, -h*0.67, nw, -h*0.65, nw, -h*0.60);
    ctx.bezierCurveTo(nw*1.1, -h*0.52, bw, -h*0.28, bw, 0);
    ctx.closePath();
    ctx.clip();

    // Draw cylindrical curved bands (using quadratic curve mapping)
    const drawCylinderBand = (yCenter, height) => {
      ctx.beginPath();
      ctx.moveTo(-bw * 1.3, yCenter - height * 0.5);
      ctx.quadraticCurveTo(0, yCenter - height * 0.5 + bw * 0.15, bw * 1.3, yCenter - height * 0.5);
      ctx.lineTo(bw * 1.3, yCenter + height * 0.5);
      ctx.quadraticCurveTo(0, yCenter + height * 0.5 + bw * 0.15, -bw * 1.3, yCenter + height * 0.5);
      ctx.closePath();
      ctx.fillStyle = '#cc1111';
      ctx.fill();
    };

    const stripeY = -h * 0.41;
    const stripeH = h * 0.07;
    drawCylinderBand(stripeY, stripeH);
    drawCylinderBand(stripeY - stripeH * 1.35, stripeH);
    ctx.restore();

    // 3. Realistic Spherical Specular Light Spot on the head
    const headY = -h * 0.75 - hw;
    const headShine = ctx.createRadialGradient(-hw * 0.25, headY - hw * 0.25, 0, -hw * 0.25, headY - hw * 0.25, hw * 0.75);
    headShine.addColorStop(0,   'rgba(255,255,255,0.78)');
    headShine.addColorStop(0.35, 'rgba(255,255,255,0.25)');
    headShine.addColorStop(1,    'rgba(255,255,255,0)');
    ctx.beginPath();
    ctx.arc(0, headY, hw, 0, Math.PI * 2);
    ctx.fillStyle = headShine;
    ctx.fill();

    // 4. Subtle highlights/reflections overlay on the body
    const bodyHighlight = ctx.createRadialGradient(-bw*0.35, -h*0.3, 0, -bw*0.2, -h*0.25, bw*1.1);
    bodyHighlight.addColorStop(0,   'rgba(255,255,255,0.48)');
    bodyHighlight.addColorStop(0.4, 'rgba(255,255,255,0.12)');
    bodyHighlight.addColorStop(1,   'rgba(255,255,255,0)');
    drawBody(bodyHighlight);

    ctx.restore();
  }

  drawBall(ball, aimNx, t) {
    let nx, ny, rolling;
    if (ball.active) {
      nx = ball.nx; ny = ball.ny; rolling = true;
    } else {
      nx = aimNx; ny = 0.03; rolling = false;
    }
    const sp = this.w2s(nx, ny);
    this._drawBallAt(sp, t, rolling);
  }

  _drawBallAt(sp, t, rolling = false) {
    const { ctx } = this;
    const r = 26 * sp.scale;
    ctx.save();
    ctx.translate(sp.x, sp.y);

    // Shadow
    ctx.beginPath();
    ctx.ellipse(0, r * 0.45, r * 1.1, r * 0.32, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fill();

    // Subtle glow when rolling
    if (rolling) {
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.35, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(123,47,247,0.12)';
      ctx.fill();
    }

    // Ball gradient
    const bg = ctx.createRadialGradient(-r*0.32, -r*0.32, 0, 0, 0, r);
    bg.addColorStop(0, '#8855cc');
    bg.addColorStop(0.4, '#4a208a');
    bg.addColorStop(0.78, '#2c1060');
    bg.addColorStop(1, '#1a083a');
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fillStyle = bg;
    ctx.fill();

    // Specular highlight
    const hl = ctx.createRadialGradient(-r*0.38, -r*0.38, 0, -r*0.25, -r*0.25, r*0.62);
    hl.addColorStop(0, 'rgba(255,255,255,0.65)');
    hl.addColorStop(0.35,'rgba(255,255,255,0.18)');
    hl.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fillStyle = hl;
    ctx.fill();

    // Finger holes
    const rotT = rolling ? t * 8 : 0;
    for (const [hx, hy] of [
      [ 0,      -r*0.28],
      [-r*0.22,  r*0.10],
      [ r*0.22,  r*0.10]
    ]) {
      // Rotate holes with ball spin feel
      const rx = hx * Math.cos(rotT) - hy * Math.sin(rotT) * 0;
      const ry = hy;
      ctx.beginPath();
      ctx.arc(rx, ry, r * 0.095, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fill();
    }

    ctx.restore();
  }

  drawAimLine(aimNx, t) {
    const { ctx } = this;
    const ballSp = this.w2s(aimNx, 0.03);
    const pinSp  = this.w2s(aimNx, 0.85);
    const dashOff = (t * 60) % 22;

    ctx.save();
    ctx.strokeStyle = 'rgba(0,245,212,0.55)';
    ctx.lineWidth = 2;
    ctx.setLineDash([11, 9]);
    ctx.lineDashOffset = -dashOff;
    ctx.beginPath();
    ctx.moveTo(ballSp.x, ballSp.y);
    ctx.lineTo(pinSp.x, pinSp.y);
    ctx.stroke();
    ctx.setLineDash([]);

    // Arrow tip
    const ax = pinSp.x, ay = pinSp.y;
    ctx.fillStyle = 'rgba(0,245,212,0.80)';
    ctx.beginPath();
    ctx.moveTo(ax, ay - 7);
    ctx.lineTo(ax - 5, ay + 4);
    ctx.lineTo(ax + 5, ay + 4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  drawJGuide(jg, t) {
    const { ctx } = this;
    const pts = jg.points;
    const pulse = 0.55 + 0.25 * Math.sin(t * 5);

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // 1. Target Straight Guide Line (Cyan)
    const drawStraightPath = () => {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    };

    // Outer glow
    drawStraightPath();
    ctx.lineWidth = 28;
    ctx.strokeStyle = `rgba(0,245,212,0.06)`;
    ctx.stroke();

    // Mid glow
    drawStraightPath();
    ctx.lineWidth = 14;
    ctx.strokeStyle = `rgba(0,245,212,${pulse * 0.22})`;
    ctx.stroke();

    // Core straight line
    drawStraightPath();
    ctx.lineWidth = 5;
    ctx.strokeStyle = `rgba(0,245,212,${pulse})`;
    ctx.stroke();

    // 2. Animated Direction Arrows moving UP along the straight line
    const dashOff = (t * 80) % 24;
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 3;
    ctx.setLineDash([8, 16]);
    ctx.lineDashOffset = dashOff;
    drawStraightPath();
    ctx.stroke();
    ctx.setLineDash([]);

    // 3. User Finger Trajectory Trace (Orange / Pink Neon)
    if (jg.userTrace && jg.userTrace.length > 1) {
      const uTrace = jg.userTrace;
      // visible=true（投球中）→ 全不透明 / false（AIM中＝前回の軌跡）→ 薄く表示
      const ta = jg.visible ? 1.0 : 0.18;

      // Glow behind user trace
      ctx.beginPath();
      ctx.moveTo(uTrace[0].x, uTrace[0].y);
      for (let i = 1; i < uTrace.length; i++) ctx.lineTo(uTrace[i].x, uTrace[i].y);
      ctx.lineWidth = 16;
      ctx.strokeStyle = `rgba(247,37,133,${0.30 * ta})`;
      ctx.stroke();

      // Main user trace line
      ctx.beginPath();
      ctx.moveTo(uTrace[0].x, uTrace[0].y);
      for (let i = 1; i < uTrace.length; i++) ctx.lineTo(uTrace[i].x, uTrace[i].y);
      ctx.lineWidth = 6;
      ctx.strokeStyle = `rgba(247,37,133,${ta})`;
      ctx.stroke();

      // Deviation connector lines: guide line → user trace
      ctx.strokeStyle = `rgba(255,214,10,${0.45 * ta})`;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      for (let i = 0; i < uTrace.length; i += 3) {
        const up = uTrace[i];
        const gx = jg.expectedXAtY(up.y);
        ctx.beginPath();
        ctx.moveTo(gx, up.y);
        ctx.lineTo(up.x, up.y);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      // Current finger position head（投球中のみ表示）
      if (jg.visible) {
        const last = uTrace[uTrace.length - 1];
        ctx.beginPath();
        ctx.arc(last.x, last.y, 10, 0, Math.PI * 2);
        ctx.fillStyle = '#ffd60a';
        ctx.fill();
      }
    }

    // 4. Start Indicator (Bottom)
    const sp = pts[0];
    const pr = 1.0 + 0.18 * Math.sin(t * 6);
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, 24 * pr, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,245,212,0.15)';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(sp.x, sp.y, 12, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,245,212,0.9)';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(sp.x, sp.y, 6, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();

    ctx.fillStyle = 'rgba(0,245,212,0.95)';
    ctx.font = `bold ${12}px 'Outfit', sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(t('guideStart'), sp.x, sp.y + 18);

    // 5. Top Arrow / Goal Indicator
    const ep = pts[pts.length - 1];
    ctx.beginPath();
    ctx.moveTo(ep.x, ep.y - 12);
    ctx.lineTo(ep.x - 10, ep.y + 4);
    ctx.lineTo(ep.x + 10, ep.y + 4);
    ctx.closePath();
    ctx.fillStyle = 'rgba(0,245,212,0.95)';
    ctx.fill();

    ctx.fillStyle = 'rgba(0,245,212,0.95)';
    ctx.font = `bold ${12}px 'Outfit', sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(t('guideSwipe'), ep.x, ep.y - 16);

    ctx.restore();
  }

  // Dim J guide in AIM state (hint)
  drawJGuideHint(jg) {
    if (jg.visible) return;
    const { ctx } = this;
    const pts = jg.points;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(0,245,212,0.18)';
    ctx.stroke();
    ctx.restore();
  }
}

/* ─────────────────────────────────────────────
   BOWLING SCORE UI  (DOM updates)
───────────────────────────────────────────── */
function renderScoreboard(score, currentFrame) {
  const cells = document.getElementById('frame-cells');
  const cum   = score.getCumulative();
  cells.innerHTML = '';

  for (let i = 0; i < 10; i++) {
    const cell = document.createElement('div');
    cell.className = 'frame-cell';
    if (i + 1 === currentFrame) cell.classList.add('current');

    const numDiv  = document.createElement('div');
    numDiv.className = 'frame-num';
    numDiv.textContent = i + 1;

    const throwsDiv = document.createElement('div');
    throwsDiv.className = 'frame-throws';

    const totalDiv = document.createElement('div');
    totalDiv.className = 'frame-total';

    if (i < score.frames.length) {
      const f = score.frames[i];
      if (f.type === 'strike' && !f.f10) {
        throwsDiv.innerHTML = `<span class="strike-mark">✕</span>`;
        cell.classList.add('strike');
      } else if (f.type === 'spare' && !f.f10) {
        const r1 = f.rolls[0] ?? '-';
        throwsDiv.innerHTML = `<span class="t1">${r1}</span><span class="spare-mark">/</span>`;
        cell.classList.add('spare');
      } else {
        // Normal or 10th frame
        const parts = (f.rolls || []).map((r, ri) => {
          if (r === null) return '';
          if (r === 10) return `<span class="strike-mark">✕</span>`;
          if (!f.f10 && ri === 1 && (f.rolls[0] + r) === 10) return `<span class="spare-mark">/</span>`;
          if (f.f10 && ri === 2 && r !== 10 && (f.rolls[1] + r) === 10) return `<span class="spare-mark">/</span>`;
          return `<span class="t${ri+1}">${r}</span>`;
        });
        throwsDiv.innerHTML = parts.filter(p => p).join('');
      }
      if (cum[i] !== null) totalDiv.textContent = cum[i];
    }

    cell.appendChild(numDiv);
    cell.appendChild(throwsDiv);
    cell.appendChild(totalDiv);
    cells.appendChild(cell);
  }

  document.getElementById('frame-number').textContent = Math.min(currentFrame, 10);
}

/* ─────────────────────────────────────────────
   MAIN GAME CLASS
───────────────────────────────────────────── */
class Game {
  constructor() {
    this.canvas = document.getElementById('gameCanvas');
    this.renderer = null;
    this.jGuide  = null;
    this.audio   = new AudioManager();

    this.pinSet = new PinSet();
    this.ball   = new Ball();
    this.score  = new BowlingScore();

    this.state      = STATE.TITLE;
    this.time       = 0;
    this.dt         = 0;
    this._lastRAF   = 0;

    this.aimNx         = 0;
    this._aimDragging  = false;
    this._aimTouchX    = 0;
    this._aimStartNx   = 0;
    this._aimTouchY    = 0;

    this.curFrame  = 1;
    this.curThrow  = 1;
    this.pinsAtStart = 10;   // standing pins when throw began
    this.settleTimer = 0;
    this._rollStop   = null; // fn to stop rolling sound

    this._10thStrikes = 0;   // for 10th frame logic

    this._setupCanvas();
    this._setupEvents();
    this._loop(0);
  }

  /* ── Canvas sizing ── */
  _setupCanvas() {
    const resize = () => {
      const app = document.getElementById('app');
      const rect = app.getBoundingClientRect();
      const w = Math.floor(rect.width || app.clientWidth || window.innerWidth);
      const h = Math.floor(rect.height || app.clientHeight || window.innerHeight);
      if (w <= 0 || h <= 0) return;
      this.canvas.width  = w;
      this.canvas.height = h;
      if (!this.renderer) this.renderer = new Renderer(this.canvas);
      if (!this.jGuide) {
        this.jGuide = new JGuide(w, h);
      } else {
        this.jGuide.resize(w, h);
        // リサイズ後に現在のaimNxで遠近法を再適用
        if (this.renderer) {
          this.jGuide.setAim(this.aimNx, (nx, ny) => this.renderer.w2s(nx, ny));
        }
      }
    };
    window.addEventListener('resize', resize);
    window.addEventListener('orientationchange', () => setTimeout(resize, 300));
    resize();
    setTimeout(resize, 120);
  }

  /* ── Event wiring ── */
  _setupEvents() {
    document.addEventListener('touchstart', e => {
      // Prevent default on canvas to stop pull-to-refresh and scrolling while playing
      if (e.target === this.canvas) {
        e.preventDefault();
      }
    }, { passive: false });
    
    document.addEventListener('touchmove', e => {
      if (e.target === this.canvas) {
        e.preventDefault();
      }
    }, { passive: false });

    const onDown = (tx, ty) => this._onDown(tx, ty);
    const onMove = (tx, ty) => this._onMove(tx, ty);
    const onUp   = (tx, ty) => this._onUp(tx, ty);

    const getLocalCoords = (clientX, clientY) => {
      const rect = this.canvas.getBoundingClientRect();
      const scaleX = this.canvas.width / rect.width;
      const scaleY = this.canvas.height / rect.height;
      return {
        x: (clientX - rect.left) * scaleX,
        y: (clientY - rect.top) * scaleY
      };
    };

    this.canvas.addEventListener('touchstart', e => {
      this.audio.init();
      const t = e.touches[0];
      const local = getLocalCoords(t.clientX, t.clientY);
      onDown(local.x, local.y);
    }, { passive: false });
    this.canvas.addEventListener('touchmove',  e => {
      const t = e.touches[0];
      const local = getLocalCoords(t.clientX, t.clientY);
      onMove(local.x, local.y);
    }, { passive: false });
    this.canvas.addEventListener('touchend',   e => {
      const t = e.changedTouches[0];
      const local = getLocalCoords(t.clientX, t.clientY);
      onUp(local.x, local.y);
    }, { passive: false });

    // Mouse fallback (desktop testing)
    let mouseDown = false;
    this.canvas.addEventListener('mousedown', e => {
      this.audio.init();
      mouseDown = true;
      const local = getLocalCoords(e.clientX, e.clientY);
      onDown(local.x, local.y);
    });
    this.canvas.addEventListener('mousemove', e => {
      if (mouseDown) {
        const local = getLocalCoords(e.clientX, e.clientY);
        onMove(local.x, local.y);
      }
    });
    this.canvas.addEventListener('mouseup', e => {
      mouseDown = false;
      const local = getLocalCoords(e.clientX, e.clientY);
      onUp(local.x, local.y);
    });

    // Name input persistence
    const nameInput = document.getElementById('player-name-input');
    const savedName = localStorage.getItem('strike_lane_name');
    if (savedName) nameInput.value = savedName;
    nameInput.addEventListener('change', () => {
      localStorage.setItem('strike_lane_name', nameInput.value);
    });

    // Language switch buttons
    const btnJa = document.getElementById('lang-ja');
    const btnEn = document.getElementById('lang-en');
    const switchLang = (lang) => {
      currentLang = lang;
      localStorage.setItem('strike_lane_lang', lang);
      updateStaticText();
      if (this._curHintKey) {
        this._setHint(t(this._curHintKey), this._curHintKey);
      }
    };
    if (btnJa) btnJa.addEventListener('click', () => switchLang('ja'));
    if (btnEn) btnEn.addEventListener('click', () => switchLang('en'));

    // Buttons (Use click events, touchstart isn't needed anymore with proper preventDefault scope)
    const startBtn = document.getElementById('start-btn');
    const onStart = (e) => {
      this.audio.init();
      const trimmedName = nameInput.value.trim();
      if (!trimmedName) {
        alert(t('nameAlert'));
        return;
      }
      localStorage.setItem('strike_lane_name', trimmedName);
      nameInput.value = trimmedName;
      this._startGame();
    };
    startBtn.addEventListener('click', onStart);

    const retryBtn = document.getElementById('retry-btn');
    retryBtn.addEventListener('click', onStart);

    const titleBtn = document.getElementById('title-btn');
    if (titleBtn) {
      titleBtn.addEventListener('click', () => {
        this.audio.init();
        document.getElementById('result-screen').classList.add('hidden');
        document.getElementById('title-screen').style.display = 'flex';
        this.state = STATE.TITLE;
      });
    }

    // Leaderboard Buttons
    const showLbBtn = document.getElementById('show-leaderboard-btn');
    const resultLbBtn = document.getElementById('result-leaderboard-btn');
    const closeLbBtn = document.getElementById('close-leaderboard-btn');
    
    const openLeaderboard = (e) => {
      // タブをデフォルト（PLAYER）にリセット
      this._setLbTab('player');
      this._showLeaderboard();
    };
    showLbBtn.addEventListener('click', openLeaderboard);
    resultLbBtn.addEventListener('click', openLeaderboard);

    const closeLeaderboard = (e) => {
      document.getElementById('leaderboard-screen').classList.add('hidden');
    };
    closeLbBtn.addEventListener('click', closeLeaderboard);

    // タブ切替
    document.getElementById('tab-player').addEventListener('click', () => {
      this._setLbTab('player');
      this._showLeaderboard();
    });
    document.getElementById('tab-region').addEventListener('click', () => {
      this._setLbTab('region');
      this._showRegionalLeaderboard();
    });
    document.getElementById('tab-avg').addEventListener('click', () => {
      this._setLbTab('avg');
      this._showAverageLeaderboard();
    });

    // Throw button
    const throwBtn = document.getElementById('throw-btn');
    throwBtn.addEventListener('click', () => {
      this.audio.init();
      this._onThrowBtnPress();
    });
  }

  _onDown(tx, ty) {
    if (this.state === STATE.AIM) {
      this._aimDragging = true;
      this._aimTouchX   = tx;
      this._aimTouchY   = ty;
      this._aimStartNx  = this.aimNx;
    } else if (this.state === STATE.GUIDE) {
      const started = this.jGuide.touchStart(tx, ty);
      if (started) {
        this.state = STATE.THROWING;
        this._setHint(t('hintSwipeQuickly'), 'hintSwipeQuickly');
      }
    } else if (this.state === STATE.THROWING) {
      // If they re-touch during throwing (shouldn't happen much)
    }
  }

  _onMove(tx, ty) {
    if (this.state === STATE.AIM && this._aimDragging) {
      const dx = tx - this._aimTouchX;
      // Sensitivity: full screen width → 0.8 lane units
      this.aimNx = clamp(this._aimStartNx + dx * (0.85 / this.canvas.width), -0.46, 0.46);
      // ── JGuideを遠近法ラインで同期 ──
      if (this.jGuide && this.renderer) {
        this.jGuide.setAim(this.aimNx, (nx, ny) => this.renderer.w2s(nx, ny));
      }
    } else if (this.state === STATE.THROWING) {
      this.jGuide.touchMove(tx, ty);
    }
  }

  _onUp(tx, ty) {
    if (this.state === STATE.AIM && this._aimDragging) {
      this._aimDragging = false;
    } else if (this.state === STATE.THROWING) {
      const result = this.jGuide.touchEnd();
      // Require at least 5% progress to consider it a throw, otherwise treat as abort/jitter
      if (result && result.progress > 0.05) {
        this._executeLaunch(result);
      } else {
        // Invalid trace -> back to guide
        this.state = STATE.GUIDE;
        this.jGuide.progress = 0;
        this._setHint(t('hintSwipeFirmly'), 'hintSwipeFirmly');
      }
    }
  }

  _onThrowBtnPress() {
    if (this.state !== STATE.AIM) return;
    document.getElementById('throw-btn').classList.add('hidden');
    // 投球直前に現在の照準位置でJGuideを遠近法で確定
    if (this.jGuide && this.renderer) {
      this.jGuide.setAim(this.aimNx, (nx, ny) => this.renderer.w2s(nx, ny));
    }
    this.state = STATE.GUIDE;
    this.jGuide.visible  = true;
    this.jGuide.progress = 0;
    this._setHint(t('hintTrace'), 'hintTrace');
  }

  /* ── Game start / reset ── */
  _startGame() {
    document.getElementById('title-screen').style.display = 'none';
    document.getElementById('result-screen').classList.add('hidden');

    this.pinSet = new PinSet();
    this.ball   = new Ball();
    this.score  = new BowlingScore();
    this.aimNx  = 0;
    // JGuideを初期照準位置（センター）に遠近法で合わせる
    if (this.jGuide && this.renderer) {
      this.jGuide.setAim(0, (nx, ny) => this.renderer.w2s(nx, ny));
    }
    this.curFrame = 1;
    this.curThrow = 1;
    this.strikeStreak = 0;
    this._10thStrikes = 0;
    this.state = STATE.AIM;

    document.getElementById('throw-btn').classList.remove('hidden');
    document.getElementById('throw-number').textContent = '1';
    document.getElementById('frame-number').textContent = '1';

    renderScoreboard(this.score, this.curFrame);
    this._setHint(t('hintAim'), 'hintAim');
  }

  /* ── Launch the ball ── */
  _executeLaunch({ speedFactor, deviationFactor, hookCurve, progress }) {
    this.state = STATE.ROLLING;
    this.jGuide.visible = false;
    this._setHint('');

    // Minimum progress check
    if (progress < 0.15 || speedFactor < 0.3) {
      // Too slow / too short → gentle slow ball
      speedFactor = Math.max(speedFactor, 0.35);
    }

    this.ball.launch(this.aimNx, speedFactor, deviationFactor, hookCurve);
    this.pinsAtStart = this.pinSet.standing;
    this.rollTimer = 0; // failsafe timer

    // Rolling sound
    const rollDur = 1.4 + (2.0 - speedFactor) * 0.3;
    this._rollStop = this.audio.playRoll(rollDur);
    this.audio.playSwoosh();
  }

  /* ── Called when ball exits lane ── */
  _onBallDone() {
    if (this._rollStop) { this._rollStop(); this._rollStop = null; }
    this.state = STATE.SETTLE;
    this.settleTimer = 2.5; // use real-time seconds for settle timer
  }

  /* ── After pins settle: record score + next throw ── */
  _afterSettle() {
    try {
      const nowStanding = this.pinSet.standing;
      const knocked     = this.pinsAtStart - nowStanding;

      this.score.addRoll(knocked);

      // Check if this particular roll was a strike
      const isStrike = knocked === 10 && this.pinsAtStart === 10;
      // スペア判定: 2投目で残りピンが0 (1投目がストライクの場合も含む)
      const isSpare  = !isStrike && this.curThrow === 2 && nowStanding === 0;

      // Sound and Banners
      if (isStrike) {
        this.strikeStreak++;
        this.audio.playStrike(this.strikeStreak);
        
        let text = 'STRIKE';
        let emoji = '🎳';
        let cssClass = 'strike';
        
        if (this.strikeStreak === 2) { text = 'DOUBLE'; emoji = '✌️'; cssClass = 'double'; }
        else if (this.strikeStreak === 3) { text = 'TURKEY'; emoji = '🦃'; cssClass = 'turkey'; }
        else if (this.strikeStreak === 4) { text = '4 BAGGER'; emoji = '🍀'; cssClass = 'bagger'; }
        else if (this.strikeStreak === 5) { text = '5 BAGGER'; emoji = '🔥'; cssClass = 'bagger'; }
        else if (this.strikeStreak >= 6) { text = `${this.strikeStreak} BAGGER!`; emoji = '💥'; cssClass = 'mega'; }
        
        this._showBanner(cssClass, emoji, text);
      } else {
        if (this.curThrow === 1) this.strikeStreak = 0; // Reset streak if missed strike on first throw of pins

        if (isSpare) {
          this.audio.playSpare();
          this._showBanner('spare', '✨', 'SPARE');
        } else if (this.ball.inGutter) {
          this._showBanner('gutter', '💨', 'GUTTER');
        }
      }

      renderScoreboard(this.score, this.curFrame);

      // Determine next
      this._advance(knocked, isStrike, isSpare, nowStanding);
    } catch (e) {
      document.getElementById('debug-error').innerText += '\nCAUGHT: ' + (e.stack || e.message);
    }
  }

  _advance(knocked, isStrike, isSpare, remainingPins) {
    const in10th = this.curFrame === 10;

    if (!in10th) {
      if (isStrike || this.curThrow === 2) {
        this.curFrame++;
        this.curThrow = 1;
        this.pinSet.reset();
      } else {
        this.curThrow = 2;
        // Keep fallen pins for 2nd throw
      }

      if (this.curFrame > 10) {
        setTimeout(() => this._endGame(), 800);
        return;
      }
    } else {
      // 10th frame logic
      const rolls10 = this.score.frames[9]?.rolls ?? [];
      if (this.curThrow === 1) {
        if (isStrike) {
          this.pinSet.reset();  // fresh pins for bonus
          this.pinsAtStart = 10; // ピンリセット後にpinsAtStartも更新
          this.curThrow = 2;
        } else {
          this.curThrow = 2;
          // keep fallen pins for 2nd throw
        }
      } else if (this.curThrow === 2) {
        const firstRoll = rolls10[0] ?? 0;
        if (firstRoll === 10) {
          // 1投目ストライク後、2投目もストライクなら新しいピン
          if (knocked === 10) {
            this.pinSet.reset();
            this.pinsAtStart = 10;
          } else if (isSpare) {
            // 1投目ストライク後、2投目スペア → 新しいピンで3投目
            this.pinSet.reset();
            this.pinsAtStart = 10;
          } else {
            // 残りピンで3投目
            this.pinsAtStart = this.pinSet.standing;
          }
          this.curThrow = 3;
        } else if (isSpare) {
          // 通常スペア → 新しいピンで3投目
          this.pinSet.reset();
          this.pinsAtStart = 10;
          this.curThrow = 3;
        } else {
          // ノーストライク・ノースペア → ゲームオーバー
          setTimeout(() => this._endGame(), 900);
          return;
        }
      } else {
        // 3投目終了 → ゲームオーバー
        setTimeout(() => this._endGame(), 900);
        return;
      }
    }

    // Prepare for next throw
    setTimeout(() => this._prepareNextThrow(), 400);
  }

  _prepareNextThrow() {
    try {
      if (this.score.isGameOver()) {
        this._endGame();
        return;
      }
      this.ball.reset();
      this.aimNx = 0;
      this.state = STATE.AIM;

      document.getElementById('throw-number').textContent = this.curThrow;
      document.getElementById('frame-number').textContent = Math.min(this.curFrame, 10);
      document.getElementById('throw-btn').classList.remove('hidden');

      renderScoreboard(this.score, this.curFrame);
      this._setHint(t('hintAim'), 'hintAim');
    } catch (e) {
      document.getElementById('debug-error').innerText += '\nCAUGHT ASYNC: ' + (e.stack || e.message);
    }
  }

  _endGame() {
    this.state = STATE.GAMEOVER;
    const total = this.score.getTotal();

    let emoji, title, comment;
    if (total === 300) {
      emoji = '🏆'; title = 'PERFECT!';
      comment = t('comment300');
    } else if (total >= 200) {
      emoji = '🥇'; title = 'AMAZING!';
      comment = t('comment200');
    } else if (total >= 150) {
      emoji = '🎳'; title = 'GREAT!';
      comment = t('comment150');
    } else if (total >= 100) {
      emoji = '👍'; title = 'GOOD!';
      comment = t('comment100');
    } else {
      emoji = '💪'; title = 'KEEP GOING!';
      comment = t('commentUnder100');
    }

    document.getElementById('result-emoji').textContent  = emoji;
    document.getElementById('result-title').textContent  = title;
    document.getElementById('result-score').textContent  = total;
    document.getElementById('result-comment').textContent = comment;
    document.getElementById('result-screen').classList.remove('hidden');

    // Submit score
    this._submitScore(total);
  }

  /* ── Bonus banner (strike / spare / gutter) ── */
  _showBanner(type, emojiChar, text) {
    const banner = document.getElementById('bonus-banner');
    banner.className = type;
    banner.innerHTML = `<span class="banner-text">${text}</span><span class="banner-sub">${emojiChar}</span>`;
    banner.classList.remove('hidden');
    // Remove old animation class then re-add
    banner.classList.remove('banner-anim');
    void banner.offsetWidth; // reflow
    banner.classList.add('banner-anim');
    setTimeout(() => banner.classList.add('hidden'), 2200);
  }

  /* ── Hint text ── */
  _setHint(msg, key = null) {
    this._curHintKey = key;
    document.getElementById('hint-text').textContent = msg;
  }

  /* ── Leaderboard API ── */
  async _submitScore(score) {
    const name = localStorage.getItem('strike_lane_name') || 'Anonymous';
    if (score === 0) return; // Don't submit 0 points
    const playerId = _getOrCreatePlayerId(name);
    try {
      await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name:     name,
          score:    score,
          date:     new Date().toISOString(),
          playerId: playerId
        })
      });
    } catch (e) {
      console.warn("Could not submit score", e);
    }
  }

  /* ── Leaderboard tab helper ── */
  _setLbTab(tab) {
    const tabs    = ['player', 'region', 'avg'];
    const headers = ['lb-header-player', 'lb-header-region', 'lb-header-avg'];

    tabs.forEach(t => {
      const el = document.getElementById(`tab-${t}`);
      if (el) el.classList.toggle('active', t === tab);
    });
    headers.forEach((id, i) => {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('hidden', tabs[i] !== tab);
    });
  }

  /* ── Leaderboard API ── */
  async _showLeaderboard() {
    const screen = document.getElementById('leaderboard-screen');
    const list = document.getElementById('leaderboard-list');
    screen.classList.remove('hidden');
    list.innerHTML = '<div class="loading-text">Loading...</div>';

    try {
      const res = await fetch(API_URL);
      if (!res.ok) throw new Error("API error");
      const data = await res.json();
      
      list.innerHTML = '';
      if (data.length === 0) {
        list.innerHTML = '<div class="loading-text">No scores yet!</div>';
        return;
      }

      data.forEach((entry, i) => {
        const rank = i + 1;
        const d = new Date(entry.date);
        const dateStr = `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
        const cityStr = entry.city ? `<span class="city-pin">📍</span>${entry.city}` : '';
        
        const item = document.createElement('div');
        item.className = `leaderboard-item rank-${rank}`;
        item.innerHTML = `
          <div class="rank-col">${rank}</div>
          <div class="name-col">${entry.name}</div>
          <div class="score-col">${entry.score}</div>
          <div class="city-col">${cityStr}</div>
          <div class="date-col">${dateStr}</div>
        `;
        list.appendChild(item);
      });
    } catch (e) {
      list.innerHTML = '<div class="loading-text" style="color:var(--pink)">Failed to load scores.<br>Play on Cloudflare to see them!</div>';
    }
  }

  /* ── Regional Leaderboard ── */
  async _showRegionalLeaderboard() {
    const screen = document.getElementById('leaderboard-screen');
    const list = document.getElementById('leaderboard-list');
    screen.classList.remove('hidden');
    list.innerHTML = '<div class="loading-text">Loading...</div>';

    try {
      const res = await fetch(`${API_URL}?mode=regional`);
      if (!res.ok) throw new Error("API error");
      const data = await res.json();

      list.innerHTML = '';
      if (data.length === 0) {
        list.innerHTML = '<div class="loading-text">No regional data yet!<br>Play more games to populate this ranking.</div>';
        return;
      }

      // 最高平均スコア（バー描画用）
      const maxAvg = data[0]?.avg || 1;

      data.forEach((entry, i) => {
        const rank = i + 1;
        const barPct = Math.round((entry.avg / maxAvg) * 100);
        const rankClass = rank <= 3 ? `rank-${rank}` : '';
        const medalEmoji = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `${rank}`;
        const flagEmoji = entry.country ? _countryFlag(entry.country) : '🌐';

        const item = document.createElement('div');
        item.className = `leaderboard-item regional ${rankClass}`;
        item.innerHTML = `
          <div class="rank-col">${medalEmoji}</div>
          <div class="reg-city-col">
            <span style="margin-right:4px">${flagEmoji}</span>${entry.city}
            <div class="reg-avg-bar-wrap"><div class="reg-avg-bar" style="width:${barPct}%"></div></div>
          </div>
          <div class="reg-avg-col">${entry.avg}</div>
          <div class="reg-best-col">🏆${entry.best}</div>
          <div class="reg-count-col">${t('playersUnit', { count: entry.count })}</div>
        `;
        list.appendChild(item);
      });
    } catch (e) {
      list.innerHTML = '<div class="loading-text" style="color:var(--pink)">Failed to load regional data.<br>Play on Cloudflare to see them!</div>';
    }
  }

  async _showAverageLeaderboard() {
    const screen = document.getElementById('leaderboard-screen');
    const list   = document.getElementById('leaderboard-list');
    screen.classList.remove('hidden');
    list.innerHTML = '<div class="loading-text">Loading...</div>';

    try {
      const res = await fetch(`${API_URL}?mode=average`);
      if (!res.ok) throw new Error("API error");
      const data = await res.json();

      list.innerHTML = '';
      if (data.length === 0) {
        list.innerHTML = '<div class="loading-text">No average data yet!<br>Play a few games to appear here.</div>';
        return;
      }

      const maxAvg = data[0]?.avg || 1;

      data.forEach((entry, i) => {
        const rank       = i + 1;
        const rankClass  = rank <= 3 ? `rank-${rank}` : '';
        const medal      = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `${rank}`;
        const cityText   = entry.city ? `<span style="font-size:10px;color:var(--dim);margin-left:4px">(${entry.city})</span>` : '';

        const item = document.createElement('div');
        item.className = `leaderboard-item avg-rank ${rankClass}`;
        item.innerHTML = `
          <div class="rank-col">${medal}</div>
          <div class="avg-name-col">${entry.name}${cityText}</div>
          <div class="avg-avg-col">${entry.avg}</div>
          <div class="avg-best-col">🏆${entry.best}</div>
          <div class="avg-games-col"><span class="avg-games-badge">${entry.games}G</span></div>
        `;
        list.appendChild(item);
      });
    } catch (e) {
      list.innerHTML = '<div class="loading-text" style="color:var(--pink)">Failed to load average data.</div>';
    }
  }

  /* ── Main loop ── */
  _loop(ts) {
    try {
      this.dt = Math.min((ts - this._lastRAF) / 1000, 0.05);
      this._lastRAF = ts;
      this.time += this.dt;

      this._update();
      this._render();
      requestAnimationFrame(t => this._loop(t));
    } catch (e) {
      document.getElementById('debug-error').innerText += '\nCAUGHT LOOP: ' + (e.stack || e.message);
    }
  }

  _update() {
    const dt = this.dt;

    // Apply slow motion when ball hits pins, but not too slow, so it stays explosive!
    const slowFactor = (this.state === STATE.SETTLE || (this.state === STATE.ROLLING && this.ball.hitPins)) ? 0.45 : 1.0;
    const physDt = dt * slowFactor;

    this.pinSet.update(physDt, this.audio);

    if (this.state === STATE.ROLLING) {
      this.rollTimer += dt;
      const done = this.ball.update(physDt, this.pinSet, this.audio);
      
      // Failsafe: if ball is rolling for more than 5 seconds, force it to finish
      if (done || this.rollTimer > 5.0) {
         this._onBallDone();
      }
    }

    if (this.state === STATE.SETTLE) {
      // Settle timer updates in real time to prevent waiting forever
      this.settleTimer -= dt;
      if (this.settleTimer <= 0) {
        this.state = STATE.PROCESSING; // prevent re-entry
        this._afterSettle();
      }
    }
  }

  _render() {
    const r = this.renderer;
    if (!r) return;

    r.clear();

    if (this.state === STATE.TITLE) {
      r.drawBackground(this.time);
      return;
    }

    r.drawBackground(this.time);
    r.drawLane(this.time);
    r.drawPinDeck();
    r.drawPins(this.pinSet, this.time);

    // Ball
    if (this.state !== STATE.GAMEOVER) {
      r.drawBall(this.ball, this.aimNx, this.time);
    }

    // Aim line
    if (this.state === STATE.AIM) {
      r.drawAimLine(this.aimNx, this.time);
    }

    // Straight Guide Line (always visible during aim, guide, throwing)
    if (this.state === STATE.AIM || this.state === STATE.GUIDE || this.state === STATE.THROWING) {
      r.drawJGuide(this.jGuide, this.time);
    }
  }
}

/* ─────────────────────────────────────────────
   BOOTSTRAP
───────────────────────────────────────────── */
window.addEventListener('load', () => {
  new Game();
});
