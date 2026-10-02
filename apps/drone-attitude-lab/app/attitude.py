"""Rigid-body attitude and quadrotor force math for the drone lab.

Conventions (aerospace / PX4):

* World frame is NED: x north, y east, z down. Gravity is +z.
* Body frame is FRD: x forward (nose), y right, z down (belly).
* Euler angles are intrinsic Z-Y-X: yaw ψ about z, then pitch θ about the
  new y, then roll φ about the newest x.  R = Rz(ψ) · Ry(θ) · Rx(φ).
* Quaternions are Hamilton, scalar first: q = [w, x, y, z].  They rotate a
  body vector into the world: v_w = q ⊗ v_b ⊗ q*.
* Positive roll drops the right arm, positive pitch lifts the nose, positive
  yaw turns the nose right (clockwise seen from above).

The browser redraws all of this every frame in JavaScript. This module is the
reference copy the API serves and the tests pin down.
"""

from __future__ import annotations

from dataclasses import dataclass
import math

import numpy as np

GRAVITY = 9.81
EPS = 1e-12


# ---------------------------------------------------------------------------
# Quaternion algebra
# ---------------------------------------------------------------------------


def quat_normalize(q) -> np.ndarray:
    q = np.asarray(q, dtype=float)
    n = np.linalg.norm(q)
    if n < EPS:
        raise ValueError("Zero quaternion has no attitude.")
    return q / n


def quat_mul(a, b) -> np.ndarray:
    """Hamilton product a ⊗ b."""
    aw, ax, ay, az = a
    bw, bx, by, bz = b
    return np.array(
        [
            aw * bw - ax * bx - ay * by - az * bz,
            aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw,
        ]
    )


def quat_conj(q) -> np.ndarray:
    w, x, y, z = q
    return np.array([w, -x, -y, -z])


def quat_rotate(q, v) -> np.ndarray:
    """Rotate body vector v into the world with unit quaternion q."""
    p = np.array([0.0, *v])
    return quat_mul(quat_mul(q, p), quat_conj(q))[1:]


def quat_canonical(q) -> np.ndarray:
    """q and −q are the same attitude. Pick the one with w ≥ 0."""
    q = np.asarray(q, dtype=float)
    return -q if q[0] < 0 else q


def quat_to_matrix(q) -> np.ndarray:
    w, x, y, z = quat_normalize(q)
    return np.array(
        [
            [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
            [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
            [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
        ]
    )


def matrix_to_quat(m) -> np.ndarray:
    """Shepperd's method: pick the largest diagonal term to stay well conditioned."""
    m = np.asarray(m, dtype=float)
    tr = m[0, 0] + m[1, 1] + m[2, 2]
    if tr > 0:
        s = 2.0 * math.sqrt(tr + 1.0)
        q = [0.25 * s, (m[2, 1] - m[1, 2]) / s, (m[0, 2] - m[2, 0]) / s, (m[1, 0] - m[0, 1]) / s]
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = 2.0 * math.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2])
        q = [(m[2, 1] - m[1, 2]) / s, 0.25 * s, (m[0, 1] + m[1, 0]) / s, (m[0, 2] + m[2, 0]) / s]
    elif m[1, 1] > m[2, 2]:
        s = 2.0 * math.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2])
        q = [(m[0, 2] - m[2, 0]) / s, (m[0, 1] + m[1, 0]) / s, 0.25 * s, (m[1, 2] + m[2, 1]) / s]
    else:
        s = 2.0 * math.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1])
        q = [(m[1, 0] - m[0, 1]) / s, (m[0, 2] + m[2, 0]) / s, (m[1, 2] + m[2, 1]) / s, 0.25 * s]
    return quat_canonical(quat_normalize(q))


# ---------------------------------------------------------------------------
# Euler angles (Z-Y-X)
# ---------------------------------------------------------------------------


def euler_to_quat(roll: float, pitch: float, yaw: float) -> np.ndarray:
    cr, sr = math.cos(roll / 2), math.sin(roll / 2)
    cp, sp = math.cos(pitch / 2), math.sin(pitch / 2)
    cy, sy = math.cos(yaw / 2), math.sin(yaw / 2)
    return np.array(
        [
            cr * cp * cy + sr * sp * sy,
            sr * cp * cy - cr * sp * sy,
            cr * sp * cy + sr * cp * sy,
            cr * cp * sy - sr * sp * cy,
        ]
    )


def quat_to_euler(q) -> tuple[float, float, float]:
    """Return (roll, pitch, yaw). At pitch = ±90° only roll ∓ yaw is defined;
    this picks yaw = 0 there and folds the whole twist into roll."""
    w, x, y, z = quat_normalize(q)
    sin_pitch = 2 * (w * y - z * x)
    if abs(sin_pitch) >= 1 - 1e-9:
        pitch = math.copysign(math.pi / 2, sin_pitch)
        roll = wrap(2 * math.atan2(x, w))
        return roll, pitch, 0.0
    roll = math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y))
    pitch = math.asin(sin_pitch)
    yaw = math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))
    return roll, pitch, yaw


def euler_to_matrix(roll: float, pitch: float, yaw: float) -> np.ndarray:
    return rot_z(yaw) @ rot_y(pitch) @ rot_x(roll)


def rot_x(a: float) -> np.ndarray:
    c, s = math.cos(a), math.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


def rot_y(a: float) -> np.ndarray:
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def rot_z(a: float) -> np.ndarray:
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])


def euler_rate_matrix(roll: float, pitch: float) -> np.ndarray:
    """W such that [φ̇, θ̇, ψ̇] = W · ω_body. Blows up as cos θ → 0."""
    cp = math.cos(pitch)
    if abs(cp) < 1e-9:
        raise ValueError("Gimbal lock: Euler rates are undefined at pitch = ±90°.")
    sr, cr, tp = math.sin(roll), math.cos(roll), math.tan(pitch)
    return np.array(
        [
            [1.0, sr * tp, cr * tp],
            [0.0, cr, -sr],
            [0.0, sr / cp, cr / cp],
        ]
    )


def gimbal_condition(pitch: float) -> float:
    """Condition number of the body-rate → Euler-rate map. 1 is healthy, ∞ is locked."""
    cp = abs(math.cos(pitch))
    if cp < 1e-9:
        return math.inf
    return float(np.linalg.cond(euler_rate_matrix(0.0, pitch)))


# ---------------------------------------------------------------------------
# Rotation vectors (axis · angle)
# ---------------------------------------------------------------------------


def rotvec_to_quat(rv) -> np.ndarray:
    rv = np.asarray(rv, dtype=float)
    angle = float(np.linalg.norm(rv))
    if angle < EPS:
        return np.array([1.0, *(0.5 * rv)]) / math.sqrt(1 + 0.25 * angle * angle)
    axis = rv / angle
    return np.array([math.cos(angle / 2), *(math.sin(angle / 2) * axis)])


def quat_to_rotvec(q) -> np.ndarray:
    """Shortest rotation vector, angle in [0, π]."""
    w, x, y, z = quat_canonical(quat_normalize(q))
    v = np.array([x, y, z])
    s = float(np.linalg.norm(v))
    if s < EPS:
        return 2.0 * v
    angle = 2.0 * math.atan2(s, w)
    return v / s * angle


# ---------------------------------------------------------------------------
# Interpolation
# ---------------------------------------------------------------------------


def slerp(q0, q1, t: float) -> np.ndarray:
    q0 = quat_normalize(q0)
    q1 = quat_normalize(q1)
    d = float(np.dot(q0, q1))
    if d < 0:
        q1, d = -q1, -d
    if d > 0.9995:
        return quat_normalize(q0 + t * (q1 - q0))
    theta = math.acos(d)
    return (math.sin((1 - t) * theta) * q0 + math.sin(t * theta) * q1) / math.sin(theta)


def wrap(a: float) -> float:
    return math.atan2(math.sin(a), math.cos(a))


def euler_lerp(e0, e1, t: float) -> tuple[float, float, float]:
    """Interpolate each Euler angle on its own (shortest wrap per angle)."""
    return tuple(a + t * wrap(b - a) for a, b in zip(e0, e1))


def angle_between(q0, q1) -> float:
    d = abs(float(np.dot(quat_normalize(q0), quat_normalize(q1))))
    return 2.0 * math.acos(min(1.0, d))


@dataclass
class InterpolationResult:
    slerp_path: list[np.ndarray]
    euler_path: list[np.ndarray]
    slerp_nose: np.ndarray
    euler_nose: np.ndarray
    geodesic: float
    slerp_arc: float
    euler_arc: float
    lesson: str


def interpolate(e0, e1, steps: int = 48) -> InterpolationResult:
    q0 = euler_to_quat(*e0)
    q1 = euler_to_quat(*e1)
    ts = np.linspace(0.0, 1.0, steps + 1)
    sl = [slerp(q0, q1, float(t)) for t in ts]
    el = [euler_to_quat(*euler_lerp(e0, e1, float(t))) for t in ts]
    sl_arc = sum(angle_between(a, b) for a, b in zip(sl, sl[1:]))
    el_arc = sum(angle_between(a, b) for a, b in zip(el, el[1:]))
    geo = angle_between(q0, q1)
    nose = np.array([1.0, 0.0, 0.0])
    extra = (el_arc / geo - 1) * 100 if geo > 1e-6 else 0.0
    if geo < 1e-6:
        lesson = "Start and end are the same attitude. Nothing to interpolate."
    elif extra < 1:
        lesson = (
            "Here the Euler lerp happens to follow the great circle too. Push "
            "pitch toward ±90° or combine large roll and yaw to see it detour."
        )
    else:
        lesson = (
            f"SLERP turns {math.degrees(geo):.1f}° along one fixed axis. Euler "
            f"lerp rotates {math.degrees(el_arc):.1f}° — {extra:.0f}% more — because "
            "three angles moving independently do not trace the shortest path."
        )
    return InterpolationResult(
        slerp_path=sl,
        euler_path=el,
        slerp_nose=np.array([quat_rotate(q, nose) for q in sl]),
        euler_nose=np.array([quat_rotate(q, nose) for q in el]),
        geodesic=geo,
        slerp_arc=sl_arc,
        euler_arc=el_arc,
        lesson=lesson,
    )


# ---------------------------------------------------------------------------
# Body rates → attitude
# ---------------------------------------------------------------------------


@dataclass
class SpinResult:
    t: np.ndarray
    quats: np.ndarray
    euler_from_quat: np.ndarray
    euler_integrated: np.ndarray
    euler_rates: np.ndarray
    drift_deg: np.ndarray
    norm_naive: np.ndarray
    rate_gain: float
    lesson: str


def spin(
    rates,
    start=(0.0, 0.0, 0.0),
    duration: float = 4.0,
    dt: float = 0.01,
) -> SpinResult:
    """Integrate constant body rates (p, q, r) two ways.

    Quaternion: q ← q ⊗ exp(½ ω dt), exact for constant ω.
    Euler angles: forward-Euler on [φ̇ θ̇ ψ̇] = W(φ, θ) ω, which feeds tan θ and
    1 / cos θ straight into the state as pitch nears ±90°.
    Also tracks |q| under a naive q += ½ q ⊗ ω dt step without renormalizing.
    rate_gain is the peak |Euler rate| over |ω|: 1 means the angles turn as
    fast as the body does, large means the angles are being whipped around.
    """
    w = np.asarray(rates, dtype=float)
    n = int(round(duration / dt))
    t = np.arange(n + 1) * dt
    q = euler_to_quat(*start)
    naive = q.copy()
    e = np.array(start, dtype=float)
    step = rotvec_to_quat(w * dt)
    quats = np.zeros((n + 1, 4))
    eq = np.zeros((n + 1, 3))
    ei = np.zeros((n + 1, 3))
    er = np.zeros((n + 1, 3))
    drift = np.zeros(n + 1)
    norms = np.zeros(n + 1)
    for k in range(n + 1):
        quats[k] = q
        eq[k] = quat_to_euler(q)
        ei[k] = [wrap(a) for a in e]
        drift[k] = math.degrees(angle_between(q, euler_to_quat(*e)))
        norms[k] = float(np.linalg.norm(naive))
        cp = math.cos(e[1])
        if abs(cp) < 1e-6:
            cp = math.copysign(1e-6, cp)
        sr, cr = math.sin(e[0]), math.cos(e[0])
        tp = math.sin(e[1]) / cp
        er[k] = [
            w[0] + sr * tp * w[1] + cr * tp * w[2],
            cr * w[1] - sr * w[2],
            (sr * w[1] + cr * w[2]) / cp,
        ]
        if k == n:
            break
        q = quat_normalize(quat_mul(q, step))
        naive = naive + 0.5 * quat_mul(naive, np.array([0.0, *w])) * dt
        e = e + dt * er[k]
    body = float(np.linalg.norm(w))
    gain = float(np.abs(er).max() / body) if body > EPS else 1.0
    worst = float(drift.max())
    if gain > 5:
        lesson = (
            f"The gyro read a constant {math.degrees(body):.0f}°/s, but the Euler angles "
            f"had to spin up to {gain:.0f}× faster as pitch neared ±90° — W(φ, θ) divides "
            f"by cos θ. The angle integrator ends {worst:.1f}° off; the quaternion is exact."
        )
    elif worst > 0.5:
        lesson = (
            f"Euler integration disagrees by {worst:.1f}°. Same step, same rates — the "
            "error comes from the nonlinear W(φ, θ), not from ω."
        )
    else:
        lesson = (
            "Both integrators agree. Away from pitch ±90° the Euler rates are smooth. "
            "Add a little roll or yaw rate and pitch the nose through vertical."
        )
    return SpinResult(
        t=t,
        quats=quats,
        euler_from_quat=eq,
        euler_integrated=ei,
        euler_rates=er,
        drift_deg=drift,
        norm_naive=norms,
        rate_gain=gain,
        lesson=lesson,
    )


# ---------------------------------------------------------------------------
# Quadrotor forces
# ---------------------------------------------------------------------------

# PX4 "quad X" numbering in FRD body axes.  Each row: (x, y) direction of the
# arm, and the yaw-torque sign of the rotor's drag reaction (+1 turns the nose
# right).  A counter-clockwise prop (seen from above) drags the body clockwise.
MOTORS = (
    ("front-right", (1.0, 1.0), +1),
    ("rear-left", (-1.0, -1.0), +1),
    ("front-left", (1.0, -1.0), -1),
    ("rear-right", (-1.0, 1.0), -1),
)


@dataclass
class Airframe:
    mass: float = 1.2
    arm: float = 0.25
    yaw_coeff: float = 0.016
    inertia: tuple[float, float, float] = (0.011, 0.011, 0.021)
    max_thrust: float = 9.0

    def positions(self) -> np.ndarray:
        h = self.arm / math.sqrt(2)
        return np.array([[dx * h, dy * h, 0.0] for _, (dx, dy), _ in MOTORS])

    def allocation(self) -> np.ndarray:
        """4×4 map from motor thrusts to [T, τx, τy, τz]."""
        pos = self.positions()
        rows = [np.ones(4), -pos[:, 1], pos[:, 0], np.array([s for *_, s in MOTORS]) * self.yaw_coeff]
        return np.vstack(rows)


def mix(collective: float, torque, frame: Airframe | None = None) -> np.ndarray:
    """Motor thrusts that produce collective thrust T and body torque τ."""
    frame = frame or Airframe()
    rhs = np.array([collective, *torque], dtype=float)
    return np.linalg.solve(frame.allocation(), rhs)


@dataclass
class ForceResult:
    thrusts: np.ndarray
    clipped: bool
    thrust_body: np.ndarray
    thrust_world: np.ndarray
    gravity_world: np.ndarray
    net_world: np.ndarray
    accel_world: np.ndarray
    torque_body: np.ndarray
    alpha_body: np.ndarray
    tilt: float
    hover_thrust: float
    quat: np.ndarray
    matrix: np.ndarray
    lesson: str


def quad_forces(thrusts, roll: float, pitch: float, yaw: float, frame: Airframe | None = None) -> ForceResult:
    frame = frame or Airframe()
    raw = np.asarray(thrusts, dtype=float)
    if raw.shape != (4,):
        raise ValueError("A quad X has four motors.")
    f = np.clip(raw, 0.0, frame.max_thrust)
    clipped = bool(np.any(np.abs(f - raw) > 1e-9))
    wrench = frame.allocation() @ f
    total = float(wrench[0])
    torque = wrench[1:]
    q = euler_to_quat(roll, pitch, yaw)
    m = quat_to_matrix(q)
    t_body = np.array([0.0, 0.0, -total])
    t_world = m @ t_body
    g_world = np.array([0.0, 0.0, frame.mass * GRAVITY])
    net = t_world + g_world
    accel = net / frame.mass
    alpha = torque / np.asarray(frame.inertia)
    tilt = math.acos(max(-1.0, min(1.0, float(m[2, 2]))))
    cos_tilt = math.cos(tilt)
    hover = frame.mass * GRAVITY / cos_tilt if cos_tilt > 1e-6 else math.inf

    climb = -accel[2]
    horiz = float(np.hypot(accel[0], accel[1]))
    if total < 1e-6:
        lesson = "Motors off. Gravity is the only force, so the drone falls at g."
    elif cos_tilt <= 0:
        lesson = "Belly up: every newton of thrust now pushes toward the ground."
    elif np.linalg.norm(torque) > 1e-3 and abs(climb) < 0.3:
        lesson = (
            "The thrusts are unequal, so the frame has a torque. It will not hold this "
            "attitude — the tilt changes and the force direction goes with it."
        )
    elif abs(climb) < 0.15 and horiz > 0.3:
        lesson = (
            f"Tilted {math.degrees(tilt):.0f}°: thrust is mg / cos θ = {hover:.1f} N. The "
            f"vertical part holds altitude, the horizontal part accelerates at {horiz:.1f} m/s²."
        )
    elif abs(climb) < 0.15:
        lesson = "Thrust equals weight along the vertical. The forces cancel: hover."
    elif climb > 0:
        lesson = f"Vertical thrust exceeds weight. Net upward acceleration {climb:.1f} m/s²."
    else:
        lesson = (
            f"Not enough vertical thrust for this tilt. Needs {hover:.1f} N, has {total:.1f} N "
            f"— sinking at {-climb:.1f} m/s²."
        )

    return ForceResult(
        thrusts=f,
        clipped=clipped,
        thrust_body=t_body,
        thrust_world=t_world,
        gravity_world=g_world,
        net_world=net,
        accel_world=accel,
        torque_body=torque,
        alpha_body=alpha,
        tilt=tilt,
        hover_thrust=hover,
        quat=q,
        matrix=m,
        lesson=lesson,
    )
