import { clip, uniform } from "./rng.js";

export const ARENA = 1.0;
export const DT = 0.05;
export const MAX_STEPS = 2400;
export const MIN_STEPS = 200;
export const MAX_STEPS_CAP = 12000;
export const SPEED = 0.2;
export const TURN_RADIUS = 0.06;
export const COLLIDE_R = 0.03;
export const BULLET_SPEED = 0.72;
export const BULLET_LIFE = 0.46;
export const HIT_R = 0.028;
export const COOLDOWN = 0.65;
export const GUN_RANGE = BULLET_SPEED * BULLET_LIFE;
export const SENSE_RANGE = 0.4;
export const MIN_PREY = 1;
export const MIN_HIVE = 1;
export const MAX_PLANES = 8;
export const DEFAULT_PREY = 1;
export const DEFAULT_HIVE = 4;
export const MIN_PLANES = MIN_PREY + MIN_HIVE;
export const DEFAULT_PLANES = DEFAULT_PREY + DEFAULT_HIVE;
export const MODE_FFA = "ffa";
export const MODE_HUNT = "hunt";
export const ROLE_PREY = "prey";
export const ROLE_PACK = "pack";
export const ROLE_FFA = "ffa";

export const OBS_NAMES = [
  "fwd",
  "right",
  "range",
  "rel h",
  "x",
  "y",
  "cos",
  "sin",
  "wall",
  "gun",
  "edge L",
  "edge R",
  "edge B",
  "edge T",
  "mem fwd",
  "mem rt",
  "mem heat",
  "mem kill",
  "ally fwd",
  "ally rt",
  "align",
  "crowd",
  "role pt",
  "role fl",
  "role fr",
  "role cut",
];
export const OBS = OBS_NAMES.length;

export function clampMaxSteps(steps) {
  return Math.min(MAX_STEPS_CAP, Math.max(MIN_STEPS, Math.round(Number(steps) || 0)));
}

export function stepsFromSeconds(seconds) {
  return clampMaxSteps(Math.round(Number(seconds) / DT));
}

export function secondsFromSteps(steps) {
  return clampMaxSteps(steps) * DT;
}

export function clampPlaneCount(n) {
  return Math.min(MAX_PLANES, Math.max(MIN_PLANES, Math.round(Number(n) || 0)));
}

export function clampTeamCounts(nPrey, nHive) {
  let prey = Math.max(MIN_PREY, Math.round(Number(nPrey) || 0));
  let hive = Math.max(MIN_HIVE, Math.round(Number(nHive) || 0));
  while (prey + hive > MAX_PLANES) {
    if (hive > MIN_HIVE) hive -= 1;
    else if (prey > MIN_PREY) prey -= 1;
    else break;
  }
  return [prey, hive];
}

export function clampMode(mode) {
  const text = String(mode || "")
    .trim()
    .toLowerCase()
    .replaceAll(" ", "-");
  if (["ffa", "free-for-all", "last-plane"].includes(text)) return MODE_FFA;
  return MODE_HUNT;
}

export function planeId(i) {
  return `p${i + 1}`;
}

export function makeLineup(nPrey = DEFAULT_PREY, nHive = DEFAULT_HIVE) {
  [nPrey, nHive] = clampTeamCounts(nPrey, nHive);
  const slots = [];
  for (let i = 0; i < nPrey; i++) slots.push({ brain_id: "prey", role: ROLE_PREY });
  for (let i = 0; i < nHive; i++) slots.push({ brain_id: "hive", role: ROLE_PACK });
  return slots;
}

export function defaultLineup(n, nPrey = DEFAULT_PREY) {
  n = clampPlaneCount(n);
  const prey = clip(Math.round(Number(nPrey) || DEFAULT_PREY), MIN_PREY, n - MIN_HIVE);
  return makeLineup(prey, n - prey);
}

export function maxYawRate() {
  return SPEED / TURN_RADIUS;
}

export function wrapAngle(a) {
  const tau = 2 * Math.PI;
  let x = (a + Math.PI) % tau;
  if (x < 0) x += tau;
  return x - Math.PI;
}

export class Plane {
  constructor(name, seat, x, y, heading, brainId, role) {
    this.name = name;
    this.seat = seat;
    this.x = x;
    this.y = y;
    this.heading = heading;
    this.brain_id = brainId || name;
    this.role = role || ROLE_FFA;
    this.swarm_role = "";
    this.cooldown = 0;
    this.alive = true;
  }

  pose() {
    return {
      name: this.name,
      seat: this.seat,
      brain_id: this.brain_id,
      role: this.role,
      swarm_role: this.swarm_role,
      x: this.x,
      y: this.y,
      heading: this.heading,
      cooldown: this.cooldown,
      alive: this.alive,
    };
  }
}

export class Bullet {
  constructor(x, y, heading, owner) {
    this.x = x;
    this.y = y;
    this.heading = heading;
    this.owner = owner;
    this.age = 0;
  }

  pose() {
    return { x: this.x, y: this.y, heading: this.heading, owner: this.owner };
  }
}

export class World {
  constructor(rng, { maxSteps = MAX_STEPS, nPlanes = DEFAULT_PLANES, nPrey = DEFAULT_PREY, mode = MODE_HUNT, lineup = null, swarmGain = 0.55 } = {}) {
    this.rng = rng;
    this.max_steps = Math.max(1, Math.round(maxSteps));
    this.mode = clampMode(mode);
    this.swarm_gain = swarmGain;
    this.extra_turns = {};
    if (lineup && lineup.length) {
      this.lineup = lineup.map((slot) => ({ ...slot }));
      this.n_planes = clampPlaneCount(this.lineup.length);
      this.lineup = this.lineup.slice(0, this.n_planes);
      const counted = this.lineup.filter((slot) => String(slot.role || slot.brain_id) === ROLE_PREY).length;
      this.n_prey = counted || Math.min(DEFAULT_PREY, Math.max(MIN_PREY, this.n_planes - MIN_HIVE));
    } else {
      const hive = Math.max(MIN_HIVE, nPlanes - Math.max(MIN_PREY, Math.round(Number(nPrey) || DEFAULT_PREY)));
      [this.n_prey, this.n_hive] = clampTeamCounts(nPrey, hive);
      this.n_planes = this.n_prey + this.n_hive;
      this.lineup = makeLineup(this.n_prey, this.n_hive);
    }
    this.reset();
  }

  get red() {
    return this.planes[0];
  }

  get blue() {
    return this.planes[1] || this.planes[0];
  }

  living() {
    return this.planes.filter((p) => p.alive);
  }

  prey() {
    const living = this.preysLiving();
    if (living.length) return living[0];
    const preys = this.preys();
    return preys[0] || null;
  }

  preys() {
    return this.planes.filter((p) => p.role === ROLE_PREY);
  }

  preysLiving() {
    return this.preys().filter((p) => p.alive);
  }

  pack() {
    return this.planes.filter((p) => p.role === ROLE_PACK);
  }

  packLiving() {
    return this.pack().filter((p) => p.alive);
  }

  reset() {
    const slots = this.lineup && this.lineup.length ? this.lineup : defaultLineup(this.n_planes);
    const n = slots.length;
    this.planes = [];
    for (let i = 0; i < n; i++) {
      const slot = slots[i];
      const name = planeId(i);
      const brainId = String(slot.brain_id || name);
      const slotRole = String(slot.role || "");
      let role;
      if (this.mode === MODE_HUNT) {
        if (slotRole === ROLE_PREY || slotRole === ROLE_PACK) role = slotRole;
        else if (brainId === "prey") role = ROLE_PREY;
        else if (i < this.n_prey) role = ROLE_PREY;
        else role = ROLE_PACK;
      } else {
        role = ROLE_FFA;
      }
      const angle = (2 * Math.PI * i) / n - Math.PI / 2;
      const radius = n > 2 ? 0.32 : 0.28;
      const x = clip(0.5 + radius * Math.cos(angle) + uniform(this.rng, -0.03, 0.03), 0.08, 0.92);
      const y = clip(0.5 + radius * Math.sin(angle) + uniform(this.rng, -0.03, 0.03), 0.08, 0.92);
      const heading = wrapAngle(angle + Math.PI + uniform(this.rng, -0.25, 0.25));
      this.planes.push(new Plane(name, i, x, y, heading, brainId, role));
    }
    this.bullets = [];
    this.t = 0;
    this.steps = 0;
    this.events = [];
    this.extra_turns = {};
  }

  step(redAction, blueAction = 1) {
    const rewards = {};
    if (this.mode === MODE_HUNT) {
      const prey = this.prey();
      for (const p of this.planes) rewards[p.name] = prey && p.name === prey.name ? 0.001 : -0.002;
    } else {
      for (const p of this.planes) rewards[p.name] = -0.002;
    }
    if (this._alreadyOver()) return rewards;
    let actions;
    if (redAction && typeof redAction === "object" && !Array.isArray(redAction)) actions = redAction;
    else actions = { [this.red.name]: redAction | 0, [this.blue.name]: blueAction | 0 };
    for (const plane of this.planes) {
      if (plane.alive) this._act(plane, actions[plane.name] ?? 1, rewards);
    }
    this._integratePlanes();
    this._integrateBullets();
    this._walls(rewards);
    this._midair(rewards);
    this._hits(rewards);
    this._shaping(rewards);
    this._swarmShaping(rewards);
    this.t += DT;
    this.steps += 1;
    if (this.mode === MODE_HUNT) this._resolveHunt(rewards);
    else {
      const live = this.living();
      if (live.length === 1) this.events.push(`win_${live[0].name}`);
      else if (this.steps >= this.max_steps && live.length > 1) {
        this.events.push("draw");
        for (const plane of live) rewards[plane.name] -= 1;
      }
    }
    return rewards;
  }

  done() {
    return this._alreadyOver() || this.steps >= this.max_steps;
  }

  snapshot() {
    const live = this.living();
    const prey = this.prey();
    return {
      t: this.t,
      mode: this.mode,
      n_planes: this.planes.length,
      n_prey: this.preys().length,
      n_hive: this.mode === MODE_HUNT ? this.pack().length : Math.max(0, this.planes.length - this.preys().length),
      alive: live.length,
      prey: prey && this.mode === MODE_HUNT ? prey.name : null,
      red: this.red.pose(),
      blue: this.blue.pose(),
      planes: this.planes.map((p) => p.pose()),
      bullets: this.bullets.map((b) => b.pose()),
      events: this.events.slice(),
      links: this._packLinks(),
    };
  }

  observe(who, extras) {
    const me = this._plane(who);
    const focus = this._focus(me);
    const out = new Float64Array(OBS);
    if (focus && canSee(me, focus)) {
      const rel = relativePlane(me, focus);
      out[0] = rel[0];
      out[1] = rel[1];
      out[2] = rel[2];
      out[3] = rel[3];
    }
    out[4] = (me.x - 0.5) * 2;
    out[5] = (me.y - 0.5) * 2;
    out[6] = Math.cos(me.heading);
    out[7] = Math.sin(me.heading);
    out[8] = rayToWall(me.x, me.y, me.heading);
    out[9] = me.cooldown / COOLDOWN;
    const edges = edgeDistances(me.x, me.y);
    out[10] = edges[0];
    out[11] = edges[1];
    out[12] = edges[2];
    out[13] = edges[3];
    const ally = this._nearestAlly(me);
    if (ally) {
      const rel = relativePlane(me, ally);
      out[18] = rel[0];
      out[19] = rel[1];
      out[20] = Math.cos(wrapAngle(ally.heading - me.heading));
      out[21] = clip(0.12 / (Math.hypot(ally.x - me.x, ally.y - me.y) + 1e-3), 0, 1);
    }
    const role = me.swarm_role || "";
    out[22] = role === "point" ? 1 : 0;
    out[23] = role === "flank_l" ? 1 : 0;
    out[24] = role === "flank_r" ? 1 : 0;
    out[25] = role === "cutter" ? 1 : 0;
    if (extras) {
      out[14] = Number(extras.mem_fwd) || 0;
      out[15] = Number(extras.mem_right) || 0;
      out[16] = Number(extras.mem_heat) || 0;
      out[17] = Number(extras.mem_kill) || 0;
    }
    return out;
  }

  _act(plane, action, rewards) {
    action = clip(action | 0, 0, 5);
    let turn = (action % 3) - 1;
    const fire = action >= 3;
    const extra = Number(this.extra_turns[plane.name]) || 0;
    turn = clip(turn + this.swarm_gain * extra, -1, 1);
    plane.heading = wrapAngle(plane.heading + turn * maxYawRate() * DT);
    plane.cooldown = Math.max(0, plane.cooldown - DT);
    if (fire) {
      if (plane.cooldown > 1e-9) rewards[plane.name] -= 0.01;
      else {
        this.bullets.push(new Bullet(plane.x, plane.y, plane.heading, plane.name));
        plane.cooldown = COOLDOWN;
      }
    }
  }

  _integratePlanes() {
    for (const p of this.planes) {
      if (!p.alive) continue;
      p.x += SPEED * Math.cos(p.heading) * DT;
      p.y += SPEED * Math.sin(p.heading) * DT;
    }
  }

  _integrateBullets() {
    const live = [];
    for (const b of this.bullets) {
      b.x += BULLET_SPEED * Math.cos(b.heading) * DT;
      b.y += BULLET_SPEED * Math.sin(b.heading) * DT;
      b.age += DT;
      if (b.x >= 0 && b.x <= ARENA && b.y >= 0 && b.y <= ARENA && b.age <= BULLET_LIFE) live.push(b);
    }
    this.bullets = live;
  }

  _walls(rewards) {
    for (const p of this.planes) {
      if (p.alive && (p.x <= 0 || p.x >= ARENA || p.y <= 0 || p.y >= ARENA)) {
        p.alive = false;
        this.events.push(`${p.name}_wall`);
        if (this.mode === MODE_HUNT) this._huntLoss(p, rewards, true);
        else {
          rewards[p.name] -= 1;
          const others = this.living();
          if (others.length) {
            const bonus = 0.35 / others.length;
            for (const q of others) rewards[q.name] += bonus;
          }
        }
      }
    }
  }

  _midair(rewards) {
    const live = this.living();
    const crashed = new Set();
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const a = live[i];
        const b = live[j];
        if (Math.hypot(a.x - b.x, a.y - b.y) < 2 * COLLIDE_R) {
          crashed.add(a.name);
          crashed.add(b.name);
        }
      }
    }
    if (!crashed.size) return;
    const preyHit = this.planes.some((p) => p.role === ROLE_PREY && crashed.has(p.name));
    for (const p of this.planes) {
      if (crashed.has(p.name) && p.alive) {
        p.alive = false;
        rewards[p.name] -= 0.8;
      }
    }
    this.events.push("midair");
    if (this.mode !== MODE_HUNT) return;
    const packIn = this.pack().filter((p) => crashed.has(p.name));
    if (preyHit) {
      for (const q of this.packLiving()) rewards[q.name] += 0.35;
    } else if (packIn.length && this.preysLiving().length) {
      for (const prey of this.preysLiving()) rewards[prey.name] += 1;
      for (const q of this.packLiving()) rewards[q.name] -= 0.45;
    }
  }

  _hits(rewards) {
    const leftover = [];
    for (const b of this.bullets) {
      let hit = null;
      for (const target of this.planes) {
        if (target.alive && target.name !== b.owner && Math.hypot(b.x - target.x, b.y - target.y) < HIT_R) {
          hit = target;
          break;
        }
      }
      if (hit) {
        hit.alive = false;
        this.events.push(`${b.owner}_kill`);
        if (this.mode === MODE_HUNT) this._huntShot(b.owner, hit, rewards);
        else {
          rewards[b.owner] += 1;
          rewards[hit.name] -= 1;
        }
      } else leftover.push(b);
    }
    this.bullets = leftover;
  }

  _shaping(rewards) {
    for (const me of this.planes) {
      if (!me.alive) continue;
      const you = this._focus(me);
      if (!you) continue;
      const dx = you.x - me.x;
      const dy = you.y - me.y;
      const bearing = wrapAngle(Math.atan2(dy, dx) - me.heading);
      const rng = Math.hypot(dx, dy);
      if (rng < GUN_RANGE) rewards[me.name] += 0.035 * Math.max(0, Math.cos(bearing));
      const wall = rayToWall(me.x, me.y, me.heading);
      if (wall < 0.14) rewards[me.name] -= (0.1 * (0.14 - wall)) / 0.14;
      const margin = Math.min(me.x, me.y, ARENA - me.x, ARENA - me.y);
      rewards[me.name] += 0.01 * margin;
      if (margin < 0.12) rewards[me.name] -= (0.14 * (0.12 - margin)) / 0.12;
    }
  }

  _swarmShaping(rewards) {
    if (this.mode !== MODE_HUNT) return;
    const prey = this.prey();
    const pack = this.packLiving();
    if (!prey || !prey.alive || pack.length < 2) return;
    const angles = pack.map((p) => Math.atan2(p.y - prey.y, p.x - prey.x));
    let spread = 0;
    for (let i = 0; i < angles.length; i++) {
      let nearest = Infinity;
      for (let j = 0; j < angles.length; j++) {
        if (j === i) continue;
        nearest = Math.min(nearest, Math.abs(wrapAngle(angles[i] - angles[j])));
      }
      if (Number.isFinite(nearest)) spread += nearest;
    }
    spread /= Math.max(pack.length, 1);
    const surround = clip(spread / (Math.PI / Math.max(pack.length, 1)), 0, 1);
    for (const p of pack) {
      rewards[p.name] += 0.012 * surround;
      const others = pack.filter((q) => q.name !== p.name);
      if (!others.length) continue;
      const nearest = Math.min(...others.map((q) => Math.hypot(p.x - q.x, p.y - q.y)));
      if (nearest < 0.09) rewards[p.name] -= (0.04 * (0.09 - nearest)) / 0.09;
    }
  }

  _plane(who) {
    const found = this.planes.find((p) => p.name === who);
    if (found) return found;
    if (who === "red") return this.red;
    if (who === "blue") return this.blue;
    throw new Error(who);
  }

  _nearestOther(me) {
    const others = this.planes.filter((p) => p.name !== me.name && p.alive);
    if (!others.length) return null;
    return others.reduce((best, p) => (Math.hypot(p.x - me.x, p.y - me.y) < Math.hypot(best.x - me.x, best.y - me.y) ? p : best));
  }

  _nearestAlly(me) {
    let others;
    if (this.mode === MODE_HUNT) {
      others = me.role === ROLE_PREY ? this.preysLiving().filter((p) => p.name !== me.name) : this.packLiving().filter((p) => p.name !== me.name);
    } else {
      others = this.living().filter((p) => p.name !== me.name);
    }
    if (!others.length) return null;
    return others.reduce((best, p) => (Math.hypot(p.x - me.x, p.y - me.y) < Math.hypot(best.x - me.x, best.y - me.y) ? p : best));
  }

  _focus(me) {
    if (this.mode === MODE_HUNT) {
      if (me.role === ROLE_PACK) {
        const livingPrey = this.preysLiving();
        if (livingPrey.length) {
          return livingPrey.reduce((best, p) => (Math.hypot(p.x - me.x, p.y - me.y) < Math.hypot(best.x - me.x, best.y - me.y) ? p : best));
        }
        return null;
      }
      if (me.role === ROLE_PREY) {
        const hunters = this.packLiving();
        if (hunters.length) {
          return hunters.reduce((best, p) => (Math.hypot(p.x - me.x, p.y - me.y) < Math.hypot(best.x - me.x, best.y - me.y) ? p : best));
        }
        return null;
      }
    }
    return this._nearestOther(me);
  }

  _packLinks() {
    const pack = this.mode === MODE_HUNT ? this.packLiving() : this.living();
    const links = [];
    for (let i = 0; i < pack.length; i++) {
      for (let j = i + 1; j < pack.length; j++) {
        const a = pack[i];
        const b = pack[j];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (dist < 0.28) links.push({ a: a.name, b: b.name, x0: a.x, y0: a.y, x1: b.x, y1: b.y, dist });
      }
    }
    return links;
  }

  _alreadyOver() {
    if (this.mode === MODE_HUNT) return !this.preysLiving().length || !this.packLiving().length;
    return this.living().length <= 1;
  }

  _huntShot(owner, hit, rewards) {
    const shooter = this.planes.find((p) => p.name === owner);
    const ownerIsPrey = Boolean(shooter && shooter.role === ROLE_PREY);
    const hitIsPrey = hit.role === ROLE_PREY;
    if (ownerIsPrey && !hitIsPrey) {
      rewards[owner] += 1.5;
      rewards[hit.name] -= 1;
      for (const q of this.packLiving()) rewards[q.name] -= 0.55;
      for (const q of this.preysLiving()) {
        if (q.name !== owner) rewards[q.name] += 0.35;
      }
    } else if (hitIsPrey && !ownerIsPrey) {
      rewards[owner] += 2.2;
      rewards[hit.name] -= 1.6;
      for (const q of this.packLiving()) {
        if (q.name !== owner) rewards[q.name] += 0.5;
      }
      for (const q of this.preysLiving()) rewards[q.name] -= 0.35;
    } else {
      rewards[owner] -= 1.2;
      rewards[hit.name] -= 1;
      if (ownerIsPrey) {
        for (const q of this.packLiving()) rewards[q.name] += 0.4;
      } else {
        for (const q of this.preysLiving()) rewards[q.name] += 1.1;
      }
    }
  }

  _huntLoss(plane, rewards, wall) {
    if (plane.role === ROLE_PREY) {
      rewards[plane.name] -= 1.4;
      for (const q of this.packLiving()) rewards[q.name] += 0.35;
      return;
    }
    rewards[plane.name] -= wall ? 1.2 : 1;
    for (const q of this.preysLiving()) rewards[q.name] += 1;
    for (const q of this.packLiving()) rewards[q.name] -= 0.45;
  }

  _resolveHunt(rewards) {
    if (this.events.some((e) => e === "prey_down" || e === "pack_wipe" || e === "escape")) return;
    const livingPrey = this.preysLiving();
    const packLost = this.pack().filter((p) => !p.alive).length;
    if (!livingPrey.length) {
      this.events.push("prey_down");
      if (packLost === 0) this.events.push("clean_hunt");
      const bonus = Math.max(-0.8, 1.6 - 0.7 * packLost);
      for (const q of this.packLiving()) rewards[q.name] += bonus;
      for (const prey of this.preys()) rewards[prey.name] -= 0.3;
    } else if (!this.packLiving().length) {
      this.events.push("pack_wipe");
      for (const prey of livingPrey) rewards[prey.name] += 2.4 + 0.35 * packLost;
    } else if (this.steps >= this.max_steps && livingPrey.length) {
      this.events.push("escape");
      for (const prey of livingPrey) rewards[prey.name] += 2 + 0.35 * packLost;
      for (const q of this.packLiving()) rewards[q.name] -= 1.2;
    }
  }
}

function canSee(me, you) {
  return Math.hypot(you.x - me.x, you.y - me.y) <= SENSE_RANGE;
}

function relativePlane(me, you) {
  const dx = you.x - me.x;
  const dy = you.y - me.y;
  const c = Math.cos(me.heading);
  const s = Math.sin(me.heading);
  const fwd = dx * c + dy * s;
  const right = -dx * s + dy * c;
  const rng = Math.hypot(dx, dy) / Math.sqrt(2);
  const relH = wrapAngle(you.heading - me.heading) / Math.PI;
  return [fwd, right, rng, relH];
}

function edgeDistances(x, y) {
  return [clip(x / ARENA, 0, 1), clip((ARENA - x) / ARENA, 0, 1), clip(y / ARENA, 0, 1), clip((ARENA - y) / ARENA, 0, 1)];
}

function rayToWall(x, y, heading) {
  const c = Math.cos(heading);
  const s = Math.sin(heading);
  const hits = [];
  if (c > 1e-9) hits.push((ARENA - x) / c);
  else if (c < -1e-9) hits.push((0 - x) / c);
  if (s > 1e-9) hits.push((ARENA - y) / s);
  else if (s < -1e-9) hits.push((0 - y) / s);
  return hits.length ? Math.min(...hits) : 1;
}
