"""Hive vs isolated pack learners sharing a tactical map."""

from __future__ import annotations

import json
import os
import threading
import time
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

if __package__:
    from .agents import ACTION_NAMES, Policy
    from .memory import SharedMemory
    from .physics import (
        DEFAULT_HIVE,
        DEFAULT_PLANES,
        DEFAULT_PREY,
        MAX_PLANES,
        MAX_STEPS,
        MIN_HIVE,
        MIN_PLANES,
        MIN_PREY,
        MODE_HUNT,
        SENSE_RANGE,
        World,
        clamp_max_steps,
        clamp_mode,
        clamp_plane_count,
        clamp_team_counts,
        make_lineup,
    )
    from .swarm import extra_turns
else:
    from agents import ACTION_NAMES, Policy
    from memory import SharedMemory
    from physics import (
        DEFAULT_HIVE,
        DEFAULT_PLANES,
        DEFAULT_PREY,
        MAX_PLANES,
        MAX_STEPS,
        MIN_HIVE,
        MIN_PLANES,
        MIN_PREY,
        MODE_HUNT,
        SENSE_RANGE,
        World,
        clamp_max_steps,
        clamp_mode,
        clamp_plane_count,
        clamp_team_counts,
        make_lineup,
    )
    from swarm import extra_turns

CURVE_KEEP = 200
SAVE_EVERY = 40
SHARE_ISOLATED = "isolated"
SHARE_BOARD = "blackboard"
SHARE_HIVE = "hive"
SHARE_MODES = (SHARE_ISOLATED, SHARE_BOARD, SHARE_HIVE)


def clamp_share(mode: str | None) -> str:
    text = str(mode or "").strip().lower()
    if text in ("isolated", "private", "solo"):
        return SHARE_ISOLATED
    if text in ("blackboard", "board", "map", "memory"):
        return SHARE_BOARD
    return SHARE_HIVE


@dataclass
class Scoreboard:
    kills: dict[str, int] = field(default_factory=dict)
    walls: dict[str, int] = field(default_factory=dict)
    wins: dict[str, int] = field(default_factory=dict)
    midairs: int = 0
    draws: int = 0
    episodes: int = 0
    last_winner: str | None = None
    escapes: int = 0
    hunts: int = 0
    clean_hunts: int = 0
    pack_wipes: int = 0
    pack_losses: int = 0
    last_outcome: str | None = None
    last_pack_losses: int = 0

    def as_dict(self) -> dict:
        return {
            "kills": dict(self.kills),
            "walls": dict(self.walls),
            "wins": dict(self.wins),
            "midairs": self.midairs,
            "draws": self.draws,
            "episodes": self.episodes,
            "last_winner": self.last_winner,
            "escapes": self.escapes,
            "hunts": self.hunts,
            "clean_hunts": self.clean_hunts,
            "pack_wipes": self.pack_wipes,
            "pack_losses": self.pack_losses,
            "last_outcome": self.last_outcome,
            "last_pack_losses": self.last_pack_losses,
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
            escapes=int(payload.get("escapes", 0)),
            hunts=int(payload.get("hunts", 0)),
            clean_hunts=int(payload.get("clean_hunts", 0)),
            pack_wipes=int(payload.get("pack_wipes", 0)),
            pack_losses=int(payload.get("pack_losses", 0)),
            last_outcome=payload.get("last_outcome"),
            last_pack_losses=int(payload.get("last_pack_losses", 0)),
        )

    def note(self, events: list[str], name_to_brain: dict[str, str], *, mode: str, pack_dead: list[str]) -> None:
        self.episodes += 1
        self.last_winner = None
        self.last_outcome = None
        self.last_pack_losses = 0
        for event in events:
            if event.endswith("_kill"):
                name = event[: -len("_kill")]
                bid = name_to_brain.get(name, name)
                self.kills[bid] = self.kills.get(bid, 0) + 1
            elif event.endswith("_wall"):
                name = event[: -len("_wall")]
                bid = name_to_brain.get(name, name)
                self.walls[bid] = self.walls.get(bid, 0) + 1
            elif event.startswith("win_") and mode != MODE_HUNT:
                name = event[len("win_") :]
                bid = name_to_brain.get(name, name)
                self.wins[bid] = self.wins.get(bid, 0) + 1
                self.last_winner = bid
                self.last_outcome = "win"
            elif event == "midair":
                self.midairs += 1
        if mode != MODE_HUNT:
            if "draw" in events and not any(e.startswith("win_") for e in events):
                self.draws += 1
                self.last_outcome = "failure"
            return
        self.last_pack_losses = len(pack_dead)
        self.pack_losses += self.last_pack_losses
        if "escape" in events:
            self.escapes += 1
            self.last_outcome = "escape"
            self.last_winner = "prey"
        elif "pack_wipe" in events:
            self.pack_wipes += 1
            self.last_outcome = "wipe"
            self.last_winner = "prey"
        elif "prey_down" in events:
            self.hunts += 1
            self.last_winner = "hive" if "hive" in name_to_brain.values() else "pack"
            if "clean_hunt" in events:
                self.clean_hunts += 1
                self.last_outcome = "clean_hunt"
            elif any(event.endswith("_wall") and name_to_brain.get(event[: -len("_wall")]) == "prey" for event in events):
                self.last_outcome = "prey_crash"
            elif "midair" in events:
                self.last_outcome = "midair"
            else:
                self.last_outcome = "hunt"


@dataclass
class Academy:
    rng: np.random.Generator
    data_dir: Path | None = None
    mode: str = MODE_HUNT
    share: str = SHARE_HIVE
    scores: dict[str, Scoreboard] = field(default_factory=dict)
    curves: dict[str, list] = field(default_factory=dict)
    empty: bool = True
    max_steps: int = MAX_STEPS
    n_prey: int = DEFAULT_PREY
    n_hive: int = DEFAULT_HIVE
    swarm_gain: float = 0.55
    memory_gain: float = 0.35
    memory_on: bool = True

    def __post_init__(self) -> None:
        if self.data_dir is not None:
            self.data_dir = Path(self.data_dir)
            self.data_dir.mkdir(parents=True, exist_ok=True)
        self.mode = clamp_mode(self.mode)
        self.share = clamp_share(self.share)
        self.scores = {SHARE_ISOLATED: Scoreboard(), SHARE_BOARD: Scoreboard(), SHARE_HIVE: Scoreboard()}
        self.curves = {SHARE_ISOLATED: [], SHARE_BOARD: [], SHARE_HIVE: []}
        self.n_prey, self.n_hive = clamp_team_counts(self.n_prey, self.n_hive)
        self.prey = Policy(self.rng, "prey")
        self.hive = Policy(self.rng, "hive")
        self.memory = SharedMemory()
        self._play_lock = threading.RLock()
        self._persist_lock = threading.RLock()
        self._burst_stop = threading.Event()
        self._burst_thread: threading.Thread | None = None
        self.burst_running = False
        self.burst_trained = 0
        self.burst_error: str | None = None
        self.stats_gen = 0
        self.restore()

    @property
    def score(self) -> Scoreboard:
        return self.scores.setdefault(self.share, Scoreboard())

    @property
    def curve(self) -> list:
        return self.curves.setdefault(self.share, [])

    @property
    def n_planes(self) -> int:
        return int(self.n_prey + self.n_hive)

    def lineup(self) -> list[dict[str, str]]:
        slots = make_lineup(self.n_prey, self.n_hive)
        if self.mode != MODE_HUNT:
            for slot in slots:
                slot["role"] = "ffa"
        return slots

    def _policy_for(self, brain_id: str) -> Policy:
        if brain_id == "prey":
            return self.prey
        return self.hive

    def uses_memory(self) -> bool:
        return bool(self.memory_on and self.share != SHARE_ISOLATED)

    def reset_models(self, persist: bool = True) -> None:
        self.stop_burst(join=True)
        self.prey.reset()
        self.hive.reset()
        self.memory.reset()
        self._clear_stats()
        self.empty = True
        if persist:
            self.persist()

    def reset_stats(self, persist: bool = True) -> None:
        self.stats_gen += 1
        self._clear_stats()
        if persist:
            self.persist()

    def reset_memory(self) -> None:
        self.memory.reset()

    def reset_brain(self, which: str, persist: bool = True) -> str:
        name = str(which or "").strip().lower()
        if name in ("prey", "preys"):
            self.prey.reset()
            name = "prey"
        elif name in ("hive", "pack", "hunter", "hunters"):
            self.hive.reset()
            name = "hive"
        else:
            raise ValueError("brain must be prey or hive")
        self.empty = self.prey.updates == 0 and self.hive.updates == 0
        if persist:
            self.persist()
        return name

    def _clear_stats(self) -> None:
        self.scores = {SHARE_ISOLATED: Scoreboard(), SHARE_BOARD: Scoreboard(), SHARE_HIVE: Scoreboard()}
        self.curves = {SHARE_ISOLATED: [], SHARE_BOARD: [], SHARE_HIVE: []}

    def set_mode(self, mode: str, persist: bool = True) -> str:
        self.mode = clamp_mode(mode)
        if persist:
            self.persist()
        return self.mode

    def set_share(self, share: str, persist: bool = True) -> str:
        self.share = clamp_share(share)
        self.scores.setdefault(self.share, Scoreboard())
        self.curves.setdefault(self.share, [])
        if persist:
            self.persist()
        return self.share

    def set_max_steps(self, steps: int, persist: bool = True) -> int:
        self.max_steps = clamp_max_steps(steps)
        if persist:
            self.persist()
        return self.max_steps

    def set_n_planes(self, n: int, persist: bool = True) -> int:
        n = clamp_plane_count(n)
        prey = int(np.clip(self.n_prey, MIN_PREY, n - MIN_HIVE))
        self.n_prey = prey
        self.n_hive = n - prey
        if persist:
            self.persist()
        return self.n_planes

    def set_n_prey(self, n: int, persist: bool = True) -> int:
        cap = MAX_PLANES - self.n_hive
        self.n_prey = int(min(max(MIN_PREY, int(n)), max(MIN_PREY, cap)))
        if persist:
            self.persist()
        return self.n_prey

    def set_n_hive(self, n: int, persist: bool = True) -> int:
        cap = MAX_PLANES - self.n_prey
        self.n_hive = int(min(max(MIN_HIVE, int(n)), max(MIN_HIVE, cap)))
        if persist:
            self.persist()
        return self.n_hive

    def set_gains(self, swarm_gain: float | None = None, memory_gain: float | None = None, memory_on: bool | None = None, persist: bool = True) -> None:
        if swarm_gain is not None:
            self.swarm_gain = float(np.clip(swarm_gain, 0.0, 1.0))
        if memory_gain is not None:
            self.memory_gain = float(np.clip(memory_gain, 0.0, 1.0))
        if memory_on is not None:
            self.memory_on = bool(memory_on)
        if persist:
            self.persist()

    def brain_paths(self) -> dict[str, Path] | None:
        if self.data_dir is None:
            return None
        paths = {
            "prey": self.data_dir / "prey.npz",
            "hive": self.data_dir / "hive.npz",
            "academy": self.data_dir / "academy.json",
        }
        return paths

    def restore(self) -> bool:
        if self.data_dir is None:
            return False
        academy_path = self.data_dir / "academy.json"
        if not academy_path.is_file() and not (self.data_dir / "hive.npz").is_file():
            return False
        try:
            payload: dict = {}
            if academy_path.is_file():
                payload = json.loads(academy_path.read_text())
            self.mode = clamp_mode(payload.get("mode"))
            self.share = clamp_share(payload.get("share"))
            self.max_steps = clamp_max_steps(payload.get("max_steps", self.max_steps))
            stored_planes = clamp_plane_count(payload.get("n_planes", DEFAULT_PLANES))
            if "n_prey" in payload or "n_hive" in payload:
                self.n_prey, self.n_hive = clamp_team_counts(
                    payload.get("n_prey", DEFAULT_PREY),
                    payload.get("n_hive", DEFAULT_HIVE),
                )
            else:
                self.n_prey, self.n_hive = clamp_team_counts(DEFAULT_PREY, stored_planes - DEFAULT_PREY)
            self.swarm_gain = float(payload.get("swarm_gain", self.swarm_gain))
            self.memory_gain = float(payload.get("memory_gain", self.memory_gain))
            self.memory_on = bool(payload.get("memory_on", True))
            stored = payload.get("scores")
            if isinstance(stored, dict):
                self.scores = {key: Scoreboard.from_dict(stored.get(key) or {}) for key in SHARE_MODES}
            stored_c = payload.get("curves")
            if isinstance(stored_c, dict):
                self.curves = {key: list(stored_c.get(key) or [])[-CURVE_KEEP:] for key in SHARE_MODES}
            self.empty = bool(payload.get("empty", True))
            paths = self.brain_paths() or {}
            if paths["prey"].is_file():
                self.prey.load(paths["prey"])
            if paths["hive"].is_file():
                self.hive.load(paths["hive"])
            return True
        except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
            self.reset_models(persist=False)
            return False

    def persist(self) -> None:
        paths = self.brain_paths()
        if paths is None or self.data_dir is None:
            return
        with self._persist_lock:
            self.data_dir.mkdir(parents=True, exist_ok=True)
            self.prey.save(paths["prey"])
            self.hive.save(paths["hive"])
            tmp = paths["academy"].with_name(f".academy.{os.getpid()}.{time.time_ns()}.json.tmp")
            tmp.write_text(
                json.dumps(
                    {
                        "mode": self.mode,
                        "share": self.share,
                        "empty": self.empty,
                        "max_steps": self.max_steps,
                        "n_planes": self.n_planes,
                        "n_prey": self.n_prey,
                        "n_hive": self.n_hive,
                        "swarm_gain": self.swarm_gain,
                        "memory_gain": self.memory_gain,
                        "memory_on": self.memory_on,
                        "scores": {key: board.as_dict() for key, board in self.scores.items()},
                        "curves": {key: _jsonable(rows[-CURVE_KEEP:]) for key, rows in self.curves.items()},
                    }
                )
            )
            tmp.replace(paths["academy"])

    def roster_report(self) -> list[dict]:
        used = [item["brain_id"] for item in self.lineup()]
        rows = []
        brains = [("prey", self.prey), ("hive", self.hive)]
        seen = set()
        for brain_id, policy in brains:
            if brain_id in seen:
                continue
            seen.add(brain_id)
            info = policy.inspect()
            info["id"] = brain_id
            info["label"] = {"prey": "Prey", "hive": "Hive"}.get(brain_id, brain_id.upper())
            info["planes"] = used.count(brain_id)
            info["assigned"] = brain_id in used
            info["kills"] = int(self.score.kills.get(brain_id, 0))
            info["walls"] = int(self.score.walls.get(brain_id, 0))
            info["wins"] = int(self.score.wins.get(brain_id, 0))
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
            values = [pick(row) for row in rows]
            values = [v for v in values if v is not None]
            if not values:
                return None
            return float(np.mean(values))

        return {
            "episodes": n,
            "hunt_rate": rate(score.hunts),
            "escape_rate": rate(score.escapes),
            "wipe_rate": rate(score.pack_wipes),
            "clean_hunt_rate": rate(score.clean_hunts),
            "draw_rate": rate(score.draws),
            "midair_rate": rate(score.midairs),
            "pack_loss_rate": (score.pack_losses / n) if n else 0.0,
            "life": {"mean": mean_of(curve, lambda row: row["steps"]), "recent": mean_of(tail, lambda row: row["steps"])},
            "updates": {
                "prey": self.prey.updates,
                "hive": self.hive.updates,
            },
        }

    def play(self, learn: bool = True, lr: float = 0.014, record: bool = True, persist: bool = True, trace: bool = True) -> dict:
        with self._play_lock:
            return self._play(learn=learn, lr=lr, record=record, persist=persist, trace=trace)

    def _play(self, learn: bool = True, lr: float = 0.014, record: bool = True, persist: bool = True, trace: bool = True) -> dict:
        epoch = self.stats_gen
        lineup = self.lineup()
        world = World(self.rng, max_steps=self.max_steps, lineup=lineup, mode=self.mode, n_planes=self.n_planes, swarm_gain=self.swarm_gain)
        rolls: dict[str, list[tuple[np.ndarray, int, float]]] = {p.name: [] for p in world.planes}
        last_obs: dict[str, np.ndarray] = {}
        frames = []
        seen_events = 0
        pack_names = {p.name for p in world.pack()}
        if not self.uses_memory():
            extras_off = {"mem_fwd": 0.0, "mem_right": 0.0, "mem_heat": 0.0, "mem_kill": 0.0}
        while not world.done():
            world.extra_turns = extra_turns(world)
            if self.uses_memory():
                for name, turn in list(world.extra_turns.items()):
                    plane = next(p for p in world.planes if p.name == name)
                    scent = self.memory.scent_turn(plane)
                    world.extra_turns[name] = float(np.clip(turn + self.memory_gain * scent, -1.0, 1.0))
            actions: dict[str, int] = {}
            for plane in world.planes:
                if not plane.alive:
                    continue
                extras = self.memory.readout(plane) if self.uses_memory() else extras_off
                obs = world.observe(plane.name, extras)
                last_obs[plane.name] = obs
                policy = self._policy_for(plane.brain_id)
                action, _, _ = policy.act(obs)
                actions[plane.name] = action
            reward = world.step(actions)
            new_events = world.events[seen_events:]
            seen_events = len(world.events)
            if self.uses_memory():
                self.memory.watch(world.planes, new_events, pack_names, sense_range=SENSE_RANGE)
            for name, action in actions.items():
                rolls[name].append((last_obs[name], action, float(reward.get(name, 0.0))))
            if trace:
                snap = world.snapshot()
                snap["memory"] = self.memory.snapshot() if self.uses_memory() else None
                for pose in snap["planes"]:
                    pose["brain_label"] = _brain_label(pose.get("brain_id"))
                frames.append(snap)

        name_to_brain = {p.name: p.brain_id for p in world.planes}
        if record and epoch == self.stats_gen:
            self.score.note(
                world.events,
                name_to_brain,
                mode=self.mode,
                pack_dead=[p.name for p in world.pack() if not p.alive],
            )

        brain_rolls: dict[str, list[tuple[np.ndarray, int, float]]] = defaultdict(list)
        last_by_brain: dict[str, np.ndarray] = {}
        for plane in world.planes:
            bid = plane.brain_id
            brain_rolls[bid].extend(rolls[plane.name])
            if plane.name in last_obs:
                last_by_brain[bid] = last_obs[plane.name]

        probe_fallback = next(iter(last_obs.values()), world.observe(world.planes[0].name))
        brain_stats: dict[str, dict] = {}
        unique = []
        for bid in dict.fromkeys(name_to_brain.values()):
            unique.append(bid)
        for bid in unique:
            policy = self._policy_for(bid)
            roll = brain_rolls[bid]
            probe = last_by_brain.get(bid, probe_fallback)
            if learn:
                brain_stats[bid] = policy.learn(roll, lr=lr)
            else:
                brain_stats[bid] = _watch_stats(policy, roll, probe)

        row = {
            "episode": self.score.episodes,
            "steps": world.steps,
            "events": world.events,
            "brains": brain_stats,
            "winner": self.score.last_winner,
            "outcome": self.score.last_outcome,
            "mode": self.mode,
            "share": self.share,
            "pack_losses": self.score.last_pack_losses,
            "memory_energy": self.memory.energy() if self.uses_memory() else {},
            "score": self.score.as_dict(),
        }
        if learn:
            self.empty = self.prey.updates == 0 and self.hive.updates == 0
            if record and epoch == self.stats_gen:
                self.curve.append(row)
                extra = len(self.curve) - CURVE_KEEP
                if extra > 0:
                    del self.curve[:extra]
            if persist:
                self.persist()
        if not frames:
            snap = world.snapshot()
            snap["memory"] = self.memory.snapshot() if self.uses_memory() else None
            frames = [snap]
        return {"trace": frames, "summary": row, "memory": self.memory.snapshot() if self.uses_memory() else None}

    def lesson(self, episodes: int = 40, lr: float = 0.014) -> dict:
        rows = []
        for i in range(episodes):
            last = self.play(learn=True, lr=lr, persist=False, trace=False)
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
            "lesson": _narrate(rows, self.score, self.share, self.mode),
        }

    def burst_status(self) -> dict:
        return {"running": bool(self.burst_running), "trained": int(self.burst_trained), "error": self.burst_error}

    def start_burst(self, lr: float = 0.014) -> dict:
        if self.burst_running:
            return self.burst_status()
        self._burst_stop.set()
        leftover = self._burst_thread
        if leftover is not None and leftover.is_alive():
            leftover.join(timeout=2)
        self._burst_stop.clear()
        self.burst_running = True
        self.burst_trained = 0
        self.burst_error = None
        self._burst_thread = threading.Thread(target=self._run_burst, args=(float(lr),), daemon=True)
        self._burst_thread.start()
        return self.burst_status()

    def stop_burst(self, join: bool = False) -> dict:
        self._burst_stop.set()
        if join:
            thread = self._burst_thread
            if thread is not None and thread.is_alive():
                thread.join(timeout=2)
            self.burst_running = False
        return self.burst_status()

    def _run_burst(self, lr: float) -> None:
        try:
            while not self._burst_stop.is_set():
                self.play(learn=True, lr=lr, persist=False, trace=False)
                self.burst_trained += 1
                if self.burst_trained % SAVE_EVERY == 0:
                    self.persist()
        except Exception as exc:
            self.burst_error = str(exc)
        finally:
            try:
                self.persist()
            except Exception:
                pass
            self.burst_running = False


def _brain_label(brain_id: str | None) -> str:
    if brain_id == "prey":
        return "Prey"
    if brain_id == "hive":
        return "Hive"
    return (brain_id or "").upper()


def _watch_stats(policy: Policy, rollout: list[tuple[np.ndarray, int, float]], last_obs: np.ndarray) -> dict:
    n = max(len(rollout), 1)
    hist = np.bincount([int(action) for _, action, _ in rollout], minlength=len(ACTION_NAMES))
    return {
        "loss": 0.0,
        "return": float(sum(reward for _, _, reward in rollout)),
        "entropy": policy.entropy(last_obs),
        "steps": len(rollout),
        "actions": [int(v) for v in hist],
        "fire_rate": float(hist[3:].sum() / n),
        "turn": {
            "left": float((hist[0] + hist[3]) / n),
            "straight": float((hist[1] + hist[4]) / n),
            "right": float((hist[2] + hist[5]) / n),
        },
        "hidden_active": float(np.mean([np.mean(policy.forward(obs)["h"] > 0.0) for obs, _, _ in rollout])) if rollout else 0.0,
    }


def _narrate(rows: list[dict], score: Scoreboard, share: str, mode: str) -> str:
    if not rows:
        return "No sorties yet."
    first = rows[: max(1, len(rows) // 5)]
    last = rows[-max(1, len(rows) // 5) :]
    life0 = np.mean([r["steps"] for r in first])
    life1 = np.mean([r["steps"] for r in last])
    label = {"isolated": "private brains", "blackboard": "shared map", "hive": "hive weights + map"}.get(share, share)
    if mode == MODE_HUNT:
        hunts = sum(1 for r in last if r.get("outcome") in ("hunt", "clean_hunt", "prey_crash", "midair") and r.get("winner") != "prey")
        return (
            f"{len(rows)} hunts with {label}. Mean life {life0:.0f} → {life1:.0f} steps. "
            f"Pack scores {score.hunts} ({score.clean_hunts} clean), prey escapes {score.escapes}, "
            f"wipes {score.pack_wipes}. Recent pack finishes {hunts}/{len(last)}."
        )
    return f"{len(rows)} free-for-all sorties with {label}. Mean life {life0:.0f} → {life1:.0f} steps."


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
