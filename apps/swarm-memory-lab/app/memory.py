"""Shared tactical map. Every drone writes; every drone reads.

This is the lab's 'shared memory': a decaying 2-D blackboard over the
arena, not a private net. One hunter that sees the prey leaves a scent
the rest of the pack can steer by, even if their own weights never
changed on that step.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

if __package__:
    from .physics import ARENA, DT, Plane, wrap_angle
else:
    from physics import ARENA, DT, Plane, wrap_angle

GRID = 32
CHANNELS = ("prey", "danger", "kill", "traffic")
TAU = 2.8


def _cell(x: float, y: float) -> tuple[int, int]:
    i = int(np.clip(np.floor(float(x) / ARENA * GRID), 0, GRID - 1))
    j = int(np.clip(np.floor(float(y) / ARENA * GRID), 0, GRID - 1))
    return i, j


@dataclass
class SharedMemory:
    """Four-channel arena map: prey scent, danger, kill success, traffic."""

    grid: np.ndarray = field(init=False)
    writes: int = 0
    hits: int = 0

    def __post_init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self.grid = np.zeros((len(CHANNELS), GRID, GRID), dtype=float)
        self.writes = 0
        self.hits = 0

    def decay(self) -> None:
        self.grid *= float(np.exp(-DT / TAU))

    def splat(self, channel: str, x: float, y: float, value: float = 1.0) -> None:
        if channel not in CHANNELS:
            return
        c = CHANNELS.index(channel)
        i, j = _cell(x, y)
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                ii, jj = i + di, j + dj
                if 0 <= ii < GRID and 0 <= jj < GRID:
                    w = value * (1.0 if di == 0 and dj == 0 else 0.45)
                    self.grid[c, jj, ii] = min(1.0, self.grid[c, jj, ii] + w)
        self.writes += 1

    def sample(self, channel: str, x: float, y: float) -> float:
        c = CHANNELS.index(channel)
        i, j = _cell(x, y)
        return float(self.grid[c, j, i])

    def centroid(self, channel: str) -> tuple[float, float, float]:
        c = CHANNELS.index(channel)
        layer = self.grid[c]
        mass = float(np.sum(layer))
        if mass < 1e-4:
            return 0.5, 0.5, 0.0
        ys, xs = np.indices((GRID, GRID))
        cx = float((xs * layer).sum() / mass + 0.5) / GRID
        cy = float((ys * layer).sum() / mass + 0.5) / GRID
        return cx, cy, min(1.0, mass / 8.0)

    def readout(self, me: Plane) -> dict[str, float]:
        px, py, mass = self.centroid("prey")
        dx, dy = px - me.x, py - me.y
        c, s = np.cos(me.heading), np.sin(me.heading)
        fwd = dx * c + dy * s
        right = -dx * s + dy * c
        heat = self.sample("danger", me.x, me.y) + 0.45 * self.sample("traffic", me.x, me.y)
        kill = self.sample("kill", me.x, me.y)
        if mass < 0.05:
            fwd, right = 0.0, 0.0
        return {
            "mem_fwd": float(np.clip(fwd, -1.0, 1.0)),
            "mem_right": float(np.clip(right, -1.0, 1.0)),
            "mem_heat": float(np.clip(heat, 0.0, 1.0)),
            "mem_kill": float(np.clip(kill, 0.0, 1.0)),
            "prey_x": px,
            "prey_y": py,
            "prey_mass": mass,
        }

    def scent_turn(self, me: Plane) -> float:
        feat = self.readout(me)
        if feat["prey_mass"] < 0.05:
            return 0.0
        bearing = wrap_angle(np.arctan2(feat["prey_y"] - me.y, feat["prey_x"] - me.x) - me.heading)
        return float(np.clip(bearing / (np.pi / 2), -1.0, 1.0))

    def energy(self) -> dict[str, float]:
        return {name: float(np.sum(self.grid[i])) for i, name in enumerate(CHANNELS)}

    def snapshot(self) -> dict:
        layers = {name: [[round(float(v), 3) for v in row] for row in self.grid[i]] for i, name in enumerate(CHANNELS)}
        px, py, mass = self.centroid("prey")
        return {
            "grid": GRID,
            "channels": list(CHANNELS),
            "layers": layers,
            "energy": self.energy(),
            "writes": self.writes,
            "hits": self.hits,
            "prey": {"x": px, "y": py, "mass": mass},
        }

    def watch(self, planes: list[Plane], new_events: list[str], pack_names: set[str], sense_range: float = 0.40) -> None:
        self.decay()
        preys = [p for p in planes if p.role == "prey" and p.alive]
        for plane in planes:
            if not plane.alive:
                continue
            if plane.role == "pack" or plane.name in pack_names:
                self.splat("traffic", plane.x, plane.y, 0.28)
                for prey in preys:
                    dist = float(np.hypot(plane.x - prey.x, plane.y - prey.y))
                    if dist <= sense_range:
                        self.splat("prey", prey.x, prey.y, 0.70)
            elif plane.role == "prey":
                self.splat("prey", plane.x, plane.y, 0.12)
        for event in new_events:
            if event.endswith("_wall"):
                name = event[: -len("_wall")]
                plane = next((p for p in planes if p.name == name), None)
                if plane is not None:
                    self.splat("danger", plane.x, plane.y, 0.9)
            elif event == "midair":
                for plane in planes:
                    if not plane.alive:
                        self.splat("danger", plane.x, plane.y, 0.7)
            elif event.endswith("_kill"):
                owner = event[: -len("_kill")]
                shooter = next((p for p in planes if p.name == owner), None)
                if shooter is not None:
                    self.splat("kill", shooter.x, shooter.y, 1.0)
                    self.hits += 1
            elif event == "prey_down":
                for prey in planes:
                    if prey.role == "prey":
                        self.splat("kill", prey.x, prey.y, 1.0)
                self.hits += 1
