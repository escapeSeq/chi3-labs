"""2-D gun fight with a hard turn radius and forward-only shots.

Each plane is a Dubins-style vehicle: constant speed, yaw rate capped by
speed / turn_radius. The gun is bolted to the nose — bullets inherit heading
and never steer.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

ARENA = 1.0
DT = 0.05
MAX_STEPS = 240
MIN_STEPS = 40
MAX_STEPS_CAP = 1200
SPEED = 0.20
TURN_RADIUS = 0.12
COLLIDE_R = 0.030
BULLET_SPEED = 0.72
BULLET_LIFE = 0.46
HIT_R = 0.028
COOLDOWN = 0.65
GUN_RANGE = BULLET_SPEED * BULLET_LIFE


def clamp_max_steps(steps: int) -> int:
    return int(min(MAX_STEPS_CAP, max(MIN_STEPS, int(steps))))


def steps_from_seconds(seconds: float) -> int:
    return clamp_max_steps(round(float(seconds) / DT))


def seconds_from_steps(steps: int) -> float:
    return clamp_max_steps(steps) * DT


def max_yaw_rate() -> float:
    return SPEED / TURN_RADIUS


def wrap_angle(a: float) -> float:
    return float((a + np.pi) % (2 * np.pi) - np.pi)


@dataclass
class Plane:
    name: str
    x: float
    y: float
    heading: float
    cooldown: float = 0.0
    alive: bool = True

    def pose(self) -> dict:
        return {
            "name": self.name,
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
    red: Plane = field(init=False)
    blue: Plane = field(init=False)
    bullets: list[Bullet] = field(default_factory=list)
    t: float = 0.0
    steps: int = 0
    events: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.max_steps = max(1, int(self.max_steps))
        self.reset()

    def reset(self) -> None:
        jitter = lambda: float(self.rng.uniform(-0.06, 0.06))
        self.red = Plane(
            "red",
            0.22 + jitter(),
            0.30 + jitter(),
            float(self.rng.uniform(0.05, 0.9)),
        )
        self.blue = Plane(
            "blue",
            0.78 + jitter(),
            0.70 + jitter(),
            float(self.rng.uniform(np.pi - 0.2, np.pi + 0.9)),
        )
        self.bullets = []
        self.t = 0.0
        self.steps = 0
        self.events = []

    def step(self, red_action: int, blue_action: int) -> dict[str, float]:
        rewards = {"red": -0.002, "blue": -0.002}
        if not self.red.alive or not self.blue.alive:
            return rewards
        self._act(self.red, red_action, rewards)
        self._act(self.blue, blue_action, rewards)
        self._integrate_planes()
        self._integrate_bullets()
        self._walls(rewards)
        self._midair(rewards)
        self._hits(rewards)
        self._shaping(rewards)
        self.t += DT
        self.steps += 1
        if self.steps >= self.max_steps and self.red.alive and self.blue.alive:
            self.events.append("draw")
        return rewards

    def done(self) -> bool:
        return (not self.red.alive) or (not self.blue.alive) or self.steps >= self.max_steps

    def snapshot(self) -> dict:
        return {
            "t": self.t,
            "red": self.red.pose(),
            "blue": self.blue.pose(),
            "bullets": [b.pose() for b in self.bullets],
            "events": list(self.events),
        }

    def observe(self, who: str) -> np.ndarray:
        me = self.red if who == "red" else self.blue
        you = self.blue if who == "red" else self.red
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
        for p in (self.red, self.blue):
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
        for p in (self.red, self.blue):
            if p.alive and (p.x <= 0.0 or p.x >= ARENA or p.y <= 0.0 or p.y >= ARENA):
                p.alive = False
                rewards[p.name] -= 1.0
                other = "blue" if p.name == "red" else "red"
                if (self.red if other == "red" else self.blue).alive:
                    rewards[other] += 0.35
                self.events.append(f"{p.name}_wall")

    def _midair(self, rewards: dict[str, float]) -> None:
        if self.red.alive and self.blue.alive:
            if np.hypot(self.red.x - self.blue.x, self.red.y - self.blue.y) < 2 * COLLIDE_R:
                self.red.alive = False
                self.blue.alive = False
                rewards["red"] -= 0.8
                rewards["blue"] -= 0.8
                self.events.append("midair")

    def _hits(self, rewards: dict[str, float]) -> None:
        leftover = []
        for b in self.bullets:
            target = self.blue if b.owner == "red" else self.red
            if target.alive and np.hypot(b.x - target.x, b.y - target.y) < HIT_R:
                target.alive = False
                rewards[b.owner] += 1.0
                rewards[target.name] -= 1.0
                self.events.append(f"{b.owner}_kill")
            else:
                leftover.append(b)
        self.bullets = leftover

    def _shaping(self, rewards: dict[str, float]) -> None:
        if not (self.red.alive and self.blue.alive):
            return
        for me, you in ((self.red, self.blue), (self.blue, self.red)):
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
