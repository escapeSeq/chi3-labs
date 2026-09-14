const G = 9.81;
const RHO = 1025;
const BLOCK = 0.42;
const STATIONS = 25;

export const SHIP_PRESETS = {
  skiff: {
    length: 7.5,
    mass: 1800,
    speed: 7.2,
    draft: 0.55,
    beam: 2.2,
    bowLift: 0.7,
    midLift: 0.45,
    sternLift: 0.55,
    damping: 0.42,
    inertiaScale: 0.85,
  },
  yacht: {
    length: 14,
    mass: 12000,
    speed: 5.5,
    draft: 1.35,
    beam: 3.4,
    bowLift: 0.32,
    midLift: 0.55,
    sternLift: 0.38,
    damping: 0.58,
    inertiaScale: 1,
  },
  trawler: {
    length: 18,
    mass: 42000,
    speed: 3.4,
    draft: 2.2,
    beam: 5.2,
    bowLift: 0.18,
    midLift: 0.72,
    sternLift: 0.28,
    damping: 0.78,
    inertiaScale: 1.25,
  },
  racer: {
    length: 11,
    mass: 4200,
    speed: 11.5,
    draft: 0.7,
    beam: 2.6,
    bowLift: 0.85,
    midLift: 0.4,
    sternLift: 0.75,
    damping: 0.32,
    inertiaScale: 0.7,
  },
};

export const SHIP_LABELS = {
  skiff: "Skiff",
  yacht: "Yacht",
  trawler: "Trawler",
  racer: "Racer",
};

const LIFT_ZONES = [
  { station: 0.12, key: "sternLift", center: 0.14, width: 0.22 },
  { station: 0.5, key: "midLift", center: 0.5, width: 0.28 },
  { station: 0.88, key: "bowLift", center: 0.86, width: 0.22 },
];

export function createShip(preset = "yacht") {
  return {
    visible: true,
    heading: -1,
    ...SHIP_PRESETS[preset],
    speed: 0,
    x: 34,
    y: 0,
    pitch: 0,
    vy: 0,
    vp: 0,
    heave: 0,
    wet: 0,
    sit: 0,
    trim: 0,
    liftSum: 0,
  };
}

export function applyShipPreset(ship, name, viewWidth = 68, points = null) {
  if (!SHIP_PRESETS[name]) return;
  const heading = ship.heading;
  Object.assign(ship, SHIP_PRESETS[name]);
  ship.heading = heading;
  resetShipMotion(ship, viewWidth, points);
}

export function setHeading(ship, heading, viewWidth = 68, points = null) {
  ship.heading = heading >= 0 ? 1 : -1;
  resetShipMotion(ship, viewWidth, points);
}

export function resetShipMotion(ship, viewWidth = 68, points = null) {
  ship.x = viewWidth * 0.5;
  ship.vy = 0;
  ship.vp = 0;
  ship.y = 0;
  ship.pitch = 0;
  ship.heave = 0;
  ship.wet = 0;
  ship.sit = sitDepth(ship);
  ship.trim = 0;
  ship.liftSum = 0;
  if (points?.ys || points?.length) {
    const { waveY } = sampleHullSea(ship, points);
    const hull = ensureHullCache(ship);
    ship._buoyKey = null;
    buoyancyScale(ship, hull, waveY);
    const eq = solveEquilibrium(ship, points, Math.abs(ship.speed), 0);
    ship.y = eq.y;
    ship.pitch = eq.pitch;
    ship.heave = eq.y;
    ship.wet = eq.wet;
    ship.sit = eq.sit;
    ship.trim = eq.trim;
    ship.liftSum = eq.liftSum;
    ship._liftForces = eq.liftForces;
  }
}

export function sitDepth(ship) {
  const length = Math.max(1, ship.length);
  const beam = Math.max(0.6, ship.beam);
  const draft = Math.max(0.2, ship.draft);
  const immersed = ship.mass / (RHO * BLOCK * length * beam);
  return Math.max(draft * 0.12, Math.min(draft * 1.65, immersed));
}

export function heightAt(sea, x, viewWidth = sea?.viewWidth) {
  if (sea?.ys) return seaHeight(sea, x);
  if (!sea?.length) return 0;
  return heightAtLegacy(sea, x, viewWidth);
}

function seaHeight(sea, x) {
  const { ys, count, viewWidth } = sea;
  if (!count) return 0;
  const wx = ((x % viewWidth) + viewWidth) % viewWidth;
  const f = (wx / viewWidth) * (count - 1);
  const i = f | 0;
  const j = i < count - 1 ? i + 1 : i;
  return ys[i] + (ys[j] - ys[i]) * (f - i);
}

function heightAtLegacy(points, x, viewWidth) {
  const wx = ((x % viewWidth) + viewWidth) % viewWidth;
  const n = points.length;
  const f = (wx / viewWidth) * (n - 1);
  const i = f | 0;
  const j = i < n - 1 ? i + 1 : i;
  return points[i].y + (points[j].y - points[i].y) * (f - i);
}

function sampleHullSea(ship, sea) {
  const heading = ship.heading >= 0 ? 1 : -1;
  const { ys, vys, count, viewWidth } = sea;
  const scale = (count - 1) / viewWidth;
  const waveY = new Float64Array(STATIONS);
  const waveVy = new Float64Array(STATIONS);
  const L = ship.length;
  for (let i = 0; i < STATIONS; i += 1) {
    const wx = ship.x + (i / (STATIONS - 1) - 0.5) * L * heading;
    const w = ((wx % viewWidth) + viewWidth) % viewWidth;
    const f = w * scale;
    const idx = f | 0;
    const j = idx < count - 1 ? idx + 1 : idx;
    const t = f - idx;
    waveY[i] = ys[idx] + (ys[j] - ys[idx]) * t;
    if (vys) waveVy[i] = vys[idx] + (vys[j] - vys[idx]) * t;
  }
  return { waveY, waveVy };
}

function sampleHullWaves(ship, sea) {
  return sampleHullSea(ship, sea).waveY;
}

function ensureHullCache(ship) {
  const key = `${ship.length}|${ship.draft}`;
  if (ship._hullCacheKey === key && ship._hullCache) return ship._hullCache;
  const lx = new Float64Array(STATIONS);
  const keel = new Float64Array(STATIONS);
  const deck = new Float64Array(STATIONS);
  for (let i = 0; i < STATIONS; i += 1) {
    const station = i / (STATIONS - 1);
    lx[i] = stationLx(station, ship.length);
    keel[i] = -keelDepth(station, ship.draft);
    deck[i] = deckHeight(station, ship.draft);
  }
  ship._hullCacheKey = key;
  ship._hullCache = { lx, keel, deck };
  return ship._hullCache;
}

function ensureSectionGains(ship, speed) {
  const key = `${speed.toFixed(2)}|${ship.bowLift}|${ship.midLift}|${ship.sternLift}`;
  if (ship._gainKey === key && ship._sectionGains) return ship._sectionGains;
  const gains = new Float64Array(STATIONS);
  const fn = froudeGain(speed, ship.length);
  const ref = ship.midLift;
  const strength = 1.35 + (speed > 0.08 ? 0.75 * (0.15 + 0.85 * fn) : 0);
  for (let i = 0; i < STATIONS; i += 1) {
    const coeff = sectionLiftCoeff(ship, i / (STATIONS - 1));
    gains[i] = Math.max(0.45, Math.min(2.2, 1 + (coeff - ref) * strength));
  }
  ship._gainKey = key;
  ship._sectionGains = gains;
  return gains;
}

function midshipFullness(station) {
  const t = 1 - Math.abs(station - 0.5) * 1.65;
  return Math.max(0, t) ** 0.85;
}

function keelDepth(station, draft) {
  return draft * (0.5 + 0.52 * midshipFullness(station));
}

function deckHeight(station, draft) {
  const t = 1 - Math.abs(station - 0.5) * 1.65;
  const flat = Math.max(0, Math.min(1, t / 0.38));
  return draft * (0.48 + 0.2 * flat);
}

function stationLx(station, length) {
  return (station - 0.5) * length;
}

function cgX(ship) {
  return -ship.length * 0.025;
}

function displacementVolume(ship) {
  return ship.mass / (RHO * BLOCK);
}

function waterplaneArea(ship) {
  return ship.beam * ship.length * 0.56;
}

function heaveMass(ship) {
  return ship.mass + 0.38 * RHO * displacementVolume(ship);
}

function pitchInertia(ship) {
  const hull = ship.mass * ship.length * ship.length * (1 / 12);
  const added = 0.2 * RHO * displacementVolume(ship) * ship.length * ship.length * (1 / 12);
  return (hull + added) * Math.max(0.35, ship.inertiaScale);
}

function sliceDepth(waveY, y, pitch, lx, keelLy, deckLy) {
  const sin = Math.sin(pitch);
  const cos = Math.cos(pitch);
  const keel = y + lx * sin + keelLy * cos;
  const deck = y + lx * sin + deckLy * cos;
  return Math.max(0, Math.min(waveY, deck) - keel);
}

function stripArea(beam, depth, keelLy, deckLy) {
  const keelBelow = Math.max(0, -keelLy);
  const deckAbove = Math.max(0, deckLy);
  const sectionH = keelBelow + deckAbove;
  if (depth < 0.006 || sectionH < 1e-6) return 0;
  const frac = Math.min(1, depth / sectionH);
  const shape = frac < 1 ? 0.34 + 0.5 * frac * frac : 0.82 + 0.12 * frac;
  return beam * depth * shape;
}

function buoyancyScale(ship, hull, waveY = null) {
  const key = `${ship.mass}|${ship.length}|${ship.beam}|${ship.draft}`;
  if (ship._buoyKey === key && ship._buoyScale) return ship._buoyScale;
  const dx = ship.length / (STATIONS - 1);
  const yRef = waveY ? waterlineOnWave(waveY, hull, 0) : 0;
  let buoyancy = 0;
  for (let i = 0; i < STATIONS; i += 1) {
    const eta = waveY ? waveY[i] : 0;
    const depth = sliceDepth(eta, yRef, 0, hull.lx[i], hull.keel[i], hull.deck[i]);
    buoyancy += RHO * G * dx * stripArea(ship.beam, depth, hull.keel[i], hull.deck[i]);
  }
  ship._buoyKey = key;
  ship._buoyScale = (ship.mass * G) / Math.max(buoyancy, 1);
  return ship._buoyScale;
}

function froudeGain(speed, length) {
  const fn = Math.abs(speed) / Math.sqrt(G * Math.max(1, length));
  return Math.min(1, fn * fn * 2.8);
}

function zoneWeight(station, center, width) {
  const d = Math.abs(station - center) / width;
  return Math.max(0, 1 - d);
}

function sectionLiftCoeff(ship, station) {
  let sumW = 0;
  let sumC = 0;
  for (const { center, width, key } of LIFT_ZONES) {
    const w = zoneWeight(station, center, width);
    sumW += w;
    sumC += w * ship[key];
  }
  return sumW > 1e-6 ? sumC / sumW : ship.midLift;
}

function waterlineOnWave(waveY, hull, pitch) {
  const sin = Math.sin(pitch);
  let sum = 0;
  for (let i = 0; i < STATIONS; i += 1) {
    sum += waveY[i] - hull.lx[i] * sin;
  }
  return sum / STATIONS;
}

function solveFlotationY(ship, waveY, pitch, hull, gains) {
  const draft = Math.max(0.2, ship.draft);
  const yWave = waterlineOnWave(waveY, hull, pitch);
  let lo = -draft * 0.96;
  let hi = -draft * 0.06;
  let fLo = hydroForces(ship, waveY, yWave + lo, pitch, hull, gains).Fy;
  let fHi = hydroForces(ship, waveY, yWave + hi, pitch, hull, gains).Fy;

  for (let expand = 0; expand < 5 && fLo * fHi > 0; expand += 1) {
    lo -= draft * 0.24;
    fLo = hydroForces(ship, waveY, yWave + lo, pitch, hull, gains).Fy;
    fHi = hydroForces(ship, waveY, yWave + hi, pitch, hull, gains).Fy;
  }

  for (let i = 0; i < 24; i += 1) {
    const delta = (lo + hi) * 0.5;
    const { Fy } = hydroForces(ship, waveY, yWave + delta, pitch, hull, gains);
    if (Fy > 0) lo = delta;
    else hi = delta;
  }
  return yWave + (lo + hi) * 0.5;
}

function hydroForces(ship, waveY, y, pitch, hull, gains, waveYForScale = null) {
  const dx = ship.length / (STATIONS - 1);
  const xcg = cgX(ship);
  const weight = ship.mass * G;
  const scale = buoyancyScale(ship, hull, waveYForScale);
  let buoyancy = 0;
  let moment = 0;
  let wet = 0;
  let submerged = 0;
  let bowDepth = 0;
  let sternDepth = 0;
  let liftSum = 0;
  const liftForces = [0, 0, 0];

  for (let i = 0; i < STATIONS; i += 1) {
    const lx = hull.lx[i];
    const depth = sliceDepth(waveY[i], y, pitch, lx, hull.keel[i], hull.deck[i]);
    if (depth < 0.006) continue;

    const base = scale * RHO * G * dx * stripArea(ship.beam, depth, hull.keel[i], hull.deck[i]);
    const gain = gains[i];
    const force = base * gain;
    const extra = force - base;

    buoyancy += force;
    moment += force * (lx - xcg);
    liftSum += extra;
    submerged += depth * dx;
    wet += 1;
    if (i > STATIONS * 0.8) bowDepth = depth;
    if (i < STATIONS * 0.2) sternDepth = depth;

    const station = i / (STATIONS - 1);
    for (let z = 0; z < LIFT_ZONES.length; z += 1) {
      const zone = LIFT_ZONES[z];
      const w = zoneWeight(station, zone.center, zone.width);
      if (w > 0.01) liftForces[z] += extra * w;
    }
  }

  return {
    Fy: buoyancy - weight,
    M: moment,
    wet: wet / STATIONS,
    sit: submerged / ship.length,
    trim: bowDepth - sternDepth,
    liftSum,
    liftForces,
  };
}

function quickPitchEquilibrium(ship, waveY, y, pitch, hull, gains) {
  let p = pitch;
  for (let pass = 0; pass < 12; pass += 1) {
    const m0 = hydroForces(ship, waveY, y, p, hull, gains).M;
    if (Math.abs(m0) < 60) break;
    const m1 = hydroForces(ship, waveY, y, p + 0.012, hull, gains).M;
    const dM = m1 - m0;
    if (Math.abs(dM) < 1e-5) break;
    p -= m0 / (dM / 0.012);
    p = Math.max(-0.42, Math.min(0.42, p));
  }
  return p;
}

function solveEquilibrium(ship, sea, speed, pitchSeed) {
  const waveY = sampleHullWaves(ship, sea);
  const hull = ensureHullCache(ship);
  const gains = ensureSectionGains(ship, speed);
  let pitch = pitchSeed;

  for (let pass = 0; pass < 22; pass += 1) {
    const y = solveFlotationY(ship, waveY, pitch, hull, gains);
    const m0 = hydroForces(ship, waveY, y, pitch, hull, gains).M;
    const m1 = hydroForces(ship, waveY, y, pitch + 0.008, hull, gains).M;
    const dM = m1 - m0;
    if (Math.abs(dM) > 1e-5) pitch -= m0 / (dM / 0.008);
    pitch = Math.max(-0.38, Math.min(0.38, pitch));
    if (pass > 5 && Math.abs(m0) < 250) break;
  }

  const y = solveFlotationY(ship, waveY, pitch, hull, gains);
  const hydro = hydroForces(ship, waveY, y, pitch, hull, gains);
  return { y, pitch, ...hydro };
}

function hydroStiffness(ship, waveY, y, pitch, hull, gains) {
  const epsY = 0.012;
  const epsP = 0.008;
  const base = hydroForces(ship, waveY, y, pitch, hull, gains);
  const kY = (hydroForces(ship, waveY, y + epsY, pitch, hull, gains).Fy - base.Fy) / epsY;
  const kP = (hydroForces(ship, waveY, y, pitch + epsP, hull, gains).M - base.M) / epsP;
  return { ...base, kY, kP };
}

export function settlePose(ship, sea, viewWidth) {
  const eq = solveEquilibrium(ship, sea, Math.abs(ship.speed), ship.pitch);
  ship.y = eq.y;
  ship.pitch = eq.pitch;
  ship.vy = 0;
  ship.vp = 0;
  ship.heave = eq.y;
  ship.wet = eq.wet;
  ship.sit = eq.sit;
  ship.trim = eq.trim;
  ship.liftSum = eq.liftSum;
  ship._liftForces = eq.liftForces;
}

export function stepShip(ship, sea, field, dt) {
  if (!ship.visible) return;

  const viewWidth = field.viewWidth;
  const heading = ship.heading >= 0 ? 1 : -1;
  if (!field.paused && ship.speed > 0) {
    field.scrollX += ship.speed * heading * dt;
  }
  ship.x = viewWidth * 0.5;

  const speed = Math.abs(ship.speed);
  const m = heaveMass(ship);
  const I = pitchInertia(ship);
  const { waveY, waveVy } = sampleHullSea(ship, sea);
  const hull = ensureHullCache(ship);
  const gains = ensureSectionGains(ship, speed);
  const kNominal = RHO * G * waterplaneArea(ship);
  const zetaH = 0.26 + ship.damping * 0.22;
  const zetaP = 0.2 + ship.damping * 0.18;
  let waveVyMid = 0;
  for (let i = 0; i < STATIONS; i += 1) waveVyMid += waveVy[i];
  waveVyMid /= STATIONS;

  const steps = dt > 0.012 ? 3 : 2;
  const subDt = dt / steps;

  for (let step = 0; step < steps; step += 1) {
    const hydro = hydroStiffness(ship, waveY, ship.y, ship.pitch, hull, gains);
    const kY = hydro.kY > 80 ? hydro.kY : kNominal * Math.max(0.08, hydro.wet);
    const kP = hydro.kP > 120 ? hydro.kP : kNominal * ship.length * ship.length * 0.045 * Math.max(0.08, hydro.wet);
    const cY = 2 * zetaH * Math.sqrt(m * kY);
    const cP = 2 * zetaP * Math.sqrt(I * kP);
    const relVy = ship.vy - waveVyMid;

    ship.vy += ((hydro.Fy - cY * relVy) / m) * subDt;
    ship.vp += ((hydro.M - cP * ship.vp) / I) * subDt;
    ship.y += ship.vy * subDt;
    ship.pitch += ship.vp * subDt;
  }

  const wetNow = hydroForces(ship, waveY, ship.y, ship.pitch, hull, gains).wet;
  if (wetNow > 0.2) {
    const wet = Math.min(1, wetNow * 1.25);
    const blend = Math.min(0.48, 3.6 * dt) * wet;
    const yEq = solveFlotationY(ship, waveY, ship.pitch, hull, gains);
    const pitchEq = quickPitchEquilibrium(ship, waveY, ship.y, ship.pitch, hull, gains);
    ship.y += (yEq - ship.y) * blend;
    ship.vy += (waveVyMid - ship.vy) * blend * 0.45;
    ship.pitch += (pitchEq - ship.pitch) * blend * 0.85;
    ship.vp *= 1 - blend * 0.35;
  }

  const report = hydroForces(ship, waveY, ship.y, ship.pitch, hull, gains);
  ship.pitch = Math.max(-0.4, Math.min(0.4, ship.pitch));
  ship.heave = ship.y;
  ship.wet = report.wet;
  ship.sit = report.sit;
  ship.trim = report.trim;
  ship.liftSum = report.liftSum;
  ship._liftForces = report.liftForces;
}

export function shipParts(ship) {
  const key = [ship.length, ship.draft, ship.beam].map((n) => n.toFixed(3)).join(":");
  if (ship._partsKey === key && ship._parts) return ship._parts;

  const L = ship.length;
  const D = ship.draft;
  const B = ship.beam;
  const free = Math.max(0.42, D * 0.7 + B * 0.12);
  const bowH = free * 1.45;
  const sternH = free * 0.78;
  const bow = L * 0.5;
  const stern = -L * 0.5;

  const midDeck = free * 0.9;
  const hull = [
    [stern, sternH],
    [stern, -D * 0.05],
    [stern + L * 0.1, -D * 0.38],
    [-L * 0.28, -D * 0.78],
    [-L * 0.14, -D * 1.14],
    [L * 0.14, -D * 1.14],
    [L * 0.28, -D * 0.92],
    [L * 0.4, -D * 0.68],
    [bow - L * 0.02, -D * 0.14],
    [bow, bowH * 0.22],
    [bow - L * 0.06, bowH],
    [L * 0.32, midDeck],
    [L * 0.16, midDeck],
    [0, midDeck],
    [-L * 0.16, midDeck],
    [-L * 0.32, midDeck],
    [-L * 0.44, midDeck],
    [stern + L * 0.06, midDeck * 0.94],
    [stern, sternH],
  ];

  const boot = [
    [stern + L * 0.01, 0],
    [0, 0],
    [bow - L * 0.04, 0],
  ];

  const houseAft = -L * 0.41;
  const houseFwd = -L * 0.1;
  const houseH = midDeck + Math.max(0.38, B * 0.16 + D * 0.14);
  const cabin = [
    [houseAft, midDeck],
    [houseAft + L * 0.03, houseH],
    [houseFwd - L * 0.02, houseH],
    [houseFwd, midDeck],
    [houseAft, midDeck],
  ];

  ship._partsKey = key;
  ship._parts = {
    hull,
    boot,
    cabin,
    mast: null,
    lifts: [
      [stationLx(0.12, L), -D * 0.1, ship.sternLift],
      [stationLx(0.5, L), -D * 0.18, ship.midLift],
      [stationLx(0.88, L), -D * 0.22, ship.bowLift],
    ],
  };
  return ship._parts;
}

function visualKeelY(station, draft) {
  const mid = Math.sin(station * Math.PI) ** 1.08;
  const bow = Math.max(0, (station - 0.74) / 0.26);
  return -draft * (0.2 + 0.94 * mid * (1 - bow * 0.78));
}

function visualDeckY(station, free) {
  const bow = Math.max(0, (station - 0.58) / 0.42);
  const stern = Math.max(0, (0.16 - station) / 0.16);
  return free * (0.88 + bow * 0.62 - stern * 0.12);
}

function visualBreadth(station) {
  const bow = station > 0.7 ? Math.max(0.03, ((1 - station) / 0.3) ** 0.65) : 1;
  const stern = station < 0.1 ? 0.58 + 0.42 * (station / 0.1) : 1;
  return Math.max(0.04, bow * stern * (0.78 + 0.22 * midshipFullness(station)));
}

export function hullRings(ship, stationCount = 20, profileCount = 11) {
  const L = ship.length;
  const D = ship.draft;
  const B = ship.beam;
  const free = Math.max(0.42, D * 0.7 + B * 0.12);
  const rings = [];
  for (let i = 0; i < stationCount; i += 1) {
    const station = i / (stationCount - 1);
    const lx = stationLx(station, L);
    const keel = visualKeelY(station, D);
    const deck = visualDeckY(station, free);
    const halfB = B * 0.5 * visualBreadth(station);
    const ring = [];
    for (let p = 0; p < profileCount; p += 1) {
      const u = p / (profileCount - 1);
      const s = Math.abs(u * 2 - 1);
      const side = u < 0.5 ? -1 : 1;
      ring.push({
        x: lx,
        y: keel + (deck - keel) * s ** 1.12,
        z: side * halfB * s ** 0.7,
      });
    }
    rings.push(ring);
  }

  const midDeck = free * 0.9;
  const houseAft = -L * 0.41;
  const houseFwd = -L * 0.1;
  const houseH = midDeck + Math.max(0.38, B * 0.16 + D * 0.14);
  return {
    rings,
    cabin: {
      x: (houseAft + houseFwd) * 0.5,
      y: (midDeck + houseH) * 0.5,
      z: 0,
      length: Math.max(0.4, houseFwd - houseAft),
      height: Math.max(0.28, houseH - midDeck),
      width: B * 0.62,
    },
  };
}

export function hullLocal(ship) {
  return shipParts(ship).hull;
}

export function liftLocal(ship) {
  const parts = shipParts(ship);
  const lifts = parts.lifts;
  const forces = ship._liftForces || [0, 0, 0];
  const ref = Math.max(3500, ship.mass * G * 0.035);
  lifts[0][2] = ship.sternLift;
  lifts[1][2] = ship.midLift;
  lifts[2][2] = ship.bowLift;
  lifts[0][3] = forces[0] / ref;
  lifts[1][3] = forces[1] / ref;
  lifts[2][3] = forces[2] / ref;
  return lifts;
}
