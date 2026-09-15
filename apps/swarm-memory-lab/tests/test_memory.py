import numpy as np

from app.memory import SharedMemory
from app.physics import Plane
from app.trainer import Academy, SHARE_HIVE, SHARE_ISOLATED, SHARE_BOARD


def test_splat_and_centroid():
    mem = SharedMemory()
    mem.splat("prey", 0.25, 0.25, 1.0)
    cx, cy, mass = mem.centroid("prey")
    assert mass > 0
    assert abs(cx - 0.25) < 0.12
    assert abs(cy - 0.25) < 0.12
    plane = Plane("p2", 1, 0.25, 0.25, 0.0, role="pack")
    feat = mem.readout(plane)
    assert feat["prey_mass"] > 0
    assert feat["mem_heat"] >= 0


def test_decay_reduces_energy():
    mem = SharedMemory()
    mem.splat("kill", 0.5, 0.5, 1.0)
    before = mem.energy()["kill"]
    for _ in range(40):
        mem.decay()
    assert mem.energy()["kill"] < before


def test_only_local_hunters_write_prey_scent():
    mem = SharedMemory()
    prey = Plane("p1", 0, 0.2, 0.2, 0.0, role="prey")
    near = Plane("p2", 1, 0.24, 0.22, 0.0, role="pack")
    far = Plane("p3", 2, 0.9, 0.9, 0.0, role="pack")
    mem.watch([prey, near, far], [], {"p2", "p3"}, sense_range=0.4)
    assert mem.energy()["prey"] > 0
    mem2 = SharedMemory()
    mem2.watch([prey, far], [], {"p3"}, sense_range=0.4)
    assert mem2.energy()["prey"] < mem.energy()["prey"]


def test_hive_pools_pack_experience():
    academy = Academy(np.random.default_rng(3), data_dir=None)
    academy.set_max_steps(80, persist=False)
    academy.set_n_planes(4, persist=False)
    academy.set_share(SHARE_HIVE, persist=False)
    academy.set_mode("hunt", persist=False)
    hive_before = academy.hive.updates
    drone_before = [d.updates for d in academy.drones]
    academy.play(learn=True, persist=False, trace=False)
    assert academy.hive.updates == hive_before + 1
    assert academy.prey.updates == 1
    assert [d.updates for d in academy.drones] == drone_before


def test_isolated_does_not_update_hive_or_map():
    academy = Academy(np.random.default_rng(4), data_dir=None)
    academy.set_max_steps(80, persist=False)
    academy.set_n_planes(4, persist=False)
    academy.set_share(SHARE_ISOLATED, persist=False)
    academy.play(learn=True, persist=False, trace=False)
    assert academy.hive.updates == 0
    assert academy.prey.updates == 1
    assert any(d.updates == 1 for d in academy.drones)
    assert academy.memory.energy()["prey"] == 0
    assert academy.uses_memory() is False


def test_blackboard_writes_memory_but_keeps_private_nets():
    academy = Academy(np.random.default_rng(5), data_dir=None)
    academy.set_max_steps(80, persist=False)
    academy.set_n_planes(4, persist=False)
    academy.set_share(SHARE_BOARD, persist=False)
    academy.play(learn=True, persist=False, trace=True)
    assert academy.uses_memory() is True
    assert academy.hive.updates == 0
    assert academy.memory.writes > 0
    ids = [slot["brain_id"] for slot in academy.lineup()]
    assert ids[0] == "prey"
    assert "hive" not in ids
