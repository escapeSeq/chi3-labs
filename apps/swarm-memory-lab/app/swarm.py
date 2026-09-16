"""Reynolds flocking plus hunt roles: point, flanks, cutter."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

if __package__:
    from .physics import Plane, World, wrap_angle
else:
    from physics import Plane, World, wrap_angle

ROLES = ("point", "flank_l", "flank_r", "cutter")


def assign_roles(world: World) -> dict[str, str]:
    """Give living pack members complementary intercept jobs."""
    roles: dict[str, str] = {}
    prey = world.prey()
    pack = world.pack_living() if world.mode == "hunt" else []
    if prey is None or not prey.alive or not pack:
        for plane in world.planes:
            plane.swarm_role = "prey" if plane.role == "prey" else ""
        return roles
    scored = []
    for plane in pack:
        dx, dy = prey.x - plane.x, prey.y - plane.y
        bearing = wrap_angle(np.arctan2(dy, dx) - prey.heading)
        rng = float(np.hypot(dx, dy))
        scored.append((plane, bearing, rng))
    scored.sort(key=lambda item: item[2])
    leftover = list(scored)
    if leftover:
        point = leftover.pop(0)
        roles[point[0].name] = "point"
    lefts = sorted(leftover, key=lambda item: item[1])
    if lefts:
        roles[lefts[0][0].name] = "flank_l"
        leftover = [item for item in leftover if item[0].name != lefts[0][0].name]
    rights = sorted(leftover, key=lambda item: item[1], reverse=True)
    if rights:
        roles[rights[0][0].name] = "flank_r"
        leftover = [item for item in leftover if item[0].name != rights[0][0].name]
    for plane, _, _ in leftover:
        roles[plane.name] = "cutter"
    for plane in world.planes:
        if plane.role == "prey":
            plane.swarm_role = "prey"
        else:
            plane.swarm_role = roles.get(plane.name, "")
    return roles


def _steer_toward(me: Plane, tx: float, ty: float) -> float:
    bearing = wrap_angle(np.arctan2(ty - me.y, tx - me.x) - me.heading)
    return float(np.clip(bearing / (np.pi / 2), -1.0, 1.0))


def _role_target(me: Plane, prey: Plane) -> tuple[float, float]:
    hx, hy = np.cos(prey.heading), np.sin(prey.heading)
    lx, ly = -hy, hx
    role = me.swarm_role
    if role == "flank_l":
        return prey.x + 0.14 * lx - 0.04 * hx, prey.y + 0.14 * ly - 0.04 * hy
    if role == "flank_r":
        return prey.x - 0.14 * lx - 0.04 * hx, prey.y - 0.14 * ly - 0.04 * hy
    if role == "cutter":
        return prey.x + 0.18 * hx, prey.y + 0.18 * hy
    return prey.x, prey.y


def _separation(me: Plane, allies: list[Plane]) -> float:
    acc = 0.0
    for other in allies:
        dx, dy = me.x - other.x, me.y - other.y
        dist = float(np.hypot(dx, dy))
        if dist < 1e-6 or dist > 0.14:
            continue
        bearing = wrap_angle(np.arctan2(dy, dx) - me.heading)
        weight = (0.14 - dist) / 0.14
        acc += weight * float(np.clip(bearing / (np.pi / 2), -1.0, 1.0))
    return float(np.clip(acc, -1.0, 1.0))


def _alignment(me: Plane, allies: list[Plane]) -> float:
    if not allies:
        return 0.0
    sx = float(np.mean([np.cos(p.heading) for p in allies]))
    sy = float(np.mean([np.sin(p.heading) for p in allies]))
    heading = np.arctan2(sy, sx)
    return float(np.clip(wrap_angle(heading - me.heading) / (np.pi / 2), -1.0, 1.0))


def _cohesion(me: Plane, allies: list[Plane]) -> float:
    if not allies:
        return 0.0
    cx = float(np.mean([p.x for p in allies] + [me.x]))
    cy = float(np.mean([p.y for p in allies] + [me.y]))
    return _steer_toward(me, cx, cy)


@dataclass
class SwarmForces:
    sep: float
    ali: float
    coh: float
    role: float
    mix: float


def forces(me: Plane, world: World, *, k_sep: float = 0.55, k_ali: float = 0.22, k_coh: float = 0.18, k_role: float = 0.85) -> SwarmForces:
    if not me.alive:
        return SwarmForces(0.0, 0.0, 0.0, 0.0, 0.0)
    if me.role == "prey":
        hunters = world.pack_living()
        if not hunters:
            return SwarmForces(0.0, 0.0, 0.0, 0.0, 0.0)
        nearest = min(hunters, key=lambda p: float(np.hypot(p.x - me.x, p.y - me.y)))
        flee = -_steer_toward(me, nearest.x, nearest.y)
        mates = [p for p in world.preys_living() if p.name != me.name]
        sep = _separation(me, mates)
        wall_turn = 0.0
        margin_l, margin_r = me.x, 1.0 - me.x
        margin_b, margin_t = me.y, 1.0 - me.y
        if min(margin_l, margin_r, margin_b, margin_t) < 0.16:
            inward_x = 0.5
            inward_y = 0.5
            wall_turn = _steer_toward(me, inward_x, inward_y)
        mix = float(np.clip(0.65 * flee + 0.35 * sep + 0.55 * wall_turn, -1.0, 1.0))
        return SwarmForces(sep, 0.0, 0.0, flee, mix)
    allies = [p for p in world.pack_living() if p.name != me.name] if world.mode == "hunt" else [p for p in world.living() if p.name != me.name]
    sep = _separation(me, allies)
    ali = _alignment(me, allies)
    coh = _cohesion(me, allies)
    role = 0.0
    prey = world.prey()
    if world.mode == "hunt" and prey is not None and prey.alive:
        tx, ty = _role_target(me, prey)
        role = _steer_toward(me, tx, ty)
    mix = float(np.clip(k_sep * sep + k_ali * ali + k_coh * coh + k_role * role, -1.0, 1.0))
    return SwarmForces(sep, ali, coh, role, mix)


def extra_turns(world: World) -> dict[str, float]:
    assign_roles(world)
    return {plane.name: forces(plane, world).mix for plane in world.planes if plane.alive}
