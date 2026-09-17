"""2-D gun fight from the dogfight lab, used as the swarm hunting ground.

Each drone is a Dubins vehicle: constant speed, yaw capped by speed / turn
radius, gun welded to the nose. Default fight is prey against a hive pack.
Every prey body shares one brain; every hunter shares the hive brain.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

ARENA = 2.0
DT = 0.05
MAX_STEPS = 2400
MIN_STEPS = 200
MAX_STEPS_CAP = 12000
SPEED = 0.20
TURN_RADIUS = 0.06
COLLIDE_R = 0.030
BULLET_SPEED = 0.72
BULLET_LIFE = 0.46
HIT_R = 0.028
COOLDOWN = 0.65
GUN_RANGE = BULLET_SPEED * BULLET_LIFE
SENSE_RANGE = 0.40
MIN_PREY = 1
MIN_HIVE = 1
MAX_PLANES = 8
DEFAULT_PREY = 1
DEFAULT_HIVE = 4
MIN_PLANES = MIN_PREY + MIN_HIVE
DEFAULT_PLANES = DEFAULT_PREY + DEFAULT_HIVE
MODE_FFA = "ffa"
MODE_HUNT = "hunt"
MODES = (MODE_FFA, MODE_HUNT)
ROLE_PREY = "prey"
ROLE_PACK = "pack"
ROLE_FFA = "ffa"

OBS_NAMES = (
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
)
OBS = len(OBS_NAMES)


def clamp_max_steps(steps: int) -> int:
    return int(min(MAX_STEPS_CAP, max(MIN_STEPS, int(steps))))


def steps_from_seconds(seconds: float) -> int:
    return clamp_max_steps(round(float(seconds) / DT))


def seconds_from_steps(steps: int) -> float:
    return clamp_max_steps(steps) * DT


def clamp_plane_count(n: int) -> int:
    return int(min(MAX_PLANES, max(MIN_PLANES, int(n))))


def clamp_team_counts(n_prey: int, n_hive: int) -> tuple[int, int]:
    prey = max(MIN_PREY, int(n_prey))
    hive = max(MIN_HIVE, int(n_hive))
    while prey + hive > MAX_PLANES:
        if hive > MIN_HIVE:
            hive -= 1
        elif prey > MIN_PREY:
            prey -= 1
        else:
            break
    return prey, hive


def clamp_mode(mode: str | None) -> str:
    text = str(mode or "").strip().lower().replace(" ", "-")
    if text in ("ffa", "free-for-all", "last-plane"):
        return MODE_FFA
    return MODE_HUNT


def plane_id(i: int) -> str:
    return f"p{int(i) + 1}"


def make_lineup(n_prey: int = DEFAULT_PREY, n_hive: int = DEFAULT_HIVE) -> list[dict[str, str]]:
    n_prey, n_hive = clamp_team_counts(n_prey, n_hive)
    slots = [{"brain_id": "prey", "role": ROLE_PREY} for _ in range(n_prey)]
    slots.extend({"brain_id": "hive", "role": ROLE_PACK} for _ in range(n_hive))
    return slots


def default_lineup(n: int, n_prey: int = DEFAULT_PREY) -> list[dict[str, str]]:
    n = clamp_plane_count(n)
    prey = int(np.clip(int(n_prey), MIN_PREY, n - MIN_HIVE))
    return make_lineup(prey, n - prey)


def max_yaw_rate() -> float:
    return SPEED / TURN_RADIUS


def wrap_angle(a: float) -> float:
    return float((a + np.pi) % (2 * np.pi) - np.pi)


def decode_action(action: int) -> tuple[int, bool]:
    action = int(action)
    return (action % 3) - 1, action >= 3


def encode_action(turn: int, fire: bool) -> int:
    turn = int(np.clip(round(turn), -1, 1))
    return (turn + 1) + (3 if fire else 0)


@dataclass
class Plane:
    name: str
    seat: int
    x: float
    y: float
    heading: float
    brain_id: str = ""
    role: str = "ffa"
    swarm_role: str = ""
    cooldown: float = 0.0
    alive: bool = True

    def pose(self) -> dict:
        return {
            "name": self.name,
            "seat": self.seat,
            "brain_id": self.brain_id or self.name,
            "role": self.role,
            "swarm_role": self.swarm_role,
            "x": self.x,
            "y": self.y,
            "heading": self.heading,
            "cooldown": self.cooldown,
            "alive": self.alive,
        }


@dataclass
class Bullet:
    x: float
    y: float
    heading: float
    owner: str
    age: float = 0.0

    def pose(self) -> dict:
        return {"x": self.x, "y": self.y, "heading": self.heading, "owner": self.owner}


@dataclass
class World:
    rng: np.random.Generator
    max_steps: int = MAX_STEPS
    n_planes: int = DEFAULT_PLANES
    n_prey: int = DEFAULT_PREY
    mode: str = MODE_HUNT
    lineup: list[dict[str, str]] | None = None
    planes: list[Plane] = field(init=False)
    bullets: list[Bullet] = field(default_factory=list)
    t: float = 0.0
    steps: int = 0
    events: list[str] = field(default_factory=list)
    swarm_gain: float = 0.55
    extra_turns: dict[str, float] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.max_steps = max(1, int(self.max_steps))
        self.mode = clamp_mode(self.mode)
        if self.lineup:
            self.lineup = [dict(slot) for slot in self.lineup]
            self.n_planes = clamp_plane_count(len(self.lineup))
            self.lineup = self.lineup[: self.n_planes]
            counted = sum(1 for slot in self.lineup if str(slot.get("role") or slot.get("brain_id")) == ROLE_PREY)
            self.n_prey = counted if counted else min(DEFAULT_PREY, max(MIN_PREY, self.n_planes - MIN_HIVE))
        else:
            self.n_prey, n_hive = clamp_team_counts(self.n_prey, max(MIN_HIVE, self.n_planes - max(MIN_PREY, int(self.n_prey))))
            self.n_planes = self.n_prey + n_hive
            self.lineup = make_lineup(self.n_prey, n_hive)
        self.reset()

    @property
    def red(self) -> Plane:
        return self.planes[0]

    @property
    def blue(self) -> Plane:
        return self.planes[1] if len(self.planes) > 1 else self.planes[0]

    def living(self) -> list[Plane]:
        return [p for p in self.planes if p.alive]

    def prey(self) -> Plane | None:
        living = self.preys_living()
        if living:
            return living[0]
        preys = self.preys()
        return preys[0] if preys else None

    def preys(self) -> list[Plane]:
        return [p for p in self.planes if p.role == ROLE_PREY]

    def preys_living(self) -> list[Plane]:
        return [p for p in self.preys() if p.alive]

    def pack(self) -> list[Plane]:
        return [p for p in self.planes if p.role == ROLE_PACK]

    def pack_living(self) -> list[Plane]:
        return [p for p in self.pack() if p.alive]

    def reset(self) -> None:
        slots = list(self.lineup or default_lineup(self.n_planes))
        n = len(slots)
        jitter = lambda: float(self.rng.uniform(-0.03, 0.03))
        self.planes = []
        for i, slot in enumerate(slots):
            name = plane_id(i)
            brain_id = str(slot.get("brain_id") or name)
            slot_role = str(slot.get("role") or "")
            if self.mode == MODE_HUNT:
                if slot_role in (ROLE_PREY, ROLE_PACK):
                    role = slot_role
                elif brain_id == "prey":
                    role = ROLE_PREY
                elif i < self.n_prey:
                    role = ROLE_PREY
                else:
                    role = ROLE_PACK
            else:
                role = ROLE_FFA
            angle = (2.0 * np.pi * i) / n - np.pi / 2
            mid = ARENA / 2
            radius = (0.32 if n > 2 else 0.28) * ARENA
            x = float(np.clip(mid + radius * np.cos(angle) + jitter() * ARENA, 0.08 * ARENA, 0.92 * ARENA))
            y = float(np.clip(mid + radius * np.sin(angle) + jitter() * ARENA, 0.08 * ARENA, 0.92 * ARENA))
            heading = float(wrap_angle(angle + np.pi + self.rng.uniform(-0.25, 0.25)))
            self.planes.append(Plane(name, i, x, y, heading, brain_id=brain_id, role=role))
        self.bullets = []
        self.t = 0.0
        self.steps = 0
        self.events = []
        self.extra_turns = {}

    def step(self, red_action: int | dict[str, int], blue_action: int = 1) -> dict[str, float]:
        if self.mode == MODE_HUNT:
            prey = self.prey()
            rewards = {p.name: (0.001 if prey and p.name == prey.name else -0.002) for p in self.planes}
        else:
            rewards = {p.name: -0.002 for p in self.planes}
        if self._already_over():
            return rewards
        if isinstance(red_action, dict):
            actions = red_action
        else:
            actions = {self.red.name: int(red_action), self.blue.name: int(blue_action)}
        for plane in self.planes:
            if plane.alive:
                self._act(plane, int(actions.get(plane.name, 1)), rewards)
        self._integrate_planes()
        self._integrate_bullets()
        self._walls(rewards)
        self._midair(rewards)
        self._hits(rewards)
        self._shaping(rewards)
        self._swarm_shaping(rewards)
        self.t += DT
        self.steps += 1
        if self.mode == MODE_HUNT:
            self._resolve_hunt(rewards)
        else:
            live = self.living()
            if len(live) == 1:
                self.events.append(f"win_{live[0].name}")
            elif self.steps >= self.max_steps and len(live) > 1:
                self.events.append("draw")
                for plane in live:
                    rewards[plane.name] -= 1.0
        return rewards

    def done(self) -> bool:
        return self._already_over() or self.steps >= self.max_steps

    def snapshot(self) -> dict:
        live = self.living()
        prey = self.prey()
        return {
            "t": self.t,
            "mode": self.mode,
            "n_planes": len(self.planes),
            "n_prey": len(self.preys()),
            "n_hive": len(self.pack()) if self.mode == MODE_HUNT else max(0, len(self.planes) - len(self.preys())),
            "alive": len(live),
            "prey": prey.name if prey and self.mode == MODE_HUNT else None,
            "red": self.red.pose(),
            "blue": self.blue.pose(),
            "planes": [p.pose() for p in self.planes],
            "bullets": [b.pose() for b in self.bullets],
            "events": list(self.events),
            "links": self._pack_links(),
        }

    def observe(self, who: str, extras: dict[str, float] | None = None) -> np.ndarray:
        me = self._plane(who)
        focus = self._focus(me)
        out = np.zeros(OBS, dtype=float)
        if focus is not None and _can_see(me, focus):
            out[0:4] = _relative_plane(me, focus)
        out[4:10] = (
            (me.x / ARENA - 0.5) * 2,
            (me.y / ARENA - 0.5) * 2,
            np.cos(me.heading),
            np.sin(me.heading),
            _ray_to_wall(me.x, me.y, me.heading),
            me.cooldown / COOLDOWN,
        )
        out[10:14] = _edge_distances(me.x, me.y)
        ally = self._nearest_ally(me)
        if ally is not None:
            out[18:22] = (
                *_relative_plane(me, ally)[:2],
                float(np.cos(wrap_angle(ally.heading - me.heading))),
                float(np.clip(0.12 / (np.hypot(ally.x - me.x, ally.y - me.y) + 1e-3), 0.0, 1.0)),
            )
        role = me.swarm_role or ""
        out[22] = 1.0 if role == "point" else 0.0
        out[23] = 1.0 if role == "flank_l" else 0.0
        out[24] = 1.0 if role == "flank_r" else 0.0
        out[25] = 1.0 if role == "cutter" else 0.0
        if extras:
            out[14] = float(extras.get("mem_fwd", 0.0))
            out[15] = float(extras.get("mem_right", 0.0))
            out[16] = float(extras.get("mem_heat", 0.0))
            out[17] = float(extras.get("mem_kill", 0.0))
        return out

    def _act(self, plane: Plane, action: int, rewards: dict[str, float]) -> None:
        action = int(np.clip(action, 0, 5))
        turn = float((action % 3) - 1)
        fire = action >= 3
        extra = float(self.extra_turns.get(plane.name, 0.0))
        turn = float(np.clip(turn + self.swarm_gain * extra, -1.0, 1.0))
        plane.heading = wrap_angle(plane.heading + turn * max_yaw_rate() * DT)
        plane.cooldown = max(0.0, plane.cooldown - DT)
        if fire:
            if plane.cooldown > 1e-9:
                rewards[plane.name] -= 0.01
            else:
                self.bullets.append(Bullet(plane.x, plane.y, plane.heading, plane.name))
                plane.cooldown = COOLDOWN

    def _integrate_planes(self) -> None:
        for p in self.planes:
            if not p.alive:
                continue
            p.x += SPEED * np.cos(p.heading) * DT
            p.y += SPEED * np.sin(p.heading) * DT

    def _integrate_bullets(self) -> None:
        live = []
        for b in self.bullets:
            b.x += BULLET_SPEED * np.cos(b.heading) * DT
            b.y += BULLET_SPEED * np.sin(b.heading) * DT
            b.age += DT
            if 0.0 <= b.x <= ARENA and 0.0 <= b.y <= ARENA and b.age <= BULLET_LIFE:
                live.append(b)
        self.bullets = live

    def _walls(self, rewards: dict[str, float]) -> None:
        for p in self.planes:
            if p.alive and (p.x <= 0.0 or p.x >= ARENA or p.y <= 0.0 or p.y >= ARENA):
                p.alive = False
                self.events.append(f"{p.name}_wall")
                if self.mode == MODE_HUNT:
                    self._hunt_loss(p, rewards, wall=True)
                else:
                    rewards[p.name] -= 1.0
                    others = self.living()
                    if others:
                        bonus = 0.35 / len(others)
                        for q in others:
                            rewards[q.name] += bonus

    def _midair(self, rewards: dict[str, float]) -> None:
        live = self.living()
        crashed: set[str] = set()
        for i, a in enumerate(live):
            for b in live[i + 1 :]:
                if np.hypot(a.x - b.x, a.y - b.y) < 2 * COLLIDE_R:
                    crashed.add(a.name)
                    crashed.add(b.name)
        if not crashed:
            return
        prey_hit = any(p.role == ROLE_PREY and p.name in crashed for p in self.planes)
        for p in self.planes:
            if p.name in crashed and p.alive:
                p.alive = False
                rewards[p.name] -= 0.8
        self.events.append("midair")
        if self.mode != MODE_HUNT:
            return
        pack_in = [p for p in self.pack() if p.name in crashed]
        if prey_hit:
            for q in self.pack_living():
                rewards[q.name] += 0.35
        elif pack_in and self.preys_living():
            for prey in self.preys_living():
                rewards[prey.name] += 1.0
            for q in self.pack_living():
                rewards[q.name] -= 0.45

    def _hits(self, rewards: dict[str, float]) -> None:
        leftover = []
        for b in self.bullets:
            hit = None
            for target in self.planes:
                if target.alive and target.name != b.owner and np.hypot(b.x - target.x, b.y - target.y) < HIT_R:
                    hit = target
                    break
            if hit is not None:
                hit.alive = False
                self.events.append(f"{b.owner}_kill")
                if self.mode == MODE_HUNT:
                    self._hunt_shot(b.owner, hit, rewards)
                else:
                    rewards[b.owner] += 1.0
                    rewards[hit.name] -= 1.0
            else:
                leftover.append(b)
        self.bullets = leftover

    def _shaping(self, rewards: dict[str, float]) -> None:
        for me in self.planes:
            if not me.alive:
                continue
            you = self._focus(me)
            if you is None:
                continue
            dx, dy = you.x - me.x, you.y - me.y
            bearing = wrap_angle(np.arctan2(dy, dx) - me.heading)
            rng = float(np.hypot(dx, dy))
            if rng < GUN_RANGE:
                rewards[me.name] += 0.035 * max(0.0, np.cos(bearing))
            wall = _ray_to_wall(me.x, me.y, me.heading)
            if wall < 0.14:
                rewards[me.name] -= 0.10 * (0.14 - wall) / 0.14
            margin = min(me.x, me.y, ARENA - me.x, ARENA - me.y)
            rewards[me.name] += 0.01 * margin
            if margin < 0.12:
                rewards[me.name] -= 0.14 * (0.12 - margin) / 0.12

    def _swarm_shaping(self, rewards: dict[str, float]) -> None:
        if self.mode != MODE_HUNT:
            return
        prey = self.prey()
        pack = self.pack_living()
        if prey is None or not prey.alive or len(pack) < 2:
            return
        angles = [float(np.arctan2(p.y - prey.y, p.x - prey.x)) for p in pack]
        spread = 0.0
        for i, a in enumerate(angles):
            diffs = [abs(wrap_angle(a - b)) for j, b in enumerate(angles) if j != i]
            if diffs:
                spread += min(diffs)
        spread = spread / max(len(pack), 1)
        surround = float(np.clip(spread / (np.pi / max(len(pack), 1)), 0.0, 1.0))
        for p in pack:
            rewards[p.name] += 0.012 * surround
            others = [q for q in pack if q.name != p.name]
            if not others:
                continue
            nearest = min(float(np.hypot(p.x - q.x, p.y - q.y)) for q in others)
            if nearest < 0.09:
                rewards[p.name] -= 0.04 * (0.09 - nearest) / 0.09

    def _plane(self, who: str) -> Plane:
        for p in self.planes:
            if p.name == who:
                return p
        if who == "red":
            return self.red
        if who == "blue":
            return self.blue
        raise KeyError(who)

    def _nearest_other(self, me: Plane) -> Plane | None:
        others = [p for p in self.planes if p.name != me.name and p.alive]
        if not others:
            return None
        return min(others, key=lambda p: float(np.hypot(p.x - me.x, p.y - me.y)))

    def _nearest_ally(self, me: Plane) -> Plane | None:
        if self.mode == MODE_HUNT:
            if me.role == ROLE_PREY:
                others = [p for p in self.preys_living() if p.name != me.name]
            else:
                others = [p for p in self.pack_living() if p.name != me.name]
        else:
            others = [p for p in self.living() if p.name != me.name]
        if not others:
            return None
        return min(others, key=lambda p: float(np.hypot(p.x - me.x, p.y - me.y)))

    def _focus(self, me: Plane) -> Plane | None:
        if self.mode == MODE_HUNT:
            if me.role == ROLE_PACK:
                living_prey = self.preys_living()
                if living_prey:
                    return min(living_prey, key=lambda p: float(np.hypot(p.x - me.x, p.y - me.y)))
                return None
            if me.role == ROLE_PREY:
                hunters = self.pack_living()
                if hunters:
                    return min(hunters, key=lambda p: float(np.hypot(p.x - me.x, p.y - me.y)))
                return None
        return self._nearest_other(me)

    def _pack_links(self) -> list[dict]:
        pack = self.pack_living() if self.mode == MODE_HUNT else self.living()
        links = []
        for i, a in enumerate(pack):
            for b in pack[i + 1 :]:
                dist = float(np.hypot(a.x - b.x, a.y - b.y))
                if dist < 0.28:
                    links.append({"a": a.name, "b": b.name, "x0": a.x, "y0": a.y, "x1": b.x, "y1": b.y, "dist": dist})
        return links

    def _already_over(self) -> bool:
        if self.mode == MODE_HUNT:
            return not self.preys_living() or not self.pack_living()
        return self._survivors() <= 1

    def _survivors(self) -> int:
        return sum(1 for p in self.planes if p.alive)

    def _hunt_shot(self, owner: str, hit: Plane, rewards: dict[str, float]) -> None:
        shooter = next((p for p in self.planes if p.name == owner), None)
        owner_is_prey = bool(shooter and shooter.role == ROLE_PREY)
        hit_is_prey = hit.role == ROLE_PREY
        if owner_is_prey and not hit_is_prey:
            rewards[owner] += 1.5
            rewards[hit.name] -= 1.0
            for q in self.pack_living():
                rewards[q.name] -= 0.55
            for q in self.preys_living():
                if q.name != owner:
                    rewards[q.name] += 0.35
        elif hit_is_prey and not owner_is_prey:
            rewards[owner] += 2.2
            rewards[hit.name] -= 1.6
            for q in self.pack_living():
                if q.name != owner:
                    rewards[q.name] += 0.5
            for q in self.preys_living():
                rewards[q.name] -= 0.35
        else:
            rewards[owner] -= 1.2
            rewards[hit.name] -= 1.0
            if owner_is_prey:
                for q in self.pack_living():
                    rewards[q.name] += 0.4
            else:
                for q in self.preys_living():
                    rewards[q.name] += 1.1

    def _hunt_loss(self, plane: Plane, rewards: dict[str, float], *, wall: bool) -> None:
        if plane.role == ROLE_PREY:
            rewards[plane.name] -= 1.4
            for q in self.pack_living():
                rewards[q.name] += 0.35
            return
        rewards[plane.name] -= 1.2 if wall else 1.0
        for q in self.preys_living():
            rewards[q.name] += 1.0
        for q in self.pack_living():
            rewards[q.name] -= 0.45

    def _resolve_hunt(self, rewards: dict[str, float]) -> None:
        if any(event in self.events for event in ("prey_down", "pack_wipe", "escape")):
            return
        living_prey = self.preys_living()
        pack_lost = sum(1 for p in self.pack() if not p.alive)
        if not living_prey:
            self.events.append("prey_down")
            if pack_lost == 0:
                self.events.append("clean_hunt")
            bonus = max(-0.8, 1.6 - 0.7 * pack_lost)
            for q in self.pack_living():
                rewards[q.name] += bonus
            for prey in self.preys():
                rewards[prey.name] -= 0.3
        elif not self.pack_living():
            self.events.append("pack_wipe")
            for prey in living_prey:
                rewards[prey.name] += 2.4 + 0.35 * pack_lost
        elif self.steps >= self.max_steps and living_prey:
            self.events.append("escape")
            for prey in living_prey:
                rewards[prey.name] += 2.0 + 0.35 * pack_lost
            for q in self.pack_living():
                rewards[q.name] -= 1.2


def _can_see(me: Plane, you: Plane) -> bool:
    return float(np.hypot(you.x - me.x, you.y - me.y)) <= SENSE_RANGE


def _relative_plane(me: Plane, you: Plane) -> tuple[float, float, float, float]:
    dx, dy = you.x - me.x, you.y - me.y
    c, s = np.cos(me.heading), np.sin(me.heading)
    fwd = dx * c + dy * s
    right = -dx * s + dy * c
    rng = float(np.hypot(dx, dy)) / (ARENA * np.sqrt(2.0))
    rel_h = wrap_angle(you.heading - me.heading) / np.pi
    return float(fwd), float(right), rng, rel_h


def _edge_distances(x: float, y: float) -> tuple[float, float, float, float]:
    return (
        float(np.clip(x / ARENA, 0.0, 1.0)),
        float(np.clip((ARENA - x) / ARENA, 0.0, 1.0)),
        float(np.clip(y / ARENA, 0.0, 1.0)),
        float(np.clip((ARENA - y) / ARENA, 0.0, 1.0)),
    )


def _ray_to_wall(x: float, y: float, heading: float) -> float:
    c, s = float(np.cos(heading)), float(np.sin(heading))
    hits = []
    if c > 1e-9:
        hits.append((ARENA - x) / c)
    elif c < -1e-9:
        hits.append((0.0 - x) / c)
    if s > 1e-9:
        hits.append((ARENA - y) / s)
    elif s < -1e-9:
        hits.append((0.0 - y) / s)
    return float(min(hits)) if hits else 1.0
