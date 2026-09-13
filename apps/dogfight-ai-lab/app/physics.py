"""2-D free-for-all gun fight with a hard turn radius and forward-only shots.

Each plane is a Dubins-style vehicle: constant speed, yaw rate capped by
speed / turn_radius. The gun is bolted to the nose — bullets inherit heading
and never steer. Every other living plane is a target. The sortie ends when
one plane remains, or the clock runs out.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

ARENA = 1.0
DT = 0.05
MAX_STEPS = 12000
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
MIN_PLANES = 2
MAX_PLANES = 9


def clamp_max_steps(steps: int) -> int:
    return int(min(MAX_STEPS_CAP, max(MIN_STEPS, int(steps))))


def steps_from_seconds(seconds: float) -> int:
    return clamp_max_steps(round(float(seconds) / DT))


def seconds_from_steps(steps: int) -> float:
    return clamp_max_steps(steps) * DT


def clamp_plane_count(n: int) -> int:
    return int(min(MAX_PLANES, max(MIN_PLANES, int(n))))


def plane_id(i: int) -> str:
    return f"p{int(i) + 1}"


def default_lineup(n: int) -> list[dict[str, str]]:
    n = clamp_plane_count(n)
    return [{"brain_id": plane_id(i)} for i in range(n)]


def max_yaw_rate() -> float:
    return SPEED / TURN_RADIUS


def wrap_angle(a: float) -> float:
    return float((a + np.pi) % (2 * np.pi) - np.pi)


@dataclass
class Plane:
    name: str
    seat: int
    x: float
    y: float
    heading: float
    brain_id: str = ""
    cooldown: float = 0.0
    alive: bool = True

    def pose(self) -> dict:
        return {
            "name": self.name,
            "seat": self.seat,
            "brain_id": self.brain_id or self.name,
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
    n_planes: int = MIN_PLANES
    lineup: list[dict[str, str]] | None = None
    planes: list[Plane] = field(init=False)
    bullets: list[Bullet] = field(default_factory=list)
    t: float = 0.0
    steps: int = 0
    events: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.max_steps = max(1, int(self.max_steps))
        if self.lineup:
            self.lineup = [dict(slot) for slot in self.lineup]
            self.n_planes = clamp_plane_count(len(self.lineup))
            self.lineup = self.lineup[: self.n_planes]
        else:
            self.n_planes = clamp_plane_count(self.n_planes)
            self.lineup = default_lineup(self.n_planes)
        self.reset()

    @property
    def red(self) -> Plane:
        return self.planes[0]

    @property
    def blue(self) -> Plane:
        return self.planes[1] if len(self.planes) > 1 else self.planes[0]

    def living(self) -> list[Plane]:
        return [p for p in self.planes if p.alive]

    def reset(self) -> None:
        slots = list(self.lineup or default_lineup(self.n_planes))
        n = len(slots)
        jitter = lambda: float(self.rng.uniform(-0.03, 0.03))
        self.planes = []
        for i, slot in enumerate(slots):
            name = plane_id(i)
            brain_id = str(slot.get("brain_id") or name)
            angle = (2.0 * np.pi * i) / n - np.pi / 2
            radius = 0.32 if n > 2 else 0.28
            x = float(np.clip(0.5 + radius * np.cos(angle) + jitter(), 0.08, 0.92))
            y = float(np.clip(0.5 + radius * np.sin(angle) + jitter(), 0.08, 0.92))
            heading = float(wrap_angle(angle + np.pi + self.rng.uniform(-0.25, 0.25)))
            self.planes.append(Plane(name, i, x, y, heading, brain_id=brain_id))
        self.bullets = []
        self.t = 0.0
        self.steps = 0
        self.events = []

    def step(self, red_action: int | dict[str, int], blue_action: int = 1) -> dict[str, float]:
        rewards = {p.name: -0.002 for p in self.planes}
        if self._survivors() <= 1:
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
        self.t += DT
        self.steps += 1
        live = self.living()
        if len(live) == 1:
            self.events.append(f"win_{live[0].name}")
        elif self.steps >= self.max_steps and len(live) > 1:
            self.events.append("draw")
        return rewards

    def done(self) -> bool:
        return self._survivors() <= 1 or self.steps >= self.max_steps

    def snapshot(self) -> dict:
        live = self.living()
        return {
            "t": self.t,
            "n_planes": len(self.planes),
            "alive": len(live),
            "red": self.red.pose(),
            "blue": self.blue.pose(),
            "planes": [p.pose() for p in self.planes],
            "bullets": [b.pose() for b in self.bullets],
            "events": list(self.events),
        }

    def observe(self, who: str) -> np.ndarray:
        me = self._plane(who)
        you = self._nearest_other(me) or me
        dx, dy = you.x - me.x, you.y - me.y
        c, s = np.cos(me.heading), np.sin(me.heading)
        fwd = dx * c + dy * s
        right = -dx * s + dy * c
        rng = float(np.hypot(dx, dy))
        rel_h = wrap_angle(you.heading - me.heading)
        return np.array(
            [
                fwd,
                right,
                rng / np.sqrt(2.0),
                rel_h / np.pi,
                (me.x - 0.5) * 2,
                (me.y - 0.5) * 2,
                np.cos(me.heading),
                np.sin(me.heading),
                _ray_to_wall(me.x, me.y, me.heading),
                me.cooldown / COOLDOWN,
            ],
            dtype=float,
        )

    def _act(self, plane: Plane, action: int, rewards: dict[str, float]) -> None:
        action = int(np.clip(action, 0, 5))
        turn = (action % 3) - 1
        fire = action >= 3
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
                rewards[p.name] -= 1.0
                others = self.living()
                if others:
                    bonus = 0.35 / len(others)
                    for q in others:
                        rewards[q.name] += bonus
                self.events.append(f"{p.name}_wall")

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
        for p in self.planes:
            if p.name in crashed and p.alive:
                p.alive = False
                rewards[p.name] -= 0.8
        self.events.append("midair")

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
                rewards[b.owner] += 1.0
                rewards[hit.name] -= 1.0
                self.events.append(f"{b.owner}_kill")
            else:
                leftover.append(b)
        self.bullets = leftover

    def _shaping(self, rewards: dict[str, float]) -> None:
        for me in self.planes:
            if not me.alive:
                continue
            you = self._nearest_other(me)
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

    def _survivors(self) -> int:
        return sum(1 for p in self.planes if p.alive)


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


def decode_action(action: int) -> tuple[int, bool]:
    action = int(action)
    return (action % 3) - 1, action >= 3
