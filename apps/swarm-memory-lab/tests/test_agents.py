import time

import numpy as np

from app import trainer as trainer_mod
from app.agents import ACTION_NAMES, OBS, Policy
from app.trainer import Academy


def test_act_survives_nan_weights():
    p = Policy(np.random.default_rng(0), "prey")
    p.W1[...] = np.nan
    p.W2[...] = np.inf
    action, _, out = p.act(np.zeros(OBS))
    assert 0 <= action < len(ACTION_NAMES)
    assert abs(float(out["probs"].sum()) - 1.0) < 1e-6
    assert np.all(np.isfinite(out["probs"]))


def test_burst_keeps_running_when_persist_fails(tmp_path, monkeypatch):
    academy = Academy(np.random.default_rng(4), data_dir=tmp_path)
    academy.set_max_steps(80, persist=False)
    academy.set_n_prey(1, persist=False)
    academy.set_n_hive(2, persist=False)
    monkeypatch.setattr(trainer_mod, "SAVE_EVERY", 1)

    def boom() -> None:
        raise OSError("disk full")

    academy.persist = boom  # type: ignore[method-assign]
    academy.start_burst()
    deadline = time.time() + 8
    while time.time() < deadline and academy.burst_trained < 3:
        time.sleep(0.04)
    running = academy.burst_running
    trained = academy.burst_trained
    academy.stop_burst(join=True)
    assert trained >= 2
    assert running is True
