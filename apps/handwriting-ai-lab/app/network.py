"""Tiny MLP used to teach the training loop versus frozen inference."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
import os
import time

import numpy as np

INPUT = 256
HIDDEN = 20
CLASSES = 10
GRID = 16


def softmax(logits: np.ndarray) -> np.ndarray:
    z = logits - np.max(logits, axis=-1, keepdims=True)
    exp = np.exp(z)
    return exp / np.sum(exp, axis=-1, keepdims=True)


@dataclass
class MLP:
    rng: np.random.Generator
    W1: np.ndarray = field(init=False)
    b1: np.ndarray = field(init=False)
    W2: np.ndarray = field(init=False)
    b2: np.ndarray = field(init=False)

    def __post_init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        # Xavier-ish scale keeps the first guesses from saturating.
        self.W1 = self.rng.normal(0.0, np.sqrt(2.0 / INPUT), size=(HIDDEN, INPUT))
        self.b1 = np.zeros(HIDDEN)
        self.W2 = self.rng.normal(0.0, np.sqrt(2.0 / HIDDEN), size=(CLASSES, HIDDEN))
        self.b2 = np.zeros(CLASSES)

    def save(self, path: Path) -> None:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.parent / f".{path.name}.{os.getpid()}.{time.time_ns()}.tmp"
        with tmp.open("wb") as handle:
            np.savez(
                handle,
                W1=self.W1,
                b1=self.b1,
                W2=self.W2,
                b2=self.b2,
            )
        tmp.replace(path)

    def load(self, path: Path) -> None:
        with np.load(Path(path)) as data:
            self.W1 = np.asarray(data["W1"], dtype=float)
            self.b1 = np.asarray(data["b1"], dtype=float)
            self.W2 = np.asarray(data["W2"], dtype=float)
            self.b2 = np.asarray(data["b2"], dtype=float)
        if self.W1.shape != (HIDDEN, INPUT) or self.W2.shape != (CLASSES, HIDDEN):
            raise ValueError(f"brain file {path} has the wrong weight shapes")
        if self.b1.shape != (HIDDEN,) or self.b2.shape != (CLASSES,):
            raise ValueError(f"brain file {path} has the wrong bias shapes")

    def forward(self, x: np.ndarray) -> dict[str, np.ndarray]:
        flat = np.asarray(x, dtype=float).reshape(-1, INPUT)
        z1 = flat @ self.W1.T + self.b1
        hidden = np.maximum(0.0, z1)
        logits = hidden @ self.W2.T + self.b2
        probs = softmax(logits)
        return {"x": flat, "z1": z1, "hidden": hidden, "logits": logits, "probs": probs}

    def predict(self, x: np.ndarray) -> int:
        return int(np.argmax(self.forward(x)["probs"], axis=-1)[0])

    def loss_acc(self, x: np.ndarray, y: np.ndarray) -> tuple[float, float]:
        out = self.forward(x)
        y = np.asarray(y, dtype=int)
        p = np.clip(out["probs"][np.arange(len(y)), y], 1e-9, 1.0)
        loss = float(-np.mean(np.log(p)))
        acc = float(np.mean(np.argmax(out["probs"], axis=1) == y))
        return loss, acc

    def train_epoch(self, x: np.ndarray, y: np.ndarray, lr: float, batch: int = 16) -> tuple[float, float]:
        n = len(y)
        order = self.rng.permutation(n)
        for start in range(0, n, batch):
            idx = order[start : start + batch]
            self._sgd_step(x[idx], y[idx], lr)
        return self.loss_acc(x, y)

    def _sgd_step(self, x: np.ndarray, y: np.ndarray, lr: float) -> None:
        out = self.forward(x)
        bsz = len(y)
        onehot = np.zeros((bsz, CLASSES))
        onehot[np.arange(bsz), y] = 1.0
        dlogits = (out["probs"] - onehot) / bsz
        dW2 = dlogits.T @ out["hidden"]
        db2 = np.sum(dlogits, axis=0)
        dhidden = dlogits @ self.W2
        dhidden[out["z1"] <= 0] = 0.0
        dW1 = dhidden.T @ out["x"]
        db1 = np.sum(dhidden, axis=0)
        self.W2 -= lr * dW2
        self.b2 -= lr * db2
        self.W1 -= lr * dW1
        self.b1 -= lr * db1

    def templates(self, count: int | None = 8) -> np.ndarray:
        """Hidden-unit weights reshaped to 16×16 — what each neuron looks for."""
        count = HIDDEN if count is None else min(count, HIDDEN)
        maps = self.W1[:count].reshape(count, GRID, GRID)
        peak = np.max(np.abs(maps), axis=(1, 2), keepdims=True)
        peak = np.where(peak < 1e-9, 1.0, peak)
        return maps / peak

    def inspect(self, trained: bool = False) -> dict:
        """Weights plus short English of what each unit and digit is doing."""
        maps = self.templates(count=None)
        hidden = [_explain_hidden(i, maps[i], self.W2[:, i], float(self.b1[i]), trained) for i in range(HIDDEN)]
        digits = [_explain_digit(d, self.W2[d], float(self.b2[d]), hidden, trained) for d in range(CLASSES)]
        w1_rms = float(np.sqrt(np.mean(self.W1 * self.W1)))
        w2_rms = float(np.sqrt(np.mean(self.W2 * self.W2)))
        alive = sum(1 for unit in hidden if unit["energy"] >= 0.08)
        return {
            "architecture": {
                "input": INPUT,
                "grid": GRID,
                "hidden": HIDDEN,
                "classes": CLASSES,
                "activation": "ReLU",
                "story": (
                    "A page is 256 numbers: a 16×16 ink grid, row by row. Each of the 20 hidden "
                    "neurons dots that page with its own template, adds a bias, then ReLU zeros "
                    "any negative score — so a unit is on or silent. The ten digit scores are a "
                    "learned vote over those 20 units, plus a bias each. Softmax turns the scores "
                    "into a guess 0–9. A lesson moves these numbers. Asking the net does not."
                ),
            },
            "legend": {
                "template": (
                    "Cyan pixels raise this neuron when ink sits there. Red pixels lower it — "
                    "ink there is evidence against this feature. After ReLU, a negative score "
                    "becomes silence, and a silent unit cannot vote."
                ),
                "votes": (
                    "Each digit has a weight on every hidden unit. Cyan means that unit’s firing "
                    "raises the digit; red means it suppresses it. The guess is whichever digit "
                    "ends up with the largest score."
                ),
            },
            "hidden": hidden,
            "digits": digits,
            "votes": [[round(float(v), 4) for v in row] for row in self.W2],
            "stats": {
                "w1_rms": w1_rms,
                "w2_rms": w2_rms,
                "hidden_alive": alive,
                "hidden_total": HIDDEN,
            },
            "trained": trained,
        }


def _mass_center(layer: np.ndarray) -> tuple[float, float, float]:
    mass = float(np.sum(layer))
    if mass < 1e-8:
        return 0.5, 0.5, 0.0
    ys, xs = np.indices(layer.shape)
    cx = float((xs * layer).sum() / mass) / max(layer.shape[1] - 1, 1)
    cy = float((ys * layer).sum() / mass) / max(layer.shape[0] - 1, 1)
    return cx, cy, mass


def _where(cx: float, cy: float) -> str:
    horiz = "left" if cx < 0.36 else "right" if cx > 0.64 else "center"
    vert = "top" if cy < 0.36 else "bottom" if cy > 0.64 else "middle"
    if horiz == "center" and vert == "middle":
        return "the middle of the pad"
    if horiz == "center":
        return f"the {vert}"
    if vert == "middle":
        return f"the {horiz} side"
    return f"the {vert}-{horiz}"


def _shape_hint(template: np.ndarray) -> str:
    energy = np.abs(template)
    col = energy.sum(axis=0)
    row = energy.sum(axis=1)
    col_focus = float(col.max() / (col.mean() + 1e-9))
    row_focus = float(row.max() / (row.mean() + 1e-9))
    edge = float(energy[0].sum() + energy[-1].sum() + energy[:, 0].sum() + energy[:, -1].sum())
    interior = float(energy[4:12, 4:12].sum())
    total = float(energy.sum()) + 1e-9
    if col_focus > 1.85 and col_focus > row_focus * 1.08:
        return "a vertical stroke"
    if row_focus > 1.85 and row_focus > col_focus * 1.08:
        return "a horizontal bar"
    if edge / total > 0.55 and interior / total < 0.28:
        return "a loop or rim"
    if interior / total > 0.55:
        return "a blob in the middle"
    return "a local patch of ink"


def _signed_votes(weights: np.ndarray, k: int = 3) -> tuple[list[dict], list[dict]]:
    order = np.argsort(weights)
    against = [{"digit": int(i), "weight": round(float(weights[i]), 3)} for i in order[:k] if weights[i] < -0.05]
    favor = [{"digit": int(i), "weight": round(float(weights[i]), 3)} for i in order[::-1][:k] if weights[i] > 0.05]
    return favor, against


def _explain_hidden(index: int, template: np.ndarray, votes: np.ndarray, bias: float, trained: bool) -> dict:
    pos = np.maximum(template, 0.0)
    neg = np.maximum(-template, 0.0)
    pcx, pcy, pmass = _mass_center(pos)
    ncx, ncy, nmass = _mass_center(neg)
    energy = float(np.sqrt(np.mean(template * template)))
    likes = _where(pcx, pcy) if pmass > 0.08 else None
    avoids = _where(ncx, ncy) if nmass > 0.08 else None
    shape = _shape_hint(template) if energy >= 0.08 else None
    favor, against = _signed_votes(votes)
    if energy < 0.05:
        blurb = f"Hidden unit {index} is nearly silent — its template is tiny, so it barely votes."
    else:
        parts = [f"Hidden unit {index} lights up when ink sits in {likes or 'a weak spread of the pad'}"]
        if shape:
            parts[-1] += f", a bit like {shape}"
        parts[-1] += "."
        if avoids and avoids != likes:
            parts.append(f"Ink in {avoids} counts against it and can ReLU it off.")
        if favor:
            names = ", ".join(str(item["digit"]) for item in favor)
            parts.append(f"When it fires it raises {names}.")
        if against:
            names = ", ".join(str(item["digit"]) for item in against)
            parts.append(f"It suppresses {names}.")
        if abs(bias) > 0.08:
            parts.append(
                "A positive bias means it starts slightly on."
                if bias > 0
                else "A negative bias means it stays off unless the page matches well."
            )
        blurb = " ".join(parts)
    if not trained:
        blurb = "Still untrained, so this pattern is mostly random noise. After a lesson: " + blurb
    return {
        "index": index,
        "template": [[round(float(v), 3) for v in row] for row in template],
        "bias": round(bias, 3),
        "energy": round(energy, 3),
        "likes_ink": likes,
        "likes_empty": avoids,
        "shape": shape,
        "votes_for": favor,
        "votes_against": against,
        "blurb": blurb,
    }


def _explain_digit(digit: int, weights: np.ndarray, bias: float, hidden: list[dict], trained: bool) -> dict:
    order = np.argsort(weights)
    listens = []
    for i in order[::-1][:3]:
        if weights[i] <= 0.05:
            continue
        unit = hidden[int(i)]
        listens.append(
            {
                "unit": int(i),
                "weight": round(float(weights[i]), 3),
                "shape": unit.get("shape"),
                "likes_ink": unit.get("likes_ink"),
            }
        )
    ignores = []
    for i in order[:3]:
        if weights[i] >= -0.05:
            continue
        unit = hidden[int(i)]
        ignores.append(
            {
                "unit": int(i),
                "weight": round(float(weights[i]), 3),
                "shape": unit.get("shape"),
                "likes_ink": unit.get("likes_ink"),
            }
        )
    if not listens and not ignores:
        blurb = f"Digit {digit} has not yet learned a clear vote — the hidden units barely move its score."
    else:
        bits = [f"The score for {digit} is a weighted vote over the 20 hidden units."]
        if listens:
            bits.append(
                "It is raised most by "
                + ", ".join(
                    f"unit {item['unit']}"
                    + (f" ({item['shape']} in {item['likes_ink']})" if item.get("shape") and item.get("likes_ink") else "")
                    for item in listens
                )
                + "."
            )
        if ignores:
            bits.append(
                "It is held down by "
                + ", ".join(f"unit {item['unit']}" for item in ignores)
                + " — templates that look unlike a "
                + str(digit)
                + "."
            )
        if abs(bias) > 0.08:
            bits.append(
                f"Bias {bias:+.2f} means this digit starts slightly ahead even if every hidden unit is off."
                if bias > 0
                else f"Bias {bias:+.2f} means this digit must earn its score from hidden units; it starts behind."
            )
        blurb = " ".join(bits)
    if not trained:
        blurb = "No lesson yet, so this vote is still noise. " + blurb
    return {
        "digit": digit,
        "bias": round(bias, 3),
        "listens_to": listens,
        "ignores": ignores,
        "blurb": blurb,
    }


def train_trace(
    model: MLP,
    x: np.ndarray,
    y: np.ndarray,
    epochs: int = 14,
    lr: float = 0.28,
) -> dict:
    losses, accs, templates = [], [], []
    for _ in range(epochs):
        loss, acc = model.train_epoch(x, y, lr=lr)
        losses.append(loss)
        accs.append(acc)
        templates.append(model.templates().tolist())
    return {
        "epochs": epochs,
        "losses": losses,
        "accs": accs,
        "templates": templates,
        "final_loss": losses[-1],
        "final_acc": accs[-1],
    }
