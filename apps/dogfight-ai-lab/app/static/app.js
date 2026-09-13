const $ = (id) => document.getElementById(id);
function text(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}
const PALETTE = ["#e85d4c", "#3db8c5", "#e6c36a", "#7c6bff", "#5dce8a", "#e07ab5", "#f08a4b", "#8aa09a", "#6ec6ff"];
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
  inspectId: null,
  sort: {
    hangar: { key: "plane", dir: "asc" },
    library: { key: "revision", dir: "desc" },
  },
};

const field = $("field");
const fctx = field.getContext("2d");

const BURST_MIN = 100;
const BURST_MAX = 1_000_000;
const ACTION_NAMES = ["left", "straight", "right", "left+fire", "straight+fire", "right+fire"];
const OBS_NAMES = ["fwd", "right", "range", "rel h", "x", "y", "cos", "sin", "wall", "gun"];
const PLANES_MIN = 2;
const PLANES_MAX = 9;
const TIMEOUT_MIN = 10;
const TIMEOUT_MAX = 600;
const TIMEOUT_DT = 0.05;

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

function rosterList() {
  return state.roster?.length ? state.roster : Object.values(state.brains || {});
}

function libraryList() {
  return rosterList().filter((brain) => brain.stored);
}

function sortValue(row, key) {
  const value = row[key];
  if (value == null || value === "") return key === "name" || key === "plane" || key === "from" || key === "favorite" ? "" : -Infinity;
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

function compareRows(a, b, key, dir) {
  const av = sortValue(a, key);
  const bv = sortValue(b, key);
  let cmp = 0;
  if (typeof av === "number" && typeof bv === "number") cmp = av - bv;
  else cmp = String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: "base" });
  return dir === "desc" ? -cmp : cmp;
}

function sortedCopy(rows, which) {
  const { key, dir } = state.sort[which];
  return [...rows].sort((a, b) => compareRows(a, b, key, dir));
}

function sortableHead(label, key, which, numeric) {
  const el = document.createElement("th");
  const cur = state.sort[which];
  el.scope = "col";
  if (numeric) el.classList.add("num");
  el.classList.add("sortable");
  if (cur.key === key) el.classList.add(cur.dir === "desc" ? "is-desc" : "is-asc");
  el.textContent = label;
  el.addEventListener("click", () => {
    if (state.sort[which].key === key) {
      state.sort[which].dir = state.sort[which].dir === "asc" ? "desc" : "asc";
    } else {
      state.sort[which] = { key, dir: numeric ? "desc" : "asc" };
    }
    if (which === "hangar") renderHangar();
    else renderRoster();
  });
  return el;
}

function td(value, className) {
  const cell = document.createElement("td");
  if (className) cell.className = className;
  cell.textContent = value == null || value === "" ? "—" : String(value);
  return cell;
}

function ratePct(value) {
  if (value == null || Number.isNaN(Number(value))) return "—";
  return `${(Number(value) * 100).toFixed(0)}%`;
}

function brainOptions(select, selectedId) {
  rosterList().forEach((brain) => {
    const opt = document.createElement("option");
    opt.value = brain.id;
    const place = brain.stored ? " · library" : "";
    const rev = brain.revision ? ` r${brain.revision}` : "";
    const frozen = brain.learn === false ? " · frozen" : "";
    opt.textContent = `${brain.label}${rev}${frozen}${place}`;
    select.append(opt);
  });
  select.value = selectedId;
}

function brainById(id) {
  return state.brains?.[id] || rosterList().find((item) => item.id === id);
}

function brainLabel(id) {
  return brainById(id)?.label || id || "—";
}

function seatColor(i) {
  return PALETTE[i % PALETTE.length];
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

$("episodes").addEventListener("input", () => setBurst(sliderToBurst($("episodes").value)));
$("episodes-num").addEventListener("change", () => setBurst(burstSize()));

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
  text("timeout-read", `${v} s · ${steps} steps`);
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
$("timeout").addEventListener("change", pushTimeout);
$("timeout-num").addEventListener("change", () => {
  state.timeoutDirty = true;
  setTimeoutSeconds(timeoutSeconds());
  pushTimeout();
});

function planeCount() {
  const n = Number($("planes-num").value);
  if (!Number.isFinite(n)) return PLANES_MIN;
  return Math.min(PLANES_MAX, Math.max(PLANES_MIN, Math.round(n)));
}

function setPlaneCount(n) {
  const v = Math.min(PLANES_MAX, Math.max(PLANES_MIN, Math.round(Number(n) || PLANES_MIN)));
  $("planes").value = String(v);
  $("planes-num").value = String(v);
  text("planes-read", `${v} planes · each seat has its own brain unless you share one`);
  text("matchup-read", `${v} planes · FFA`);
  text("field-hint", `Free-for-all, ${v} aircraft. Last plane left wins. Out of bounds is a crash.`);
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
    $("status").textContent = `Next fight has ${n} planes. New seats got their own brains.`;
  } catch (err) {
    state.planesDirty = false;
    $("status").textContent = err.message;
  }
}

$("planes").addEventListener("input", () => {
  state.planesDirty = true;
  setPlaneCount(Number($("planes").value));
});
$("planes").addEventListener("change", pushPlanes);
$("planes-num").addEventListener("change", () => {
  state.planesDirty = true;
  setPlaneCount(planeCount());
  pushPlanes();
});

function renderHangar() {
  const host = $("hangar");
  if (!host) return;
  const lineup = state.lineup || [];
  const rows = lineup.map((slot, i) => {
    const brain = brainById(slot.brain_id) || {};
    return {
      plane: i + 1,
      seat: i,
      brain_id: slot.brain_id,
      name: brain.label || slot.brain_id,
      revision: brain.revision || 0,
      learn: brain.learn !== false,
      wins: brain.wins ?? 0,
      kills: brain.kills ?? 0,
      walls: brain.walls ?? 0,
      updates: brain.updates ?? 0,
      win_rate: brain.win_rate ?? 0,
      favorite: brain.favorite || "—",
      brain,
    };
  });
  const table = document.createElement("table");
  table.className = "stat-table";
  const thead = document.createElement("thead");
  const head = document.createElement("tr");
  head.append(
    sortableHead("Plane", "plane", "hangar"),
    sortableHead("Brain", "name", "hangar"),
    sortableHead("Rev", "revision", "hangar", true),
    sortableHead("Learn", "learn", "hangar"),
    sortableHead("Wins", "wins", "hangar", true),
    sortableHead("Kills", "kills", "hangar", true),
    sortableHead("Walls", "walls", "hangar", true),
    sortableHead("Updates", "updates", "hangar", true),
    sortableHead("Win%", "win_rate", "hangar", true),
    sortableHead("Fav", "favorite", "hangar"),
    document.createElement("th")
  );
  thead.append(head);
  const tbody = document.createElement("tbody");
  sortedCopy(rows, "hangar").forEach((row) => {
    const tr = document.createElement("tr");
    tr.className = "seat-row";
    tr.dataset.seat = String(row.seat);
    tr.dataset.brainId = row.brain_id;
    const plane = document.createElement("td");
    const seat = document.createElement("span");
    seat.className = "seat";
    const swatch = document.createElement("i");
    swatch.className = "swatch";
    swatch.style.background = seatColor(row.seat);
    seat.append(swatch, document.createTextNode(`P${row.plane}`));
    plane.append(seat);
    const nameCell = document.createElement("td");
    const name = document.createElement("input");
    name.type = "text";
    name.maxLength = 32;
    name.value = row.name;
    name.addEventListener("input", () => {
      state.rosterDirty = true;
    });
    name.addEventListener("change", () => pushRoster());
    const select = document.createElement("select");
    brainOptions(select, row.brain_id);
    select.addEventListener("change", () => pushRoster());
    nameCell.className = "brain-pick";
    nameCell.append(name, select);
    const learnCell = document.createElement("td");
    const learn = document.createElement("label");
    learn.className = "learn-toggle";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = row.learn;
    box.addEventListener("change", () => pushRoster());
    learn.append(box);
    learnCell.append(learn);
    const actions = document.createElement("td");
    actions.className = "brain-actions";
    const inspect = document.createElement("button");
    inspect.type = "button";
    inspect.className = "icon-btn";
    inspect.textContent = "inspect";
    inspect.addEventListener("click", () => {
      state.inspectId = row.brain_id;
      fillInspect();
      renderChips();
    });
    const fork = document.createElement("button");
    fork.type = "button";
    fork.className = "icon-btn";
    fork.textContent = "revise";
    fork.title = "Freeze this net in the library and fly a learning copy";
    fork.addEventListener("click", () => reviseBrain(row.brain_id, row.seat));
    actions.append(inspect, fork);
    tr.append(
      plane,
      nameCell,
      td(row.revision || "—", "num"),
      learnCell,
      td(row.wins, "num"),
      td(row.kills, "num"),
      td(row.walls, "num"),
      td(row.updates, "num"),
      td(ratePct(row.win_rate), "num"),
      td(row.favorite),
      actions
    );
    tbody.append(tr);
  });
  table.append(thead, tbody);
  host.replaceChildren(table);
}

function renderRoster() {
  const host = $("roster");
  if (!host) return;
  const stored = libraryList().map((brain) => ({
    ...brain,
    name: brain.label || brain.id,
    from: brain.parent_label || brain.parent_id || "",
    revision: brain.revision || 0,
    learn: brain.learn !== false,
    wins: brain.wins ?? 0,
    kills: brain.kills ?? 0,
    walls: brain.walls ?? 0,
    updates: brain.updates ?? 0,
    win_rate: brain.win_rate ?? 0,
  }));
  const table = document.createElement("table");
  table.className = "stat-table";
  const thead = document.createElement("thead");
  const head = document.createElement("tr");
  head.append(
    sortableHead("Brain", "name", "library"),
    sortableHead("From", "from", "library"),
    sortableHead("Rev", "revision", "library", true),
    sortableHead("Wins", "wins", "library", true),
    sortableHead("Kills", "kills", "library", true),
    sortableHead("Walls", "walls", "library", true),
    sortableHead("Updates", "updates", "library", true),
    sortableHead("Win%", "win_rate", "library", true),
    sortableHead("Status", "learn", "library"),
    document.createElement("th")
  );
  thead.append(head);
  const tbody = document.createElement("tbody");
  if (!stored.length) {
    const tr = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 10;
    cell.className = "empty-lib";
    cell.textContent = "No stored revisions yet. Revise a hangar brain to freeze it here and fly a learning copy.";
    tr.append(cell);
    tbody.append(tr);
  } else {
    sortedCopy(stored, "library").forEach((brain) => {
      const tr = document.createElement("tr");
      tr.className = "brain-row";
      tr.dataset.brainId = brain.id;
      const nameCell = document.createElement("td");
      const name = document.createElement("input");
      name.type = "text";
      name.maxLength = 32;
      name.value = brain.name;
      name.addEventListener("input", () => {
        state.rosterDirty = true;
      });
      name.addEventListener("change", () => pushRoster());
      nameCell.append(name);
      const status = document.createElement("td");
      const learn = document.createElement("label");
      learn.className = "learn-toggle";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = false;
      box.disabled = true;
      learn.append(box, document.createTextNode("frozen"));
      status.append(learn);
      const actions = document.createElement("td");
      actions.className = "brain-actions";
      const inspect = document.createElement("button");
      inspect.type = "button";
      inspect.className = "icon-btn";
      inspect.textContent = "inspect";
      inspect.addEventListener("click", () => {
        state.inspectId = brain.id;
        fillInspect();
        renderChips();
      });
      const wipe = document.createElement("button");
      wipe.type = "button";
      wipe.className = "icon-btn";
      wipe.textContent = "wipe";
      wipe.addEventListener("click", () => wipeBrain(brain.id));
      const drop = document.createElement("button");
      drop.type = "button";
      drop.className = "icon-btn";
      drop.textContent = "delete";
      drop.addEventListener("click", () => dropBrain(brain.id));
      actions.append(inspect, wipe, drop);
      tr.append(
        nameCell,
        td(brain.from),
        td(brain.revision || "—", "num"),
        td(brain.wins, "num"),
        td(brain.kills, "num"),
        td(brain.walls, "num"),
        td(brain.updates, "num"),
        td(ratePct(brain.win_rate), "num"),
        status,
        actions
      );
      tbody.append(tr);
    });
  }
  table.append(thead, tbody);
  host.replaceChildren(table);
}

function renderChips() {
  const host = $("brain-chips");
  host.replaceChildren();
  rosterList().forEach((brain) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `chip${state.inspectId === brain.id ? " is-on" : ""}`;
    chip.textContent = brain.revision ? `${brain.label}` : brain.label;
    chip.addEventListener("click", () => {
      state.inspectId = brain.id;
      fillInspect();
      renderChips();
    });
    host.append(chip);
  });
}

function readRosterForm() {
  const byId = {};
  [...$("roster").querySelectorAll(".brain-row")].forEach((row) => {
    const id = row.dataset.brainId;
    if (!id) return;
    byId[id] = {
      id,
      label: row.querySelector("input[type=text]")?.value || id,
      learn: row.querySelector("input[type=checkbox]")?.checked !== false,
    };
  });
  const lineup = [...$("hangar").querySelectorAll(".seat-row")]
    .sort((a, b) => Number(a.dataset.seat) - Number(b.dataset.seat))
    .map((row) => {
      const brain_id = row.querySelector("select")?.value;
      const learn = row.querySelector("input[type=checkbox]")?.checked !== false;
      const label = row.querySelector("input[type=text]")?.value;
      if (brain_id) {
        byId[brain_id] = { id: brain_id, label: label || byId[brain_id]?.label || brain_id, learn };
      }
      return { brain_id, learn };
    });
  return { brains: Object.values(byId), lineup };
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
    if (!res.ok) throw new Error(typeof body.detail === "string" ? body.detail : "Roster update failed");
    state.rosterDirty = false;
    applyStatus(body);
    $("status").textContent = "Hangar saved. A mixed learn on a shared brain forks a library revision.";
  } catch (err) {
    state.rosterDirty = false;
    $("status").textContent = err.message;
  }
}

async function reviseBrain(id, seat) {
  try {
    const res = await fetch(`/api/brains/${id}/revise`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(seat == null ? {} : { seat }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(typeof body.detail === "string" ? body.detail : "Revise failed");
    applyStatus(body);
    $("status").textContent =
      seat == null
        ? `${brainLabel(id)} copied into the library as a frozen revision.`
        : `P${seat + 1} now flies a learning copy. The previous net is stored in the library.`;
  } catch (err) {
    $("status").textContent = err.message;
  }
}

async function dropBrain(id) {
  try {
    const res = await fetch(`/api/brains/${id}`, { method: "DELETE" });
    const body = await res.json();
    if (!res.ok) throw new Error(typeof body.detail === "string" ? body.detail : "Could not delete brain");
    if (state.inspectId === id) state.inspectId = null;
    applyStatus(body);
    $("status").textContent = "Revision deleted.";
  } catch (err) {
    $("status").textContent = err.message;
  }
}

async function wipeBrain(id) {
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

$("pause").addEventListener("click", () => {
  if (state.running) pauseFlights();
  else resumeFlights();
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
    $("status").textContent = "Wins, kills, and the chart are cleared. Brains kept.";
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
  $("status").textContent = "All brains scrambled. Names, revisions, and hangar seats kept.";
  resumeFlights();
});

function applyStatus(body) {
  const s = body.score || {};
  const t = body.training || {};
  const brains = body.brains || {};
  state.training = t;
  if (body.roster) state.roster = body.roster;
  if (body.lineup) state.lineup = body.lineup;
  if (body.brains) state.brains = brains;
  if (body.action_names) ACTION_NAMES.splice(0, ACTION_NAMES.length, ...body.action_names);
  text("episode-read", String(s.episodes ?? 0));
  text("winner-read", s.last_winner ? brainLabel(s.last_winner) : "—");
  text("draw-read", `${s.draws ?? 0} · ${s.midairs ?? 0}`);
  const learners = rosterList().filter((b) => b.learn !== false);
  text("empty-badge", body.empty ? "brains empty" : learners.length ? "learning in progress" : "brains frozen");
  $("empty-badge")?.classList.toggle("is-trained", !body.empty);
  renderWinStrip(s);
  if (body.physics) {
    state.physics = body.physics;
    if (!state.timeoutDirty && body.physics.timeout != null) setTimeoutSeconds(body.physics.timeout);
    if (!state.planesDirty && body.physics.n_planes != null) setPlaneCount(body.physics.n_planes);
  }
  if (!state.rosterDirty) {
    renderHangar();
    renderRoster();
    renderChips();
  }
  if (!state.inspectId || !brains[state.inspectId]) {
    state.inspectId = state.lineup[0]?.brain_id || rosterList()[0]?.id || null;
  }
  fillInspect();
  if (body.curve) {
    state.curve = body.curve;
    paintChart(body.curve);
    if (!body.curve.length) {
      text("lesson-note", "Survive. Point the nose. A crash is usually the wall.");
    }
  }
}

function renderWinStrip(score) {
  const host = $("win-strip");
  if (!host) return;
  host.replaceChildren();
  const wins = score.wins || {};
  const kills = score.kills || {};
  const ids = [...new Set([...Object.keys(wins), ...Object.keys(kills), ...rosterList().map((b) => b.id)])];
  ids.forEach((id) => {
    const chip = document.createElement("span");
    chip.className = "win-chip";
    chip.textContent = `${brainLabel(id)} ${wins[id] || 0} wins · ${kills[id] || 0} kills`;
    host.append(chip);
  });
}

function fillInspect() {
  const brain = brainById(state.inspectId);
  if (!brain) return;
  const last = state.training?.last_actions?.brains?.[brain.id];
  text("inspect-title", brain.revision ? `${brain.label} · r${brain.revision}` : `${brain.label || "Brain"}`);
  const shape = brain.shape || {};
  text("inspect-arch", `${shape.obs ?? 10} obs → ${shape.hidden ?? 24} hidden ReLU → ${shape.actions ?? 6} actions`);
  text("insp-upd", String(brain.updates ?? 0));
  text("insp-l2", `${num(brain.weights?.l2, 2)} / ${brain.weights?.count ?? "—"}`);
  text("insp-rms", `${num(brain.weights?.w1_rms)} (${num(brain.weights?.w1_growth)}×) · ${num(brain.weights?.w2_rms)} (${num(brain.weights?.w2_growth)}×)`);
  text("insp-base", num(brain.baseline));
  text("insp-ent", `${num(brain.probe?.entropy)} / ${pct(brain.probe?.max_prob)}`);
  text("insp-hid", `${pct(brain.probe?.hidden_active)} on · ${brain.probe?.hidden_dead ?? 0} dead`);
  text("insp-fav", brain.favorite || "—");
  text("insp-rev", brain.revision ? `r${brain.revision} from ${brain.parent_label || brain.parent_id}` : "original");
  text("inspect-last", `Last sortie mix: ${actionMix(last)}`);
  paintActions("inspect-acts", brain.probe?.mean_probs || [], "amber");
  paintBrainNet("inspect-net", brain, "amber");
  paintWeights("inspect-w1", brain.w1, "amber");
  paintWeights("inspect-weights", brain.w2, "amber");
}

function paintActions(id, probs) {
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
    track.className = "act-track";
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
  w1.forEach((row, hi) => row.forEach((value, ii) => strokeEdge(ins[ii], hid[hi], value, max1)));
  w2.forEach((row, ai) => row.forEach((value, hi) => strokeEdge(hid[hi], outs[ai], value, max2)));
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
  $("status").textContent = "Continuous flights. Last plane standing, then the next sortie starts.";
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
  const lineup = state.lineup?.length ? state.lineup : [{ brain_id: "p1" }, { brain_id: "p2" }];
  const n = lineup.length;
  const planes = lineup.map((slot, i) => {
    const angle = (2 * Math.PI * i) / n - Math.PI / 2;
    const radius = n > 2 ? 0.32 : 0.28;
    return {
      name: `p${i + 1}`,
      seat: i,
      brain_id: slot.brain_id,
      brain_label: brainLabel(slot.brain_id),
      x: 0.5 + radius * Math.cos(angle),
      y: 0.5 + radius * Math.sin(angle),
      heading: angle + Math.PI,
      alive: true,
    };
  });
  drawField({ planes, bullets: [], events: [], t: 0 });
}

function drawField(frame) {
  const ctx = fctx;
  const w = field.width;
  ctx.fillStyle = "#081014";
  ctx.fillRect(0, 0, w, field.height);
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
  const rets = curve.map((r) => {
    const brains = Object.values(r.brains || {});
    if (brains.length) return brains.reduce((sum, b) => sum + (b.return || 0), 0) / brains.length;
    return ((r.red?.return || 0) + (r.blue?.return || 0)) / 2;
  });
  const maxR = Math.max(...rets.map(Math.abs), 0.2);
  line(
    rets.map((v) => v + maxR),
    "#3db8c5",
    2 * maxR
  );
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
