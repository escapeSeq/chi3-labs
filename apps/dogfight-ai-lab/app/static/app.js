const $ = (id) => document.getElementById(id);
const state = {
  timer: null,
  nextTimer: null,
  frames: [],
  i: 0,
  curve: [],
  physics: { turn_radius: 0.06, arena: 1, n_planes: 2 },
  running: true,
  loopId: 0,
  busy: false,
  timeoutDirty: false,
  planesDirty: false,
};

const field = $("field");
const fctx = field.getContext("2d");

const BURST_MIN = 100;
const BURST_MAX = 1_000_000;
const ACTION_NAMES = ["left", "straight", "right", "left+fire", "straight+fire", "right+fire"];
const OBS_NAMES = ["fwd", "right", "range", "rel h", "x", "y", "cos", "sin", "wall", "gun"];

function pct(value, digits = 1) {
  if (value == null || Number.isNaN(Number(value))) return "—";
  return `${(Number(value) * 100).toFixed(digits)}%`;
}

function num(value, digits = 2) {
  if (value == null || Number.isNaN(Number(value))) return "—";
  return Number(value).toFixed(digits);
}

function actionMix(counts) {
  if (!counts || !counts.length) return "—";
  const total = counts.reduce((sum, n) => sum + n, 0);
  if (!total) return "—";
  return ACTION_NAMES.map((name, i) => `${name} ${((counts[i] / total) * 100).toFixed(0)}%`).join(" · ");
}

function burstSize() {
  const n = Number($("episodes-num").value);
  if (!Number.isFinite(n)) return 100;
  return Math.min(BURST_MAX, Math.max(BURST_MIN, Math.round(n)));
}

function burstToSlider(n) {
  const clamped = Math.min(BURST_MAX, Math.max(BURST_MIN, n));
  const t = Math.log(clamped / BURST_MIN) / Math.log(BURST_MAX / BURST_MIN);
  return String(Math.round(t * 1000));
}

function sliderToBurst(raw) {
  const t = Math.min(1, Math.max(0, Number(raw) / 1000));
  if (t <= 0) return BURST_MIN;
  if (t >= 1) return BURST_MAX;
  const n = BURST_MIN * (BURST_MAX / BURST_MIN) ** t;
  const exp = Math.floor(Math.log10(n));
  const step = 10 ** Math.max(exp - 1, 0);
  return Math.min(BURST_MAX, Math.max(BURST_MIN, Math.round(n / step) * step));
}

function setBurst(n) {
  const v = String(Math.min(BURST_MAX, Math.max(BURST_MIN, Math.round(n))));
  $("episodes").value = burstToSlider(Number(v));
  $("episodes-num").value = v;
}

$("episodes").addEventListener("input", () => {
  setBurst(sliderToBurst($("episodes").value));
});

$("episodes-num").addEventListener("change", () => {
  setBurst(burstSize());
});

const TIMEOUT_MIN = 2;
const TIMEOUT_MAX = 60;
const TIMEOUT_DT = 0.05;

function timeoutSeconds() {
  const n = Number($("timeout-num").value);
  if (!Number.isFinite(n)) return 12;
  return Math.min(TIMEOUT_MAX, Math.max(TIMEOUT_MIN, Math.round(n)));
}

function setTimeoutSeconds(seconds) {
  const v = Math.min(TIMEOUT_MAX, Math.max(TIMEOUT_MIN, Math.round(seconds)));
  $("timeout").value = String(v);
  $("timeout-num").value = String(v);
  const steps = Math.round(v / (state.physics.dt || TIMEOUT_DT));
  $("timeout-read").textContent = `${v} s · ${steps} steps`;
}

async function pushTimeout() {
  const seconds = timeoutSeconds();
  setTimeoutSeconds(seconds);
  try {
    const res = await fetch("/api/timeout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seconds }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.detail || "Timeout update failed");
    state.timeoutDirty = false;
    applyStatus(body);
    $("status").textContent = `Sortie timeout set to ${seconds}s. Next fight uses the new limit.`;
  } catch (err) {
    state.timeoutDirty = false;
    $("status").textContent = err.message;
  }
}

$("timeout").addEventListener("input", () => {
  state.timeoutDirty = true;
  setTimeoutSeconds(Number($("timeout").value));
});

$("timeout").addEventListener("change", () => {
  pushTimeout();
});

$("timeout-num").addEventListener("change", () => {
  state.timeoutDirty = true;
  setTimeoutSeconds(timeoutSeconds());
  pushTimeout();
});

const PLANES_MIN = 2;
const PLANES_MAX = 9;

function matchup(n) {
  const count = Math.min(PLANES_MAX, Math.max(PLANES_MIN, Math.round(Number(n) || PLANES_MIN)));
  const red = Math.ceil(count / 2);
  const blue = Math.floor(count / 2);
  return { n: count, red, blue, label: `${red}v${blue}` };
}

function planeCount() {
  return matchup($("planes-num").value).n;
}

function setPlaneCount(n) {
  const m = matchup(n);
  $("planes").value = String(m.n);
  $("planes-num").value = String(m.n);
  $("planes-read").textContent = `${m.n} planes · ${m.label}`;
  $("matchup-read").textContent = m.label;
  $("field-hint").textContent =
    m.n === 2
      ? "A 2-D square. Out of bounds is a crash. Mid-air contact is a crash."
      : `A 2-D square. ${m.label} — each team shares a brain. Out of bounds is a crash. Mid-air contact is a crash.`;
}

async function pushPlanes() {
  const n = planeCount();
  setPlaneCount(n);
  try {
    const res = await fetch("/api/planes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ n }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.detail || "Plane count update failed");
    state.planesDirty = false;
    applyStatus(body);
    $("status").textContent = `Next fight is ${matchup(n).label} (${n} planes).`;
  } catch (err) {
    state.planesDirty = false;
    $("status").textContent = err.message;
  }
}

$("planes").addEventListener("input", () => {
  state.planesDirty = true;
  setPlaneCount(Number($("planes").value));
});

$("planes").addEventListener("change", () => {
  pushPlanes();
});

$("planes-num").addEventListener("change", () => {
  state.planesDirty = true;
  setPlaneCount(planeCount());
  pushPlanes();
});

$("pause").addEventListener("click", () => {
  if (state.running) {
    pauseFlights();
  } else {
    resumeFlights();
  }
});

$("lesson").addEventListener("click", async () => {
  $("lesson").disabled = true;
  setBurst(burstSize());
  pauseFlights();
  $("status").textContent = `Fast-forwarding ${burstSize()} sorties…`;
  try {
    const res = await fetch("/api/lesson", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ episodes: burstSize(), lr: 0.018, seconds: timeoutSeconds() }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.detail || "Lesson failed");
    applyStatus(body);
    $("status").textContent = `${body.lesson} Continuous flights resume.`;
    $("lesson-note").textContent = body.lesson;
    resumeFlights();
  } catch (err) {
    $("status").textContent = err.message;
    resumeFlights();
  } finally {
    $("lesson").disabled = false;
  }
});

$("reset-stats").addEventListener("click", async () => {
  pauseFlights();
  try {
    const res = await fetch("/api/reset-stats", { method: "POST" });
    const body = await res.json();
    if (!res.ok) throw new Error(body.detail || "Reset failed");
    applyStatus(body);
    paintChart([]);
    $("status").textContent = "Kills, walls, draws, and the learning chart are cleared. Brains kept. Resume to keep flying.";
  } catch (err) {
    $("status").textContent = err.message;
  }
});

document.querySelectorAll("[data-brain-tab]").forEach((button) => {
  button.addEventListener("click", () => setBrainTab(button.dataset.brainTab));
});

function setBrainTab(tab) {
  document.querySelectorAll("[data-brain-tab]").forEach((button) => {
    button.classList.toggle("is-on", button.dataset.brainTab === tab);
  });
  document.querySelectorAll(".brain-pane").forEach((pane) => {
    pane.classList.toggle("is-on", pane.dataset.pane === tab);
  });
}

$("forget").addEventListener("click", async () => {
  pauseFlights();
  const body = await (await fetch("/api/reset", { method: "POST" })).json();
  applyStatus(body);
  drawEmpty();
  $("status").textContent = "Weights scrambled on /data. Continuous flights restart from empty nets.";
  resumeFlights();
});

function applyStatus(body) {
  const s = body.score;
  const t = body.training || {};
  const brains = body.brains || {};
  if (body.action_names) ACTION_NAMES.splice(0, ACTION_NAMES.length, ...body.action_names);
  $("red-kills").textContent = s.red_kills;
  $("blue-kills").textContent = s.blue_kills;
  $("red-extra").textContent = `${s.red_walls} walls`;
  $("blue-extra").textContent = `${s.blue_walls} walls`;
  $("red-brain-line").textContent = `${brains.red?.shape?.hidden ?? 24} hidden · ${brains.red?.updates ?? 0} updates`;
  $("blue-brain-line").textContent = `${brains.blue?.shape?.hidden ?? 24} hidden · ${brains.blue?.updates ?? 0} updates`;
  $("episode-read").textContent = `Sortie ${s.episodes}`;
  $("empty-badge").textContent = body.empty ? "both models empty" : "learning in progress";
  $("empty-badge").classList.toggle("is-trained", !body.empty);
  if (body.physics) {
    state.physics = body.physics;
    if (!state.timeoutDirty && body.physics.timeout != null) {
      setTimeoutSeconds(body.physics.timeout);
    }
    if (!state.planesDirty && body.physics.n_planes != null) {
      setPlaneCount(body.physics.n_planes);
    }
  }
  fillBrain("red", brains.red, t.last_actions?.red);
  fillBrain("blue", brains.blue, t.last_actions?.blue);
  if (body.curve) {
    state.curve = body.curve;
    paintChart(body.curve);
    if (!body.curve.length) {
      $("lesson-note").textContent =
        "A kill requires pointing the nose. A crash is usually the wall — the first thing an empty net learns is “don’t fly off the plot.”";
    }
  }
}

function fillBrain(side, brain, lastActions) {
  if (!brain) return;
  const prefix = side === "red" ? "rb" : "bb";
  const shape = brain.shape || {};
  $(`${side}-arch`).textContent = `${shape.obs ?? 10} obs → ${shape.hidden ?? 24} hidden ReLU → ${shape.actions ?? 6} actions`;
  $(`${prefix}-upd`).textContent = String(brain.updates ?? 0);
  $(`${prefix}-l2`).textContent = `${num(brain.weights?.l2, 2)} / ${brain.weights?.count ?? "—"}`;
  $(`${prefix}-rms`).textContent = `${num(brain.weights?.w1_rms)} (${num(brain.weights?.w1_growth)}×) · ${num(brain.weights?.w2_rms)} (${num(brain.weights?.w2_growth)}×)`;
  $(`${prefix}-base`).textContent = num(brain.baseline);
  $(`${prefix}-ent`).textContent = `${num(brain.probe?.entropy)} / ${pct(brain.probe?.max_prob)}`;
  $(`${prefix}-hid`).textContent = `${pct(brain.probe?.hidden_active)} on · ${brain.probe?.hidden_dead ?? 0} dead`;
  $(`${prefix}-fav`).textContent = brain.favorite || "—";
  paintActions(`${side}-acts`, brain.probe?.mean_probs || [], side);
  $(`${side}-last`).textContent = `Last sortie mix: ${actionMix(lastActions)}`;
  paintBrainNet(`${side}-net`, brain, side);
  paintWeights(`${side}-w1`, brain.w1, side);
  paintWeights(`${side}-weights`, brain.w2, side);
}

function paintActions(id, probs, side) {
  const host = $(id);
  host.replaceChildren();
  ACTION_NAMES.forEach((name, i) => {
    const p = Number(probs[i] || 0);
    const row = document.createElement("div");
    row.className = "act-row";
    const label = document.createElement("span");
    label.textContent = name;
    const track = document.createElement("div");
    track.className = `act-track is-${side}`;
    const fill = document.createElement("i");
    fill.style.width = `${Math.max(0, Math.min(1, p)) * 100}%`;
    track.append(fill);
    const read = document.createElement("span");
    read.textContent = pct(p, 0);
    row.append(label, track, read);
    host.append(row);
  });
}

function paintBrainNet(id, brain, side) {
  const canvas = $(id);
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.fillStyle = "#081014";
  ctx.fillRect(0, 0, w, h);
  const w1 = brain.w1;
  const w2 = brain.w2;
  if (!w1?.length || !w2?.length) return;
  const plus = side === "red" ? [232, 93, 76] : [61, 184, 197];
  const minus = [138, 160, 154];
  const nIn = w1[0].length;
  const nHid = w1.length;
  const nOut = w2.length;
  const labels = brain.obs_names?.length === nIn ? brain.obs_names : OBS_NAMES;
  const column = (count, x) =>
    Array.from({ length: count }, (_, i) => ({
      x,
      y: 26 + ((h - 44) * (count === 1 ? 0.5 : i / (count - 1))),
    }));
  const ins = column(nIn, 62);
  const hid = column(nHid, w * 0.5);
  const outs = column(nOut, w - 78);
  const max1 = Math.max(...w1.flat().map((v) => Math.abs(v)), 1e-6);
  const max2 = Math.max(...w2.flat().map((v) => Math.abs(v)), 1e-6);
  const strokeEdge = (a, b, value, maxA) => {
    const mag = Math.abs(value) / maxA;
    if (mag < 0.1) return;
    const [r, g, bl] = value >= 0 ? plus : minus;
    ctx.strokeStyle = `rgba(${r},${g},${bl},${0.08 + 0.7 * mag})`;
    ctx.lineWidth = 0.35 + 2.4 * mag;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  };
  w1.forEach((row, hi) => {
    row.forEach((value, ii) => strokeEdge(ins[ii], hid[hi], value, max1));
  });
  w2.forEach((row, ai) => {
    row.forEach((value, hi) => strokeEdge(hid[hi], outs[ai], value, max2));
  });
  const hidden = brain.hidden_mean || [];
  const maxH = Math.max(...hidden.map(Math.abs), 0.2);
  hid.forEach((p, i) => {
    const lit = Math.min(1, Math.abs(hidden[i] || 0) / maxH);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4.2, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${plus[0]},${plus[1]},${plus[2]},${0.2 + 0.8 * lit})`;
    ctx.fill();
    ctx.strokeStyle = "rgba(231,239,230,0.25)";
    ctx.lineWidth = 1;
    ctx.stroke();
  });
  ctx.font = "11px ui-monospace, monospace";
  ctx.textBaseline = "middle";
  ins.forEach((p, i) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5.2, 0, Math.PI * 2);
    ctx.fillStyle = "#1b2a2e";
    ctx.fill();
    ctx.strokeStyle = "rgba(230,195,106,0.55)";
    ctx.stroke();
    ctx.fillStyle = "#8aa09a";
    ctx.textAlign = "right";
    ctx.fillText(labels[i] || String(i), p.x - 10, p.y);
  });
  const probs = brain.probe?.mean_probs || [];
  outs.forEach((p, i) => {
    const glow = Math.max(0, Math.min(1, Number(probs[i] || 0)));
    ctx.beginPath();
    ctx.arc(p.x, p.y, 6 + 5 * glow, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${plus[0]},${plus[1]},${plus[2]},${0.25 + 0.75 * glow})`;
    ctx.fill();
    ctx.strokeStyle = "rgba(231,239,230,0.4)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = "#e7efe6";
    ctx.textAlign = "left";
    ctx.fillText(ACTION_NAMES[i] || String(i), p.x + 12, p.y);
  });
}

function paintWeights(id, rows, side) {
  const canvas = $(id);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#081014";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!rows || !rows.length || !rows[0]?.length) return;
  const plus = side === "red" ? [232, 93, 76] : [61, 184, 197];
  const minus = [138, 160, 154];
  const maxA = Math.max(...rows.flat().map((v) => Math.abs(v)), 1e-6);
  const cw = canvas.width / rows[0].length;
  const ch = canvas.height / rows.length;
  rows.forEach((row, y) => {
    row.forEach((value, x) => {
      const a = Math.abs(value) / maxA;
      const [r, g, b] = value >= 0 ? plus : minus;
      ctx.fillStyle = `rgba(${r},${g},${b},${0.12 + 0.88 * a})`;
      ctx.fillRect(x * cw + 0.4, y * ch + 0.4, Math.max(cw - 0.8, 1), Math.max(ch - 0.8, 1));
    });
  });
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
    const ev = frame.events[frame.events.length - 1] || "in the merge";
    $("field-caption").textContent = `t = ${frame.t.toFixed(2)}s · ${ev.replaceAll("_", " ")} · ${state.i + 1}/${state.frames.length}`;
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

function setPauseLabel() {
  $("pause").textContent = state.running ? "Pause flights" : "Resume flights";
}

function pauseFlights() {
  state.running = false;
  state.loopId += 1;
  state.busy = false;
  stopPlay();
  setPauseLabel();
  $("status").textContent = "Flights paused. Resume to keep the loop going.";
}

function resumeFlights() {
  state.running = true;
  state.loopId += 1;
  state.busy = false;
  setPauseLabel();
  $("status").textContent = "Continuous flights. Each sortie learns, then the next one starts.";
  flyNext(state.loopId);
}

async function flyNext(loopId) {
  if (!state.running || loopId !== state.loopId || state.busy) return;
  state.busy = true;
  try {
    const res = await fetch("/api/sortie", { method: "POST" });
    const body = await res.json();
    if (!res.ok) throw new Error(body.detail || "Sortie failed");
    if (!state.running || loopId !== state.loopId) {
      state.busy = false;
      return;
    }
    applyStatus(body);
    const events = body.summary?.events || [];
    $("status").textContent = events.length
      ? `Sortie ${body.score.episodes} ended (${events.join(", ").replaceAll("_", " ")}). Restarting.`
      : `Sortie ${body.score.episodes} in the air.`;
    playTrace(body.trace, body.summary, () => {
      state.busy = false;
      flyNext(loopId);
    });
    return;
  } catch (err) {
    $("status").textContent = err.message;
  }
  state.busy = false;
}

function xy(v) {
  const pad = 28;
  return pad + v * (field.width - pad * 2);
}

function drawEmpty() {
  const m = matchup($("planes-num")?.value || state.physics.n_planes || PLANES_MIN);
  const planes = [];
  for (let i = 0; i < m.red; i += 1) {
    planes.push({
      name: i === 0 ? "red" : `red${i + 1}`,
      team: "red",
      x: 0.2,
      y: m.red === 1 ? 0.22 : (i + 1) / (m.red + 1),
      heading: 0.4,
      alive: true,
    });
  }
  for (let i = 0; i < m.blue; i += 1) {
    planes.push({
      name: i === 0 ? "blue" : `blue${i + 1}`,
      team: "blue",
      x: 0.8,
      y: m.blue === 1 ? 0.78 : (i + 1) / (m.blue + 1),
      heading: Math.PI + 0.4,
      alive: true,
    });
  }
  drawField({
    red: planes.find((p) => p.team === "red"),
    blue: planes.find((p) => p.team === "blue"),
    planes,
    bullets: [],
    events: [],
    t: 0,
  });
}

function teamColor(team, idx) {
  const base = team === "blue" ? [61, 184, 197] : [232, 93, 76];
  const shade = 1 - 0.1 * (idx % 5);
  return `rgb(${base.map((c) => Math.round(c * shade)).join(",")})`;
}

function drawField(frame) {
  const ctx = fctx;
  const w = field.width;
  const h = field.height;
  ctx.fillStyle = "#081014";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(231,239,230,0.08)";
  ctx.lineWidth = 1;
  for (let i = 1; i < 8; i += 1) {
    ctx.beginPath();
    ctx.moveTo(xy(i / 8), xy(0));
    ctx.lineTo(xy(i / 8), xy(1));
    ctx.moveTo(xy(0), xy(i / 8));
    ctx.lineTo(xy(1), xy(i / 8));
    ctx.stroke();
  }
  ctx.strokeStyle = "rgba(230,195,106,0.35)";
  ctx.strokeRect(xy(0), xy(0), xy(1) - xy(0), xy(1) - xy(0));
  const planes = frame.planes?.length ? frame.planes : [frame.red, frame.blue].filter(Boolean);
  const teamIndex = { red: 0, blue: 0 };
  for (const p of planes) {
    const team = p.team || (String(p.name || "").startsWith("blue") ? "blue" : "red");
    const idx = teamIndex[team] || 0;
    teamIndex[team] = idx + 1;
    drawPlane(ctx, p, teamColor(team, idx));
  }
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

function drawPlane(ctx, p, color) {
  if (!p) return;
  const x = xy(p.x);
  const y = xy(p.y);
  const r = state.physics.turn_radius || 0.06;
  if (p.alive) {
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.28;
    ctx.lineWidth = 1;
    const left = p.heading + Math.PI / 2;
    const right = p.heading - Math.PI / 2;
    for (const side of [left, right]) {
      ctx.beginPath();
      ctx.arc(xy(p.x + r * Math.cos(side)), xy(p.y + r * Math.sin(side)), r * (field.width - 56), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(xy(p.x + 0.22 * Math.cos(p.heading)), xy(p.y + 0.22 * Math.sin(p.heading)));
    ctx.strokeStyle = "rgba(230,195,106,0.35)";
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
}

function paintChart(curve) {
  const canvas = $("chart");
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#081014";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (curve.length < 2) return;
  const lives = curve.map((r) => r.steps);
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
  const rets = curve.map((r) => (r.red.return + r.blue.return) / 2);
  const maxR = Math.max(...rets.map(Math.abs), 0.2);
  line(rets.map((v) => v + maxR), "#3db8c5", 2 * maxR);
  ctx.fillStyle = "#8aa09a";
  ctx.font = "11px ui-monospace, monospace";
  ctx.fillText("life (amber) · mean return (cyan, shifted)", 12, 14);
}

async function boot() {
  const snap = await (await fetch("/api/state")).json();
  applyStatus(snap);
  setBurst(burstSize());
  if (snap.physics?.timeout != null) setTimeoutSeconds(snap.physics.timeout);
  if (snap.physics?.n_planes != null) setPlaneCount(snap.physics.n_planes);
  drawEmpty();
  if (snap.stored && !snap.empty) {
    $("status").textContent = `Restored brains from ${snap.data_dir}. Continuous flights resume.`;
  }
  resumeFlights();
}

boot();
