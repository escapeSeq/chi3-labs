"""Stroke-drawn digits so the classroom has examples before anyone writes."""

from __future__ import annotations

import numpy as np

GRID = 16
PAINT = 48


def generate_digit(label: int, rng: np.random.Generator | None = None) -> np.ndarray:
    """Return a 16×16 ink grid in [0, 1] for a digit 0–9."""
    if label < 0 or label > 9:
        raise ValueError("label must be a digit 0–9")
    rng = rng or np.random.default_rng()
    canvas = np.zeros((PAINT, PAINT), dtype=float)
    _draw_glyph(canvas, label, rng)
    canvas = _jitter(canvas, rng)
    return fit_ink(_down(canvas))


def fit_ink(grid: np.ndarray) -> np.ndarray:
    """Center and scale ink so a huge pad-filling 7 matches a classroom 7."""
    g = np.asarray(grid, dtype=float)
    ink = g > 0.12
    if not ink.any():
        return np.clip(g, 0.0, 1.0)
    ys, xs = np.where(ink)
    crop = g[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1]
    h, w = crop.shape
    side = max(h, w, 1)
    square = np.zeros((side, side), dtype=float)
    square[(side - h) // 2 : (side - h) // 2 + h, (side - w) // 2 : (side - w) // 2 + w] = crop
    inner = 12
    yy = np.linspace(0, side - 1, inner).astype(int)
    xx = np.linspace(0, side - 1, inner).astype(int)
    small = square[yy][:, xx]
    out = np.zeros((GRID, GRID), dtype=float)
    out[2 : 2 + inner, 2 : 2 + inner] = small
    peak = float(out.max()) or 1.0
    return np.clip(out / peak, 0.0, 1.0)


def classroom(per_class: int = 10, seed: int = 3) -> tuple[np.ndarray, np.ndarray]:
    rng = np.random.default_rng(seed)
    xs, ys = [], []
    for label in range(10):
        for _ in range(per_class):
            xs.append(generate_digit(label, rng))
            ys.append(label)
    return np.stack(xs), np.asarray(ys, dtype=int)


def _down(canvas: np.ndarray) -> np.ndarray:
    factor = PAINT // GRID
    block = canvas.reshape(GRID, factor, GRID, factor)
    out = block.mean(axis=(1, 3))
    peak = float(out.max()) or 1.0
    return np.clip(out / peak, 0.0, 1.0)


def _stamp(canvas: np.ndarray, x: float, y: float, radius: float) -> None:
    h, w = canvas.shape
    cx, cy = int(round(x)), int(round(y))
    r = int(np.ceil(radius)) + 1
    for j in range(cy - r, cy + r + 1):
        for i in range(cx - r, cx + r + 1):
            if 0 <= i < w and 0 <= j < h:
                d = np.hypot(i - x, j - y)
                if d <= radius:
                    canvas[j, i] = max(canvas[j, i], 1.0)
                elif d <= radius + 1.1:
                    canvas[j, i] = max(canvas[j, i], 1.0 - (d - radius) / 1.1)


def _line(canvas: np.ndarray, x0: float, y0: float, x1: float, y1: float, radius: float) -> None:
    steps = max(int(np.hypot(x1 - x0, y1 - y0) * 2), 1)
    for t in np.linspace(0.0, 1.0, steps):
        _stamp(canvas, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, radius)


def _curve(
    canvas: np.ndarray,
    pts: list[tuple[float, float]],
    radius: float,
) -> None:
    for a, b in zip(pts, pts[1:]):
        _line(canvas, a[0], a[1], b[0], b[1], radius)


def _ellipse(
    canvas: np.ndarray,
    cx: float,
    cy: float,
    rx: float,
    ry: float,
    radius: float,
    t0: float = 0.0,
    t1: float = 1.0,
) -> None:
    steps = max(int(2 * np.pi * max(rx, ry)), 16)
    ts = np.linspace(t0 * 2 * np.pi, t1 * 2 * np.pi, steps)
    pts = [(cx + rx * np.cos(t), cy + ry * np.sin(t)) for t in ts]
    _curve(canvas, pts, radius)


def _uv(u: float, v: float) -> tuple[float, float]:
    return u * (PAINT - 1), v * (PAINT - 1)


def _draw_glyph(canvas: np.ndarray, label: int, rng: np.random.Generator) -> None:
    r = float(rng.uniform(2.1, 2.7))
    jitter = lambda x, y: _uv(x + rng.normal(0, 0.018), y + rng.normal(0, 0.018))

    if label == 0:
        cx, cy = jitter(0.50, 0.50)
        _ellipse(canvas, cx, cy, 0.26 * PAINT, 0.36 * PAINT, r)
    elif label == 1:
        _curve(canvas, [jitter(0.36, 0.22), jitter(0.54, 0.10), jitter(0.54, 0.90)], r)
        _line(canvas, *jitter(0.30, 0.90), *jitter(0.76, 0.90), r * 0.85)
    elif label == 2:
        _curve(
            canvas,
            [
                jitter(0.22, 0.28),
                jitter(0.50, 0.10),
                jitter(0.78, 0.26),
                jitter(0.30, 0.70),
                jitter(0.22, 0.88),
                jitter(0.80, 0.88),
            ],
            r,
        )
    elif label == 3:
        _curve(
            canvas,
            [jitter(0.24, 0.18), jitter(0.72, 0.18), jitter(0.40, 0.48), jitter(0.76, 0.62), jitter(0.28, 0.88)],
            r,
        )
        _line(canvas, *jitter(0.24, 0.18), *jitter(0.30, 0.30), r * 0.7)
    elif label == 4:
        _line(canvas, *jitter(0.28, 0.14), *jitter(0.22, 0.58), r)
        _line(canvas, *jitter(0.22, 0.58), *jitter(0.82, 0.58), r)
        _line(canvas, *jitter(0.64, 0.12), *jitter(0.64, 0.90), r)
    elif label == 5:
        _curve(
            canvas,
            [
                jitter(0.76, 0.12),
                jitter(0.28, 0.12),
                jitter(0.26, 0.42),
                jitter(0.70, 0.48),
                jitter(0.74, 0.78),
                jitter(0.28, 0.90),
            ],
            r,
        )
    elif label == 6:
        _curve(canvas, [jitter(0.70, 0.16), jitter(0.30, 0.22), jitter(0.26, 0.58)], r)
        _ellipse(canvas, *jitter(0.48, 0.66), 0.24 * PAINT, 0.22 * PAINT, r)
    elif label == 7:
        _line(canvas, *jitter(0.20, 0.14), *jitter(0.82, 0.14), r)
        _line(canvas, *jitter(0.82, 0.14), *jitter(0.38, 0.90), r)
    elif label == 8:
        _ellipse(canvas, *jitter(0.50, 0.30), 0.22 * PAINT, 0.18 * PAINT, r)
        _ellipse(canvas, *jitter(0.50, 0.70), 0.24 * PAINT, 0.20 * PAINT, r)
    else:  # 9
        _ellipse(canvas, *jitter(0.50, 0.34), 0.22 * PAINT, 0.20 * PAINT, r)
        _curve(canvas, [jitter(0.70, 0.40), jitter(0.66, 0.88), jitter(0.36, 0.88)], r)


def _jitter(canvas: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """Small rotate/shift so the starter classroom is not a single stencil."""
    angle = float(rng.uniform(-0.18, 0.18))
    c, s = np.cos(angle), np.sin(angle)
    yy, xx = np.mgrid[0:PAINT, 0:PAINT]
    xx = xx - (PAINT - 1) / 2
    yy = yy - (PAINT - 1) / 2
    xr = c * xx + s * yy + (PAINT - 1) / 2 + rng.uniform(-1.4, 1.4)
    yr = -s * xx + c * yy + (PAINT - 1) / 2 + rng.uniform(-1.4, 1.4)
    x0 = np.clip(xr.astype(int), 0, PAINT - 1)
    y0 = np.clip(yr.astype(int), 0, PAINT - 1)
    return canvas[y0, x0]
