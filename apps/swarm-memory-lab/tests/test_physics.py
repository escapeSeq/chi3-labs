import numpy as np

from app.physics import OBS, SENSE_RANGE, SPEED, TURN_RADIUS, World, decode_action, max_yaw_rate, wrap_angle
from app.swarm import assign_roles, extra_turns


def test_turn_rate_capped_by_radius():
    w = World(np.random.default_rng(0), n_planes=3)
    h0 = w.red.heading
    w.swarm_gain = 0.0
    w.step(0, 1)
    dh = abs(wrap_angle(w.red.heading - h0))
    assert dh <= max_yaw_rate() * 0.05 + 1e-9
    assert abs(max_yaw_rate() - SPEED / TURN_RADIUS) < 1e-9


def test_wall_crash():
    w = World(np.random.default_rng(2), n_planes=3)
    w.red.x, w.red.y, w.red.heading = 0.01, 0.5, np.pi
    w.step(1, 1)
    assert not w.red.alive
    assert any(e.endswith("_wall") for e in w.events)


def test_decode_actions():
    assert decode_action(1) == (0, False)
    assert decode_action(4) == (0, True)


def test_observation_size_and_limited_sense():
    w = World(np.random.default_rng(4), n_planes=4, mode="hunt")
    w.red.x, w.red.y = 0.1, 0.1
    hunter = w.planes[1]
    hunter.x, hunter.y = 0.9, 0.9
    obs = w.observe(hunter.name)
    assert obs.shape == (OBS,)
    assert float(np.hypot(hunter.x - w.red.x, hunter.y - w.red.y)) > SENSE_RANGE
    assert obs[0] == 0.0
    assert obs[2] == 0.0
    hunter.x, hunter.y = 0.18, 0.12
    close = w.observe(hunter.name)
    assert close[2] > 0.0


def test_hunt_roles_and_turns():
    w = World(np.random.default_rng(5), n_planes=5, mode="hunt")
    roles = assign_roles(w)
    assert "point" in roles.values()
    assert any(name.startswith("flank") for name in roles.values())
    turns = extra_turns(w)
    assert set(turns) == {p.name for p in w.planes if p.alive}
    for value in turns.values():
        assert -1.0 <= value <= 1.0


def test_multiple_prey_bodies():
    w = World(np.random.default_rng(8), n_planes=5, n_prey=2, mode="hunt")
    assert len(w.preys()) == 2
    assert len(w.pack()) == 3
    assert all(p.role == "prey" for p in w.preys())
    assert all(p.brain_id == "prey" for p in w.preys())
    assert all(p.brain_id == "hive" for p in w.pack())
    w.preys()[0].alive = False
    assert w.prey() is w.preys_living()[0]
    assert not w.done()
    for prey in w.preys():
        prey.alive = False
    assert w.done()


def test_swarm_gain_mixes_into_yaw():
    w = World(np.random.default_rng(6), n_planes=3, mode="hunt")
    w.swarm_gain = 1.0
    w.extra_turns = {w.red.name: 1.0, w.blue.name: 0.0}
    h0 = w.red.heading
    w.step({w.red.name: 1, w.blue.name: 1, w.planes[2].name: 1})
    assert abs(wrap_angle(w.red.heading - h0)) > 1e-6
