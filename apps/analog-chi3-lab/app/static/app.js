const state = {
  run: null,
  frame: 1,
  timer: null,
};

const $ = (id) => document.getElementById(id);

function fmt(n) {
  if (n == null || Number.isNaN(n)) return "—";
  if (!Number.isFinite(n)) return "∞";
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}e9`;
  if (n >= 1e6) return n.toExponential(2);
  if (Number.isInteger(n) || Math.abs(n) >= 100) return Math.round(n).toLocaleString();
  return n.toFixed(2);
}

function showTab(name) {
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("is-on", b.dataset.tab === name));
  document.querySelectorAll("main .panel").forEach((p) => {
    p.classList.toggle("is-on", p.id === `panel-${name}`);
  });
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

$("n").addEventListener("input", () => {
  $("n-readout").textContent = $("n").value;
});
$("field-size").addEventListener("input", () => {
  $("field-size-readout").textContent = `${$("field-size").value}×${$("field-size").value}`;
});
$("gamma").addEventListener("input", () => {
  $("gamma-readout").textContent = Number($("gamma").value).toFixed(1);
});

$("run").addEventListener("click", async () => {
  $("run").disabled = true;
  $("status").textContent = "Pumping the analog fabric and walking the digital graph…";
  try {
    const n = Number($("n").value);
    const method = $("digital-method").value;
    if (method === "brute" && n > 18) {
      throw new Error("Brute force is limited to N ≤ 18. Lower N or pick Metropolis.");
    }
    const body = {
      instance: { kind: $("kind").value, n, seed: Number($("seed").value) },
      analog: {
        steps: n > 48 ? 520 : 420,
        pump_end: Number($("pump").value),
        coupling: Number($("coupling").value),
        noise: Number($("noise").value),
        seed: Number($("seed").value) + 11,
      },
      digital: {
        method,
        steps: method === "brute" ? null : n * 20,
        seed: Number($("seed").value) + 3,
      },
    };
    const res = await fetch("api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || "Run failed");
    }
    stopPlay();
    state.run = await res.json();
    state.frame = 0;
    fillMetrics(state.run);
    $("scrub").disabled = false;
    $("scrub").value = "0";
    $("status").textContent = "Relaxation captured. Playing analog and digital side by side.";
    drawAll(0);
    play();
  } catch (err) {
    $("status").textContent = err.message;
  } finally {
    $("run").disabled = false;
  }
});

$("scrub").addEventListener("input", () => {
  if (!state.run) return;
  stopPlay();
  state.frame = Number($("scrub").value) / 100;
  drawAll(state.frame);
});

$("run-field").addEventListener("click", async () => {
  $("run-field").disabled = true;
  $("field-status").textContent = "Propagating through the analog slab…";
  try {
    const res = await fetch("api/field", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        size: Number($("field-size").value),
        gamma: Number($("gamma").value),
        pattern: $("field-pattern").value,
        seed: 3,
      }),
    });
    if (!res.ok) throw new Error("Field run failed");
    const data = await res.json();
    paintField($("f-in"), data.input, "input");
    paintField($("f-mix"), data.mixed, "mix");
    paintField($("f-phase"), data.phase, "phase");
    paintField($("f-out"), data.output, "out");
    $("f-pix").textContent = fmt(data.pixels);
    $("f-inst").textContent = fmt(data.analog_instants);
    $("f-flops").textContent = fmt(data.digital_flops);
    $("field-status").textContent =
      `${data.pixels} pixels received a χ³ phase in ${data.analog_instants} analog instants.`;
  } catch (err) {
    $("field-status").textContent = err.message;
  } finally {
    $("run-field").disabled = false;
  }
});

function fillMetrics(run) {
  const v = run.analog.volume;
  $("m-space").textContent = v.configuration_space === Infinity ? `2^${run.instance.n}` : fmt(v.configuration_space);
  $("m-pair").textContent = fmt(v.pairwise_couplings);
  $("m-serial").textContent = fmt(v.equivalent_serial_ops);
  $("m-digital").textContent = fmt(run.digital.updates);
  $("m-acut").textContent = fmt(run.analog.best_cut);
  $("m-dcut").textContent = fmt(run.digital.best_cut);
  $("m-max").textContent = fmt(run.comparison.max_possible_cut);
  $("lesson").textContent = run.comparison.lesson;
  $("analog-badge").textContent = `${run.instance.n} oscillators`;
  $("digital-badge").textContent = run.digital.method;
}

function stopPlay() {
  if (state.timer != null) {
    clearInterval(state.timer);
    state.timer = null;
  }
}

function play() {
  stopPlay();
  const started = performance.now();
  const duration = 5200;
  const tick = () => {
    const t = Math.min(1, (performance.now() - started) / duration);
    state.frame = t;
    $("scrub").value = String(Math.round(t * 100));
    drawAll(t);
    if (t >= 1) stopPlay();
  };
  tick();
  state.timer = setInterval(tick, 40);
}

function drawAll(t) {
  const run = state.run;
  if (!run || !run.analog?.amplitudes?.length || !run.digital?.spins?.length) return;
  const analogIdx = Math.min(run.analog.amplitudes.length - 1, Math.floor(t * (run.analog.amplitudes.length - 1)));
  const digitalIdx = Math.min(run.digital.spins.length - 1, Math.floor(t * (run.digital.spins.length - 1)));
  const analogAmps = t >= 0.999 ? run.analog.final_amplitudes : run.analog.amplitudes[analogIdx];
  drawGraph($("analog-graph"), run.instance, analogAmps, true, analogIdx);
  drawGraph($("digital-graph"), run.instance, run.digital.spins[digitalIdx], false, digitalIdx);
  drawEnergy(t);
  $("analog-caption").textContent =
    `Instant ${Math.round(t * run.analog.steps)} · cut ${fmt(run.analog.cuts[Math.min(run.analog.cuts.length - 1, Math.round(t * (run.analog.cuts.length - 1)))])}`;
  $("digital-caption").textContent =
    `Tick ${digitalIdx + 1} / ${run.digital.spins.length} · cut ${fmt(run.digital.cuts[digitalIdx])}`;
}

function drawGraph(canvas, instance, values, analog, tick) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#09060b";
  ctx.fillRect(0, 0, w, h);
  const pad = 36;
  const pos = instance.positions.map(([x, y]) => [
    pad + ((x + 1) / 2) * (w - pad * 2),
    pad + ((y + 1) / 2) * (h - pad * 2),
  ]);

  for (const e of instance.edges) {
    const a = pos[e.source];
    const b = pos[e.target];
    const sa = Math.sign(values[e.source] || 0) || 1;
    const sb = Math.sign(values[e.target] || 0) || 1;
    const cut = sa !== sb;
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.strokeStyle = cut ? "rgba(62, 224, 212, 0.42)" : "rgba(255, 77, 141, 0.28)";
    ctx.lineWidth = 0.8 + e.weight;
    ctx.stroke();
  }

  values.forEach((amp, i) => {
    const [x, y] = pos[i];
    const spin = amp >= 0 ? 1 : -1;
    const mag = analog ? Math.tanh(Math.abs(amp) * 1.6) : 1;
    const r = 5.5 + 5.5 * mag;
    ctx.beginPath();
    ctx.arc(x, y, 7.5, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(246, 234, 215, 0.28)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, r + 2, 0, Math.PI * 2);
    ctx.fillStyle = spin > 0 ? `rgba(62, 224, 212, ${0.12 + 0.2 * mag})` : `rgba(255, 77, 141, ${0.12 + 0.2 * mag})`;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = spin > 0 ? "#3ee0d4" : "#ff4d8d";
    ctx.globalAlpha = 0.45 + 0.55 * mag;
    ctx.fill();
    ctx.globalAlpha = 1;
    if (!analog && i === tick % instance.n) {
      ctx.strokeStyle = "#d4f25a";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  });
}

function drawEnergy(t) {
  const canvas = $("energy");
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#09060b";
  ctx.fillRect(0, 0, w, h);
  const analog = state.run.analog.cuts;
  const digital = state.run.digital.cuts;
  const maxCut = Math.max(
    state.run.comparison.max_possible_cut,
    ...analog,
    ...digital,
  );
  const plot = (series, color, upto) => {
    ctx.beginPath();
    series.slice(0, upto).forEach((y, i) => {
      const x = 16 + (i / Math.max(series.length - 1, 1)) * (w - 32);
      const py = h - 18 - (y / (maxCut || 1)) * (h - 36);
      if (i === 0) ctx.moveTo(x, py);
      else ctx.lineTo(x, py);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
  };
  plot(analog, "#3ee0d4", Math.max(2, Math.floor(t * analog.length)));
  plot(digital, "#ffb020", Math.max(2, Math.floor(t * digital.length)));
  ctx.font = "12px ui-monospace, monospace";
  ctx.fillStyle = "#3ee0d4";
  ctx.fillText("analog cut", 20, 18);
  ctx.fillStyle = "#ffb020";
  ctx.fillText("digital cut", 120, 18);
}

function paintField(canvas, grid, kind) {
  const ctx = canvas.getContext("2d");
  const n = grid.length;
  const img = ctx.createImageData(canvas.width, canvas.height);
  const palettes = {
    input: [80, 200, 210],
    mix: [80, 160, 255],
    phase: [255, 70, 150],
    out: [220, 240, 90],
  };
  const [r0, g0, b0] = palettes[kind];
  for (let y = 0; y < canvas.height; y += 1) {
    const gy = Math.min(n - 1, Math.floor((y / canvas.height) * n));
    for (let x = 0; x < canvas.width; x += 1) {
      const gx = Math.min(n - 1, Math.floor((x / canvas.width) * n));
      const v = grid[gy][gx];
      const i = (y * canvas.width + x) * 4;
      img.data[i] = Math.round(r0 * v);
      img.data[i + 1] = Math.round(g0 * v);
      img.data[i + 2] = Math.round(b0 * v);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

drawEmpty($("analog-graph"), "waiting for analog amplitudes");
drawEmpty($("digital-graph"), "waiting for digital walk");

function drawEmpty(canvas, label) {
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#09060b";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#b6a28c";
  ctx.font = "16px Georgia, serif";
  ctx.fillText(label, 24, canvas.height / 2);
}
