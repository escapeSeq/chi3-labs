const GRID = 16;
const HIDDEN = 20;
const state = {
  mode: "teach",
  label: 0,
  drawing: false,
  last: null,
  hasInk: false,
  timer: null,
  lastInfer: null,
  lastTrain: null,
  templates: null,
  inferWait: null,
  inspect: null,
  unit: 0,
  digit: 0,
};

const $ = (id) => document.getElementById(id);
const pad = $("pad");
const pctx = pad.getContext("2d");

function clearPad() {
  pctx.fillStyle = "#081014";
  pctx.fillRect(0, 0, pad.width, pad.height);
  pctx.strokeStyle = "rgba(231, 239, 230, 0.08)";
  pctx.beginPath();
  pctx.moveTo(pad.width / 2, 12);
  pctx.lineTo(pad.width / 2, pad.height - 12);
  pctx.moveTo(12, pad.height / 2);
  pctx.lineTo(pad.width - 12, pad.height / 2);
  pctx.stroke();
  state.hasInk = false;
  state.last = null;
  $("ink-status").textContent = "No ink yet.";
}

function padPos(event) {
  const rect = pad.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * pad.width,
    y: ((event.clientY - rect.top) / rect.height) * pad.height,
  };
}

function strokeTo(from, to) {
  pctx.strokeStyle = "#e7efe6";
  pctx.lineWidth = 22;
  pctx.lineCap = "round";
  pctx.lineJoin = "round";
  pctx.beginPath();
  pctx.moveTo(from.x, from.y);
  pctx.lineTo(to.x, to.y);
  pctx.stroke();
  state.hasInk = true;
  $("ink-status").textContent = "Ink on the page.";
}

pad.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  if (state.inferWait) {
    clearTimeout(state.inferWait);
    state.inferWait = null;
  }
  pad.setPointerCapture(event.pointerId);
  state.drawing = true;
  state.last = padPos(event);
  strokeTo(state.last, state.last);
});

pad.addEventListener("pointermove", (event) => {
  if (!state.drawing || !state.last) return;
  const now = padPos(event);
  strokeTo(state.last, now);
  state.last = now;
});

function endStroke() {
  state.drawing = false;
  state.last = null;
  paintSees(readGrid());
  if (state.mode === "ask" && state.hasInk) {
    if (state.inferWait) clearTimeout(state.inferWait);
    // Wait so a 4 or 7 can be more than one stroke.
    state.inferWait = setTimeout(() => inferNow(), 750);
  }
}

pad.addEventListener("pointerup", endStroke);
pad.addEventListener("pointercancel", endStroke);
$("clear").addEventListener("click", () => {
  clearPad();
  paintSees(zeros());
});

function zeros() {
  return Array.from({ length: GRID }, () => Array(GRID).fill(0));
}

function readGrid() {
  const { data, width, height } = pctx.getImageData(0, 0, pad.width, pad.height);
  const grid = zeros();
  const bw = width / GRID;
  const bh = height / GRID;
  for (let y = 0; y < GRID; y += 1) {
    for (let x = 0; x < GRID; x += 1) {
      let peak = 0;
      const x0 = Math.floor(x * bw);
      const y0 = Math.floor(y * bh);
      const x1 = Math.ceil((x + 1) * bw);
      const y1 = Math.ceil((y + 1) * bh);
      for (let yy = y0; yy < y1; yy += 1) {
        for (let xx = x0; xx < x1; xx += 1) {
          const i = (yy * width + xx) * 4;
          const brightness = (data[i] + data[i + 1] + data[i + 2]) / (3 * 255);
          if (brightness > peak) peak = brightness;
        }
      }
      grid[y][x] = Math.max(0, Math.min(1, (peak - 0.08) / 0.85));
    }
  }
  return grid;
}

function paintSees(grid) {
  const canvas = $("sees");
  const ctx = canvas.getContext("2d");
  const cell = canvas.width / GRID;
  ctx.fillStyle = "#081014";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let y = 0; y < GRID; y += 1) {
    for (let x = 0; x < GRID; x += 1) {
      const v = grid[y][x];
      ctx.fillStyle = `rgb(${Math.round(8 + 223 * v)}, ${Math.round(16 + 179 * v)}, ${Math.round(20 + 86 * v)})`;
      ctx.fillRect(x * cell + 1, y * cell + 1, cell - 2, cell - 2);
    }
  }
}

function setMode(mode) {
  state.mode = mode;
  document.body.classList.toggle("is-ask", mode === "ask");
  document.body.classList.toggle("is-teach", mode === "teach");
  document.body.classList.toggle("is-inspect", mode === "inspect");
  document.querySelectorAll(".mode").forEach((btn) => {
    btn.classList.toggle("is-on", btn.dataset.mode === mode);
  });
  if (mode === "inspect") {
    loadInspect();
    return;
  }
  $("pad-hint").textContent =
    mode === "teach"
      ? "Write a digit, pick its label, keep the page. Then run a lesson."
      : "Write a digit and release the mouse. The net reads; it does not learn.";
  highlightStep(mode === "ask" ? 1 : 0);
}

document.querySelectorAll(".mode").forEach((btn) => {
  btn.addEventListener("click", () => setMode(btn.dataset.mode));
});

const labelBox = $("labels");
for (let d = 0; d <= 9; d += 1) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = String(d);
  if (d === 0) b.classList.add("is-on");
  b.addEventListener("click", () => {
    state.label = d;
    [...labelBox.children].forEach((el) => el.classList.toggle("is-on", el === b));
  });
  labelBox.appendChild(b);
}

$("keep").addEventListener("click", async () => {
  if (!state.hasInk) {
    $("train-status").textContent = "Write something before keeping a page.";
    return;
  }
  $("keep").disabled = true;
  try {
    const res = await fetch("api/example", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pixels: readGrid(), label: state.label }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.detail || "Could not keep the page");
    fillCounts(body.counts, body.examples);
    $("train-status").textContent = `Kept a handwritten ${state.label}. Classroom is ${body.examples} pages.`;
    clearPad();
    paintSees(zeros());
  } catch (err) {
    $("train-status").textContent = err.message;
  } finally {
    $("keep").disabled = false;
  }
});

$("epochs").addEventListener("input", () => {
  $("epochs-read").textContent = `${$("epochs").value} epochs`;
});

$("train").addEventListener("click", async () => {
  $("train").disabled = true;
  $("train-status").textContent = "The classroom is being read again and again…";
  try {
    const res = await fetch("api/train", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ epochs: Number($("epochs").value), lr: 0.28 }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.detail || "Lesson failed");
    state.lastTrain = body;
    playLesson(body);
    loadInspect(false);
  } catch (err) {
    $("train-status").textContent = err.message;
  } finally {
    $("train").disabled = false;
  }
});

$("forget").addEventListener("click", async () => {
  await fetch("api/reset-model", { method: "POST" });
  state.lastTrain = null;
  state.templates = null;
  $("train-status").textContent = "Weights scrambled. Run a lesson before asking it to read well.";
  paintLoss([]);
  paintTemplates([]);
  $("guess-digit").textContent = "?";
  highlightStep(0);
  loadInspect(false);
});

$("read").addEventListener("click", () => inferNow());

async function inferNow() {
  if (!state.hasInk) {
    $("guess-note").textContent = "Write a digit first.";
    return;
  }
  const grid = readGrid();
  paintSees(grid);
  const res = await fetch("api/infer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pixels: grid }),
  });
  const body = await res.json();
  if (!res.ok) {
    $("guess-note").textContent = body.detail || "Could not read";
    return;
  }
  state.lastInfer = body;
  state.templates = body.templates;
  paintSees(body.grid);
  playInfer(body);
}

function playLesson(trace) {
  stopTimer();
  let i = 0;
  const tick = () => {
    const t = Math.min(1, i / (trace.losses.length - 1));
    paintLoss(trace.losses.slice(0, i + 1), trace.accs.slice(0, i + 1));
    paintTemplates(trace.templates[i]);
    highlightStep(i % 5);
    $("train-status").textContent =
      `Epoch ${i + 1}/${trace.epochs} · loss ${trace.losses[i].toFixed(2)} · classroom accuracy ${(trace.accs[i] * 100).toFixed(0)}%`;
    $("guess-note").textContent = i + 1 === trace.epochs ? trace.lesson : "Nudge, then read the classroom again.";
    i += 1;
    if (i >= trace.losses.length) {
      stopTimer();
      highlightStep(4);
      $("guess-digit").textContent = "✓";
    }
  };
  tick();
  state.timer = setInterval(tick, 220);
}

function playInfer(body) {
  stopTimer();
  highlightStep(1);
  let phase = 0;
  const tick = () => {
    paintNet(body.grid, body, phase);
    phase += 1;
    if (phase > 18) {
      stopTimer();
      $("guess-digit").textContent = String(body.guess);
      $("guess-note").textContent = `${body.note} Confidence ${(body.confidence * 100).toFixed(0)}%.`;
      paintTemplates(body.templates);
      highlightStep(1);
    }
  };
  tick();
  state.timer = setInterval(tick, 70);
}

function stopTimer() {
  if (state.timer != null) {
    clearInterval(state.timer);
    state.timer = null;
  }
}

function highlightStep(n) {
  document.querySelectorAll("#loop-steps li").forEach((li) => {
    li.classList.toggle("is-on", Number(li.dataset.step) === n);
  });
}

function paintLoss(losses, accs = []) {
  const canvas = $("loss");
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#081014";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#8aa09a";
  ctx.font = "12px ui-monospace, monospace";
  ctx.fillText("loss (amber) and accuracy (cyan)", 12, 18);
  if (losses.length < 2) return;
  const maxL = Math.max(...losses, 0.2);
  const line = (series, color, maxV) => {
    ctx.beginPath();
    series.forEach((v, i) => {
      const x = 16 + (i / Math.max(series.length - 1, 1)) * (canvas.width - 32);
      const y = canvas.height - 16 - (v / maxV) * (canvas.height - 40);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
  };
  line(losses, "#e6c36a", maxL);
  if (accs.length) line(accs, "#3db8c5", 1);
}

function paintTemplates(maps) {
  const canvas = $("templates");
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#081014";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!maps || !maps.length) return;
  const n = maps.length;
  const tile = Math.floor((canvas.width - 8) / n);
  maps.forEach((grid, i) => {
    const ox = 4 + i * tile;
    const cell = tile / 16;
    for (let y = 0; y < 16; y += 1) {
      for (let x = 0; x < 16; x += 1) {
        const v = grid[y][x];
        const pos = Math.max(0, v);
        const neg = Math.max(0, -v);
        ctx.fillStyle = `rgb(${Math.round(8 + 224 * neg)}, ${Math.round(16 + 77 * pos + 77 * neg)}, ${Math.round(20 + 181 * pos)})`;
        ctx.fillRect(ox + x * cell, 8 + y * cell, Math.max(cell - 0.4, 1), Math.max(cell - 0.4, 1));
      }
    }
  });
}

function paintNet(grid, infer, phase) {
  const canvas = $("net");
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#081014";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const showHidden = phase > 4;
  const showOut = phase > 10;
  const hidden = infer?.hidden || Array(20).fill(0);
  const probs = infer?.probs || Array(10).fill(0);

  // input grid
  const cell = 9;
  const gx = 18;
  const gy = 36;
  ctx.fillStyle = "#8aa09a";
  ctx.font = "11px ui-monospace, monospace";
  ctx.fillText("input 16×16", gx, 22);
  for (let y = 0; y < GRID; y += 1) {
    for (let x = 0; x < GRID; x += 1) {
      const v = grid[y][x] * Math.min(1, phase / 3);
      ctx.fillStyle = `rgb(${Math.round(8 + 223 * v)}, ${Math.round(16 + 179 * v)}, ${Math.round(20 + 86 * v)})`;
      ctx.fillRect(gx + x * cell, gy + y * cell, cell - 1, cell - 1);
    }
  }

  // hidden
  const hx = 210;
  hidden.forEach((h, i) => {
    const y = 28 + i * 21;
    ctx.beginPath();
    ctx.arc(hx, y, 7, 0, Math.PI * 2);
    const lit = showHidden ? Math.min(1, h / 2) : 0;
    ctx.fillStyle = `rgb(${Math.round(12 + 49 * lit)}, ${Math.round(20 + 164 * lit)}, ${Math.round(24 + 173 * lit)})`;
    ctx.fill();
    ctx.strokeStyle = "#8aa09a";
    ctx.stroke();
  });
  ctx.fillStyle = "#8aa09a";
  ctx.fillText("hidden", hx - 18, 450);

  // outputs
  const ox = 300;
  probs.forEach((p, i) => {
    const y = 40 + i * 40;
    const w = showOut ? 18 + 90 * p : 18;
    ctx.fillStyle = infer && showOut && i === infer.guess ? "#e85d4c" : "#3db8c5";
    ctx.fillRect(ox, y, w, 18);
    ctx.fillStyle = "#e7efe6";
    ctx.fillText(String(i), ox - 16, y + 13);
  });
}

function fillCounts(counts, total) {
  const box = $("counts");
  box.innerHTML = "";
  counts.forEach((n, d) => {
    const li = document.createElement("li");
    li.textContent = `${d} · ${n}`;
    box.appendChild(li);
  });
  $("class-count").textContent = `${total} pages`;
}

function heatColor(v) {
  const pos = Math.max(0, v);
  const neg = Math.max(0, -v);
  return `rgb(${Math.round(8 + 224 * neg)}, ${Math.round(16 + 77 * pos + 77 * neg)}, ${Math.round(20 + 181 * pos)})`;
}

function paintHeatmap(canvas, grid, pad = 0) {
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#081014";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!grid || !grid.length) return;
  const inner = Math.min(canvas.width, canvas.height) - pad * 2;
  const cell = inner / GRID;
  const ox = (canvas.width - inner) / 2;
  const oy = (canvas.height - inner) / 2;
  for (let y = 0; y < GRID; y += 1) {
    for (let x = 0; x < GRID; x += 1) {
      ctx.fillStyle = heatColor(grid[y][x]);
      ctx.fillRect(ox + x * cell, oy + y * cell, Math.max(cell - 0.4, 1), Math.max(cell - 0.4, 1));
    }
  }
}

function paintUnitGrid() {
  const canvas = $("unit-grid");
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#081014";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const hidden = state.inspect?.hidden || [];
  if (!hidden.length) return;
  const cols = 5;
  const rows = 4;
  const labelH = 16;
  const tileW = canvas.width / cols;
  const tileH = canvas.height / rows;
  hidden.forEach((unit, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const ox = col * tileW;
    const oy = row * tileH;
    const cell = (tileW - 10) / GRID;
    const gx = ox + 5;
    const gy = oy + labelH;
    for (let y = 0; y < GRID; y += 1) {
      for (let x = 0; x < GRID; x += 1) {
        ctx.fillStyle = heatColor(unit.template[y][x]);
        ctx.fillRect(gx + x * cell, gy + y * cell, Math.max(cell - 0.3, 1), Math.max(cell - 0.3, 1));
      }
    }
    ctx.font = "11px ui-monospace, monospace";
    ctx.fillStyle = i === state.unit ? "#e6c36a" : "#8aa09a";
    ctx.fillText(`H${i}`, ox + 6, oy + 12);
    if (i === state.unit) {
      ctx.strokeStyle = "#e6c36a";
      ctx.lineWidth = 2;
      ctx.strokeRect(ox + 2, oy + 2, tileW - 4, tileH - 4);
    }
  });
}

function paintVoteGrid() {
  const canvas = $("vote-grid");
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#081014";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const votes = state.inspect?.votes;
  if (!votes) return;
  const left = 28;
  const top = 10;
  const cellW = (canvas.width - left - 8) / HIDDEN;
  const cellH = (canvas.height - top - 8) / 10;
  let peak = 0.2;
  votes.forEach((row) => {
    row.forEach((v) => {
      peak = Math.max(peak, Math.abs(v));
    });
  });
  votes.forEach((row, d) => {
    const y = top + d * cellH;
    ctx.fillStyle = d === state.digit ? "#e6c36a" : "#8aa09a";
    ctx.font = "11px ui-monospace, monospace";
    ctx.fillText(String(d), 8, y + cellH * 0.7);
    row.forEach((v, i) => {
      const n = v / peak;
      ctx.fillStyle = heatColor(n);
      ctx.fillRect(left + i * cellW, y + 1, Math.max(cellW - 1, 1), Math.max(cellH - 2, 1));
      if (i === state.unit) {
        ctx.strokeStyle = "rgba(230, 195, 106, 0.85)";
        ctx.lineWidth = 1;
        ctx.strokeRect(left + i * cellW, y + 1, Math.max(cellW - 1, 1), Math.max(cellH - 2, 1));
      }
    });
    if (d === state.digit) {
      ctx.strokeStyle = "#e6c36a";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(left, y + 1, canvas.width - left - 8, Math.max(cellH - 2, 1));
    }
  });
}

function renderInspect() {
  const snap = state.inspect;
  if (!snap) return;
  $("inspect-story").textContent = snap.architecture?.story || "";
  $("template-legend").textContent = snap.legend?.template || $("template-legend").textContent;
  $("vote-legend").textContent = snap.legend?.votes || $("vote-legend").textContent;
  $("inspect-pill").textContent = snap.trained ? "trained · on disk" : snap.persisted ? "untrained · on disk" : "in memory";
  const acc = snap.metrics?.acc;
  const loss = snap.metrics?.loss;
  const when = snap.saved_at ? `${snap.saved_at.slice(0, 19).replace("T", " ")} UTC` : "not saved yet";
  $("inspect-status").textContent = snap.trained
    ? `Last lesson kept at ${when}. Classroom accuracy ${acc != null ? `${(acc * 100).toFixed(0)}%` : "—"}, loss ${loss != null ? loss.toFixed(2) : "—"}. Path ${snap.data_dir || "/data"}.`
    : `No lesson is stored yet. Templates below are still close to random. After you teach, weights land in ${snap.data_dir || "/data"}.`;
  const stats = snap.stats || {};
  $("inspect-stats").innerHTML = [
    ["hidden alive", `${stats.hidden_alive ?? "—"} / ${stats.hidden_total ?? HIDDEN}`],
    ["W1 RMS", stats.w1_rms != null ? stats.w1_rms.toFixed(3) : "—"],
    ["W2 RMS", stats.w2_rms != null ? stats.w2_rms.toFixed(3) : "—"],
    ["saved", snap.persisted ? "yes" : "no"],
  ]
    .map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`)
    .join("");

  const unit = snap.hidden?.[state.unit];
  if (unit) {
    $("unit-title").textContent = `Hidden unit ${unit.index}` + (unit.shape ? ` · ${unit.shape}` : "");
    $("unit-blurb").textContent = unit.blurb;
    const favor = (unit.votes_for || []).map((v) => `${v.digit} (${v.weight})`).join(", ") || "none yet";
    const against = (unit.votes_against || []).map((v) => `${v.digit} (${v.weight})`).join(", ") || "none yet";
    $("unit-votes").textContent = `Raises ${favor}. Suppresses ${against}. Bias ${unit.bias}.`;
    paintHeatmap($("unit-zoom"), unit.template, 8);
  }
  const digit = snap.digits?.[state.digit];
  if (digit) $("digit-blurb").textContent = digit.blurb;
  document.querySelectorAll("#digit-picks button").forEach((btn, i) => {
    btn.classList.toggle("is-on", i === state.digit);
  });
  paintUnitGrid();
  paintVoteGrid();
}

async function loadInspect(render = true) {
  const res = await fetch("api/inspect");
  const body = await res.json();
  state.inspect = body;
  state.templates = (body.hidden || []).slice(0, 8).map((unit) => unit.template);
  if (state.templates.length) paintTemplates(state.templates);
  if (render && state.mode === "inspect") renderInspect();
}

function gridIndex(event, canvas, cols, rows) {
  const rect = canvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;
  const col = Math.min(cols - 1, Math.max(0, Math.floor(x * cols)));
  const row = Math.min(rows - 1, Math.max(0, Math.floor(y * rows)));
  return { col, row };
}

$("unit-grid").addEventListener("click", (event) => {
  const { col, row } = gridIndex(event, $("unit-grid"), 5, 4);
  const i = row * 5 + col;
  if (i < HIDDEN) {
    state.unit = i;
    renderInspect();
  }
});

$("vote-grid").addEventListener("click", (event) => {
  const canvas = $("vote-grid");
  const rect = canvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;
  const left = 28 / canvas.width;
  const col = Math.min(HIDDEN - 1, Math.max(0, Math.floor(((x - left) / (1 - left)) * HIDDEN)));
  const row = Math.min(9, Math.max(0, Math.floor(y * 10)));
  state.unit = col;
  state.digit = row;
  renderInspect();
});

const digitBox = $("digit-picks");
for (let d = 0; d <= 9; d += 1) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = String(d);
  if (d === 0) b.classList.add("is-on");
  b.addEventListener("click", () => {
    state.digit = d;
    renderInspect();
  });
  digitBox.appendChild(b);
}

async function boot() {
  clearPad();
  paintSees(zeros());
  paintLoss([]);
  paintNet(zeros(), null, 0);
  setMode("teach");
  const stateRes = await fetch("api/state");
  const snap = await stateRes.json();
  fillCounts(snap.counts, snap.examples);
  if (snap.trained && snap.metrics) {
    $("train-status").textContent =
      `A lesson is already on disk · loss ${Number(snap.metrics.loss).toFixed(2)} · classroom accuracy ${(Number(snap.metrics.acc) * 100).toFixed(0)}%.`;
  }
  await loadInspect(false);
}

boot();
