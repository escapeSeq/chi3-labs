"""Classroom constitutive physics of a weakly nonlinear analog medium.

A real field E drives a polarization (or voltage, current, displacement)

    P = χ⁽¹⁾ E + χ⁽²⁾ E² + χ⁽³⁾ E³

Linear media copy. Quadratic media multiply the field by itself (even
harmonics, sum and difference frequencies). Cubic media multiply three
fields (odd harmonics, Kerr index, saturation). Superposition is the
dividing line: it holds if and only if χ⁽²⁾ = χ⁽³⁾ = 0.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

SAMPLES = 512
DURATION = 8.0  # time units; frequency 1 sits on FFT bin 8
DRIVE_FREQ = 1.0
SECOND_FREQ = 1.625  # 13/8, still on a bin


@dataclass(frozen=True)
class Tone:
    amplitude: float
    frequency: float
    phase: float = 0.0


@dataclass(frozen=True)
class Peak:
    frequency: float
    amplitude: float
    label: str
    order: str


@dataclass(frozen=True)
class Probe:
    t: np.ndarray
    field: np.ndarray
    response: np.ndarray
    linear: np.ndarray
    e_axis: np.ndarray
    p_axis: np.ndarray
    freqs: np.ndarray
    mag_field: np.ndarray
    mag_response: np.ndarray
    peaks: list[Peak]
    lesson: str
    superposition_error: float
    chi1: float
    chi2: float
    chi3: float


@dataclass(frozen=True)
class KerrSlice:
    x: np.ndarray
    envelope: np.ndarray
    intensity: np.ndarray
    phase: np.ndarray
    carrier: np.ndarray
    linear_carrier: np.ndarray
    n2: float
    lesson: str


@dataclass(frozen=True)
class SaturateTrace:
    t: np.ndarray
    x: np.ndarray
    x_grid: np.ndarray
    potential: np.ndarray
    force: np.ndarray
    wells: tuple[float, ...]
    pump: float
    chi3: float
    runaway: bool
    lesson: str


def time_axis(samples: int = SAMPLES, duration: float = DURATION) -> np.ndarray:
    return np.linspace(0.0, duration, samples, endpoint=False)


def field_from_tones(t: np.ndarray, tones: list[Tone]) -> np.ndarray:
    field = np.zeros_like(t, dtype=float)
    for tone in tones:
        field = field + tone.amplitude * np.sin(
            2.0 * np.pi * tone.frequency * t + tone.phase
        )
    return field


def polarize(
    field: np.ndarray | float, chi1: float, chi2: float, chi3: float
) -> np.ndarray | float:
    return chi1 * field + chi2 * field**2 + chi3 * field**3


def transfer_curve(
    chi1: float, chi2: float, chi3: float, e_max: float = 1.6, n: int = 241
) -> tuple[np.ndarray, np.ndarray]:
    e_axis = np.linspace(-e_max, e_max, n)
    return e_axis, polarize(e_axis, chi1, chi2, chi3)


def sine_harmonics(amplitude: float, chi1: float, chi2: float, chi3: float) -> dict[str, float]:
    """Closed-form Fourier pieces of P(A sin ωt).

    E² = A² (1 − cos 2ωt) / 2
    E³ = A³ (3 sin ωt − sin 3ωt) / 4
    """
    a = float(amplitude)
    return {
        "dc": 0.5 * chi2 * a**2,
        "fund": chi1 * a + 0.75 * chi3 * a**3,
        "second": 0.5 * chi2 * a**2,
        "third": 0.25 * chi3 * a**3,
    }


def superposition_error(
    tones: list[Tone],
    chi1: float,
    chi2: float,
    chi3: float,
    samples: int = SAMPLES,
) -> float:
    """L2 gap between P(E1+E2) and P(E1)+P(E2), normalized by |P(E1+E2)|."""
    if len(tones) < 2:
        return 0.0
    t = time_axis(samples)
    parts = [field_from_tones(t, [tone]) for tone in tones]
    total = np.sum(parts, axis=0)
    p_sum = polarize(total, chi1, chi2, chi3)
    p_parts = np.sum([polarize(part, chi1, chi2, chi3) for part in parts], axis=0)
    denom = float(np.linalg.norm(p_sum) + 1e-12)
    return float(np.linalg.norm(p_sum - p_parts) / denom)


def _rfft_mags(signal: np.ndarray, duration: float) -> tuple[np.ndarray, np.ndarray]:
    windowed = signal * np.hanning(signal.size)
    spec = np.fft.rfft(windowed)
    mag = np.abs(spec) * 2.0 / np.sum(np.hanning(signal.size))
    mag[0] *= 0.5
    freqs = np.fft.rfftfreq(signal.size, d=duration / signal.size)
    return freqs, mag


def _peak_near(freqs: np.ndarray, mag: np.ndarray, target: float, radius: float = 0.12) -> float:
    mask = np.abs(freqs - target) <= radius
    if not np.any(mask):
        return 0.0
    return float(np.max(mag[mask]))


def expected_lines(tones: list[Tone], chi1: float, chi2: float, chi3: float) -> list[tuple[float, str, str]]:
    """(frequency, order, label) that should light up for this drive."""
    lines: list[tuple[float, str, str]] = []
    freqs = [tone.frequency for tone in tones if tone.amplitude > 1e-9]
    if chi1:
        for freq in freqs:
            lines.append((freq, "χ¹", f"drive {freq:g}"))
    if chi2:
        lines.append((0.0, "χ²", "rectification / DC"))
        for freq in freqs:
            lines.append((2.0 * freq, "χ²", f"second harmonic {2 * freq:g}"))
        if len(freqs) >= 2:
            f1, f2 = freqs[0], freqs[1]
            lines.append((f1 + f2, "χ²", "sum frequency"))
            lines.append((abs(f1 - f2), "χ²", "difference frequency"))
    if chi3:
        for freq in freqs:
            lines.append((freq, "χ³", f"Kerr at {freq:g}"))
            lines.append((3.0 * freq, "χ³", f"third harmonic {3 * freq:g}"))
        if len(freqs) >= 2:
            f1, f2 = freqs[0], freqs[1]
            lines.append((2.0 * f1 - f2, "χ³", "four-wave 2ω₁−ω₂"))
            lines.append((2.0 * f2 - f1, "χ³", "four-wave 2ω₂−ω₁"))
            lines.append((2.0 * f1 + f2, "χ³", "four-wave 2ω₁+ω₂"))
            lines.append((2.0 * f2 + f1, "χ³", "four-wave 2ω₂+ω₁"))
    # Drop negative / duplicate frequencies.
    cleaned: list[tuple[float, str, str]] = []
    seen: set[tuple[float, str]] = set()
    for freq, order, label in lines:
        key = (round(abs(freq), 4), order)
        if key in seen:
            continue
        seen.add(key)
        cleaned.append((abs(freq), order, label))
    return cleaned


def _lesson(
    tones: list[Tone],
    chi1: float,
    chi2: float,
    chi3: float,
    error: float,
) -> str:
    n_tones = sum(1 for tone in tones if tone.amplitude > 1e-9)
    nonlinear = abs(chi2) > 1e-9 or abs(chi3) > 1e-9
    if not nonlinear:
        if n_tones <= 1:
            return (
                "Linear medium: P is a scaled copy of E. The spectrum has only the "
                "drive. Superposition still holds — add a second tone and nothing "
                "new appears."
            )
        return (
            "Two drives in a linear medium stay two drives. Superposition holds "
            f"(relative mix error {error:.1e}). Turn on χ² or χ³ to watch the "
            "field multiply itself."
        )
    bits = []
    if abs(chi2) > 1e-9:
        bits.append("χ² squares the field: DC, 2ω, and (with two tones) sum and difference")
    if abs(chi3) > 1e-9:
        bits.append("χ³ cubes the field: 3ω, Kerr at ω, and four-wave mixing")
    mix = " Superposition has already failed." if n_tones >= 2 else ""
    return (
        ("Two-tone analog multiply. " if n_tones >= 2 else "One-tone analog multiply. ")
        + "; ".join(bits)
        + "."
        + mix
    )


def probe(
    tones: list[Tone],
    chi1: float,
    chi2: float,
    chi3: float,
    samples: int = SAMPLES,
    duration: float = DURATION,
) -> Probe:
    t = time_axis(samples, duration)
    field = field_from_tones(t, tones)
    response = polarize(field, chi1, chi2, chi3)
    linear = polarize(field, chi1, 0.0, 0.0)
    e_max = max(1.2, float(np.max(np.abs(field)) * 1.15), 0.4)
    e_axis, p_axis = transfer_curve(chi1, chi2, chi3, e_max=e_max)
    freqs, mag_field = _rfft_mags(field, duration)
    _, mag_response = _rfft_mags(response, duration)
    error = superposition_error(tones, chi1, chi2, chi3, samples=samples)
    peaks: list[Peak] = []
    for freq, order, label in expected_lines(tones, chi1, chi2, chi3):
        amp = _peak_near(freqs, mag_response, freq)
        if freq == 0.0:
            amp = float(mag_response[0])
        peaks.append(Peak(frequency=float(freq), amplitude=amp, label=label, order=order))
    return Probe(
        t=t,
        field=field,
        response=response,
        linear=linear,
        e_axis=e_axis,
        p_axis=p_axis,
        freqs=freqs,
        mag_field=mag_field,
        mag_response=mag_response,
        peaks=peaks,
        lesson=_lesson(tones, chi1, chi2, chi3, error),
        superposition_error=error,
        chi1=chi1,
        chi2=chi2,
        chi3=chi3,
    )


def kerr_slice(
    n2: float = 1.4,
    waist: float = 0.28,
    amplitude: float = 1.0,
    length: float = 1.0,
    carrier_cycles: float = 4.0,
    n: int = 320,
) -> KerrSlice:
    x = np.linspace(-1.0, 1.0, n)
    envelope = amplitude * np.exp(-((x / waist) ** 2))
    intensity = envelope**2
    phase = n2 * intensity * length
    k = 2.0 * np.pi * carrier_cycles
    carrier = envelope * np.cos(k * x + phase)
    linear_carrier = envelope * np.cos(k * x)
    if abs(n2) < 1e-9:
        lesson = (
            "n₂ = 0: the index is a constant. The carrier keeps a uniform "
            "wavelength across the beam. Intensity does not write phase."
        )
    else:
        lesson = (
            "Kerr: n = n₀ + n₂ I. The bright core accumulates extra phase, so "
            "the wavefront bunches in the middle — self-phase modulation, a "
            "free analog multiply of the field by its own intensity."
        )
    return KerrSlice(
        x=x,
        envelope=envelope,
        intensity=intensity,
        phase=phase,
        carrier=carrier,
        linear_carrier=linear_carrier,
        n2=n2,
        lesson=lesson,
    )


def saturate(
    pump: float = 1.55,
    chi3: float = 1.0,
    steps: int = 720,
    dt: float = 0.035,
    x0: float = 0.08,
    damp: float = 1.0,
) -> SaturateTrace:
    """Overdamped Duffing well: ẋ = (p − 1) x − χ³ x³.

    Below threshold (p < 1) the origin is the only well. Above threshold a
    cubic restoring force is the only thing that stops runaway gain — it
    splits the well into ±√((p−1)/χ³), the analog bit.
    """
    t = np.arange(steps, dtype=float) * dt
    x = float(x0)
    xs = np.empty(steps, dtype=float)
    runaway = False
    for i in range(steps):
        dx = damp * ((pump - 1.0) * x - chi3 * x**3)
        x = x + dt * dx
        if abs(x) > 40:
            runaway = True
            x = float(np.clip(x, -40, 40))
        xs[i] = x

    x_grid = np.linspace(-2.4, 2.4, 241)
    potential = -0.5 * (pump - 1.0) * x_grid**2 + 0.25 * chi3 * x_grid**4
    force = (pump - 1.0) * x_grid - chi3 * x_grid**3
    wells: tuple[float, ...]
    if chi3 > 1e-9 and pump > 1.0:
        well = float(np.sqrt((pump - 1.0) / chi3))
        wells = (-well, well)
    elif chi3 > 1e-9:
        wells = (0.0,)
    else:
        wells = ()

    if chi3 <= 1e-9 and pump > 1.0:
        lesson = (
            "Pump above threshold with χ³ = 0: gain with no saturation. The "
            "amplitude runs away. A linear analog computer cannot make a bit."
        )
    elif pump <= 1.0:
        lesson = (
            "Below threshold the only well is x = 0. Amplitudes die. Raise the "
            "pump past 1 and, with a cubic, the origin splits into ± wells."
        )
    else:
        well = wells[1] if len(wells) == 2 else 0.0
        lesson = (
            f"Pump p = {pump:.2f} opened a double well at ±{well:.2f}. The "
            "cubic −χ³ x³ is the same saturation that locks a coherent Ising "
            "machine onto a spin."
        )
    return SaturateTrace(
        t=t,
        x=xs,
        x_grid=x_grid,
        potential=potential,
        force=force,
        wells=wells,
        pump=pump,
        chi3=chi3,
        runaway=runaway,
        lesson=lesson,
    )
