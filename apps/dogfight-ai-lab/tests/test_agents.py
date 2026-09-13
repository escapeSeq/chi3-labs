import numpy as np

from app.agents import ACTION_NAMES, HIDDEN, OBS, Policy
from app.trainer import Academy


def test_fresh_policy_is_near_uniform():
    p = Policy(np.random.default_rng(0), "red")
    obs = np.zeros(10)
    probs = p.forward(obs)["probs"]
    assert abs(float(probs.sum()) - 1.0) < 1e-6
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
    assert (tmp_path / "p1.npz").is_file()
    assert (tmp_path / "p2.npz").is_file()
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
    first.set_max_steps(400)
    assert first.max_steps == 400
    second = Academy(np.random.default_rng(9), data_dir=tmp_path)
    assert second.max_steps == 400


def test_plane_count_round_trips_on_data_dir(tmp_path):
    first = Academy(np.random.default_rng(2), data_dir=tmp_path)
    first.set_n_planes(7)
    assert first.n_planes == 7
    assert len({slot["brain_id"] for slot in first.lineup}) == 7
    second = Academy(np.random.default_rng(9), data_dir=tmp_path)
    assert second.n_planes == 7


def test_roster_round_trips_on_data_dir(tmp_path):
    first = Academy(np.random.default_rng(2), data_dir=tmp_path)
    first.set_roster(
        [{"id": "p1", "label": "Ace", "learn": False}, {"id": "p2", "label": "Rookie", "learn": True}],
        [{"brain_id": "p1"}, {"brain_id": "p2"}],
    )
    child = first.revise_brain("p1")
    first.set_roster(
        [slot.meta() for slot in first.brains.values()],
        [{"brain_id": child.id}, {"brain_id": "p2"}],
    )
    second = Academy(np.random.default_rng(9), data_dir=tmp_path)
    assert second.brains["p1"].label == "Ace"
    assert second.brains["p1"].learn is False
    assert second.brains["p2"].label == "Rookie"
    assert child.id in second.brains
    assert second.brains[child.id].parent_id == "p1"
    assert second.lineup[0]["brain_id"] == child.id


def test_frozen_brain_does_not_learn():
    academy = Academy(np.random.default_rng(4))
    academy.brains["p1"].learn = False
    before = academy.red.W2.copy()
    academy.play(learn=True, persist=False)
    assert np.allclose(academy.red.W2, before)
    assert academy.blue.updates == 1


def test_revision_copies_weights_and_freezes_parent():
    academy = Academy(np.random.default_rng(6))
    academy.play(learn=True, persist=False)
    parent = academy.red.W2.copy()
    child = academy.revise_brain("p1", assign_seat=0)
    assert np.allclose(child.policy.W2, parent)
    assert academy.brains["p1"].learn is False
    assert child.learn is True
    assert academy.lineup[0]["brain_id"] == child.id
    report = academy.roster_report()
    stored = [row for row in report if row.get("in_library")]
    flying = [row for row in report if row["assigned"]]
    assert {row["id"] for row in stored} == {"p1"}
    assert child.id in {row["id"] for row in flying}
    academy.set_roster(
        [slot.meta() for slot in academy.brains.values()],
        [{"brain_id": "p1"}, {"brain_id": academy.lineup[1]["brain_id"]}],
        persist=False,
    )
    assert "p1" in academy.brains
    assert child.id not in academy.brains
    assert academy.brains["p1"].stored is True
    assert any(row["id"] == "p1" and row["in_library"] for row in academy.roster_report())


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
