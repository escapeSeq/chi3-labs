import { ACTION_NAMES, Policy, watchStats } from "./agents.js";
import { SharedMemory } from "./memory.js";
import {
  DEFAULT_HIVE,
  DEFAULT_PREY,
  MAX_PLANES,
  MAX_STEPS,
  MIN_HIVE,
  MIN_PREY,
  MIN_STEPS,
  MAX_STEPS_CAP,
  MODE_HUNT,
  SENSE_RANGE,
  SPEED,
  TURN_RADIUS,
  GUN_RANGE,
  ARENA,
  DT,
  World,
  clampMaxSteps,
  clampMode,
  clampPlaneCount,
  clampTeamCounts,
  makeLineup,
  secondsFromSteps,
  stepsFromSeconds,
} from "./physics.js";
import { clip } from "./rng.js";
import { extraTurns } from "./swarm.js";
import { mulberry32 } from "./rng.js";

export const CURVE_KEEP = 200;
export const SAVE_EVERY = 40;
export const SHARE_ISOLATED = "isolated";
export const SHARE_BOARD = "blackboard";
export const SHARE_HIVE = "hive";
export const SHARE_MODES = [SHARE_ISOLATED, SHARE_BOARD, SHARE_HIVE];

export function clampShare(mode) {
  const text = String(mode || "")
    .trim()
    .toLowerCase();
  if (["isolated", "private", "solo"].includes(text)) return SHARE_ISOLATED;
  if (["blackboard", "board", "map", "memory"].includes(text)) return SHARE_BOARD;
  return SHARE_HIVE;
}

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
      last_outcome: this.last_outcome,
      last_pack_losses: this.last_pack_losses,
    };
  }

  note(events, nameToBrain, { mode, packDead }) {
    this.episodes += 1;
    this.last_winner = null;
    this.last_outcome = null;
    this.last_pack_losses = 0;
    for (const event of events) {
      if (event.endsWith("_kill")) {
        const name = event.slice(0, -5);
        const bid = nameToBrain[name] || name;
        this.kills[bid] = (this.kills[bid] || 0) + 1;
      } else if (event.endsWith("_wall")) {
        const name = event.slice(0, -5);
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
    this.last_pack_losses = (packDead || []).length;
    this.pack_losses += this.last_pack_losses;
    if (events.includes("escape")) {
      this.escapes += 1;
      this.last_outcome = "escape";
      this.last_winner = "prey";
    } else if (events.includes("pack_wipe")) {
      this.pack_wipes += 1;
      this.last_outcome = "wipe";
      this.last_winner = "prey";
    } else if (events.includes("prey_down")) {
      this.hunts += 1;
      this.last_winner = Object.values(nameToBrain).includes("hive") ? "hive" : "pack";
      if (events.includes("clean_hunt")) this.last_outcome = "clean_hunt";
      else if (events.some((e) => e.endsWith("_wall") && nameToBrain[e.slice(0, -5)] === "prey")) this.last_outcome = "prey_crash";
      else if (events.includes("midair")) this.last_outcome = "midair";
      else this.last_outcome = "hunt";
      if (this.last_outcome === "clean_hunt") this.clean_hunts += 1;
    }
  }
}

function brainLabel(brainId) {
  if (brainId === "prey") return "Prey";
  if (brainId === "hive") return "Hive";
  return String(brainId || "").toUpperCase();
}

export class Academy {
  constructor(seed = 11) {
    this.rng = mulberry32(seed);
    this.mode = MODE_HUNT;
    this.share = SHARE_HIVE;
    this.scores = emptyScores();
    this.curves = emptyCurves();
    this.empty = true;
    this.max_steps = MAX_STEPS;
    this.n_prey = DEFAULT_PREY;
    this.n_hive = DEFAULT_HIVE;
    this.swarm_gain = 0.55;
    this.memory_gain = 0.35;
    this.memory_on = true;
    this.prey = new Policy(this.rng, "prey");
    this.hive = new Policy(this.rng, "hive");
    this.memory = new SharedMemory();
    this.stats_gen = 0;
    this._cancel_play = false;
    this._burst_stop = false;
    this._burst_gen = 0;
    this.burst_running = false;
    this.burst_trained = 0;
    this.burst_error = null;
    this.burst_lr = 0.014;
    this.onPersist = null;
  }

  get score() {
    if (!this.scores[this.share]) this.scores[this.share] = new Scoreboard();
    return this.scores[this.share];
  }

  get curve() {
    if (!this.curves[this.share]) this.curves[this.share] = [];
    return this.curves[this.share];
  }

  get n_planes() {
    return this.n_prey + this.n_hive;
  }

  lineup() {
    const slots = makeLineup(this.n_prey, this.n_hive);
    if (this.mode !== MODE_HUNT) {
      for (const slot of slots) slot.role = "ffa";
    }
    return slots;
  }

  _policyFor(brainId) {
    return brainId === "prey" ? this.prey : this.hive;
  }

  usesMemory() {
    return Boolean(this.memory_on && this.share !== SHARE_ISOLATED);
  }

  dumpSnapshot() {
    return {
      mode: this.mode,
      share: this.share,
      empty: this.empty,
      max_steps: this.max_steps,
      n_planes: this.n_planes,
      n_prey: this.n_prey,
      n_hive: this.n_hive,
      swarm_gain: this.swarm_gain,
      memory_gain: this.memory_gain,
      memory_on: this.memory_on,
      burst_trained: this.burst_trained,
      scores: Object.fromEntries(Object.entries(this.scores).map(([k, b]) => [k, b.asDict()])),
      curves: Object.fromEntries(Object.entries(this.curves).map(([k, rows]) => [k, rows.slice(-CURVE_KEEP)])),
      weights: { prey: this.prey.dump(), hive: this.hive.dump() },
    };
  }

  persist() {
    if (typeof this.onPersist === "function") this.onPersist(this.dumpSnapshot());
  }

  restore(payload) {
    if (!payload || typeof payload !== "object") return false;
    try {
      this.mode = clampMode(payload.mode);
      this.share = clampShare(payload.share);
      if (payload.max_steps != null) this.max_steps = clampMaxSteps(payload.max_steps);
      const storedPlanes = clampPlaneCount(payload.n_planes || this.n_planes);
      if (payload.n_prey != null || payload.n_hive != null) {
        [this.n_prey, this.n_hive] = clampTeamCounts(payload.n_prey ?? DEFAULT_PREY, payload.n_hive ?? DEFAULT_HIVE);
      } else {
        [this.n_prey, this.n_hive] = clampTeamCounts(DEFAULT_PREY, storedPlanes - DEFAULT_PREY);
      }
      if (payload.swarm_gain != null) this.swarm_gain = Number(payload.swarm_gain);
      if (payload.memory_gain != null) this.memory_gain = Number(payload.memory_gain);
      if (payload.memory_on != null) this.memory_on = Boolean(payload.memory_on);
      const stored = payload.scores;
      if (stored && typeof stored === "object") {
        this.scores = Object.fromEntries(SHARE_MODES.map((key) => [key, new Scoreboard(stored[key] || {})]));
      }
      const storedC = payload.curves;
      if (storedC && typeof storedC === "object") {
        this.curves = Object.fromEntries(SHARE_MODES.map((key) => [key, (storedC[key] || []).slice(-CURVE_KEEP)]));
      }
      this.empty = Boolean(payload.empty ?? true);
      this.burst_trained = payload.burst_trained | 0;
      const weights = payload.weights || {};
      if (weights.prey) this.prey.load(weights.prey);
      if (weights.hive) this.hive.load(weights.hive);
      return true;
    } catch {
      this.resetModels(false);
      return false;
    }
  }

  resetModels(persist = true) {
    this.stopBurst(true);
    this.prey.reset();
    this.hive.reset();
    this.memory.reset();
    this._clearStats();
    this.empty = true;
    if (persist) this.persist();
  }

  resetStats(persist = true) {
    this.stats_gen += 1;
    this._clearStats();
    if (persist) this.persist();
  }

  resetMemory() {
    this.memory.reset();
  }

  resetBrain(which, persist = true) {
    const name = String(which || "")
      .trim()
      .toLowerCase();
    if (name === "prey" || name === "preys") this.prey.reset();
    else if (["hive", "pack", "hunter", "hunters"].includes(name)) this.hive.reset();
    else throw new Error("brain must be prey or hive");
    this.empty = this.prey.updates === 0 && this.hive.updates === 0;
    if (persist) this.persist();
    return name === "prey" || name === "preys" ? "prey" : "hive";
  }

  _clearStats() {
    this.scores = emptyScores();
    this.curves = emptyCurves();
  }

  setMode(mode, persist = true) {
    this.mode = clampMode(mode);
    if (persist) this.persist();
    return this.mode;
  }

  setShare(share, persist = true) {
    this.share = clampShare(share);
    if (!this.scores[this.share]) this.scores[this.share] = new Scoreboard();
    if (!this.curves[this.share]) this.curves[this.share] = [];
    if (persist) this.persist();
    return this.share;
  }

  setMaxSteps(steps, persist = true) {
    this.max_steps = clampMaxSteps(steps);
    if (persist) this.persist();
    return this.max_steps;
  }

  setNPlanes(n, persist = true) {
    this.interruptPlay();
    n = clampPlaneCount(n);
    const prey = clip(this.n_prey, MIN_PREY, n - MIN_HIVE);
    this.n_prey = prey;
    this.n_hive = n - prey;
    if (persist) this.persist();
    return this.n_planes;
  }

  setNPrey(n, persist = true) {
    this.interruptPlay();
    const cap = MAX_PLANES - this.n_hive;
    this.n_prey = Math.min(Math.max(MIN_PREY, Math.round(Number(n) || 0)), Math.max(MIN_PREY, cap));
    if (persist) this.persist();
    return this.n_prey;
  }

  setNHive(n, persist = true) {
    this.interruptPlay();
    const cap = MAX_PLANES - this.n_prey;
    this.n_hive = Math.min(Math.max(MIN_HIVE, Math.round(Number(n) || 0)), Math.max(MIN_HIVE, cap));
    if (persist) this.persist();
    return this.n_hive;
  }

  setGains({ swarmGain, memoryGain, memoryOn } = {}, persist = true) {
    if (swarmGain != null) this.swarm_gain = clip(Number(swarmGain), 0, 1);
    if (memoryGain != null) this.memory_gain = clip(Number(memoryGain), 0, 1);
    if (memoryOn != null) this.memory_on = Boolean(memoryOn);
    if (persist) this.persist();
  }

  rosterReport() {
    const used = this.lineup().map((item) => item.brain_id);
    const rows = [];
    for (const [brainId, policy] of [
      ["prey", this.prey],
      ["hive", this.hive],
    ]) {
      const info = policy.inspect();
      info.id = brainId;
      info.label = brainLabel(brainId);
      info.planes = used.filter((id) => id === brainId).length;
      info.assigned = used.includes(brainId);
      info.kills = this.score.kills[brainId] | 0;
      info.walls = this.score.walls[brainId] | 0;
      info.wins = this.score.wins[brainId] | 0;
      rows.push(info);
    }
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
    return {
      episodes: n,
      hunt_rate: rate(score.hunts),
      escape_rate: rate(score.escapes),
      wipe_rate: rate(score.pack_wipes),
      clean_hunt_rate: rate(score.clean_hunts),
      draw_rate: rate(score.draws),
      midair_rate: rate(score.midairs),
      pack_loss_rate: n ? score.pack_losses / n : 0,
      life: { mean: meanOf(curve, (row) => row.steps), recent: meanOf(tail, (row) => row.steps) },
      updates: { prey: this.prey.updates, hive: this.hive.updates },
    };
  }

  status() {
    const roster = this.rosterReport();
    return {
      empty: this.empty,
      score: this.score.asDict(),
      curve: this.curve.slice(-80),
      data_dir: "localStorage",
      stored: true,
      action_names: ACTION_NAMES.slice(),
      roster,
      lineup: this.lineup(),
      mode: this.mode,
      share: this.share,
      burst: this.burstStatus(),
      training: this.trainingReport(),
      memory: this.usesMemory() ? this.memory.snapshot() : null,
      memory_on: this.usesMemory(),
      gains: { swarm: this.swarm_gain, memory: this.memory_gain },
      physics: {
        mode: this.mode,
        share: this.share,
        turn_radius: TURN_RADIUS,
        speed: SPEED,
        gun_range: GUN_RANGE,
        sense_range: SENSE_RANGE,
        arena: ARENA,
        dt: DT,
        max_steps: this.max_steps,
        timeout: secondsFromSteps(this.max_steps),
        min_timeout: secondsFromSteps(MIN_STEPS),
        max_timeout: secondsFromSteps(MAX_STEPS_CAP),
        n_planes: this.n_planes,
        n_prey: this.n_prey,
        n_hive: this.n_hive,
        min_planes: MIN_PREY + MIN_HIVE,
        max_planes: MAX_PLANES,
        min_prey: MIN_PREY,
        min_hive: MIN_HIVE,
        swarm_gain: this.swarm_gain,
        memory_gain: this.memory_gain,
      },
    };
  }

  interruptPlay() {
    this._cancel_play = true;
  }

  play({ learn = true, lr = 0.014, record = true, persist = true, trace = true } = {}) {
    this._cancel_play = false;
    const epoch = this.stats_gen;
    const lineup = this.lineup();
    const world = new World(this.rng, {
      maxSteps: this.max_steps,
      lineup,
      mode: this.mode,
      nPlanes: this.n_planes,
      swarmGain: this.swarm_gain,
    });
    const rolls = {};
    for (const p of world.planes) rolls[p.name] = [];
    const lastObs = {};
    const frames = [];
    let seenEvents = 0;
    const packNames = new Set(world.pack().map((p) => p.name));
    const extrasOff = { mem_fwd: 0, mem_right: 0, mem_heat: 0, mem_kill: 0 };
    let aborted = false;
    while (!world.done()) {
      if (this._cancel_play) {
        aborted = true;
        break;
      }
      world.extra_turns = extraTurns(world);
      if (this.usesMemory()) {
        const byName = Object.fromEntries(world.planes.map((plane) => [plane.name, plane]));
        for (const [name, turn] of Object.entries(world.extra_turns)) {
          const plane = byName[name];
          if (!plane) continue;
          const scent = this.memory.scentTurn(plane);
          world.extra_turns[name] = clip(turn + this.memory_gain * scent, -1, 1);
        }
      }
      const actions = {};
      for (const plane of world.planes) {
        if (!plane.alive) continue;
        const extras = this.usesMemory() ? this.memory.readout(plane) : extrasOff;
        const obs = world.observe(plane.name, extras);
        lastObs[plane.name] = obs;
        actions[plane.name] = this._policyFor(plane.brain_id).act(obs)[0];
      }
      const reward = world.step(actions);
      const newEvents = world.events.slice(seenEvents);
      seenEvents = world.events.length;
      if (this.usesMemory()) this.memory.watch(world.planes, newEvents, packNames, SENSE_RANGE);
      for (const [name, action] of Object.entries(actions)) rolls[name].push([lastObs[name], action, Number(reward[name] || 0)]);
      if (trace) {
        const snap = world.snapshot();
        if (this.usesMemory() && (world.steps % 8 === 1 || newEvents.length || world.done())) snap.memory = this.memory.snapshot();
        for (const pose of snap.planes) pose.brain_label = brainLabel(pose.brain_id);
        frames.push(snap);
      }
    }
    if (aborted) {
      const snap = world.snapshot();
      snap.memory = this.usesMemory() ? this.memory.snapshot() : null;
      return { trace: [snap], summary: { events: ["aborted"], steps: world.steps, outcome: "aborted" }, memory: snap.memory, aborted: true };
    }
    const nameToBrain = Object.fromEntries(world.planes.map((p) => [p.name, p.brain_id]));
    if (record && epoch === this.stats_gen) {
      this.score.note(world.events, nameToBrain, {
        mode: this.mode,
        packDead: world.pack().filter((p) => !p.alive).map((p) => p.name),
      });
    }
    const brainRolls = {};
    const lastByBrain = {};
    for (const plane of world.planes) {
      const bid = plane.brain_id;
      if (!brainRolls[bid]) brainRolls[bid] = [];
      brainRolls[bid].push(...rolls[plane.name]);
      if (plane.name in lastObs) lastByBrain[bid] = lastObs[plane.name];
    }
    const probeFallback = Object.values(lastObs)[0] || world.observe(world.planes[0].name);
    const unique = [...new Set(Object.values(nameToBrain))];
    const brainStats = {};
    for (const bid of unique) {
      const policy = this._policyFor(bid);
      const roll = brainRolls[bid] || [];
      const probe = lastByBrain[bid] || probeFallback;
      brainStats[bid] = learn ? policy.learn(roll, 0.97, lr) : watchStats(policy, roll, probe);
    }
    const row = {
      episode: this.score.episodes,
      steps: world.steps,
      events: world.events,
      brains: brainStats,
      winner: this.score.last_winner,
      outcome: this.score.last_outcome,
      mode: this.mode,
      share: this.share,
      pack_losses: this.score.last_pack_losses,
      memory_energy: this.usesMemory() ? this.memory.energy() : {},
      score: this.score.asDict(),
    };
    if (learn) {
      this.empty = this.prey.updates === 0 && this.hive.updates === 0;
      if (record && epoch === this.stats_gen) {
        this.curve.push(row);
        const extra = this.curve.length - CURVE_KEEP;
        if (extra > 0) this.curve.splice(0, extra);
      }
      if (persist) this.persist();
    }
    if (!frames.length) {
      const snap = world.snapshot();
      snap.memory = this.usesMemory() ? this.memory.snapshot() : null;
      frames.push(snap);
    }
    return { trace: frames, summary: row, memory: this.usesMemory() ? this.memory.snapshot() : null };
  }

  burstStatus() {
    return { running: Boolean(this.burst_running), trained: this.burst_trained | 0, error: this.burst_error };
  }

  startBurst(lr = 0.014, resume = false) {
    if (this.burst_running) return this.burstStatus();
    this._burst_gen += 1;
    this.burst_lr = Number(lr) || 0.014;
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

function emptyScores() {
  return {
    [SHARE_ISOLATED]: new Scoreboard(),
    [SHARE_BOARD]: new Scoreboard(),
    [SHARE_HIVE]: new Scoreboard(),
  };
}

function emptyCurves() {
  return { [SHARE_ISOLATED]: [], [SHARE_BOARD]: [], [SHARE_HIVE]: [] };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { stepsFromSeconds, secondsFromSteps };
