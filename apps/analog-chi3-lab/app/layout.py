"""Simple force layout so the graph is readable without a JS physics library."""

from __future__ import annotations

import numpy as np

from .problems import MaxCutInstance


def layout_positions(instance: MaxCutInstance, seed: int | None = None) -> np.ndarray:
    n = instance.n
    rng = np.random.default_rng(instance.seed if seed is None else seed)
    if instance.kind == "frustrated_grid":
        cols = int(np.ceil(np.sqrt(n)))
        pts = np.zeros((n, 2), dtype=float)
        for i in range(n):
            r, c = divmod(i, cols)
            pts[i] = (c, r)
        return _normalize(pts)

    if instance.kind == "ring_chords":
        theta = np.linspace(0, 2 * np.pi, n, endpoint=False)
        return np.stack((np.cos(theta), np.sin(theta)), axis=1)

    if instance.kind == "planted_cut" and instance.planted_spins is not None:
        pts = rng.normal(0, 0.18, size=(n, 2))
        pts[instance.planted_spins > 0, 0] -= 0.85
        pts[instance.planted_spins < 0, 0] += 0.85
        return _normalize(_relax(pts, instance.weights, steps=80))

    theta = rng.uniform(0, 2 * np.pi, n)
    radius = np.sqrt(rng.uniform(0.15, 1.0, n))
    pts = np.stack((radius * np.cos(theta), radius * np.sin(theta)), axis=1)
    return _normalize(_relax(pts, instance.weights, steps=90))


def _relax(pts: np.ndarray, weights: np.ndarray, steps: int) -> np.ndarray:
    pos = pts.astype(float).copy()
    n = len(pos)
    for _ in range(steps):
        delta = pos[:, None, :] - pos[None, :, :]
        dist2 = np.sum(delta * delta, axis=2) + 1e-4
        dist = np.sqrt(dist2)
        repel = delta / dist2[:, :, None]
        np.fill_diagonal(dist, 1.0)
        spring = weights[:, :, None] * delta / dist[:, :, None]
        force = 0.35 * np.sum(repel, axis=1) - 0.12 * np.sum(spring, axis=1)
        pos += 0.04 * force
        pos -= pos.mean(axis=0)
    return pos


def _normalize(pts: np.ndarray) -> np.ndarray:
    pos = pts.astype(float).copy()
    pos -= pos.mean(axis=0)
    span = np.max(np.abs(pos)) or 1.0
    return pos / span
