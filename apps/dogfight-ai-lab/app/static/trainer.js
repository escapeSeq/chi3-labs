import { ACTION_NAMES, Policy, watchStats } from "./agents.js";
import {
  MAX_STEPS,
  MIN_PLANES,
  MODE_FFA,
  MODE_HUNT,
  World,
  clampMaxSteps,
  clampMode,
  clampPlaneCount,
  defaultLineup,
  planeId,
  secondsFromSteps,
  stepsFromSeconds,
} from "./physics.js";
import { mulberry32 } from "./rng.js";

export const CURVE_KEEP = 200;
export const SAVE_EVERY = 50;
export const MAX_BRAINS = 36;
const SAFE_ID = /^[a-z][a-z0-9-]{0,23}$/;

function intMap(value) {
  if (!value || typeof value !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(value)) out[String(k)] = v | 0;
  return out;
}

export class Scoreboard {
  constructor(payload) {
    const p = payload || {};
    this.kills = intMap(p.kills);
    this.walls = intMap(p.walls);
    this.wins = intMap(p.wins);
    this.midairs = p.midairs | 0;
    this.draws = p.draws | 0;
    this.episodes = p.episodes | 0;
    this.last_winner = p.last_winner ?? null;
    this.escapes = p.escapes | 0;
    this.hunts = p.hunts | 0;
    this.clean_hunts = p.clean_hunts | 0;
    this.pack_wipes = p.pack_wipes | 0;
    this.pack_losses = p.pack_losses | 0;
    this.prey_kills = intMap(p.prey_kills);
    this.prey_escapes = intMap(p.prey_escapes);
    this.pack_scores = intMap(p.pack_scores);
    this.pack_deaths = intMap(p.pack_deaths);
    this.last_outcome = p.last_outcome ?? null;
    this.last_pack_losses = p.last_pack_losses | 0;
  }

  asDict() {
    return {
      kills: { ...this.kills },
      walls: { ...this.walls },
      wins: { ...this.wins },
      midairs: this.midairs,
      draws: this.draws,
      episodes: this.episodes,
      last_winner: this.last_winner,
      escapes: this.escapes,
      hunts: this.hunts,
      clean_hunts: this.clean_hunts,
      pack_wipes: this.pack_wipes,
      pack_losses: this.pack_losses,
      prey_kills: { ...this.prey_kills },
      prey_escapes: { ...this.prey_escapes },
      pack_scores: { ...this.pack_scores },
      pack_deaths: { ...this.pack_deaths },
      last_outcome: this.last_outcome,
      last_pack_losses: this.last_pack_losses,
      red_kills: this.kills.p1 | 0,
      blue_kills: this.kills.p2 | 0,
      red_walls: this.walls.p1 | 0,
      blue_walls: this.walls.p2 | 0,
    };
  }

  note(events, nameToBrain, { mode = MODE_FFA, preyName = null, packNames = null, packDead = null } = {}) {
    this.episodes += 1;
    this.last_winner = null;
    this.last_outcome = null;
    this.last_pack_losses = 0;
    for (const event of events) {
      if (event.endsWith("_kill")) {
        const name = event.slice(0, -5);
        const bid = nameToBrain[name] || name;
        this.kills[bid] = (this.kills[bid] || 0) + 1;
      } else if (event.endsWith("_wall") || event.endsWith("_circle")) {
        const name = event.slice(0, event.lastIndexOf("_"));
        const bid = nameToBrain[name] || name;
        this.walls[bid] = (this.walls[bid] || 0) + 1;
      } else if (event.startsWith("win_") && mode !== MODE_HUNT) {
        const name = event.slice(4);
        const bid = nameToBrain[name] || name;
        this.wins[bid] = (this.wins[bid] || 0) + 1;
        this.last_winner = bid;
        this.last_outcome = "win";
      } else if (event === "midair") this.midairs += 1;
    }
    if (mode !== MODE_HUNT) {
      if (events.includes("draw") && !events.some((e) => e.startsWith("win_"))) {
        this.draws += 1;
        this.last_outcome = "failure";
      }
      return;
    }
    preyName = preyName || "p1";
    packNames = packNames || [];
    packDead = packDead || [];
    const preyBid = nameToBrain[preyName] || preyName;
    this.last_pack_losses = packDead.length;
    this.pack_losses += this.last_pack_losses;
    this.prey_kills[preyBid] = (this.prey_kills[preyBid] || 0) + events.filter((e) => e === `${preyName}_kill`).length;
    for (const name of packDead) {
      const bid = nameToBrain[name] || name;
      this.pack_deaths[bid] = (this.pack_deaths[bid] || 0) + 1;
    }
    if (events.includes("escape")) {
      this.escapes += 1;
      this.last_outcome = "escape";
      this.last_winner = preyBid;
      this.prey_escapes[preyBid] = (this.prey_escapes[preyBid] || 0) + 1;
    } else if (events.includes("pack_wipe")) {
      this.pack_wipes += 1;
      this.last_outcome = "wipe";
      this.last_winner = preyBid;
      this.prey_escapes[preyBid] = (this.prey_escapes[preyBid] || 0) + 1;
    } else if (events.includes("prey_down")) {
      this.hunts += 1;
      if (events.includes("clean_hunt")) this.last_outcome = "clean_hunt";
      else if (events.some((e) => (e.endsWith("_wall") || e.endsWith("_circle")) && e.startsWith(preyName))) this.last_outcome = "prey_crash";
      else if (events.includes("midair")) this.last_outcome = "midair";
      else this.last_outcome = "hunt";
      if (this.last_outcome === "clean_hunt") this.clean_hunts += 1;
      for (const name of packNames) {
        if (!packDead.includes(name)) {
          const bid = nameToBrain[name] || name;
          this.pack_scores[bid] = (this.pack_scores[bid] || 0) + 1;
        }
      }
    }
  }

  copyBrainStats(src, dst) {
    if (!src || !dst || src === dst) return;
    this.kills[dst] = this.kills[src] | 0;
    this.walls[dst] = this.walls[src] | 0;
    this.wins[dst] = this.wins[src] | 0;
    this.prey_kills[dst] = this.prey_kills[src] | 0;
    this.prey_escapes[dst] = this.prey_escapes[src] | 0;
    this.pack_scores[dst] = this.pack_scores[src] | 0;
    this.pack_deaths[dst] = this.pack_deaths[src] | 0;
    if (this.last_winner === src) this.last_winner = dst;
  }
}

function labelOf(raw, fallback) {
  const text = String(raw || "")
    .split(/\s+/)
    .join(" ")
    .slice(0, 32)
    .trim();
  return text || fallback;
}

function revisionLabel(parentLabel, revision) {
  const base = parentLabel.replace(/\s*r\d+$/, "").trim() || parentLabel;
  return labelOf(`${base} r${revision}`, `r${revision}`);
}

function brainId(raw) {
  const text = String(raw || "")
    .trim()
    .toLowerCase();
  return SAFE_ID.test(text) ? text : null;
}

function normalizeLineup(lineup, nPlanes, brains) {
  const n = clampPlaneCount(nPlanes || MIN_PLANES);
  const raw = Array.isArray(lineup) ? lineup : [];
  const ids = Object.keys(brains);
  const slots = [];
  for (let i = 0; i < n; i++) {
    const item = raw[i] && typeof raw[i] === "object" ? raw[i] : {};
    let id = brainId(item.brain_id) || planeId(i);
    if (!(id in brains)) id = planeId(i) in brains ? planeId(i) : ids[Math.min(i, ids.length - 1)];
    slots.push({ brain_id: id });
  }
  return slots;
}

export class BrainSlot {
  constructor(id, label, learn, policy, parentId = null, lineage = "", revision = 0, stored = false) {
    this.id = id;
    this.label = label;
    this.learn = Boolean(learn);
    this.policy = policy;
    this.parent_id = parentId;
    this.lineage = lineage || parentId || id;
    this.revision = revision | 0;
    this.stored = Boolean(stored);
  }

  meta() {
    return {
      id: this.id,
      label: this.label,
      learn: this.learn,
      parent_id: this.parent_id,
      lineage: this.lineage,
      revision: this.revision,
      stored: this.stored,
    };
  }
}

export class Academy {
  constructor(seed = 7) {
    this.rng = mulberry32(seed);
    this.mode = MODE_FFA;
    this.scores = { [MODE_FFA]: new Scoreboard(), [MODE_HUNT]: new Scoreboard() };
    this.curves = { [MODE_FFA]: [], [MODE_HUNT]: [] };
    this.empty = true;
    this.max_steps = MAX_STEPS;
    this.n_planes = MIN_PLANES;
    this.brains = {};
    this._ensureSeatBrains(this.n_planes);
    this.lineup = defaultLineup(this.n_planes);
    this.stats_gen = 0;
    this._cancel_play = false;
    this._burst_stop = false;
    this._burst_gen = 0;
    this.burst_running = false;
    this.burst_trained = 0;
    this.burst_error = null;
    this.burst_lr = 0.018;
    this.onPersist = null;
  }

  get score() {
    if (!this.scores[this.mode]) this.scores[this.mode] = new Scoreboard();
    return this.scores[this.mode];
  }

  set score(value) {
    this.scores[this.mode] = value;
  }

  get curve() {
    if (!this.curves[this.mode]) this.curves[this.mode] = [];
    return this.curves[this.mode];
  }

  get red() {
    return this._seatPolicy(0);
  }

  get blue() {
    return this._seatPolicy(1);
  }

  _seatPolicy(seat) {
    if (seat < this.lineup.length) {
      const bid = this.lineup[seat].brain_id;
      if (this.brains[bid]) return this.brains[bid].policy;
    }
    const fallback = planeId(seat) in this.brains ? planeId(seat) : Object.keys(this.brains)[0];
    return this.brains[fallback].policy;
  }

  _makeBrain(id, label, learn, parentId = null, lineage = "", revision = 0) {
    return new BrainSlot(id, labelOf(label, id.toUpperCase()), learn, new Policy(this.rng, id), parentId, lineage || parentId || id, revision, false);
  }

  _ensureSeatBrains(n) {
    for (let i = 0; i < n; i++) {
      const bid = planeId(i);
      if (!this.brains[bid]) this.brains[bid] = this._makeBrain(bid, `P${i + 1}`, true);
    }
  }

  dumpSnapshot() {
    const weights = {};
    for (const [id, slot] of Object.entries(this.brains)) weights[id] = slot.policy.dump();
    return {
      mode: this.mode,
      score: this.score.asDict(),
      curve: this.curve.slice(-CURVE_KEEP),
      scores: Object.fromEntries(Object.entries(this.scores).map(([k, b]) => [k, b.asDict()])),
      curves: Object.fromEntries(Object.entries(this.curves).map(([k, rows]) => [k, rows.slice(-CURVE_KEEP)])),
      empty: this.empty,
      max_steps: this.max_steps,
      n_planes: this.n_planes,
      brains: Object.values(this.brains).map((s) => s.meta()),
      lineup: this.lineup.map((s) => ({ ...s })),
      weights,
      burst_trained: this.burst_trained,
    };
  }

  persist() {
    if (typeof this.onPersist === "function") this.onPersist(this.dumpSnapshot());
  }

  restore(payload) {
    if (!payload || typeof payload !== "object") return false;
    try {
      let metas = payload.brains;
      if (!Array.isArray(metas) || !metas.length) {
        metas = [
          { id: "p1", label: "P1", learn: true },
          { id: "p2", label: "P2", learn: true },
        ];
      }
      const brains = {};
      const weights = payload.weights || {};
      for (const meta of metas) {
        if (!meta || typeof meta !== "object") continue;
        const id = brainId(meta.id);
        if (!id || brains[id]) continue;
        const slot = this._makeBrain(id, String(meta.label || id), Boolean(meta.learn ?? true), brainId(meta.parent_id), String(meta.lineage || id), Number(meta.revision) || 0);
        if (weights[id]) slot.policy.load(weights[id]);
        brains[id] = slot;
      }
      if (!Object.keys(brains).length) return false;
      this.brains = brains;
      if (payload.max_steps != null) this.max_steps = clampMaxSteps(payload.max_steps);
      const nPlanes = clampPlaneCount(payload.n_planes || this.n_planes);
      this._ensureSeatBrains(nPlanes);
      this.lineup = normalizeLineup(payload.lineup, nPlanes, this.brains);
      this.n_planes = this.lineup.length;
      const assigned = new Set(this.lineup.map((s) => s.brain_id));
      for (const meta of metas) {
        const id = brainId(meta?.id);
        if (!id || !this.brains[id]) continue;
        this.brains[id].stored = "stored" in meta ? Boolean(meta.stored) : !assigned.has(id);
      }
      this._detachStoredSeats();
      this._pruneEphemeral();
      this.mode = clampMode(payload.mode);
      const storedScores = payload.scores;
      if (storedScores && typeof storedScores === "object") {
        this.scores = {
          [MODE_FFA]: new Scoreboard(storedScores[MODE_FFA] || {}),
          [MODE_HUNT]: new Scoreboard(storedScores[MODE_HUNT] || {}),
        };
      } else {
        this.scores = { [MODE_FFA]: new Scoreboard(payload.score || {}), [MODE_HUNT]: new Scoreboard() };
      }
      const storedCurves = payload.curves;
      if (storedCurves && typeof storedCurves === "object") {
        this.curves = {
          [MODE_FFA]: (storedCurves[MODE_FFA] || []).slice(-CURVE_KEEP),
          [MODE_HUNT]: (storedCurves[MODE_HUNT] || []).slice(-CURVE_KEEP),
        };
      } else {
        this.curves = { [MODE_FFA]: (payload.curve || []).slice(-CURVE_KEEP), [MODE_HUNT]: [] };
      }
      this.empty = Boolean(payload.empty ?? this.score.episodes === 0);
      this.burst_trained = payload.burst_trained | 0;
      return true;
    } catch {
      this.resetModels(false);
      return false;
    }
  }

  resetModels(persist = true) {
    this.stopBurst(true);
    for (const slot of Object.values(this.brains)) {
      if (slot.stored) {
        slot.learn = false;
        continue;
      }
      slot.policy.reset();
    }
    this._clearModeStats();
    this.empty = true;
    if (persist) this.persist();
  }

  resetStats(persist = true) {
    this.stats_gen += 1;
    this._clearModeStats();
    if (persist) this.persist();
  }

  _clearModeStats() {
    this.scores = { [MODE_FFA]: new Scoreboard(), [MODE_HUNT]: new Scoreboard() };
    this.curves = { [MODE_FFA]: [], [MODE_HUNT]: [] };
  }

  setMode(mode, persist = true) {
    this.mode = clampMode(mode);
    if (!this.scores[this.mode]) this.scores[this.mode] = new Scoreboard();
    if (!this.curves[this.mode]) this.curves[this.mode] = [];
    if (persist) this.persist();
    return this.mode;
  }

  setMaxSteps(steps, persist = true) {
    this.max_steps = clampMaxSteps(steps);
    if (persist) this.persist();
    return this.max_steps;
  }

  setNPlanes(n, persist = true) {
    n = clampPlaneCount(n);
    while (this.lineup.length < n) {
      const seat = this.lineup.length;
      const slot = this._freshSeatBrain(seat);
      this.lineup.push({ brain_id: slot.id });
    }
    this.lineup = this.lineup.slice(0, n);
    this.n_planes = this.lineup.length;
    this._pruneEphemeral();
    if (persist) this.persist();
    return this.n_planes;
  }

  _freshSeatBrain(seat) {
    const bid = planeId(seat);
    if (!this.brains[bid]) {
      this.brains[bid] = this._makeBrain(bid, `P${seat + 1}`, true);
      return this.brains[bid];
    }
    const used = new Set(this.lineup.map((s) => s.brain_id));
    if (!used.has(bid) && !this.brains[bid].stored) return this.brains[bid];
    return this.addBrain(`P${seat + 1}`, true, false);
  }

  setRoster(brains, lineup = null, persist = true) {
    const byId = { ...this.brains };
    const selected = new Set();
    if (lineup) {
      for (const item of lineup) {
        const picked = brainId(item?.brain_id);
        if (picked) selected.add(picked);
      }
    }
    for (const meta of brains || []) {
      const id = brainId(meta?.id);
      if (!id || !byId[id]) continue;
      const slot = byId[id];
      if (slot.stored) {
        if (!selected.has(id)) slot.label = labelOf(meta.label, slot.label);
        slot.learn = false;
        continue;
      }
      slot.label = labelOf(meta.label, slot.label);
      slot.learn = Boolean(meta.learn ?? slot.learn);
    }
    if (lineup) {
      this.lineup = this._applyLineup(lineup);
      this.n_planes = this.lineup.length;
      this._pruneEphemeral();
    }
    if (persist) this.persist();
  }

  _applyLineup(lineup) {
    const n = clampPlaneCount(lineup.length || this.n_planes);
    const pending = [];
    for (let i = 0; i < n; i++) {
      const item = lineup[i] && typeof lineup[i] === "object" ? lineup[i] : {};
      let id = brainId(item.brain_id) || planeId(i);
      if (!this.brains[id]) id = this._freshSeatBrain(i).id;
      pending.push({ brain_id: id, learn: item.learn });
    }
    for (const item of pending) {
      if (this.brains[item.brain_id].stored) {
        const clone = this._checkoutBrain(item.brain_id, item.learn === true);
        item.brain_id = clone.id;
      }
    }
    const seats = [];
    for (let i = 0; i < pending.length; i++) {
      const item = pending[i];
      let brain_id = item.brain_id;
      const want = item.learn;
      const slot = this.brains[brain_id];
      const others = pending.filter((o, j) => j !== i && o.brain_id === brain_id);
      if (want === true && others.length && (others.some((o) => o.learn === false) || slot.learn === false)) {
        const child = this._checkoutBrain(brain_id, true);
        pending[i].brain_id = child.id;
        seats.push({ brain_id: child.id });
      } else {
        if (want === true) slot.learn = true;
        else if (want === false) slot.learn = false;
        seats.push({ brain_id });
      }
    }
    return seats.map((item) => ({ brain_id: this._flyableId(item.brain_id, false) }));
  }

  addBrain(label = "New brain", learn = true, persist = true) {
    if (Object.keys(this.brains).length >= MAX_BRAINS) throw new Error(`at most ${MAX_BRAINS} brains`);
    const id = this._nextBrainId();
    const slot = this._makeBrain(id, label || id.toUpperCase(), learn);
    this.brains[id] = slot;
    if (persist) this.persist();
    return slot;
  }

  reviseBrain(parentId, persist = true, assignSeat = null) {
    parentId = brainId(parentId) || parentId;
    if (!this.brains[parentId]) throw new Error(`unknown brain ${parentId}`);
    if (Object.keys(this.brains).length >= MAX_BRAINS) throw new Error(`at most ${MAX_BRAINS} brains`);
    const parent = this.brains[parentId];
    const lineage = parent.lineage || parent.id;
    const revision =
      1 +
      Math.max(
        parent.revision,
        ...Object.values(this.brains)
          .filter((s) => s.lineage === lineage)
          .map((s) => s.revision)
      );
    const child = this._makeBrain(this._nextBrainId(`${lineage}-r`), revisionLabel(parent.label, revision), true, parent.id, lineage, revision);
    child.policy.copyFrom(parent.policy);
    this.brains[child.id] = child;
    this._copyBrainStats(parent.id, child.id);
    parent.learn = false;
    parent.stored = true;
    if (assignSeat != null && assignSeat >= 0 && assignSeat < this.lineup.length) this.lineup[assignSeat].brain_id = child.id;
    if (persist) {
      this._detachStoredSeats();
      if (!this.lineup.some((s) => s.brain_id === child.id)) {
        child.stored = true;
        child.learn = false;
      }
      this._pruneEphemeral();
      this.persist();
    }
    return child;
  }

  removeBrain(id, persist = true) {
    id = brainId(id) || id;
    if (!this.brains[id]) throw new Error(`unknown brain ${id}`);
    const assigned = this.lineup.map((s, i) => (s.brain_id === id ? i : -1)).filter((i) => i >= 0);
    if (Object.keys(this.brains).length - 1 < 1) throw new Error("need at least one brain");
    delete this.brains[id];
    for (const seat of assigned) this.lineup[seat].brain_id = this._freshSeatBrain(seat).id;
    this._pruneEphemeral();
    if (persist) this.persist();
  }

  wipeBrain(id, persist = true) {
    id = brainId(id) || id;
    if (!this.brains[id]) throw new Error(`unknown brain ${id}`);
    this.brains[id].policy.reset();
    this.empty = Object.values(this.brains).every((s) => s.stored || s.policy.updates === 0);
    if (persist) this.persist();
  }

  _checkoutBrain(sourceId, learn = true) {
    sourceId = brainId(sourceId) || sourceId;
    const source = this.brains[sourceId];
    if (Object.keys(this.brains).length >= MAX_BRAINS) throw new Error(`at most ${MAX_BRAINS} brains`);
    const child = this._makeBrain(this._nextBrainId("w"), source.label, Boolean(learn), source.id, source.lineage || source.id, source.revision | 0);
    child.policy.copyFrom(source.policy);
    child.stored = false;
    this.brains[child.id] = child;
    this._copyBrainStats(source.id, child.id);
    return child;
  }

  _copyBrainStats(src, dst) {
    for (const board of Object.values(this.scores)) board.copyBrainStats(src, dst);
  }

  _flyableId(id, learn = true) {
    const slot = this.brains[id];
    if (!slot || !slot.stored) return id;
    return this._checkoutBrain(id, learn).id;
  }

  _detachStoredSeats() {
    const copies = {};
    for (const item of this.lineup) {
      const bid = item.brain_id;
      const slot = this.brains[bid];
      if (!slot || !slot.stored) continue;
      if (!(bid in copies)) copies[bid] = this._checkoutBrain(bid, false).id;
      item.brain_id = copies[bid];
      slot.learn = false;
    }
  }

  _assignedIds() {
    return new Set(this.lineup.map((s) => s.brain_id));
  }

  _pruneEphemeral() {
    const keep = this._assignedIds();
    const drop = Object.keys(this.brains).filter((id) => !keep.has(id) && !this.brains[id].stored);
    for (const id of drop) {
      if (Object.keys(this.brains).length <= 1) break;
      delete this.brains[id];
    }
  }

  _nextBrainId(prefix = "b") {
    prefix = String(prefix)
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "") || "b";
    let n = 1;
    while (true) {
      let candidate = `${prefix}${n}`;
      if (candidate.length > 24) candidate = `b${n}`;
      if (SAFE_ID.test(candidate) && !this.brains[candidate]) return candidate;
      n += 1;
    }
  }

  rosterReport() {
    const used = this.lineup.map((s) => s.brain_id);
    const episodes = this.score.episodes;
    const rows = [];
    for (const slot of Object.values(this.brains)) {
      const info = slot.policy.inspect();
      Object.assign(info, slot.meta());
      info.planes = used.filter((id) => id === slot.id).length;
      info.assigned = used.includes(slot.id);
      info.in_library = Boolean(slot.stored);
      info.parent_label = slot.parent_id && this.brains[slot.parent_id] ? this.brains[slot.parent_id].label : null;
      const wins = this.score.wins[slot.id] | 0;
      const kills = this.score.kills[slot.id] | 0;
      const walls = this.score.walls[slot.id] | 0;
      info.wins = wins;
      info.kills = kills;
      info.walls = walls;
      info.prey_kills = this.score.prey_kills[slot.id] | 0;
      info.prey_escapes = this.score.prey_escapes[slot.id] | 0;
      info.pack_scores = this.score.pack_scores[slot.id] | 0;
      info.pack_deaths = this.score.pack_deaths[slot.id] | 0;
      info.win_rate = episodes ? wins / episodes : 0;
      info.kill_rate = episodes ? kills / episodes : 0;
      info.wall_rate = episodes ? walls / episodes : 0;
      info.escape_rate = episodes ? info.prey_escapes / episodes : 0;
      info.hunt_rate = episodes ? info.pack_scores / episodes : 0;
      rows.push(info);
    }
    rows.sort((a, b) => String(a.lineage || a.id).localeCompare(b.lineage || b.id) || (a.revision || 0) - (b.revision || 0) || a.id.localeCompare(b.id));
    return rows;
  }

  trainingReport() {
    const score = this.score;
    const n = score.episodes;
    const curve = this.curve;
    const tail = curve.slice(-24);
    const rate = (count) => (n ? count / n : 0);
    const meanOf = (rows, pick) => {
      const values = rows.map(pick).filter((v) => v != null && Number.isFinite(v));
      if (!values.length) return null;
      return values.reduce((s, v) => s + v, 0) / values.length;
    };
    const last = curve[curve.length - 1] || null;
    const lastBrains = (last && last.brains) || {};
    const p1 = this.lineup[0]?.brain_id || "p1";
    const p2 = this.lineup[1]?.brain_id || "p2";
    const updates = {};
    for (const [id, slot] of Object.entries(this.brains)) updates[id] = slot.policy.updates;
    return {
      episodes: n,
      kill_rate: Object.fromEntries(Object.entries(score.kills).map(([k, v]) => [k, rate(v)])),
      win_rate: Object.fromEntries(Object.entries(score.wins).map(([k, v]) => [k, rate(v)])),
      wall_rate: Object.fromEntries(Object.entries(score.walls).map(([k, v]) => [k, rate(v)])),
      midair_rate: rate(score.midairs),
      draw_rate: rate(score.draws),
      escape_rate: rate(score.escapes),
      hunt_rate: rate(score.hunts),
      clean_hunt_rate: rate(score.clean_hunts),
      wipe_rate: rate(score.pack_wipes),
      pack_loss_rate: n ? score.pack_losses / n : 0,
      life: { mean: meanOf(curve, (r) => r.steps), recent: meanOf(tail, (r) => r.steps) },
      return: {
        red: meanOf(tail, (r) => ((r.brains || {})[p1] || r.red || {}).return),
        blue: meanOf(tail, (r) => ((r.brains || {})[p2] || r.blue || {}).return),
      },
      last_actions: {
        red: last ? (lastBrains[p1] || last.red || {}).actions : null,
        blue: last ? (lastBrains[p2] || last.blue || {}).actions : null,
        brains: Object.fromEntries(Object.entries(lastBrains).map(([k, row]) => [k, row.actions])),
      },
      divergence: Object.keys(this.brains).length >= 2 ? brainDivergence(this.red, this.blue) : { cosine: 1, l2: 0 },
      updates,
    };
  }

  status() {
    const roster = this.rosterReport();
    const brains = Object.fromEntries(roster.map((row) => [row.id, row]));
    return {
      empty: this.empty,
      score: this.score.asDict(),
      curve: this.curve.slice(-80),
      data_dir: "localStorage",
      stored: true,
      action_names: ACTION_NAMES.slice(),
      brains,
      roster,
      library: roster.filter((row) => row.in_library),
      lineup: this.lineup.map((s) => ({ ...s })),
      mode: this.mode,
      burst: this.burstStatus(),
      training: this.trainingReport(),
      physics: {
        mode: this.mode,
        turn_radius: 0.06,
        speed: 0.2,
        gun_range: 0.72 * 0.46,
        arena: 1,
        dt: 0.05,
        max_steps: this.max_steps,
        timeout: secondsFromSteps(this.max_steps),
        min_timeout: secondsFromSteps(200),
        max_timeout: secondsFromSteps(12000),
        n_planes: this.n_planes,
        min_planes: MIN_PLANES,
        max_planes: 9,
      },
    };
  }

  play({ learn = true, lr = 0.012, record = true, persist = true, trace = true } = {}) {
    this._cancel_play = false;
    const epoch = this.stats_gen;
    const world = new World(this.rng, { maxSteps: this.max_steps, lineup: this.lineup, mode: this.mode });
    const rolls = {};
    for (const p of world.planes) rolls[p.name] = [];
    const lastObs = {};
    const frames = [];
    const labels = Object.fromEntries(Object.values(this.brains).map((s) => [s.id, s.label]));
    let aborted = false;
    while (!world.done()) {
      if (this._cancel_play) {
        aborted = true;
        break;
      }
      const actions = {};
      for (const plane of world.planes) {
        if (!plane.alive) continue;
        const obs = world.observe(plane.name);
        lastObs[plane.name] = obs;
        const slot = this.brains[plane.brain_id] || this.brains[this.lineup[plane.seat].brain_id];
        actions[plane.name] = slot.policy.act(obs)[0];
      }
      const reward = world.step(actions);
      for (const [name, action] of Object.entries(actions)) rolls[name].push([lastObs[name], action, Number(reward[name] || 0)]);
      if (trace) {
        const snap = world.snapshot();
        for (const pose of snap.planes) pose.brain_label = labels[pose.brain_id] || pose.brain_id || "";
        frames.push(snap);
      }
    }
    if (aborted) {
      const snap = world.snapshot();
      for (const pose of snap.planes) pose.brain_label = labels[pose.brain_id] || pose.brain_id || "";
      return { trace: trace ? [snap] : [], summary: { events: ["aborted"], steps: world.steps, outcome: "aborted" }, aborted: true };
    }
    const brainRolls = {};
    const lastByBrain = {};
    const nameToBrain = {};
    for (const plane of world.planes) {
      const bid = this.brains[plane.brain_id] ? plane.brain_id : this.lineup[plane.seat].brain_id;
      nameToBrain[plane.name] = bid;
      if (!brainRolls[bid]) brainRolls[bid] = [];
      brainRolls[bid].push(...rolls[plane.name]);
      if (plane.name in lastObs) lastByBrain[bid] = lastObs[plane.name];
    }
    if (record && epoch === this.stats_gen) {
      const prey = world.prey();
      this.score.note(world.events, nameToBrain, {
        mode: this.mode,
        preyName: prey ? prey.name : null,
        packNames: world.pack().map((p) => p.name),
        packDead: world.pack().filter((p) => !p.alive).map((p) => p.name),
      });
    }
    const probeFallback = Object.values(lastObs)[0] || world.observe(world.planes[0].name);
    const brainStats = {};
    for (const [bid, slot] of Object.entries(this.brains)) {
      const roll = brainRolls[bid] || [];
      const probe = lastByBrain[bid] || probeFallback;
      brainStats[bid] = learn && slot.learn && !slot.stored ? slot.policy.learn(roll, 0.97, lr) : watchStats(slot.policy, roll, probe);
    }
    const p1 = nameToBrain[world.red.name] || "p1";
    const p2 = nameToBrain[world.blue.name] || "p2";
    const row = {
      episode: this.score.episodes,
      steps: world.steps,
      events: world.events,
      red: brainStats[p1] || watchStats(this.red, [], probeFallback),
      blue: brainStats[p2] || watchStats(this.blue, [], probeFallback),
      brains: brainStats,
      winner: this.score.last_winner,
      outcome: this.score.last_outcome,
      mode: this.mode,
      pack_losses: this.score.last_pack_losses,
      score: this.score.asDict(),
    };
    if (learn) {
      this.empty = Object.values(this.brains).every((s) => s.stored || s.policy.updates === 0);
      if (record && epoch === this.stats_gen) {
        this.curve.push(row);
        const extra = this.curve.length - CURVE_KEEP;
        if (extra > 0) this.curve.splice(0, extra);
      }
      if (persist) this.persist();
    }
    return { trace: frames, summary: row };
  }

  burstStatus() {
    return { running: Boolean(this.burst_running), trained: this.burst_trained | 0, error: this.burst_error };
  }

  startBurst(lr = 0.018, resume = false) {
    if (this.burst_running) return this.burstStatus();
    this._burst_gen += 1;
    this.burst_lr = Number(lr) || 0.018;
    this._burst_stop = false;
    this.burst_running = true;
    if (!resume) this.burst_trained = 0;
    this.burst_error = null;
    return this.burstStatus();
  }

  stopBurst(_join = false) {
    this._burst_stop = true;
    this._cancel_play = true;
    return this.burstStatus();
  }

  async runBurst() {
    const gen = this._burst_gen;
    const lr = this.burst_lr;
    try {
      this.persist();
      await delay(0);
      while (!this._burst_stop && gen === this._burst_gen) {
        try {
          this.play({ learn: true, lr, persist: false, trace: false });
          if (gen !== this._burst_gen) return;
          if (this._burst_stop) break;
          this.burst_trained += 1;
          if (this.burst_trained % SAVE_EVERY === 0) this.persist();
        } catch (err) {
          this.burst_error = String(err.message || err);
          await delay(50);
        }
        await delay(0);
      }
    } finally {
      if (gen === this._burst_gen) {
        this.burst_running = false;
        try {
          this.persist();
        } catch {
          /* ignore */
        }
      }
    }
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function brainDivergence(red, blue) {
  const a = concatWeights(red);
  const b = concatWeights(blue);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb) + 1e-12;
  let l2 = 0;
  for (let i = 0; i < a.length; i++) l2 += (a[i] - b[i]) ** 2;
  return { cosine: dot / denom, l2: Math.sqrt(l2) };
}

function concatWeights(p) {
  const out = new Float64Array(p.W1.length + p.W2.length + p.b1.length + p.b2.length);
  out.set(p.W1, 0);
  out.set(p.W2, p.W1.length);
  out.set(p.b1, p.W1.length + p.W2.length);
  out.set(p.b2, p.W1.length + p.W2.length + p.b1.length);
  return out;
}

export { stepsFromSeconds, secondsFromSteps };
