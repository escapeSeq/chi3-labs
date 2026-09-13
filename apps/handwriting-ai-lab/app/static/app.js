const GRID = 16;
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
};

const $ = (id) => document.getElementById(id);
const pad = $("pad");
const pctx = pad.getContext("2d");

function clearPad() {
  pctx.fillStyle = "#fffaf0";
  pctx.fillRect(0, 0, pad.width, pad.height);
  // faint notebook cross
  pctx.strokeStyle = "rgba(42, 75, 124, 0.08)";
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
  pctx.strokeStyle = "#1d2430";
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
          const darkness = 1 - (data[i] + data[i + 1] + data[i + 2]) / (3 * 255);
          if (darkness > peak) peak = darkness;
        }
      }
      grid[y][x] = Math.max(0, Math.min(1, peak));
    }
  }
  return grid;
}

function paintSees(grid) {
  const canvas = $("sees");
  const ctx = canvas.getContext("2d");
  const cell = canvas.width / GRID;
  ctx.fillStyle = "#243126";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let y = 0; y < GRID; y += 1) {
    for (let x = 0; x < GRID; x += 1) {
      const v = grid[y][x];
      ctx.fillStyle = `rgb(${Math.round(36 + 210 * v)}, ${Math.round(48 + 200 * v)}, ${Math.round(40 + 160 * v)})`;
      ctx.fillRect(x * cell + 1, y * cell + 1, cell - 2, cell - 2);
    }
  }
}

function setMode(mode) {
  state.mode = mode;
  document.body.classList.toggle("is-ask", mode === "ask");
  document.body.classList.toggle("is-teach", mode === "teach");
  document.querySelectorAll(".mode").forEach((btn) => {
    btn.classList.toggle("is-on", btn.dataset.mode === mode);
  });
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
    const res = await fetch("/api/example", {
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
    const res = await fetch("/api/train", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ epochs: Number($("epochs").value), lr: 0.28 }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.detail || "Lesson failed");
    state.lastTrain = body;
    playLesson(body);
  } catch (err) {
    $("train-status").textContent = err.message;
  } finally {
    $("train").disabled = false;
  }
});

$("forget").addEventListener("click", async () => {
  await fetch("/api/reset-model", { method: "POST" });
  state.lastTrain = null;
  state.templates = null;
  $("train-status").textContent = "Weights scrambled. Run a lesson before asking it to read well.";
  paintLoss([]);
  paintTemplates([]);
  $("guess-digit").textContent = "?";
  highlightStep(0);
});

$("read").addEventListener("click", () => inferNow());

async function inferNow() {
  if (!state.hasInk) {
    $("guess-note").textContent = "Write a digit first.";
    return;
  }
  const grid = readGrid();
  paintSees(grid);
  const res = await fetch("/api/infer", {
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
  ctx.fillStyle = "#243126";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#f3ead3";
  ctx.font = "12px ui-monospace, monospace";
  ctx.fillText("loss (chalk) and accuracy (leaf)", 12, 18);
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
  line(losses, "#f3ead3", maxL);
  if (accs.length) line(accs, "#8fd4a2", 1);
}

function paintTemplates(maps) {
  const canvas = $("templates");
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#243126";
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
        ctx.fillStyle = `rgb(${Math.round(36 + 200 * neg)}, ${Math.round(48 + 170 * pos)}, ${Math.round(40 + 40 * pos)})`;
        ctx.fillRect(ox + x * cell, 8 + y * cell, Math.max(cell - 0.4, 1), Math.max(cell - 0.4, 1));
      }
    }
  });
}

function paintNet(grid, infer, phase) {
  const canvas = $("net");
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#243126";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const showHidden = phase > 4;
  const showOut = phase > 10;
  const hidden = infer?.hidden || Array(20).fill(0);
  const probs = infer?.probs || Array(10).fill(0);

  // input grid
  const cell = 9;
  const gx = 18;
  const gy = 36;
  ctx.fillStyle = "#f3ead3";
  ctx.font = "11px ui-monospace, monospace";
  ctx.fillText("input 16×16", gx, 22);
  for (let y = 0; y < GRID; y += 1) {
    for (let x = 0; x < GRID; x += 1) {
      const v = grid[y][x] * Math.min(1, phase / 3);
      ctx.fillStyle = `rgb(${Math.round(40 + 200 * v)}, ${Math.round(50 + 190 * v)}, ${Math.round(42 + 150 * v)})`;
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
    ctx.fillStyle = `rgb(${Math.round(40 + 80 * lit)}, ${Math.round(70 + 160 * lit)}, ${Math.round(70 + 80 * lit)})`;
    ctx.fill();
    ctx.strokeStyle = "#f3ead3";
    ctx.stroke();
  });
  ctx.fillStyle = "#f3ead3";
  ctx.fillText("hidden", hx - 18, 450);

  // outputs
  const ox = 300;
  probs.forEach((p, i) => {
    const y = 40 + i * 40;
    const w = showOut ? 18 + 90 * p : 18;
    ctx.fillStyle = infer && showOut && i === infer.guess ? "#d45a4c" : "#8fd4a2";
    ctx.fillRect(ox, y, w, 18);
    ctx.fillStyle = "#f3ead3";
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

async function boot() {
  clearPad();
  paintSees(zeros());
  paintLoss([]);
  paintNet(zeros(), null, 0);
  setMode("teach");
  const stateRes = await fetch("/api/state");
  const snap = await stateRes.json();
  fillCounts(snap.counts, snap.examples);
}

boot();
