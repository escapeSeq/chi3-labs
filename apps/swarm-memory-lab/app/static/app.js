import { createAcademyClient } from "./client.js";

const academy = createAcademyClient(new URL("./academy-worker.js", import.meta.url));

const $ = (id) => document.getElementById(id);
function text(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}

const PALETTE = ["#e85d4c", "#3db8c5", "#e6c36a", "#7c6bff", "#5dce8a", "#e07ab5", "#f08a4b", "#8aa09a"];
const PREY_MIN = 1;
const HIVE_MIN = 1;
const PLANES_MAX = 8;
const TIMEOUT_MIN = 10;
const TIMEOUT_MAX = 600;
const TIMEOUT_DT = 0.05;
const BURST_REPORT = 10_000;
const OUTCOMES = {
  escape: "escaped",
  wipe: "pack wiped",
  clean_hunt: "clean hunt",
  hunt: "pack scored",
  prey_crash: "prey crashed",
  midair: "midair",
  failure: "timeout loss",
  win: "last plane",
};

const state = {
  timer: null,
  nextTimer: null,
  frames: [],
  i: 0,
  curve: [],
  physics: { turn_radius: 0.06, arena: 2, n_planes: 5, dt: 0.05, sense_range: 0.4 },
  running: true,
  flightId: 0,
  lastMemory: null,
  timeoutDirty: false,
  preyDirty: false,
  hiveDirty: false,
  modeDirty: false,
  shareDirty: false,
  gainsDirty: false,
  mode: "hunt",
  share: "hive",
  roster: [],
  lineup: [],
  bursting: false,
  burstTimer: null,
  burstShown: 0,
};

const field = $("field");
const fctx = field.getContext("2d");

function seatColor(i) {
  return PALETTE[i % PALETTE.length];
}

function xy(v) {
  const pad = 28;
  const arena = state.physics.arena || 2;
  return pad + (v / arena) * (field.width - pad * 2);
}

function fieldScale() {
  const arena = state.physics.arena || 2;
  return (field.width - 56) / arena;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function shareMode() {
  const v = $("share")?.value || state.share;
  if (v === "isolated" || v === "blackboard") return v;
  return "hive";
}

function fightMode() {
  return state.mode === "ffa" ? "ffa" : "hunt";
}

function preyCount() {
  const n = Number($("prey-num").value);
  if (!Number.isFinite(n)) return PREY_MIN;
  return clamp(Math.round(n), PREY_MIN, PLANES_MAX - HIVE_MIN);
}

function hiveCount() {
  const n = Number($("hive-num").value);
  if (!Number.isFinite(n)) return 4;
  return clamp(Math.round(n), HIVE_MIN, PLANES_MAX - PREY_MIN);
}

function timeoutSeconds() {
  const n = Number($("timeout-num").value);
  if (!Number.isFinite(n)) return 120;
  return clamp(Math.round(n), TIMEOUT_MIN, TIMEOUT_MAX);
}

function gainValue(id) {
  return clamp(Number($(id).value) / 100, 0, 1);
}

function syncCopy(prey, hive) {
  const p = prey ?? preyCount();
  const h = hive ?? hiveCount();
  const hunt = fightMode() === "hunt";
  const share = shareMode();
  text("prey-read", `${p} prey · one shared prey brain`);
  text("hive-read", `${h} hive · one shared hive brain`);
  text("matchup-read", hunt ? `${p} prey · ${h} hive · ${share}` : `${p + h} drones · ${share}`);
  text(
    "field-hint",
    hunt
      ? "Amber rings are prey. All prey share one brain; hunters share the hive."
      : "Free-for-all. Shared memory still paints traffic, danger, and kill cells."
  );
  const plusOff = p + h >= PLANES_MAX;
  const preyMinusOff = p <= PREY_MIN;
  const hiveMinusOff = h <= HIVE_MIN;
  if ($("prey-plus")) $("prey-plus").classList.toggle("is-limit", plusOff);
  if ($("hive-plus")) $("hive-plus").classList.toggle("is-limit", plusOff);
  if ($("prey-minus")) $("prey-minus").classList.toggle("is-limit", preyMinusOff);
  if ($("hive-minus")) $("hive-minus").classList.toggle("is-limit", hiveMinusOff);
}

function setTeamCounts(prey, hive) {
  let p = clamp(Math.round(Number(prey) || PREY_MIN), PREY_MIN, PLANES_MAX - HIVE_MIN);
  let h = clamp(Math.round(Number(hive) || HIVE_MIN), HIVE_MIN, PLANES_MAX - PREY_MIN);
  while (p + h > PLANES_MAX) {
    if (h > HIVE_MIN) h -= 1;
    else if (p > PREY_MIN) p -= 1;
    else break;
  }
  $("prey-num").value = String(p);
  $("hive-num").value = String(h);
  syncCopy(p, h);
}

function setTimeoutSeconds(seconds) {
  const v = clamp(Math.round(seconds), TIMEOUT_MIN, TIMEOUT_MAX);
  $("timeout").value = String(v);
  $("timeout-num").value = String(v);
  const steps = Math.round(v / (state.physics.dt || TIMEOUT_DT));
  text("timeout-read", `${v} s · ${steps} steps`);
}

function setGain(id, readId, value, suffix) {
  const v = clamp(Number(value), 0, 1);
  $(id).value = String(Math.round(v * 100));
  text(readId, `${v.toFixed(2)} · ${suffix}`);
}

async function pushTimeout() {
  const seconds = timeoutSeconds();
  setTimeoutSeconds(seconds);
  try {
    const body = await academy.call("timeout", { seconds });
    state.timeoutDirty = false;
    applyStatus(body);
    $("status").textContent = `Sortie timeout set to ${seconds}s.`;
  } catch (err) {
    state.timeoutDirty = false;
    $("status").textContent = err.message;
  }
}

const teamQueue = { prey: null, hive: null, timer: null, inflight: false };

function teamPending() {
  return teamQueue.prey != null || teamQueue.hive != null || teamQueue.inflight;
}

function previewLineup() {
  const hunt = fightMode() === "hunt";
  const slots = [];
  for (let i = 0; i < preyCount(); i += 1) slots.push({ brain_id: "prey", role: hunt ? "prey" : "ffa" });
  for (let i = 0; i < hiveCount(); i += 1) slots.push({ brain_id: "hive", role: hunt ? "pack" : "ffa" });
  return slots;
}

function queuePrey(n) {
  const next = clamp(Math.round(Number(n)), PREY_MIN, PLANES_MAX - hiveCount());
  setTeamCounts(next, hiveCount());
  teamQueue.prey = next;
  state.preyDirty = true;
  state.lineup = previewLineup();
  renderHangar();
  scheduleTeamPush();
}

function queueHive(n) {
  const next = clamp(Math.round(Number(n)), HIVE_MIN, PLANES_MAX - preyCount());
  setTeamCounts(preyCount(), next);
  teamQueue.hive = next;
  state.hiveDirty = true;
  state.lineup = previewLineup();
  renderHangar();
  scheduleTeamPush();
}

function scheduleTeamPush() {
  if (teamQueue.timer) clearTimeout(teamQueue.timer);
  teamQueue.timer = setTimeout(flushTeam, 80);
}

async function flushTeam() {
  teamQueue.timer = null;
  if (teamQueue.inflight) {
    scheduleTeamPush();
    return;
  }
  const prey = teamQueue.prey;
  const hive = teamQueue.hive;
  if (prey == null && hive == null) return;
  teamQueue.prey = null;
  teamQueue.hive = null;
  teamQueue.inflight = true;
  try {
    let body = null;
    if (prey != null) body = await academy.call("prey", { n: prey });
    if (hive != null) body = await academy.call("hive", { n: hive });
    state.preyDirty = teamQueue.prey != null;
    state.hiveDirty = teamQueue.hive != null;
    if (body) applyStatus(body);
    $("status").textContent = `${preyCount()} prey · ${hiveCount()} hive.`;
    restartFlights();
  } catch (err) {
    state.preyDirty = false;
    state.hiveDirty = false;
    $("status").textContent = err.message;
  } finally {
    teamQueue.inflight = false;
    if (teamQueue.prey != null || teamQueue.hive != null) scheduleTeamPush();
  }
}

async function pushMode() {
  const mode = $("mode").value === "ffa" ? "ffa" : "hunt";
  state.mode = mode;
  try {
    const body = await academy.call("mode", { mode });
    state.modeDirty = false;
    applyStatus(body);
    $("status").textContent = mode === "hunt" ? "One against the pack." : "Last plane standing.";
    restartFlights();
  } catch (err) {
    state.modeDirty = false;
    $("status").textContent = err.message;
  }
}

async function pushShare() {
  const share = shareMode();
  state.share = share;
  try {
    const body = await academy.call("share", { share });
    state.shareDirty = false;
    applyStatus(body);
    const copy = {
      hive: "Hive on. One prey brain, one hive brain, shared map.",
      blackboard: "Blackboard on. Same two brains, shared map.",
      isolated: "Isolated. Same two brains, radio off.",
    };
    $("status").textContent = copy[share];
    restartFlights();
  } catch (err) {
    state.shareDirty = false;
    $("status").textContent = err.message;
  }
}

async function pushGains() {
  const swarm = gainValue("swarm-gain");
  const memory = gainValue("memory-gain");
  setGain("swarm-gain", "swarm-read", swarm, "flocking + hunt roles mix into yaw");
  setGain("memory-gain", "memory-read", memory, "follow the shared prey scent");
  try {
    const body = await academy.call("gains", { swarm_gain: swarm, memory_gain: memory });
    state.gainsDirty = false;
    applyStatus(body);
  } catch (err) {
    state.gainsDirty = false;
    $("status").textContent = err.message;
  }
}

$("timeout").addEventListener("input", () => {
  state.timeoutDirty = true;
  setTimeoutSeconds(Number($("timeout").value));
});
$("timeout").addEventListener("change", pushTimeout);
$("timeout-num").addEventListener("change", () => {
  state.timeoutDirty = true;
  setTimeoutSeconds(timeoutSeconds());
  pushTimeout();
});
$("prey-num").addEventListener("change", () => {
  queuePrey(preyCount());
});
$("hive-num").addEventListener("change", () => {
  queueHive(hiveCount());
});
$("prey-plus").addEventListener("click", () => {
  if (preyCount() + hiveCount() >= PLANES_MAX) return;
  queuePrey(preyCount() + 1);
});
$("prey-minus").addEventListener("click", () => {
  if (preyCount() <= PREY_MIN) return;
  queuePrey(preyCount() - 1);
});
$("hive-plus").addEventListener("click", () => {
  if (preyCount() + hiveCount() >= PLANES_MAX) return;
  queueHive(hiveCount() + 1);
});
$("hive-minus").addEventListener("click", () => {
  if (hiveCount() <= HIVE_MIN) return;
  queueHive(hiveCount() - 1);
});
$("mode").addEventListener("change", () => {
  state.modeDirty = true;
  state.mode = $("mode").value;
  syncCopy();
  pushMode();
});
$("share").addEventListener("change", () => {
  state.shareDirty = true;
  state.share = shareMode();
  syncCopy();
  pushShare();
});
$("swarm-gain").addEventListener("input", () => {
  state.gainsDirty = true;
  setGain("swarm-gain", "swarm-read", gainValue("swarm-gain"), "flocking + hunt roles mix into yaw");
});
$("swarm-gain").addEventListener("change", pushGains);
$("memory-gain").addEventListener("input", () => {
  state.gainsDirty = true;
  setGain("memory-gain", "memory-read", gainValue("memory-gain"), "follow the shared prey scent");
});
$("memory-gain").addEventListener("change", pushGains);

function pauseFlights() {
  state.running = false;
  state.flightId += 1;
  stopPlay();
  $("pause").textContent = "Resume flights";
}

function resumeFlights() {
  state.running = true;
  state.flightId += 1;
  stopPlay();
  $("pause").textContent = "Pause flights";
  loopSortie();
}

function restartFlights() {
  if (state.running) resumeFlights();
  else {
    state.flightId += 1;
    stopPlay();
    drawEmpty();
  }
}

$("pause").addEventListener("click", () => {
  if (state.running) pauseFlights();
  else resumeFlights();
});

$("wipe-memory").addEventListener("click", async () => {
  try {
    const body = await academy.call("resetMemory");
    applyStatus(body);
    $("status").textContent = "Shared map wiped. Scent, danger, and kill heat are gone.";
    paintMemory(body.memory);
  } catch (err) {
    $("status").textContent = err.message;
  }
});

const wipeTimers = {};

function resetWipeButton(id) {
  const btn = $(id);
  if (!btn) return;
  btn.classList.remove("is-confirm");
  btn.textContent = btn.dataset.label || btn.textContent;
  if (wipeTimers[id]) {
    clearTimeout(wipeTimers[id]);
    wipeTimers[id] = null;
  }
}

function armWipe(id, confirmText, onConfirm) {
  const btn = $(id);
  if (!btn) return;
  if (btn.classList.contains("is-confirm")) {
    resetWipeButton(id);
    onConfirm();
    return;
  }
  ["wipe-prey", "wipe-hive"].forEach((other) => {
    if (other !== id) resetWipeButton(other);
  });
  btn.classList.add("is-confirm");
  btn.textContent = confirmText;
  wipeTimers[id] = setTimeout(() => resetWipeButton(id), 5000);
}

$("wipe-prey").addEventListener("click", () => {
  armWipe("wipe-prey", "Confirm wipe prey brain", async () => {
    try {
      const body = await academy.call("resetBrain", { brain: "prey" });
      applyStatus(body);
      $("status").textContent = "Prey brain wiped. Every prey starts untrained.";
    } catch (err) {
      $("status").textContent = err.message;
    }
  });
});

$("wipe-hive").addEventListener("click", () => {
  armWipe("wipe-hive", "Confirm wipe hive brain", async () => {
    try {
      const body = await academy.call("resetBrain", { brain: "hive" });
      applyStatus(body);
      $("status").textContent = "Hive brain wiped. Every hunter starts untrained.";
    } catch (err) {
      $("status").textContent = err.message;
    }
  });
});

function setBurstControls(on) {
  state.bursting = on;
  $("burst").classList.toggle("is-on", on);
  $("burst").setAttribute("aria-pressed", on ? "true" : "false");
  $("burst").textContent = on ? "Burst training on" : "Burst training off";
}

function burstMilestone(n) {
  return Math.floor(Number(n || 0) / BURST_REPORT) * BURST_REPORT;
}

function startBurstPoll() {
  stopBurstPoll();
  state.burstTimer = setInterval(async () => {
    try {
      const burst = await academy.call("burst");
      const shown = burstMilestone(burst.trained);
      if (shown !== state.burstShown) {
        state.burstShown = shown;
        text("burst-read", shown ? `Burst training · ${shown.toLocaleString()} sorties` : "Burst training · 0 sorties");
      }
      if (burst.running === false) {
        stopBurstPoll();
        setBurstControls(false);
        const snap = await academy.call("state");
        applyStatus(snap);
        $("status").textContent = burst.error ? `Burst stopped: ${burst.error}` : "Burst training stopped.";
        resumeFlights();
      }
    } catch (err) {
      $("status").textContent = err.message;
    }
  }, 400);
}

function stopBurstPoll() {
  if (state.burstTimer) {
    clearInterval(state.burstTimer);
    state.burstTimer = null;
  }
}

$("burst").addEventListener("click", async () => {
  try {
    if (state.bursting) {
      const body = await academy.call("stopBurst");
      applyStatus(body);
      setBurstControls(false);
      stopBurstPoll();
      $("status").textContent = "Stopping burst after the current sortie.";
      return;
    }
    pauseFlights();
    setBurstControls(true);
    state.burstShown = 0;
    text("burst-read", "Burst training · 0 sorties");
    $("status").textContent = "Burst training. Counter updates every 10,000 sorties.";
    try {
      await academy.call("startBurst", { lr: 0.014, seconds: timeoutSeconds() });
    } catch (err) {
      const burst = await academy.call("burst");
      if (burst.running !== true) throw err;
    }
    startBurstPoll();
  } catch (err) {
    setBurstControls(false);
    resumeFlights();
    $("status").textContent = err.message;
  }
});

function stopPlay() {
  if (state.timer != null) {
    clearInterval(state.timer);
    state.timer = null;
  }
  if (state.nextTimer != null) {
    clearTimeout(state.nextTimer);
    state.nextTimer = null;
  }
}

function drawEmpty() {
  drawField({ planes: [], bullets: [], events: [], memory: null, t: 0 });
  $("field-caption").textContent = "No sortie on the field yet.";
}

function drawField(frame) {
  const ctx = fctx;
  const w = field.width;
  ctx.fillStyle = "#081014";
  ctx.fillRect(0, 0, w, field.height);
  if (frame.memory) state.lastMemory = frame.memory;
  paintHeat(ctx, frame.memory || state.lastMemory);
  ctx.strokeStyle = "rgba(231,239,230,0.08)";
  ctx.lineWidth = 1;
  const arena = state.physics.arena || 2;
  for (let i = 1; i < 8; i += 1) {
    const u = (i / 8) * arena;
    ctx.beginPath();
    ctx.moveTo(xy(u), xy(0));
    ctx.lineTo(xy(u), xy(arena));
    ctx.moveTo(xy(0), xy(u));
    ctx.lineTo(xy(arena), xy(u));
    ctx.stroke();
  }
  ctx.strokeStyle = "rgba(230,195,106,0.35)";
  ctx.strokeRect(xy(0), xy(0), xy(arena) - xy(0), xy(arena) - xy(0));
  const sense = state.physics.sense_range || 0.4;
  const planes = frame.planes || [];
  const livingPrey = planes.filter((p) => p.role === "prey" && p.alive);
  for (const prey of livingPrey) {
    ctx.beginPath();
    ctx.arc(xy(prey.x), xy(prey.y), sense * fieldScale(), 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(230,195,106,0.18)";
    ctx.setLineDash([4, 6]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  for (const link of frame.links || []) {
    ctx.beginPath();
    ctx.moveTo(xy(link.x0), xy(link.y0));
    ctx.lineTo(xy(link.x1), xy(link.y1));
    ctx.strokeStyle = "rgba(61,184,197,0.35)";
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }
  planes.forEach((p, i) => drawPlane(ctx, p, seatColor(p.seat ?? i)));
  for (const b of frame.bullets || []) {
    ctx.fillStyle = "#e6c36a";
    ctx.beginPath();
    ctx.arc(xy(b.x), xy(b.y), 3.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(230,195,106,0.7)";
    ctx.beginPath();
    ctx.moveTo(xy(b.x), xy(b.y));
    ctx.lineTo(xy(b.x + 0.03 * Math.cos(b.heading)), xy(b.y + 0.03 * Math.sin(b.heading)));
    ctx.stroke();
  }
}

function paintHeat(ctx, memory) {
  const layers = memory?.layers;
  if (!layers) return;
  const grid = memory.grid || layers.prey?.length || 64;
  const cell = (field.width - 56) / grid;
  const origin = 28;
  for (let j = 0; j < grid; j += 1) {
    for (let i = 0; i < grid; i += 1) {
      const prey = layers.prey?.[j]?.[i] || 0;
      const kill = layers.kill?.[j]?.[i] || 0;
      const danger = layers.danger?.[j]?.[i] || 0;
      const traffic = layers.traffic?.[j]?.[i] || 0;
      const a = Math.min(1, prey * 0.9 + kill * 0.7 + danger * 0.55 + traffic * 0.35);
      if (a < 0.04) continue;
      const r = Math.min(255, 230 * prey + 232 * danger);
      const g = Math.min(255, 195 * prey + 184 * kill + 206 * traffic);
      const b = Math.min(255, 106 * prey + 197 * kill + 76 * danger + 138 * traffic);
      ctx.fillStyle = `rgba(${r | 0},${g | 0},${b | 0},${0.12 + 0.42 * a})`;
      ctx.fillRect(origin + i * cell, origin + j * cell, cell + 0.4, cell + 0.4);
    }
  }
}

function drawPlane(ctx, p, color) {
  if (!p) return;
  const x = xy(p.x);
  const y = xy(p.y);
  const r = state.physics.turn_radius || 0.06;
  if (p.alive) {
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.22;
    ctx.lineWidth = 1;
    const left = p.heading + Math.PI / 2;
    const right = p.heading - Math.PI / 2;
    for (const side of [left, right]) {
      ctx.beginPath();
      ctx.arc(xy(p.x + r * Math.cos(side)), xy(p.y + r * Math.sin(side)), r * fieldScale(), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  if (p.role === "prey" && p.alive) {
    ctx.beginPath();
    ctx.arc(x, y, 18, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(230,195,106,0.7)";
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(p.heading);
  ctx.fillStyle = p.alive ? color : "rgba(138,160,154,0.35)";
  ctx.beginPath();
  ctx.moveTo(14, 0);
  ctx.lineTo(-10, 7);
  ctx.lineTo(-6, 0);
  ctx.lineTo(-10, -7);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  const role = p.swarm_role && p.swarm_role !== "prey" ? p.swarm_role.replace("_", " ") : "";
  const tag = [p.brain_label || p.brain_id, role].filter(Boolean).join(" · ");
  if (tag) {
    ctx.fillStyle = "rgba(231,239,230,0.72)";
    ctx.font = "10px ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.fillText(tag, x, y + 18);
  }
}

function paintMemory(memory) {
  const canvas = $("memory-map");
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#081014";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const energy = memory?.energy || {};
  text("mem-prey", (energy.prey ?? 0).toFixed(1));
  text("mem-kill", (energy.kill ?? 0).toFixed(1));
  text("mem-danger", (energy.danger ?? 0).toFixed(1));
  text("mem-traffic", (energy.traffic ?? 0).toFixed(1));
  const layers = memory?.layers;
  if (!layers) {
    ctx.fillStyle = "#8aa09a";
    ctx.font = "13px ui-monospace, monospace";
    ctx.fillText("Map off in isolated mode.", 24, 36);
    return;
  }
  const grid = memory.grid || 64;
  const cw = canvas.width / grid;
  const ch = canvas.height / grid;
  for (let j = 0; j < grid; j += 1) {
    for (let i = 0; i < grid; i += 1) {
      const prey = layers.prey?.[j]?.[i] || 0;
      const kill = layers.kill?.[j]?.[i] || 0;
      const danger = layers.danger?.[j]?.[i] || 0;
      const traffic = layers.traffic?.[j]?.[i] || 0;
      const r = Math.min(255, 40 + 210 * prey + 180 * danger);
      const g = Math.min(255, 40 + 160 * prey + 180 * kill + 160 * traffic);
      const b = Math.min(255, 40 + 80 * prey + 180 * kill + 90 * danger);
      const a = Math.min(1, 0.15 + prey + kill + danger + traffic);
      ctx.fillStyle = `rgba(${r | 0},${g | 0},${b | 0},${a})`;
      ctx.fillRect(i * cw, j * ch, cw + 0.4, ch + 0.4);
    }
  }
  const prey = memory.prey;
  if (prey && prey.mass > 0.05) {
    ctx.beginPath();
    ctx.arc(prey.x * canvas.width, prey.y * canvas.height, 8 + 14 * Math.min(1, prey.mass), 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(230,195,106,0.9)";
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

function paintChart(curve) {
  const canvas = $("chart");
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#081014";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (curve.length < 2) return;
  const lives = curve.map((r) => r.steps);
  const hunts = curve.map((r) => (r.outcome && r.winner !== "prey" && r.mode !== "ffa" ? 1 : r.outcome === "win" ? 1 : 0));
  const maxL = Math.max(...lives, 1);
  const line = (series, color, maxV) => {
    ctx.beginPath();
    series.forEach((v, i) => {
      const x = 10 + (i / Math.max(series.length - 1, 1)) * (canvas.width - 20);
      const y = canvas.height - 12 - (v / maxV) * (canvas.height - 28);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
  };
  line(lives, "#e6c36a", maxL);
  const window = 8;
  const rate = hunts.map((_, i) => {
    const slice = hunts.slice(Math.max(0, i - window + 1), i + 1);
    return slice.reduce((s, v) => s + v, 0) / slice.length;
  });
  line(
    rate.map((v) => v * maxL),
    "#3db8c5",
    maxL
  );
  ctx.fillStyle = "#8aa09a";
  ctx.font = "11px ui-monospace, monospace";
  ctx.fillText("life (amber) · pack finish rate (cyan)", 12, 14);
}

function renderHangar() {
  const host = $("hangar");
  if (!host) return;
  const lineup = state.lineup || [];
  const table = document.createElement("table");
  table.className = "stat-table";
  table.innerHTML = `<thead><tr><th>Seat</th><th>Brain</th><th>Role</th><th class="num">Kills</th><th class="num">Walls</th><th class="num">Updates</th><th>Fav</th></tr></thead>`;
  const tbody = document.createElement("tbody");
  lineup.forEach((slot, i) => {
    const brain = state.roster.find((row) => row.id === slot.brain_id) || {};
    const role = slot.role === "prey" || (fightMode() === "hunt" && slot.brain_id === "prey") ? "prey" : fightMode() === "hunt" ? "hunter" : "ffa";
    const tr = document.createElement("tr");
    const seat = document.createElement("td");
    const label = document.createElement("span");
    label.className = role === "prey" ? "seat is-prey" : "seat";
    const swatch = document.createElement("i");
    swatch.className = "swatch";
    swatch.style.background = seatColor(i);
    label.append(swatch, document.createTextNode(`P${i + 1}`));
    seat.append(label);
    const roleName = role === "prey" ? "prey" : role === "hunter" ? "hunter" : "ffa";
    tr.append(
      seat,
      cell(brain.label || slot.brain_id),
      cell(roleName),
      cell(brain.kills ?? 0, "num"),
      cell(brain.walls ?? 0, "num"),
      cell(brain.updates ?? 0, "num"),
      cell(brain.favorite || "—")
    );
    tbody.append(tr);
  });
  table.append(tbody);
  host.replaceChildren(table);
}

function cell(value, className) {
  const td = document.createElement("td");
  if (className) td.className = className;
  td.textContent = value == null ? "—" : String(value);
  return td;
}

function renderWinStrip(score) {
  const host = $("win-strip");
  if (!host) return;
  host.replaceChildren();
  const chip = document.createElement("span");
  chip.className = "win-chip pack";
  if (fightMode() === "hunt") {
    chip.textContent = `escapes ${score.escapes || 0} · hunts ${score.hunts || 0} · clean ${score.clean_hunts || 0} · wipes ${score.pack_wipes || 0} · pack lost ${score.pack_losses || 0}`;
  } else {
    chip.textContent = `timeout losses ${score.draws || 0} · midairs ${score.midairs || 0}`;
  }
  host.append(chip);
}

function applyStatus(body) {
  state.roster = body.roster || [];
  state.lineup = body.lineup || [];
  state.mode = body.mode || state.mode;
  state.share = body.share || state.share;
  if (!state.modeDirty && $("mode")) $("mode").value = state.mode;
  if (!state.shareDirty && $("share")) $("share").value = state.share;
  const s = body.score || {};
  text("episode-read", String(s.episodes || 0));
  text("winner-read", OUTCOMES[s.last_outcome] || s.last_winner || "—");
  text("hunt-read", fightMode() === "hunt" ? `${s.hunts || 0} · ${s.escapes || 0}` : `${s.draws || 0} · ${s.midairs || 0}`);
  $("empty-badge").textContent = body.empty ? "brains empty" : "learning in progress";
  $("empty-badge").classList.toggle("is-trained", !body.empty);
  renderWinStrip(s);
  renderHangar();
  if (body.physics) {
    state.physics = body.physics;
    if (!state.timeoutDirty && body.physics.timeout != null) setTimeoutSeconds(body.physics.timeout);
    if (!state.preyDirty && !state.hiveDirty && !teamPending() && (body.physics.n_prey != null || body.physics.n_hive != null)) {
      setTeamCounts(body.physics.n_prey ?? preyCount(), body.physics.n_hive ?? hiveCount());
    } else {
      syncCopy();
    }
    if (!state.gainsDirty) {
      if (body.physics.swarm_gain != null) setGain("swarm-gain", "swarm-read", body.physics.swarm_gain, "flocking + hunt roles mix into yaw");
      if (body.physics.memory_gain != null) setGain("memory-gain", "memory-read", body.physics.memory_gain, "follow the shared prey scent");
    }
  } else {
    syncCopy();
  }
  paintMemory(body.memory);
  if (body.curve) {
    state.curve = body.curve;
    paintChart(body.curve);
    if (!body.curve.length) {
      text(
        "lesson-note",
        shareMode() === "isolated"
          ? "Two brains, no radio. Each team still shares its own net."
          : shareMode() === "blackboard"
            ? "Two brains, public map. Scent is the only extra they share."
            : "Two brains. Every prey trains prey; every hunter trains the hive."
      );
    }
  }
}

function playTrace(frames, summary, onDone) {
  stopPlay();
  state.frames = frames || [];
  state.i = 0;
  if (!state.frames.length) {
    if (onDone) onDone();
    return;
  }
  const tick = () => {
    const frame = state.frames[state.i];
    drawField(frame);
    if (frame.memory) paintMemory(frame.memory);
    const ev = frame.events[frame.events.length - 1] || "in the merge";
    $("field-caption").textContent = `t = ${frame.t.toFixed(2)}s · ${String(ev).replaceAll("_", " ")} · ${state.i + 1}/${state.frames.length}`;
    state.i += 1;
    if (state.i >= state.frames.length) {
      stopPlay();
      if (summary?.events?.length) {
        $("field-caption").textContent = `Ended: ${summary.events.join(", ").replaceAll("_", " ")} — next sortie starting`;
      }
      if (onDone) state.nextTimer = setTimeout(onDone, 700);
    }
  };
  tick();
  state.timer = setInterval(tick, 40);
}

async function loopSortie() {
  if (!state.running || state.bursting) return;
  const id = state.flightId;
  try {
    const body = await academy.call("play", { learn: true, trace: true });
    if (id !== state.flightId || !state.running || state.bursting) return;
    if (body.aborted) {
      if (state.running) loopSortie();
      return;
    }
    applyStatus(body);
    playTrace(body.trace, body.summary, () => {
      if (id !== state.flightId || !state.running) return;
      loopSortie();
    });
  } catch (err) {
    if (id !== state.flightId) return;
    $("status").textContent = err.message;
    if (state.running) state.nextTimer = setTimeout(loopSortie, 1200);
  }
}

async function boot() {
  const snap = await academy.boot();
  applyStatus(snap);
  drawEmpty();
  if (snap.burst?.running) {
    setBurstControls(true);
    state.burstShown = burstMilestone(snap.burst.trained);
    text("burst-read", state.burstShown ? `Burst training · ${state.burstShown.toLocaleString()} sorties` : "Burst training · 0 sorties");
    pauseFlights();
    startBurstPoll();
    return;
  }
  resumeFlights();
}

boot();
