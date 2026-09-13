"""Combinatorial instances that analog Ising machines relax in parallel."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import numpy as np

GraphKind = Literal["planted_cut", "erdos_renyi", "ring_chords", "frustrated_grid"]


@dataclass(frozen=True)
class MaxCutInstance:
    """Undirected weighted Max-Cut instance plus a layout-friendly adjacency."""

    kind: GraphKind
    n: int
    seed: int
    weights: np.ndarray  # symmetric, zero diagonal, nonnegative
    planted_spins: np.ndarray | None = None

    @property
    def couplings(self) -> np.ndarray:
        """CIM / Hopfield coupling matrix J = −W so analog descent maximizes the cut."""
        return -self.weights

    def edge_list(self) -> list[tuple[int, int, float]]:
        i, j = np.triu_indices(self.n, k=1)
        w = self.weights[i, j]
        mask = w > 0
        return list(zip(i[mask].tolist(), j[mask].tolist(), w[mask].tolist(), strict=True))

    def cut_value(self, spins: np.ndarray) -> float:
        s = np.asarray(spins, dtype=float)
        return 0.25 * float(s @ self.weights @ s * -1.0 + np.sum(self.weights))

    def ising_energy(self, spins: np.ndarray) -> float:
        s = np.asarray(spins, dtype=float)
        return 0.5 * float(s @ self.weights @ s)

    def max_possible_cut(self) -> float:
        # Every edge cut: cut = Σ_{i<j} w_ij.
        return float(np.sum(np.triu(self.weights, 1)))


def build_instance(kind: GraphKind, n: int, seed: int = 1) -> MaxCutInstance:
    if n < 4:
        raise ValueError("Need at least 4 spins for a readable demonstration.")
    if n > 160:
        raise ValueError("Keep N ≤ 160 so the browser animation stays fluid.")
    rng = np.random.default_rng(seed)
    if kind == "planted_cut":
        return _planted_cut(n, rng, seed)
    if kind == "erdos_renyi":
        return _erdos_renyi(n, rng, seed)
    if kind == "ring_chords":
        return _ring_chords(n, rng, seed)
    if kind == "frustrated_grid":
        return _frustrated_grid(n, rng, seed)
    raise ValueError(f"Unknown graph kind: {kind}")


def _planted_cut(n: int, rng: np.random.Generator, seed: int) -> MaxCutInstance:
    """Two communities with dense crossing edges — a known high-quality cut exists."""
    left = n // 2
    spins = np.ones(n, dtype=float)
    spins[left:] = -1.0
    weights = np.zeros((n, n), dtype=float)
    for i in range(n):
        for j in range(i + 1, n):
            same = spins[i] == spins[j]
            if same and rng.random() < 0.12:
                w = rng.uniform(0.2, 0.6)
            elif (not same) and rng.random() < 0.55:
                w = rng.uniform(0.7, 1.2)
            else:
                continue
            weights[i, j] = weights[j, i] = w
    return MaxCutInstance("planted_cut", n, seed, weights, spins)


def _erdos_renyi(n: int, rng: np.random.Generator, seed: int) -> MaxCutInstance:
    p = min(0.28, 4.2 / n + 0.08)
    mask = rng.random((n, n)) < p
    mask = np.triu(mask, 1)
    weights = np.zeros((n, n), dtype=float)
    weights[mask] = rng.uniform(0.35, 1.15, size=int(mask.sum()))
    weights = weights + weights.T
    return MaxCutInstance("erdos_renyi", n, seed, weights)


def _ring_chords(n: int, rng: np.random.Generator, seed: int) -> MaxCutInstance:
    weights = np.zeros((n, n), dtype=float)
    for i in range(n):
        j = (i + 1) % n
        weights[i, j] = weights[j, i] = 1.0
        k = (i + 2) % n
        weights[i, k] = weights[k, i] = 0.45
    extra = max(n // 3, 4)
    for _ in range(extra):
        i, j = rng.integers(0, n, size=2)
        if i == j:
            continue
        weights[i, j] = weights[j, i] = float(rng.uniform(0.5, 1.0))
    np.fill_diagonal(weights, 0.0)
    return MaxCutInstance("ring_chords", n, seed, weights)


def _frustrated_grid(n: int, rng: np.random.Generator, seed: int) -> MaxCutInstance:
    cols = int(np.ceil(np.sqrt(n)))
    rows = int(np.ceil(n / cols))
    weights = np.zeros((n, n), dtype=float)
    for idx in range(n):
        r, c = divmod(idx, cols)
        neighbors = []
        if c + 1 < cols and idx + 1 < n:
            neighbors.append(idx + 1)
        if r + 1 < rows and idx + cols < n:
            neighbors.append(idx + cols)
        for j in neighbors:
            weights[idx, j] = weights[j, idx] = float(rng.uniform(0.6, 1.2))
    return MaxCutInstance("frustrated_grid", n, seed, weights)
