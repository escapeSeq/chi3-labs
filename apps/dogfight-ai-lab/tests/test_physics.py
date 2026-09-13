import numpy as np

from app.physics import SPEED, TURN_RADIUS, World, decode_action, max_yaw_rate, steps_from_seconds, wrap_angle


def test_turn_rate_capped_by_radius():
    w = World(np.random.default_rng(0))
    h0 = w.red.heading
    w.step(0, 1)
    dh = abs(wrap_angle(w.red.heading - h0))
    assert dh <= max_yaw_rate() * 0.05 + 1e-9
    assert abs(max_yaw_rate() - SPEED / TURN_RADIUS) < 1e-9
    assert TURN_RADIUS == 0.06


def test_bullets_only_travel_forward():
    w = World(np.random.default_rng(1))
    w.red.x, w.red.y, w.red.heading = 0.4, 0.4, 0.0
    w.red.cooldown = 0.0
    w.blue.x, w.blue.y = 0.9, 0.9
    w.red.x, w.red.y, w.red.heading, w.red.cooldown = 0.4, 0.4, 0.0, 0.0
    w.bullets.clear()
    w.step(4, 1)
    assert w.bullets
    b = w.bullets[0]
    assert b.owner == w.red.name
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
    assert any(e.endswith("_wall") for e in w.events)


def test_custom_timeout_draws():
    w = World(np.random.default_rng(0), max_steps=4)
    w.red.x, w.red.y, w.red.heading = 0.4, 0.4, 0.0
    w.blue.x, w.blue.y, w.blue.heading = 0.6, 0.6, np.pi
    while not w.done():
        w.step(1, 1)
    assert w.steps == 4
    assert "draw" in w.events
    assert steps_from_seconds(8) == 200
    assert steps_from_seconds(10) == 200
    assert steps_from_seconds(12) == 240
    assert steps_from_seconds(600) == 12000
    assert steps_from_seconds(700) == 12000


def test_decode_actions():
    assert decode_action(1) == (0, False)
    assert decode_action(4) == (0, True)
    assert decode_action(0) == (-1, False)
    assert decode_action(5) == (1, True)


def test_multiplane_spawn_is_ffa():
    w = World(np.random.default_rng(0), n_planes=9)
    assert len(w.planes) == 9
    assert [p.name for p in w.planes] == [f"p{i}" for i in range(1, 10)]
    for p in w.planes:
        assert 0.0 < p.x < 1.0
        assert 0.0 < p.y < 1.0
    assert len(w.snapshot()["planes"]) == 9


def test_custom_lineup_sets_brain_ids():
    w = World(
        np.random.default_rng(3),
        lineup=[{"brain_id": "ace"}, {"brain_id": "p1"}, {"brain_id": "p2"}],
    )
    assert len(w.planes) == 3
    assert [p.brain_id for p in w.planes] == ["ace", "p1", "p2"]
    assert w.snapshot()["planes"][0]["brain_id"] == "ace"


def test_fight_lasts_until_one_plane():
    w = World(np.random.default_rng(1), n_planes=4, max_steps=40)
    assert not w.done()
    w.planes[0].alive = False
    w.planes[1].alive = False
    assert not w.done()
    w.planes[2].alive = False
    assert w.done()


def test_hunt_ends_when_prey_dies_even_if_pack_remains():
    hunt = World(np.random.default_rng(0), n_planes=4, mode="hunt", max_steps=40)
    ffa = World(np.random.default_rng(0), n_planes=4, max_steps=40)
    assert hunt.prey().role == "prey"
    assert all(p.role == "pack" for p in hunt.pack())
    assert not hunt.done()
    hunt.prey().alive = False
    assert hunt.done()
    ffa.planes[0].alive = False
    assert not ffa.done()


def test_hunt_pack_wipe_and_timeout_escape():
    wiped = World(np.random.default_rng(0), n_planes=3, mode="hunt", max_steps=40)
    for plane in wiped.pack():
        plane.alive = False
    assert wiped.done()
    clock = World(np.random.default_rng(1), n_planes=3, mode="hunt", max_steps=4)
    while not clock.done():
        clock.step({plane.name: 1 for plane in clock.planes})
    assert "escape" in clock.events
    assert "draw" not in clock.events
    assert clock.prey().alive


def test_hunt_prey_kill_hurts_the_pack():
    from app.physics import Bullet

    w = World(np.random.default_rng(4), n_planes=3, mode="hunt")
    prey, hunter, other = w.planes
    hunter.x, hunter.y = 0.5, 0.5
    other.x, other.y = 0.8, 0.8
    rewards = {p.name: 0.0 for p in w.planes}
    w.bullets = [Bullet(0.5, 0.5, 0.0, prey.name)]
    w._hits(rewards)
    assert not hunter.alive
    assert other.alive
    assert rewards[prey.name] > 0
    assert rewards[other.name] < 0


def test_bullets_hit_any_other_plane():
    from app.physics import Bullet

    w = World(np.random.default_rng(4), n_planes=3)
    shooter, target, other = w.planes
    target.x, target.y = 0.5, 0.5
    other.x, other.y = 0.8, 0.8
    rewards = {p.name: 0.0 for p in w.planes}
    w.bullets = [Bullet(0.5, 0.5, 0.0, shooter.name)]
    w._hits(rewards)
    assert not target.alive
    assert other.alive
    assert f"{shooter.name}_kill" in w.events
    assert not w.done()
