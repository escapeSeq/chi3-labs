import { ARENA, DT, wrapAngle } from "./physics.js";
import { clip } from "./rng.js";

export const GRID = 64;
export const CHANNELS = ["prey", "danger", "kill", "traffic"];
export const TAU = 2.8;

function cell(x, y) {
  const i = clip(Math.floor(Number(x) / ARENA * GRID), 0, GRID - 1) | 0;
  const j = clip(Math.floor(Number(y) / ARENA * GRID), 0, GRID - 1) | 0;
  return [i, j];
}

function idx(c, j, i) {
  return c * GRID * GRID + j * GRID + i;
}

export class SharedMemory {
  constructor() {
    this.reset();
  }

  reset() {
    this.grid = new Float64Array(CHANNELS.length * GRID * GRID);
    this.writes = 0;
    this.hits = 0;
  }

  decay() {
    const factor = Math.exp(-DT / TAU);
    for (let i = 0; i < this.grid.length; i++) this.grid[i] *= factor;
  }

  splat(channel, x, y, value = 1) {
    const c = CHANNELS.indexOf(channel);
    if (c < 0) return;
    const [ci, cj] = cell(x, y);
    for (const di of [-1, 0, 1]) {
      for (const dj of [-1, 0, 1]) {
        const ii = ci + di;
        const jj = cj + dj;
        if (ii >= 0 && ii < GRID && jj >= 0 && jj < GRID) {
          const w = value * (di === 0 && dj === 0 ? 1 : 0.45);
          const k = idx(c, jj, ii);
          this.grid[k] = Math.min(1, this.grid[k] + w);
        }
      }
    }
    this.writes += 1;
  }

  sample(channel, x, y) {
    const c = CHANNELS.indexOf(channel);
    const [i, j] = cell(x, y);
    return this.grid[idx(c, j, i)];
  }

  centroid(channel) {
    const c = CHANNELS.indexOf(channel);
    let mass = 0;
    let sx = 0;
    let sy = 0;
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        const v = this.grid[idx(c, j, i)];
        mass += v;
        sx += i * v;
        sy += j * v;
      }
    }
    if (mass < 1e-4) return [0.5, 0.5, 0];
    const cx = (sx / mass + 0.5) / GRID;
    const cy = (sy / mass + 0.5) / GRID;
    return [cx, cy, Math.min(1, mass / 8)];
  }

  readout(me) {
    const [nx, ny, mass] = this.centroid("prey");
    const px = nx * ARENA;
    const py = ny * ARENA;
    let dx = px - me.x;
    let dy = py - me.y;
    const c = Math.cos(me.heading);
    const s = Math.sin(me.heading);
    let fwd = dx * c + dy * s;
    let right = -dx * s + dy * c;
    const heat = this.sample("danger", me.x, me.y) + 0.45 * this.sample("traffic", me.x, me.y);
    const kill = this.sample("kill", me.x, me.y);
    if (mass < 0.05) {
      fwd = 0;
      right = 0;
    }
    return {
      mem_fwd: clip(fwd, -1, 1),
      mem_right: clip(right, -1, 1),
      mem_heat: clip(heat, 0, 1),
      mem_kill: clip(kill, 0, 1),
      prey_x: nx,
      prey_y: ny,
      prey_mass: mass,
    };
  }

  scentTurn(me) {
    const feat = this.readout(me);
    if (feat.prey_mass < 0.05) return 0;
    const bearing = wrapAngle(Math.atan2(feat.prey_y * ARENA - me.y, feat.prey_x * ARENA - me.x) - me.heading);
    return clip(bearing / (Math.PI / 2), -1, 1);
  }

  energy() {
    const out = {};
    for (let c = 0; c < CHANNELS.length; c++) {
      let sum = 0;
      const off = c * GRID * GRID;
      for (let k = 0; k < GRID * GRID; k++) sum += this.grid[off + k];
      out[CHANNELS[c]] = sum;
    }
    return out;
  }

  snapshot() {
    const layers = {};
    for (let c = 0; c < CHANNELS.length; c++) {
      const rows = [];
      for (let j = 0; j < GRID; j++) {
        const row = [];
        for (let i = 0; i < GRID; i++) row.push(Math.round(this.grid[idx(c, j, i)] * 1000) / 1000);
        rows.push(row);
      }
      layers[CHANNELS[c]] = rows;
    }
    const [px, py, mass] = this.centroid("prey");
    return {
      grid: GRID,
      channels: CHANNELS.slice(),
      layers,
      energy: this.energy(),
      writes: this.writes,
      hits: this.hits,
      prey: { x: px, y: py, mass },
    };
  }

  watch(planes, newEvents, packNames, senseRange = 0.4) {
    this.decay();
    const preys = planes.filter((p) => p.role === "prey" && p.alive);
    const packSet = packNames instanceof Set ? packNames : new Set(packNames || []);
    for (const plane of planes) {
      if (!plane.alive) continue;
      if (plane.role === "pack" || packSet.has(plane.name)) {
        this.splat("traffic", plane.x, plane.y, 0.28);
        for (const prey of preys) {
          const dist = Math.hypot(plane.x - prey.x, plane.y - prey.y);
          if (dist <= senseRange) this.splat("prey", prey.x, prey.y, 0.7);
        }
      } else if (plane.role === "prey") {
        this.splat("prey", plane.x, plane.y, 0.12);
      }
    }
    for (const event of newEvents) {
      if (event.endsWith("_wall")) {
        const name = event.slice(0, -5);
        const plane = planes.find((p) => p.name === name);
        if (plane) this.splat("danger", plane.x, plane.y, 0.9);
      } else if (event === "midair") {
        for (const plane of planes) {
          if (!plane.alive) this.splat("danger", plane.x, plane.y, 0.7);
        }
      } else if (event.endsWith("_kill")) {
        const owner = event.slice(0, -5);
        const shooter = planes.find((p) => p.name === owner);
        if (shooter) {
          this.splat("kill", shooter.x, shooter.y, 1);
          this.hits += 1;
        }
      } else if (event === "prey_down") {
        for (const prey of planes) {
          if (prey.role === "prey") this.splat("kill", prey.x, prey.y, 1);
        }
        this.hits += 1;
      }
    }
  }
}
