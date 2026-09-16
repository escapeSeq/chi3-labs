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
    academy.play(learn=True, persist=False, trace=False)
    assert academy.hive.updates == hive_before + 1
    assert academy.prey.updates == 1


def test_isolated_does_not_write_map():
    academy = Academy(np.random.default_rng(4), data_dir=None)
    academy.set_max_steps(80, persist=False)
    academy.set_n_planes(4, persist=False)
    academy.set_share(SHARE_ISOLATED, persist=False)
    academy.play(learn=True, persist=False, trace=False)
    assert academy.hive.updates == 1
    assert academy.prey.updates == 1
    assert academy.memory.energy()["prey"] == 0
    assert academy.uses_memory() is False


def test_blackboard_writes_memory_on_two_brains():
    academy = Academy(np.random.default_rng(5), data_dir=None)
    academy.set_max_steps(80, persist=False)
    academy.set_n_planes(4, persist=False)
    academy.set_share(SHARE_BOARD, persist=False)
    academy.play(learn=True, persist=False, trace=True)
    assert academy.uses_memory() is True
    assert academy.hive.updates == 1
    assert academy.memory.writes > 0
    ids = [slot["brain_id"] for slot in academy.lineup()]
    assert ids[0] == "prey"
    assert set(ids[1:]) == {"hive"}


def test_multiple_prey_share_one_brain():
    academy = Academy(np.random.default_rng(6), data_dir=None)
    academy.set_max_steps(80, persist=False)
    academy.set_n_prey(2, persist=False)
    academy.set_n_hive(3, persist=False)
    academy.set_share(SHARE_HIVE, persist=False)
    lineup = academy.lineup()
    assert [slot["brain_id"] for slot in lineup] == ["prey", "prey", "hive", "hive", "hive"]
    academy.play(learn=True, persist=False, trace=False)
    assert academy.prey.updates == 1
    assert academy.hive.updates == 1


def test_changing_prey_count_aborts_the_current_fight():
    import threading
    import time

    academy = Academy(np.random.default_rng(7), data_dir=None)
    academy.set_max_steps(4000, persist=False)
    academy.set_n_prey(1, persist=False)
    academy.set_n_hive(3, persist=False)
    result = {}

    def run():
        result["play"] = academy.play(learn=True, persist=False, trace=False)

    thread = threading.Thread(target=run)
    thread.start()
    deadline = time.time() + 2
    while time.time() < deadline:
        got = academy._play_lock.acquire(blocking=False)
        if got:
            academy._play_lock.release()
            time.sleep(0.01)
            continue
        break
    academy.set_n_prey(2, persist=False)
    thread.join(timeout=8)
    assert thread.is_alive() is False
    assert result["play"]["aborted"] is True
    assert academy.n_prey == 2
