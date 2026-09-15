import {
  PRESETS,
  PRESET_LABELS,
  addImpulse,
  addLayer,
  classifySea,
  createField,
  EMPTY_WAVE,
  normalizeParams,
  peakAmplitude,
  removeLayer,
  sampleLine,
  scrollDisplayX,
  selectedLayer,
  stepField,
  windDir,
} from "./wave.js";
import {
  SHIP_LABELS,
  applyShipPreset,
  createShip,
  liftLocal,
  resetShipMotion,
  settlePose,
  setHeading,
  shipParts,
  stepShip,
} from "./ship.js";
import { applyState, readStateFromUrl, writeStateToUrl } from "./state-url.js";
import { knotsToMs, msToKnots } from "./units.js";

const app = document.querySelector("#app");
const canvas = document.querySelector("#viewport");
const canvas3d = document.querySelector("#viewport-3d");
const dockBackdrop = document.querySelector("#dock-backdrop");
const tabWaves = document.querySelector("#tab-waves");
const tabShip = document.querySelector("#tab-ship");

const NARROW_BREAKPOINT = 980;

function isNarrowViewport() {
  return window.innerWidth <= NARROW_BREAKPOINT;
}
const ctx = canvas.getContext("2d");
const field = createField();
const ship = createShip("yacht");
const draft = field.preview;

const waveControls = {
  amplitude: document.querySelector("#amplitude"),
  wavelength: document.querySelector("#wavelength"),
  period: document.querySelector("#period"),
  steepness: document.querySelector("#steepness"),
  breaker: document.querySelector("#breaker"),
};

const waveLabels = {
  amplitude: document.querySelector("#amplitude-val"),
  wavelength: document.querySelector("#wavelength-val"),
  period: document.querySelector("#period-val"),
  steepness: document.querySelector("#steepness-val"),
  breaker: document.querySelector("#breaker-val"),
};

const shipControls = {
  length: document.querySelector("#length"),
  mass: document.querySelector("#mass"),
  speed: document.querySelector("#speed"),
  draft: document.querySelector("#draft"),
  beam: document.querySelector("#beam"),
  bowLift: document.querySelector("#bowLift"),
  midLift: document.querySelector("#midLift"),
  sternLift: document.querySelector("#sternLift"),
  damping: document.querySelector("#damping"),
  inertiaScale: document.querySelector("#inertiaScale"),
};

const shipLabels = {
  length: document.querySelector("#length-val"),
  mass: document.querySelector("#mass-val"),
  speed: document.querySelector("#speed-val"),
  draft: document.querySelector("#draft-val"),
  beam: document.querySelector("#beam-val"),
  bowLift: document.querySelector("#bowLift-val"),
  midLift: document.querySelector("#midLift-val"),
  sternLift: document.querySelector("#sternLift-val"),
  damping: document.querySelector("#damping-val"),
  inertiaScale: document.querySelector("#inertiaScale-val"),
};

const pills = {
  form: document.querySelector("#form-pill"),
  height: document.querySelector("#height-pill"),
  period: document.querySelector("#period-pill"),
  steep: document.querySelector("#steep-pill"),
  ship: document.querySelector("#ship-pill"),
};

const readouts = {
  course: document.querySelector("#course-val"),
  heave: document.querySelector("#heave-val"),
  pitch: document.querySelector("#pitch-val"),
  wet: document.querySelector("#wet-val"),
  sit: document.querySelector("#sit-val"),
  trim: document.querySelector("#trim-val"),
  lift: document.querySelector("#lift-val"),
};

const pauseBtn = document.querySelector("#btn-pause");
const viewBtn = document.querySelector("#btn-view");
const brandBtn = document.querySelector("#btn-brand");
const resetDialog = document.querySelector("#reset-dialog");
const resetYesBtn = document.querySelector("#reset-yes");
const resetNoBtn = document.querySelector("#reset-no");
const waveDockBtn = document.querySelector("#btn-wave-dock");
const shipDockBtn = document.querySelector("#btn-ship-dock");
const layerList = document.querySelector("#layer-list");
const stackEmpty = document.querySelector("#stack-empty");
const nameInput = document.querySelector("#wave-name");
const editorMode = document.querySelector("#editor-mode");
const windInput = document.querySelector("#wind");
const windLabel = document.querySelector("#wind-val");
const shipPresetBox = document.querySelector("#ship-presets");
const formStarters = document.querySelector("#form-starters");

let activeShipPreset = "yacht";
let last = performance.now();
let urlSyncTimer = null;
let view3d = null;
let view3dFailed = false;
let view3dPromise = null;

function queueUrlSync() {
  clearTimeout(urlSyncTimer);
  urlSyncTimer = setTimeout(() => {
    writeStateToUrl(field, ship, { preset: activeShipPreset });
  }, 350);
}

function syncUrlNow() {
  clearTimeout(urlSyncTimer);
  writeStateToUrl(field, ship, { preset: activeShipPreset });
}

function formatPercent(value) {
  return `${Math.round(value * 100)}%`;
}

function editorTarget() {
  return selectedLayer(field) ?? draft;
}

function currentParams() {
  return editorTarget().params;
}

function currentName() {
  const layer = selectedLayer(field);
  return layer ? layer.name : draft.name;
}

function syncEditor() {
  const params = currentParams();
  for (const [key, input] of Object.entries(waveControls)) {
    input.value = String(params[key]);
  }
  nameInput.value = currentName();
  refreshWaveLabels();
  renderLayers();
  const editing = Boolean(selectedLayer(field));
  editorMode.textContent = editing ? `Editing ${currentName()}` : "New waveform";
}

function refreshWaveLabels() {
  const p = currentParams();
  waveLabels.amplitude.textContent = `${p.amplitude.toFixed(2)} m`;
  waveLabels.wavelength.textContent = `${p.wavelength.toFixed(1)} m`;
  waveLabels.period.textContent = `${p.period.toFixed(1)} s`;
  waveLabels.steepness.textContent = p.steepness.toFixed(2);
  waveLabels.breaker.textContent = formatPercent(p.breaker);
}

function syncWeather() {
  windInput.value = String(field.weather.strength);
  windLabel.textContent = formatPercent(field.weather.strength);
  document.querySelector("#btn-wind-back").classList.toggle("active", field.weather.from === "back");
  document.querySelector("#btn-wind-front").classList.toggle("active", field.weather.from === "front");
}

function syncShipControls() {
  for (const [key, input] of Object.entries(shipControls)) {
    if (key === "speed") input.value = msToKnots(ship.speed).toFixed(1);
    else input.value = String(ship[key]);
  }
  refreshShipLabels();
  markShipPreset();
}

function courseLabel() {
  return ship.heading >= 0 ? "From waves" : "Against waves";
}

function refreshShipLabels() {
  shipLabels.length.textContent = `${ship.length.toFixed(1)} m`;
  shipLabels.mass.textContent = `${(ship.mass / 1000).toFixed(1)} t`;
  shipLabels.speed.textContent = `${msToKnots(ship.speed).toFixed(1)} kn`;
  shipLabels.draft.textContent = `${ship.draft.toFixed(2)} m`;
  shipLabels.beam.textContent = `${ship.beam.toFixed(1)} m`;
  shipLabels.bowLift.textContent = formatPercent(ship.bowLift);
  shipLabels.midLift.textContent = formatPercent(ship.midLift);
  shipLabels.sternLift.textContent = formatPercent(ship.sternLift);
  shipLabels.damping.textContent = formatPercent(ship.damping);
  shipLabels.inertiaScale.textContent = `${ship.inertiaScale.toFixed(2)}×`;
  document.querySelector("#btn-heading-from").classList.toggle("active", ship.heading >= 0);
  document.querySelector("#btn-heading-against").classList.toggle("active", ship.heading < 0);
}

function markShipPreset() {
  for (const button of shipPresetBox.querySelectorAll("button")) {
    button.classList.toggle("active", button.dataset.preset === activeShipPreset);
  }
}

function renderLayers() {
  layerList.replaceChildren();
  stackEmpty.classList.toggle("hidden", field.layers.length > 0);
  for (const layer of field.layers) {
    const row = document.createElement("div");
    row.className = "layer-row";

    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = `pick${layer.id === field.selectedId ? " active" : ""}`;
    pick.textContent = `${layer.enabled ? "" : "(off) "}${layer.name}`;
    pick.addEventListener("click", () => {
      field.selectedId = layer.id;
      Object.assign(draft.params, layer.params);
      draft.name = layer.name;
      syncEditor();
      queueUrlSync();
    });

    const gain = document.createElement("input");
    gain.type = "range";
    gain.min = "0.15";
    gain.max = "1.6";
    gain.step = "0.05";
    gain.value = String(layer.gain);
    gain.title = "Mix";
    gain.addEventListener("input", () => {
      layer.gain = Number(gain.value);
      queueUrlSync();
    });

    const mute = document.createElement("button");
    mute.type = "button";
    mute.className = "icon-btn";
    mute.textContent = layer.enabled ? "On" : "Off";
    mute.addEventListener("click", (event) => {
      event.stopPropagation();
      layer.enabled = !layer.enabled;
      renderLayers();
      queueUrlSync();
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icon-btn";
    remove.textContent = "×";
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      removeLayer(field, layer.id);
      const next = selectedLayer(field);
      if (next) {
        Object.assign(draft.params, next.params);
        draft.name = next.name;
      }
      syncEditor();
      queueUrlSync();
    });

    row.append(pick, gain, mute, remove);
    layerList.append(row);
  }
}

function bindWaveControls() {
  for (const [key, input] of Object.entries(waveControls)) {
    input.addEventListener("input", () => {
      currentParams()[key] = Number(input.value);
      refreshWaveLabels();
      queueUrlSync();
    });
  }
  nameInput.addEventListener("input", () => {
    const layer = selectedLayer(field);
    if (layer) layer.name = nameInput.value || layer.name;
    else draft.name = nameInput.value || "Wave";
    renderLayers();
    editorMode.textContent = layer ? `Editing ${currentName()}` : "New waveform";
    queueUrlSync();
  });
}

function bindShipControls() {
  for (const [key, input] of Object.entries(shipControls)) {
    input.addEventListener("input", () => {
      if (key === "speed") ship.speed = knotsToMs(Number(input.value));
      else ship[key] = Number(input.value);
      activeShipPreset = "";
      refreshShipLabels();
      markShipPreset();
      if (key === "mass" || key === "length" || key === "beam" || key === "draft") {
        resetShipOnSea();
      }
      if (key === "bowLift" || key === "midLift" || key === "sternLift") {
        ship._gainKey = null;
        settlePose(ship, sampleSea(), field.viewWidth);
        refreshShipLabels();
        if (readouts.pitch) {
          readouts.pitch.textContent = `${((ship.pitch * 180) / Math.PI).toFixed(1)}°`;
        }
        if (readouts.trim) {
          readouts.trim.textContent = `${ship.trim >= 0 ? "+" : ""}${ship.trim.toFixed(2)} m`;
        }
        if (readouts.lift) {
          readouts.lift.textContent = `${(ship.liftSum / 1000).toFixed(1)} kN`;
        }
      }
      queueUrlSync();
    });
  }
}

function buildFormStarters() {
  for (const [name, label] of Object.entries(PRESET_LABELS)) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", () => {
      const params = normalizeParams(PRESETS[name]);
      Object.assign(currentParams(), params);
      if (selectedLayer(field)) selectedLayer(field).name = label;
      else draft.name = label;
      syncEditor();
      queueUrlSync();
    });
    formStarters.append(button);
  }
}

function buildShipPresets() {
  for (const [name, label] of Object.entries(SHIP_LABELS)) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.preset = name;
    button.textContent = label;
    button.addEventListener("click", () => {
      applyShipPreset(ship, name, field.viewWidth, sampleSea());
      activeShipPreset = name;
      syncShipControls();
      queueUrlSync();
    });
    shipPresetBox.append(button);
  }
}

function updateDockChrome() {
  const waveOpen = app.classList.contains("wave-open");
  const shipOpen = app.classList.contains("ship-open");
  const narrow = isNarrowViewport();
  const anyOpen = waveOpen || shipOpen;

  waveDockBtn.classList.toggle("active", waveOpen);
  shipDockBtn.classList.toggle("active", shipOpen);
  tabWaves.setAttribute("aria-expanded", String(waveOpen));
  tabShip.setAttribute("aria-expanded", String(shipOpen));

  if (narrow) {
    dockBackdrop.hidden = !anyOpen;
    dockBackdrop.classList.toggle("visible", anyOpen);
    dockBackdrop.setAttribute("aria-hidden", String(!anyOpen));
    document.body.classList.toggle("dock-open", anyOpen);
  } else {
    dockBackdrop.hidden = true;
    dockBackdrop.classList.remove("visible");
    dockBackdrop.setAttribute("aria-hidden", "true");
    document.body.classList.remove("dock-open");
  }
}

function setWaveDock(open, { mutual = true } = {}) {
  if (open && mutual && isNarrowViewport()) setShipDock(false, { mutual: false });
  app.classList.toggle("wave-open", open);
  updateDockChrome();
}

function setShipDock(open, { mutual = true } = {}) {
  if (open && mutual && isNarrowViewport()) setWaveDock(false, { mutual: false });
  app.classList.toggle("ship-open", open);
  ship.visible = true;
  pills.ship.classList.remove("hidden");
  updateDockChrome();
}

function closeAllDocks() {
  setWaveDock(false, { mutual: false });
  setShipDock(false, { mutual: false });
}

function initDockLayout() {
  if (isNarrowViewport()) closeAllDocks();
  else updateDockChrome();
}

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const { clientWidth, clientHeight } = canvas;
  canvas.width = Math.max(1, Math.floor(clientWidth * dpr));
  canvas.height = Math.max(1, Math.floor(clientHeight * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  view3d?.resize();
}

function pxPerMeter(width) {
  return width / field.viewWidth;
}

function sceneViewWidth(width, height, stats) {
  const horizM = Math.max(36, ship.length * 4.85);
  const waveBand = Math.max(0.5, stats.maxY - stats.minY, peakAmplitude(field) * 2);
  const vertM = waveBand + ship.draft * 1.35 + ship.length * 0.1;
  const fitHeightM = vertM / 0.72;
  return Math.max(horizM, fitHeightM * (width / Math.max(1, height)));
}

function worldToScreen(x, y, width, height) {
  const scale = pxPerMeter(width);
  const mid = height * 0.58;
  return [x * scale, mid - y * scale];
}

function seaClip(points, width, height, underwater) {
  if (!points.length) return;
  ctx.beginPath();
  if (underwater) {
    points.forEach((p, i) => {
      const [sx, sy] = worldToScreen(p.x, p.y, width, height);
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    });
    ctx.lineTo(width, height);
    ctx.lineTo(0, height);
  } else {
    ctx.moveTo(0, 0);
    ctx.lineTo(width, 0);
    for (let i = points.length - 1; i >= 0; i -= 1) {
      const [sx, sy] = worldToScreen(points[i].x, points[i].y, width, height);
      ctx.lineTo(sx, sy);
    }
  }
  ctx.closePath();
  ctx.clip();
}

function drawShip(width, height, points) {
  const origin = worldToScreen(ship.x, ship.y, width, height);
  const scale = pxPerMeter(width);
  const heading = ship.heading >= 0 ? 1 : -1;
  const cos = Math.cos(ship.pitch);
  const sin = Math.sin(ship.pitch);

  function point(lx, ly) {
    const wx = (lx * cos - ly * sin) * heading;
    const wy = lx * sin + ly * cos;
    return [origin[0] + wx * scale, origin[1] - wy * scale];
  }

  function strokePath(pts, closed = false) {
    if (!pts?.length) return;
    ctx.beginPath();
    pts.forEach(([lx, ly], index) => {
      const [sx, sy] = point(lx, ly);
      if (index === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    });
    if (closed) ctx.closePath();
  }

  const parts = shipParts(ship);

  ctx.save();
  seaClip(points, width, height, true);
  strokePath(parts.hull, true);
  ctx.fillStyle = "#152026";
  ctx.fill();
  ctx.restore();

  ctx.save();
  seaClip(points, width, height, false);
  strokePath(parts.hull, true);
  ctx.fillStyle = "#c4a37a";
  ctx.fill();
  ctx.restore();

  strokePath(parts.hull, true);
  ctx.strokeStyle = "#ead7b8";
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "round";
  ctx.stroke();

  strokePath(parts.boot);
  ctx.strokeStyle = "#5c4030";
  ctx.lineWidth = 1.8;
  ctx.stroke();

  strokePath(parts.cabin, true);
  ctx.fillStyle = "#d8c4a4";
  ctx.strokeStyle = "#ead7b8";
  ctx.lineWidth = 1.2;
  ctx.fill();
  ctx.stroke();

  if (parts.mast) {
    strokePath(parts.mast);
    ctx.strokeStyle = "#d7c4a6";
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }

  ctx.lineWidth = 1.2;
  for (const lift of liftLocal(ship)) {
    const [lx, ly, coeff, forceScale = coeff] = lift;
    const arrow = 0.1 + coeff * 0.35 + forceScale * 0.85;
    const [sx, sy] = point(lx, ly);
    const [ex, ey] = point(lx, ly + arrow);
    ctx.strokeStyle = forceScale > 0.08 ? "rgba(61, 184, 197, 0.95)" : "rgba(230, 195, 106, 0.45)";
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(ex, ey);
    ctx.stroke();
  }
}

function fitView(stats) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const targetWidth = sceneViewWidth(width, height, stats);
  field.viewWidth += (targetWidth - field.viewWidth) * 0.08;
  ship.x = field.viewWidth * 0.5;
}

function draw(stats) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const scale = pxPerMeter(width);
  const mid = height * 0.58;

  ctx.clearRect(0, 0, width, height);

  const sky = ctx.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, "#1b3034");
  sky.addColorStop(0.55, "#0c1418");
  sky.addColorStop(1, "#081014");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);

  const stillY = mid;
  ctx.beginPath();
  ctx.moveTo(0, stillY);
  ctx.lineTo(width, stillY);
  ctx.strokeStyle = "rgba(231, 239, 230, 0.12)";
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 8]);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.font = "11px ui-monospace, SF Mono, Menlo, monospace";
  ctx.fillStyle = "rgba(138, 160, 154, 0.7)";
  ctx.textAlign = "left";
  const topM = (mid - 24) / scale;
  const botM = -(height - mid - 20) / scale;
  const tickStep = scale < 8 ? 2 : 1;
  const first = Math.floor(botM / tickStep) * tickStep;
  for (let meter = first; meter <= topM; meter += tickStep) {
    const y = mid - meter * scale;
    if (y < 24 || y > height - 20) continue;
    ctx.fillText(`${meter > 0 ? "+" : ""}${meter} m`, 16, y - 6);
  }

  ctx.beginPath();
  stats.points.forEach((point, index) => {
    const [sx, sy] = worldToScreen(point.x, point.y, width, height);
    if (index === 0) ctx.moveTo(sx, sy);
    else ctx.lineTo(sx, sy);
  });
  ctx.strokeStyle = "#e7efe6";
  ctx.lineWidth = 1.7;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.shadowColor = "rgba(61, 184, 197, 0.45)";
  ctx.stroke();

  ctx.strokeStyle = "rgba(231, 239, 230, 0.78)";
  ctx.lineWidth = 1.35;
  ctx.beginPath();
  const dir = windDir(field);
  for (let i = 1; i < stats.points.length; i += 1) {
    const point = stats.points[i];
    if (!point.break || point.break < 0.06) continue;
    const prev = stats.points[i - 1];
    const slope = point.slope ?? (point.y - prev.y) / Math.max(1e-4, point.x - prev.x);
    const run = 0.18 + point.break * 0.7;
    const [sx, sy] = worldToScreen(point.x, point.y, width, height);
    const [tx, ty] = worldToScreen(
      point.x + dir * run,
      point.y + slope * dir * run - point.break * 0.16,
      width,
      height
    );
    ctx.moveTo(sx, sy);
    ctx.lineTo(tx, ty);
  }
  ctx.stroke();

  ctx.lineWidth = 2.4;
  ctx.strokeStyle = "rgba(231, 239, 230, 0.22)";
  ctx.beginPath();
  let foamOpen = false;
  for (let i = 0; i < stats.points.length; i += 1) {
    const point = stats.points[i];
    if (!point.break || point.break < 0.14) {
      foamOpen = false;
      continue;
    }
    const [sx, sy] = worldToScreen(point.x, point.y + 0.04, width, height);
    if (!foamOpen) {
      ctx.moveTo(sx, sy);
      foamOpen = true;
    } else ctx.lineTo(sx, sy);
  }
  ctx.stroke();

  ctx.lineWidth = 1.15;
  const scroll = field.scrollX ?? 0;
  for (const drop of field.spray) {
    const fade = 1 - drop.age / drop.life;
    const dx = scrollDisplayX(drop.x, field.viewWidth, scroll);
    const [x1, y1] = worldToScreen(dx, drop.y, width, height);
    const [x2, y2] = worldToScreen(dx + drop.vx * 0.045, drop.y + drop.vy * 0.045, width, height);
    ctx.strokeStyle = `rgba(231, 239, 230, ${0.18 + fade * 0.7})`;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  if (ship.visible) drawShip(width, height, stats.points);
}

function updateHud(stats) {
  const sea = classifySea(field, stats);
  pills.form.textContent = sea.name;
  pills.form.classList.toggle("alert", sea.name === "Breaking" || sea.name === "Huge" || sea.name === "Gale");
  pills.height.textContent = `Hs ${sea.hs.toFixed(2)} m`;
  pills.period.textContent = `T ${sea.period.toFixed(1)} s`;
  if (stats.waveC > 0.05) {
    const enc = stats.waveC + (ship.heading >= 0 ? 1 : -1) * ship.speed;
    pills.steep.textContent = `c ${msToKnots(stats.waveC).toFixed(1)} kn`;
    pills.ship.textContent = `${courseLabel()} · ${msToKnots(ship.speed).toFixed(1)} kn · ${msToKnots(enc).toFixed(1)} kn λ`;
  } else {
    pills.steep.textContent = `ak ${sea.ak.toFixed(2)}`;
    pills.ship.textContent = `${courseLabel()} · ${msToKnots(ship.speed).toFixed(1)} kn`;
  }
  readouts.course.textContent = courseLabel();
  readouts.heave.textContent = `${ship.heave.toFixed(2)} m`;
  readouts.pitch.textContent = `${((ship.pitch * 180) / Math.PI).toFixed(1)}°`;
  readouts.wet.textContent = formatPercent(ship.wet);
  readouts.sit.textContent = `${ship.sit.toFixed(2)} m`;
  if (readouts.trim) readouts.trim.textContent = `${ship.trim >= 0 ? "+" : ""}${ship.trim.toFixed(2)} m`;
  if (readouts.lift) readouts.lift.textContent = `${(ship.liftSum / 1000).toFixed(1)} kN`;
}

function sampleSea() {
  const count = Math.max(900, Math.floor(canvas.clientWidth * 2.4));
  return sampleLine(field, count);
}

function resetShipOnSea() {
  field.scrollX = 0;
  resetShipMotion(ship, field.viewWidth, sampleSea());
}

function resetSimulation() {
  const viewWidth = field.viewWidth;
  field.time = 0;
  field.paused = false;
  field.scrollX = 0;
  field.layers = [];
  field.selectedId = null;
  field.preview.name = "Wave";
  field.preview.params = normalizeParams(EMPTY_WAVE);
  field.weather.strength = 0;
  field.weather.from = "back";
  field.impulses = [];
  field.spray = [];
  field.spawnCarry = 0;
  field.viewWidth = viewWidth;

  Object.assign(ship, createShip("yacht"));
  ship._buoyKey = null;
  ship._hullCacheKey = null;
  ship._gainKey = null;
  ship._partsKey = null;
  ship._liftForces = null;

  activeShipPreset = "yacht";
  pauseBtn.textContent = "Pause";
  syncEditor();
  syncWeather();
  syncShipControls();
  resetShipOnSea();
  syncUrlNow();
}

function isView3d() {
  return app.classList.contains("view-3d");
}

function ensureView3d() {
  if (view3d) return Promise.resolve(view3d);
  if (view3dFailed || !canvas3d) return Promise.resolve(null);
  if (!view3dPromise) {
    view3dPromise = import("./view3d.js")
      .then(({ createView3D }) => {
        view3d = createView3D(canvas3d, {
          onPickX(x) {
            addImpulse(field, x + field.viewWidth * 0.5, clickImpulseAmp());
          },
        });
        return view3d;
      })
      .catch((err) => {
        view3dFailed = true;
        view3dPromise = null;
        console.warn("3D view unavailable", err);
        return null;
      });
  }
  return view3dPromise;
}

async function setView3d(on) {
  if (on) {
    const next = await ensureView3d();
    if (!next) return;
    app.classList.add("view-3d");
    viewBtn.classList.add("active");
    viewBtn.setAttribute("aria-pressed", "true");
    next.resize();
    next.resetCamera(ship);
  } else {
    app.classList.remove("view-3d");
    viewBtn.classList.remove("active");
    viewBtn.setAttribute("aria-pressed", "false");
  }
}

function loadStateFromUrl() {
  const payload = readStateFromUrl();
  if (!payload) return false;
  const loaded = applyState(field, ship, payload);
  activeShipPreset = loaded?.preset || "";
  return true;
}

function tick(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  stepField(field, dt);
  const stats = sampleSea();
  if (!field.paused) stepShip(ship, stats, field, dt);
  fitView(stats);
  if (canvas.clientWidth > 1) {
    if (isView3d() && view3d) view3d.render(field, ship);
    else draw(stats);
  }
  updateHud(stats);
  requestAnimationFrame(tick);
}

function showTab(name) {
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("is-on", b.dataset.tab === name));
  document.querySelectorAll("main .panel").forEach((p) => {
    p.classList.toggle("is-on", p.id === `panel-${name}`);
  });
  if (name === "sea") {
    requestAnimationFrame(() => {
      resize();
      view3d?.resize();
    });
  }
}

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => showTab(btn.dataset.tab));
});

document.querySelectorAll("[data-jump]").forEach((el) => {
  el.addEventListener("click", () => {
    showTab("glossary");
    const target = document.getElementById(el.dataset.jump);
    if (!target) return;
    document.querySelectorAll(".glossary article").forEach((card) => card.classList.remove("is-focus"));
    target.classList.add("is-focus");
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  });
});

function canvasToWorldX(clientX) {
  const rect = canvas.getBoundingClientRect();
  return ((clientX - rect.left) / rect.width) * field.viewWidth;
}

function clickImpulseAmp() {
  return 5.2 + Math.max(1.4, peakAmplitude(field)) * 1.8;
}

canvas.addEventListener("pointerdown", (event) => {
  addImpulse(field, canvasToWorldX(event.clientX), clickImpulseAmp());
});

waveDockBtn.addEventListener("click", () => setWaveDock(!app.classList.contains("wave-open")));
tabWaves.addEventListener("click", () => setWaveDock(true));
document.querySelector("#btn-wave-collapse").addEventListener("click", () => setWaveDock(false));

shipDockBtn.addEventListener("click", () => setShipDock(!app.classList.contains("ship-open")));
document.querySelector("#btn-ship-collapse").addEventListener("click", () => setShipDock(false));
tabShip.addEventListener("click", () => setShipDock(true));

dockBackdrop.addEventListener("click", closeAllDocks);

pauseBtn.addEventListener("click", () => {
  field.paused = !field.paused;
  pauseBtn.textContent = field.paused ? "Play" : "Pause";
});

viewBtn.addEventListener("click", () => setView3d(!isView3d()));

brandBtn.addEventListener("click", () => {
  if (typeof resetDialog.showModal === "function") resetDialog.showModal();
  else if (window.confirm("Do you want to reset the simulation?")) resetSimulation();
});

resetYesBtn.addEventListener("click", () => {
  resetDialog.close();
  resetSimulation();
});

resetNoBtn.addEventListener("click", () => {
  resetDialog.close();
});

resetDialog.addEventListener("click", (event) => {
  if (event.target === resetDialog) resetDialog.close();
});

document.querySelector("#btn-add-wave").addEventListener("click", () => {
  const added = addLayer(field, currentName() || "Wave", currentParams());
  if (!added) return;
  field.selectedId = null;
  draft.name = "Wave";
  draft.params = normalizeParams(EMPTY_WAVE);
  syncEditor();
  queueUrlSync();
});

document.querySelector("#btn-new-wave").addEventListener("click", () => {
  field.selectedId = null;
  draft.name = "Wave";
  draft.params = normalizeParams(EMPTY_WAVE);
  syncEditor();
  queueUrlSync();
});

windInput.addEventListener("input", () => {
  field.weather.strength = Number(windInput.value);
  windLabel.textContent = formatPercent(field.weather.strength);
  queueUrlSync();
});

document.querySelector("#btn-wind-back").addEventListener("click", () => {
  field.weather.from = "back";
  syncWeather();
  queueUrlSync();
});

document.querySelector("#btn-wind-front").addEventListener("click", () => {
  field.weather.from = "front";
  syncWeather();
  queueUrlSync();
});

document.querySelector("#btn-heading-from").addEventListener("click", () => {
  setHeading(ship, 1, field.viewWidth, sampleSea());
  refreshShipLabels();
  queueUrlSync();
});

document.querySelector("#btn-heading-against").addEventListener("click", () => {
  setHeading(ship, -1, field.viewWidth, sampleSea());
  refreshShipLabels();
  queueUrlSync();
});

document.querySelector("#btn-ship-reset").addEventListener("click", () => {
  resetShipOnSea();
});

window.addEventListener("keydown", (event) => {
  if (resetDialog.open) return;
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
  if (event.code === "Space") {
    event.preventDefault();
    pauseBtn.click();
    return;
  }
  if (event.key === "w") {
    waveDockBtn.click();
    return;
  }
  if (event.key === "s") {
    shipDockBtn.click();
    return;
  }
  if (event.key === "v") {
    event.preventDefault();
    setView3d(!isView3d());
    return;
  }
  if (event.key === "Escape" && isNarrowViewport()) {
    closeAllDocks();
    return;
  }
  if (event.key === "ArrowRight") {
    event.preventDefault();
    setHeading(ship, 1, field.viewWidth, sampleSea());
    refreshShipLabels();
    queueUrlSync();
    return;
  }
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    setHeading(ship, -1, field.viewWidth, sampleSea());
    refreshShipLabels();
    queueUrlSync();
    return;
  }
});

window.addEventListener("pagehide", syncUrlNow);

window.addEventListener("resize", () => {
  resize();
  if (!isNarrowViewport()) {
    dockBackdrop.hidden = true;
    dockBackdrop.classList.remove("visible");
    document.body.classList.remove("dock-open");
  }
  updateDockChrome();
});

buildFormStarters();
buildShipPresets();
bindWaveControls();
bindShipControls();
syncEditor();
syncWeather();
syncShipControls();
initDockLayout();
resize();
if (loadStateFromUrl()) {
  syncEditor();
  syncWeather();
  syncShipControls();
}
resetShipOnSea();
syncUrlNow();
requestAnimationFrame(tick);
