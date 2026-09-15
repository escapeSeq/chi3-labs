import numpy as np

from app.agents import ACTION_NAMES, HIDDEN, OBS, Policy
from app.trainer import Academy, Scoreboard


def test_fresh_policy_is_near_uniform():
    p = Policy(np.random.default_rng(0), "red")
    obs = np.zeros(OBS)
    probs = p.forward(obs)["probs"]
    assert abs(float(probs.sum()) - 1.0) < 1e-6
    assert float(probs.max()) < 0.55


def test_legacy_brain_pads_new_observation_channels(tmp_path):
    old = Policy(np.random.default_rng(0), "legacy")
    old.W1 = np.ones((HIDDEN, 10))
    path = tmp_path / "legacy.npz"
    old.save(path)
    loaded = Policy(np.random.default_rng(1), "padded")
    loaded.load(path)
    assert loaded.W1.shape == (HIDDEN, OBS)
    assert np.allclose(loaded.W1[:, :10], 1.0)
    assert np.allclose(loaded.W1[:, 10:], 0.0)


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


def test_mode_and_hunt_stats_round_trip_on_data_dir(tmp_path):
    first = Academy(np.random.default_rng(2), data_dir=tmp_path)
    first.set_mode("hunt")
    first.score.escapes = 3
    first.score.hunts = 5
    first.score.pack_losses = 8
    first.persist()
    second = Academy(np.random.default_rng(9), data_dir=tmp_path)
    assert second.mode == "hunt"
    assert second.score.escapes == 3
    assert second.score.hunts == 5
    assert second.score.pack_losses == 8
    second.set_mode("ffa")
    assert second.score.escapes == 0


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
    flyer = second.lineup[0]["brain_id"]
    assert flyer != child.id
    assert second.brains[flyer].parent_id == child.id
    assert second.brains[child.id].stored is True
    assert second.lineup[0]["brain_id"] != "p1"


def test_draw_is_scored_as_failure():
    board = Scoreboard()
    board.note(["draw"], {"p1": "ace", "p2": "rookie"})
    assert board.draws == 1
    assert board.wins == {}
    assert board.last_winner is None
    assert board.last_outcome == "failure"
    board.note(["win_p1"], {"p1": "ace", "p2": "rookie"})
    assert board.draws == 1
    assert board.wins == {"ace": 1}
    assert board.last_winner == "ace"
    assert board.last_outcome == "win"
    academy = Academy(np.random.default_rng(0))
    academy.max_steps = 4
    result = academy.play(learn=False, persist=False)
    assert "draw" in result["summary"]["events"]
    assert result["summary"]["outcome"] == "failure"
    assert result["summary"]["winner"] is None
    assert academy.score.draws == 1
    for stats in result["summary"]["brains"].values():
        assert stats["return"] < -0.8


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
    academy.score.wins["p1"] = 4
    academy.score.kills["p1"] = 7
    academy.score.walls["p1"] = 2
    child = academy.revise_brain("p1", assign_seat=0)
    assert np.allclose(child.policy.W2, parent)
    assert academy.brains["p1"].learn is False
    assert child.learn is True
    assert academy.lineup[0]["brain_id"] == child.id
    assert academy.score.wins[child.id] == 4
    assert academy.score.kills[child.id] == 7
    assert academy.score.walls[child.id] == 2
    assert academy.score.wins["p1"] == 4
    academy.score.note(["x_kill", "win_x"], {"x": child.id})
    assert academy.score.kills[child.id] == 8
    assert academy.score.wins[child.id] == 5
    assert academy.score.kills["p1"] == 7
    assert academy.score.wins["p1"] == 4
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
    flyer_id = academy.lineup[0]["brain_id"]
    assert flyer_id != "p1"
    assert child.id not in academy.brains
    assert academy.brains["p1"].stored is True
    assert academy.brains["p1"].learn is False
    assert np.allclose(academy.brains["p1"].policy.W2, parent)
    assert academy.brains[flyer_id].parent_id == "p1"
    assert academy.score.wins[flyer_id] == 4
    assert academy.score.kills[flyer_id] == 7
    academy.play(learn=True, persist=False)
    assert np.allclose(academy.brains["p1"].policy.W2, parent)
    assert academy.brains[flyer_id].policy.updates >= 1


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
