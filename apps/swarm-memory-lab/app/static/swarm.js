import { wrapAngle } from "./physics.js";
import { clip } from "./rng.js";

export const ROLES = ["point", "flank_l", "flank_r", "cutter"];

function mean(values) {
  if (!values.length) return 0;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

export function assignRoles(world) {
  const roles = {};
  const prey = world.prey();
  const pack = world.mode === "hunt" ? world.packLiving() : [];
  if (!prey || !prey.alive || !pack.length) {
    for (const plane of world.planes) plane.swarm_role = plane.role === "prey" ? "prey" : "";
    return roles;
  }
  const scored = pack.map((plane) => {
    const dx = prey.x - plane.x;
    const dy = prey.y - plane.y;
    const bearing = wrapAngle(Math.atan2(dy, dx) - prey.heading);
    const rng = Math.hypot(dx, dy);
    return { plane, bearing, rng };
  });
  scored.sort((a, b) => a.rng - b.rng);
  let leftover = scored.slice();
  if (leftover.length) {
    const point = leftover.shift();
    roles[point.plane.name] = "point";
  }
  const lefts = leftover.slice().sort((a, b) => a.bearing - b.bearing);
  if (lefts.length) {
    roles[lefts[0].plane.name] = "flank_l";
    leftover = leftover.filter((item) => item.plane.name !== lefts[0].plane.name);
  }
  const rights = leftover.slice().sort((a, b) => b.bearing - a.bearing);
  if (rights.length) {
    roles[rights[0].plane.name] = "flank_r";
    leftover = leftover.filter((item) => item.plane.name !== rights[0].plane.name);
  }
  for (const item of leftover) roles[item.plane.name] = "cutter";
  for (const plane of world.planes) {
    plane.swarm_role = plane.role === "prey" ? "prey" : roles[plane.name] || "";
  }
  return roles;
}

function steerToward(me, tx, ty) {
  const bearing = wrapAngle(Math.atan2(ty - me.y, tx - me.x) - me.heading);
  return clip(bearing / (Math.PI / 2), -1, 1);
}

function roleTarget(me, prey) {
  const hx = Math.cos(prey.heading);
  const hy = Math.sin(prey.heading);
  const lx = -hy;
  const ly = hx;
  const role = me.swarm_role;
  if (role === "flank_l") return [prey.x + 0.14 * lx - 0.04 * hx, prey.y + 0.14 * ly - 0.04 * hy];
  if (role === "flank_r") return [prey.x - 0.14 * lx - 0.04 * hx, prey.y - 0.14 * ly - 0.04 * hy];
  if (role === "cutter") return [prey.x + 0.18 * hx, prey.y + 0.18 * hy];
  return [prey.x, prey.y];
}

function separation(me, allies) {
  let acc = 0;
  for (const other of allies) {
    const dx = me.x - other.x;
    const dy = me.y - other.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-6 || dist > 0.14) continue;
    const bearing = wrapAngle(Math.atan2(dy, dx) - me.heading);
    const weight = (0.14 - dist) / 0.14;
    acc += weight * clip(bearing / (Math.PI / 2), -1, 1);
  }
  return clip(acc, -1, 1);
}

function alignment(me, allies) {
  if (!allies.length) return 0;
  const sx = mean(allies.map((p) => Math.cos(p.heading)));
  const sy = mean(allies.map((p) => Math.sin(p.heading)));
  const heading = Math.atan2(sy, sx);
  return clip(wrapAngle(heading - me.heading) / (Math.PI / 2), -1, 1);
}

function cohesion(me, allies) {
  if (!allies.length) return 0;
  const cx = mean(allies.map((p) => p.x).concat([me.x]));
  const cy = mean(allies.map((p) => p.y).concat([me.y]));
  return steerToward(me, cx, cy);
}

export function forces(me, world, kSep = 0.55, kAli = 0.22, kCoh = 0.18, kRole = 0.85) {
  if (!me.alive) return { sep: 0, ali: 0, coh: 0, role: 0, mix: 0 };
  if (me.role === "prey") {
    const hunters = world.packLiving();
    if (!hunters.length) return { sep: 0, ali: 0, coh: 0, role: 0, mix: 0 };
    const nearest = hunters.reduce((best, p) => (Math.hypot(p.x - me.x, p.y - me.y) < Math.hypot(best.x - me.x, best.y - me.y) ? p : best));
    const flee = -steerToward(me, nearest.x, nearest.y);
    const mates = world.preysLiving().filter((p) => p.name !== me.name);
    const sep = separation(me, mates);
    let wallTurn = 0;
    const marginL = me.x;
    const marginR = 1 - me.x;
    const marginB = me.y;
    const marginT = 1 - me.y;
    if (Math.min(marginL, marginR, marginB, marginT) < 0.16) wallTurn = steerToward(me, 0.5, 0.5);
    const mix = clip(0.65 * flee + 0.35 * sep + 0.55 * wallTurn, -1, 1);
    return { sep, ali: 0, coh: 0, role: flee, mix };
  }
  const allies = world.mode === "hunt" ? world.packLiving().filter((p) => p.name !== me.name) : world.living().filter((p) => p.name !== me.name);
  const sep = separation(me, allies);
  const ali = alignment(me, allies);
  const coh = cohesion(me, allies);
  let role = 0;
  const prey = world.prey();
  if (world.mode === "hunt" && prey && prey.alive) {
    const [tx, ty] = roleTarget(me, prey);
    role = steerToward(me, tx, ty);
  }
  const mix = clip(kSep * sep + kAli * ali + kCoh * coh + kRole * role, -1, 1);
  return { sep, ali, coh, role, mix };
}

export function extraTurns(world) {
  assignRoles(world);
  const out = {};
  for (const plane of world.planes) {
    if (plane.alive) out[plane.name] = forces(plane, world).mix;
  }
  return out;
}
