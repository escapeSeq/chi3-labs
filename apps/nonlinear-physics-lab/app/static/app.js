const $ = (id) => document.getElementById(id);

const F1 = 1.0;
const F2 = 1.625;
const SAMPLES = 512;
const DURATION = 8.0;

const state = {
  tab: "drive",
  phase: 0,
  satX: 0.08,
  satTrail: [],
  satT: 0,
};

function showTab(name) {
  state.tab = name;
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("is-on", b.dataset.tab === name));
  document.querySelectorAll("main .panel").forEach((p) => {
    p.classList.toggle("is-on", p.id === `panel-${name}`);
  });
  if (location.hash.slice(1) !== name) {
    history.replaceState(null, "", `#${name}`);
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

function fmt(n, digits = 2) {
  if (n == null || Number.isNaN(n)) return "—";
  if (!Number.isFinite(n)) return "∞";
  const abs = Math.abs(n);
  if (abs !== 0 && abs < 0.005) return "0";
  if (abs >= 100) return Math.round(n).toString();
  return n.toFixed(digits);
}

function polarize(E, chi1, chi2, chi3) {
  return chi1 * E + chi2 * E * E + chi3 * E * E * E;
}

function driveKnobs() {
  return {
    chi1: Number($("chi1").value),
    chi2: Number($("chi2").value),
    chi3: Number($("chi3").value),
    amp: Number($("amp").value),
    second: $("second-tone").checked,
  };
}

function constitutiveText(chi1, chi2, chi3) {
  const bits = [`${fmt(chi1)} E`];
  if (Math.abs(chi2) >= 0.005) bits.push(`${chi2 < 0 ? "−" : "+"} ${fmt(Math.abs(chi2))} E²`);
  if (Math.abs(chi3) >= 0.005) bits.push(`${chi3 < 0 ? "−" : "+"} ${fmt(Math.abs(chi3))} E³`);
  return `P = ${bits.join(" ")}`;
}

function waveform(knobs, phase) {
  const field = new Float64Array(SAMPLES);
  const response = new Float64Array(SAMPLES);
  const linear = new Float64Array(SAMPLES);
  const t = new Float64Array(SAMPLES);
  const b = knobs.second ? 0.85 * knobs.amp : 0;
  for (let i = 0; i < SAMPLES; i += 1) {
    const ti = (i / SAMPLES) * DURATION;
    t[i] = ti;
    const E =
      knobs.amp * Math.sin(2 * Math.PI * F1 * ti + phase) +
      b * Math.sin(2 * Math.PI * F2 * ti + phase * 0.7);
    field[i] = E;
    response[i] = polarize(E, knobs.chi1, knobs.chi2, knobs.chi3);
    linear[i] = knobs.chi1 * E;
  }
  return { t, field, response, linear, b };
}

function rfftMags(signal) {
  const n = signal.length;
  const bins = 72;
  const mag = new Float64Array(bins);
  for (let k = 0; k < bins; k += 1) {
    let re = 0;
    let im = 0;
    const step = (2 * Math.PI * k) / n;
    for (let i = 0; i < n; i += 1) {
      const v = signal[i];
      re += v * Math.cos(step * i);
      im -= v * Math.sin(step * i);
    }
    let m = (2 / n) * Math.hypot(re, im);
    if (k === 0) m *= 0.5;
    mag[k] = m;
  }
  return mag;
}

function binFreq(k) {
  return k / DURATION;
}

function peakNear(mag, freq, radius = 0.14) {
  let best = 0;
  for (let k = 0; k < mag.length; k += 1) {
    if (Math.abs(binFreq(k) - freq) <= radius) best = Math.max(best, mag[k]);
  }
  return best;
}

function superpositionError(knobs) {
  if (!knobs.second) return 0;
  const { field, response } = waveform(knobs, 0);
  const p1 = new Float64Array(SAMPLES);
  const p2 = new Float64Array(SAMPLES);
  for (let i = 0; i < SAMPLES; i += 1) {
    const e1 = knobs.amp * Math.sin(2 * Math.PI * F1 * (i / SAMPLES) * DURATION);
    const e2 = 0.85 * knobs.amp * Math.sin(2 * Math.PI * F2 * (i / SAMPLES) * DURATION);
    p1[i] = polarize(e1, knobs.chi1, knobs.chi2, knobs.chi3);
    p2[i] = polarize(e2, knobs.chi1, knobs.chi2, knobs.chi3);
  }
  let num = 0;
  let den = 0;
  for (let i = 0; i < SAMPLES; i += 1) {
    const gap = response[i] - (p1[i] + p2[i]);
    num += gap * gap;
    den += response[i] * response[i];
  }
  return Math.sqrt(num) / (Math.sqrt(den) + 1e-12);
}

function driveLesson(knobs, mixErr) {
  const nonlinear = Math.abs(knobs.chi2) > 0.01 || Math.abs(knobs.chi3) > 0.01;
  if (!nonlinear) {
    return knobs.second
      ? `Two drives in a linear medium stay two drives. Superposition holds (mix error ${mixErr.toExponential(1)}). Turn on χ² or χ³ to watch the field multiply itself.`
      : "Linear medium: P is a scaled copy of E. The spectrum has only the drive. Superposition still holds — add a second tone and nothing new appears.";
  }
  const bits = [];
  if (Math.abs(knobs.chi2) > 0.01) bits.push("χ² squares the field: DC, 2ω, and (with two tones) sum and difference");
  if (Math.abs(knobs.chi3) > 0.01) bits.push("χ³ cubes the field: 3ω, Kerr at ω, and four-wave mixing");
  const head = knobs.second ? "Two-tone analog multiply. " : "One-tone analog multiply. ";
  const mix = knobs.second ? " Superposition has already failed." : "";
  return head + bits.join("; ") + "." + mix;
}

function syncDriveReadouts() {
  const knobs = driveKnobs();
  $("chi1-read").textContent = fmt(knobs.chi1);
  $("chi2-read").textContent = fmt(knobs.chi2);
  $("chi3-read").textContent = fmt(knobs.chi3);
  $("amp-read").textContent = fmt(knobs.amp);
  $("constitutive").textContent = constitutiveText(knobs.chi1, knobs.chi2, knobs.chi3);
  const kind =
    Math.abs(knobs.chi2) < 0.01 && Math.abs(knobs.chi3) < 0.01
      ? "linear"
      : Math.abs(knobs.chi2) >= Math.abs(knobs.chi3)
        ? "quadratic"
        : "cubic";
  $("curve-badge").textContent = kind;
  $("spec-badge").textContent = knobs.second ? "two tones" : "one tone";
}

["chi1", "chi2", "chi3", "amp"].forEach((id) => {
  $(id).addEventListener("input", syncDriveReadouts);
});
$("second-tone").addEventListener("change", syncDriveReadouts);

document.querySelectorAll("[data-preset]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const preset = btn.dataset.preset;
    const map = {
      linear: { chi1: 1, chi2: 0, chi3: 0, amp: 1.15, second: false },
      doubler: { chi1: 0.35, chi2: 0.7, chi3: 0, amp: 1.2, second: false },
      kerr: { chi1: 0.45, chi2: 0, chi3: 0.5, amp: 1.2, second: false },
      mixer: { chi1: 0.35, chi2: 0.7, chi3: 0, amp: 1.05, second: true },
    }[preset];
    if (!map) return;
    $("chi1").value = String(map.chi1);
    $("chi2").value = String(map.chi2);
    $("chi3").value = String(map.chi3);
    $("amp").value = String(map.amp);
    $("second-tone").checked = map.second;
    syncDriveReadouts();
  });
});

function clearCanvas(ctx, canvas) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function axes(ctx, canvas, pad) {
  ctx.strokeStyle = "rgba(231, 239, 230, 0.12)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad, canvas.height / 2);
  ctx.lineTo(canvas.width - pad, canvas.height / 2);
  ctx.moveTo(canvas.width / 2, pad);
  ctx.lineTo(canvas.width / 2, canvas.height - pad);
  ctx.stroke();
}

function plotSeries(ctx, xs, ys, x0, x1, y0, y1, canvas, pad, color, dash) {
  ctx.save();
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.7;
  if (dash) ctx.setLineDash(dash);
  let started = false;
  for (let i = 0; i < xs.length; i += 1) {
    const x = pad + ((xs[i] - x0) / (x1 - x0)) * (canvas.width - 2 * pad);
    const y = canvas.height - pad - ((ys[i] - y0) / (y1 - y0)) * (canvas.height - 2 * pad);
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();
}

function drawTransfer(knobs, eNow) {
  const canvas = $("transfer");
  const ctx = canvas.getContext("2d");
  clearCanvas(ctx, canvas);
  const pad = 28;
  const eMax = Math.max(1.45, knobs.amp * 1.25);
  const n = 220;
  const eAxis = [];
  const pAxis = [];
  const lin = [];
  for (let i = 0; i < n; i += 1) {
    const e = -eMax + (2 * eMax * i) / (n - 1);
    eAxis.push(e);
    pAxis.push(polarize(e, knobs.chi1, knobs.chi2, knobs.chi3));
    lin.push(knobs.chi1 * e);
  }
  const pMax = Math.max(1.1, ...pAxis.map(Math.abs), ...lin.map(Math.abs));
  axes(ctx, canvas, pad);
  const xs = eAxis;
  plotSeries(ctx, xs, lin, -eMax, eMax, -pMax, pMax, canvas, pad, "rgba(231, 239, 230, 0.28)", [5, 4]);
  plotSeries(ctx, xs, pAxis, -eMax, eMax, -pMax, pMax, canvas, pad, "#e6c36a");
  const pNow = polarize(eNow, knobs.chi1, knobs.chi2, knobs.chi3);
  const x = pad + ((eNow + eMax) / (2 * eMax)) * (canvas.width - 2 * pad);
  const y = canvas.height - pad - ((pNow + pMax) / (2 * pMax)) * (canvas.height - 2 * pad);
  ctx.fillStyle = "#3db8c5";
  ctx.beginPath();
  ctx.arc(x, y, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(138, 160, 154, 0.9)";
  ctx.font = "11px ui-monospace, SF Mono, Menlo, monospace";
  ctx.fillText("E", canvas.width - 22, canvas.height / 2 - 6);
  ctx.fillText("P", canvas.width / 2 + 6, 18);
}

function drawScope(wave) {
  const canvas = $("scope");
  const ctx = canvas.getContext("2d");
  clearCanvas(ctx, canvas);
  const pad = 22;
  const yMax = Math.max(
    0.8,
    ...wave.field.map(Math.abs),
    ...wave.response.map(Math.abs),
    ...wave.linear.map(Math.abs)
  );
  const xs = Array.from(wave.t);
  const mid = canvas.height / 2;
  ctx.strokeStyle = "rgba(231, 239, 230, 0.1)";
  ctx.beginPath();
  ctx.moveTo(pad, pad);
  ctx.lineTo(canvas.width - pad, pad);
  ctx.moveTo(pad, mid);
  ctx.lineTo(canvas.width - pad, mid);
  ctx.moveTo(pad, canvas.height - pad);
  ctx.lineTo(canvas.width - pad, canvas.height - pad);
  ctx.stroke();
  ctx.fillStyle = "rgba(138, 160, 154, 0.85)";
  ctx.font = "11px ui-monospace, SF Mono, Menlo, monospace";
  ctx.fillText("E", pad + 4, pad + 12);
  ctx.fillText("P", pad + 4, mid + 12);
  const topPad = pad;
  const band = (canvas.height - 2 * pad) / 2;
  const plotBand = (ys, y0, color, dash) => {
    ctx.save();
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.7;
    if (dash) ctx.setLineDash(dash);
    for (let i = 0; i < xs.length; i += 1) {
      const x = pad + (xs[i] / DURATION) * (canvas.width - 2 * pad);
      const y = y0 + band / 2 - (ys[i] / (yMax * 1.15)) * (band / 2 - 8);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();
  };
  plotBand(Array.from(wave.field), topPad, "#3db8c5");
  plotBand(Array.from(wave.linear), mid, "rgba(231, 239, 230, 0.3)", [4, 4]);
  plotBand(Array.from(wave.response), mid, "#e6c36a");
}

function spectrumLines(knobs) {
  const lines = [];
  const chi1 = Math.abs(knobs.chi1) > 0.01;
  const chi2 = Math.abs(knobs.chi2) > 0.01;
  const chi3 = Math.abs(knobs.chi3) > 0.01;
  if (chi1) {
    lines.push({ f: F1, label: "ω₁" });
    if (knobs.second) lines.push({ f: F2, label: "ω₂" });
  }
  if (chi2) {
    lines.push({ f: 0, label: "DC" });
    lines.push({ f: 2 * F1, label: "2ω₁" });
    if (knobs.second) {
      lines.push({ f: 2 * F2, label: "2ω₂" });
      lines.push({ f: F1 + F2, label: "ω₁+ω₂" });
      lines.push({ f: Math.abs(F1 - F2), label: "ω₁−ω₂" });
    }
  }
  if (chi3) {
    lines.push({ f: 3 * F1, label: "3ω₁" });
    if (knobs.second) {
      lines.push({ f: 3 * F2, label: "3ω₂" });
      lines.push({ f: 2 * F1 - F2, label: "2ω₁−ω₂" });
      lines.push({ f: 2 * F2 - F1, label: "2ω₂−ω₁" });
    }
  }
  return lines.filter((line) => line.f >= -0.01 && line.f < 8.5);
}

function drawSpectrum(knobs, wave) {
  const canvas = $("spectrum");
  const ctx = canvas.getContext("2d");
  clearCanvas(ctx, canvas);
  const magE = rfftMags(wave.field);
  const magP = rfftMags(wave.response);
  const pad = 28;
  const fMax = 6;
  const kMax = Math.min(magP.length - 1, Math.floor(fMax * DURATION));
  let yMax = 0.15;
  for (let k = 0; k <= kMax; k += 1) yMax = Math.max(yMax, magE[k], magP[k]);
  ctx.strokeStyle = "rgba(231, 239, 230, 0.1)";
  ctx.beginPath();
  ctx.moveTo(pad, canvas.height - pad);
  ctx.lineTo(canvas.width - pad, canvas.height - pad);
  ctx.stroke();
  const width = canvas.width - 2 * pad;
  const xs = [];
  const ys = [];
  for (let k = 0; k <= kMax; k += 1) {
    xs.push(binFreq(k));
    ys.push(magP[k]);
  }
  plotSeries(ctx, xs, ys, 0, fMax, 0, yMax, canvas, pad, "rgba(230, 195, 106, 0.35)");
  const stem = (freq, mag, color, dx) => {
    const x = pad + (freq / fMax) * width + dx;
    const h = (mag / yMax) * (canvas.height - 2 * pad);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, canvas.height - pad);
    ctx.lineTo(x, canvas.height - pad - h);
    ctx.stroke();
    ctx.lineWidth = 1;
  };
  for (let k = 0; k <= kMax; k += 1) {
    if (magE[k] < 0.08 * yMax && magP[k] < 0.08 * yMax) continue;
    stem(binFreq(k), magE[k], "rgba(61, 184, 197, 0.7)", -2);
    stem(binFreq(k), magP[k], "#e6c36a", 2);
  }
  ctx.fillStyle = "rgba(230, 195, 106, 0.9)";
  ctx.font = "11px ui-monospace, SF Mono, Menlo, monospace";
  const used = [];
  spectrumLines(knobs).forEach((line) => {
    const amp = peakNear(magP, line.f);
    if (amp < 0.06 * yMax && line.f !== 0) return;
    const x = pad + (line.f / fMax) * width;
    if (used.some((u) => Math.abs(u - x) < 28)) return;
    used.push(x);
    ctx.fillText(line.label, x - 10, 16);
  });
  return magP;
}

function updateDriveMeters(knobs, magP, mixErr) {
  $("m-mix").textContent = mixErr < 0.008 ? "0 (linear)" : fmt(mixErr, 3);
  $("m-dc").textContent = fmt(peakNear(magP, 0));
  $("m-2").textContent = fmt(peakNear(magP, 2 * F1));
  $("m-3").textContent = fmt(peakNear(magP, 3 * F1));
  if (knobs.second) {
    const sum = peakNear(magP, F1 + F2);
    const diff = peakNear(magP, Math.abs(F1 - F2));
    $("m-sum").textContent = `${fmt(sum)} / ${fmt(diff)}`;
  } else {
    $("m-sum").textContent = "—";
  }
  $("drive-lesson").textContent = driveLesson(knobs, mixErr);
}

function drawDrive(phase) {
  const knobs = driveKnobs();
  const wave = waveform(knobs, phase);
  const eNow = wave.field[0];
  drawTransfer(knobs, eNow);
  drawScope(wave);
  const magP = drawSpectrum(knobs, wave);
  const mixErr = superpositionError(knobs);
  updateDriveMeters(knobs, magP, mixErr);
}

function kerrKnobs() {
  return {
    n2: Number($("n2").value),
    waist: Number($("waist").value),
    amp: Number($("kerr-amp").value),
  };
}

function syncKerrReadouts() {
  const k = kerrKnobs();
  $("n2-read").textContent = fmt(k.n2);
  $("waist-read").textContent = fmt(k.waist);
  $("kerr-amp-read").textContent = fmt(k.amp);
}

["n2", "waist", "kerr-amp"].forEach((id) => {
  $(id).addEventListener("input", syncKerrReadouts);
});

function drawKerr(phase) {
  const k = kerrKnobs();
  const n = 320;
  const xs = [];
  const intensity = [];
  const envelope = [];
  const kerrPhase = [];
  const carrier = [];
  const linear = [];
  for (let i = 0; i < n; i += 1) {
    const x = -1 + (2 * i) / (n - 1);
    const env = k.amp * Math.exp(-((x / k.waist) ** 2));
    const I = env * env;
    const phi = k.n2 * I;
    xs.push(x);
    envelope.push(env);
    intensity.push(I);
    kerrPhase.push(phi);
    const arg = 8 * Math.PI * x - phase * 3 + phi;
    carrier.push(env * Math.cos(arg));
    linear.push(env * Math.cos(8 * Math.PI * x - phase * 3));
  }
  const profiles = $("kerr-profiles");
  const ctx = profiles.getContext("2d");
  clearCanvas(ctx, profiles);
  const pad = 26;
  const iMax = Math.max(0.2, ...intensity);
  const iNorm = intensity.map((v) => v / (iMax || 1));
  const pShift = kerrPhase.map((v) => v - Math.min(...kerrPhase));
  const pSpan = Math.max(1e-9, ...pShift);
  const pNorm = pShift.map((v) => v / pSpan);
  ctx.beginPath();
  const x0 = pad;
  const x1 = profiles.width - pad;
  const yBase = profiles.height - pad;
  const yTop = pad;
  ctx.moveTo(x0, yBase);
  for (let i = 0; i < xs.length; i += 1) {
    const x = pad + ((xs[i] + 1) / 2) * (profiles.width - 2 * pad);
    const y = yBase - (iNorm[i] / 1.15) * (yBase - yTop);
    ctx.lineTo(x, y);
  }
  ctx.lineTo(x1, yBase);
  ctx.closePath();
  ctx.fillStyle = "rgba(61, 184, 197, 0.28)";
  ctx.fill();
  plotSeries(ctx, xs, iNorm, -1, 1, -0.05, 1.15, profiles, pad, "#3db8c5");
  plotSeries(ctx, xs, pNorm, -1, 1, -0.05, 1.15, profiles, pad, "#e6c36a");
  ctx.fillStyle = "rgba(138, 160, 154, 0.9)";
  ctx.font = "11px ui-monospace, SF Mono, Menlo, monospace";
  ctx.fillText("I(x) teal · φ(x) amber", pad, 18);

  const car = $("kerr-carrier");
  const cctx = car.getContext("2d");
  clearCanvas(cctx, car);
  const cMax = Math.max(0.4, ...envelope);
  plotSeries(cctx, xs, linear, -1, 1, -cMax, cMax, car, pad, "rgba(231, 239, 230, 0.28)", [4, 4]);
  plotSeries(cctx, xs, carrier, -1, 1, -cMax, cMax, car, pad, "#e6c36a");

  const peakI = Math.max(...intensity);
  const span = Math.max(...kerrPhase) - Math.min(...kerrPhase);
  $("k-i").textContent = fmt(peakI);
  $("k-phi").textContent = fmt(span);
  $("k-product").textContent = fmt(k.n2 * k.amp * k.amp);
  $("kerr-badge").textContent = Math.abs(k.n2) < 0.02 ? "linear index" : "n₂ I";
  $("kerr-lesson").textContent =
    Math.abs(k.n2) < 0.02
      ? "n₂ = 0: the index is a constant. The carrier keeps a uniform wavelength across the beam. Intensity does not write phase."
      : "Kerr: n = n₀ + n₂ I. The bright core accumulates extra phase, so the wavefront bunches in the middle — self-phase modulation, a free analog multiply of the field by its own intensity.";
}

function satKnobs() {
  return {
    pump: Number($("pump").value),
    chi3: Number($("sat-chi3").value),
    x0: Number($("x0").value),
  };
}

function wellsFor(pump, chi3) {
  if (chi3 > 1e-6 && pump > 1) {
    const w = Math.sqrt((pump - 1) / chi3);
    return [-w, w];
  }
  if (chi3 > 1e-6) return [0];
  return [];
}

function potential(x, pump, chi3) {
  return -0.5 * (pump - 1) * x * x + 0.25 * chi3 * x ** 4;
}

function resetSaturate() {
  const k = satKnobs();
  state.satX = k.x0;
  state.satTrail = [];
  state.satT = 0;
}

function syncSatReadouts() {
  const k = satKnobs();
  $("pump-read").textContent = fmt(k.pump);
  $("sat-chi3-read").textContent = fmt(k.chi3);
  $("x0-read").textContent = `${k.x0 >= 0 ? "+" : ""}${fmt(k.x0)}`;
  resetSaturate();
}

["pump", "sat-chi3", "x0"].forEach((id) => {
  $(id).addEventListener("input", syncSatReadouts);
});
$("kick").addEventListener("click", resetSaturate);

function stepSaturate(dt) {
  const k = satKnobs();
  const steps = 4;
  const h = dt / steps;
  for (let s = 0; s < steps; s += 1) {
    const dx = (k.pump - 1) * state.satX - k.chi3 * state.satX ** 3;
    state.satX += h * dx;
    if (Math.abs(state.satX) > 40) state.satX = Math.sign(state.satX) * 40;
    state.satT += h;
    state.satTrail.push({ t: state.satT, x: state.satX });
    if (state.satTrail.length > 420) state.satTrail.shift();
  }
}

function drawSaturate() {
  const k = satKnobs();
  const wells = wellsFor(k.pump, k.chi3);
  const canvas = $("potential");
  const ctx = canvas.getContext("2d");
  clearCanvas(ctx, canvas);
  const pad = 26;
  const wellAbs = wells.length === 2 ? Math.abs(wells[1]) : 0;
  const xMax = wells.length === 2 ? Math.max(1.35, wellAbs * 1.85) : 2.2;
  const xs = [];
  const vs = [];
  for (let i = 0; i < 241; i += 1) {
    const x = -xMax + (2 * xMax * i) / 240;
    xs.push(x);
    vs.push(potential(x, k.pump, k.chi3));
  }
  const vmin = Math.min(...vs);
  const shifted = vs.map((v) => v - vmin);
  const vmax = Math.max(0.4, ...shifted);
  plotSeries(ctx, xs, shifted, -xMax, xMax, -0.05 * vmax, vmax * 1.08, canvas, pad, "#e6c36a");
  wells.forEach((w) => {
    const x = pad + ((w + xMax) / (2 * xMax)) * (canvas.width - 2 * pad);
    ctx.strokeStyle = "rgba(61, 184, 197, 0.45)";
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x, pad);
    ctx.lineTo(x, canvas.height - pad);
    ctx.stroke();
    ctx.setLineDash([]);
  });
  const y0 = -0.05 * vmax;
  const y1 = vmax * 1.08;
  const xDraw = Math.max(-xMax, Math.min(xMax, state.satX));
  const px = pad + ((xDraw + xMax) / (2 * xMax)) * (canvas.width - 2 * pad);
  const pyVal = potential(xDraw, k.pump, k.chi3) - vmin;
  const py = canvas.height - pad - ((pyVal - y0) / (y1 - y0)) * (canvas.height - 2 * pad);
  ctx.fillStyle = "#3db8c5";
  ctx.beginPath();
  ctx.arc(px, py, 6, 0, Math.PI * 2);
  ctx.fill();

  const sc = $("settle");
  const sctx = sc.getContext("2d");
  clearCanvas(sctx, sc);
  const trail = state.satTrail;
  if (trail.length > 1) {
    const t0 = trail[0].t;
    const t1 = Math.max(trail[trail.length - 1].t, t0 + 1);
    const yAbs = Math.max(1.1, ...trail.map((p) => Math.abs(p.x)), ...wells.map(Math.abs));
    plotSeries(
      sctx,
      trail.map((p) => p.t),
      trail.map((p) => p.x),
      t0,
      t1,
      -yAbs,
      yAbs,
      sc,
      pad,
      "#3db8c5"
    );
    sctx.strokeStyle = "rgba(231, 239, 230, 0.12)";
    sctx.beginPath();
    sctx.moveTo(pad, sc.height / 2);
    sctx.lineTo(sc.width - pad, sc.height / 2);
    sctx.stroke();
  }

  const runaway = Math.abs(state.satX) > 12;
  $("s-wells").textContent = wells.length === 2 ? `±${fmt(wells[1])}` : wells.length === 1 ? "0" : "none";
  $("s-final").textContent = runaway ? "runaway" : fmt(state.satX);
  $("s-spin").textContent = runaway ? "—" : state.satX === 0 ? "0" : state.satX > 0 ? "+1" : "−1";
  $("well-badge").textContent =
    k.chi3 < 0.01 && k.pump > 1 ? "runaway" : wells.length === 2 ? "double well" : "single well";
  if (k.chi3 < 0.01 && k.pump > 1) {
    $("sat-lesson").textContent =
      "Pump above threshold with χ³ = 0: gain with no saturation. The amplitude runs away. A linear analog computer cannot make a bit.";
  } else if (k.pump <= 1) {
    $("sat-lesson").textContent =
      "Below threshold the only well is x = 0. Amplitudes die. Raise the pump past 1 and, with a cubic, the origin splits into ± wells.";
  } else {
    $("sat-lesson").textContent = `Pump p = ${fmt(k.pump)} opened a double well at ±${fmt(wells[1] || 0)}. The cubic −χ³ x³ is the same saturation that locks a coherent Ising machine onto a spin.`;
  }
}

function tick(now) {
  if (!tick.last) tick.last = now;
  const dt = Math.min(0.05, (now - tick.last) / 1000);
  tick.last = now;
  state.phase = (state.phase + dt * 1.6) % (Math.PI * 2);
  if (state.tab === "drive") drawDrive(state.phase);
  if (state.tab === "kerr") drawKerr(state.phase);
  if (state.tab === "saturate") {
    stepSaturate(dt * 5.5);
    drawSaturate();
  }
  requestAnimationFrame(tick);
}

syncDriveReadouts();
syncKerrReadouts();
syncSatReadouts();
const startTab = location.hash.slice(1);
if (startTab && document.getElementById(`panel-${startTab}`)) showTab(startTab);
window.addEventListener("hashchange", () => {
  const name = location.hash.slice(1);
  if (name && document.getElementById(`panel-${name}`)) showTab(name);
});
requestAnimationFrame(tick);
