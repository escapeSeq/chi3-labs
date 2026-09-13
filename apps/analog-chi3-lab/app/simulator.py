"""Analog CIM dynamics and sequential digital search for the same Max-Cut instance.

The analog model is a pedagogical Coherent Ising Machine (CIM): each spin is a
continuous oscillator amplitude x_i. Third-order (χ³) saturation −x_i³ keeps
amplitudes bounded, while analog coupling Jx evaluates every pairwise term at
once. Digital baselines update one spin per step.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .problems import MaxCutInstance


@dataclass(frozen=True)
class AnalogTrace:
    amplitudes: np.ndarray  # (steps, n)
    energies: np.ndarray
    cuts: np.ndarray
    pump: np.ndarray
    dt: float
    coupling: float
    noise: float


@dataclass(frozen=True)
class DigitalTrace:
    method: str
    spins_over_time: np.ndarray  # (steps, n) after each sequential update
    energies: np.ndarray
    cuts: np.ndarray
    updates: int
    configs_examined: int
    exhausted: bool


def analog_cim(
    instance: MaxCutInstance,
    *,
    steps: int = 420,
    dt: float = 0.045,
    pump_start: float = -0.55,
    pump_end: float = 1.35,
    coupling: float = 0.22,
    noise: float = 0.035,
    seed: int = 0,
) -> AnalogTrace:
    """Integrate ẋ = (p−1)x − x³ + ξ Jx + η.

    The cubic term is the χ³ Kerr / gain-saturation nonlinearity. Pump p(t) is
    ramped so the analog fabric first explores, then saturates into ± amplitudes
    that read out as Ising spins.
    """
    if steps < 20:
        raise ValueError("Need enough analog samples to see relaxation.")
    J = instance.couplings
    n = instance.n
    rng = np.random.default_rng(seed)
    x = rng.normal(0.0, 0.05, size=n)
    amplitudes = np.zeros((steps, n), dtype=float)
    energies = np.zeros(steps, dtype=float)
    cuts = np.zeros(steps, dtype=float)
    pump = np.linspace(pump_start, pump_end, steps)
    for t in range(steps):
        p = pump[t]
        # All N amplitudes and all N² couplings advance in one analog instant.
        dx = (p - 1.0) * x - x**3 + coupling * (J @ x)
        if noise:
            dx = dx + noise * rng.normal(0.0, 1.0, size=n)
        x = x + dt * dx
        amplitudes[t] = x
        spins = _readout(x)
        energies[t] = instance.ising_energy(spins)
        cuts[t] = instance.cut_value(spins)
    return AnalogTrace(amplitudes, energies, cuts, pump, dt, coupling, noise)


def digital_search(
    instance: MaxCutInstance,
    *,
    method: str = "metropolis",
    steps: int | None = None,
    seed: int = 0,
    temperature: float = 0.35,
) -> DigitalTrace:
    if method == "brute":
        return _brute_force(instance)
    if method == "greedy":
        return _sequential_local(instance, steps=steps, seed=seed, stochastic=False)
    if method == "metropolis":
        return _sequential_local(
            instance,
            steps=steps,
            seed=seed,
            stochastic=True,
            temperature=temperature,
        )
    raise ValueError(f"Unknown digital method: {method}")


def _readout(x: np.ndarray) -> np.ndarray:
    spins = np.sign(x)
    spins[spins == 0] = 1.0
    return spins


def _brute_force(instance: MaxCutInstance) -> DigitalTrace:
    n = instance.n
    if n > 18:
        raise ValueError("Brute force is only offered up to 18 spins.")
    best_energy = np.inf
    best_spins = np.ones(n)
    energies = []
    cuts = []
    snapshots = []
    examined = 0
    # Reflect bits 0..n-2; last spin is fixed +1 to remove global flip symmetry.
    limit = 1 << (n - 1)
    for code in range(limit):
        spins = np.ones(n, dtype=float)
        for bit in range(n - 1):
            if code & (1 << bit):
                spins[bit] = -1.0
        energy = instance.ising_energy(spins)
        examined += 1
        if energy < best_energy:
            best_energy = energy
            best_spins = spins.copy()
        if code % max(limit // 80, 1) == 0 or code == limit - 1:
            snapshots.append(best_spins.copy())
            energies.append(best_energy)
            cuts.append(instance.cut_value(best_spins))
    return DigitalTrace(
        method="brute",
        spins_over_time=np.asarray(snapshots),
        energies=np.asarray(energies),
        cuts=np.asarray(cuts),
        updates=examined * n,
        configs_examined=examined,
        exhausted=True,
    )


def _sequential_local(
    instance: MaxCutInstance,
    *,
    steps: int | None,
    seed: int,
    stochastic: bool,
    temperature: float = 0.35,
) -> DigitalTrace:
    n = instance.n
    rng = np.random.default_rng(seed)
    spins = rng.choice(np.array([-1.0, 1.0]), size=n)
    steps = steps if steps is not None else n * 18
    path = np.zeros((steps, n), dtype=float)
    energies = np.zeros(steps, dtype=float)
    cuts = np.zeros(steps, dtype=float)
    energy = instance.ising_energy(spins)
    for t in range(steps):
        i = int(t % n)  # one oscillator / one bit per digital tick
        # ΔE for flipping spin i: 2 s_i (W s)_i  (diagonal of W is 0)
        field = float(instance.weights[i] @ spins)
        # H = ½ sᵀ W s  →  flipping i changes energy by −2 s_i (W s)_i
        delta = -2.0 * spins[i] * field
        accept = delta <= 0.0
        if stochastic and delta > 0.0:
            cooled = temperature * (1.0 - t / max(steps, 1)) + 0.03
            accept = rng.random() < np.exp(-delta / cooled)
        if accept:
            spins[i] *= -1.0
            energy += delta
        path[t] = spins
        energies[t] = energy
        cuts[t] = instance.cut_value(spins)
    return DigitalTrace(
        method="metropolis" if stochastic else "greedy",
        spins_over_time=path,
        energies=energies,
        cuts=cuts,
        updates=steps,
        configs_examined=steps,
        exhausted=False,
    )


def analog_volume(n: int, steps: int) -> dict[str, float]:
    """How much arithmetic the analog fabric performs in parallel each instant."""
    pairwise = float(n * n)
    local_nonlinearity = float(3 * n)  # gain, cubic, Euler update
    per_step = pairwise + local_nonlinearity
    return {
        "units": float(n),
        "pairwise_couplings": pairwise,
        "local_nonlinear_ops": local_nonlinearity,
        "parallel_ops_per_instant": per_step,
        "analog_instants": float(steps),
        "equivalent_serial_ops": per_step * steps,
        "configuration_space": float(2**n) if n <= 62 else float("inf"),
    }
