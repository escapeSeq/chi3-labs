import numpy as np

from app.physics import (
    SPEED,
    TURN_RADIUS,
    World,
    decode_action,
    max_yaw_rate,
    steps_from_seconds,
    team_counts,
    wrap_angle,
)


def test_turn_rate_capped_by_radius():
    w = World(np.random.default_rng(0))
    h0 = w.red.heading
    w.step(0, 1)  # red full left, blue straight
    dh = abs(wrap_angle(w.red.heading - h0))
    assert dh <= max_yaw_rate() * 0.05 + 1e-9
    assert abs(max_yaw_rate() - SPEED / TURN_RADIUS) < 1e-9
    assert TURN_RADIUS == 0.06


def test_bullets_only_travel_forward():
    w = World(np.random.default_rng(1))
    w.red.x, w.red.y, w.red.heading = 0.4, 0.4, 0.0
    w.red.cooldown = 0.0
    w.blue.x, w.blue.y = 0.9, 0.9
    w.step(3, 1)  # red straight + fire (action 3 is left+fire; 4 is straight+fire)
    # fire with straight
    w.red.x, w.red.y, w.red.heading, w.red.cooldown = 0.4, 0.4, 0.0, 0.0
    w.bullets.clear()
    w.step(4, 1)
    assert w.bullets
    b = w.bullets[0]
    assert b.owner == "red"
    assert abs(wrap_angle(b.heading - 0.0)) < 1e-9
    x0 = b.x
    w.step(1, 1)
    assert w.bullets[0].x > x0
    assert abs(w.bullets[0].y - 0.4) < 0.02


def test_wall_crash():
    w = World(np.random.default_rng(2))
    w.red.x, w.red.y, w.red.heading = 0.01, 0.5, np.pi
    w.step(1, 1)
    assert not w.red.alive
    assert "red_wall" in w.events


def test_custom_timeout_draws():
    w = World(np.random.default_rng(0), max_steps=4)
    w.red.x, w.red.y, w.red.heading = 0.4, 0.4, 0.0
    w.blue.x, w.blue.y, w.blue.heading = 0.6, 0.6, np.pi
    while not w.done():
        w.step(1, 1)
    assert w.steps == 4
    assert "draw" in w.events
    assert steps_from_seconds(8) == 160
    assert steps_from_seconds(12) == 240


def test_decode_actions():
    assert decode_action(1) == (0, False)
    assert decode_action(4) == (0, True)
    assert decode_action(0) == (-1, False)
    assert decode_action(5) == (1, True)


def test_team_counts_split_two_to_nine():
    assert team_counts(2) == (1, 1)
    assert team_counts(3) == (2, 1)
    assert team_counts(9) == (5, 4)


def test_multiplane_spawn():
    w = World(np.random.default_rng(0), n_planes=9)
    assert len(w.planes) == 9
    assert sum(p.team == "red" for p in w.planes) == 5
    assert sum(p.team == "blue" for p in w.planes) == 4
    names = [p.name for p in w.planes]
    assert "red" in names and "blue" in names
    for p in w.planes:
        assert 0.0 < p.x < 1.0
        assert 0.0 < p.y < 1.0
    snap = w.snapshot()
    assert len(snap["planes"]) == 9


def test_fight_lasts_until_team_wipe():
    w = World(np.random.default_rng(1), n_planes=4, max_steps=40)
    blues = [p for p in w.planes if p.team == "blue"]
    assert not w.done()
    blues[0].alive = False
    assert not w.done()
    blues[1].alive = False
    assert w.done()
