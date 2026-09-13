"""Self-play loop: two empty policies duel, then both learn from their traces."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from .agents import ACTION_NAMES, Policy
from .physics import MAX_STEPS, World, clamp_max_steps

CURVE_KEEP = 200
SAVE_EVERY = 50


@dataclass
class Scoreboard:
    red_kills: int = 0
    blue_kills: int = 0
    red_walls: int = 0
    blue_walls: int = 0
    midairs: int = 0
    draws: int = 0
    episodes: int = 0

    def as_dict(self) -> dict:
        return {
            "red_kills": self.red_kills,
            "blue_kills": self.blue_kills,
            "red_walls": self.red_walls,
            "blue_walls": self.blue_walls,
            "midairs": self.midairs,
            "draws": self.draws,
            "episodes": self.episodes,
        }

    @classmethod
    def from_dict(cls, payload: dict) -> Scoreboard:
        return cls(
            red_kills=int(payload.get("red_kills", 0)),
            blue_kills=int(payload.get("blue_kills", 0)),
            red_walls=int(payload.get("red_walls", 0)),
            blue_walls=int(payload.get("blue_walls", 0)),
            midairs=int(payload.get("midairs", 0)),
            draws=int(payload.get("draws", 0)),
            episodes=int(payload.get("episodes", 0)),
        )

    def note(self, events: list[str]) -> None:
        self.episodes += 1
        if "red_kill" in events:
            self.red_kills += 1
        if "blue_kill" in events:
            self.blue_kills += 1
        if "red_wall" in events:
            self.red_walls += 1
        if "blue_wall" in events:
            self.blue_walls += 1
        if "midair" in events:
            self.midairs += 1
        if "draw" in events and not any(e.endswith("_kill") or e.endswith("_wall") or e == "midair" for e in events):
            self.draws += 1


@dataclass
class Academy:
    rng: np.random.Generator
    data_dir: Path | None = None
    red: Policy = field(init=False)
    blue: Policy = field(init=False)
    score: Scoreboard = field(default_factory=Scoreboard)
    curve: list[dict] = field(default_factory=list)
    empty: bool = True
    max_steps: int = MAX_STEPS
    stats_gen: int = 0

    def __post_init__(self) -> None:
        if self.data_dir is not None:
            self.data_dir = Path(self.data_dir)
            self.data_dir.mkdir(parents=True, exist_ok=True)
        self.red = Policy(self.rng, "red")
        self.blue = Policy(self.rng, "blue")
        self.restore()

    def brain_paths(self) -> dict[str, Path] | None:
        if self.data_dir is None:
            return None
        return {
            "red": self.data_dir / "red.npz",
            "blue": self.data_dir / "blue.npz",
            "academy": self.data_dir / "academy.json",
        }

    def restore(self) -> bool:
        paths = self.brain_paths()
        if paths is None or not paths["red"].is_file() or not paths["blue"].is_file():
            return False
        try:
            self.red.load(paths["red"])
            self.blue.load(paths["blue"])
            if paths["academy"].is_file():
                payload = json.loads(paths["academy"].read_text())
                self.score = Scoreboard.from_dict(payload.get("score") or {})
                self.curve = list(payload.get("curve") or [])[-CURVE_KEEP:]
                self.empty = bool(payload.get("empty", self.score.episodes == 0))
                if "max_steps" in payload:
                    self.max_steps = clamp_max_steps(payload["max_steps"])
            else:
                self.empty = False
            return True
        except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
            self.reset_models(persist=False)
            return False

    def persist(self) -> None:
        paths = self.brain_paths()
        if paths is None or self.data_dir is None:
            return
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.red.save(paths["red"])
        self.blue.save(paths["blue"])
        tmp = paths["academy"].with_name(".academy.json.tmp")
        tmp.write_text(
            json.dumps(
                {
                    "score": self.score.as_dict(),
                    "curve": _jsonable(self.curve[-CURVE_KEEP:]),
                    "empty": self.empty,
                    "max_steps": self.max_steps,
                }
            )
        )
        tmp.replace(paths["academy"])

    def reset_models(self, persist: bool = True) -> None:
        self.red.reset()
        self.blue.reset()
        self.score = Scoreboard()
        self.curve = []
        self.empty = True
        if persist:
            self.persist()

    def reset_stats(self, persist: bool = True) -> None:
        self.stats_gen += 1
        self.score = Scoreboard()
        self.curve = []
        if persist:
            self.persist()

    def set_max_steps(self, steps: int, persist: bool = True) -> int:
        self.max_steps = clamp_max_steps(steps)
        if persist:
            self.persist()
        return self.max_steps

    def training_report(self) -> dict:
        score = self.score
        n = score.episodes
        curve = self.curve
        tail = curve[-24:] if curve else []

        def rate(count: int) -> float:
            return (count / n) if n else 0.0

        def mean_of(rows: list[dict], pick) -> float | None:
            if not rows:
                return None
            return float(np.mean([pick(row) for row in rows]))

        last = curve[-1] if curve else None
        return {
            "episodes": n,
            "kill_rate": {"red": rate(score.red_kills), "blue": rate(score.blue_kills)},
            "wall_rate": {"red": rate(score.red_walls), "blue": rate(score.blue_walls)},
            "midair_rate": rate(score.midairs),
            "draw_rate": rate(score.draws),
            "life": {
                "mean": mean_of(curve, lambda row: row["steps"]),
                "recent": mean_of(tail, lambda row: row["steps"]),
            },
            "return": {
                "red": mean_of(tail, lambda row: row["red"]["return"]),
                "blue": mean_of(tail, lambda row: row["blue"]["return"]),
            },
            "loss": {
                "red": mean_of(tail, lambda row: row["red"].get("loss", 0.0)),
                "blue": mean_of(tail, lambda row: row["blue"].get("loss", 0.0)),
            },
            "entropy": {
                "red": mean_of(tail, lambda row: row["red"]["entropy"]),
                "blue": mean_of(tail, lambda row: row["blue"]["entropy"]),
            },
            "fire_rate": {
                "red": mean_of(tail, lambda row: row["red"].get("fire_rate", 0.0)),
                "blue": mean_of(tail, lambda row: row["blue"].get("fire_rate", 0.0)),
            },
            "last_actions": {
                "red": (last["red"].get("actions") if last else None),
                "blue": (last["blue"].get("actions") if last else None),
            },
            "divergence": _brain_divergence(self.red, self.blue),
            "updates": {"red": self.red.updates, "blue": self.blue.updates},
        }

    def play(self, learn: bool = True, lr: float = 0.012, record: bool = True, persist: bool = True) -> dict:
        epoch = self.stats_gen
        world = World(self.rng, max_steps=self.max_steps)
        red_roll: list[tuple[np.ndarray, int, float]] = []
        blue_roll: list[tuple[np.ndarray, int, float]] = []
        frames = []
        while not world.done():
            o_r = world.observe("red")
            o_b = world.observe("blue")
            a_r, _, _ = self.red.act(o_r)
            a_b, _, _ = self.blue.act(o_b)
            reward = world.step(a_r, a_b)
            red_roll.append((o_r, a_r, reward["red"]))
            blue_roll.append((o_b, a_b, reward["blue"]))
            frames.append(world.snapshot())
        if record and epoch == self.stats_gen:
            self.score.note(world.events)
        if learn:
            red_stats = self.red.learn(red_roll, lr=lr)
            blue_stats = self.blue.learn(blue_roll, lr=lr)
        else:
            red_stats = _watch_stats(self.red, red_roll, o_r)
            blue_stats = _watch_stats(self.blue, blue_roll, o_b)
        row = {
            "episode": self.score.episodes,
            "steps": world.steps,
            "events": world.events,
            "red": red_stats,
            "blue": blue_stats,
            "score": self.score.as_dict(),
        }
        if learn:
            self.empty = False
            if epoch == self.stats_gen:
                self.curve.append(row)
            if persist:
                self.persist()
        return {"trace": frames, "summary": row}

    def lesson(self, episodes: int = 100, lr: float = 0.018) -> dict:
        rows = []
        last = None
        for i in range(episodes):
            last = self.play(learn=True, lr=lr, persist=False)
            rows.append(last["summary"])
            if (i + 1) % SAVE_EVERY == 0:
                self.persist()
        self.persist()
        watch = self.play(learn=False, record=False)
        return {
            "trained": rows,
            "watch": watch,
            "score": self.score.as_dict(),
            "empty": False,
            "lesson": _narrate(rows, self.score),
        }


def _watch_stats(policy: Policy, rollout: list[tuple[np.ndarray, int, float]], last_obs: np.ndarray) -> dict:
    n = max(len(rollout), 1)
    hist = np.bincount([int(action) for _, action, _ in rollout], minlength=len(ACTION_NAMES))
    return {
        "loss": 0.0,
        "return": float(sum(reward for _, _, reward in rollout)),
        "entropy": policy.entropy(last_obs),
        "actions": [int(v) for v in hist],
        "fire_rate": float(hist[3:].sum() / n),
        "turn": {
            "left": float((hist[0] + hist[3]) / n),
            "straight": float((hist[1] + hist[4]) / n),
            "right": float((hist[2] + hist[5]) / n),
        },
        "hidden_active": float(np.mean([np.mean(policy.forward(obs)["h"] > 0.0) for obs, _, _ in rollout])) if rollout else 0.0,
    }


def _brain_divergence(red: Policy, blue: Policy) -> dict[str, float]:
    a = np.concatenate([red.W1.ravel(), red.W2.ravel(), red.b1, red.b2])
    b = np.concatenate([blue.W1.ravel(), blue.W2.ravel(), blue.b1, blue.b2])
    denom = float(np.linalg.norm(a) * np.linalg.norm(b)) + 1e-12
    return {
        "cosine": float(np.dot(a, b) / denom),
        "l2": float(np.linalg.norm(a - b)),
    }


def _narrate(rows: list[dict], score: Scoreboard) -> str:
    if not rows:
        return "No sorties yet."
    first = rows[: max(1, len(rows) // 5)]
    last = rows[-max(1, len(rows) // 5) :]
    crash0 = np.mean([any("wall" in e or e == "midair" for e in r["events"]) for r in first])
    crash1 = np.mean([any("wall" in e or e == "midair" for e in r["events"]) for r in last])
    life0 = np.mean([r["steps"] for r in first])
    life1 = np.mean([r["steps"] for r in last])
    return (
        f"{len(rows)} sorties of trial and error. Mean life {life0:.0f} → {life1:.0f} steps. "
        f"Crash fraction {crash0:.0%} → {crash1:.0%}. "
        f"Scoreboard: red {score.red_kills} kills / {score.red_walls} walls, "
        f"blue {score.blue_kills} kills / {score.blue_walls} walls, {score.midairs} midairs."
    )


def _jsonable(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_jsonable(item) for item in value]
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, (np.floating, np.integer, np.bool_)):
        return value.item()
    return value
