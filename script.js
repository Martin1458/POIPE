// --- Sync sliders and number inputs ---
const controls = ['volume', 'minInterval', 'maxInterval', 'duration', 'overlap', 'speed', 'volVar', 'pitchVar'];

controls.forEach(name => {
  const slider = document.getElementById(name + 'Slider');
  const input = document.getElementById(name + 'Input');
  if (!slider || !input) return;

  slider.addEventListener('input', () => {
    input.value = slider.value;
    if (name === 'minInterval') updateOverlapVisibility();
    if (name === 'volume') updateVolVarMax();
  });

  input.addEventListener('input', () => {
    let val = Math.max(Number(input.value), Number(slider.min));
    input.value = val;
    slider.value = Math.min(Math.max(val, Number(slider.min)), Number(slider.max));
    if (name === 'minInterval') updateOverlapVisibility();
    if (name === 'volume') updateVolVarMax();
  });
});

// --- Volume variation max capped to current volume ---
function updateVolVarMax() {
  const vol = Number(document.getElementById('volumeInput').value);
  const volVarSlider = document.getElementById('volVarSlider');
  const volVarInput = document.getElementById('volVarInput');
  volVarSlider.max = vol;
  if (Number(volVarInput.value) > vol) {
    volVarInput.value = vol;
    volVarSlider.value = Math.min(vol, Number(volVarSlider.max));
  }
}

// --- State ---
let isRunning = false;
let timers = [];
let sessionTimeout = null;
let activeSounds = 0;
let totalPlays = 0;

// --- Web Audio API (preloaded AudioBuffers for minimal RAM) ---
let audioCtx = null;
function getAudioContext() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

// Preloaded audio buffers: { url/key: AudioBuffer }
const audioBuffers = new Map();

async function loadAudioBuffer(url) {
  if (audioBuffers.has(url)) return audioBuffers.get(url);
  const ctx = getAudioContext();
  const resp = await fetch(url);
  const arr = await resp.arrayBuffer();
  const buffer = await ctx.decodeAudioData(arr);
  audioBuffers.set(url, buffer);
  return buffer;
}

async function loadAudioBufferFromFile(file) {
  const ctx = getAudioContext();
  const arr = await file.arrayBuffer();
  const buffer = await ctx.decodeAudioData(arr);
  return buffer;
}

function playBuffer(buffer, gainValue, speed) {
  const ctx = getAudioContext();
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = speed;
  const gainNode = ctx.createGain();
  gainNode.gain.value = gainValue;
  source.connect(gainNode);
  gainNode.connect(ctx.destination);
  source.start(0);
  // Auto-cleanup: disconnect nodes when done
  source.onended = () => {
    source.disconnect();
    gainNode.disconnect();
  };
  return source;
}

// Preload default sound
function preloadDefault() {
  loadAudioBuffer('POIPE.wav').catch(err => console.warn('Failed to preload POIPE.wav:', err));
}

const startBtn = document.getElementById('startBtn');
const testBtn = document.getElementById('testBtn');
const statusEl = document.getElementById('status');
const playCountEl = document.getElementById('playCount');
const overlapGroup = document.getElementById('overlapGroup');

// --- Overlap visibility/limit based on min interval ---
function updateOverlapVisibility() {
  const minInterval = getVal('minInterval');
  const overlapSlider = document.getElementById('overlapSlider');
  const overlapInput = document.getElementById('overlapInput');

  if (minInterval > 2) {
    overlapGroup.style.display = 'none';
  } else {
    overlapGroup.style.display = '';
    if (minInterval === 2) {
      overlapSlider.max = 1;
      overlapInput.value = Math.min(Number(overlapInput.value), 1);
      overlapSlider.value = overlapInput.value;
    } else if (minInterval === 1) {
      overlapSlider.max = 2;
      overlapInput.value = Math.min(Number(overlapInput.value), 2);
      overlapSlider.value = Math.min(Number(overlapInput.value), 2);
    } else {
      // 0 = infinite, restore full slider range
      overlapSlider.max = 10;
    }
  }
}

// --- Helpers ---
function getVal(name) {
  return Number(document.getElementById(name + 'Input').value);
}

function randomBetween(min, max) {
  return Math.random() * (max - min) + min;
}

// --- Probability Curves ---
const curveSelect = document.getElementById('curveSelect');
const curveCanvas = document.getElementById('curveCanvas');
const ctx = curveCanvas.getContext('2d');

// Curve functions: take a uniform random [0,1] and a strength param, return shaped [0,1]
// strength: 1.0 = default, <1 = flatter (closer to uniform), >1 = more extreme
function getCurveFn(name, strength) {
  switch (name) {
    case 'uniform':    return t => t;
    case 'earlyBias':  return t => Math.pow(t, 1 + strength);           // power > 1 favors low
    case 'lateBias':   return t => 1 - Math.pow(1 - t, 1 + strength);  // favors high
    case 'centerBias': {
      // Blend between uniform (t) and edge-favoring at strength
      return t => {
        const edge = t < 0.5
          ? 0.5 - 0.5 * Math.pow(1 - 2 * t, 1 + strength)
          : 0.5 + 0.5 * Math.pow(2 * t - 1, 1 + strength);
        return t + strength * (edge - t);
      };
    }
    case 'edgeBias': {
      // Blend between uniform (t) and cosine-center at strength
      return t => {
        const center = 0.5 - 0.5 * Math.cos(Math.PI * t);
        return t + strength * (center - t);
      };
    }
    default: return t => t;
  }
}

function getStrength() {
  return Number(document.getElementById('strengthInput').value) / 100;
}

// For the graph we show the PDF (derivative of the CDF curve)
// We approximate it numerically
function drawCurve() {
  const dpr = window.devicePixelRatio || 1;
  const rect = curveCanvas.getBoundingClientRect();
  curveCanvas.width = rect.width * dpr;
  curveCanvas.height = rect.height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const w = rect.width;
  const h = rect.height;
  const pad = 8;
  const curveName = curveSelect.value;
  const curveFn = getCurveFn(curveName, getStrength());

  ctx.clearRect(0, 0, w, h);

  // Compute PDF analytically via numerical differentiation of the CDF
  const steps = 200;
  const pdf = [];
  let maxPdf = 0;
  const eps = 0.001;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // Derivative of CDF = PDF of output distribution
    // For output value t, density = 1 / (derivative of curveFn at inverse point)
    // Easier: numerically differentiate curveFn and invert
    const t0 = Math.max(t - eps, 0);
    const t1 = Math.min(t + eps, 1);
    const dy = curveFn(t1) - curveFn(t0);
    const dx = t1 - t0;
    const derivative = dy / dx;
    // PDF of output = 1 / derivative (inverse function theorem)
    const density = derivative > 0.0001 ? 1 / derivative : 0;
    pdf.push(density);
    if (density > maxPdf) maxPdf = density;
  }

  // Draw filled area
  const graphW = w - pad * 2;
  const graphH = h - pad * 2;

  ctx.beginPath();
  ctx.moveTo(pad, h - pad);
  for (let i = 0; i <= steps; i++) {
    const x = pad + (i / steps) * graphW;
    const y = (h - pad) - (pdf[i] / (maxPdf || 1)) * graphH * 0.85;
    ctx.lineTo(x, y);
  }
  ctx.lineTo(pad + graphW, h - pad);
  ctx.closePath();

  ctx.fillStyle = 'rgba(233, 69, 96, 0.2)';
  ctx.fill();

  // Draw line
  ctx.beginPath();
  for (let i = 0; i <= steps; i++) {
    const x = pad + (i / steps) * graphW;
    const y = (h - pad) - (pdf[i] / (maxPdf || 1)) * graphH * 0.85;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = '#e94560';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Axis labels
  ctx.fillStyle = '#555';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('min', pad, h - 1);
  ctx.textAlign = 'right';
  ctx.fillText('max', w - pad, h - 1);
}

curveSelect.addEventListener('change', () => {
  updateStrengthVisibility();
  drawCurve();
});
window.addEventListener('resize', drawCurve);

// Redraw graph when advanced section is opened
document.getElementById('advancedSection').addEventListener('toggle', function () {
  if (this.open) drawCurve();
});

// Strength slider sync and redraw
const strengthSlider = document.getElementById('strengthSlider');
const strengthInput = document.getElementById('strengthInput');
const strengthRow = document.getElementById('strengthRow');
const strengthInfo = document.getElementById('strengthInfo');

strengthSlider.addEventListener('input', () => {
  strengthInput.value = strengthSlider.value;
  drawCurve();
});
strengthInput.addEventListener('input', () => {
  let val = Math.max(Number(strengthInput.value), 0);
  strengthInput.value = val;
  strengthSlider.value = Math.min(val, 500);
  drawCurve();
});

function updateStrengthVisibility() {
  const hidden = curveSelect.value === 'uniform';
  strengthRow.style.display = hidden ? 'none' : '';
  strengthInfo.style.display = hidden ? 'none' : '';
}

function shapedRandom(min, max) {
  const curveFn = getCurveFn(curveSelect.value, getStrength());
  const u = Math.random();
  const shaped = curveFn(u);
  return min + shaped * (max - min);
}

// --- Sound Files ---
let soundFiles = []; // Array of { name, key, buffer } for user-added files

const soundFileInput = document.getElementById('soundFileInput');
const soundFileList = document.getElementById('soundFileList');

soundFileInput.addEventListener('change', async (e) => {
  for (const file of e.target.files) {
    try {
      const buffer = await loadAudioBufferFromFile(file);
      const key = 'user_' + Date.now() + '_' + file.name;
      audioBuffers.set(key, buffer);
      soundFiles.push({ name: file.name, key });
    } catch (err) {
      console.warn('Failed to load sound file:', file.name, err);
    }
  }
  renderSoundFileList();
  soundFileInput.value = '';
});

function renderSoundFileList() {
  soundFileList.innerHTML = '';
  soundFiles.forEach((sf, i) => {
    const div = document.createElement('div');
    div.className = 'sound-file-item';
    div.innerHTML = `<span class="sound-name">${sf.name}</span><button class="remove-sound" data-idx="${i}">✕</button>`;
    soundFileList.appendChild(div);
  });
  soundFileList.querySelectorAll('.remove-sound').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.idx);
      audioBuffers.delete(soundFiles[idx].key);
      soundFiles.splice(idx, 1);
      renderSoundFileList();
    });
  });
}

function getRandomBufferKey() {
  if (soundFiles.length === 0) return 'POIPE.wav';
  const all = ['POIPE.wav', ...soundFiles.map(sf => sf.key)];
  return all[Math.floor(Math.random() * all.length)];
}

// Silent preload: plays at volume 0 so the audio pipeline warms up without audible sound
function playSilentPreload() {
  const key = getRandomBufferKey();
  const buffer = audioBuffers.get(key);
  if (!buffer) { console.warn('Buffer not loaded for preload:', key); return; }
  const source = playBuffer(buffer, 0, 1);
  // Stop almost immediately — just enough to unlock the audio context
  setTimeout(() => { try { source.stop(); } catch(e) {} }, 50);
}

function playSound() {
  const minInterval = getVal('minInterval');
  let maxOverlap;
  if (minInterval > 2) {
    maxOverlap = 1;
  } else if (minInterval === 0) {
    maxOverlap = Infinity;
  } else {
    maxOverlap = getVal('overlap');
  }
  if (activeSounds >= maxOverlap) return;

  const baseVol = getVal('volume') / 100;
  const volVar = getVal('volVar') / 100;
  const vol = Math.max(0, baseVol + randomBetween(-volVar, volVar));
  const baseSpeed = getVal('speed') / 100;
  const pitchVar = getVal('pitchVar') / 100;
  const speed = Math.max(0.1, baseSpeed + randomBetween(-pitchVar, pitchVar));

  const key = getRandomBufferKey();
  const buffer = audioBuffers.get(key);
  if (!buffer) { console.warn('Buffer not loaded:', key); return; }

  activeSounds++;
  totalPlays++;
  playCountEl.textContent = `Played ${totalPlays} time${totalPlays !== 1 ? 's' : ''} | ${activeSounds} active`;

  const source = playBuffer(buffer, vol, speed);
  const origOnended = source.onended;
  source.onended = () => {
    activeSounds--;
    playCountEl.textContent = `Played ${totalPlays} time${totalPlays !== 1 ? 's' : ''} | ${activeSounds} active`;
    if (origOnended) origOnended();
  };
}

function scheduleNext() {
  if (!isRunning) return;

  const minSec = getVal('minInterval');
  const maxSec = getVal('maxInterval');
  const actualMin = Math.min(minSec, maxSec);
  const actualMax = Math.max(minSec, maxSec);

  const delaySec = shapedRandom(actualMin, actualMax);
  const delayMs = delaySec * 1000;

  const timerId = setTimeout(() => {
    // Remove this timer from the array
    const idx = timers.indexOf(timerId);
    if (idx !== -1) timers.splice(idx, 1);
    if (!isRunning) return;
    playSound();
    scheduleNext();
  }, delayMs);

  timers.push(timerId);
}

function startSession() {
  isRunning = true;
  totalPlays = 0;
  activeSounds = 0;
  playCountEl.textContent = '';

  startBtn.textContent = 'Stop';
  startBtn.classList.add('running');
  statusEl.textContent = 'Running...';
  statusEl.classList.add('active');

  // Ease-in lava background scroll
  lavaScrollTarget = 1;

  // Hide controls panel
  const panel = document.getElementById('controlsPanel');
  if (panel) panel.classList.add('hidden');
  document.querySelector('.container').classList.add('session-active');

  // Play one silently (volume 0) to preload audio into memory
  playSilentPreload();
  scheduleNext();

  // Session duration
  const durationMin = getVal('duration');
  if (durationMin > 0) {
    sessionTimeout = setTimeout(() => {
      stopSession();
      statusEl.textContent = 'Session ended (duration reached)';
    }, durationMin * 60 * 1000);
  }
}

function stopSession() {
  isRunning = false;
  timers.forEach(t => clearTimeout(t));
  timers = [];
  if (sessionTimeout) {
    clearTimeout(sessionTimeout);
    sessionTimeout = null;
  }

  startBtn.textContent = 'Start';
  startBtn.classList.remove('running');
  statusEl.textContent = 'Stopped';
  statusEl.classList.remove('active');

  // Ease-out lava background scroll
  lavaScrollTarget = 0;

  // Show controls panel
  const panel = document.getElementById('controlsPanel');
  if (panel) panel.classList.remove('hidden');
  document.querySelector('.container').classList.remove('session-active');
}

// --- Event Listeners ---
startBtn.addEventListener('click', () => {
  if (isRunning) {
    stopSession();
  } else {
    startSession();
  }
});

testBtn.addEventListener('click', () => {
  const baseVol = getVal('volume') / 100;
  const volVar = getVal('volVar') / 100;
  const vol = Math.max(0, baseVol + randomBetween(-volVar, volVar));
  const baseSpeed = getVal('speed') / 100;
  const pitchVar = getVal('pitchVar') / 100;
  const speed = Math.max(0.1, baseSpeed + randomBetween(-pitchVar, pitchVar));
  const key = getRandomBufferKey();
  const buffer = audioBuffers.get(key);
  if (!buffer) { console.warn('Buffer not loaded:', key); return; }
  playBuffer(buffer, vol, speed);
});

// --- Defaults ---
const defaults = {
  volume: 50,
  minInterval: 0,
  maxInterval: 420,
  duration: 60,
  overlap: 3,
  speed: 100,
  volVar: 0,
  pitchVar: 0
};

// --- Presets ---
const builtInPresets = {
  chill: { volume: 30, minInterval: 300, maxInterval: 600, duration: 60, overlap: 1, speed: 100, volVar: 10, pitchVar: 5 },
  normal: { volume: 50, minInterval: 0, maxInterval: 420, duration: 60, overlap: 3, speed: 100, volVar: 0, pitchVar: 0 },
  frequent: { volume: 60, minInterval: 0, maxInterval: 60, duration: 60, overlap: 3, speed: 100, volVar: 15, pitchVar: 10 },
  chaos: { volume: 250, minInterval: 0, maxInterval: 5, duration: 10, overlap: 10, speed: 100, volVar: 100, pitchVar: 70 },
};

function getAllSettings() {
  const settings = {};
  for (const name of Object.keys(defaults)) {
    settings[name] = getVal(name);
  }
  settings.curve = curveSelect.value;
  settings.strength = Number(strengthInput.value);
  return settings;
}

function applySettings(s) {
  for (const [name, val] of Object.entries(s)) {
    if (name === 'curve' || name === 'strength') continue;
    const slider = document.getElementById(name + 'Slider');
    const input = document.getElementById(name + 'Input');
    if (slider && input) {
      input.value = val;
      slider.value = Math.min(Math.max(val, Number(slider.min)), Number(slider.max));
    }
  }
  if (s.curve) curveSelect.value = s.curve;
  if (s.strength !== undefined) {
    strengthSlider.value = Math.min(s.strength, 500);
    strengthInput.value = s.strength;
  }
  updateOverlapVisibility();
  updateStrengthVisibility();
  updateVolVarMax();
  drawCurve();
}

// Built-in preset buttons
document.querySelectorAll('.btn-preset[data-preset]').forEach(btn => {
  btn.addEventListener('click', () => {
    const key = btn.dataset.preset;
    if (builtInPresets[key]) applySettings(builtInPresets[key]);
  });
});

// --- Cookie / Storage Consent ---
let storageAllowed = false;

function checkStorageConsent() {
  try {
    const consent = localStorage.getItem('poipe_cookie_consent');
    if (consent === 'yes') { storageAllowed = true; return 'yes'; }
    if (consent === 'no') { storageAllowed = false; return 'no'; }
  } catch { /* storage blocked entirely */ }
  return null; // not yet decided
}

function applyStorageState() {
  const section = document.getElementById('customPresetsSection');
  const warning = document.getElementById('cookieWarning');
  if (storageAllowed) {
    section.style.display = '';
    warning.style.display = 'none';
    renderCustomPresets();
  } else {
    section.style.display = 'none';
    warning.style.display = '';
  }
}

const cookiePopup = document.getElementById('cookiePopup');

document.getElementById('cookieAccept').addEventListener('click', () => {
  storageAllowed = true;
  try { localStorage.setItem('poipe_cookie_consent', 'yes'); } catch {}
  cookiePopup.style.display = 'none';
  applyStorageState();
});

document.getElementById('cookieDecline').addEventListener('click', () => {
  storageAllowed = false;
  try { localStorage.setItem('poipe_cookie_consent', 'no'); } catch {}
  cookiePopup.style.display = 'none';
  applyStorageState();
});

// Show popup if no decision yet, otherwise apply saved choice
const consentResult = checkStorageConsent();
if (consentResult === null) {
  cookiePopup.style.display = '';
} else {
  cookiePopup.style.display = 'none';
}
applyStorageState();

// Custom presets (localStorage)
function loadCustomPresets() {
  if (!storageAllowed) return {};
  try { return JSON.parse(localStorage.getItem('poipe_presets') || '{}'); }
  catch { return {}; }
}

function saveCustomPresets(presets) {
  if (!storageAllowed) return;
  localStorage.setItem('poipe_presets', JSON.stringify(presets));
}

function renderCustomPresets() {
  const container = document.getElementById('customPresets');
  container.innerHTML = '';
  const presets = loadCustomPresets();
  for (const [name, settings] of Object.entries(presets)) {
    const btn = document.createElement('button');
    btn.className = 'btn-preset btn-preset-custom';
    btn.textContent = name;
    btn.addEventListener('click', () => applySettings(settings));
    const del = document.createElement('button');
    del.className = 'btn-preset-delete';
    del.textContent = '✕';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      const p = loadCustomPresets();
      delete p[name];
      saveCustomPresets(p);
      renderCustomPresets();
    });
    btn.appendChild(del);
    container.appendChild(btn);
  }
}

document.getElementById('savePresetBtn').addEventListener('click', () => {
  const nameInput = document.getElementById('presetName');
  const name = nameInput.value.trim();
  if (!name) return;
  const presets = loadCustomPresets();
  presets[name] = getAllSettings();
  saveCustomPresets(presets);
  renderCustomPresets();
  nameInput.value = '';
});

renderCustomPresets();

// --- Init ---
updateOverlapVisibility();
updateStrengthVisibility();
updateVolVarMax();
preloadDefault();

drawCurve();

// === Lava Blob System — fully JS-driven, infinite with respawn ===
(function initLavaBlobs() {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const container = document.getElementById('lava-blobs');
  if (!container) return;

  const W = 800, H = 400;
  const fills = ['url(#blob1)', 'url(#blob2)', 'url(#blob3)', 'url(#blob4)', 'url(#blob5)'];

  function rand(a, b) { return a + Math.random() * (b - a); }
  function randInt(a, b) { return Math.floor(rand(a, b + 1)); }

  // Each blob is a JS object with its own state
  // { el, cx, cy, rx, ry, vx, vy, rxBase, ryBase, morphPhaseX, morphPhaseY, morphSpeedX, morphSpeedY, morphAmpX, morphAmpY, driftPhase, driftSpeed, driftAmp }
  const blobs = [];
  let activeCount = 50; // controlled by slider
  const FULL_RISE_SPEED = 15; // SVG units/sec at full speed
  const EASE_DUR = 2.0;
  let riseSpeed = 0;

  // lavaScrollTarget: 0 = stopped, 1 = full speed
  window.lavaScrollTarget = 0;

  // --- Panel background blob (rounded rect that morphs with goo filter) ---
  const panelEl = document.createElementNS(SVG_NS, 'rect');
  container.appendChild(panelEl);
  panelEl.setAttribute('fill', 'url(#panelBg)');
  const panelHost = document.querySelector('.container');
  const lavaSvg = container.ownerSVGElement;
  const showPanelDebug = false;
  let panelDebugEl = null;
  if (showPanelDebug && lavaSvg) {
    panelDebugEl = document.createElementNS(SVG_NS, 'rect');
    panelDebugEl.setAttribute('fill', 'none');
    panelDebugEl.setAttribute('stroke', '#2f6fff');
    panelDebugEl.setAttribute('stroke-width', '2');
    panelDebugEl.setAttribute('stroke-opacity', '0.95');
    panelDebugEl.setAttribute('vector-effect', 'non-scaling-stroke');
    panelDebugEl.setAttribute('pointer-events', 'none');
    lavaSvg.appendChild(panelDebugEl);
  }
  const panelInsetPx = 6;
  const panelState = {
    x: W * 0.2,
    y: H * 0.15,
    w: W * 0.6,
    h: H * 0.7
  };
  let panelPhaseW = 0, panelPhaseH = 0, panelPhaseX = 0, panelPhaseY = 0;

  function screenToSvg(x, y) {
    if (!lavaSvg) return { x: (x / window.innerWidth) * W, y: (y / window.innerHeight) * H };
    const ctm = lavaSvg.getScreenCTM();
    if (!ctm) return { x: (x / window.innerWidth) * W, y: (y / window.innerHeight) * H };
    const pt = lavaSvg.createSVGPoint();
    pt.x = x;
    pt.y = y;
    const mapped = pt.matrixTransform(ctm.inverse());
    return { x: mapped.x, y: mapped.y };
  }

  function getPanelTargetRect() {
    if (!panelHost) {
      return { x: panelState.x, y: panelState.y, w: panelState.w, h: panelState.h, rx: 24, ry: 24 };
    }
    const rect = panelHost.getBoundingClientRect();
    const tl = screenToSvg(rect.left + panelInsetPx, rect.top + panelInsetPx);
    const br = screenToSvg(rect.right - panelInsetPx, rect.bottom - panelInsetPx);
    const w = Math.max(40, br.x - tl.x);
    const h = Math.max(40, br.y - tl.y);
    const computed = getComputedStyle(panelHost);
    const radiusPx = parseFloat(computed.borderTopLeftRadius) || 24;
    const rx = Math.max(6, (radiusPx / Math.max(1, rect.width)) * w);
    const ry = Math.max(6, (radiusPx / Math.max(1, rect.height)) * h);
    return { x: tl.x, y: tl.y, w, h, rx, ry };
  }

  function randomBlobProps(spawnAtRandom) {
    const rx = rand(14, 34);
    const ry = rand(12, 30);
    return {
      cx: rand(30, W - 30),
      cy: spawnAtRandom ? rand(0, H) : H + rand(20, 80), // spawn below viewport or randomly
      rx: rx,
      ry: ry,
      rxBase: rx,
      ryBase: ry,
      vx: rand(-2, 2),      // slow horizontal drift base
      vy: rand(8, 22),       // individual rise speed
      morphPhaseX: rand(0, Math.PI * 2),
      morphPhaseY: rand(0, Math.PI * 2),
      morphSpeedX: rand(0.15, 0.4),
      morphSpeedY: rand(0.15, 0.4),
      morphAmpX: rand(3, 7),
      morphAmpY: rand(3, 7),
      driftPhase: rand(0, Math.PI * 2),
      driftSpeed: rand(0.1, 0.3),
      driftAmp: rand(12, 28),
      fill: fills[randInt(0, 4)]
    };
  }

  function createBlobEl() {
    const el = document.createElementNS(SVG_NS, 'ellipse');
    container.appendChild(el);
    return el;
  }

  function respawnBlob(b, spawnAtRandom) {
    const props = randomBlobProps(spawnAtRandom);
    Object.assign(b, props);
    b.el.setAttribute('fill', props.fill);
  }

  // Create initial blobs distributed across viewport
  function initBlobs(count) {
    for (let i = 0; i < count; i++) {
      const el = createBlobEl();
      const props = randomBlobProps(true); // random position
      const blob = { el, ...props };
      blobs.push(blob);
      el.setAttribute('fill', props.fill);
    }
  }

  function ensureBlobCount(count) {
    // Add more blobs if needed
    while (blobs.length < count) {
      const el = createBlobEl();
      const props = randomBlobProps(true);
      const blob = { el, ...props };
      blobs.push(blob);
      el.setAttribute('fill', props.fill);
    }
    // Show/hide
    activeCount = count;
    blobs.forEach((b, i) => {
      b.el.style.display = i < count ? '' : 'none';
    });
  }

  // Animation loop
  let lastTime = null;

  function tick(now) {
    if (lastTime === null) { lastTime = now; requestAnimationFrame(tick); return; }
    const dt = (now - lastTime) / 1000;
    lastTime = now;

    // Ease rise speed toward target
    const target = window.lavaScrollTarget * FULL_RISE_SPEED;
    const ramp = FULL_RISE_SPEED / EASE_DUR * dt;
    if (riseSpeed < target) riseSpeed = Math.min(riseSpeed + ramp, target);
    else if (riseSpeed > target) riseSpeed = Math.max(riseSpeed - ramp, target);

    const speedMul = riseSpeed / FULL_RISE_SPEED; // 0..1

    // Track panel geometry and morph rounded rect around it
    const targetPanel = getPanelTargetRect();
    if (panelDebugEl) {
      panelDebugEl.setAttribute('x', targetPanel.x);
      panelDebugEl.setAttribute('y', targetPanel.y);
      panelDebugEl.setAttribute('width', targetPanel.w);
      panelDebugEl.setAttribute('height', targetPanel.h);
      panelDebugEl.setAttribute('rx', targetPanel.rx);
      panelDebugEl.setAttribute('ry', targetPanel.ry);
    }
    const lerp = Math.min(1, dt * 10);
    panelState.x += (targetPanel.x - panelState.x) * lerp;
    panelState.y += (targetPanel.y - panelState.y) * lerp;
    panelState.w += (targetPanel.w - panelState.w) * lerp;
    panelState.h += (targetPanel.h - panelState.h) * lerp;

    panelPhaseW += 0.13 * dt;
    panelPhaseH += 0.09 * dt;
    panelPhaseX += 0.07 * dt;
    panelPhaseY += 0.05 * dt;
    const pw = panelState.w + Math.sin(panelPhaseW) * Math.min(12, panelState.w * 0.03);
    const ph = panelState.h + Math.sin(panelPhaseH) * Math.min(10, panelState.h * 0.03);
    const px = panelState.x - (pw - panelState.w) / 2 + Math.sin(panelPhaseX) * 4;
    const py = panelState.y - (ph - panelState.h) / 2 + Math.sin(panelPhaseY) * 3;
    panelEl.setAttribute('x', px);
    panelEl.setAttribute('y', py);
    panelEl.setAttribute('width', pw);
    panelEl.setAttribute('height', ph);
    panelEl.setAttribute('rx', targetPanel.rx);
    panelEl.setAttribute('ry', targetPanel.ry);

    for (let i = 0; i < activeCount && i < blobs.length; i++) {
      const b = blobs[i];

      // Rise upward (individual speed scaled by global speed multiplier)
      b.cy -= b.vy * speedMul * dt;

      // Horizontal sine drift
      b.driftPhase += b.driftSpeed * dt;
      const driftX = Math.sin(b.driftPhase) * b.driftAmp;

      // Morph rx/ry
      b.morphPhaseX += b.morphSpeedX * dt;
      b.morphPhaseY += b.morphSpeedY * dt;
      const curRx = b.rxBase + Math.sin(b.morphPhaseX) * b.morphAmpX;
      const curRy = b.ryBase + Math.sin(b.morphPhaseY) * b.morphAmpY;

      // Respawn if off top (with margin for blur)
      if (b.cy < -curRy - 30) {
        respawnBlob(b, false); // respawn at bottom
      }

      // Respawn if off bottom (after session stops and speed is 0, blob drifted off)
      if (b.cy > H + curRy + 80) {
        b.cy = H + rand(20, 60); // keep near bottom, ready for next start
      }

      // Update SVG element
      const displayCx = b.cx + driftX;
      b.el.setAttribute('cx', displayCx);
      b.el.setAttribute('cy', b.cy);
      b.el.setAttribute('rx', Math.max(5, curRx));
      b.el.setAttribute('ry', Math.max(5, curRy));
    }

    requestAnimationFrame(tick);
  }

  initBlobs(50);
  requestAnimationFrame(tick);

  // --- Blob count slider ---
  const slider = document.getElementById('blobCountSlider');
  const input = document.getElementById('blobCountInput');
  if (slider && input) {
    slider.addEventListener('input', () => {
      input.value = slider.value;
      ensureBlobCount(Number(slider.value));
    });
    input.addEventListener('input', () => {
      let val = Math.max(0, Math.min(200, Number(input.value)));
      input.value = val;
      slider.value = val;
      ensureBlobCount(val);
    });
  }
})();
