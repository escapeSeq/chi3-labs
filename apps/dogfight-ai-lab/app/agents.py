"""Tiny empty policies that learn a dogfight by REINFORCE (trial and error)."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

if __package__:
    from .physics import LEGACY_OBS, OBS, OBS_NAMES
else:
    from physics import LEGACY_OBS, OBS, OBS_NAMES

HIDDEN = 24
ACTIONS = 6
ACTION_NAMES = (
    "left",
    "straight",
    "right",
    "left+fire",
    "straight+fire",
    "right+fire",
)
W1_INIT_RMS = float(np.sqrt(2.0 / OBS))
W2_INIT_RMS = 0.15
WEIGHT_CLIP = 8.0


def softmax(logits: np.ndarray) -> np.ndarray:
    z = np.nan_to_num(np.asarray(logits, dtype=float), nan=0.0, posinf=20.0, neginf=-20.0)
    z = z - np.max(z, axis=-1, keepdims=True)
    z = np.clip(z, -20.0, 20.0)
    e = np.exp(z)
    denom = np.sum(e, axis=-1, keepdims=True)
    fallback = np.full_like(e, 1.0 / e.shape[-1])
    probs = np.divide(e, denom, out=fallback.copy(), where=denom > 0)
    probs = np.nan_to_num(probs, nan=0.0, posinf=0.0, neginf=0.0)
    total = np.sum(probs, axis=-1, keepdims=True)
    return np.divide(probs, total, out=fallback, where=total > 0)


@dataclass
class Policy:
    """Softmax policy. Fresh Gaussian weights = no skill, only noise."""

    rng: np.random.Generator
    name: str
    W1: np.ndarray = field(init=False)
    b1: np.ndarray = field(init=False)
    W2: np.ndarray = field(init=False)
    b2: np.ndarray = field(init=False)
    baseline: float = 0.0
    updates: int = 0

    def __post_init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self.W1 = self.rng.normal(0.0, W1_INIT_RMS, size=(HIDDEN, OBS))
        self.b1 = np.zeros(HIDDEN)
        self.W2 = self.rng.normal(0.0, W2_INIT_RMS, size=(ACTIONS, HIDDEN))
        self.b2 = np.zeros(ACTIONS)
        self.baseline = 0.0
        self.updates = 0

    def copy_from(self, other: Policy) -> None:
        self.W1 = np.array(other.W1, dtype=float, copy=True)
        self.b1 = np.array(other.b1, dtype=float, copy=True)
        self.W2 = np.array(other.W2, dtype=float, copy=True)
        self.b2 = np.array(other.b2, dtype=float, copy=True)
        self.baseline = float(other.baseline)
        self.updates = int(other.updates)

    def save(self, path: Path) -> None:
        path = Path(path)
        tmp = path.parent / f".{path.name}.tmp"
        with tmp.open("wb") as handle:
            np.savez(
                handle,
                W1=self.W1,
                b1=self.b1,
                W2=self.W2,
                b2=self.b2,
                baseline=np.asarray([self.baseline], dtype=float),
                updates=np.asarray([self.updates], dtype=int),
            )
        tmp.replace(path)

    def load(self, path: Path) -> None:
        with np.load(Path(path)) as data:
            w1 = np.asarray(data["W1"], dtype=float)
            b1 = np.asarray(data["b1"], dtype=float)
            w2 = np.asarray(data["W2"], dtype=float)
            b2 = np.asarray(data["b2"], dtype=float)
            baseline = np.asarray(data["baseline"], dtype=float).reshape(-1)
            updates = int(np.asarray(data["updates"]).reshape(-1)[0]) if "updates" in data.files else 0
        w1 = _pad_w1(w1)
        if w1.shape != (HIDDEN, OBS) or b1.shape != (HIDDEN,) or w2.shape != (ACTIONS, HIDDEN) or b2.shape != (ACTIONS,):
            raise ValueError(f"brain file {path} has the wrong weight shapes")
        self.W1, self.b1, self.W2, self.b2 = w1, b1, w2, b2
        self.baseline = float(baseline[0]) if baseline.size else 0.0
        self.updates = max(0, updates)

    def _stabilize(self) -> None:
        for name in ("W1", "b1", "W2", "b2"):
            raw = np.nan_to_num(getattr(self, name), nan=0.0, posinf=WEIGHT_CLIP, neginf=-WEIGHT_CLIP)
            setattr(self, name, np.clip(raw, -WEIGHT_CLIP, WEIGHT_CLIP))
        if not np.isfinite(self.baseline):
            self.baseline = 0.0

    def forward(self, obs: np.ndarray) -> dict[str, np.ndarray]:
        x = np.asarray(obs, dtype=float).reshape(OBS)
        h = np.maximum(0.0, self.W1 @ x + self.b1)
        logits = self.W2 @ h + self.b2
        probs = softmax(logits)
        return {"x": x, "h": h, "logits": logits, "probs": probs}

    def act(self, obs: np.ndarray) -> tuple[int, float, dict[str, np.ndarray]]:
        out = self.forward(obs)
        probs = np.asarray(out["probs"], dtype=float).reshape(ACTIONS)
        if (not np.all(np.isfinite(probs))) or float(probs.sum()) <= 0:
            probs = np.full(ACTIONS, 1.0 / ACTIONS)
        else:
            probs = probs / float(probs.sum())
        out["probs"] = probs
        action = int(self.rng.choice(ACTIONS, p=probs))
        logp = float(np.log(np.clip(probs[action], 1e-8, 1.0)))
        return action, logp, out

    def entropy(self, obs: np.ndarray) -> float:
        p = np.clip(self.forward(obs)["probs"], 1e-8, 1.0)
        return float(-np.sum(p * np.log(p)))

    def inspect(self) -> dict:
        """Summarize weights and how the policy answers a few stock situations."""
        w1 = self.W1.ravel()
        w2 = self.W2.ravel()
        probes = _probe_obs()
        packs = [self.forward(obs) for obs in probes]
        probs = np.stack([pack["probs"] for pack in packs])
        hidden = np.stack([pack["h"] for pack in packs])
        mean_p = probs.mean(axis=0)
        ent = float(np.mean([-np.sum(np.clip(p, 1e-8, 1.0) * np.log(np.clip(p, 1e-8, 1.0))) for p in probs]))
        w1_rms = float(np.sqrt(np.mean(w1 * w1)))
        w2_rms = float(np.sqrt(np.mean(w2 * w2)))
        return {
            "name": self.name,
            "updates": int(self.updates),
            "shape": {"obs": OBS, "hidden": HIDDEN, "actions": ACTIONS},
            "weights": {
                "count": int(w1.size + w2.size + self.b1.size + self.b2.size),
                "l2": float(np.sqrt(np.sum(w1 * w1) + np.sum(w2 * w2) + np.sum(self.b1 * self.b1) + np.sum(self.b2 * self.b2))),
                "w1_rms": w1_rms,
                "w2_rms": w2_rms,
                "w1_max": float(np.max(np.abs(w1))),
                "w2_max": float(np.max(np.abs(w2))),
                "w1_growth": w1_rms / W1_INIT_RMS,
                "w2_growth": w2_rms / W2_INIT_RMS,
            },
            "baseline": float(self.baseline),
            "bias": [float(v) for v in self.b2],
            "obs_names": list(OBS_NAMES),
            "w1": [[float(v) for v in row] for row in self.W1],
            "w2": [[float(v) for v in row] for row in self.W2],
            "hidden_mean": [float(v) for v in hidden.mean(axis=0)],
            "probe": {
                "mean_probs": [float(v) for v in mean_p],
                "max_prob": float(np.max(probs)),
                "entropy": ent,
                "hidden_active": float(np.mean(hidden > 0.0)),
                "hidden_dead": int(np.sum(np.all(hidden <= 0.0, axis=0))),
            },
            "favorite": ACTION_NAMES[int(np.argmax(mean_p))],
        }

    def learn(
        self,
        rollout: list[tuple[np.ndarray, int, float]],
        gamma: float = 0.97,
        lr: float = 0.012,
    ) -> dict:
        """REINFORCE: nudge log-probability of actions that led to return."""
        if not rollout:
            return {"loss": 0.0, "return": 0.0, "entropy": 0.0}
        rewards = np.array([r for _, _, r in rollout], dtype=float)
        returns = np.zeros_like(rewards)
        acc = 0.0
        for i in range(len(rewards) - 1, -1, -1):
            acc = rewards[i] + gamma * acc
            returns[i] = acc
        total = float(returns[0])
        self.baseline = 0.9 * self.baseline + 0.1 * total
        adv = returns - self.baseline
        scale = float(np.std(adv)) + 1e-6
        adv = adv / scale

        dW1 = np.zeros_like(self.W1)
        db1 = np.zeros_like(self.b1)
        dW2 = np.zeros_like(self.W2)
        db2 = np.zeros_like(self.b2)
        loss = 0.0
        ent = 0.0
        hidden_on = 0.0
        for (obs, action, _), a in zip(rollout, adv):
            out = self.forward(obs)
            p = out["probs"]
            hidden_on += float(np.mean(out["h"] > 0.0))
            ent += float(-np.sum(p * np.log(np.clip(p, 1e-8, 1.0))))
            loss += float(-np.log(np.clip(p[action], 1e-8, 1.0)) * a)
            one = np.zeros(ACTIONS)
            one[action] = 1.0
            # dL/dlogits for -log π(a) * A  is  (π - one_hot) * A
            dlogits = (p - one) * a
            dW2 += np.outer(dlogits, out["h"])
            db2 += dlogits
            dh = self.W2.T @ dlogits
            dh[out["h"] <= 0] = 0.0
            dW1 += np.outer(dh, out["x"])
            db1 += dh
        n = max(len(rollout), 1)
        self.W1 -= lr * dW1 / n
        self.b1 -= lr * db1 / n
        self.W2 -= lr * dW2 / n
        self.b2 -= lr * db2 / n
        self._stabilize()
        self.updates += 1
        hist = np.bincount([int(action) for _, action, _ in rollout], minlength=ACTIONS)
        fire = float(hist[3:].sum() / n)
        return {
            "loss": loss / n,
            "return": total,
            "entropy": ent / n,
            "actions": [int(v) for v in hist],
            "fire_rate": fire,
            "turn": {
                "left": float((hist[0] + hist[3]) / n),
                "straight": float((hist[1] + hist[4]) / n),
                "right": float((hist[2] + hist[5]) / n),
            },
            "hidden_active": hidden_on / n,
        }


def _pad_w1(w1: np.ndarray) -> np.ndarray:
    if w1.shape == (HIDDEN, OBS):
        return w1
    if w1.ndim == 2 and w1.shape[0] == HIDDEN and LEGACY_OBS <= w1.shape[1] < OBS:
        padded = np.zeros((HIDDEN, OBS), dtype=float)
        padded[:, : w1.shape[1]] = w1
        return padded
    return w1


def _pad_obs(core: list[float] | np.ndarray, extras: dict[int, float] | None = None) -> np.ndarray:
    vec = np.zeros(OBS, dtype=float)
    core = np.asarray(core, dtype=float).reshape(-1)
    vec[: core.size] = core
    if extras:
        for index, value in extras.items():
            vec[index] = float(value)
    return vec


def _probe_obs() -> list[np.ndarray]:
    """A few stock dogfight views so action preferences are comparable over time."""
    return [
        _pad_obs([0.35, 0.00, 0.25, 0.00, 0.00, 0.00, 1.00, 0.00, 0.50, 0.00], {10: 0.45, 11: 0.55, 12: 0.50, 13: 0.50}),
        _pad_obs([0.00, 0.35, 0.25, 0.20, 0.00, 0.00, 1.00, 0.00, 0.50, 0.00], {10: 0.40, 11: 0.60, 12: 0.50, 13: 0.50, 14: 1.0, 15: -0.2, 17: 0.3}),
        _pad_obs([-0.35, 0.00, 0.25, 1.00, 0.00, 0.00, 1.00, 0.00, 0.50, 0.00], {10: 0.50, 11: 0.50, 12: 0.50, 13: 0.50}),
        _pad_obs([0.20, 0.00, 0.15, 0.00, 0.00, 0.00, 1.00, 0.00, 0.08, 0.00], {10: 0.12, 11: 0.88, 12: 0.50, 13: 0.50}),
        _pad_obs([0.15, 0.02, 0.12, 0.00, 0.00, 0.00, 1.00, 0.00, 0.50, 0.00], {10: 0.50, 11: 0.50, 12: 0.50, 13: 0.50, 14: 1.0, 15: 0.18, 17: 0.2}),
        _pad_obs([0.15, 0.02, 0.12, 0.00, 0.00, 0.00, 1.00, 0.00, 0.50, 1.00], {10: 0.50, 11: 0.50, 12: 0.50, 13: 0.50}),
    ]
