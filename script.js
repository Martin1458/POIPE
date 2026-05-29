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

// === Tilted line background ===
(function initLines() {
  const canvas = document.getElementById('lava-bg');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  const ANGLE = 20 * Math.PI / 180;
  const SPACING = 52;
  const SCROLL_SPEED_IDLE = 6;
  const SCROLL_SPEED_ACTIVE = 60;
  const EASE_DUR = 2.0;

  const lineStyles = [
    { color: 'rgba(255, 100, 20, 0.5)',  width: 6  },
    { color: 'rgba(255, 200, 0, 0.35)',  width: 4  },
    { color: 'rgba(220, 40, 10, 0.45)',  width: 8  },
    { color: 'rgba(255, 70, 130, 0.35)', width: 4  },
    { color: 'rgba(255, 150, 0, 0.5)',   width: 6  },
  ];

  const lineDir = [Math.cos(ANGLE), Math.sin(ANGLE)];
  const normal  = [-Math.sin(ANGLE), Math.cos(ANGLE)];

  let totalOffset = 0;
  let scrollSpeed = SCROLL_SPEED_IDLE;
  window.lavaScrollTarget = 0;

  let lastTime = null;

  function tick(now) {
    if (lastTime === null) { lastTime = now; requestAnimationFrame(tick); return; }
    const dt = (now - lastTime) / 1000;
    lastTime = now;

    const target = window.lavaScrollTarget ? SCROLL_SPEED_ACTIVE : SCROLL_SPEED_IDLE;
    const ramp = (SCROLL_SPEED_ACTIVE - SCROLL_SPEED_IDLE) / EASE_DUR * dt;
    if (scrollSpeed < target) scrollSpeed = Math.min(scrollSpeed + ramp, target);
    else if (scrollSpeed > target) scrollSpeed = Math.max(scrollSpeed - ramp, target);
    totalOffset += scrollSpeed * dt;
    const scrollOffset = totalOffset % SPACING;
    const scrollSteps = Math.floor(totalOffset / SPACING);

    const w = canvas.width;
    const h = canvas.height;
    const diag = Math.sqrt(w * w + h * h);
    const cx = w / 2, cy = h / 2;
    const halfCount = Math.ceil(diag / SPACING) + 2;

    const bgGrad = ctx.createLinearGradient(0, 0, 0, h);
    bgGrad.addColorStop(0, '#0a0010');
    bgGrad.addColorStop(1, '#1a0030');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);

    for (let i = -halfCount; i <= halfCount; i++) {
      const d = i * SPACING + scrollOffset;
      const px = cx + d * normal[0];
      const py = cy + d * normal[1];
      const ci = i - scrollSteps;
      const style = lineStyles[((ci % lineStyles.length) + lineStyles.length) % lineStyles.length];

      ctx.strokeStyle = style.color;
      ctx.lineWidth = style.width;
      ctx.beginPath();
      ctx.moveTo(px - diag * lineDir[0], py - diag * lineDir[1]);
      ctx.lineTo(px + diag * lineDir[0], py + diag * lineDir[1]);
      ctx.stroke();
    }

    requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);
})();
