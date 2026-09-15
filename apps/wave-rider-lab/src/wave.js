const TWO_PI = Math.PI * 2;
export const MAX_LAYERS = 6;
const FAVORITES_KEY = "wave-rider-favorites";

const CHOP_TRAINS = [
  { ratio: 0.11, amp: 0.22, phase: 0.4, dir: 1 },
  { ratio: 0.16, amp: 0.16, phase: 1.7, dir: 1 },
  { ratio: 0.07, amp: 0.1, phase: 2.9, dir: -1 },
  { ratio: 0.22, amp: 0.18, phase: 0.9, dir: 1 },
  { ratio: 0.09, amp: 0.08, phase: 4.1, dir: 1 },
];

export const PRESETS = {
  glass: { amplitude: 0.05, wavelength: 22, period: 7, steepness: 0.06, breaker: 0 },
  ripples: { amplitude: 0.14, wavelength: 4.2, period: 1.5, steepness: 0.16, breaker: 0 },
  chop: { amplitude: 0.55, wavelength: 8.5, period: 3.1, steepness: 0.34, breaker: 0.04 },
  swell: { amplitude: 1.6, wavelength: 32, period: 9, steepness: 0.28, breaker: 0 },
  storm: { amplitude: 3.4, wavelength: 26, period: 8, steepness: 0.5, breaker: 0.28 },
  breaker: { amplitude: 2.8, wavelength: 20, period: 7.2, steepness: 0.64, breaker: 0.84 },
  monster: { amplitude: 6.4, wavelength: 42, period: 12, steepness: 0.74, breaker: 0.96 },
};

export const PRESET_LABELS = {
  glass: "Glass",
  ripples: "Ripples",
  chop: "Chop",
  swell: "Swell",
  storm: "Storm",
  breaker: "Breaker",
  monster: "Monster",
};

let layerSeq = 1;

export const EMPTY_WAVE = {
  amplitude: 0,
  wavelength: 32,
  period: 9,
  steepness: 0.28,
  breaker: 0,
};

export function normalizeParams(params = {}) {
  const amplitude = Number(params.amplitude);
  const wavelength = Number(params.wavelength);
  const period = Number(params.period);
  const steepness = Number(params.steepness);
  const breaker = Number(params.breaker);
  return {
    amplitude: Number.isFinite(amplitude) ? amplitude : 0,
    wavelength: Number.isFinite(wavelength) && wavelength > 0 ? wavelength : 32,
    period: Number.isFinite(period) && period > 0 ? period : 9,
    steepness: Number.isFinite(steepness) ? steepness : 0,
    breaker: Number.isFinite(breaker) ? breaker : 0,
  };
}

export function makeLayer(name, params, gain = 1) {
  return {
    id: `layer-${layerSeq++}`,
    name,
    params: normalizeParams(params),
    gain,
    enabled: true,
  };
}

export function selectedLayer(field) {
  return field.layers.find((layer) => layer.id === field.selectedId) || null;
}

export function selectedParams(field) {
  return selectedLayer(field)?.params ?? null;
}

export function peakAmplitude(field) {
  let max = 0;
  for (const layer of field.layers) {
    if (!layer.enabled) continue;
    max = Math.max(max, layer.params.amplitude * layer.gain);
  }
  if (!selectedLayer(field) && field.preview) {
    max = Math.max(max, field.preview.params.amplitude);
  }
  return max;
}

export function scrollDisplayX(x, viewWidth, scroll) {
  return ((x - scroll) % viewWidth + viewWidth) % viewWidth;
}

export function createField() {
  return {
    time: 0,
    paused: false,
    viewWidth: 68,
    viewSpan: 8,
    scrollX: 0,
    layers: [],
    selectedId: null,
    preview: { name: "Wave", params: normalizeParams(EMPTY_WAVE) },
    weather: { strength: 0, from: "back" },
    impulses: [],
    spray: [],
    spawnCarry: 0,
    _peakAmp: 0,
  };
}

export function applyPreset(field, name) {
  if (!PRESETS[name]) return;
  const layer = selectedLayer(field);
  if (!layer) return;
  Object.assign(layer.params, normalizeParams(PRESETS[name]));
  layer.name = PRESET_LABELS[name];
}

export function addLayer(field, name, params, gain = 1) {
  if (field.layers.length >= MAX_LAYERS) return null;
  const layer = makeLayer(name, params, gain);
  field.layers.push(layer);
  return layer;
}

export function removeLayer(field, id) {
  field.layers = field.layers.filter((layer) => layer.id !== id);
  if (!field.layers.some((layer) => layer.id === field.selectedId)) {
    field.selectedId = field.layers[0]?.id ?? null;
  }
}

export function snapshotLayers(field) {
  return field.layers.map((layer) => ({
    name: layer.name,
    gain: layer.gain,
    enabled: layer.enabled,
    params: { ...layer.params },
  }));
}

export function addLayersFromSnapshot(field, layers) {
  for (const snap of layers) {
    if (field.layers.length >= MAX_LAYERS) break;
    const layer = makeLayer(snap.name, snap.params, snap.gain ?? 1);
    layer.enabled = snap.enabled !== false;
    field.layers.push(layer);
    field.selectedId = layer.id;
  }
}

export function replaceLayersFromSnapshot(field, layers) {
  field.layers = [];
  addLayersFromSnapshot(field, layers);
  if (!field.layers.length) field.selectedId = null;
}

export function loadFavorites() {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveFavorite(field, name) {
  const list = loadFavorites();
  const item = {
    id: `fav-${Date.now()}`,
    name: name.trim() || `Favourite ${list.length + 1}`,
    layers: snapshotLayers(field),
  };
  list.unshift(item);
  localStorage.setItem(FAVORITES_KEY, JSON.stringify(list));
  return list;
}

export function deleteFavorite(id) {
  const list = loadFavorites().filter((item) => item.id !== id);
  localStorage.setItem(FAVORITES_KEY, JSON.stringify(list));
  return list;
}

export function addImpulse(field, x, amp = 4.8) {
  const seaX = x + (field.scrollX ?? 0);
  field.impulses.push({ x: seaX, t0: field.time, amp });
  if (field.impulses.length > 8) field.impulses.shift();

  const dir = windDir(field);
  const wind = field.weather?.strength ?? 0;
  const n = 36;
  for (let i = 0; i < n && field.spray.length < 560; i += 1) {
    const scatter = (hash(seaX * 3.1 + i * 1.7 + field.time) - 0.5) * 2;
    field.spray.push({
      x: seaX + scatter * 1.8,
      y: amp * (0.55 + hash(i * 4.4 + seaX) * 0.5),
      vx: dir * (4 + wind * 14 + hash(i * 2.2) * 8) + scatter * 3.5,
      vy: 3.2 + hash(i * 5.1 + field.time) * 7.5 + amp * 0.22,
      life: 0.55 + hash(i + seaX) * 0.7,
      age: 0,
    });
  }
}

export function windDir(field) {
  return field.weather?.from === "front" ? -1 : 1;
}

export function stepField(field, dt) {
  field._peakAmp = peakAmplitude(field);
  if (field.paused) return;
  field.time += dt;
  field.impulses = field.impulses.filter((imp) => field.time - imp.t0 < 12);
  stepSpray(field, dt);
}

function hash(n) {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}

function gerstner(x0, t, wavelength, period, amplitude, steepness, stokes, dir = 1) {
  if (amplitude <= 0 || wavelength <= 0 || period <= 0) {
    return { x: x0, y: 0, theta: 0, dx0: 1, dy0: 0 };
  }

  const k = TWO_PI / wavelength;
  const omega = TWO_PI / period;
  const theta = dir * k * x0 - omega * t;
  const Q = Math.min(steepness, 0.78);
  const s = Math.sin(theta);
  const c = Math.cos(theta);
  const dth = dir * k;

  return {
    x: x0 - dir * Q * amplitude * s,
    y: amplitude * c + stokes * amplitude * 0.2 * Math.cos(2 * theta),
    theta,
    dx0: 1 - Q * amplitude * k * c,
    dy0: -amplitude * s * dth - stokes * amplitude * 0.4 * Math.sin(2 * theta) * dth,
  };
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function windExposure(slope, y, peakAmp, dir) {
  const A = Math.max(0.12, peakAmp);
  const slopeN = slope / Math.max(0.18, A * 0.55);
  const windward = clamp01(0.5 + 0.62 * dir * slopeN);
  const crest = clamp01((y / A - 0.12) / 0.72);
  const lee = 1 - windward;
  return clamp01(0.16 + 0.58 * windward + 0.48 * crest - 0.5 * lee * (1 - crest)) * (1.05 + 0.2 * crest);
}

function wrapAngle(theta) {
  return Math.atan2(Math.sin(theta), Math.cos(theta));
}

function breakPower(params) {
  return params.breaker * Math.min(1, params.steepness / 0.38);
}

function spillingTip(x0, t, wavelength, period, amplitude, params) {
  const power = breakPower(params);
  if (power < 0.03 || amplitude < 0.04) return { x: 0, y: 0, amount: 0 };

  const k = TWO_PI / wavelength;
  const omega = TWO_PI / period;
  const phase = wrapAngle(k * x0 - omega * t);
  const d = phase - 0.2;
  const window = Math.exp(-(d * d) / (2 * 0.26 * 0.26));
  const amount = power * window;
  if (amount < 0.01) return { x: 0, y: 0, amount: 0 };

  const shear = amount * amplitude;
  const grit = (hash(x0 * 14.2 + t * 21.5) - 0.5) * 2;
  const collapse = 0.28 + 0.9 * power;

  return {
    x: shear * (0.62 + 0.22 * params.breaker),
    y: -shear * collapse + grit * shear * 0.28,
    amount,
  };
}

function impulseLift(imp, x0, t) {
  const age = t - imp.t0;
  if (age < 0) return 0;
  const c = 7.2;
  const w = 3.2 + age * 1.55;
  const decay = Math.exp(-0.14 * age);
  const r = x0 - imp.x;
  const left = Math.exp(-((r + c * age) ** 2) / (2 * w * w));
  const right = Math.exp(-((r - c * age) ** 2) / (2 * w * w));
  const shape = 0.82 + 0.18 * Math.cos(0.38 * r);
  return imp.amp * decay * (left + right) * 0.58 * shape;
}

export function layerCelerity(params) {
  if (!params?.wavelength || !params?.period) return 0;
  return params.wavelength / params.period;
}

function layerVerticalVelocity(params, x0, t, gain = 1) {
  const A = params.amplitude * gain;
  if (A <= 0 || params.wavelength <= 0 || params.period <= 0) return 0;
  const k = TWO_PI / params.wavelength;
  const omega = TWO_PI / params.period;
  const theta = k * x0 - omega * t;
  const stokes = Math.min(0.8, params.steepness * 0.55);
  let vy = A * omega * Math.sin(theta);
  vy += stokes * A * 0.2 * omega * 2 * Math.sin(2 * theta);
  return vy;
}

function sampleLayer(params, x0, t) {
  const A = params.amplitude;
  const stokes = Math.min(0.8, params.steepness * 0.55);
  const primary = gerstner(x0, t, params.wavelength, params.period, A, params.steepness, stokes, 1);
  const spill = spillingTip(x0, t, params.wavelength, params.period, A, params);
  return {
    x: primary.x + spill.x,
    y: primary.y + spill.y,
    vy: layerVerticalVelocity(params, x0, t, 1),
    break: spill.amount,
    dx0: primary.dx0,
    dy0: primary.dy0,
  };
}

export function dominantWave(field) {
  let best = { c: 0, period: 0, wavelength: 0, amplitude: 0, weight: 0 };
  const sources = field.layers.filter((layer) => layer.enabled && layer.gain > 0);
  if (!selectedLayer(field) && field.preview?.params?.amplitude > 0) {
    sources.push({ params: field.preview.params, gain: 1 });
  }
  for (const source of sources) {
    const weight = source.params.amplitude * source.gain;
    if (weight <= best.weight) continue;
    best = {
      c: layerCelerity(source.params),
      period: source.params.period,
      wavelength: source.params.wavelength,
      amplitude: source.params.amplitude * source.gain,
      weight,
    };
  }
  return best;
}

export function sampleSurfaceVelocity(field, x0) {
  let vy = 0;
  for (const layer of field.layers) {
    if (!layer.enabled || layer.gain <= 0) continue;
    vy += layerVerticalVelocity(layer.params, x0, field.time, layer.gain);
  }
  if (!selectedLayer(field) && field.preview) {
    vy += layerVerticalVelocity(field.preview.params, x0, field.time, 1);
  }
  return vy;
}

function sampleWeather(field, x0, swellSlope, swellY, peakAmp) {
  const strength = field.weather?.strength ?? 0;
  if (strength < 0.02) return { x: 0, y: 0, dy0: 0, dx0: 0, expose: 0 };
  const dir = windDir(field);
  const expose = windExposure(swellSlope, swellY, peakAmp, dir);
  const A = (0.03 + strength * 0.28) * (0.22 + 0.78 * expose);
  let x = 0;
  let y = 0;
  let dy0 = 0;
  let dx0 = 0;
  for (const train of CHOP_TRAINS) {
    const chop = gerstner(
      x0,
      field.time,
      Math.max(1.4, 18 * train.ratio),
      Math.max(0.45, 4.2 * train.ratio),
      A * train.amp,
      0.18 + strength * 0.22 * expose,
      0.06,
      dir * train.dir
    );
    x += chop.x - x0;
    y += chop.y;
    dy0 += chop.dy0;
    dx0 += chop.dx0 - 1;
  }
  return { x, y, dy0, dx0, expose };
}

function ripCrest(field, x0, y, slope, peakAmp, foam0, expose) {
  const wind = field.weather?.strength ?? 0;
  const A = Math.max(0.25, peakAmp);
  if (wind < 0.03 && foam0 < 0.04) return { dx: 0, dy: 0, foam: 0 };

  const dir = windDir(field);
  const upper = clamp01((y - A * 0.06) / Math.max(0.18, A * 0.72));
  if (upper < 0.02) return { dx: 0, dy: 0, foam: 0 };

  const slopeN = slope / Math.max(0.16, A * 0.48);
  const windward = clamp01(0.28 + 0.85 * dir * slopeN);
  const crest = Math.exp(-slopeN * slopeN * 0.55);
  const drive = Math.min(1.45, wind * 1.4 + foam0 * 0.55);
  const hold = Math.max(0.16, 0.92 - wind * 0.62 - foam0 * 0.18);
  const excess = Math.max(0, y - A * hold);
  const tear = drive * upper * (0.4 + 0.6 * Math.max(crest, windward));
  const rip = Math.min(A * 0.88, excess * (0.9 + wind * 1.05) + tear * A * 0.62);
  if (rip < 0.012) return { dx: 0, dy: 0, foam: tear * 0.4 };

  return {
    dy: -rip,
    dx: dir * rip * (0.7 + 0.9 * Math.max(expose, windward)),
    foam: Math.min(1, 0.18 + rip / (A * 0.1) + wind * upper),
  };
}

export function sampleSurface(field, x0) {
  let x = x0;
  let y = 0;
  let brk = 0;
  let dy0 = 0;
  let dx0 = 1;

  for (const layer of field.layers) {
    if (!layer.enabled || layer.gain <= 0) continue;
    const sample = sampleLayer(layer.params, x0, field.time);
    x += (sample.x - x0) * layer.gain;
    y += sample.y * layer.gain;
    brk = Math.max(brk, sample.break * layer.gain);
    dy0 += sample.dy0 * layer.gain;
    dx0 += (sample.dx0 - 1) * layer.gain;
  }

  if (!selectedLayer(field) && field.preview) {
    const sample = sampleLayer(field.preview.params, x0, field.time);
    x += sample.x - x0;
    y += sample.y;
    brk = Math.max(brk, sample.break);
    dy0 += sample.dy0;
    dx0 += sample.dx0 - 1;
  }

  const peakAmp = field._peakAmp ?? peakAmplitude(field);
  const swellSlope = dy0 / Math.max(0.25, dx0);
  const weather = sampleWeather(field, x0, swellSlope, y, peakAmp);
  x += weather.x;
  y += weather.y;
  dy0 += weather.dy0;
  dx0 += weather.dx0;

  let impY = 0;
  for (const imp of field.impulses) {
    impY += impulseLift(imp, x0, field.time);
  }
  y += impY;
  if (impY > 0.25) brk = Math.max(brk, clamp01(impY / 2.4));

  const slope = dy0 / Math.max(0.25, dx0);
  const rip = ripCrest(field, x0, y, slope, peakAmp, brk, weather.expose);
  x += rip.dx;
  y += rip.dy;
  brk = Math.max(brk, rip.foam);

  return { x, y, break: brk, slope, expose: weather.expose || 0 };
}

export function sampleSurfaceXZ(field, x0, z0) {
  const base = sampleSurface(field, x0);
  const wind = field.weather?.strength ?? 0;
  const t = field.time;
  const spread =
    Math.sin(0.22 * z0 + 0.05 * x0 + t * 0.7) * (0.055 + wind * 0.2) +
    Math.sin(0.58 * z0 - 0.11 * x0 + t * 1.55) * (0.028 + wind * 0.14) +
    Math.sin(1.12 * z0 + t * 2.35) * (0.014 + wind * 0.08);
  const crest = Math.cos(z0 * 0.09);
  return {
    x: base.x,
    y: base.y * (0.9 + 0.1 * crest) + spread,
    break: base.break * (0.65 + 0.35 * Math.max(0, crest)),
  };
}

export function sampleLine(field, count) {
  field._peakAmp = peakAmplitude(field);
  const points = new Array(count);
  const ys = new Float64Array(count);
  const vys = new Float64Array(count);
  const dominant = dominantWave(field);
  const scroll = field.scrollX ?? 0;
  const viewWidth = field.viewWidth;
  let minY = Infinity;
  let maxY = -Infinity;
  let maxSlope = 0;
  let prevX = null;
  let prevY = null;

  for (let i = 0; i < count; i += 1) {
    const x0 = (i / (count - 1)) * viewWidth;
    const xSea = x0 + scroll;
    const sample = sampleSurface(field, xSea);
    points[i] = { x: x0, y: sample.y, break: sample.break, slope: sample.slope, expose: sample.expose };
    ys[i] = sample.y;
    vys[i] = sampleSurfaceVelocity(field, xSea);
    if (sample.y < minY) minY = sample.y;
    if (sample.y > maxY) maxY = sample.y;
    if (prevX !== null) {
      const dx = x0 - prevX;
      const dy = sample.y - prevY;
      if (Math.abs(dx) > 1e-5) {
        maxSlope = Math.max(maxSlope, Math.abs(dy / dx));
      }
    }
    prevX = x0;
    prevY = sample.y;
  }

  return {
    points,
    ys,
    vys,
    count,
    viewWidth: field.viewWidth,
    minY,
    maxY,
    maxSlope,
    waveC: dominant.c,
    wavePeriod: dominant.period,
    waveLength: dominant.wavelength,
  };
}

function collectTips(field) {
  const tips = [];
  const scroll = field.scrollX ?? 0;
  const viewWidth = field.viewWidth;
  const sources = field.layers
    .filter((layer) => layer.enabled)
    .map((layer) => ({ params: layer.params, gain: layer.gain }));
  if (!selectedLayer(field) && field.preview) {
    sources.push({ params: field.preview.params, gain: 1 });
  }

  for (const source of sources) {
    const p = source.params;
    const power = breakPower(p) * source.gain;
    if (power < 0.08) continue;
    const t = field.time;
    const k = TWO_PI / p.wavelength;
    const omega = TWO_PI / p.period;
    const start = Math.floor((scroll - p.wavelength * k - omega * t) / TWO_PI) - 1;
    const end = Math.ceil(((scroll + viewWidth + p.wavelength) * k - omega * t) / TWO_PI) + 1;

    for (let n = start; n <= end; n += 1) {
      const tipSea = (omega * t + TWO_PI * n) / k + p.wavelength * 0.035;
      if (tipSea < scroll - 2 || tipSea > scroll + viewWidth + 2) continue;
      const point = sampleSurface(field, tipSea);
      tips.push({ x: tipSea, y: point.y, intensity: power, slope: point.slope || 0 });
    }
  }

  const wind = field.weather?.strength ?? 0;
  if (wind > 0.02) {
    const n = 72;
    const dir = windDir(field);
    const peak = Math.max(0.2, field._peakAmp || 0.2);
    for (let i = 0; i < n; i += 1) {
      const xSea = scroll + (i / (n - 1)) * viewWidth;
      const point = sampleSurface(field, xSea);
      const climb = dir * (point.slope || 0);
      const torn = point.break > 0.06 || (point.y > 0.1 * peak && climb > -0.15);
      if (!torn) continue;
      const intensity = Math.max(point.break, wind * (0.45 + 0.7 * (point.expose || 0)));
      if (intensity < 0.05) continue;
      tips.push({ x: xSea, y: point.y, intensity, slope: point.slope || 0 });
    }
  }

  return tips;
}

function stepSpray(field, dt) {
  const tips = collectTips(field);
  const A = Math.max(0.2, field._peakAmp || peakAmplitude(field));
  const wind = field.weather?.strength ?? 0;
  const dir = windDir(field);
  const windU = dir * (3.5 + wind * 28);
  field.spawnCarry += dt * (tips.reduce((sum, tip) => sum + 28 + tip.intensity * 90, 0) + wind * 70);

  while (field.spawnCarry >= 1 && field.spray.length < 560) {
    field.spawnCarry -= 1;
    const tip = tips[Math.floor(hash(field.time * 80 + field.spawnCarry * 9) * tips.length)] || tips[0];
    if (!tip) break;
    const slope = tip.slope || 0;
    const mag = Math.sqrt(1 + slope * slope);
    const along = (4.5 + wind * 16) * Math.max(0.35, tip.intensity);
    const tx = (dir / mag) * along;
    const ty = ((dir * slope) / mag) * along;
    const loft = (0.4 + hash(tip.y * 5.7 + field.time * 2.2) * 2.4) * (2.2 + wind * 4.2) * Math.max(0.35, tip.intensity);
    field.spray.push({
      x: tip.x + (hash(field.time + tip.x) - 0.35) * A * 0.16,
      y: tip.y + (hash(field.time * 1.7 + tip.y) - 0.2) * A * 0.08,
      vx: tx + (hash(tip.x * 3.1 + field.time) - 0.2) * 4.5,
      vy: ty + loft * Math.sqrt(A),
      life: 0.45 + hash(tip.x + field.time) * 0.85 + wind * 0.4,
      age: 0,
    });
  }

  const next = [];
  for (const drop of field.spray) {
    drop.age += dt;
    if (drop.age >= drop.life) continue;
    drop.vx += (windU - drop.vx) * Math.min(1, 1.6 * dt);
    drop.vy -= 11 * dt;
    drop.x += drop.vx * dt;
    drop.y += drop.vy * dt;
    next.push(drop);
  }
  field.spray = next;
}

export function classifySea(field, stats) {
  const hs = Math.max(0, stats.maxY - stats.minY);
  const active = field.layers.filter((layer) => layer.enabled);
  const live = selectedLayer(field) ? null : field.preview?.params;
  const forms = live ? [...active.map((layer) => layer.params), live] : active.map((layer) => layer.params);
  const ak = forms.reduce((max, params) => Math.max(max, params.steepness), 0);
  const breaking = forms.some((params) => params.breaker > 0.2 && params.steepness > 0.28);
  const period = live?.period ?? selectedParams(field)?.period ?? 0;
  const wind = field.weather?.strength ?? 0;

  if (breaking || (ak > 0.95 && hs > 1.2) || (wind > 0.42 && hs > 0.85 && ak > 0.3)) {
    return { name: "Breaking", hs, ak, period };
  }
  if (hs < 0.08) return { name: "Still", hs, ak, period };
  if (wind > 0.72) return { name: "Gale", hs, ak, period };
  if (hs < 0.35 && (live?.wavelength ?? selectedParams(field)?.wavelength ?? 32) < 8) {
    return { name: "Ripples", hs, ak, period };
  }
  if (wind > 0.45) return { name: "Chop", hs, ak, period };
  if (hs > 5.5) return { name: "Huge", hs, ak, period };
  if (hs > 3.2) return { name: "Storm", hs, ak, period };
  if (active.length + (live && live.amplitude > 0 ? 1 : 0) > 1) return { name: "Mixed", hs, ak, period };
  return { name: "Swell", hs, ak, period };
}
