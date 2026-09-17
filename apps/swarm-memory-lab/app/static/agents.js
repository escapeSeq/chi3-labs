import { choice, gaussian } from "./rng.js";
import { OBS, OBS_NAMES } from "./physics.js";

export const HIDDEN = 24;
export const ACTIONS = 6;
export const ACTION_NAMES = ["left", "straight", "right", "left+fire", "straight+fire", "right+fire"];
export const W1_INIT_RMS = Math.sqrt(2 / OBS);
export const W2_INIT_RMS = 0.15;
export const WEIGHT_CLIP = 8;

function zeros(n) {
  return new Float64Array(n);
}

function softmax(logits) {
  const n = logits.length;
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = Number.isFinite(logits[i]) ? logits[i] : 0;
    if (v > max) max = v;
  }
  const e = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const z = Math.min(20, Math.max(-20, (Number.isFinite(logits[i]) ? logits[i] : 0) - max));
    e[i] = Math.exp(z);
    sum += e[i];
  }
  if (!(sum > 0)) {
    const u = 1 / n;
    for (let i = 0; i < n; i++) e[i] = u;
    return e;
  }
  let total = 0;
  for (let i = 0; i < n; i++) {
    e[i] /= sum;
    if (!Number.isFinite(e[i])) e[i] = 0;
    total += e[i];
  }
  if (!(total > 0)) {
    const u = 1 / n;
    for (let i = 0; i < n; i++) e[i] = u;
    return e;
  }
  for (let i = 0; i < n; i++) e[i] /= total;
  return e;
}

function matvec(W, rows, cols, x, b) {
  const out = new Float64Array(rows);
  for (let i = 0; i < rows; i++) {
    let s = b[i];
    const off = i * cols;
    for (let j = 0; j < cols; j++) s += W[off + j] * x[j];
    out[i] = s;
  }
  return out;
}

function clipWeights(arr) {
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (!Number.isFinite(v)) arr[i] = 0;
    else if (v > WEIGHT_CLIP) arr[i] = WEIGHT_CLIP;
    else if (v < -WEIGHT_CLIP) arr[i] = -WEIGHT_CLIP;
  }
}

export class Policy {
  constructor(rng, name) {
    this.rng = rng;
    this.name = name;
    this.reset();
  }

  reset() {
    this.W1 = zeros(HIDDEN * OBS);
    this.b1 = zeros(HIDDEN);
    this.W2 = zeros(ACTIONS * HIDDEN);
    this.b2 = zeros(ACTIONS);
    for (let i = 0; i < this.W1.length; i++) this.W1[i] = gaussian(this.rng) * W1_INIT_RMS;
    for (let i = 0; i < this.W2.length; i++) this.W2[i] = gaussian(this.rng) * W2_INIT_RMS;
    this.baseline = 0;
    this.updates = 0;
  }

  copyFrom(other) {
    this.W1 = Float64Array.from(other.W1);
    this.b1 = Float64Array.from(other.b1);
    this.W2 = Float64Array.from(other.W2);
    this.b2 = Float64Array.from(other.b2);
    this.baseline = other.baseline;
    this.updates = other.updates;
  }

  dump() {
    return {
      W1: Array.from(this.W1),
      b1: Array.from(this.b1),
      W2: Array.from(this.W2),
      b2: Array.from(this.b2),
      baseline: this.baseline,
      updates: this.updates,
    };
  }

  load(data) {
    if (!data) return;
    this.W1 = Float64Array.from(data.W1 || []);
    this.b1 = Float64Array.from(data.b1 || []);
    this.W2 = Float64Array.from(data.W2 || []);
    this.b2 = Float64Array.from(data.b2 || []);
    if (this.W1.length !== HIDDEN * OBS || this.W2.length !== ACTIONS * HIDDEN) {
      this.reset();
      return;
    }
    this.baseline = Number(data.baseline) || 0;
    this.updates = Math.max(0, Number(data.updates) || 0);
  }

  _stabilize() {
    clipWeights(this.W1);
    clipWeights(this.b1);
    clipWeights(this.W2);
    clipWeights(this.b2);
    if (!Number.isFinite(this.baseline)) this.baseline = 0;
  }

  forward(obs) {
    const x = obs.length === OBS ? obs : Float64Array.from({ length: OBS }, (_, i) => obs[i] || 0);
    const pre = matvec(this.W1, HIDDEN, OBS, x, this.b1);
    const h = new Float64Array(HIDDEN);
    for (let i = 0; i < HIDDEN; i++) h[i] = Math.max(0, pre[i]);
    const logits = matvec(this.W2, ACTIONS, HIDDEN, h, this.b2);
    return { x, h, logits, probs: softmax(logits) };
  }

  act(obs) {
    const out = this.forward(obs);
    let probs = out.probs;
    let sum = 0;
    let ok = true;
    for (let i = 0; i < ACTIONS; i++) {
      if (!Number.isFinite(probs[i])) ok = false;
      sum += probs[i];
    }
    if (!ok || !(sum > 0)) {
      probs = new Float64Array(ACTIONS);
      for (let i = 0; i < ACTIONS; i++) probs[i] = 1 / ACTIONS;
    } else for (let i = 0; i < ACTIONS; i++) probs[i] /= sum;
    out.probs = probs;
    const action = choice(this.rng, ACTIONS, probs);
    const logp = Math.log(Math.min(1, Math.max(1e-8, probs[action])));
    return [action, logp, out];
  }

  entropy(obs) {
    const p = this.forward(obs).probs;
    let e = 0;
    for (let i = 0; i < p.length; i++) {
      const v = Math.min(1, Math.max(1e-8, p[i]));
      e -= v * Math.log(v);
    }
    return e;
  }

  inspect() {
    const probes = probeObs();
    const packs = probes.map((obs) => this.forward(obs));
    const meanP = new Float64Array(ACTIONS);
    let ent = 0;
    let hiddenOn = 0;
    const hiddenDead = new Int8Array(HIDDEN);
    hiddenDead.fill(1);
    const hiddenMean = zeros(HIDDEN);
    for (const pack of packs) {
      for (let i = 0; i < ACTIONS; i++) meanP[i] += pack.probs[i] / packs.length;
      let pe = 0;
      for (let i = 0; i < ACTIONS; i++) {
        const v = Math.min(1, Math.max(1e-8, pack.probs[i]));
        pe -= v * Math.log(v);
      }
      ent += pe / packs.length;
      for (let i = 0; i < HIDDEN; i++) {
        hiddenMean[i] += pack.h[i] / packs.length;
        if (pack.h[i] > 0) {
          hiddenOn += 1 / (HIDDEN * packs.length);
          hiddenDead[i] = 0;
        }
      }
    }
    let w1sq = 0;
    let w2sq = 0;
    let w1max = 0;
    let w2max = 0;
    for (const v of this.W1) {
      w1sq += v * v;
      w1max = Math.max(w1max, Math.abs(v));
    }
    for (const v of this.W2) {
      w2sq += v * v;
      w2max = Math.max(w2max, Math.abs(v));
    }
    let b1sq = 0;
    let b2sq = 0;
    for (const v of this.b1) b1sq += v * v;
    for (const v of this.b2) b2sq += v * v;
    const w1rms = Math.sqrt(w1sq / this.W1.length);
    const w2rms = Math.sqrt(w2sq / this.W2.length);
    let fav = 0;
    for (let i = 1; i < ACTIONS; i++) if (meanP[i] > meanP[fav]) fav = i;
    const w1 = [];
    for (let i = 0; i < HIDDEN; i++) w1.push(Array.from(this.W1.subarray(i * OBS, (i + 1) * OBS)));
    const w2 = [];
    for (let i = 0; i < ACTIONS; i++) w2.push(Array.from(this.W2.subarray(i * HIDDEN, (i + 1) * HIDDEN)));
    return {
      name: this.name,
      updates: this.updates,
      shape: { obs: OBS, hidden: HIDDEN, actions: ACTIONS },
      weights: {
        count: this.W1.length + this.W2.length + this.b1.length + this.b2.length,
        l2: Math.sqrt(w1sq + w2sq + b1sq + b2sq),
        w1_rms: w1rms,
        w2_rms: w2rms,
        w1_max: w1max,
        w2_max: w2max,
        w1_growth: w1rms / W1_INIT_RMS,
        w2_growth: w2rms / W2_INIT_RMS,
      },
      baseline: this.baseline,
      bias: Array.from(this.b2),
      obs_names: OBS_NAMES.slice(),
      w1,
      w2,
      hidden_mean: Array.from(hiddenMean),
      probe: {
        mean_probs: Array.from(meanP),
        max_prob: Math.max(...meanP),
        entropy: ent,
        hidden_active: hiddenOn,
        hidden_dead: hiddenDead.reduce((n, v) => n + v, 0),
      },
      favorite: ACTION_NAMES[fav],
    };
  }

  learn(rollout, gamma = 0.97, lr = 0.012) {
    if (!rollout.length) return { loss: 0, return: 0, entropy: 0 };
    const n = rollout.length;
    const returns = new Float64Array(n);
    let acc = 0;
    for (let i = n - 1; i >= 0; i--) {
      acc = rollout[i][2] + gamma * acc;
      returns[i] = acc;
    }
    const total = returns[0];
    this.baseline = 0.9 * this.baseline + 0.1 * total;
    const adv = new Float64Array(n);
    let mean = 0;
    for (let i = 0; i < n; i++) {
      adv[i] = returns[i] - this.baseline;
      mean += adv[i];
    }
    mean /= n;
    let varSum = 0;
    for (let i = 0; i < n; i++) varSum += (adv[i] - mean) ** 2;
    const scale = Math.sqrt(varSum / n) + 1e-6;
    for (let i = 0; i < n; i++) adv[i] /= scale;

    const dW1 = zeros(this.W1.length);
    const db1 = zeros(HIDDEN);
    const dW2 = zeros(this.W2.length);
    const db2 = zeros(ACTIONS);
    let loss = 0;
    let ent = 0;
    let hiddenOn = 0;
    for (let t = 0; t < n; t++) {
      const [obs, action, _r] = rollout[t];
      const a = adv[t];
      const out = this.forward(obs);
      const p = out.probs;
      let hon = 0;
      for (let i = 0; i < HIDDEN; i++) if (out.h[i] > 0) hon += 1;
      hiddenOn += hon / HIDDEN;
      let pe = 0;
      for (let i = 0; i < ACTIONS; i++) pe -= p[i] * Math.log(Math.min(1, Math.max(1e-8, p[i])));
      ent += pe;
      loss += -Math.log(Math.min(1, Math.max(1e-8, p[action]))) * a;
      const dlogits = new Float64Array(ACTIONS);
      for (let i = 0; i < ACTIONS; i++) dlogits[i] = (p[i] - (i === action ? 1 : 0)) * a;
      for (let i = 0; i < ACTIONS; i++) {
        db2[i] += dlogits[i];
        const off = i * HIDDEN;
        for (let j = 0; j < HIDDEN; j++) dW2[off + j] += dlogits[i] * out.h[j];
      }
      const dh = zeros(HIDDEN);
      for (let j = 0; j < HIDDEN; j++) {
        let s = 0;
        for (let i = 0; i < ACTIONS; i++) s += this.W2[i * HIDDEN + j] * dlogits[i];
        if (out.h[j] <= 0) s = 0;
        dh[j] = s;
        db1[j] += s;
        const off = j * OBS;
        for (let k = 0; k < OBS; k++) dW1[off + k] += s * out.x[k];
      }
    }
    const inv = lr / n;
    for (let i = 0; i < this.W1.length; i++) this.W1[i] -= inv * dW1[i];
    for (let i = 0; i < HIDDEN; i++) this.b1[i] -= inv * db1[i];
    for (let i = 0; i < this.W2.length; i++) this.W2[i] -= inv * dW2[i];
    for (let i = 0; i < ACTIONS; i++) this.b2[i] -= inv * db2[i];
    this._stabilize();
    this.updates += 1;
    const hist = new Array(ACTIONS).fill(0);
    for (const [, action] of rollout) hist[action] += 1;
    const fire = (hist[3] + hist[4] + hist[5]) / n;
    return {
      loss: loss / n,
      return: total,
      entropy: ent / n,
      actions: hist,
      fire_rate: fire,
      turn: {
        left: (hist[0] + hist[3]) / n,
        straight: (hist[1] + hist[4]) / n,
        right: (hist[2] + hist[5]) / n,
      },
      hidden_active: hiddenOn / n,
    };
  }
}

function padObs(core, extras) {
  const vec = zeros(OBS);
  for (let i = 0; i < core.length && i < OBS; i++) vec[i] = core[i];
  if (extras) for (const [k, v] of Object.entries(extras)) vec[Number(k)] = v;
  return vec;
}

function probeObs() {
  return [
    padObs([0.35, 0, 0.25, 0, 0, 0, 1, 0, 0.5, 0], { 10: 0.45, 11: 0.55, 12: 0.5, 13: 0.5 }),
    padObs([0, 0.35, 0.25, 0.2, 0, 0, 1, 0, 0.5, 0], { 10: 0.4, 11: 0.6, 12: 0.5, 13: 0.5, 14: 1, 15: -0.2, 17: 0.3 }),
    padObs([-0.35, 0, 0.25, 1, 0, 0, 1, 0, 0.5, 0], { 10: 0.5, 11: 0.5, 12: 0.5, 13: 0.5 }),
    padObs([0.2, 0, 0.15, 0, 0, 0, 1, 0, 0.08, 0], { 10: 0.12, 11: 0.88, 12: 0.5, 13: 0.5 }),
    padObs([0.15, 0.02, 0.12, 0, 0, 0, 1, 0, 0.5, 0], { 10: 0.5, 11: 0.5, 12: 0.5, 13: 0.5, 14: 1, 15: 0.18, 17: 0.2 }),
    padObs([0.15, 0.02, 0.12, 0, 0, 0, 1, 0, 0.5, 1], { 10: 0.5, 11: 0.5, 12: 0.5, 13: 0.5 }),
  ];
}

export function watchStats(policy, rollout, lastObs) {
  const n = Math.max(rollout.length, 1);
  const hist = new Array(ACTION_NAMES.length).fill(0);
  for (const [, action] of rollout) hist[action] += 1;
  let hidden = 0;
  if (rollout.length) {
    for (const [obs] of rollout) {
      const h = policy.forward(obs).h;
      let on = 0;
      for (let i = 0; i < h.length; i++) if (h[i] > 0) on += 1;
      hidden += on / h.length;
    }
    hidden /= rollout.length;
  }
  return {
    loss: 0,
    return: rollout.reduce((s, r) => s + r[2], 0),
    entropy: policy.entropy(lastObs),
    actions: hist,
    fire_rate: (hist[3] + hist[4] + hist[5]) / n,
    turn: {
      left: (hist[0] + hist[3]) / n,
      straight: (hist[1] + hist[4]) / n,
      right: (hist[2] + hist[5]) / n,
    },
    hidden_active: hidden,
  };
}
