import numpy as np

from app.agents import ACTION_NAMES, HIDDEN, OBS, Policy
from app.trainer import Academy


def test_fresh_policy_is_near_uniform():
    p = Policy(np.random.default_rng(0), "red")
    obs = np.zeros(10)
    probs = p.forward(obs)["probs"]
    assert abs(float(probs.sum()) - 1.0) < 1e-6
    # Empty of skill: no action should be nearly certain.
    assert float(probs.max()) < 0.55


def test_inspect_reports_weights_and_probe():
    p = Policy(np.random.default_rng(1), "blue")
    info = p.inspect()
    assert info["updates"] == 0
    assert info["shape"] == {"obs": OBS, "hidden": HIDDEN, "actions": len(ACTION_NAMES)}
    assert abs(sum(info["probe"]["mean_probs"]) - 1.0) < 1e-6
    assert info["favorite"] in ACTION_NAMES
    assert info["weights"]["count"] == HIDDEN * OBS + len(ACTION_NAMES) * HIDDEN + HIDDEN + len(ACTION_NAMES)
    assert len(info["w1"]) == HIDDEN
    assert len(info["w1"][0]) == OBS


def test_self_play_updates_weights():
    academy = Academy(np.random.default_rng(3))
    before = academy.red.W2.copy()
    result = academy.lesson(episodes=12)
    assert academy.score.episodes == 12
    assert result["watch"]["trace"]
    assert not np.allclose(before, academy.red.W2)


def test_brains_round_trip_on_data_dir(tmp_path):
    first = Academy(np.random.default_rng(3), data_dir=tmp_path)
    first.lesson(episodes=8)
    red = first.red.W2.copy()
    blue = first.blue.W2.copy()
    score = first.score.as_dict()
    assert (tmp_path / "red.npz").is_file()
    assert (tmp_path / "blue.npz").is_file()
    assert (tmp_path / "academy.json").is_file()

    second = Academy(np.random.default_rng(99), data_dir=tmp_path)
    assert np.allclose(second.red.W2, red)
    assert np.allclose(second.blue.W2, blue)
    assert second.score.as_dict() == score
    assert second.score.episodes == 8
    assert second.red.updates == first.red.updates
    assert second.red.updates == 8


def test_timeout_round_trips_on_data_dir(tmp_path):
    first = Academy(np.random.default_rng(2), data_dir=tmp_path)
    first.set_max_steps(80)
    assert first.max_steps == 80
    second = Academy(np.random.default_rng(9), data_dir=tmp_path)
    assert second.max_steps == 80


def test_plane_count_round_trips_on_data_dir(tmp_path):
    first = Academy(np.random.default_rng(2), data_dir=tmp_path)
    first.set_n_planes(7)
    assert first.n_planes == 7
    second = Academy(np.random.default_rng(9), data_dir=tmp_path)
    assert second.n_planes == 7


def test_roster_round_trips_on_data_dir(tmp_path):
    first = Academy(np.random.default_rng(2), data_dir=tmp_path)
    first.brains["red"].learn = False
    first.set_roster(
        [{"id": "red", "label": "Ace", "learn": False}, {"id": "blue", "label": "Rookie", "learn": True}],
        [{"team": "red", "brain_id": "red"}, {"team": "blue", "brain_id": "blue"}],
    )
    first.add_brain("Spare", learn=False)
    extra = next(bid for bid in first.brains if bid not in ("red", "blue"))
    first.set_roster(
        [slot.meta() for slot in first.brains.values()],
        [{"team": "red", "brain_id": extra}, {"team": "blue", "brain_id": "blue"}],
    )
    second = Academy(np.random.default_rng(9), data_dir=tmp_path)
    assert second.brains["red"].label == "Ace"
    assert second.brains["red"].learn is False
    assert second.brains["blue"].label == "Rookie"
    assert extra in second.brains
    assert second.lineup[0]["brain_id"] == extra


def test_frozen_brain_does_not_learn():
    academy = Academy(np.random.default_rng(4))
    academy.brains["red"].learn = False
    before = academy.red.W2.copy()
    academy.play(learn=True, persist=False)
    assert np.allclose(academy.red.W2, before)
    assert academy.blue.updates == 1


def test_reset_stats_keeps_stored_brains(tmp_path):
    academy = Academy(np.random.default_rng(5), data_dir=tmp_path)
    academy.lesson(episodes=6)
    red = academy.red.W2.copy()
    blue = academy.blue.W2.copy()
    academy.reset_stats()
    assert academy.score.episodes == 0
    assert academy.curve == []
    assert academy.empty is False
    assert np.allclose(academy.red.W2, red)
    assert np.allclose(academy.blue.W2, blue)
    reloaded = Academy(np.random.default_rng(1), data_dir=tmp_path)
    assert reloaded.score.episodes == 0
    assert reloaded.empty is False
    assert np.allclose(reloaded.red.W2, red)
    assert np.allclose(reloaded.blue.W2, blue)


def test_wipe_rewrites_stored_brains(tmp_path):
    academy = Academy(np.random.default_rng(4), data_dir=tmp_path)
    academy.lesson(episodes=6)
    trained = academy.red.W2.copy()
    academy.reset_models()
    assert academy.score.episodes == 0
    assert not np.allclose(academy.red.W2, trained)
    reloaded = Academy(np.random.default_rng(1), data_dir=tmp_path)
    assert reloaded.score.episodes == 0
    assert np.allclose(reloaded.red.W2, academy.red.W2)
