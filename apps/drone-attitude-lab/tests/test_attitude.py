import math

import numpy as np
import pytest

from app import attitude as at

RNG = np.random.default_rng(7)


def random_euler(n=50):
    return [
        (
            RNG.uniform(-math.pi, math.pi),
            RNG.uniform(-1.4, 1.4),
            RNG.uniform(-math.pi, math.pi),
        )
        for _ in range(n)
    ]


def test_quaternion_matches_matrix_composition():
    for e in random_euler():
        q = at.euler_to_quat(*e)
        assert np.allclose(at.quat_to_matrix(q), at.euler_to_matrix(*e))
        assert math.isclose(np.linalg.norm(q), 1.0)


def test_quaternion_rotation_equals_matrix_rotation():
    v = np.array([0.3, -1.2, 0.7])
    for e in random_euler(20):
        q = at.euler_to_quat(*e)
        assert np.allclose(at.quat_rotate(q, v), at.euler_to_matrix(*e) @ v)


def test_euler_roundtrip_away_from_lock():
    for e in random_euler():
        back = at.quat_to_euler(at.euler_to_quat(*e))
        assert np.allclose(back, e, atol=1e-9)


@pytest.mark.parametrize("pitch", [math.pi / 2, -math.pi / 2])
def test_gimbal_lock_keeps_attitude_not_angles(pitch):
    roll, yaw = 0.4, 1.1
    q = at.euler_to_quat(roll, pitch, yaw)
    r2, p2, y2 = at.quat_to_euler(q)
    assert y2 == 0.0
    assert math.isclose(p2, pitch)
    # Different angles, same attitude.
    assert at.angle_between(q, at.euler_to_quat(r2, p2, y2)) < 1e-6


def test_gimbal_lock_families_are_one_attitude():
    a = at.euler_to_quat(0.5, math.pi / 2, 0.2)
    b = at.euler_to_quat(0.8, math.pi / 2, 0.5)  # same roll − yaw
    assert at.angle_between(a, b) < 1e-9


def test_euler_rate_matrix_singular_at_lock():
    assert at.gimbal_condition(0.0) == pytest.approx(1.0)
    assert at.gimbal_condition(math.radians(89)) > 50
    assert at.gimbal_condition(math.pi / 2) == math.inf
    with pytest.raises(ValueError):
        at.euler_rate_matrix(0.0, math.pi / 2)


def test_matrix_to_quat_roundtrip():
    for e in random_euler():
        q = at.quat_canonical(at.euler_to_quat(*e))
        assert np.allclose(at.matrix_to_quat(at.quat_to_matrix(q)), q)


def test_double_cover():
    q = at.euler_to_quat(0.3, 0.2, -0.9)
    assert np.allclose(at.quat_to_matrix(q), at.quat_to_matrix(-q))
    full_turn = at.rotvec_to_quat([0, 0, 2 * math.pi])
    assert np.allclose(full_turn, [-1, 0, 0, 0])


def test_rotation_vector_roundtrip_and_shortest():
    for e in random_euler():
        q = at.euler_to_quat(*e)
        rv = at.quat_to_rotvec(q)
        assert np.linalg.norm(rv) <= math.pi + 1e-9
        assert at.angle_between(at.rotvec_to_quat(rv), q) < 1e-9
    assert np.allclose(at.quat_to_rotvec(at.euler_to_quat(0, 0, 0.5)), [0, 0, 0.5])


def test_pure_yaw_matches_axis_angle():
    q = at.euler_to_quat(0.0, 0.0, math.radians(90))
    assert np.allclose(at.quat_rotate(q, [1, 0, 0]), [0, 1, 0])  # nose north → east


def test_slerp_constant_rate_and_endpoints():
    q0 = at.euler_to_quat(0, 0, 0)
    q1 = at.euler_to_quat(1.0, 0.6, -0.8)
    assert np.allclose(at.slerp(q0, q1, 0), q0)
    assert at.angle_between(at.slerp(q0, q1, 1), q1) < 1e-9
    geo = at.angle_between(q0, q1)
    assert at.angle_between(q0, at.slerp(q0, q1, 0.25)) == pytest.approx(0.25 * geo)


def test_euler_lerp_is_never_shorter_than_slerp():
    r = at.interpolate((0, 0, 0), (math.radians(90), math.radians(80), math.radians(90)))
    assert r.slerp_arc == pytest.approx(r.geodesic, rel=1e-6)
    assert r.euler_arc > r.slerp_arc * 1.05


def test_spin_quaternion_is_exact_for_constant_rate():
    r = at.spin([0.0, 0.0, math.radians(90)], duration=1.0)
    assert at.angle_between(r.quats[-1], at.euler_to_quat(0, 0, math.radians(90))) < 1e-9


def test_spin_euler_rates_explode_through_lock():
    calm = at.spin([math.radians(30), 0.0, math.radians(20)], duration=2.0)
    assert calm.drift_deg.max() < 1.0
    assert calm.rate_gain < 2
    loop = at.spin([math.radians(5), math.radians(90), 0.0], duration=4.0)
    assert loop.rate_gain > 10
    assert loop.drift_deg.max() > calm.drift_deg.max()


def test_naive_quaternion_integration_grows_norm():
    r = at.spin([math.radians(200), 0, 0], duration=4.0)
    assert r.norm_naive[-1] > 1.01
    assert np.allclose(np.linalg.norm(r.quats, axis=1), 1.0)


def test_hover():
    frame = at.Airframe()
    each = frame.mass * at.GRAVITY / 4
    r = at.quad_forces([each] * 4, 0, 0, 0, frame)
    assert np.allclose(r.net_world, 0, atol=1e-9)
    assert np.allclose(r.torque_body, 0, atol=1e-12)
    assert "hover" in r.lesson


def test_tilted_hover_needs_more_thrust_and_moves_forward():
    frame = at.Airframe()
    pitch = math.radians(-20)  # nose down
    each = frame.mass * at.GRAVITY / math.cos(pitch) / 4
    r = at.quad_forces([each] * 4, 0, pitch, 0, frame)
    assert r.hover_thrust == pytest.approx(4 * each)
    assert abs(r.accel_world[2]) < 1e-9
    assert r.accel_world[0] == pytest.approx(at.GRAVITY * math.tan(-pitch))  # forward = north


def test_torque_signs():
    frame = at.Airframe()
    base = frame.mass * at.GRAVITY / 4
    names = [m[0] for m in at.MOTORS]

    def bump(*which):
        f = [base] * 4
        for w in which:
            f[names.index(w)] += 0.5
        return at.quad_forces(f, 0, 0, 0, frame).torque_body

    assert bump("front-left", "rear-left")[0] > 0  # left side up → roll right
    assert bump("front-left", "front-right")[1] > 0  # front up → nose up
    assert bump("front-right", "rear-left")[2] > 0  # CCW props → yaw right


def test_mix_inverts_allocation():
    frame = at.Airframe()
    f = at.mix(12.0, [0.1, -0.2, 0.03], frame)
    assert np.allclose(frame.allocation() @ f, [12.0, 0.1, -0.2, 0.03])


def test_thrust_clipped():
    r = at.quad_forces([-1, 3, 3, 50], 0, 0, 0)
    assert r.clipped
    assert r.thrusts.min() == 0.0
    assert r.thrusts.max() == at.Airframe().max_thrust
