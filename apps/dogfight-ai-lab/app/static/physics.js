import { clip, uniform } from "./rng.js";

export const ARENA = 1.0;
export const DT = 0.05;
export const MAX_STEPS = 12000;
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
export const MIN_PLANES = 2;
export const MAX_PLANES = 9;
export const OTHER_SLOTS = MAX_PLANES - 1;
export const MODE_FFA = "ffa";
export const MODE_HUNT = "hunt";

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

export function clampMode(mode) {
  const text = String(mode || "")
    .trim()
    .toLowerCase()
    .replaceAll(" ", "-");
  if (["hunt", "pack", "chase", "prey", "1vpack", "one-against-the-pack"].includes(text)) return MODE_HUNT;
  return MODE_FFA;
}

export function planeId(i) {
  return `p${i + 1}`;
}

export function defaultLineup(n) {
  n = clampPlaneCount(n);
  return Array.from({ length: n }, (_, i) => ({ brain_id: planeId(i) }));
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

function observationNames() {
  const names = ["fwd", "right", "range", "rel h", "x", "y", "cos", "sin", "wall", "gun", "edge L", "edge R", "edge B", "edge T"];
  for (let slot = 2; slot < MAX_PLANES; slot++) names.push(`n${slot}`, `fwd${slot}`, `rt${slot}`, `rng${slot}`, `h${slot}`);
  return names;
}

export const OBS_NAMES = observationNames();
export const OBS = OBS_NAMES.length;

export class Plane {
  constructor(name, seat, x, y, heading, brainId, role) {
    this.name = name;
    this.seat = seat;
    this.x = x;
    this.y = y;
    this.heading = heading;
    this.brain_id = brainId || name;
    this.role = role || "ffa";
    this.cooldown = 0;
    this.alive = true;
  }

  pose() {
    return {
      name: this.name,
      seat: this.seat,
      brain_id: this.brain_id,
      role: this.role,
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
  constructor(rng, { maxSteps = MAX_STEPS, nPlanes = MIN_PLANES, mode = MODE_FFA, lineup = null } = {}) {
    this.rng = rng;
    this.max_steps = Math.max(1, Math.round(maxSteps));
    this.mode = clampMode(mode);
    if (lineup && lineup.length) {
      this.lineup = lineup.map((slot) => ({ ...slot }));
      this.n_planes = clampPlaneCount(this.lineup.length);
      this.lineup = this.lineup.slice(0, this.n_planes);
    } else {
      this.n_planes = clampPlaneCount(nPlanes);
      this.lineup = defaultLineup(this.n_planes);
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
    return this.planes[0] || null;
  }

  pack() {
    return this.planes.slice(1);
  }

  packLiving() {
    return this.pack().filter((p) => p.alive);
  }

  reset() {
    const slots = this.lineup.length ? this.lineup : defaultLineup(this.n_planes);
    const n = slots.length;
    this.planes = [];
    for (let i = 0; i < n; i++) {
      const slot = slots[i];
      const name = planeId(i);
      const brainId = String(slot.brain_id || name);
      const role = this.mode === MODE_HUNT ? (i === 0 ? "prey" : "pack") : "ffa";
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
  }

  step(redAction, blueAction = 1) {
    const prey = this.prey();
    const rewards = {};
    for (const p of this.planes) {
      rewards[p.name] = this.mode === MODE_HUNT ? (prey && p.name === prey.name ? 0.001 : -0.002) : -0.002;
    }
    if (this._alreadyOver()) return rewards;
    const actions = redAction && typeof redAction === "object" && !Number.isInteger(redAction) ? redAction : { [this.red.name]: redAction | 0, [this.blue.name]: blueAction | 0 };
    for (const plane of this.planes) {
      if (plane.alive) this._act(plane, actions[plane.name] ?? 1, rewards);
    }
    this._integratePlanes();
    this._integrateBullets();
    this._walls(rewards);
    this._midair(rewards);
    this._hits(rewards);
    this._shaping(rewards);
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
      alive: live.length,
      prey: prey && this.mode === MODE_HUNT ? prey.name : null,
      red: this.red.pose(),
      blue: this.blue.pose(),
      planes: this.planes.map((p) => p.pose()),
      bullets: this.bullets.map((b) => b.pose()),
      events: this.events.slice(),
    };
  }

  observe(who) {
    const me = this._plane(who);
    const others = this._visibleOthers(me);
    const focus = others[0] || me;
    const out = new Float64Array(OBS);
    const rel = relativePlane(me, focus);
    out[0] = rel[0];
    out[1] = rel[1];
    out[2] = rel[2];
    out[3] = rel[3];
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
    let cursor = 14;
    const extra = others.slice(1);
    for (let slot = 0; slot < OTHER_SLOTS - 1; slot++) {
      if (slot < extra.length) {
        const plane = extra[slot];
        const r = relativePlane(me, plane);
        out[cursor] = plane.alive ? 1 : 0;
        out[cursor + 1] = r[0];
        out[cursor + 2] = r[1];
        out[cursor + 3] = r[2];
        out[cursor + 4] = r[3];
      }
      cursor += 5;
    }
    return out;
  }

  _visibleOthers(me) {
    const others = this.planes.filter((p) => p.name !== me.name);
    const byRange = (p) => Math.hypot(p.x - me.x, p.y - me.y);
    let living = others.filter((p) => p.alive);
    const dead = others.filter((p) => !p.alive);
    if (this.mode === MODE_HUNT) {
      const prey = this.prey();
      if (prey && prey.name !== me.name && prey.alive) {
        living = [prey, ...living.filter((p) => p.name !== prey.name).sort((a, b) => byRange(a) - byRange(b))];
      } else living = living.sort((a, b) => byRange(a) - byRange(b));
    } else living = living.sort((a, b) => byRange(a) - byRange(b));
    return living.concat(dead.sort((a, b) => byRange(a) - byRange(b)));
  }

  _act(plane, action, rewards) {
    action = clip(action | 0, 0, 5);
    const turn = (action % 3) - 1;
    const fire = action >= 3;
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
        if (Math.hypot(live[i].x - live[j].x, live[i].y - live[j].y) < 2 * COLLIDE_R) {
          crashed.add(live[i].name);
          crashed.add(live[j].name);
        }
      }
    }
    if (!crashed.size) return;
    const prey = this.prey();
    const preyHit = Boolean(prey && crashed.has(prey.name));
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
    } else if (packIn.length && prey && prey.alive) {
      rewards[prey.name] += 1;
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

  _focus(me) {
    if (this.mode === MODE_HUNT) {
      const prey = this.prey();
      if (prey && me.name !== prey.name && prey.alive) return prey;
    }
    return this._nearestOther(me);
  }

  _alreadyOver() {
    if (this.mode === MODE_HUNT) {
      const prey = this.prey();
      return !prey || !prey.alive || !this.packLiving().length;
    }
    return this._survivors() <= 1;
  }

  _survivors() {
    return this.planes.reduce((n, p) => n + (p.alive ? 1 : 0), 0);
  }

  _huntShot(owner, hit, rewards) {
    const prey = this.prey();
    const ownerIsPrey = Boolean(prey && owner === prey.name);
    const hitIsPrey = Boolean(prey && hit.name === prey.name);
    if (ownerIsPrey) {
      rewards[owner] += 1.5;
      rewards[hit.name] -= 1;
      for (const q of this.packLiving()) rewards[q.name] -= 0.55;
    } else if (hitIsPrey) {
      rewards[owner] += 2.2;
      rewards[hit.name] -= 1.6;
      for (const q of this.packLiving()) if (q.name !== owner) rewards[q.name] += 0.5;
    } else {
      rewards[owner] -= 1.2;
      rewards[hit.name] -= 1;
      if (prey && prey.alive) rewards[prey.name] += 1.1;
    }
  }

  _huntLoss(plane, rewards, wall) {
    const prey = this.prey();
    if (prey && plane.name === prey.name) {
      rewards[plane.name] -= 1.4;
      for (const q of this.packLiving()) rewards[q.name] += 0.35;
      return;
    }
    rewards[plane.name] -= wall ? 1.2 : 1;
    if (prey && prey.alive) rewards[prey.name] += 1;
    for (const q of this.packLiving()) rewards[q.name] -= 0.45;
  }

  _resolveHunt(rewards) {
    if (this.events.some((e) => e === "prey_down" || e === "pack_wipe" || e === "escape")) return;
    const prey = this.prey();
    const packLost = this.pack().reduce((n, p) => n + (p.alive ? 0 : 1), 0);
    if (prey && !prey.alive) {
      this.events.push("prey_down");
      if (packLost === 0) this.events.push("clean_hunt");
      const bonus = Math.max(-0.8, 1.6 - 0.7 * packLost);
      for (const q of this.packLiving()) rewards[q.name] += bonus;
      rewards[prey.name] -= 0.3;
    } else if (prey && prey.alive && !this.packLiving().length) {
      this.events.push("pack_wipe");
      rewards[prey.name] += 2.4 + 0.35 * packLost;
    } else if (this.steps >= this.max_steps && prey && prey.alive) {
      this.events.push("escape");
      rewards[prey.name] += 2 + 0.35 * packLost;
      for (const q of this.packLiving()) rewards[q.name] -= 1.2;
    }
  }
}

function relativePlane(me, you) {
  const dx = you.x - me.x;
  const dy = you.y - me.y;
  const c = Math.cos(me.heading);
  const s = Math.sin(me.heading);
  return [dx * c + dy * s, -dx * s + dy * c, Math.hypot(dx, dy) / Math.SQRT2, wrapAngle(you.heading - me.heading) / Math.PI];
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
