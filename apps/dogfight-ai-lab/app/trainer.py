"""Self-play loop: named policies fly assigned planes, then learners update."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

if __package__:
    from .agents import ACTION_NAMES, Policy
    from .physics import (
        MAX_STEPS,
        MIN_PLANES,
        World,
        clamp_max_steps,
        clamp_plane_count,
        default_lineup,
        team_counts,
    )
else:
    from agents import ACTION_NAMES, Policy
    from physics import (
        MAX_STEPS,
        MIN_PLANES,
        World,
        clamp_max_steps,
        clamp_plane_count,
        default_lineup,
        team_counts,
    )

CURVE_KEEP = 200
SAVE_EVERY = 50
MAX_BRAINS = 9
CORE_BRAINS = ("red", "blue")
_SAFE_ID = re.compile(r"^[a-z][a-z0-9-]{0,23}$")


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
        self.red_kills += events.count("red_kill")
        self.blue_kills += events.count("blue_kill")
        self.red_walls += events.count("red_wall")
        self.blue_walls += events.count("blue_wall")
        self.midairs += events.count("midair")
        if "draw" in events and not any(e.endswith("_kill") or e.endswith("_wall") or e == "midair" for e in events):
            self.draws += 1


@dataclass
class BrainSlot:
    id: str
    label: str
    learn: bool
    policy: Policy

    def meta(self) -> dict:
        return {"id": self.id, "label": self.label, "learn": self.learn}


@dataclass
class Academy:
    rng: np.random.Generator
    data_dir: Path | None = None
    brains: dict[str, BrainSlot] = field(init=False)
    score: Scoreboard = field(default_factory=Scoreboard)
    curve: list[dict] = field(default_factory=list)
    empty: bool = True
    max_steps: int = MAX_STEPS
    n_planes: int = MIN_PLANES
    lineup: list[dict[str, str]] = field(default_factory=list)
    stats_gen: int = 0

    def __post_init__(self) -> None:
        if self.data_dir is not None:
            self.data_dir = Path(self.data_dir)
            self.data_dir.mkdir(parents=True, exist_ok=True)
        self.brains = {
            "red": self._make_brain("red", "Red", True),
            "blue": self._make_brain("blue", "Blue", True),
        }
        self.lineup = default_lineup(self.n_planes)
        self.restore()

    @property
    def red(self) -> Policy:
        return self.brains["red"].policy

    @property
    def blue(self) -> Policy:
        return self.brains["blue"].policy

    def _make_brain(self, brain_id: str, label: str, learn: bool) -> BrainSlot:
        return BrainSlot(brain_id, _label(label, brain_id.title()), bool(learn), Policy(self.rng, brain_id))

    def brain_paths(self) -> dict[str, Path] | None:
        if self.data_dir is None:
            return None
        paths = {bid: self.data_dir / f"{bid}.npz" for bid in self.brains}
        paths["academy"] = self.data_dir / "academy.json"
        return paths

    def restore(self) -> bool:
        if self.data_dir is None:
            return False
        academy_path = self.data_dir / "academy.json"
        red_path = self.data_dir / "red.npz"
        blue_path = self.data_dir / "blue.npz"
        if not red_path.is_file() or not blue_path.is_file():
            return False
        try:
            payload: dict = {}
            if academy_path.is_file():
                payload = json.loads(academy_path.read_text())
            metas = payload.get("brains")
            if not isinstance(metas, list) or not metas:
                metas = [{"id": "red", "label": "Red", "learn": True}, {"id": "blue", "label": "Blue", "learn": True}]
            brains: dict[str, BrainSlot] = {}
            for meta in metas:
                if not isinstance(meta, dict):
                    continue
                brain_id = _brain_id(meta.get("id"))
                if not brain_id or brain_id in brains:
                    continue
                slot = self._make_brain(brain_id, str(meta.get("label") or brain_id), bool(meta.get("learn", True)))
                weight_path = self.data_dir / f"{brain_id}.npz"
                if weight_path.is_file():
                    slot.policy.load(weight_path)
                brains[brain_id] = slot
            for core in CORE_BRAINS:
                if core not in brains:
                    slot = self._make_brain(core, core.title(), True)
                    weight_path = self.data_dir / f"{core}.npz"
                    if weight_path.is_file():
                        slot.policy.load(weight_path)
                    brains[core] = slot
            self.brains = brains
            if "max_steps" in payload:
                self.max_steps = clamp_max_steps(payload["max_steps"])
            if "n_planes" in payload:
                self.n_planes = clamp_plane_count(payload["n_planes"])
            self.lineup = _normalize_lineup(payload.get("lineup"), self.n_planes, self.brains)
            self.n_planes = len(self.lineup)
            if academy_path.is_file():
                self.score = Scoreboard.from_dict(payload.get("score") or {})
                self.curve = list(payload.get("curve") or [])[-CURVE_KEEP:]
                self.empty = bool(payload.get("empty", self.score.episodes == 0))
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
        for brain_id, slot in self.brains.items():
            slot.policy.save(paths[brain_id])
        tmp = paths["academy"].with_name(".academy.json.tmp")
        tmp.write_text(
            json.dumps(
                {
                    "score": self.score.as_dict(),
                    "curve": _jsonable(self.curve[-CURVE_KEEP:]),
                    "empty": self.empty,
                    "max_steps": self.max_steps,
                    "n_planes": self.n_planes,
                    "brains": [slot.meta() for slot in self.brains.values()],
                    "lineup": self.lineup,
                }
            )
        )
        tmp.replace(paths["academy"])

    def reset_models(self, persist: bool = True) -> None:
        for slot in self.brains.values():
            slot.policy.reset()
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

    def reset_flight_setup(self, persist: bool = False) -> None:
        for brain_id in [bid for bid in self.brains if bid not in CORE_BRAINS]:
            self.brains.pop(brain_id, None)
        self.brains["red"].label = "Red"
        self.brains["red"].learn = True
        self.brains["blue"].label = "Blue"
        self.brains["blue"].learn = True
        self.n_planes = MIN_PLANES
        self.lineup = default_lineup(MIN_PLANES)
        if persist:
            self.persist()

    def set_max_steps(self, steps: int, persist: bool = True) -> int:
        self.max_steps = clamp_max_steps(steps)
        if persist:
            self.persist()
        return self.max_steps

    def set_n_planes(self, n: int, persist: bool = True) -> int:
        n = clamp_plane_count(n)
        current = list(self.lineup)
        if current == default_lineup(len(current) or MIN_PLANES):
            resized = default_lineup(n)
        elif n <= len(current):
            resized = current[:n]
        else:
            resized = current + default_lineup(n)[len(current) :]
        self.lineup = _normalize_lineup(resized, n, self.brains)
        self.n_planes = len(self.lineup)
        if persist:
            self.persist()
        return self.n_planes

    def set_roster(self, brains: list[dict], lineup: list[dict] | None = None, persist: bool = True) -> None:
        by_id = {slot.id: slot for slot in self.brains.values()}
        for meta in brains:
            brain_id = _brain_id(meta.get("id"))
            if brain_id is None or brain_id not in by_id:
                continue
            slot = by_id[brain_id]
            slot.label = _label(meta.get("label"), slot.label)
            slot.learn = bool(meta.get("learn", slot.learn))
        if lineup is not None:
            self.lineup = _normalize_lineup(lineup, self.n_planes, self.brains)
            self.n_planes = len(self.lineup)
        if persist:
            self.persist()

    def add_brain(self, label: str = "New brain", learn: bool = True, persist: bool = True) -> BrainSlot:
        if len(self.brains) >= MAX_BRAINS:
            raise ValueError(f"at most {MAX_BRAINS} brains")
        brain_id = self._next_brain_id()
        slot = self._make_brain(brain_id, label or f"Brain {len(self.brains) + 1}", learn)
        self.brains[brain_id] = slot
        if persist:
            self.persist()
        return slot

    def remove_brain(self, brain_id: str, persist: bool = True) -> None:
        brain_id = _brain_id(brain_id) or brain_id
        if brain_id in CORE_BRAINS:
            raise ValueError("red and blue brains stay on the roster")
        if brain_id not in self.brains:
            raise KeyError(brain_id)
        fallback = "red"
        del self.brains[brain_id]
        for slot in self.lineup:
            if slot["brain_id"] == brain_id:
                slot["brain_id"] = fallback if slot["team"] == "red" else "blue"
        self.lineup = _normalize_lineup(self.lineup, self.n_planes, self.brains)
        if persist:
            self.persist()

    def wipe_brain(self, brain_id: str, persist: bool = True) -> None:
        brain_id = _brain_id(brain_id) or brain_id
        if brain_id not in self.brains:
            raise KeyError(brain_id)
        self.brains[brain_id].policy.reset()
        self.empty = all(slot.policy.updates == 0 for slot in self.brains.values())
        if persist:
            self.persist()

    def _next_brain_id(self) -> str:
        n = 3
        while f"b{n}" in self.brains:
            n += 1
        return f"b{n}"

    def roster_report(self) -> list[dict]:
        used = {slot["brain_id"] for slot in self.lineup}
        rows = []
        for slot in self.brains.values():
            info = slot.policy.inspect()
            info.update(slot.meta())
            info["planes"] = sum(1 for item in self.lineup if item["brain_id"] == slot.id)
            info["assigned"] = slot.id in used
            rows.append(info)
        return rows

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
        last_brains = (last or {}).get("brains") or {}
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
                "brains": {bid: row.get("actions") for bid, row in last_brains.items()},
            },
            "divergence": _brain_divergence(self.red, self.blue),
            "updates": {bid: slot.policy.updates for bid, slot in self.brains.items()},
        }

    def play(self, learn: bool = True, lr: float = 0.012, record: bool = True, persist: bool = True) -> dict:
        epoch = self.stats_gen
        world = World(self.rng, max_steps=self.max_steps, lineup=self.lineup)
        rolls: dict[str, list[tuple[np.ndarray, int, float]]] = {p.name: [] for p in world.planes}
        last_obs: dict[str, np.ndarray] = {}
        frames = []
        labels = {bid: slot.label for bid, slot in self.brains.items()}
        while not world.done():
            actions: dict[str, int] = {}
            for plane in world.planes:
                if not plane.alive:
                    continue
                obs = world.observe(plane.name)
                last_obs[plane.name] = obs
                slot = self.brains.get(plane.brain_id) or self.brains[plane.team]
                action, _, _ = slot.policy.act(obs)
                actions[plane.name] = action
            reward = world.step(actions)
            for name, action in actions.items():
                rolls[name].append((last_obs[name], action, float(reward.get(name, 0.0))))
            snap = world.snapshot()
            for pose in snap["planes"]:
                pose["brain_label"] = labels.get(pose.get("brain_id"), pose.get("brain_id", ""))
            for key in ("red", "blue"):
                if snap.get(key):
                    snap[key]["brain_label"] = labels.get(snap[key].get("brain_id"), "")
            frames.append(snap)

        brain_rolls: dict[str, list[tuple[np.ndarray, int, float]]] = {bid: [] for bid in self.brains}
        team_rolls = {"red": [], "blue": []}
        last_by_brain: dict[str, np.ndarray] = {}
        for plane in world.planes:
            bid = plane.brain_id if plane.brain_id in self.brains else plane.team
            brain_rolls[bid].extend(rolls[plane.name])
            team_rolls[plane.team].extend(rolls[plane.name])
            if plane.name in last_obs:
                last_by_brain[bid] = last_obs[plane.name]
        o_r = last_obs.get("red", world.observe("red"))
        o_b = last_obs.get("blue", world.observe("blue"))
        if record and epoch == self.stats_gen:
            self.score.note(world.events)

        brain_stats: dict[str, dict] = {}
        for bid, slot in self.brains.items():
            roll = brain_rolls[bid]
            probe = last_by_brain.get(bid, o_r if bid == "red" else o_b)
            if learn and slot.learn:
                brain_stats[bid] = slot.policy.learn(roll, lr=lr)
            else:
                brain_stats[bid] = _watch_stats(slot.policy, roll, probe)

        row = {
            "episode": self.score.episodes,
            "steps": world.steps,
            "events": world.events,
            "red": brain_stats.get("red") or _watch_stats(self.red, team_rolls["red"], o_r),
            "blue": brain_stats.get("blue") or _watch_stats(self.blue, team_rolls["blue"], o_b),
            "brains": brain_stats,
            "score": self.score.as_dict(),
        }
        if learn:
            self.empty = all(slot.policy.updates == 0 for slot in self.brains.values())
            if record and epoch == self.stats_gen:
                self.curve.append(row)
            if persist:
                self.persist()
        return {"trace": frames, "summary": row}

    def lesson(self, episodes: int = 100, lr: float = 0.018) -> dict:
        rows = []
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
            "empty": self.empty,
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


def _label(raw: Any, fallback: str) -> str:
    text = " ".join(str(raw or "").split())[:32].strip()
    return text or fallback


def _brain_id(raw: Any) -> str | None:
    text = str(raw or "").strip().lower()
    if _SAFE_ID.match(text):
        return text
    return None


def _normalize_lineup(lineup: Any, n_planes: int, brains: dict[str, BrainSlot]) -> list[dict[str, str]]:
    n = clamp_plane_count(n_planes if n_planes else MIN_PLANES)
    raw = list(lineup) if isinstance(lineup, list) else []
    n_red, n_blue = team_counts(n)
    slots: list[dict[str, str]] = []
    for i in range(n):
        item = raw[i] if i < len(raw) and isinstance(raw[i], dict) else {}
        team = item.get("team", "red" if i < n_red else "blue")
        team = "red" if team == "red" else "blue"
        brain_id = _brain_id(item.get("brain_id")) or ("red" if team == "red" else "blue")
        if brain_id not in brains:
            brain_id = "red" if team == "red" else "blue"
        slots.append({"team": team, "brain_id": brain_id})
    if not any(slot["team"] == "red" for slot in slots):
        slots[0]["team"] = "red"
        if slots[0]["brain_id"] not in brains:
            slots[0]["brain_id"] = "red"
    if not any(slot["team"] == "blue" for slot in slots):
        slots[-1]["team"] = "blue"
        if slots[-1]["brain_id"] not in brains:
            slots[-1]["brain_id"] = "blue"
    return slots


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
