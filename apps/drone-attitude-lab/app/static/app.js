const $ = (id) => document.getElementById(id);

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const G = 9.81;

const C = {
  ink: "#e7efe6",
  mute: "#8aa09a",
  red: "#e85d4c",
  blue: "#3db8c5",
  amber: "#e6c36a",
  green: "#8fce72",
  violet: "#b394f0",
  line: "rgba(231, 239, 230, 0.12)",
  panel: "#152026",
};
const AXIS_COLORS = [C.red, C.green, C.blue];

const state = { tab: "attitude" };

// ---------------------------------------------------------------------------
// Tabs and glossary jumps
// ---------------------------------------------------------------------------

function showTab(name) {
  state.tab = name;
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("is-on", b.dataset.tab === name));
  document.querySelectorAll("main .panel").forEach((p) => {
    p.classList.toggle("is-on", p.id === `panel-${name}`);
  });
  if (location.hash.slice(1) !== name) history.replaceState(null, "", `#${name}`);
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
  const s = Math.abs(n) < 0.5 * 10 ** -digits ? (0).toFixed(digits) : n.toFixed(digits);
  return s.replace("-", "−");
}

function signed(n, digits = 2) {
  const s = fmt(n, digits);
  return n > 0 && Number(s) !== 0 ? `+${s}` : s;
}

const deg = (rad, digits = 0) => `${fmt(rad * R2D, digits)}°`;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// ---------------------------------------------------------------------------
// Vectors, matrices, quaternions — same conventions as app/attitude.py
// World NED, body FRD, Euler intrinsic Z-Y-X, Hamilton quaternions [w,x,y,z].
// ---------------------------------------------------------------------------

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => {
  const n = norm(a);
  return n < 1e-12 ? [0, 0, 0] : scale(a, 1 / n);
};

function matMul(A, B) {
  const out = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i += 1)
    for (let j = 0; j < 3; j += 1) out[i][j] = A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j];
  return out;
}

const matVec = (M, v) => [dot(M[0], v), dot(M[1], v), dot(M[2], v)];
const column = (M, j) => [M[0][j], M[1][j], M[2][j]];
const IDENTITY = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

function rot(axis, a) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  if (axis === "x") return [[1, 0, 0], [0, c, -s], [0, s, c]];
  if (axis === "y") return [[c, 0, s], [0, 1, 0], [-s, 0, c]];
  return [[c, -s, 0], [s, c, 0], [0, 0, 1]];
}

function det3(M) {
  return dot(M[0], cross(M[1], M[2]));
}

function qmul(a, b) {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}

const qlen = (q) => Math.hypot(q[0], q[1], q[2], q[3]);
const qnormalize = (q) => {
  const n = qlen(q);
  return q.map((v) => v / n);
};
const qneg = (q) => q.map((v) => -v);
const qdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
const qcanon = (q) => (q[0] < 0 ? qneg(q) : q);

function qFromEuler(roll, pitch, yaw) {
  const cr = Math.cos(roll / 2);
  const sr = Math.sin(roll / 2);
  const cp = Math.cos(pitch / 2);
  const sp = Math.sin(pitch / 2);
  const cy = Math.cos(yaw / 2);
  const sy = Math.sin(yaw / 2);
  return [
    cr * cp * cy + sr * sp * sy,
    sr * cp * cy - cr * sp * sy,
    cr * sp * cy + sr * cp * sy,
    cr * cp * sy - sr * sp * cy,
  ];
}

function qToEuler(q) {
  const [w, x, y, z] = qnormalize(q);
  const sp = 2 * (w * y - z * x);
  if (Math.abs(sp) >= 1 - 1e-9) {
    return [wrapPi(2 * Math.atan2(x, w)), Math.sign(sp) * (Math.PI / 2), 0];
  }
  return [
    Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y)),
    Math.asin(sp),
    Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)),
  ];
}

function qToMat(q) {
  const [w, x, y, z] = qnormalize(q);
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
  ];
}

function matToQuat(m) {
  const tr = m[0][0] + m[1][1] + m[2][2];
  let q;
  if (tr > 0) {
    const s = 2 * Math.sqrt(tr + 1);
    q = [0.25 * s, (m[2][1] - m[1][2]) / s, (m[0][2] - m[2][0]) / s, (m[1][0] - m[0][1]) / s];
  } else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) {
    const s = 2 * Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]);
    q = [(m[2][1] - m[1][2]) / s, 0.25 * s, (m[0][1] + m[1][0]) / s, (m[0][2] + m[2][0]) / s];
  } else if (m[1][1] > m[2][2]) {
    const s = 2 * Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]);
    q = [(m[0][2] - m[2][0]) / s, (m[0][1] + m[1][0]) / s, 0.25 * s, (m[1][2] + m[2][1]) / s];
  } else {
    const s = 2 * Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]);
    q = [(m[1][0] - m[0][1]) / s, (m[0][2] + m[2][0]) / s, (m[1][2] + m[2][1]) / s, 0.25 * s];
  }
  return qcanon(qnormalize(q));
}

function qFromRotvec(r) {
  const a = norm(r);
  if (a < 1e-12) return qnormalize([1, r[0] / 2, r[1] / 2, r[2] / 2]);
  const s = Math.sin(a / 2) / a;
  return [Math.cos(a / 2), r[0] * s, r[1] * s, r[2] * s];
}

function qToRotvec(q) {
  const [w, x, y, z] = qcanon(qnormalize(q));
  const s = Math.hypot(x, y, z);
  if (s < 1e-12) return [2 * x, 2 * y, 2 * z];
  const a = 2 * Math.atan2(s, w);
  return [(x / s) * a, (y / s) * a, (z / s) * a];
}

function slerp(q0, q1, t) {
  let b = q1;
  let d = qdot(q0, q1);
  if (d < 0) {
    b = qneg(q1);
    d = -d;
  }
  if (d > 0.9995) return qnormalize(q0.map((v, i) => v + t * (b[i] - v)));
  const th = Math.acos(d);
  const s0 = Math.sin((1 - t) * th) / Math.sin(th);
  const s1 = Math.sin(t * th) / Math.sin(th);
  return q0.map((v, i) => s0 * v + s1 * b[i]);
}

const angleBetween = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(qdot(qnormalize(a), qnormalize(b)))));

// [φ̇ θ̇ ψ̇] = W(φ, θ) ω
function eulerRates(roll, pitch, w) {
  let cp = Math.cos(pitch);
  if (Math.abs(cp) < 1e-6) cp = cp < 0 ? -1e-6 : 1e-6;
  const sr = Math.sin(roll);
  const cr = Math.cos(roll);
  const tp = Math.sin(pitch) / cp;
  return [w[0] + sr * tp * w[1] + cr * tp * w[2], cr * w[1] - sr * w[2], (sr * w[1] + cr * w[2]) / cp];
}

// Condition number of W(φ, θ). Independent of φ; 1 when level, ∞ at ±90°.
function gimbalCond(pitch) {
  const c = Math.abs(Math.cos(pitch));
  if (c < 1e-9) return Infinity;
  const t = Math.tan(pitch);
  const tr = 1 + t * t + 1 / (c * c);
  const dt = 1 / (c * c);
  const disc = Math.sqrt(Math.max(0, tr * tr - 4 * dt));
  const big = Math.sqrt((tr + disc) / 2);
  const small = Math.sqrt(Math.max(1e-30, (tr - disc) / 2));
  return Math.max(big, 1) / Math.min(small, 1);
}

function fmtQ(q, digits = 3) {
  return `[${q.map((v) => fmt(v, digits)).join(", ")}]`;
}

function fmtV(v, digits = 2) {
  return `(${v.map((x) => fmt(x, digits)).join(", ")})`;
}

// ---------------------------------------------------------------------------
// A tiny 3-D canvas renderer: orbit camera, depth-sorted lines and polygons.
// ---------------------------------------------------------------------------

class View {
  constructor(canvas, cam = { az: 215 * D2R, el: 24 * D2R }, zoom = 1) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.cam = cam;
    this.zoom = zoom;
    this.items = [];
    let drag = null;
    canvas.addEventListener("pointerdown", (e) => {
      drag = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!drag) return;
      this.cam.az -= (e.clientX - drag.x) * 0.008;
      this.cam.el = clamp(this.cam.el + (e.clientY - drag.y) * 0.008, -1.45, 1.45);
      drag = { x: e.clientX, y: e.clientY };
    });
    const end = () => {
      drag = null;
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
  }

  begin() {
    const { canvas, ctx, cam } = this;
    this.k = canvas.width / Math.max(1, canvas.clientWidth || canvas.width);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const c = [Math.cos(cam.el) * Math.cos(cam.az), Math.cos(cam.el) * Math.sin(cam.az), -Math.sin(cam.el)];
    this.f = scale(c, -1);
    this.right = unit(cross(this.f, [0, 0, -1]));
    this.up = cross(this.right, this.f);
    this.s = Math.min(canvas.width, canvas.height) * 0.27 * this.zoom;
    this.cx = canvas.width / 2;
    this.cy = canvas.height / 2;
    this.items = [];
  }

  project(p) {
    const d = dot(p, this.f);
    const persp = 7 / (7 + d);
    return { x: this.cx + this.s * dot(p, this.right) * persp, y: this.cy - this.s * dot(p, this.up) * persp, d };
  }

  push(depth, draw) {
    this.items.push({ depth, draw });
  }

  line(a, b, o = {}) {
    const pa = this.project(a);
    const pb = this.project(b);
    this.push((pa.d + pb.d) / 2 + (o.bias || 0), (ctx) => {
      ctx.save();
      ctx.globalAlpha = o.alpha ?? 1;
      ctx.strokeStyle = o.color || C.ink;
      ctx.lineWidth = (o.width || 1.5) * this.k;
      if (o.dash) ctx.setLineDash(o.dash.map((v) => v * this.k));
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
      ctx.restore();
    });
  }

  poly(points, o = {}) {
    const ps = points.map((p) => this.project(p));
    const depth = ps.reduce((acc, p) => acc + p.d, 0) / ps.length + (o.bias || 0);
    this.push(depth, (ctx) => {
      ctx.save();
      ctx.globalAlpha = o.alpha ?? 1;
      if (o.dash) ctx.setLineDash(o.dash.map((v) => v * this.k));
      ctx.beginPath();
      ps.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      if (o.closed !== false) ctx.closePath();
      if (o.fill) {
        ctx.fillStyle = o.fill;
        ctx.fill();
      }
      if (o.color) {
        ctx.strokeStyle = o.color;
        ctx.lineWidth = (o.width || 1.5) * this.k;
        ctx.stroke();
      }
      ctx.restore();
    });
  }

  // Long polylines (rings, traces) are split so depth sorting stays sensible.
  path(points, o = {}) {
    for (let i = 0; i + 1 < points.length; i += 1) this.line(points[i], points[i + 1], o);
  }

  arrow(origin, vec, o = {}) {
    const len = norm(vec);
    if (len < 1e-4) return;
    const end = add(origin, vec);
    const pa = this.project(origin);
    const pb = this.project(end);
    this.push((pa.d + pb.d) / 2 + (o.bias ?? -0.05), (ctx) => {
      const k = this.k;
      ctx.save();
      ctx.globalAlpha = o.alpha ?? 1;
      ctx.strokeStyle = o.color || C.ink;
      ctx.fillStyle = o.color || C.ink;
      ctx.lineWidth = (o.width || 2.5) * k;
      if (o.dash) ctx.setLineDash(o.dash.map((v) => v * k));
      const dx = pb.x - pa.x;
      const dy = pb.y - pa.y;
      const L = Math.hypot(dx, dy);
      const head = Math.min(11 * k, L * 0.45);
      const ux = L > 0 ? dx / L : 0;
      const uy = L > 0 ? dy / L : 0;
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x - ux * head * 0.8, pb.y - uy * head * 0.8);
      ctx.stroke();
      ctx.setLineDash([]);
      if (L > 2 * k) {
        ctx.beginPath();
        ctx.moveTo(pb.x, pb.y);
        ctx.lineTo(pb.x - ux * head - uy * head * 0.45, pb.y - uy * head + ux * head * 0.45);
        ctx.lineTo(pb.x - ux * head + uy * head * 0.45, pb.y - uy * head - ux * head * 0.45);
        ctx.closePath();
        ctx.fill();
      }
      if (o.label) {
        ctx.font = `${12 * k}px ui-monospace, "SF Mono", Menlo, monospace`;
        ctx.textAlign = ux >= 0 ? "left" : "right";
        ctx.textBaseline = "middle";
        ctx.fillText(o.label, pb.x + ux * 7 * k + (ux >= 0 ? 3 : -3) * k, pb.y + uy * 7 * k);
      }
      ctx.restore();
    });
  }

  text(p, str, o = {}) {
    const pp = this.project(p);
    this.push(pp.d - 1, (ctx) => {
      ctx.save();
      ctx.globalAlpha = o.alpha ?? 1;
      ctx.fillStyle = o.color || C.mute;
      ctx.font = `${(o.size || 12) * this.k}px ui-monospace, "SF Mono", Menlo, monospace`;
      ctx.textAlign = o.align || "center";
      ctx.textBaseline = "middle";
      ctx.fillText(str, pp.x, pp.y);
      ctx.restore();
    });
  }

  dot(p, r, color) {
    const pp = this.project(p);
    this.push(pp.d - 0.01, (ctx) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(pp.x, pp.y, r * this.k, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  flush() {
    this.items.sort((a, b) => b.depth - a.depth);
    for (const it of this.items) it.draw(this.ctx);
    this.items = [];
  }

  hud(lines, o = {}) {
    const { ctx, k } = this;
    ctx.save();
    ctx.font = `${12 * k}px ui-monospace, "SF Mono", Menlo, monospace`;
    ctx.textBaseline = "top";
    lines.forEach((ln, i) => {
      const [txt, color] = Array.isArray(ln) ? ln : [ln, C.mute];
      ctx.fillStyle = color;
      ctx.textAlign = o.align || "left";
      const x = o.align === "right" ? this.canvas.width - 12 * k : 12 * k;
      ctx.fillText(txt, x, (10 + i * 17) * k);
    });
    ctx.restore();
  }
}

function circlePoints(center, u, v, r, n = 48) {
  const pts = [];
  for (let i = 0; i <= n; i += 1) {
    const a = (i / n) * Math.PI * 2;
    pts.push(add(center, add(scale(u, r * Math.cos(a)), scale(v, r * Math.sin(a)))));
  }
  return pts;
}

function drawGround(view, z = 1.15, half = 2.5, alpha = 1) {
  for (let i = -half; i <= half + 1e-9; i += 0.5) {
    view.line([i, -half, z], [i, half, z], { color: C.line, width: 1, alpha, bias: 5 });
    view.line([-half, i, z], [half, i, z], { color: C.line, width: 1, alpha, bias: 5 });
  }
}

function drawWorldAxes(view, origin = [0, 0, 0], len = 1.7) {
  const labels = ["N", "E", "D"];
  for (let i = 0; i < 3; i += 1) {
    const e = [0, 0, 0];
    e[i] = len;
    view.line(origin, add(origin, e), { color: AXIS_COLORS[i], width: 1, alpha: 0.35, dash: [4, 5], bias: 3 });
    view.text(add(origin, scale(e, 1.08)), labels[i], { color: AXIS_COLORS[i], alpha: 0.6 });
  }
}

function drawBodyAxes(view, R, pos = [0, 0, 0], len = 1.05, o = {}) {
  const names = o.names || ["x", "y", "z"];
  for (let i = 0; i < 3; i += 1) {
    view.arrow(pos, scale(column(R, i), len), {
      color: AXIS_COLORS[i],
      width: o.width || 2,
      label: names[i],
      alpha: o.alpha ?? 1,
    });
  }
}

// Quad X in FRD body axes, PX4 numbering: ① FR, ② RL, ③ FL, ④ RR.
const MOTORS = [
  { name: "front-right", tag: "①", dir: [1, 1], yaw: +1 },
  { name: "rear-left", tag: "②", dir: [-1, -1], yaw: +1 },
  { name: "front-left", tag: "③", dir: [1, -1], yaw: -1 },
  { name: "rear-right", tag: "④", dir: [-1, 1], yaw: -1 },
];
const ARM_VIS = 0.46;
const DRONE_SCALE = 1.35;

function motorBody(i, s = 1) {
  return [MOTORS[i].dir[0] * ARM_VIS * s, MOTORS[i].dir[1] * ARM_VIS * s, 0];
}

function drawDrone(view, R, pos = [0, 0, 0], o = {}) {
  const s = o.scale || DRONE_SCALE;
  const alpha = o.alpha ?? 1;
  const dash = o.ghost ? [5, 4] : null;
  const W = (b) => add(pos, matVec(R, scale(b, s)));
  const bodyU = column(R, 0);
  const bodyV = column(R, 1);

  // frame plate
  const plate = [[0.13, 0.1, 0], [0.13, -0.1, 0], [-0.13, -0.1, 0], [-0.13, 0.1, 0]].map(W);
  view.poly(plate, { fill: o.ghost ? null : "#1f2f36", color: o.ghost ? C.ink : "#5b7078", alpha, dash, width: 1.5 });

  // arms, rotors, legs
  for (let i = 0; i < 4; i += 1) {
    const m = motorBody(i);
    view.line(W([0, 0, 0]), W(m), { color: o.ghost ? C.ink : "#9fb2ac", width: o.ghost ? 1.4 : 3.5, alpha, dash });
    const hub = W(add(m, [0, 0, -0.05]));
    const front = MOTORS[i].dir[0] > 0;
    const ring = circlePoints(hub, bodyU, bodyV, 0.21 * s, 28);
    view.poly(ring, {
      fill: o.ghost ? null : front ? "rgba(232, 93, 76, 0.18)" : "rgba(61, 184, 197, 0.16)",
      color: o.ghost ? C.ink : front ? C.red : C.blue,
      alpha: alpha * (o.ghost ? 0.8 : 0.9),
      width: 1.2,
      dash,
    });
    if (o.tags) view.text(add(hub, scale(column(R, 2), -0.12 * s)), MOTORS[i].tag, { color: C.ink, size: 11, alpha });
    if (!o.ghost) {
      const foot = [MOTORS[i].dir[0] * 0.1, MOTORS[i].dir[1] * 0.1, 0];
      view.line(W(foot), W(add(foot, [0, 0, 0.17])), { color: "#5b7078", width: 1.5, alpha });
    }
  }

  // nose wedge
  view.poly([W([0.36, 0, 0]), W([0.13, 0.08, 0]), W([0.13, -0.08, 0])], {
    fill: o.ghost ? null : C.red,
    color: o.ghost ? C.ink : C.red,
    alpha,
    dash,
    bias: -0.02,
  });
}

function clearCanvas(canvas) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  return ctx;
}

function kOf(canvas) {
  return canvas.width / Math.max(1, canvas.clientWidth || canvas.width);
}

function drawArrow2d(ctx, x0, y0, x1, y1, color, k, o = {}) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const L = Math.hypot(dx, dy);
  if (L < 1) return;
  const ux = dx / L;
  const uy = dy / L;
  const head = Math.min(10 * k, L * 0.4);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = (o.width || 2.5) * k;
  if (o.dash) ctx.setLineDash(o.dash.map((v) => v * k));
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1 - ux * head * 0.8, y1 - uy * head * 0.8);
  ctx.stroke();
  ctx.setLineDash([]);
  if (!o.noHead) {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 - ux * head - uy * head * 0.45, y1 - uy * head + ux * head * 0.45);
    ctx.lineTo(x1 - ux * head + uy * head * 0.45, y1 - uy * head - ux * head * 0.45);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function label2d(ctx, txt, x, y, color, k, align = "left", base = "middle") {
  ctx.save();
  ctx.fillStyle = color;
  ctx.font = `${12 * k}px ui-monospace, "SF Mono", Menlo, monospace`;
  ctx.textAlign = align;
  ctx.textBaseline = base;
  ctx.fillText(txt, x, y);
  ctx.restore();
}

function plotLines(canvas, series, o) {
  const ctx = clearCanvas(canvas);
  const k = kOf(canvas);
  const pad = 34 * k;
  const w = canvas.width - pad - 12 * k;
  const h = canvas.height - pad - 12 * k;
  const X = (x) => pad + ((x - o.x0) / (o.x1 - o.x0)) * w;
  const Y = (y) => 12 * k + (1 - (y - o.y0) / (o.y1 - o.y0)) * h;
  ctx.strokeStyle = C.line;
  ctx.lineWidth = k;
  ctx.font = `${10 * k}px ui-monospace, "SF Mono", Menlo, monospace`;
  ctx.fillStyle = C.mute;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (const yt of o.yticks || []) {
    ctx.beginPath();
    ctx.moveTo(pad, Y(yt));
    ctx.lineTo(pad + w, Y(yt));
    ctx.stroke();
    ctx.fillText(o.ytickFmt ? o.ytickFmt(yt) : String(yt), pad - 5 * k, Y(yt));
  }
  for (const s of series) {
    ctx.save();
    ctx.strokeStyle = s.color;
    ctx.lineWidth = (s.width || 1.8) * k;
    if (s.dash) ctx.setLineDash(s.dash.map((v) => v * k));
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i < s.x.length; i += 1) {
      const y = s.y[i];
      if (y == null || !Number.isFinite(y)) {
        pen = false;
        continue;
      }
      const yy = Y(clamp(y, o.y0, o.y1));
      if (pen && s.breakJump != null && Math.abs(y - s.y[i - 1]) > s.breakJump) pen = false;
      if (pen) ctx.lineTo(X(s.x[i]), yy);
      else ctx.moveTo(X(s.x[i]), yy);
      pen = true;
    }
    ctx.stroke();
    ctx.restore();
  }
  if (o.marker != null) {
    ctx.save();
    ctx.strokeStyle = C.ink;
    ctx.globalAlpha = 0.5;
    ctx.setLineDash([3 * k, 4 * k]);
    ctx.beginPath();
    ctx.moveTo(X(o.marker), 12 * k);
    ctx.lineTo(X(o.marker), 12 * k + h);
    ctx.stroke();
    ctx.restore();
  }
  if (o.legend) {
    ctx.font = `${12 * k}px ui-monospace, "SF Mono", Menlo, monospace`;
    let x = pad + 8 * k;
    let y = 22 * k;
    for (const [txt, color] of o.legend) {
      const wTxt = ctx.measureText(txt).width;
      if (x > pad + 8 * k && x + wTxt > pad + w) {
        x = pad + 8 * k;
        y += 17 * k;
      }
      label2d(ctx, txt, x, y, color, k);
      x += wTxt + 14 * k;
    }
  }
  return { X, Y, k, pad, w, h, ctx };
}

// ---------------------------------------------------------------------------
// Attitude tab
// ---------------------------------------------------------------------------

const att = {
  view: new View($("a-view"), { az: 215 * D2R, el: 24 * D2R }, 1.2),
  anim: null,
  negate: false,
};

function attKnobs() {
  return {
    roll: Number($("a-roll").value) * D2R,
    pitch: Number($("a-pitch").value) * D2R,
    yaw: Number($("a-yaw").value) * D2R,
    order: $("a-order").value,
  };
}

function attSteps(k) {
  return k.order === "zyx"
    ? [["z", k.yaw, "ψ yaw"], ["y", k.pitch, "θ pitch"], ["x", k.roll, "φ roll"]]
    : [["x", k.roll, "φ roll"], ["y", k.pitch, "θ pitch"], ["z", k.yaw, "ψ yaw"]];
}

function attMatrix(k, progress = 3) {
  let R = IDENTITY;
  attSteps(k).forEach(([ax, a], i) => {
    R = matMul(R, rot(ax, a * clamp(progress - i, 0, 1)));
  });
  return R;
}

function syncAttReadouts() {
  $("a-roll-read").textContent = `${$("a-roll").value}°`;
  $("a-pitch-read").textContent = `${$("a-pitch").value}°`;
  $("a-yaw-read").textContent = `${$("a-yaw").value}°`;
  const k = attKnobs();
  $("a-badge").textContent = k.order === "zyx" ? "Z-Y-X" : "X-Y-Z";
  const R = attMatrix(k);
  let q = matToQuat(R);
  if (att.negate) q = qneg(q);
  const rv = qToRotvec(q);
  const alpha = norm(rv);
  const axis = alpha > 1e-9 ? scale(rv, 1 / alpha) : [0, 0, 0];

  if (k.order === "zyx") {
    $("a-euler").textContent = `R = Rz(ψ)·Ry(θ)·Rx(φ)\nψ yaw   ${signed(k.yaw * R2D, 0)}°\nθ pitch ${signed(k.pitch * R2D, 0)}°\nφ roll  ${signed(k.roll * R2D, 0)}°`;
    $("a-euler-note").textContent = "Yaw first, then pitch about the new y, then roll about the newest x.";
  } else {
    const [r2, p2, y2] = qToEuler(q);
    $("a-euler").textContent = `R = Rx(φ)·Ry(θ)·Rz(ψ)\nφ roll  ${signed(k.roll * R2D, 0)}°\nθ pitch ${signed(k.pitch * R2D, 0)}°\nψ yaw   ${signed(k.yaw * R2D, 0)}°`;
    $("a-euler-note").textContent = `Same numbers, other order. In Z-Y-X this attitude is φ ${deg(r2)}, θ ${deg(p2)}, ψ ${deg(y2)}.`;
  }

  const bars = ["w", "x", "y", "z"]
    .map((n, i) => {
      const v = q[i];
      const left = v >= 0 ? 50 : 50 + v * 50;
      const width = Math.abs(v) * 50;
      return `<div class="qbar"><span>${n}</span><span class="track"><span class="fill" style="left:${left}%;width:${width}%"></span></span><span class="val">${signed(v, 3)}</span></div>`;
    })
    .join("");
  $("a-qbars").innerHTML = bars;

  $("a-rotvec").textContent = `r = ${fmtV(rv, 3)} rad\nα = |r| = ${deg(alpha, 1)}\nn̂ = ${fmtV(axis, 3)}`;
  $("a-matrix").innerHTML = R.map((row) => row.map((v, j) => `<span class="c${j}">${fmt(v, 3)}</span>`).join("")).join("");

  const tilt = Math.acos(clamp(R[2][2], -1, 1));
  const nose = column(R, 0);
  const horiz = Math.hypot(nose[0], nose[1]);
  const pitchZyx = qToEuler(q)[1];
  $("a-m-angle").textContent = deg(alpha, 1);
  $("a-m-axis").textContent = fmtV(axis, 2);
  $("a-m-norm").textContent = fmt(qlen(q), 6);
  $("a-m-det").textContent = fmt(det3(R), 6);
  $("a-m-tilt").textContent = deg(tilt, 1);
  $("a-m-heading").textContent = horiz < 1e-3 ? "nose vertical" : `${fmt(((Math.atan2(nose[1], nose[0]) * R2D) + 360) % 360, 0)}°`;
  $("a-m-cond").textContent = fmt(gimbalCond(pitchZyx), 1);

  let lesson;
  if (att.negate) {
    lesson = "Every quaternion sign flipped and the drone did not move. q and −q are the same attitude: half-angles mean a 360° turn lands on −q.";
  } else if (Math.abs(pitchZyx) > 85 * D2R) {
    lesson = "Nose almost vertical. Euler pitch is near ±90°, cond W is huge, and roll and yaw have started to mean the same thing. The quaternion and rotation vector do not care.";
  } else if (k.order === "xyz") {
    lesson = "Same three angles applied roll-first. The drone points somewhere else: rotations do not commute, so an Euler triple is meaningless without its order.";
  } else if (alpha < 1e-3) {
    lesson = "Level and facing north. q = [1, 0, 0, 0], r = 0, R = I. Every description agrees on nothing happening.";
  } else {
    lesson = `Three turns about moving axes, or one turn of ${deg(alpha, 1)} about n̂ ${fmtV(axis, 2)}. The quaternion stores that single turn as cos(α/2) and sin(α/2) n̂.`;
  }
  $("a-lesson").textContent = lesson;
  att.R = R;
  att.q = q;
  att.rv = rv;
}

["a-roll", "a-pitch", "a-yaw", "a-order"].forEach((id) =>
  $(id).addEventListener("input", () => {
    att.anim = null;
    att.negate = false;
    syncAttReadouts();
  })
);

$("a-play-euler").addEventListener("click", () => {
  att.negate = false;
  syncAttReadouts();
  att.anim = { kind: "euler", t0: performance.now() };
});
$("a-play-axis").addEventListener("click", () => {
  att.negate = false;
  syncAttReadouts();
  att.anim = { kind: "axis", t0: performance.now() };
});

const ATT_PRESETS = {
  level: [0, 0, 0],
  bank: [30, 0, 0],
  climb: [0, 45, 0],
  flip: [180, 0, 0],
  lock: [20, 90, 50],
};

document.querySelectorAll("[data-apreset]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const name = btn.dataset.apreset;
    att.anim = null;
    if (name === "same") {
      att.negate = !att.negate;
    } else {
      const [r, p, y] = ATT_PRESETS[name];
      $("a-roll").value = r;
      $("a-pitch").value = p;
      $("a-yaw").value = y;
      $("a-order").value = "zyx";
      att.negate = false;
    }
    syncAttReadouts();
  });
});

function drawAttitude(now) {
  const v = att.view;
  const k = attKnobs();
  v.begin();
  drawGround(v);
  drawWorldAxes(v, [0, 0, 0], 1.5);

  let R = att.R;
  const hud = [];
  if (att.anim) {
    const el = (now - att.anim.t0) / 1000;
    if (att.anim.kind === "euler") {
      const prog = clamp(el / 1.3, 0, 3);
      R = attMatrix(k, prog);
      const steps = attSteps(k);
      const i = Math.min(2, Math.floor(prog));
      const before = attMatrix(k, i);
      const [ax, , name] = steps[i];
      const axisIdx = { x: 0, y: 1, z: 2 }[ax];
      const dir = column(before, axisIdx);
      v.line(scale(dir, -1.6), scale(dir, 1.6), { color: AXIS_COLORS[axisIdx], width: 1.5, dash: [8, 6] });
      const primes = ["", "′", "″"][i];
      hud.push([`step ${i + 1} / 3 · ${name} about ${ax}${primes}`, AXIS_COLORS[axisIdx]]);
      drawDrone(v, before, [0, 0, 0], { ghost: true, alpha: 0.35 });
      if (el > 3 * 1.3 + 1.2) att.anim = null;
    } else {
      const t = clamp(el / 2.6, 0, 1);
      R = qToMat(qFromRotvec(scale(att.rv, t)));
      hud.push([`one turn about n̂ · ${deg(norm(att.rv) * t, 0)} of ${deg(norm(att.rv), 0)}`, C.violet]);
      if (el > 2.6 + 1.2) att.anim = null;
    }
  }

  const alpha = norm(att.rv);
  if (alpha > 1e-3) {
    const n = scale(att.rv, 1 / alpha);
    v.line(scale(n, -1.5), [0, 0, 0], { color: C.violet, width: 1, dash: [3, 5], alpha: 0.6 });
    v.arrow([0, 0, 0], scale(n, 0.45 + (alpha / Math.PI) * 1.1), { color: C.violet, width: 3, label: `r · α=${deg(alpha, 0)}` });
  }
  drawDrone(v, R, [0, 0, 0], { tags: true });
  drawBodyAxes(v, R, [0, 0, 0], 1.1, { names: ["x fwd", "y right", "z down"] });
  v.flush();
  v.hud(hud.length ? hud : [["drag to orbit", C.mute]]);
}

// ---------------------------------------------------------------------------
// Forces tab
// ---------------------------------------------------------------------------

const FRAME = { arm: 0.25, yawCoeff: 0.016, inertia: [0.011, 0.011, 0.021], maxThrust: 9 };
const N_SCALE = 0.075; // scene units per newton
const MOTOR_IDS = ["f-m1", "f-m2", "f-m3", "f-m4"];

const forces = { view: new View($("f-view"), { az: 225 * D2R, el: 30 * D2R }, 1.15) };

function allocation() {
  const h = FRAME.arm / Math.SQRT2;
  return [
    [1, 1, 1, 1],
    MOTORS.map((m) => -m.dir[1] * h),
    MOTORS.map((m) => m.dir[0] * h),
    MOTORS.map((m) => m.yaw * FRAME.yawCoeff),
  ];
}

function solve4(A, b) {
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < 4; c += 1) {
    let p = c;
    for (let r = c + 1; r < 4; r += 1) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < 4; r += 1) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let j = c; j < 5; j += 1) M[r][j] -= f * M[c][j];
    }
  }
  return M.map((row, i) => row[4] / row[i]);
}

function mix(T, tau) {
  return solve4(allocation(), [T, ...tau]);
}

function forceKnobs() {
  return {
    thrusts: MOTOR_IDS.map((id) => Number($(id).value)),
    roll: Number($("f-roll").value) * D2R,
    pitch: Number($("f-pitch").value) * D2R,
    mass: Number($("f-mass").value),
  };
}

function computeForces(k) {
  const A = allocation();
  const wrench = A.map((row) => row.reduce((acc, a, i) => acc + a * k.thrusts[i], 0));
  const T = wrench[0];
  const tau = wrench.slice(1);
  const R = qToMat(qFromEuler(k.roll, k.pitch, 0));
  const Tw = matVec(R, [0, 0, -T]);
  const Gw = [0, 0, k.mass * G];
  const net = add(Tw, Gw);
  const acc = scale(net, 1 / k.mass);
  const tilt = Math.acos(clamp(R[2][2], -1, 1));
  const hover = Math.cos(tilt) > 1e-6 ? (k.mass * G) / Math.cos(tilt) : Infinity;
  const alpha = tau.map((t, i) => t / FRAME.inertia[i]);
  return { T, tau, R, Tw, Gw, net, acc, tilt, hover, alpha };
}

function setThrusts(list) {
  let clipped = false;
  list.forEach((f, i) => {
    const c = clamp(f, 0, FRAME.maxThrust);
    if (Math.abs(c - f) > 1e-6) clipped = true;
    $(MOTOR_IDS[i]).value = c.toFixed(2);
  });
  forces.clipped = clipped;
}

function syncForceReadouts() {
  const k = forceKnobs();
  MOTOR_IDS.forEach((id, i) => {
    $(`${id}-read`).textContent = `${fmt(k.thrusts[i])} N`;
  });
  $("f-roll-read").textContent = `${$("f-roll").value}°`;
  $("f-pitch-read").textContent = `${$("f-pitch").value}°`;
  $("f-mass-read").textContent = `${fmt(k.mass)} kg`;
  const r = computeForces(k);
  forces.k = k;
  forces.r = r;

  const W = k.mass * G;
  const climb = -r.acc[2];
  const horiz = Math.hypot(r.acc[0], r.acc[1]);
  const torqueMag = norm(r.tau);
  $("f-m-T").textContent = `${fmt(r.T)} N`;
  $("f-m-W").textContent = `${fmt(W)} N`;
  $("f-m-hover").textContent = Number.isFinite(r.hover) ? `${fmt(r.hover)} N` : "∞";
  $("f-m-tilt").textContent = deg(r.tilt, 1);
  $("f-m-ah").textContent = `${signed(r.acc[0])} / ${signed(r.acc[1])} m/s²`;
  $("f-m-av").textContent = `${signed(climb)} m/s² up`;
  $("f-m-tau").textContent = r.tau.map((t) => fmt(t, 3)).join(", ");
  $("f-m-alpha").textContent = `${r.alpha.map((a) => fmt(a * R2D, 0)).join(", ")} °/s²`;

  let lesson;
  let badge;
  if (r.T < 1e-6) {
    lesson = "Motors off. Gravity is the only force, so the drone falls at g.";
    badge = "free fall";
  } else if (torqueMag > 1e-3) {
    const parts = [];
    if (Math.abs(r.tau[0]) > 1e-3) parts.push(r.tau[0] > 0 ? "roll right (left rotors stronger)" : "roll left (right rotors stronger)");
    if (Math.abs(r.tau[1]) > 1e-3) parts.push(r.tau[1] > 0 ? "nose up (front rotors stronger)" : "nose down (rear rotors stronger)");
    if (Math.abs(r.tau[2]) > 1e-4) parts.push(r.tau[2] > 0 ? "yaw right (CCW pair ①② stronger)" : "yaw left (CW pair ③④ stronger)");
    lesson = `Unequal rotors make a torque: ${parts.join(", ")}. The frame starts turning, the thrust axis turns with it, and the force picture changes a moment later.`;
    badge = "torque";
  } else if (Math.cos(r.tilt) <= 0) {
    lesson = "Belly up. Every newton of thrust now pushes toward the ground.";
    badge = "inverted";
  } else if (Math.abs(climb) < 0.15 && horiz > 0.3) {
    lesson = `Tilted ${deg(r.tilt, 0)}: thrust is mg / cos tilt = ${fmt(r.hover, 1)} N. The vertical share holds altitude, the horizontal share accelerates at ${fmt(horiz, 1)} m/s².`;
    badge = "cruise";
  } else if (Math.abs(climb) < 0.15) {
    lesson = "Thrust balances weight and the rotors are equal. No net force, no torque: hover.";
    badge = "hover";
  } else if (climb > 0) {
    lesson = `Vertical thrust beats weight by ${fmt(climb * k.mass, 1)} N: climbing at +${fmt(climb, 1)} m/s²${horiz > 0.3 ? ` while accelerating ${fmt(horiz, 1)} m/s² sideways` : ""}.`;
    badge = "climb";
  } else {
    lesson = `Not enough vertical thrust for this tilt: needs ${fmt(r.hover, 1)} N, has ${fmt(r.T, 1)} N. Sinking at ${fmt(-climb, 1)} m/s². Tilting borrows thrust from the vertical.`;
    badge = "sink";
  }
  if (forces.clipped) lesson += " Some rotors hit their 0–9 N limit, so the mixer could not deliver the full request.";
  $("f-lesson").textContent = lesson;
  $("f-badge").textContent = badge;
}

[...MOTOR_IDS, "f-roll", "f-pitch", "f-mass"].forEach((id) =>
  $(id).addEventListener("input", () => {
    forces.clipped = false;
    syncForceReadouts();
  })
);

$("f-hold").addEventListener("click", () => {
  const k = forceKnobs();
  const r = computeForces(k);
  if (!Number.isFinite(r.hover)) return;
  if (r.T < 1e-6) setThrusts(mix(r.hover, [0, 0, 0]));
  else setThrusts(k.thrusts.map((f) => (f * r.hover) / r.T));
  syncForceReadouts();
});

document.querySelectorAll("[data-fpreset]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const m = Number($("f-mass").value);
    const W = m * G;
    let roll = 0;
    let pitch = 0;
    let list;
    switch (btn.dataset.fpreset) {
      case "climb":
        list = mix(1.35 * W, [0, 0, 0]);
        break;
      case "cruise":
        pitch = -20;
        list = mix(W / Math.cos(20 * D2R), [0, 0, 0]);
        break;
      case "sink":
        pitch = -20;
        list = mix(W, [0, 0, 0]);
        break;
      case "roll":
        list = mix(W, [0.25, 0, 0]);
        break;
      case "yaw":
        list = mix(W, [0, 0, 0.06]);
        break;
      default:
        list = mix(W, [0, 0, 0]);
    }
    $("f-roll").value = roll;
    $("f-pitch").value = pitch;
    setThrusts(list);
    syncForceReadouts();
  });
});

function drawForces() {
  const { k, r } = forces;
  const v = forces.view;
  v.begin();
  drawGround(v, 1.25);
  drawWorldAxes(v, [0, 0, 0], 1.5);
  drawDrone(v, r.R, [0, 0, 0], { tags: true });

  const thrustDir = column(r.R, 2).map((x) => -x);
  for (let i = 0; i < 4; i += 1) {
    const at = matVec(r.R, add(motorBody(i, DRONE_SCALE), [0, 0, -0.08]));
    v.arrow(at, scale(thrustDir, k.thrusts[i] * N_SCALE), { color: C.amber, width: 2, alpha: 0.75 });
  }
  v.arrow([0, 0, 0], scale(r.Tw, N_SCALE), { color: C.amber, width: 4, label: `T ${fmt(r.T, 1)} N` });
  v.arrow([0, 0, 0], scale(r.Gw, N_SCALE), { color: C.red, width: 4, label: `mg ${fmt(r.Gw[2], 1)} N` });
  if (norm(r.net) > 0.05) v.arrow([0, 0, 0], scale(r.net, N_SCALE * 1.5), { color: C.blue, width: 4, label: `net ${fmt(norm(r.net), 1)} N` });
  const tauW = matVec(r.R, r.tau);
  if (norm(tauW) > 1e-3) {
    const L = 0.35 + Math.min(1.2, norm(tauW) * 3);
    v.arrow([0, 0, 0], scale(unit(tauW), L), { color: C.violet, width: 3, dash: [6, 4], label: `τ ${fmt(norm(r.tau), 2)} N·m` });
  }
  v.flush();
  v.hud([["arrows: 1 N ≈ " + fmt(N_SCALE * 100, 1) + " cm of scene · net drawn ×1.5", C.mute]]);
  drawTriangle();
  drawTopView();
}

function drawTriangle() {
  const { k, r } = forces;
  const canvas = $("f-triangle");
  const ctx = clearCanvas(canvas);
  const kk = kOf(canvas);
  const Tv = -r.Tw[2];
  const Th = Math.hypot(r.Tw[0], r.Tw[1]);
  const W = k.mass * G;
  const span = Math.max(r.T, W, 1);
  const s = (canvas.height * 0.35) / span;
  const ox = canvas.width * 0.4;
  const oy = canvas.height * 0.5;

  ctx.strokeStyle = C.line;
  ctx.lineWidth = kk;
  ctx.beginPath();
  ctx.moveTo(20 * kk, oy);
  ctx.lineTo(canvas.width - 20 * kk, oy);
  ctx.moveTo(ox, 12 * kk);
  ctx.lineTo(ox, canvas.height - 12 * kk);
  ctx.stroke();

  const tx = ox + Th * s;
  const ty = oy - Tv * s;
  drawArrow2d(ctx, ox, oy, ox + Th * s, oy, C.amber, kk, { width: 1.5, dash: [5, 4] });
  drawArrow2d(ctx, ox, oy, ox, oy - Tv * s, C.amber, kk, { width: 1.5, dash: [5, 4] });
  ctx.save();
  ctx.strokeStyle = C.amber;
  ctx.globalAlpha = 0.4;
  ctx.setLineDash([3 * kk, 4 * kk]);
  ctx.beginPath();
  ctx.moveTo(tx, ty);
  ctx.lineTo(tx, oy);
  ctx.moveTo(tx, ty);
  ctx.lineTo(ox, ty);
  ctx.stroke();
  ctx.restore();
  drawArrow2d(ctx, ox, oy, tx, ty, C.amber, kk, { width: 3.5 });
  drawArrow2d(ctx, ox, oy, ox, oy + W * s, C.red, kk, { width: 3.5 });
  const nx = ox + Th * s;
  const ny = oy - (Tv - W) * s;
  if (Math.hypot(Th, Tv - W) > 0.05) drawArrow2d(ctx, ox, oy, nx, ny, C.blue, kk, { width: 3 });

  if (r.tilt > 0.01 && r.T > 0.01) {
    ctx.save();
    ctx.strokeStyle = C.ink;
    ctx.lineWidth = kk;
    ctx.beginPath();
    ctx.arc(ox, oy, 34 * kk, -Math.PI / 2, -Math.PI / 2 + Math.min(r.tilt, Math.PI), false);
    ctx.stroke();
    ctx.restore();
    label2d(ctx, `tilt ${deg(r.tilt, 0)}`, ox + 6 * kk, oy - 48 * kk, C.ink, kk);
  }
  label2d(ctx, `T ${fmt(r.T, 1)} N`, tx + 8 * kk, ty - 4 * kk, C.amber, kk, "left", "bottom");
  label2d(ctx, `T cos = ${fmt(Tv, 1)}`, ox - 8 * kk, oy - (Tv * s) / 2, C.amber, kk, "right");
  label2d(ctx, `T sin = ${fmt(Th, 1)}`, ox + Math.max((Th * s) / 2, 50 * kk), oy + 6 * kk, C.amber, kk, "center", "top");
  label2d(ctx, `mg ${fmt(W, 1)} N`, ox - 8 * kk, oy + W * s, C.red, kk, "right");
  if (Math.hypot(Th, Tv - W) > 0.05) label2d(ctx, `net ${fmt(Math.hypot(Th, Tv - W), 1)} N`, nx + 8 * kk, ny, C.blue, kk);
  const bearing = Th > 1e-3 ? `toward ${fmt(((Math.atan2(r.Tw[1], r.Tw[0]) * R2D) + 360) % 360, 0)}°` : "no horizontal push";
  label2d(ctx, `up ↑ · horizontal → ${bearing}`, 12 * kk, canvas.height - 10 * kk, C.mute, kk, "left", "bottom");
}

function drawTopView() {
  const { k, r } = forces;
  const canvas = $("f-top");
  const ctx = clearCanvas(canvas);
  const kk = kOf(canvas);
  const cx = canvas.width / 2;
  const cy = canvas.height / 2 + 6 * kk;
  const arm = canvas.height * 0.26;
  const rad = canvas.height * 0.11;
  // Body x (forward) is screen up, body y (right) is screen right.
  const P = (bx, by) => [cx + by * arm, cy - bx * arm];

  ctx.strokeStyle = "#9fb2ac";
  ctx.lineWidth = 4 * kk;
  for (let i = 0; i < 4; i += 1) {
    const [x, y] = P(MOTORS[i].dir[0] * 0.707, MOTORS[i].dir[1] * 0.707);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(x, y);
    ctx.stroke();
  }
  ctx.fillStyle = C.red;
  ctx.beginPath();
  ctx.moveTo(cx, cy - 34 * kk);
  ctx.lineTo(cx - 10 * kk, cy - 12 * kk);
  ctx.lineTo(cx + 10 * kk, cy - 12 * kk);
  ctx.closePath();
  ctx.fill();

  const mean = k.thrusts.reduce((a, b) => a + b, 0) / 4;
  for (let i = 0; i < 4; i += 1) {
    const m = MOTORS[i];
    const [x, y] = P(m.dir[0] * 0.707, m.dir[1] * 0.707);
    const f = k.thrusts[i];
    ctx.save();
    ctx.strokeStyle = m.dir[0] > 0 ? C.red : C.blue;
    ctx.fillStyle = "#0f1a1e";
    ctx.lineWidth = 1.5 * kk;
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // thrust bar
    const bh = (f / FRAME.maxThrust) * rad * 1.6;
    ctx.fillStyle = f > mean + 0.05 ? C.amber : f < mean - 0.05 ? "#8a7a4a" : "rgba(230, 195, 106, 0.75)";
    ctx.fillRect(x - 7 * kk, y + rad * 0.8 - bh, 14 * kk, bh);
    // spin arrow: CCW seen from above for yaw +1
    const ccw = m.yaw > 0;
    ctx.strokeStyle = C.ink;
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 1.5 * kk;
    const a0 = -Math.PI * 0.85;
    const a1 = -Math.PI * 0.15;
    ctx.beginPath();
    ctx.arc(x, y, rad + 6 * kk, a0, a1, false);
    ctx.stroke();
    const tip = ccw ? a0 : a1;
    const tx = x + Math.cos(tip) * (rad + 6 * kk);
    const ty = y + Math.sin(tip) * (rad + 6 * kk);
    const tdir = ccw ? -1 : 1;
    const hx = -Math.sin(tip) * tdir;
    const hy = Math.cos(tip) * tdir;
    ctx.fillStyle = C.ink;
    ctx.beginPath();
    ctx.moveTo(tx + hx * 7 * kk, ty + hy * 7 * kk);
    ctx.lineTo(tx - hy * 4 * kk, ty + hx * 4 * kk);
    ctx.lineTo(tx + hy * 4 * kk, ty - hx * 4 * kk);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    const outX = x + m.dir[1] * (rad + 12 * kk);
    const side = m.dir[1] > 0 ? "left" : "right";
    label2d(ctx, `${m.tag} ${fmt(f, 2)} N`, outX, y - 8 * kk, C.ink, kk, side);
    label2d(ctx, ccw ? "CCW" : "CW", outX, y + 10 * kk, C.mute, kk, side);
  }
  label2d(ctx, "from above · nose ↑", 12 * kk, 12 * kk, C.mute, kk, "left", "top");
  const tauTxt = `τ ${r.tau.map((t) => signed(t, 2)).join(" ")} N·m`;
  label2d(ctx, tauTxt, canvas.width - 12 * kk, canvas.height - 10 * kk, C.violet, kk, "right", "bottom");
}

// ---------------------------------------------------------------------------
// Spin tab
// ---------------------------------------------------------------------------

const spin = {
  view: new View($("s-view"), { az: 210 * D2R, el: 20 * D2R }, 1.05),
  running: true,
  acc: 0,
};

function spinRates() {
  return [Number($("s-p").value) * D2R, Number($("s-q").value) * D2R, Number($("s-r").value) * D2R];
}

function resetSpin() {
  spin.q = [1, 0, 0, 0];
  spin.naive = [1, 0, 0, 0];
  spin.e = [0, 0, 0];
  spin.t = 0;
  spin.hist = [];
  spin.trail = [];
  spin.peakGain = 1;
  spin.peakDrift = 0;
  spin.acc = 0;
}

function stepSpin(h) {
  const w = spinRates();
  spin.q = qnormalize(qmul(spin.q, qFromRotvec(scale(w, h))));
  const dn = qmul(spin.naive, [0, ...w]);
  spin.naive = spin.naive.map((v, i) => v + 0.5 * dn[i] * h);
  const er = eulerRates(spin.e[0], spin.e[1], w);
  spin.e = [wrapPi(spin.e[0] + h * er[0]), wrapPi(spin.e[1] + h * er[1]), wrapPi(spin.e[2] + h * er[2])];
  spin.t += h;
  const body = norm(w);
  if (body > 1e-6) {
    const [r, p] = qToEuler(spin.q);
    const rates = eulerRates(r, p, w);
    spin.peakGain = Math.max(spin.peakGain, Math.max(...rates.map(Math.abs)) / body);
  }
  spin.peakDrift = Math.max(spin.peakDrift, angleBetween(spin.q, qFromEuler(...spin.e)));
}

function syncSpinReadouts() {
  $("s-p-read").textContent = `${$("s-p").value}°/s`;
  $("s-q-read").textContent = `${$("s-q").value}°/s`;
  $("s-r-read").textContent = `${$("s-r").value}°/s`;
}

["s-p", "s-q", "s-r"].forEach((id) =>
  $(id).addEventListener("input", () => {
    syncSpinReadouts();
    spin.peakGain = 1;
  })
);
$("s-dt").addEventListener("change", () => resetSpin());
$("s-run").addEventListener("click", () => {
  spin.running = !spin.running;
  $("s-run").textContent = spin.running ? "Pause" : "Run";
});
$("s-reset").addEventListener("click", () => resetSpin());

const SPIN_PRESETS = {
  yaw: [0, 0, 60],
  loop: [0, 90, 0],
  wobble: [5, 90, 0],
  tumble: [45, 90, 45],
  coord: [30, 0, 20],
  barrel: [120, 30, 0],
};

document.querySelectorAll("[data-spreset]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const [p, q, r] = SPIN_PRESETS[btn.dataset.spreset];
    $("s-p").value = p;
    $("s-q").value = q;
    $("s-r").value = r;
    syncSpinReadouts();
    resetSpin();
    spin.running = true;
    $("s-run").textContent = "Pause";
  });
});

function tickSpin(dt) {
  if (spin.running) {
    const h = Number($("s-dt").value);
    spin.acc += dt;
    let guard = 0;
    while (spin.acc >= h && guard < 500) {
      stepSpin(h);
      spin.acc -= h;
      guard += 1;
    }
    const R = qToMat(spin.q);
    spin.trail.push(matVec(R, [0.5, 0, 0]));
    if (spin.trail.length > 160) spin.trail.shift();
    spin.hist.push({ t: spin.t, e: qToEuler(spin.q).map((a) => a * R2D), q: spin.q.slice() });
    while (spin.hist.length && spin.hist[0].t < spin.t - 8) spin.hist.shift();
  }
  drawSpin();
}

function drawSpin() {
  const v = spin.view;
  const w = spinRates();
  const R = qToMat(spin.q);
  const Rg = qToMat(qFromEuler(...spin.e));
  v.begin();
  drawGround(v);
  drawWorldAxes(v, [0, 0, 0], 1.7);
  v.path(spin.trail, { color: C.red, width: 1.5, alpha: 0.45 });
  drawDrone(v, Rg, [0, 0, 0], { ghost: true, alpha: 0.7 });
  drawDrone(v, R, [0, 0, 0]);
  drawBodyAxes(v, R, [0, 0, 0], 0.85, { width: 1.6, alpha: 0.8 });
  const wl = norm(w);
  if (wl > 1e-6) {
    const ww = matVec(R, w);
    v.line(scale(unit(ww), -1.4), [0, 0, 0], { color: C.violet, width: 1, dash: [3, 5], alpha: 0.6 });
    v.arrow([0, 0, 0], scale(unit(ww), 0.4 + (wl / Math.PI) * 1.0), { color: C.violet, width: 3.5, label: `ω ${fmt(wl * R2D, 0)}°/s` });
  }
  v.flush();
  v.hud([[`t = ${fmt(spin.t, 2)} s`, C.mute]]);

  const [r, p, y] = qToEuler(spin.q);
  const rates = eulerRates(r, p, w);
  const drift = angleBetween(spin.q, qFromEuler(...spin.e));
  const nrm = qlen(spin.naive);
  $("s-m-w").textContent = `${fmt(wl * R2D, 0)}°/s`;
  $("s-m-rd").textContent = `${fmt(rates[0] * R2D, 0)}°/s`;
  $("s-m-pd").textContent = `${fmt(rates[1] * R2D, 0)}°/s`;
  $("s-m-yd").textContent = `${fmt(rates[2] * R2D, 0)}°/s`;
  $("s-m-gain").textContent = `${fmt(spin.peakGain, 1)}×`;
  $("s-m-drift").textContent = deg(drift, 1);
  $("s-m-norm").textContent = fmt(nrm, 4);
  $("s-badge").textContent = drift > 5 * D2R ? "ghost lost" : drift > 0.5 * D2R ? "drifting" : "agree";

  let lesson;
  if (wl < 1e-6) lesson = "No rotation. Every integrator is trivially right.";
  else if (spin.peakGain > 5)
    lesson = `The gyro reads a steady ${fmt(wl * R2D, 0)}°/s, but near pitch ±90° the Euler angles had to turn ${fmt(spin.peakGain, 0)}× faster — W(φ, θ) divides by cos θ. The ghost, integrated in Euler angles, is ${deg(drift, 1)} off; the quaternion step is exact.`;
  else if (spin.peakDrift > 0.5 * D2R)
    lesson = `Euler integration has drifted up to ${deg(spin.peakDrift, 1)}. Same rates, same step: the error comes from the nonlinear W(φ, θ), not from ω. Try 25 Hz.`;
  else
    lesson = "Both integrators agree. Away from pitch ±90° the Euler rates stay tame. Pitch the nose through vertical with a little roll or yaw rate.";
  if (nrm > 1.01) lesson += ` Unnormalized, q += ½ q⊗ω dt has already grown to |q| = ${fmt(nrm, 3)} — renormalize every step.`;
  $("s-lesson").textContent = lesson;

  const h = spin.hist;
  const t1 = Math.max(8, spin.t);
  const xs = h.map((s) => s.t);
  plotLines(
    $("s-euler"),
    [0, 1, 2].map((i) => ({ x: xs, y: h.map((s) => s.e[i]), color: AXIS_COLORS[i], breakJump: 90 })),
    {
      x0: t1 - 8,
      x1: t1,
      y0: -185,
      y1: 185,
      yticks: [-180, -90, 0, 90, 180],
      ytickFmt: (v) => `${v}°`,
      legend: [["φ", C.red], ["θ", C.green], ["ψ", C.blue]],
    }
  );
  plotLines(
    $("s-quat"),
    [C.ink, C.red, C.green, C.blue].map((color, i) => ({ x: xs, y: h.map((s) => s.q[i]), color })),
    {
      x0: t1 - 8,
      x1: t1,
      y0: -1.05,
      y1: 1.05,
      yticks: [-1, -0.5, 0, 0.5, 1],
      legend: [["w", C.ink], ["x", C.red], ["y", C.green], ["z", C.blue]],
    }
  );
}

// ---------------------------------------------------------------------------
// Gimbal tab
// ---------------------------------------------------------------------------

const gimbal = { view: new View($("g-view"), { az: 230 * D2R, el: 22 * D2R }, 0.95) };

function gimbalKnobs() {
  return {
    roll: Number($("g-roll").value) * D2R,
    pitch: Number($("g-pitch").value) * D2R,
    yaw: Number($("g-yaw").value) * D2R,
  };
}

function syncGimbalReadouts() {
  $("g-roll-read").textContent = `${$("g-roll").value}°`;
  $("g-pitch-read").textContent = `${$("g-pitch").value}°`;
  $("g-yaw-read").textContent = `${$("g-yaw").value}°`;
  const k = gimbalKnobs();
  const Ry = rot("z", k.yaw);
  const Rp = matMul(Ry, rot("y", k.pitch));
  const yawAxis = [0, 0, 1];
  const rollAxis = column(Rp, 0);
  const ang = Math.acos(clamp(Math.abs(dot(yawAxis, rollAxis)), 0, 1));
  const cond = gimbalCond(k.pitch);
  const locked = Math.abs(Math.abs(k.pitch) - Math.PI / 2) < 0.25 * D2R;
  $("g-m-angle").textContent = deg(ang, 1);
  $("g-m-cond").textContent = fmt(cond, 1);
  $("g-m-dof").textContent = locked ? "2 — locked" : "3";
  if (locked && k.pitch > 0) $("g-m-combo").textContent = `φ − ψ = ${deg(wrapPi(k.roll - k.yaw))}`;
  else if (locked) $("g-m-combo").textContent = `φ + ψ = ${deg(wrapPi(k.roll + k.yaw))}`;
  else $("g-m-combo").textContent = "φ, θ, ψ each";
  $("g-m-q").textContent = fmtQ(qcanon(qFromEuler(k.roll, k.pitch, k.yaw)), 2);
  $("g-badge").textContent = locked ? "locked" : Math.abs(k.pitch) > 75 * D2R ? "nearly locked" : "3 axes";
  let lesson;
  if (locked) {
    lesson = `Pitch ${deg(k.pitch)}: the roll ring's axis lies on the yaw ring's axis. Moving roll or yaw now spins the drone about the same vertical line, and only ${k.pitch > 0 ? "φ − ψ" : "φ + ψ"} is defined. No ring can turn it about the highlighted axis. The quaternion is still a perfectly ordinary ${fmtQ(qcanon(qFromEuler(k.roll, k.pitch, k.yaw)), 2)}.`;
  } else if (Math.abs(k.pitch) > 60 * D2R) {
    lesson = `Roll axis is only ${deg(ang, 0)} from the yaw axis. To turn about the highlighted axis the gimbal must spin yaw and roll against each other ${fmt(1 / Math.cos(k.pitch), 1)}× faster than the drone actually turns.`;
  } else {
    lesson = "Three rings, three independent axes. Raise pitch and watch the roll axis swing toward the yaw axis.";
  }
  $("g-lesson").textContent = lesson;
}

["g-roll", "g-pitch", "g-yaw"].forEach((id) => $(id).addEventListener("input", syncGimbalReadouts));
$("g-missing").addEventListener("change", syncGimbalReadouts);

const GIMBAL_PRESETS = { free: [0, 20, 30], near: [0, 80, 30], lock: [0, 90, 30], down: [0, -90, 30] };
document.querySelectorAll("[data-gpreset]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const [r, p, y] = GIMBAL_PRESETS[btn.dataset.gpreset];
    $("g-roll").value = r;
    $("g-pitch").value = p;
    $("g-yaw").value = y;
    syncGimbalReadouts();
  });
});

function drawRing(v, center, axisA, axisB, radius, color, pivot, label) {
  const pts = circlePoints(center, axisA, axisB, radius, 64);
  v.path(pts, { color, width: 5, alpha: 0.85 });
  v.dot(add(center, scale(pivot, radius)), 4.5, color);
  v.dot(add(center, scale(pivot, -radius)), 4.5, color);
  v.line(scale(pivot, -radius - 0.3), scale(pivot, radius + 0.3), { color, width: 1, dash: [4, 4], alpha: 0.7 });
  v.text(add(center, scale(pivot, radius + 0.42)), label, { color });
}

function drawGimbal() {
  const k = gimbalKnobs();
  const v = gimbal.view;
  const Ry = rot("z", k.yaw);
  const Rp = matMul(Ry, rot("y", k.pitch));
  const Rb = matMul(Rp, rot("x", k.roll));
  v.begin();
  drawGround(v, 1.9, 2.5, 0.8);
  drawWorldAxes(v, [0, 0, 0], 2.1);
  const z = [0, 0, 1];
  const yYaw = column(Ry, 1);
  const xP = column(Rp, 0);
  // outer: pivots on world z; contains yaw-frame y where the pitch ring hangs
  drawRing(v, [0, 0, 0], z, yYaw, 1.6, C.blue, z, "yaw");
  // middle: pivots on yaw-frame y; contains pitched x where the roll ring hangs
  drawRing(v, [0, 0, 0], yYaw, xP, 1.36, C.green, yYaw, "pitch");
  // inner: pivots on body x; holds the drone
  drawRing(v, [0, 0, 0], column(Rb, 0), column(Rb, 2), 1.12, C.red, column(Rb, 0), "roll");
  drawDrone(v, Rb, [0, 0, 0], { scale: 0.95 });

  if ($("g-missing").checked && Math.abs(k.pitch) > 45 * D2R) {
    const miss = unit(cross(z, yYaw));
    const a = clamp((Math.abs(k.pitch) - 45 * D2R) / (45 * D2R), 0, 1);
    v.arrow([0, 0, 0], scale(miss, 2.0), { color: C.amber, width: 3, alpha: 0.3 + 0.7 * a, label: "stuck axis" });
    v.arrow([0, 0, 0], scale(miss, -2.0), { color: C.amber, width: 3, alpha: 0.3 + 0.7 * a });
  }
  v.flush();
  v.hud([["drag to orbit", C.mute]]);

  // 1 / cos θ curve
  const canvas = $("g-curve");
  const xs = [];
  const sec = [];
  const tan = [];
  for (let d = -90; d <= 90; d += 0.5) {
    xs.push(d);
    const c = Math.cos(d * D2R);
    sec.push(Math.abs(c) < 1e-6 ? Infinity : 1 / Math.abs(c));
    tan.push(Math.abs(c) < 1e-6 ? Infinity : Math.abs(Math.tan(d * D2R)));
  }
  const pl = plotLines(
    canvas,
    [
      { x: xs, y: sec, color: C.blue, width: 2.4 },
      { x: xs, y: tan, color: C.red, width: 1.6, dash: [5, 4] },
    ],
    {
      x0: -90,
      x1: 90,
      y0: 0,
      y1: 12,
      yticks: [0, 2, 4, 6, 8, 10, 12],
      ytickFmt: (v) => `${v}×`,
      marker: k.pitch * R2D,
      legend: [["1/cos θ → ψ̇", C.blue], ["|tan θ| → φ̇", C.red]],
    }
  );
  const pd = k.pitch * R2D;
  const val = Math.abs(Math.cos(k.pitch)) < 1e-6 ? Infinity : 1 / Math.abs(Math.cos(k.pitch));
  const { ctx, X, Y, k: kk } = pl;
  ctx.fillStyle = C.amber;
  ctx.beginPath();
  ctx.arc(X(pd), Y(Math.min(12, val)), 5 * kk, 0, Math.PI * 2);
  ctx.fill();
  label2d(ctx, `θ ${fmt(pd, 1)}° → ${Number.isFinite(val) ? fmt(val, 2) + "×" : "∞"}`, X(pd) + (pd > 0 ? -10 : 10) * kk, Y(Math.min(8, val)) - 14 * kk, C.amber, kk, pd > 0 ? "right" : "left");
  ctx.fillStyle = C.mute;
  ctx.font = `${10 * kk}px ui-monospace, "SF Mono", Menlo, monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  [-90, -45, 0, 45, 90].forEach((d) => ctx.fillText(`${d}°`, X(d), canvas.height - 18 * kk));
}

// ---------------------------------------------------------------------------
// Interpolate tab
// ---------------------------------------------------------------------------

const interpCam = { az: 215 * D2R, el: 22 * D2R };
const interp = {
  views: [new View($("i-slerp"), interpCam, 1.1), new View($("i-euler"), interpCam, 1.1)],
  playing: false,
  N: 160,
};
const I_IDS = ["i-ar", "i-ap", "i-ay", "i-br", "i-bp", "i-by"];

function rebuildInterp() {
  I_IDS.forEach((id) => {
    $(`${id}-read`).textContent = `${$(id).value}°`;
  });
  const a = ["i-ar", "i-ap", "i-ay"].map((id) => Number($(id).value) * D2R);
  const b = ["i-br", "i-bp", "i-by"].map((id) => Number($(id).value) * D2R);
  const qa = qFromEuler(...a);
  const qb = qFromEuler(...b);
  const N = interp.N;
  const sl = [];
  const el = [];
  for (let i = 0; i <= N; i += 1) {
    const t = i / N;
    sl.push(slerp(qa, qb, t));
    el.push(qFromEuler(...a.map((x, j) => x + t * wrapPi(b[j] - x))));
  }
  const speed = (path) => path.map((q, i) => (i === 0 ? null : angleBetween(path[i - 1], q) * N * R2D));
  const arc = (path) => path.reduce((acc, q, i) => (i ? acc + angleBetween(path[i - 1], q) : 0), 0);
  Object.assign(interp, { qa, qb, sl, el, slSpeed: speed(sl), elSpeed: speed(el), geo: angleBetween(qa, qb), slArc: arc(sl), elArc: arc(el) });
  const tip = (path, v) => path.map((q) => matVec(qToMat(q), v));
  interp.traces = [
    [tip(sl, [1.0, 0, 0]), tip(sl, [0, 0.85, 0])],
    [tip(el, [1.0, 0, 0]), tip(el, [0, 0.85, 0])],
  ];
  $("i-m-geo").textContent = deg(interp.geo, 1);
  $("i-m-s").textContent = deg(interp.slArc, 1);
  $("i-m-e").textContent = deg(interp.elArc, 1);
  const extra = interp.geo > 1e-6 ? (interp.elArc / interp.geo - 1) * 100 : 0;
  $("i-m-extra").textContent = `${fmt(extra, 0)}%`;
  $("i-badge-e").textContent = extra < 1 ? "same path" : `+${fmt(extra, 0)}% turning`;
  let lesson;
  if (interp.geo < 1e-4) lesson = "A and B are the same attitude. Nothing to interpolate.";
  else if (extra < 1)
    lesson = "Here Euler lerp happens to follow the great circle too — only one angle changes, so it is a single-axis turn. Move two or three angles at once.";
  else
    lesson = `SLERP turns ${deg(interp.geo, 1)} about one fixed axis at constant rate. Euler lerp turns ${deg(interp.elArc, 1)} — ${fmt(extra, 0)}% more — because three angles moving independently do not trace the shortest path. Look at the arm-tip trace twist.`;
  $("i-lesson").textContent = lesson;
}

I_IDS.forEach((id) => $(id).addEventListener("input", rebuildInterp));
$("i-t").addEventListener("input", () => {
  interp.playing = false;
  $("i-play").textContent = "Play";
});
$("i-play").addEventListener("click", () => {
  interp.playing = !interp.playing;
  if (interp.playing && Number($("i-t").value) >= 1) $("i-t").value = 0;
  $("i-play").textContent = interp.playing ? "Pause" : "Play";
});

const INTERP_PRESETS = {
  corner: [[0, 0, 0], [90, 80, 90]],
  yaw: [[0, 0, -85], [0, 0, 85]],
  over: [[0, 10, 0], [0, 80, 170]],
  flip: [[0, 0, 0], [170, 20, 30]],
};
document.querySelectorAll("[data-ipreset]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const [A, B] = INTERP_PRESETS[btn.dataset.ipreset];
    ["i-ar", "i-ap", "i-ay"].forEach((id, i) => {
      $(id).value = A[i];
    });
    ["i-br", "i-bp", "i-by"].forEach((id, i) => {
      $(id).value = B[i];
    });
    rebuildInterp();
    $("i-t").value = 0;
    interp.playing = true;
    $("i-play").textContent = "Pause";
  });
});

function drawSphere(v, r) {
  const ex = [1, 0, 0];
  const ey = [0, 1, 0];
  const ez = [0, 0, 1];
  v.path(circlePoints([0, 0, 0], ex, ey, r, 64), { color: C.line, width: 1, bias: 2 });
  v.path(circlePoints([0, 0, 0], ex, ez, r, 64), { color: C.line, width: 1, bias: 2 });
  v.path(circlePoints([0, 0, 0], ey, ez, r, 64), { color: C.line, width: 1, bias: 2 });
}

function tickInterp(dt) {
  if (interp.playing) {
    let t = Number($("i-t").value) + dt / 3;
    if (t >= 1) {
      t = 1;
      interp.playing = false;
      $("i-play").textContent = "Play";
    }
    $("i-t").value = t;
  }
  const t = Number($("i-t").value);
  $("i-t-read").textContent = fmt(t, 2);
  const idx = Math.round(t * interp.N);
  const paths = [interp.sl, interp.el];
  paths.forEach((path, j) => {
    const v = interp.views[j];
    v.begin();
    drawSphere(v, 1.0);
    drawWorldAxes(v, [0, 0, 0], 1.45);
    const [nose, side] = interp.traces[j];
    v.path(nose, { color: C.red, width: 1.2, alpha: 0.3 });
    v.path(side, { color: C.amber, width: 1.2, alpha: 0.3 });
    v.path(nose.slice(0, idx + 1), { color: C.red, width: 2.6 });
    v.path(side.slice(0, idx + 1), { color: C.amber, width: 2.6 });
    v.text(nose[0], "A", { color: C.ink, size: 13 });
    v.text(nose[nose.length - 1], "B", { color: C.ink, size: 13 });
    const R = qToMat(path[idx]);
    drawDrone(v, R, [0, 0, 0], { scale: 1.15 });
    if (j === 0 && interp.geo > 1e-4) {
      const rv = qToRotvec(qmul([interp.qa[0], -interp.qa[1], -interp.qa[2], -interp.qa[3]], interp.qb));
      // body-frame axis of the A→B turn, drawn in the world frame of A
      const axisW = matVec(qToMat(interp.qa), unit(rv));
      v.line(scale(axisW, -1.35), scale(axisW, 1.35), { color: C.violet, width: 1.5, dash: [6, 5] });
      v.text(scale(axisW, 1.45), "fixed axis", { color: C.violet, size: 11 });
    }
    v.flush();
  });
  $("i-m-gap").textContent = deg(angleBetween(interp.sl[idx], interp.el[idx]), 1);

  const xs = interp.sl.map((_, i) => i / interp.N);
  const top = Math.max(10, ...interp.elSpeed.filter((v) => v != null), ...interp.slSpeed.filter((v) => v != null)) * 1.15;
  plotLines(
    $("i-speed"),
    [
      { x: xs, y: interp.slSpeed, color: C.amber, width: 2.4 },
      { x: xs, y: interp.elSpeed, color: C.blue, width: 2 },
    ],
    {
      x0: 0,
      x1: 1,
      y0: 0,
      y1: top,
      yticks: [0, Math.round(top / 2), Math.round(top)],
      ytickFmt: (v) => `${v}°`,
      marker: t,
    }
  );
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

function tick(now) {
  if (!tick.last) tick.last = now;
  const dt = Math.min(0.05, (now - tick.last) / 1000);
  tick.last = now;
  if (state.tab === "attitude") drawAttitude(now);
  if (state.tab === "forces") drawForces();
  if (state.tab === "spin") tickSpin(dt);
  if (state.tab === "gimbal") drawGimbal();
  if (state.tab === "interp") tickInterp(dt);
  requestAnimationFrame(tick);
}

syncAttReadouts();
syncForceReadouts();
syncSpinReadouts();
resetSpin();
syncGimbalReadouts();
rebuildInterp();
const startTab = location.hash.slice(1);
if (startTab && document.getElementById(`panel-${startTab}`)) showTab(startTab);
window.addEventListener("hashchange", () => {
  const name = location.hash.slice(1);
  if (name && document.getElementById(`panel-${name}`)) showTab(name);
});
requestAnimationFrame(tick);
