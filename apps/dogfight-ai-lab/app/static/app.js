import { createAcademyClient } from "./client.js";

const academy = createAcademyClient(new URL("./academy-worker.js?v=circle-death", import.meta.url));

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
  modeDirty: false,
  mode: "ffa",
  rosterDirty: false,
  roster: [],
  lineup: [],
  brains: {},
  training: {},
  inspectId: null,
  burstTimer: null,
  bursting: false,
  burstShown: 0,
  sort: {
    hangar: { key: "plane", dir: "asc" },
    library: { key: "revision", dir: "desc" },
  },
};

const field = $("field");
const fctx = field.getContext("2d");

const ACTION_NAMES = ["left", "straight", "right", "left+fire", "straight+fire", "right+fire"];
const PLANES_MIN = 2;
const PLANES_MAX = 9;
function observationNames() {
  const names = ["fwd", "right", "range", "rel h", "x", "y", "cos", "sin", "wall", "gun", "edge L", "edge R", "edge B", "edge T"];
  for (let slot = 2; slot < PLANES_MAX; slot += 1) names.push(`n${slot}`, `fwd${slot}`, `rt${slot}`, `rng${slot}`, `h${slot}`);
  return names;
}
const OBS_NAMES = observationNames();
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
  const hangar = rosterList().filter((brain) => !brain.stored && (brain.assigned || brain.id === selectedId));
  const lib = rosterList().filter((brain) => brain.stored);
  const fill = (brains, groupLabel) => {
    if (!brains.length) return;
    const group = document.createElement("optgroup");
    group.label = groupLabel;
    brains.forEach((brain) => {
      const opt = document.createElement("option");
      opt.value = brain.id;
      const rev = brain.revision ? ` r${brain.revision}` : "";
      opt.textContent = `${brain.label}${rev}`;
      group.append(opt);
    });
    select.append(group);
  };
  fill(hangar, "In the fight");
  fill(lib, "Library snapshots");
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

const BURST_REPORT = 10_000;

function timeoutSeconds() {
  const n = Number($("timeout-num").value);
  if (!Number.isFinite(n)) return 600;
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
    const body = await academy.call("timeout", { seconds });
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

function fightMode() {
  return state.mode === "hunt" ? "hunt" : "ffa";
}

function huntCopy() {
  return {
    escape: "escaped",
    wipe: "pack wiped",
    clean_hunt: "clean hunt",
    hunt: "pack scored",
    prey_crash: "prey crashed",
    midair: "midair",
  };
}

function ffaOutcomeCopy() {
  return {
    failure: "timeout loss",
    draw: "timeout loss",
    win: "—",
  };
}

function formatEvent(event) {
  if (event === "draw") return "timeout loss";
  const text = String(event || "");
  if (text.endsWith("_circle")) return `${text.slice(0, -7)} circled out`;
  return text.replaceAll("_", " ");
}

function formatEvents(events) {
  return (events || []).map(formatEvent).join(", ");
}

function syncFightCopy(n) {
  const v = n ?? planeCount();
  const hunt = fightMode() === "hunt";
  text(
    "planes-read",
    hunt
      ? `${v} planes · P1 is chased, the rest hunt`
      : `${v} planes · each seat has its own brain unless you share one`
  );
  text("matchup-read", hunt ? `${v} planes · 1 vs pack` : `${v} planes · FFA`);
  text(
    "field-hint",
    hunt
      ? "One against the pack. P1 is chased. The fight ends when that plane dies, the pack is wiped, or time runs out."
      : `Free-for-all, ${v} aircraft. Last plane left wins. Timeout with more than one still up is a loss. Out of bounds or a full circle is a crash.`
  );
  text("winner-label", hunt ? "Last outcome" : "Last winner");
  text("draw-label", hunt ? "Escapes · hunts" : "Timeout losses · midairs");
  text(
    "timeout-label",
    hunt
      ? "Sortie timeout — the chased plane escapes if still up"
      : "Sortie timeout — loss if more than one is still up"
  );
  text(
    "hangar-hint",
    hunt
      ? "P1 is the chased plane. The others hunt. Hangar, library, and revise stay the same. Hunt statistics are separate from last-plane-standing."
      : "Brains on the planes in this fight. Click a column header to sort. Revise a seat to freeze that net in the library and fly a learning copy. Swapping a seat discards the old working copy — it does not archive it."
  );
}

function setFightMode(mode) {
  state.mode = mode === "hunt" ? "hunt" : "ffa";
  if ($("mode")) $("mode").value = state.mode;
  syncFightCopy();
}

function setPlaneCount(n) {
  const v = Math.min(PLANES_MAX, Math.max(PLANES_MIN, Math.round(Number(n) || PLANES_MIN)));
  $("planes").value = String(v);
  $("planes-num").value = String(v);
  syncFightCopy(v);
}

async function pushPlanes() {
  const n = planeCount();
  setPlaneCount(n);
  try {
    const body = await academy.call("planes", { n });
    state.planesDirty = false;
    applyStatus(body);
    $("status").textContent = fightMode() === "hunt"
      ? `Next fight has ${n} planes. P1 is chased; new seats join the pack.`
      : `Next fight has ${n} planes. New seats got their own brains.`;
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

async function pushMode() {
  const mode = $("mode")?.value === "hunt" ? "hunt" : "ffa";
  setFightMode(mode);
  try {
    const body = await academy.call("mode", { mode });
    state.modeDirty = false;
    applyStatus(body);
    $("status").textContent = mode === "hunt"
      ? "One against the pack. P1 is chased. Hunt statistics are separate."
      : "Last plane standing. Free-for-all statistics are separate.";
    if (state.running) {
      pauseFlights();
      resumeFlights();
    } else {
      drawEmpty();
    }
  } catch (err) {
    state.modeDirty = false;
    $("status").textContent = err.message;
  }
}

$("mode")?.addEventListener("change", () => {
  state.modeDirty = true;
  setFightMode($("mode").value);
  pushMode();
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
      role: i === 0 ? "chased" : "hunt",
      wins: brain.wins ?? 0,
      kills: brain.kills ?? 0,
      walls: brain.walls ?? 0,
      prey_kills: brain.prey_kills ?? 0,
      pack_deaths: brain.pack_deaths ?? 0,
      prey_escapes: brain.prey_escapes ?? 0,
      pack_scores: brain.pack_scores ?? 0,
      updates: brain.updates ?? 0,
      win_rate: brain.win_rate ?? 0,
      favorite: brain.favorite || "—",
      brain,
    };
  });
  const hunt = fightMode() === "hunt";
  const table = document.createElement("table");
  table.className = "stat-table";
  const thead = document.createElement("thead");
  const head = document.createElement("tr");
  head.append(
    sortableHead("Plane", "plane", "hangar"),
    sortableHead("Brain", "name", "hangar"),
    sortableHead("Rev", "revision", "hangar", true),
    sortableHead("Learn", "learn", "hangar"),
    ...(hunt
      ? [
          sortableHead("Role", "role", "hangar"),
          sortableHead("Kills", "kills", "hangar", true),
          sortableHead("Prey kills", "prey_kills", "hangar", true),
          sortableHead("Pack deaths", "pack_deaths", "hangar", true),
          sortableHead("Escapes", "prey_escapes", "hangar", true),
          sortableHead("Hunts", "pack_scores", "hangar", true),
        ]
      : [
          sortableHead("Wins", "wins", "hangar", true),
          sortableHead("Kills", "kills", "hangar", true),
          sortableHead("Walls", "walls", "hangar", true),
          sortableHead("Win%", "win_rate", "hangar", true),
        ]),
    sortableHead("Updates", "updates", "hangar", true),
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
    seat.className = hunt && row.seat === 0 ? "seat is-prey" : "seat";
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
    select.addEventListener("change", () => {
      const chosen = brainById(select.value);
      if (chosen) name.value = chosen.label || chosen.id;
      pushRoster();
    });
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
      ...(hunt
        ? [
            td(row.role),
            td(row.kills, "num"),
            td(row.prey_kills, "num"),
            td(row.pack_deaths, "num"),
            td(row.prey_escapes, "num"),
            td(row.pack_scores, "num"),
          ]
        : [
            td(row.wins, "num"),
            td(row.kills, "num"),
            td(row.walls, "num"),
            td(ratePct(row.win_rate), "num"),
          ]),
      td(row.updates, "num"),
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
    prey_kills: brain.prey_kills ?? 0,
    pack_deaths: brain.pack_deaths ?? 0,
    prey_escapes: brain.prey_escapes ?? 0,
    pack_scores: brain.pack_scores ?? 0,
    updates: brain.updates ?? 0,
    win_rate: brain.win_rate ?? 0,
  }));
  const hunt = fightMode() === "hunt";
  const table = document.createElement("table");
  table.className = "stat-table";
  const thead = document.createElement("thead");
  const head = document.createElement("tr");
  head.append(
    sortableHead("Brain", "name", "library"),
    sortableHead("From", "from", "library"),
    sortableHead("Rev", "revision", "library", true),
    ...(hunt
      ? [
          sortableHead("Kills", "kills", "library", true),
          sortableHead("Prey kills", "prey_kills", "library", true),
          sortableHead("Pack deaths", "pack_deaths", "library", true),
          sortableHead("Escapes", "prey_escapes", "library", true),
          sortableHead("Hunts", "pack_scores", "library", true),
        ]
      : [
          sortableHead("Wins", "wins", "library", true),
          sortableHead("Kills", "kills", "library", true),
          sortableHead("Walls", "walls", "library", true),
          sortableHead("Win%", "win_rate", "library", true),
        ]),
    sortableHead("Updates", "updates", "library", true),
    sortableHead("Status", "learn", "library"),
    document.createElement("th")
  );
  thead.append(head);
  const tbody = document.createElement("tbody");
  if (!stored.length) {
    const tr = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = hunt ? 11 : 10;
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
        ...(hunt
          ? [
              td(brain.kills, "num"),
              td(brain.prey_kills, "num"),
              td(brain.pack_deaths, "num"),
              td(brain.prey_escapes, "num"),
              td(brain.pack_scores, "num"),
            ]
          : [
              td(brain.wins, "num"),
              td(brain.kills, "num"),
              td(brain.walls, "num"),
              td(ratePct(brain.win_rate), "num"),
            ]),
        td(brain.updates, "num"),
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
  rosterList()
    .filter((brain) => brain.stored || brain.assigned)
    .forEach((brain) => {
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
      const selected = brainById(brain_id);
      if (brain_id && selected?.stored !== true) {
        byId[brain_id] = { id: brain_id, label: label || byId[brain_id]?.label || brain_id, learn };
      }
      return { brain_id, learn };
    });
  return { brains: Object.values(byId), lineup };
}

async function pushRoster() {
  const payload = readRosterForm();
  try {
    const body = await academy.call("roster", payload);
    state.rosterDirty = false;
    applyStatus(body);
    $("status").textContent = "Hangar saved. A library pick copies onto the plane; the snapshot stays put.";
  } catch (err) {
    state.rosterDirty = false;
    $("status").textContent = err.message;
  }
}

async function reviseBrain(id, seat) {
  try {
    const body = await academy.call("revise", { id, seat: seat == null ? null : seat });
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
    const body = await academy.call("removeBrain", { id });
    if (state.inspectId === id) state.inspectId = null;
    applyStatus(body);
    $("status").textContent = "Revision deleted.";
  } catch (err) {
    $("status").textContent = err.message;
  }
}

async function wipeBrain(id) {
  try {
    const body = await academy.call("wipeBrain", { id });
    applyStatus(body);
    $("status").textContent = `${brainLabel(id)} weights scrambled.`;
  } catch (err) {
    $("status").textContent = err.message;
  }
}

$("pause").addEventListener("click", () => {
  if (state.bursting) return;
  if (state.running) pauseFlights();
  else resumeFlights();
});

function burstMilestone(trained) {
  return Math.floor(Math.max(0, Number(trained) || 0) / BURST_REPORT) * BURST_REPORT;
}

function setBurstControls(running) {
  state.bursting = Boolean(running);
  const btn = $("burst");
  if (btn) {
    btn.disabled = false;
    btn.setAttribute("aria-pressed", state.bursting ? "true" : "false");
    btn.classList.toggle("is-on", state.bursting);
    btn.textContent = state.bursting ? "Burst training on" : "Burst training off";
  }
  if ($("pause")) $("pause").disabled = state.bursting;
}

function stopBurstPoll() {
  if (state.burstTimer != null) {
    clearInterval(state.burstTimer);
    state.burstTimer = null;
  }
}

function startBurstPoll() {
  stopBurstPoll();
  state.burstTimer = setInterval(pollBurst, 400);
}

async function pollBurst() {
  try {
    const burst = await academy.call("burst");
    const trained = Number(burst.trained || 0);
    const mark = burstMilestone(trained);
    if (mark >= BURST_REPORT && mark !== state.burstShown) {
      state.burstShown = mark;
      text("burst-read", `Burst training · ${mark.toLocaleString()} sorties`);
      $("status").textContent = `Burst training running · ${mark.toLocaleString()} sorties.`;
      const snap = await academy.call("state");
      applyStatus(snap);
    } else if (!state.burstShown) {
      text("burst-read", "Burst training · 0 sorties");
    }
    if (burst.running === false) {
      stopBurstPoll();
      finishBurst(burst);
    }
  } catch (err) {
    $("status").textContent = err.message;
  }
}

function finishBurst(burst) {
  const shouldResume = state.bursting;
  stopBurstPoll();
  const trained = Number(burst?.trained || 0);
  setBurstControls(false);
  text(
    "burst-read",
    burst?.error
      ? `Burst stopped with an error after ${trained.toLocaleString()} sorties.`
      : `Burst stopped after ${trained.toLocaleString()} sorties.`
  );
  $("status").textContent = burst?.error
    ? burst.error
    : `Stopped burst training after ${trained.toLocaleString()} sorties. Continuous flights resume.`;
  if (trained) {
    academy.call("state").then((snap) => applyStatus(snap)).catch(() => {});
  }
  if (shouldResume) resumeFlights();
}

async function startBurst() {
  if (state.bursting) return;
  pauseFlights();
  setBurstControls(true);
  state.burstShown = 0;
  text("burst-read", "Burst training · 0 sorties");
  $("status").textContent = "Burst training started. Counter updates every 10,000 sorties.";
  try {
    await academy.call("startBurst", { lr: 0.018, seconds: timeoutSeconds() });
    startBurstPoll();
  } catch (err) {
    try {
      const burst = await academy.call("burst");
      if (burst.running === true) {
        startBurstPoll();
        return;
      }
    } catch (_) {}
    setBurstControls(false);
    $("status").textContent = err.message;
    resumeFlights();
  }
}

async function stopBurst() {
  const btn = $("burst");
  if (btn) btn.disabled = true;
  $("status").textContent = "Stopping burst after the current sortie…";
  try {
    const body = await academy.call("stopBurst");
    if (body.running === false) {
      stopBurstPoll();
      applyStatus(body);
      finishBurst(body);
    } else if (btn) {
      btn.disabled = false;
    }
  } catch (err) {
    $("status").textContent = err.message;
    if (btn && state.bursting) btn.disabled = false;
  }
}

$("burst")?.addEventListener("click", () => {
  if (state.bursting) stopBurst();
  else startBurst();
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

function applyStatus(body) {
  const s = body.score || {};
  const t = body.training || {};
  const brains = body.brains || {};
  state.training = t;
  if (body.roster) state.roster = body.roster;
  if (body.lineup) state.lineup = body.lineup;
  if (body.brains) state.brains = brains;
  if (body.action_names) ACTION_NAMES.splice(0, ACTION_NAMES.length, ...body.action_names);
  if (body.mode) state.mode = body.mode === "hunt" ? "hunt" : "ffa";
  if (body.physics?.mode) state.mode = body.physics.mode === "hunt" ? "hunt" : "ffa";
  if (!state.modeDirty && $("mode")) $("mode").value = fightMode();
  text("episode-read", String(s.episodes ?? 0));
  if (fightMode() === "hunt") {
    text("winner-read", huntCopy()[s.last_outcome] || (s.last_winner ? brainLabel(s.last_winner) : "—"));
    text("draw-read", `${s.escapes ?? 0} · ${s.hunts ?? 0}`);
  } else {
    text("winner-read", s.last_winner ? brainLabel(s.last_winner) : ffaOutcomeCopy()[s.last_outcome] || "—");
    text("draw-read", `${s.draws ?? 0} · ${s.midairs ?? 0}`);
  }
  const learners = rosterList().filter((b) => b.learn !== false);
  text("empty-badge", body.empty ? "brains empty" : learners.length ? "learning in progress" : "brains frozen");
  $("empty-badge")?.classList.toggle("is-trained", !body.empty);
  renderWinStrip(s);
  if (body.physics) {
    state.physics = body.physics;
    if (!state.timeoutDirty && body.physics.timeout != null) setTimeoutSeconds(body.physics.timeout);
    if (!state.planesDirty && body.physics.n_planes != null) setPlaneCount(body.physics.n_planes);
    else syncFightCopy();
  } else {
    syncFightCopy();
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
      text(
        "lesson-note",
        fightMode() === "hunt"
          ? "Stay alive. Every hunter you take down helps. Dying ends the sortie."
          : "Survive. Point the nose. A full circle is a crash, same as the wall."
      );
    }
  }
}

function renderWinStrip(score) {
  const host = $("win-strip");
  if (!host) return;
  host.replaceChildren();
  if (fightMode() === "hunt") {
    const summary = document.createElement("span");
    summary.className = "win-chip pack";
    summary.textContent = `escapes ${score.escapes || 0} · hunts ${score.hunts || 0} · clean ${score.clean_hunts || 0} · wipes ${score.pack_wipes || 0} · pack lost ${score.pack_losses || 0}`;
    host.append(summary);
    const preyKills = score.prey_kills || {};
    const packDeaths = score.pack_deaths || {};
    const escapes = score.prey_escapes || {};
    const hunts = score.pack_scores || {};
    const ids = [...new Set([...Object.keys(preyKills), ...Object.keys(packDeaths), ...Object.keys(escapes), ...Object.keys(hunts), ...rosterList().map((b) => b.id)])];
    ids.forEach((id) => {
      const chip = document.createElement("span");
      chip.className = "win-chip";
      chip.textContent = `${brainLabel(id)} ${preyKills[id] || 0} prey kills · ${packDeaths[id] || 0} pack deaths · ${escapes[id] || 0} escapes · ${hunts[id] || 0} hunts`;
      host.append(chip);
    });
    return;
  }
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
  text("inspect-arch", `${shape.obs ?? OBS_NAMES.length} obs → ${shape.hidden ?? 24} hidden ReLU → ${shape.actions ?? 6} actions`);
  text("inspect-w1-cap", `W1 heatmap: ${shape.hidden ?? 24} hidden × ${shape.obs ?? OBS_NAMES.length} inputs.`);
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
  ctx.font = nIn > 16 ? "8px ui-monospace, monospace" : "11px ui-monospace, monospace";
  ctx.textBaseline = "middle";
  const inR = nIn > 16 ? 3.1 : 5.2;
  ins.forEach((p, i) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, inR, 0, Math.PI * 2);
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
    $("field-caption").textContent = `t = ${frame.t.toFixed(2)}s · ${formatEvent(ev)} · ${state.i + 1}/${state.frames.length}`;
    state.i += 1;
    if (state.i >= state.frames.length) {
      stopPlay();
      if (summary?.events?.length) {
        $("field-caption").textContent = `Ended: ${formatEvents(summary.events)} — next sortie starting`;
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
  if (state.bursting) return;
  state.running = true;
  state.loopId += 1;
  state.busy = false;
  setPauseLabel();
  $("status").textContent = fightMode() === "hunt"
    ? "Continuous flights. Hunt ends when the chased plane dies, the pack is wiped, or time runs out."
    : "Continuous flights. Last plane standing, then the next sortie starts.";
  flyNext(state.loopId);
}

async function flyNext(loopId) {
  if (state.bursting || !state.running || loopId !== state.loopId || state.busy) return;
  state.busy = true;
  try {
    const body = await academy.call("play", { learn: true, trace: true });
    if (!state.running || loopId !== state.loopId) {
      state.busy = false;
      return;
    }
    applyStatus(body);
    const events = body.summary?.events || [];
    $("status").textContent = events.length
      ? `Sortie ${body.score.episodes} ended (${formatEvents(events)}). Restarting.`
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
      role: fightMode() === "hunt" ? (i === 0 ? "prey" : "pack") : "ffa",
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
    const spin = Number(p.spin) || 0;
    const spinFrac = Math.min(1, Math.abs(spin) / (Math.PI * 2));
    if (spinFrac > 0.02) {
      const side = spin < 0 ? left : right;
      ctx.globalAlpha = 0.22 + 0.55 * spinFrac;
      ctx.lineWidth = 1.5 + 2 * spinFrac;
      ctx.strokeStyle = spinFrac > 0.75 ? "#e85d4c" : color;
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
  const snap = await academy.boot();
  applyStatus(snap);
  if (snap.physics?.timeout != null) setTimeoutSeconds(snap.physics.timeout);
  if (snap.physics?.n_planes != null) setPlaneCount(snap.physics.n_planes);
  drawEmpty();
  if (snap.burst?.running) {
    setBurstControls(true);
    state.burstShown = burstMilestone(snap.burst.trained);
    text(
      "burst-read",
      state.burstShown
        ? `Burst training · ${state.burstShown.toLocaleString()} sorties`
        : "Burst training · 0 sorties"
    );
    $("status").textContent = "Burst training is already running. Counter updates every 10,000 sorties.";
    pauseFlights();
    startBurstPoll();
    return;
  }
  if (snap.stored && !snap.empty) {
    $("status").textContent = "Restored brains from this browser. Continuous flights resume.";
  }
  resumeFlights();
}

boot();
