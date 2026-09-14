"""HTTP API and static educational UI for the χ³ analog lab."""

from __future__ import annotations

from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import field_processor, layout, problems, simulator

STATIC = Path(__file__).parent / "static"

app = FastAPI(
    title="χ³ Analog Lab",
    description="Educational simulation of analog nonlinear (χ³) computing.",
    version="0.1.0",
)


class InstanceRequest(BaseModel):
    kind: problems.GraphKind = "planted_cut"
    n: int = Field(default=24, ge=4, le=160)
    seed: int = 7


class AnalogParams(BaseModel):
    steps: int = Field(default=420, ge=40, le=1600)
    dt: float = Field(default=0.045, gt=0, le=0.2)
    pump_start: float = Field(default=-0.55, ge=-1.5, le=1.0)
    pump_end: float = Field(default=1.35, ge=0.2, le=3.0)
    coupling: float = Field(default=0.22, ge=0.01, le=1.5)
    noise: float = Field(default=0.035, ge=0.0, le=0.4)
    seed: int = 0


class DigitalParams(BaseModel):
    method: str = "metropolis"
    steps: int | None = Field(default=None, ge=20, le=20000)
    seed: int = 0
    temperature: float = Field(default=0.35, ge=0.01, le=3.0)


class RunRequest(BaseModel):
    instance: InstanceRequest = InstanceRequest()
    analog: AnalogParams = AnalogParams()
    digital: DigitalParams = DigitalParams()


class FieldRequest(BaseModel):
    size: int = Field(default=48, ge=16, le=96)
    gamma: float = Field(default=2.4, ge=0.0, le=8.0)
    pattern: str = "two_beams"
    seed: int = 3


def _instance_payload(inst: problems.MaxCutInstance) -> dict:
    pos = layout.layout_positions(inst)
    return {
        "kind": inst.kind,
        "n": inst.n,
        "seed": inst.seed,
        "edges": [
            {"source": int(i), "target": int(j), "weight": float(w)}
            for i, j, w in inst.edge_list()
        ],
        "positions": pos.tolist(),
        "planted_spins": None if inst.planted_spins is None else inst.planted_spins.tolist(),
        "max_possible_cut": inst.max_possible_cut(),
        "edge_count": int(np.count_nonzero(np.triu(inst.weights, 1))),
    }


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "lab": "chi3-analog"}


@app.get("/api/primer")
def primer() -> dict:
    return {
        "title": "Analog nonlinear computing at volume",
        "thesis": (
            "A digital machine evaluates couplings in a loop. A χ³ analog fabric "
            "lets physics evaluate every product at once, then saturates into a "
            "high-quality solution."
        ),
        "equations": [
            {
                "name": "χ³ polarization",
                "tex": "P = ε₀ (χ⁽¹⁾ E + χ⁽³⁾ |E|² E)",
                "note": "The cubic term mixes fields and creates intensity-dependent index.",
            },
            {
                "name": "Kerr index",
                "tex": "n = n₀ + n₂ I",
                "note": "Light writes its own phase shift — a free analog multiply.",
            },
            {
                "name": "CIM oscillator",
                "tex": "ẋᵢ = (p − 1) xᵢ − xᵢ³ + ξ Σⱼ Jᵢⱼ xⱼ",
                "note": "−x³ is the χ³ saturation; Jx is the all-to-all analog coupling.",
            },
            {
                "name": "Max-Cut / Ising",
                "tex": "H = ½ Σᵢⱼ Wᵢⱼ sᵢ sⱼ    cut = ¼ Σᵢⱼ Wᵢⱼ (1 − sᵢ sⱼ)",
                "note": "Opposite analog signs across a heavy edge increase the cut.",
            },
        ],
        "glossary": [
            {
                "id": "ising",
                "term": "Ising machine",
                "meaning": (
                    "A classroom Coherent Ising Machine: N analog oscillators whose "
                    "amplitudes xᵢ settle into spins sᵢ = sign(xᵢ) = ±1. That pattern "
                    "is a Max-Cut guess. The analog side evaluates every pairwise "
                    "product at once; a digital walker flips one spin per tick."
                ),
            },
            {
                "id": "oscillators",
                "term": "Oscillators N",
                "meaning": (
                    "Each node is a continuous amplitude, not a bit. Color is the "
                    "readout spin; radius is |xᵢ|. N units give a 2^N configuration "
                    "space that the analog fabric never enumerates."
                ),
            },
            {
                "id": "cut",
                "term": "Cut",
                "meaning": (
                    "The score: an edge is cut when its endpoints have opposite spins. "
                    "cut = ¼ Σ Wᵢⱼ (1 − sᵢ sⱼ). Cut ceiling is the sum of all edge "
                    "weights — every edge cut, often impossible. Higher is better."
                ),
            },
            {
                "id": "couplings",
                "term": "Couplings / instant",
                "meaning": (
                    "A coupling is one pairwise product Jᵢⱼ xⱼ. An analog instant is "
                    "one time sample of the ODE, in which all N² couplings fire together. "
                    "Analog couplings/instant is N²; digital updates are one spin flip "
                    "per tick."
                ),
            },
            {
                "id": "knobs",
                "term": "Analog χ³ knobs",
                "meaning": (
                    "ODE parameters, not the graph. Pump ramp end p drives saturation. "
                    "Coupling ξ scales Jx. Analog noise η is a Brownian kick that can "
                    "help escape shallow cuts."
                ),
            },
            {
                "id": "relax",
                "term": "Relax",
                "meaning": (
                    "Run the analog pump ramp and the digital walker, then compare cuts. "
                    "Analog relaxation is physical settling: explore at low pump, then "
                    "χ³ saturation locks amplitudes toward ±1."
                ),
            },
            {
                "id": "seed",
                "term": "Seed",
                "meaning": (
                    "Random seed for the graph. Same Problem + N + Seed draws the same "
                    "instance. Analog starts from seed+11 and the digital walker from "
                    "seed+3, so they share the problem, not the same initial draw."
                ),
            },
        ],
        "how_to_read": [
            "Pick a problem and N, optionally a seed.",
            "Open Analog χ³ knobs to change pump, coupling, or noise.",
            "Hit Relax both machines.",
            "Watch analog nodes grow and flip color; digital nodes flip one at a time.",
            "Compare analog best cut vs digital best cut vs cut ceiling.",
            "Volume meters count arithmetic: analog pays N² couplings every instant.",
        ],
        "caveats": [
            "Analog machines do not magically solve NP-hard problems in O(1).",
            "Noise, precision, and embedding still matter; this lab is a teaching model.",
            "The win illustrated here is computational volume: N² interactions per instant.",
        ],
    }


@app.post("/api/instance")
def create_instance(req: InstanceRequest) -> dict:
    try:
        inst = problems.build_instance(req.kind, req.n, req.seed)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return _instance_payload(inst)


@app.post("/api/run")
def run_lab(req: RunRequest) -> dict:
    try:
        inst = problems.build_instance(req.instance.kind, req.instance.n, req.instance.seed)
        analog = simulator.analog_cim(inst, **req.analog.model_dump())
        digital = simulator.digital_search(inst, **req.digital.model_dump())
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    analog_spins = np.sign(analog.amplitudes)
    analog_spins[analog_spins == 0] = 1.0
    volume = simulator.analog_volume(inst.n, analog.amplitudes.shape[0])

    # Downsample bulky analog amplitude series for the wire, keep full energy.
    stride = max(1, analog.amplitudes.shape[0] // 120)
    amp_view = analog.amplitudes[::stride]

    return {
        "instance": _instance_payload(inst),
        "analog": {
            "amplitudes": amp_view.tolist(),
            "amplitude_stride": stride,
            "final_amplitudes": analog.amplitudes[-1].tolist(),
            "final_spins": analog_spins[-1].tolist(),
            "energies": analog.energies.tolist(),
            "cuts": analog.cuts.tolist(),
            "pump": analog.pump.tolist(),
            "best_cut": float(np.max(analog.cuts)),
            "final_cut": float(analog.cuts[-1]),
            "final_energy": float(analog.energies[-1]),
            "dt": analog.dt,
            "coupling": analog.coupling,
            "noise": analog.noise,
            "steps": int(analog.amplitudes.shape[0]),
            "volume": volume,
        },
        "digital": {
            "method": digital.method,
            "spins": digital.spins_over_time.tolist(),
            "energies": digital.energies.tolist(),
            "cuts": digital.cuts.tolist(),
            "best_cut": float(np.max(digital.cuts)),
            "final_cut": float(digital.cuts[-1]),
            "final_energy": float(digital.energies[-1]),
            "updates": digital.updates,
            "configs_examined": digital.configs_examined,
            "exhausted": digital.exhausted,
        },
        "comparison": {
            "analog_best_cut": float(np.max(analog.cuts)),
            "digital_best_cut": float(np.max(digital.cuts)),
            "max_possible_cut": inst.max_possible_cut(),
            "digital_would_brute_force": float(2 ** (inst.n - 1)) if inst.n <= 62 else None,
            "lesson": _lesson(inst, analog, digital),
        },
    }


@app.post("/api/field")
def run_field(req: FieldRequest) -> dict:
    try:
        result = field_processor.process_field(
            size=req.size, gamma=req.gamma, pattern=req.pattern, seed=req.seed
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {
        "size": result.size,
        "gamma": result.gamma,
        "input": result.input_intensity.tolist(),
        "mixed": result.mixed_intensity.tolist(),
        "output": result.output_intensity.tolist(),
        "phase": result.kerr_phase.tolist(),
        "analog_instants": result.analog_instants,
        "digital_flops": result.digital_flops,
        "analog_parallel_ops": result.analog_parallel_ops,
        "pixels": result.size * result.size,
    }


def _lesson(
    inst: problems.MaxCutInstance,
    analog: simulator.AnalogTrace,
    digital: simulator.DigitalTrace,
) -> str:
    n = inst.n
    analog_cut = float(np.max(analog.cuts))
    digital_cut = float(np.max(digital.cuts))
    winner = "analog fabric" if analog_cut >= digital_cut - 1e-9 else "digital walker"
    space = f"2^{n}" if n <= 40 else f"about 2^{n}"
    return (
        f"{n} analog oscillators relaxed together through {analog.amplitudes.shape[0]} "
        f"χ³ instants (every one of the {n * n} couplings at once). The digital "
        f"{digital.method} walker flipped one spin at a time for {digital.updates} ticks "
        f"inside a {space} configuration space. Best cut on this run: {winner} "
        f"(analog {analog_cut:.2f} vs digital {digital_cut:.2f})."
    )


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC / "index.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")
