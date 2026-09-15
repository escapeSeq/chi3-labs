import { EMPTY_WAVE, normalizeParams, replaceLayersFromSnapshot } from "./wave.js";

const STATE_VERSION = 1;
const HASH_PREFIX = "s=";

function round(n, digits = 3) {
  if (!Number.isFinite(n)) return 0;
  const m = 10 ** digits;
  return Math.round(n * m) / m;
}

function packParams(params) {
  const p = normalizeParams(params);
  return [round(p.amplitude, 2), round(p.wavelength, 1), round(p.period, 2), round(p.steepness, 2), round(p.breaker, 2)];
}

function unpackParams(arr) {
  if (!Array.isArray(arr) || arr.length < 5) return normalizeParams(EMPTY_WAVE);
  return normalizeParams({
    amplitude: arr[0],
    wavelength: arr[1],
    period: arr[2],
    steepness: arr[3],
    breaker: arr[4],
  });
}

function packLayer(layer) {
  return [layer.name || "Wave", round(layer.gain, 2), layer.enabled ? 1 : 0, packParams(layer.params)];
}

function unpackLayer(raw) {
  if (!Array.isArray(raw) || raw.length < 4) return null;
  return {
    name: String(raw[0] || "Wave").slice(0, 32),
    gain: Math.max(0.15, Math.min(1.6, Number(raw[1]) || 1)),
    enabled: raw[2] !== 0,
    params: unpackParams(raw[3]),
  };
}

export function captureState(field, ship, meta = {}) {
  const sel = field.selectedId ? field.layers.findIndex((layer) => layer.id === field.selectedId) : -1;
  return {
    v: STATE_VERSION,
    f: {
      w: [round(field.weather?.strength ?? 0, 2), field.weather?.from === "front" ? 1 : 0],
      sel,
      ly: field.layers.map(packLayer),
      pv: [field.preview?.name || "Wave", packParams(field.preview?.params ?? EMPTY_WAVE)],
    },
    s: {
      ps: meta.preset || "",
      length: round(ship.length, 2),
      mass: round(ship.mass, 0),
      speed: round(ship.speed, 2),
      draft: round(ship.draft, 2),
      beam: round(ship.beam, 2),
      bow: round(ship.bowLift, 2),
      mid: round(ship.midLift, 2),
      stern: round(ship.sternLift, 2),
      damp: round(ship.damping, 2),
      inert: round(ship.inertiaScale, 2),
      hd: ship.heading >= 0 ? 1 : -1,
    },
  };
}

function invalidateShipCaches(ship) {
  ship._buoyKey = null;
  ship._hullCacheKey = null;
  ship._gainKey = null;
  ship._partsKey = null;
  ship._liftForces = null;
}

export function applyState(field, ship, payload) {
  if (!payload || payload.v !== STATE_VERSION || !payload.f || !payload.s) return null;

  const f = payload.f;
  const s = payload.s;

  field.time = 0;
  field.paused = false;
  field.scrollX = 0;
  field.weather.strength = Math.max(0, Math.min(1, Number(f.w?.[0]) || 0));
  field.weather.from = f.w?.[1] === 1 ? "front" : "back";
  field.impulses = [];
  field.spray = [];
  field.spawnCarry = 0;

  const layers = (Array.isArray(f.ly) ? f.ly : []).map(unpackLayer).filter(Boolean);
  replaceLayersFromSnapshot(field, layers);

  const sel = Number(f.sel);
  if (Number.isInteger(sel) && sel >= 0 && sel < field.layers.length) {
    field.selectedId = field.layers[sel].id;
  } else {
    field.selectedId = null;
  }

  const preview = Array.isArray(f.pv) ? f.pv : ["Wave", packParams(EMPTY_WAVE)];
  field.preview.name = String(preview[0] || "Wave").slice(0, 32);
  field.preview.params = unpackParams(preview[1]);

  ship.visible = true;
  ship.length = Math.max(5, Math.min(28, Number(s.length) || 14));
  ship.mass = Math.max(400, Math.min(80000, Number(s.mass) || 12000));
  ship.speed = Math.max(0, Math.min(16, Number(s.speed) || 0));
  ship.draft = Math.max(0.25, Math.min(3.4, Number(s.draft) || 1.35));
  ship.beam = Math.max(1.2, Math.min(7, Number(s.beam) || 3.4));
  ship.bowLift = Math.max(0, Math.min(1.2, Number(s.bow) ?? 0.32));
  ship.midLift = Math.max(0, Math.min(1.2, Number(s.mid) ?? 0.55));
  ship.sternLift = Math.max(0, Math.min(1.2, Number(s.stern) ?? 0.38));
  ship.damping = Math.max(0.1, Math.min(1.2, Number(s.damp) ?? 0.58));
  ship.inertiaScale = Math.max(0.4, Math.min(2, Number(s.inert) ?? 1));
  ship.heading = Number(s.hd) >= 0 ? 1 : -1;
  ship.x = field.viewWidth * 0.5;
  ship.y = 0;
  ship.pitch = 0;
  ship.vy = 0;
  ship.vp = 0;
  ship.heave = 0;
  ship.fold = 0;
  ship.hog = 0;
  ship.damage = 0;
  ship.broken = false;
  ship._prevDepth = null;

  invalidateShipCaches(ship);

  return { preset: typeof s.ps === "string" ? s.ps : "" };
}

function toBase64Url(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(encoded) {
  const padded = encoded + "===".slice((encoded.length + 3) % 4);
  const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function encodeState(field, ship, meta) {
  return toBase64Url(JSON.stringify(captureState(field, ship, meta)));
}

export function decodeState(encoded) {
  if (!encoded) return null;
  try {
    const json = fromBase64Url(encoded);
    const payload = JSON.parse(json);
    if (payload?.v !== STATE_VERSION) return null;
    return payload;
  } catch {
    return null;
  }
}

export function readStateFromUrl() {
  const hash = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
  const hashParams = new URLSearchParams(hash);
  const fromHash = hashParams.get("s");
  if (fromHash) return decodeState(fromHash);

  const query = new URLSearchParams(location.search);
  const fromQuery = query.get("s");
  if (fromQuery) return decodeState(fromQuery);

  return null;
}

export function writeStateToUrl(field, ship, meta) {
  const encoded = encodeState(field, ship, meta);
  const nextHash = `${HASH_PREFIX}${encoded}`;
  if (location.hash === `#${nextHash}` && !location.search) return;
  const url = new URL(location.href);
  url.search = "";
  url.hash = nextHash;
  history.replaceState(null, "", url);
}
