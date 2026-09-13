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
  rosterDirty: false,
  roster: [],
  lineup: [],
  brains: {},
  training: {},
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

function setPlaneCount(n, teams) {
  const m = matchup(n);
  if (teams && teams.red != null && teams.blue != null) {
    m.red = Number(teams.red);
    m.blue = Number(teams.blue);
    m.label = `${m.red}v${m.blue}`;
  }
  $("planes").value = String(m.n);
  $("planes-num").value = String(m.n);
  $("planes-read").textContent = `${m.n} planes · ${m.label}`;
  $("matchup-read").textContent = m.label;
  $("field-hint").textContent =
    m.n === 2
      ? "A 2-D square. Out of bounds is a crash. Mid-air contact is a crash. Assign brains in the lineup."
      : `A 2-D square. ${m.label} — assign a named brain to each seat. Out of bounds is a crash.`;
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

function rosterList() {
  return state.roster?.length ? state.roster : Object.values(state.brains || {});
}

function brainLabel(id) {
  const brain = state.brains?.[id] || rosterList().find((item) => item.id === id);
  return brain?.label || id;
}

function renderLineup() {
  const host = $("lineup");
  const lineup = state.lineup?.length ? state.lineup : [];
  const brains = rosterList();
  host.replaceChildren();
  lineup.forEach((slot, i) => {
    const row = document.createElement("div");
    row.className = "lineup-row";
    const seat = document.createElement("span");
    seat.className = "seat";
    seat.textContent = `P${i + 1}`;
    const team = document.createElement("select");
    team.className = "team";
    team.innerHTML = `<option value="red">red</option><option value="blue">blue</option>`;
    team.value = slot.team === "blue" ? "blue" : "red";
    const brain = document.createElement("select");
    brain.className = "brain";
    brains.forEach((item) => {
      const opt = document.createElement("option");
      opt.value = item.id;
      opt.textContent = `${item.label}${item.learn ? "" : " (frozen)"}`;
      brain.append(opt);
    });
    brain.value = slot.brain_id;
    if (!brains.some((item) => item.id === slot.brain_id) && slot.brain_id) {
      const opt = document.createElement("option");
      opt.value = slot.brain_id;
      opt.textContent = slot.brain_id;
      brain.append(opt);
      brain.value = slot.brain_id;
    }
    team.addEventListener("change", () => pushRoster());
    brain.addEventListener("change", () => pushRoster());
    row.append(seat, team, brain);
    host.append(row);
  });
}

function renderRoster() {
  const host = $("roster");
  host.replaceChildren();
  rosterList().forEach((brain) => {
    const row = document.createElement("div");
    row.className = "roster-row";
    row.dataset.brainId = brain.id;
    const name = document.createElement("input");
    name.type = "text";
    name.maxLength = 32;
    name.value = brain.label || brain.id;
    name.setAttribute("aria-label", "Brain name");
    const learn = document.createElement("label");
    learn.className = "learn-toggle";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = brain.learn !== false;
    learn.append(box, document.createTextNode("learn"));
    const wipe = document.createElement("button");
    wipe.type = "button";
    wipe.className = "icon-btn";
    wipe.textContent = "wipe";
    wipe.addEventListener("click", () => wipeOneBrain(brain.id));
    name.addEventListener("input", () => {
      state.rosterDirty = true;
    });
    name.addEventListener("change", () => {
      pushRoster();
    });
    box.addEventListener("change", () => pushRoster());
    row.append(name, learn, wipe);
    if (brain.id !== "red" && brain.id !== "blue") {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "icon-btn";
      remove.textContent = "drop";
      remove.addEventListener("click", () => dropBrain(brain.id));
      row.append(remove);
    }
    host.append(row);
  });
}

function readRosterForm() {
  const brains = [...$("roster").querySelectorAll(".roster-row")].map((row) => ({
    id: row.dataset.brainId,
    label: row.querySelector("input[type=text]").value,
    learn: row.querySelector("input[type=checkbox]").checked,
  }));
  const lineup = [...$("lineup").querySelectorAll(".lineup-row")].map((row) => ({
    team: row.querySelector("select.team").value,
    brain_id: row.querySelector("select.brain").value,
  }));
  return { brains, lineup };
}

async function pushRoster() {
  const payload = readRosterForm();
  try {
    const res = await fetch("/api/roster", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.detail || "Roster update failed");
    state.rosterDirty = false;
    applyStatus(body);
    $("status").textContent = "Lineup and brain names saved. Next fight uses this roster.";
  } catch (err) {
    state.rosterDirty = false;
    $("status").textContent = err.message;
  }
}

async function addBrain() {
  try {
    const res = await fetch("/api/brains", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "New brain", learn: true }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.detail || "Could not add a brain");
    applyStatus(body);
    $("status").textContent = "Added a brain. Assign it to a plane in the lineup.";
  } catch (err) {
    $("status").textContent = err.message;
  }
}

async function dropBrain(id) {
  try {
    const res = await fetch(`/api/brains/${id}`, { method: "DELETE" });
    const body = await res.json();
    if (!res.ok) throw new Error(body.detail || "Could not drop brain");
    applyStatus(body);
    $("status").textContent = `Dropped ${id}. Seats that used it fell back to a core brain.`;
  } catch (err) {
    $("status").textContent = err.message;
  }
}

async function wipeOneBrain(id) {
  try {
    const res = await fetch(`/api/brains/${id}/wipe`, { method: "POST" });
    const body = await res.json();
    if (!res.ok) throw new Error(body.detail || "Wipe failed");
    applyStatus(body);
    $("status").textContent = `${brainLabel(id)} weights scrambled.`;
  } catch (err) {
    $("status").textContent = err.message;
  }
}

$("add-brain").addEventListener("click", addBrain);

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
  $("status").textContent = "All brains scrambled on /data. Names and lineup kept. Continuous flights restart from empty nets.";
  resumeFlights();
});

function applyStatus(body) {
  const s = body.score;
  const t = body.training || {};
  const brains = body.brains || {};
  state.training = t;
  if (body.roster) state.roster = body.roster;
  if (body.lineup) state.lineup = body.lineup;
  if (body.brains) state.brains = brains;
  if (body.action_names) ACTION_NAMES.splice(0, ACTION_NAMES.length, ...body.action_names);
  $("red-kills").textContent = s.red_kills;
  $("blue-kills").textContent = s.blue_kills;
  $("red-extra").textContent = `${s.red_walls} walls`;
  $("blue-extra").textContent = `${s.blue_walls} walls`;
  $("red-brain-line").textContent = teamBrainLine("red", brains);
  $("blue-brain-line").textContent = teamBrainLine("blue", brains);
  $("episode-read").textContent = `Sortie ${s.episodes}`;
  const learners = rosterList().filter((b) => b.learn !== false);
  $("empty-badge").textContent = body.empty
    ? "brains empty"
    : learners.length
      ? "learning in progress"
      : "brains frozen";
  $("empty-badge").classList.toggle("is-trained", !body.empty);
  if (body.physics) {
    state.physics = body.physics;
    if (!state.timeoutDirty && body.physics.timeout != null) {
      setTimeoutSeconds(body.physics.timeout);
    }
    if (!state.planesDirty && body.physics.n_planes != null) {
      setPlaneCount(body.physics.n_planes, body.physics.teams);
    }
  }
  if (!state.rosterDirty) {
    renderLineup();
    renderRoster();
  }
  const redTitle = document.querySelector(".brain.red h2");
  const blueTitle = document.querySelector(".brain.blue h2");
  if (redTitle) redTitle.textContent = `${brains.red?.label || "Red"} brain`;
  if (blueTitle) blueTitle.textContent = `${brains.blue?.label || "Blue"} brain`;
  fillBrain("red", brains.red, t.last_actions?.red);
  fillBrain("blue", brains.blue, t.last_actions?.blue);
  renderExtraBrains(brains, t.last_actions?.brains || {});
  if (body.curve) {
    state.curve = body.curve;
    paintChart(body.curve);
    if (!body.curve.length) {
      $("lesson-note").textContent =
        "A kill requires pointing the nose. A crash is usually the wall — the first thing an empty net learns is “don’t fly off the plot.”";
    }
  }
}

function teamBrainLine(team, brains) {
  const seats = (state.lineup || []).filter((slot) => slot.team === team);
  if (!seats.length) {
    const brain = brains[team];
    return `${brain?.shape?.hidden ?? 24} hidden · ${brain?.updates ?? 0} updates`;
  }
  const names = seats.map((slot) => {
    const brain = brains[slot.brain_id] || {};
    const frozen = brain.learn === false ? " frozen" : "";
    return `${brain.label || slot.brain_id}${frozen}`;
  });
  const unique = [...new Set(names)];
  const updates = seats.map((slot) => brains[slot.brain_id]?.updates ?? 0);
  return `${unique.join(" · ")} · ${Math.max(...updates, 0)} updates`;
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

function renderExtraBrains(brains, lastByBrain) {
  const host = $("brains");
  const tpl = $("brain-card-tpl");
  if (!host || !tpl) return;
  const extras = rosterList().filter((brain) => brain.id !== "red" && brain.id !== "blue");
  host.querySelectorAll(".brain.extra").forEach((el) => {
    if (!extras.some((brain) => brain.id === el.dataset.brainId)) el.remove();
  });
  extras.forEach((meta) => {
    const brain = brains[meta.id] || meta;
    let article = host.querySelector(`[data-brain-id="${meta.id}"]`);
    if (!article) {
      article = tpl.content.firstElementChild.cloneNode(true);
      article.dataset.brainId = meta.id;
      host.append(article);
    }
    fillExtraBrain(article, brain, lastByBrain[meta.id]);
  });
}

function fillExtraBrain(article, brain, lastActions) {
  if (!article || !brain) return;
  const hue = "amber";
  article.querySelector("h2").textContent = `${brain.label || brain.id} brain`;
  const shape = brain.shape || {};
  article.querySelector(".arch").textContent = `${shape.obs ?? 10} obs → ${shape.hidden ?? 24} hidden ReLU → ${shape.actions ?? 6} actions`;
  article.querySelector(".upd").textContent = String(brain.updates ?? 0);
  article.querySelector(".l2").textContent = `${num(brain.weights?.l2, 2)} / ${brain.weights?.count ?? "—"}`;
  article.querySelector(".rms").textContent = `${num(brain.weights?.w1_rms)} (${num(brain.weights?.w1_growth)}×) · ${num(brain.weights?.w2_rms)} (${num(brain.weights?.w2_growth)}×)`;
  article.querySelector(".base").textContent = num(brain.baseline);
  article.querySelector(".ent").textContent = `${num(brain.probe?.entropy)} / ${pct(brain.probe?.max_prob)}`;
  article.querySelector(".hid").textContent = `${pct(brain.probe?.hidden_active)} on · ${brain.probe?.hidden_dead ?? 0} dead`;
  article.querySelector(".fav").textContent = brain.favorite || "—";
  article.querySelector(".last").textContent = `Last sortie mix: ${actionMix(lastActions)}`;
  paintActions(article.querySelector(".acts"), brain.probe?.mean_probs || [], hue);
  paintBrainNet(article.querySelector(".net"), brain, hue);
  paintWeights(article.querySelector(".w1"), brain.w1, hue);
  paintWeights(article.querySelector(".w2"), brain.w2, hue);
}

function paintActions(id, probs, side) {
  const host = typeof id === "string" ? $(id) : id;
  if (!host) return;
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
  const canvas = typeof id === "string" ? $(id) : id;
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.fillStyle = "#081014";
  ctx.fillRect(0, 0, w, h);
  const w1 = brain.w1;
  const w2 = brain.w2;
  if (!w1?.length || !w2?.length) return;
  const plus = side === "blue" ? [61, 184, 197] : side === "amber" ? [230, 195, 106] : [232, 93, 76];
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
  const canvas = typeof id === "string" ? $(id) : id;
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#081014";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!rows || !rows.length || !rows[0]?.length) return;
  const plus = side === "blue" ? [61, 184, 197] : side === "amber" ? [230, 195, 106] : [232, 93, 76];
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
  const lineup = state.lineup?.length
    ? state.lineup
    : (() => {
        const m = matchup($("planes-num")?.value || state.physics.n_planes || PLANES_MIN);
        return [
          ...Array.from({ length: m.red }, () => ({ team: "red", brain_id: "red" })),
          ...Array.from({ length: m.blue }, () => ({ team: "blue", brain_id: "blue" })),
        ];
      })();
  const planes = [];
  let redI = 0;
  let blueI = 0;
  const nRed = lineup.filter((slot) => slot.team === "red").length;
  const nBlue = lineup.filter((slot) => slot.team !== "red").length;
  lineup.forEach((slot) => {
    const team = slot.team === "blue" ? "blue" : "red";
    const i = team === "red" ? redI : blueI;
    const count = team === "red" ? nRed : nBlue;
    planes.push({
      name: i === 0 ? team : `${team}${i + 1}`,
      team,
      brain_id: slot.brain_id,
      brain_label: brainLabel(slot.brain_id),
      x: team === "red" ? 0.2 : 0.8,
      y: count === 1 ? (team === "red" ? 0.22 : 0.78) : (i + 1) / (count + 1),
      heading: team === "red" ? 0.4 : Math.PI + 0.4,
      alive: true,
    });
    if (team === "red") redI += 1;
    else blueI += 1;
  });
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
  const tag = p.brain_label || (p.brain_id ? brainLabel(p.brain_id) : "");
  if (tag) {
    ctx.fillStyle = "rgba(231,239,230,0.72)";
    ctx.font = "10px ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.fillText(tag, x, y + 18);
  }
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
