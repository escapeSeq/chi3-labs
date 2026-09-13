"""Free-for-all academy: each seat has a brain, learners are revisions of frozen nets."""

from __future__ import annotations

import json
import re
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

if __package__:
    from .agents import ACTION_NAMES, Policy
    from .physics import MAX_STEPS, MIN_PLANES, World, clamp_max_steps, clamp_plane_count, default_lineup, plane_id
else:
    from agents import ACTION_NAMES, Policy
    from physics import MAX_STEPS, MIN_PLANES, World, clamp_max_steps, clamp_plane_count, default_lineup, plane_id

CURVE_KEEP = 200
SAVE_EVERY = 50
MAX_BRAINS = 36
_SAFE_ID = re.compile(r"^[a-z][a-z0-9-]{0,23}$")


@dataclass
class Scoreboard:
    kills: dict[str, int] = field(default_factory=dict)
    walls: dict[str, int] = field(default_factory=dict)
    wins: dict[str, int] = field(default_factory=dict)
    midairs: int = 0
    draws: int = 0
    episodes: int = 0
    last_winner: str | None = None

    def as_dict(self) -> dict:
        return {
            "kills": dict(self.kills),
            "walls": dict(self.walls),
            "wins": dict(self.wins),
            "midairs": self.midairs,
            "draws": self.draws,
            "episodes": self.episodes,
            "last_winner": self.last_winner,
            "red_kills": int(self.kills.get("p1", 0)),
            "blue_kills": int(self.kills.get("p2", 0)),
            "red_walls": int(self.walls.get("p1", 0)),
            "blue_walls": int(self.walls.get("p2", 0)),
        }

    @classmethod
    def from_dict(cls, payload: dict) -> Scoreboard:
        return cls(
            kills=_int_map(payload.get("kills")),
            walls=_int_map(payload.get("walls")),
            wins=_int_map(payload.get("wins")),
            midairs=int(payload.get("midairs", 0)),
            draws=int(payload.get("draws", 0)),
            episodes=int(payload.get("episodes", 0)),
            last_winner=payload.get("last_winner"),
        )

    def note(self, events: list[str], name_to_brain: dict[str, str]) -> None:
        self.episodes += 1
        self.last_winner = None
        for event in events:
            if event.endswith("_kill"):
                name = event[: -len("_kill")]
                bid = name_to_brain.get(name, name)
                self.kills[bid] = self.kills.get(bid, 0) + 1
            elif event.endswith("_wall"):
                name = event[: -len("_wall")]
                bid = name_to_brain.get(name, name)
                self.walls[bid] = self.walls.get(bid, 0) + 1
            elif event.startswith("win_"):
                name = event[len("win_") :]
                bid = name_to_brain.get(name, name)
                self.wins[bid] = self.wins.get(bid, 0) + 1
                self.last_winner = bid
            elif event == "midair":
                self.midairs += 1
        if "draw" in events and not any(e.startswith("win_") for e in events):
            self.draws += 1


@dataclass
class BrainSlot:
    id: str
    label: str
    learn: bool
    policy: Policy
    parent_id: str | None = None
    lineage: str = ""
    revision: int = 0
    stored: bool = False

    def __post_init__(self) -> None:
        if not self.lineage:
            self.lineage = self.parent_id or self.id

    def meta(self) -> dict:
        return {
            "id": self.id,
            "label": self.label,
            "learn": self.learn,
            "parent_id": self.parent_id,
            "lineage": self.lineage,
            "revision": self.revision,
            "stored": self.stored,
        }


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
        self.brains = {}
        self._ensure_seat_brains(self.n_planes)
        self.lineup = default_lineup(self.n_planes)
        self.restore()

    @property
    def red(self) -> Policy:
        return self._seat_policy(0)

    @property
    def blue(self) -> Policy:
        return self._seat_policy(1)

    def _seat_policy(self, seat: int) -> Policy:
        if seat < len(self.lineup):
            bid = self.lineup[seat]["brain_id"]
            if bid in self.brains:
                return self.brains[bid].policy
        fallback = plane_id(seat) if plane_id(seat) in self.brains else next(iter(self.brains))
        return self.brains[fallback].policy

    def _make_brain(
        self,
        brain_id: str,
        label: str,
        learn: bool,
        parent_id: str | None = None,
        lineage: str = "",
        revision: int = 0,
    ) -> BrainSlot:
        return BrainSlot(
            brain_id,
            _label(label, brain_id.upper()),
            bool(learn),
            Policy(self.rng, brain_id),
            parent_id,
            lineage or parent_id or brain_id,
            int(revision),
            False,
        )

    def _ensure_seat_brains(self, n: int) -> None:
        for i in range(n):
            bid = plane_id(i)
            if bid not in self.brains:
                self.brains[bid] = self._make_brain(bid, f"P{i + 1}", True)

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
        if not academy_path.is_file() and not (self.data_dir / "p1.npz").is_file() and not (self.data_dir / "red.npz").is_file():
            return False
        try:
            payload: dict = {}
            if academy_path.is_file():
                payload = json.loads(academy_path.read_text())
            metas = payload.get("brains")
            if not isinstance(metas, list) or not metas:
                metas = [
                    {"id": "p1", "label": "P1", "learn": True},
                    {"id": "p2", "label": "P2", "learn": True},
                ]
                if (self.data_dir / "red.npz").is_file():
                    metas[0]["id"] = "red"
                    metas[0]["label"] = "Red"
                if (self.data_dir / "blue.npz").is_file():
                    metas[1]["id"] = "blue"
                    metas[1]["label"] = "Blue"
            brains: dict[str, BrainSlot] = {}
            for meta in metas:
                if not isinstance(meta, dict):
                    continue
                brain_id = _brain_id(meta.get("id"))
                if not brain_id or brain_id in brains:
                    continue
                slot = self._make_brain(
                    brain_id,
                    str(meta.get("label") or brain_id),
                    bool(meta.get("learn", True)),
                    _brain_id(meta.get("parent_id")),
                    str(meta.get("lineage") or brain_id),
                    int(meta.get("revision") or 0),
                )
                weight_path = self.data_dir / f"{brain_id}.npz"
                if not weight_path.is_file() and brain_id == "p1" and (self.data_dir / "red.npz").is_file():
                    weight_path = self.data_dir / "red.npz"
                if not weight_path.is_file() and brain_id == "p2" and (self.data_dir / "blue.npz").is_file():
                    weight_path = self.data_dir / "blue.npz"
                if weight_path.is_file():
                    slot.policy.load(weight_path)
                brains[brain_id] = slot
            if not brains:
                return False
            self.brains = brains
            if "max_steps" in payload:
                self.max_steps = clamp_max_steps(payload["max_steps"])
            n_planes = clamp_plane_count(payload.get("n_planes", self.n_planes))
            self._ensure_seat_brains(n_planes)
            self.lineup = _normalize_lineup(payload.get("lineup"), n_planes, self.brains)
            self.n_planes = len(self.lineup)
            assigned = {item["brain_id"] for item in self.lineup}
            for meta in metas:
                if not isinstance(meta, dict):
                    continue
                brain_id = _brain_id(meta.get("id"))
                if not brain_id or brain_id not in self.brains:
                    continue
                if "stored" in meta:
                    self.brains[brain_id].stored = bool(meta.get("stored"))
                else:
                    self.brains[brain_id].stored = brain_id not in assigned
            self._detach_stored_seats()
            self._prune_ephemeral()
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
            if slot.stored:
                slot.learn = False
                continue
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
        self.brains = {}
        self.n_planes = MIN_PLANES
        self._ensure_seat_brains(self.n_planes)
        self.lineup = default_lineup(self.n_planes)
        if persist:
            self.persist()

    def set_max_steps(self, steps: int, persist: bool = True) -> int:
        self.max_steps = clamp_max_steps(steps)
        if persist:
            self.persist()
        return self.max_steps

    def set_n_planes(self, n: int, persist: bool = True) -> int:
        n = clamp_plane_count(n)
        while len(self.lineup) < n:
            seat = len(self.lineup)
            slot = self._fresh_seat_brain(seat)
            self.lineup.append({"brain_id": slot.id})
        self.lineup = self.lineup[:n]
        self.n_planes = len(self.lineup)
        self._prune_ephemeral()
        if persist:
            self.persist()
        return self.n_planes

    def _fresh_seat_brain(self, seat: int) -> BrainSlot:
        bid = plane_id(seat)
        if bid not in self.brains:
            self.brains[bid] = self._make_brain(bid, f"P{seat + 1}", True)
            return self.brains[bid]
        used = {item["brain_id"] for item in self.lineup}
        if bid not in used and not self.brains[bid].stored:
            return self.brains[bid]
        return self.add_brain(f"P{seat + 1}", learn=True, persist=False)

    def set_roster(self, brains: list[dict], lineup: list[dict] | None = None, persist: bool = True) -> None:
        by_id = {slot.id: slot for slot in self.brains.values()}
        for meta in brains:
            brain_id = _brain_id(meta.get("id"))
            if brain_id is None or brain_id not in by_id:
                continue
            slot = by_id[brain_id]
            slot.label = _label(meta.get("label"), slot.label)
            if slot.stored:
                slot.learn = False
                continue
            want_learn = bool(meta.get("learn", slot.learn))
            slot.learn = want_learn
        if lineup is not None:
            self.lineup = self._apply_lineup(lineup)
            self.n_planes = len(self.lineup)
            self._prune_ephemeral()
        if persist:
            self.persist()

    def _apply_lineup(self, lineup: list[dict]) -> list[dict[str, str]]:
        n = clamp_plane_count(len(lineup) or self.n_planes)
        raw = list(lineup)
        pending: list[dict] = []
        for i in range(n):
            item = raw[i] if i < len(raw) and isinstance(raw[i], dict) else {}
            brain_id = _brain_id(item.get("brain_id")) or plane_id(i)
            if brain_id not in self.brains:
                self.brains[brain_id] = self._make_brain(brain_id, brain_id.upper(), True)
            pending.append({"brain_id": brain_id, "learn": item.get("learn")})
        for item in pending:
            if self.brains[item["brain_id"]].stored:
                clone = self._checkout_brain(item["brain_id"], learn=item["learn"] is True)
                item["brain_id"] = clone.id
        seats: list[dict[str, str]] = []
        for i, item in enumerate(pending):
            brain_id = item["brain_id"]
            want = item["learn"]
            slot = self.brains[brain_id]
            others = [other for j, other in enumerate(pending) if j != i and other["brain_id"] == brain_id]
            if want is True and others and (any(other["learn"] is False for other in others) or slot.learn is False):
                child = self.revise_brain(brain_id, persist=False)
                pending[i]["brain_id"] = child.id
                seats.append({"brain_id": child.id})
            else:
                if want is True:
                    slot.learn = True
                elif want is False:
                    slot.learn = False
                seats.append({"brain_id": brain_id})
        return [{"brain_id": self._flyable_id(item["brain_id"], learn=False)} for item in seats]

    def add_brain(self, label: str = "New brain", learn: bool = True, persist: bool = True) -> BrainSlot:
        if len(self.brains) >= MAX_BRAINS:
            raise ValueError(f"at most {MAX_BRAINS} brains")
        brain_id = self._next_brain_id()
        slot = self._make_brain(brain_id, label or brain_id.upper(), learn)
        self.brains[brain_id] = slot
        if persist:
            self.persist()
        return slot

    def revise_brain(self, parent_id: str, persist: bool = True, assign_seat: int | None = None) -> BrainSlot:
        parent_id = _brain_id(parent_id) or parent_id
        if parent_id not in self.brains:
            raise KeyError(parent_id)
        if len(self.brains) >= MAX_BRAINS:
            raise ValueError(f"at most {MAX_BRAINS} brains")
        parent = self.brains[parent_id]
        revision = 1 + max(
            (slot.revision for slot in self.brains.values() if slot.lineage == (parent.lineage or parent.id)),
            default=parent.revision,
        )
        lineage = parent.lineage or parent.id
        label = _revision_label(parent.label, revision)
        brain_id = self._next_brain_id(prefix=f"{lineage}-r")
        child = self._make_brain(brain_id, label, True, parent.id, lineage, revision)
        child.policy.copy_from(parent.policy)
        self.brains[brain_id] = child
        parent.learn = False
        parent.stored = True
        if assign_seat is not None and 0 <= assign_seat < len(self.lineup):
            self.lineup[assign_seat]["brain_id"] = child.id
        if persist:
            self._detach_stored_seats()
            if child.id not in {item["brain_id"] for item in self.lineup}:
                child.stored = True
                child.learn = False
            self._prune_ephemeral()
            self.persist()
        return child

    def remove_brain(self, brain_id: str, persist: bool = True) -> None:
        brain_id = _brain_id(brain_id) or brain_id
        if brain_id not in self.brains:
            raise KeyError(brain_id)
        assigned = [i for i, slot in enumerate(self.lineup) if slot["brain_id"] == brain_id]
        if len(self.brains) - 1 < 1:
            raise ValueError("need at least one brain")
        del self.brains[brain_id]
        for seat in assigned:
            replacement = self._fresh_seat_brain(seat)
            self.lineup[seat]["brain_id"] = replacement.id
        self._prune_ephemeral()
        if persist:
            self.persist()

    def wipe_brain(self, brain_id: str, persist: bool = True) -> None:
        brain_id = _brain_id(brain_id) or brain_id
        if brain_id not in self.brains:
            raise KeyError(brain_id)
        self.brains[brain_id].policy.reset()
        self.empty = all(slot.policy.updates == 0 for slot in self.brains.values() if not slot.stored)
        if persist:
            self.persist()

    def _checkout_brain(self, source_id: str, learn: bool = True) -> BrainSlot:
        source_id = _brain_id(source_id) or source_id
        source = self.brains[source_id]
        if len(self.brains) >= MAX_BRAINS:
            raise ValueError(f"at most {MAX_BRAINS} brains")
        lineage = source.lineage or source.id
        child = self._make_brain(
            self._next_brain_id(prefix=f"{lineage}-w"),
            source.label,
            bool(learn),
            source.id,
            lineage,
            int(source.revision or 0),
        )
        child.policy.copy_from(source.policy)
        child.stored = False
        self.brains[child.id] = child
        return child

    def _flyable_id(self, brain_id: str, learn: bool = True) -> str:
        slot = self.brains.get(brain_id)
        if slot is None or not slot.stored:
            return brain_id
        return self._checkout_brain(brain_id, learn=learn).id

    def _detach_stored_seats(self) -> None:
        copies: dict[str, str] = {}
        for item in self.lineup:
            bid = item["brain_id"]
            slot = self.brains.get(bid)
            if slot is None or not slot.stored:
                continue
            if bid not in copies:
                copies[bid] = self._checkout_brain(bid, learn=False).id
            item["brain_id"] = copies[bid]
            slot.learn = False

    def _assigned_ids(self) -> set[str]:
        return {item["brain_id"] for item in self.lineup}

    def _drop_brain(self, brain_id: str) -> None:
        self.brains.pop(brain_id, None)
        if self.data_dir is None:
            return
        path = self.data_dir / f"{brain_id}.npz"
        if path.is_file():
            path.unlink()

    def _prune_ephemeral(self) -> None:
        keep = self._assigned_ids()
        drop = [bid for bid, slot in self.brains.items() if bid not in keep and not slot.stored]
        for bid in drop:
            if len(self.brains) <= 1:
                break
            if bid in keep:
                continue
            self._drop_brain(bid)

    def _next_brain_id(self, prefix: str = "b") -> str:
        prefix = re.sub(r"[^a-z0-9-]", "", prefix.lower()) or "b"
        n = 1
        while True:
            candidate = f"{prefix}{n}"
            if len(candidate) > 24:
                candidate = f"b{n}"
            if _SAFE_ID.match(candidate) and candidate not in self.brains:
                return candidate
            n += 1

    def roster_report(self) -> list[dict]:
        used = [item["brain_id"] for item in self.lineup]
        episodes = self.score.episodes
        rows = []
        for slot in self.brains.values():
            info = slot.policy.inspect()
            info.update(slot.meta())
            info["planes"] = used.count(slot.id)
            info["assigned"] = slot.id in used
            info["in_library"] = bool(slot.stored)
            info["parent_label"] = self.brains[slot.parent_id].label if slot.parent_id in self.brains else None
            wins = int(self.score.wins.get(slot.id, 0))
            kills = int(self.score.kills.get(slot.id, 0))
            walls = int(self.score.walls.get(slot.id, 0))
            info["wins"] = wins
            info["kills"] = kills
            info["walls"] = walls
            info["win_rate"] = (wins / episodes) if episodes else 0.0
            info["kill_rate"] = (kills / episodes) if episodes else 0.0
            info["wall_rate"] = (walls / episodes) if episodes else 0.0
            rows.append(info)
        rows.sort(key=lambda row: (row.get("lineage") or row["id"], row.get("revision") or 0, row["id"]))
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
            values = [pick(row) for row in rows]
            values = [v for v in values if v is not None]
            if not values:
                return None
            return float(np.mean(values))

        last = curve[-1] if curve else None
        last_brains = (last or {}).get("brains") or {}
        p1 = self.lineup[0]["brain_id"] if self.lineup else "p1"
        p2 = self.lineup[1]["brain_id"] if len(self.lineup) > 1 else "p2"
        return {
            "episodes": n,
            "kill_rate": {bid: rate(count) for bid, count in score.kills.items()},
            "win_rate": {bid: rate(count) for bid, count in score.wins.items()},
            "wall_rate": {bid: rate(count) for bid, count in score.walls.items()},
            "midair_rate": rate(score.midairs),
            "draw_rate": rate(score.draws),
            "life": {
                "mean": mean_of(curve, lambda row: row["steps"]),
                "recent": mean_of(tail, lambda row: row["steps"]),
            },
            "return": {
                "red": mean_of(tail, lambda row: (row.get("brains") or {}).get(p1, row.get("red") or {}).get("return")),
                "blue": mean_of(tail, lambda row: (row.get("brains") or {}).get(p2, row.get("blue") or {}).get("return")),
            },
            "last_actions": {
                "red": (last_brains.get(p1) or (last or {}).get("red") or {}).get("actions") if last else None,
                "blue": (last_brains.get(p2) or (last or {}).get("blue") or {}).get("actions") if last else None,
                "brains": {bid: row.get("actions") for bid, row in last_brains.items()},
            },
            "divergence": _brain_divergence(self.red, self.blue) if len(self.brains) >= 2 else {"cosine": 1.0, "l2": 0.0},
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
                slot = self.brains.get(plane.brain_id) or self.brains[self.lineup[plane.seat]["brain_id"]]
                action, _, _ = slot.policy.act(obs)
                actions[plane.name] = action
            reward = world.step(actions)
            for name, action in actions.items():
                rolls[name].append((last_obs[name], action, float(reward.get(name, 0.0))))
            snap = world.snapshot()
            for pose in snap["planes"]:
                pose["brain_label"] = labels.get(pose.get("brain_id"), pose.get("brain_id", ""))
            frames.append(snap)

        brain_rolls: dict[str, list[tuple[np.ndarray, int, float]]] = defaultdict(list)
        last_by_brain: dict[str, np.ndarray] = {}
        name_to_brain = {p.name: p.brain_id if p.brain_id in self.brains else self.lineup[p.seat]["brain_id"] for p in world.planes}
        for plane in world.planes:
            bid = name_to_brain[plane.name]
            brain_rolls[bid].extend(rolls[plane.name])
            if plane.name in last_obs:
                last_by_brain[bid] = last_obs[plane.name]
        if record and epoch == self.stats_gen:
            self.score.note(world.events, name_to_brain)

        probe_fallback = next(iter(last_obs.values()), world.observe(world.planes[0].name))
        brain_stats: dict[str, dict] = {}
        for bid, slot in self.brains.items():
            roll = brain_rolls[bid]
            probe = last_by_brain.get(bid, probe_fallback)
            if learn and slot.learn and not slot.stored:
                brain_stats[bid] = slot.policy.learn(roll, lr=lr)
            else:
                brain_stats[bid] = _watch_stats(slot.policy, roll, probe)

        p1 = name_to_brain.get(world.red.name, "p1")
        p2 = name_to_brain.get(world.blue.name, "p2")
        row = {
            "episode": self.score.episodes,
            "steps": world.steps,
            "events": world.events,
            "red": brain_stats.get(p1) or _watch_stats(self.red, [], probe_fallback),
            "blue": brain_stats.get(p2) or _watch_stats(self.blue, [], probe_fallback),
            "brains": brain_stats,
            "winner": self.score.last_winner,
            "score": self.score.as_dict(),
        }
        if learn:
            self.empty = all(slot.policy.updates == 0 for slot in self.brains.values() if not slot.stored)
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
            "lesson": _narrate(rows, self.score, self.brains),
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


def _narrate(rows: list[dict], score: Scoreboard, brains: dict[str, BrainSlot]) -> str:
    if not rows:
        return "No sorties yet."
    first = rows[: max(1, len(rows) // 5)]
    last = rows[-max(1, len(rows) // 5) :]
    crash0 = np.mean([any("wall" in e or e == "midair" for e in r["events"]) for r in first])
    crash1 = np.mean([any("wall" in e or e == "midair" for e in r["events"]) for r in last])
    life0 = np.mean([r["steps"] for r in first])
    life1 = np.mean([r["steps"] for r in last])
    top = max(score.wins, key=score.wins.get) if score.wins else None
    champ = brains[top].label if top in brains else (top or "nobody")
    return (
        f"{len(rows)} last-plane-standing sorties. Mean life {life0:.0f} → {life1:.0f} steps. "
        f"Crash fraction {crash0:.0%} → {crash1:.0%}. "
        f"Wins leader: {champ}. Draws {score.draws}, midairs {score.midairs}."
    )


def _label(raw: Any, fallback: str) -> str:
    text = " ".join(str(raw or "").split())[:32].strip()
    return text or fallback


def _revision_label(parent_label: str, revision: int) -> str:
    base = re.sub(r"\s*r\d+$", "", parent_label).strip() or parent_label
    return _label(f"{base} r{revision}", f"r{revision}")


def _brain_id(raw: Any) -> str | None:
    text = str(raw or "").strip().lower()
    if _SAFE_ID.match(text):
        return text
    return None


def _normalize_lineup(lineup: Any, n_planes: int, brains: dict[str, BrainSlot]) -> list[dict[str, str]]:
    n = clamp_plane_count(n_planes if n_planes else MIN_PLANES)
    raw = list(lineup) if isinstance(lineup, list) else []
    slots: list[dict[str, str]] = []
    ids = list(brains)
    for i in range(n):
        item = raw[i] if i < len(raw) and isinstance(raw[i], dict) else {}
        brain_id = _brain_id(item.get("brain_id")) or plane_id(i)
        if brain_id not in brains:
            brain_id = plane_id(i) if plane_id(i) in brains else ids[min(i, len(ids) - 1)]
        slots.append({"brain_id": brain_id})
    return slots


def _int_map(value: Any) -> dict[str, int]:
    if not isinstance(value, dict):
        return {}
    return {str(key): int(val) for key, val in value.items()}


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
