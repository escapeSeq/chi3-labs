"""High-volume analog field transform through a thin χ³ Kerr slab.

A 2-D optical field is linearly mixed (diffraction / Fourier optics) then
receives a Kerr phase shift exp(i γ |E|²) — a pointwise χ³ nonlinearity that
happens simultaneously at every spatial point.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class FieldResult:
    input_intensity: np.ndarray
    mixed_intensity: np.ndarray
    output_intensity: np.ndarray
    kerr_phase: np.ndarray
    size: int
    gamma: float
    analog_instants: int
    digital_flops: float
    analog_parallel_ops: float


def process_field(
    *,
    size: int = 48,
    gamma: float = 2.4,
    pattern: str = "two_beams",
    seed: int = 3,
) -> FieldResult:
    if size < 16 or size > 96:
        raise ValueError("Field size must be between 16 and 96.")
    field = _input_field(size, pattern, seed)
    ky, kx = np.mgrid[-size // 2 : size // 2, -size // 2 : size // 2]
    kx = np.fft.fftshift(kx) / size
    ky = np.fft.fftshift(ky) / size
    # Quadratic analog propagator: every spatial frequency picks up a phase at once.
    transfer = np.exp(-1j * 2.6 * (kx**2 + ky**2))
    mixed = np.fft.ifft2(np.fft.fft2(field) * transfer)
    phase = gamma * np.abs(mixed) ** 2
    output = mixed * np.exp(1j * phase)

    pixels = float(size * size)
    # 2 FFTs (≈ 5 N log2 N each) + pointwise Kerr multiply.
    digital_flops = 2.0 * 5.0 * pixels * np.log2(pixels) + 8.0 * pixels
    analog_parallel = pixels  # one slab, every pixel at once
    return FieldResult(
        input_intensity=_norm(np.abs(field) ** 2),
        mixed_intensity=_norm(np.abs(mixed) ** 2),
        output_intensity=_norm(np.abs(output) ** 2),
        kerr_phase=_norm(phase),
        size=size,
        gamma=gamma,
        analog_instants=2,  # propagate, then Kerr
        digital_flops=float(digital_flops),
        analog_parallel_ops=analog_parallel,
    )


def _input_field(size: int, pattern: str, seed: int) -> np.ndarray:
    yy, xx = np.mgrid[0:size, 0:size]
    x = (xx - (size - 1) / 2) / (size / 2)
    y = (yy - (size - 1) / 2) / (size / 2)
    rng = np.random.default_rng(seed)
    if pattern == "lattice":
        field = np.exp(-((x * 1.1) ** 2 + (y * 1.1) ** 2) * 2.2) * (
            0.55 + 0.45 * np.cos(7 * np.pi * x) * np.cos(7 * np.pi * y)
        )
    elif pattern == "noise_blob":
        field = np.exp(-(x**2 + y**2) * 1.6)
        field = field + 0.35 * rng.normal(0, 1, size=(size, size))
        field = field.astype(complex)
        field *= np.exp(1j * 0.8 * rng.normal(0, 1, size=(size, size)))
        return field
    else:  # two_beams
        g1 = np.exp(-((x + 0.32) ** 2 + (y + 0.12) ** 2) * 7.5)
        g2 = np.exp(-((x - 0.28) ** 2 + (y - 0.18) ** 2) * 6.2)
        field = g1 + 0.85 * g2 * np.exp(1j * 1.3)
        return field.astype(complex)
    return field.astype(complex)


def _norm(arr: np.ndarray) -> np.ndarray:
    a = np.asarray(arr, dtype=float)
    peak = float(np.max(a)) or 1.0
    return a / peak
