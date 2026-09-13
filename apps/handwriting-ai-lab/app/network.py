"""Tiny MLP used to teach the training loop versus frozen inference."""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

INPUT = 256
HIDDEN = 20
CLASSES = 10


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

    def templates(self, count: int = 8) -> np.ndarray:
        """Hidden-unit weights reshaped to 16×16 — what each neuron looks for."""
        count = min(count, HIDDEN)
        maps = self.W1[:count].reshape(count, 16, 16)
        peak = np.max(np.abs(maps), axis=(1, 2), keepdims=True)
        peak = np.where(peak < 1e-9, 1.0, peak)
        return maps / peak


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
