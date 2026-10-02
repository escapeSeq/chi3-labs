"""HTTP API and static educational UI for the drone attitude lab."""

from __future__ import annotations

import math
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import attitude

STATIC = Path(__file__).parent / "static"

app = FastAPI(
    title="Drone Attitude Lab",
    description="Euler angles, quaternions, rotation vectors and rotor forces on a quadrotor.",
    version="0.1.0",
    redirect_slashes=False,
)


class EulerIn(BaseModel):
    roll: float = Field(default=0.0, ge=-180.0, le=180.0, description="degrees")
    pitch: float = Field(default=0.0, ge=-90.0, le=90.0, description="degrees")
    yaw: float = Field(default=0.0, ge=-180.0, le=180.0, description="degrees")

    def radians(self) -> tuple[float, float, float]:
        return math.radians(self.roll), math.radians(self.pitch), math.radians(self.yaw)


class AttitudeRequest(EulerIn):
    pass


class ForceRequest(EulerIn):
    thrusts: list[float] = Field(default_factory=lambda: [2.943] * 4, min_length=4, max_length=4)
    mass: float = Field(default=1.2, gt=0.1, le=10.0)


class MixRequest(BaseModel):
    collective: float = Field(default=11.772, ge=0.0, le=40.0)
    torque: list[float] = Field(default_factory=lambda: [0.0, 0.0, 0.0], min_length=3, max_length=3)


class SpinRequest(BaseModel):
    rates: list[float] = Field(
        default_factory=lambda: [5.0, 90.0, 0.0], min_length=3, max_length=3, description="deg/s"
    )
    start: EulerIn = Field(default_factory=EulerIn)
    duration: float = Field(default=4.0, gt=0.0, le=20.0)


class InterpolateRequest(BaseModel):
    start: EulerIn = Field(default_factory=lambda: EulerIn(roll=0, pitch=0, yaw=0))
    end: EulerIn = Field(default_factory=lambda: EulerIn(roll=90, pitch=80, yaw=90))
    steps: int = Field(default=48, ge=2, le=400)


def _vec(v) -> list[float]:
    return [float(x) for x in v]


def _deg(v) -> list[float]:
    return [math.degrees(float(x)) for x in v]


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "lab": "drone-attitude"}


@app.get("/api/primer")
def primer() -> dict:
    return {
        "title": "Four numbers for an attitude, one vector for a push",
        "thesis": (
            "A quadrotor can only push along its own belly axis. Everything it does "
            "— hover, translate, turn — is choosing how hard to push and which way "
            "that axis points. Attitude is the whole game, so how you write it down "
            "matters."
        ),
        "conventions": {
            "world": "NED — x north, y east, z down",
            "body": "FRD — x forward, y right, z down",
            "euler": "intrinsic Z-Y-X: yaw ψ, then pitch θ, then roll φ",
            "quaternion": "Hamilton, scalar first [w, x, y, z], body → world",
        },
        "equations": [
            {
                "name": "Euler Z-Y-X",
                "tex": "R = Rz(ψ) · Ry(θ) · Rx(φ)",
                "note": "Three turns about moving axes. The order matters: X-Y-Z gives a different R.",
            },
            {
                "name": "Quaternion from axis and angle",
                "tex": "q = [cos(α/2), sin(α/2) n̂]",
                "note": "Half-angles: q and −q are the same attitude, and a full 360° turn flips the sign.",
            },
            {
                "name": "Rotating a vector",
                "tex": "v_w = q ⊗ [0, v_b] ⊗ q*",
                "note": "Same answer as R · v_b, without trig and without a singularity.",
            },
            {
                "name": "Rotation vector",
                "tex": "r = α n̂ ,  |r| = α",
                "note": "The axis-angle packed into one 3-vector. Exponential map: q = exp(r / 2).",
            },
            {
                "name": "Euler rates",
                "tex": "ψ̇ = (q sin φ + r cos φ) / cos θ",
                "note": "Gyros measure body rates ω = (p, q, r). Turning them into Euler rates divides by cos θ.",
            },
            {
                "name": "Quaternion kinematics",
                "tex": "q̇ = ½ q ⊗ [0, ω]",
                "note": "Linear in q, no trig, no division. This is what flight controllers integrate.",
            },
            {
                "name": "Newton",
                "tex": "m a = R · [0, 0, −ΣFᵢ] + [0, 0, m g]",
                "note": "Thrust is fixed in the body. Rotating the body is the only way to steer it.",
            },
            {
                "name": "Euler (rigid body)",
                "tex": "J ω̇ = τ − ω × J ω,  τ = Σ rᵢ × Fᵢ + τ_drag",
                "note": "Differences between rotors make torque; torque makes angular acceleration.",
            },
        ],
        "glossary": [
            {"id": "frames", "term": "World and body frames",
             "meaning": "NED world, FRD body. A vector has different numbers in each; R converts body to world."},
            {"id": "euler", "term": "Euler angles",
             "meaning": "Roll φ, pitch θ, yaw ψ applied in a fixed order. Easy to read, singular at pitch ±90°."},
            {"id": "gimbal", "term": "Gimbal lock",
             "meaning": "At pitch ±90° the roll and yaw axes coincide. One degree of freedom vanishes from the angles, not from the drone."},
            {"id": "quaternion", "term": "Quaternion",
             "meaning": "Four numbers on the unit 3-sphere. No singularity, cheap to compose, double cover: q and −q agree."},
            {"id": "rotvec", "term": "Rotation vector",
             "meaning": "Axis times angle. Three numbers, the shortest single turn that reaches the attitude."},
            {"id": "matrix", "term": "Rotation matrix",
             "meaning": "Nine numbers. Columns are the body axes written in world coordinates."},
            {"id": "omega", "term": "Angular velocity ω",
             "meaning": "A rotation-rate vector in the body frame (p, q, r). Gyros measure this, not Euler rates."},
            {"id": "thrust", "term": "Thrust vector",
             "meaning": "Always along −z_body. Tilt it and part of it becomes horizontal force."},
            {"id": "torque", "term": "Torque and mixing",
             "meaning": "Roll and pitch torques come from thrust differences across arms; yaw from prop drag reaction."},
            {"id": "slerp", "term": "SLERP",
             "meaning": "Spherical linear interpolation. Constant-rate turn about one axis — the great circle between two attitudes."},
        ],
        "caveats": [
            "Rigid body, no aerodynamics beyond rotor thrust and drag torque, no motor lag.",
            "Thrust per motor is clipped to [0, max]. Real ESCs and props are not linear.",
            "The gyroscopic term ω × Jω is in the equations but the force tab shows the drone at rest.",
        ],
    }


@app.post("/api/attitude")
def run_attitude(req: AttitudeRequest) -> dict:
    roll, pitch, yaw = req.radians()
    q = attitude.euler_to_quat(roll, pitch, yaw)
    m = attitude.quat_to_matrix(q)
    rv = attitude.quat_to_rotvec(q)
    angle = float(abs(rv @ rv) ** 0.5)
    back = attitude.quat_to_euler(q)
    return {
        "euler_deg": [req.roll, req.pitch, req.yaw],
        "quaternion": _vec(q),
        "quaternion_norm": float((q @ q) ** 0.5),
        "matrix": [_vec(row) for row in m],
        "rotation_vector": _vec(rv),
        "angle_deg": math.degrees(angle),
        "axis": _vec(rv / angle) if angle > 1e-9 else [0.0, 0.0, 0.0],
        "euler_roundtrip_deg": _deg(back),
        "gimbal_condition": attitude.gimbal_condition(pitch),
        "body_axes_world": {
            "forward": _vec(m[:, 0]),
            "right": _vec(m[:, 1]),
            "down": _vec(m[:, 2]),
        },
    }


@app.post("/api/forces")
def run_forces(req: ForceRequest) -> dict:
    frame = attitude.Airframe(mass=req.mass)
    try:
        r = attitude.quad_forces(req.thrusts, *req.radians(), frame=frame)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {
        "thrusts": _vec(r.thrusts),
        "clipped": r.clipped,
        "motors": [name for name, *_ in attitude.MOTORS],
        "thrust_body": _vec(r.thrust_body),
        "thrust_world": _vec(r.thrust_world),
        "gravity_world": _vec(r.gravity_world),
        "net_world": _vec(r.net_world),
        "accel_world": _vec(r.accel_world),
        "torque_body": _vec(r.torque_body),
        "alpha_body_deg": _deg(r.alpha_body),
        "tilt_deg": math.degrees(r.tilt),
        "hover_thrust": r.hover_thrust if math.isfinite(r.hover_thrust) else None,
        "quaternion": _vec(r.quat),
        "lesson": r.lesson,
    }


@app.post("/api/mix")
def run_mix(req: MixRequest) -> dict:
    frame = attitude.Airframe()
    thrusts = attitude.mix(req.collective, req.torque, frame)
    return {
        "motors": [name for name, *_ in attitude.MOTORS],
        "thrusts": _vec(thrusts),
        "allocation": [_vec(row) for row in frame.allocation()],
        "feasible": bool(((thrusts >= 0) & (thrusts <= frame.max_thrust)).all()),
    }


@app.post("/api/spin")
def run_spin(req: SpinRequest) -> dict:
    r = attitude.spin([math.radians(x) for x in req.rates], req.start.radians(), req.duration)
    stride = max(1, len(r.t) // 200)
    return {
        "t": _vec(r.t[::stride]),
        "quaternion": [_vec(q) for q in r.quats[::stride]],
        "euler_from_quat_deg": [_deg(e) for e in r.euler_from_quat[::stride]],
        "euler_integrated_deg": [_deg(e) for e in r.euler_integrated[::stride]],
        "euler_rates_deg": [_deg(e) for e in r.euler_rates[::stride]],
        "drift_deg": _vec(r.drift_deg[::stride]),
        "naive_quaternion_norm": _vec(r.norm_naive[::stride]),
        "max_drift_deg": float(r.drift_deg.max()),
        "euler_rate_gain": r.rate_gain,
        "lesson": r.lesson,
    }


@app.post("/api/interpolate")
def run_interpolate(req: InterpolateRequest) -> dict:
    r = attitude.interpolate(req.start.radians(), req.end.radians(), req.steps)
    return {
        "slerp": [_vec(q) for q in r.slerp_path],
        "euler_lerp": [_vec(q) for q in r.euler_path],
        "slerp_nose": [_vec(v) for v in r.slerp_nose],
        "euler_nose": [_vec(v) for v in r.euler_nose],
        "geodesic_deg": math.degrees(r.geodesic),
        "slerp_arc_deg": math.degrees(r.slerp_arc),
        "euler_arc_deg": math.degrees(r.euler_arc),
        "lesson": r.lesson,
    }


@app.get("/")
@app.get("/drone")
@app.get("/drone/")
def index() -> FileResponse:
    return FileResponse(STATIC / "index.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")
app.mount("/drone/static", StaticFiles(directory=STATIC), name="drone-static")
