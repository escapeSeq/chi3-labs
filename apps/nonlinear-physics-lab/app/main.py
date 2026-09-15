"""HTTP API and static educational UI for the nonlinear analog physics lab."""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import physics

STATIC = Path(__file__).parent / "static"

app = FastAPI(
    title="Nonlinear Analog Physics Lab",
    description="Educational simulation of χ¹ / χ² / χ³ analog media.",
    version="0.1.0",
)


class ToneIn(BaseModel):
    amplitude: float = Field(default=1.0, ge=0.0, le=2.5)
    frequency: float = Field(default=1.0, gt=0.05, le=6.0)
    phase: float = Field(default=0.0, ge=-6.3, le=6.3)


class ProbeRequest(BaseModel):
    tones: list[ToneIn] = Field(
        default_factory=lambda: [ToneIn(amplitude=1.15, frequency=1.0)]
    )
    chi1: float = Field(default=1.0, ge=0.0, le=2.0)
    chi2: float = Field(default=0.0, ge=-1.5, le=1.5)
    chi3: float = Field(default=0.0, ge=-1.2, le=1.2)


class KerrRequest(BaseModel):
    n2: float = Field(default=1.4, ge=-3.0, le=4.0)
    waist: float = Field(default=0.28, ge=0.12, le=0.7)
    amplitude: float = Field(default=1.0, ge=0.2, le=1.8)


class SaturateRequest(BaseModel):
    pump: float = Field(default=1.55, ge=-0.4, le=2.8)
    chi3: float = Field(default=1.0, ge=0.0, le=2.2)
    x0: float = Field(default=0.08, ge=-0.6, le=0.6)


def _tones(req: ProbeRequest) -> list[physics.Tone]:
    if not req.tones:
        raise ValueError("Provide at least one drive tone.")
    if len(req.tones) > 3:
        raise ValueError("At most three tones.")
    return [
        physics.Tone(amplitude=t.amplitude, frequency=t.frequency, phase=t.phase)
        for t in req.tones
    ]


def _downsample(values, stride: int = 2) -> list[float]:
    return [float(v) for v in values[::stride]]


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "lab": "nonlinear-physics"}


@app.get("/api/primer")
def primer() -> dict:
    return {
        "title": "The medium is the computer's first law",
        "thesis": (
            "Analog physics begins with a constitutive curve. A linear medium "
            "copies a field. A nonlinear medium multiplies fields, writes new "
            "frequencies, and — with a cubic — can lock a continuous amplitude "
            "into a bit."
        ),
        "equations": [
            {
                "name": "Constitutive expansion",
                "tex": "P = χ⁽¹⁾ E + χ⁽²⁾ E² + χ⁽³⁾ E³",
                "note": "The analog multiply lives in the powers of E. Higher orders mix more fields.",
            },
            {
                "name": "Second harmonic / rectification",
                "tex": "sin² ωt = ½ − ½ cos 2ωt",
                "note": "χ² is even: it makes DC and 2ω from one tone, sum and difference from two.",
            },
            {
                "name": "Third harmonic / Kerr",
                "tex": "sin³ ωt = ¾ sin ωt − ¼ sin 3ωt",
                "note": "χ³ is odd: 3ω plus an intensity-dependent correction at ω. That correction is the Kerr index.",
            },
            {
                "name": "Kerr index",
                "tex": "n = n₀ + n₂ I,    I = |E|²",
                "note": "The bright part of a beam writes extra phase — a spatial analog multiply.",
            },
            {
                "name": "Saturating well",
                "tex": "ẋ = (p − 1) x − χ³ x³",
                "note": "Gain without a cubic runs away. Gain with a cubic splits 0 into ± wells — the analog bit.",
            },
        ],
        "glossary": [
            {
                "id": "medium",
                "term": "Medium",
                "meaning": (
                    "Whatever writes P from E: a crystal, a Kerr fiber, a "
                    "transistor curve, a Josephson junction. The lab treats it "
                    "as a function P(E) applied everywhere at once."
                ),
            },
            {
                "id": "linear",
                "term": "Linear / χ¹",
                "meaning": (
                    "P = χ¹ E. Output is a scaled copy of input. Superposition "
                    "holds: two drives stay two drives. No new frequencies."
                ),
            },
            {
                "id": "quadratic",
                "term": "Quadratic / χ²",
                "meaning": (
                    "P has an E² term. Even function of the field: DC "
                    "(optical rectification), second harmonic, and with two "
                    "tones the sum and difference frequencies. Analog multiply "
                    "of the field by itself."
                ),
            },
            {
                "id": "cubic",
                "term": "Cubic / χ³",
                "meaning": (
                    "P has an E³ term. Odd function: third harmonic, Kerr "
                    "self-phase at ω, four-wave mixing, and the saturating "
                    "well that analog Ising machines use as a spin."
                ),
            },
            {
                "id": "superposition",
                "term": "Superposition",
                "meaning": (
                    "P(E1+E2) = P(E1)+P(E2). True only for a linear medium. "
                    "The mix error on the meters is the normalized gap. When "
                    "it leaves zero, the medium is multiplying."
                ),
            },
            {
                "id": "kerr",
                "term": "Kerr index",
                "meaning": (
                    "n = n₀ + n₂ I. Intensity writes phase. A bright core "
                    "advances (or retards) relative to the wings — self-phase "
                    "modulation, the spatial face of χ³."
                ),
            },
            {
                "id": "well",
                "term": "Saturating well",
                "meaning": (
                    "Overdamped Duffing: ẋ = (p−1)x − χ³ x³. Below threshold "
                    "everything dies to 0. Above threshold the cubic splits "
                    "the origin into ±√((p−1)/χ³). No cubic, and gain runs away."
                ),
            },
        ],
        "how_to_read": [
            "Start on Drive with χ² = χ³ = 0. The P(E) plot is a line; the spectrum is one spike.",
            "Raise χ². The line becomes a parabola, the sine grows a DC offset and a 2ω wiggle.",
            "Zero χ² and raise χ³. The curve becomes an odd S; 3ω appears.",
            "Turn on the second tone. Linear: two spikes. Nonlinear: sum, difference, four-wave lines.",
            "Open Kerr: intensity writes phase on a beam. Open Saturate: pump past 1 and watch the well split.",
        ],
        "caveats": [
            "This is a weakly nonlinear, instantaneous medium — no dispersion, no memory, no noise figure.",
            "Real χ² crystals need a lack of inversion symmetry; χ³ is allowed in every material.",
            "The saturating well is the classroom CIM oscillator with the graph unplugged.",
        ],
    }


@app.post("/api/probe")
def run_probe(req: ProbeRequest) -> dict:
    try:
        result = physics.probe(_tones(req), req.chi1, req.chi2, req.chi3)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    stride = 2
    spec_cut = 80
    return {
        "t": _downsample(result.t, stride),
        "field": _downsample(result.field, stride),
        "response": _downsample(result.response, stride),
        "linear": _downsample(result.linear, stride),
        "e_axis": [float(v) for v in result.e_axis],
        "p_axis": [float(v) for v in result.p_axis],
        "freqs": [float(v) for v in result.freqs[:spec_cut]],
        "mag_field": [float(v) for v in result.mag_field[:spec_cut]],
        "mag_response": [float(v) for v in result.mag_response[:spec_cut]],
        "peaks": [
            {
                "frequency": peak.frequency,
                "amplitude": peak.amplitude,
                "label": peak.label,
                "order": peak.order,
            }
            for peak in result.peaks
        ],
        "lesson": result.lesson,
        "superposition_error": result.superposition_error,
        "chi1": result.chi1,
        "chi2": result.chi2,
        "chi3": result.chi3,
        "harmonics": physics.sine_harmonics(
            req.tones[0].amplitude, req.chi1, req.chi2, req.chi3
        )
        if len(req.tones) == 1
        else None,
    }


@app.post("/api/kerr")
def run_kerr(req: KerrRequest) -> dict:
    result = physics.kerr_slice(n2=req.n2, waist=req.waist, amplitude=req.amplitude)
    return {
        "x": [float(v) for v in result.x],
        "envelope": [float(v) for v in result.envelope],
        "intensity": [float(v) for v in result.intensity],
        "phase": [float(v) for v in result.phase],
        "carrier": [float(v) for v in result.carrier],
        "linear_carrier": [float(v) for v in result.linear_carrier],
        "n2": result.n2,
        "phase_span": float(result.phase.max() - result.phase.min()),
        "lesson": result.lesson,
    }


@app.post("/api/saturate")
def run_saturate(req: SaturateRequest) -> dict:
    result = physics.saturate(pump=req.pump, chi3=req.chi3, x0=req.x0)
    return {
        "t": [float(v) for v in result.t],
        "x": [float(v) for v in result.x],
        "x_grid": [float(v) for v in result.x_grid],
        "potential": [float(v) for v in result.potential],
        "force": [float(v) for v in result.force],
        "wells": list(result.wells),
        "pump": result.pump,
        "chi3": result.chi3,
        "runaway": result.runaway,
        "final": float(result.x[-1]),
        "lesson": result.lesson,
    }


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC / "index.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")
