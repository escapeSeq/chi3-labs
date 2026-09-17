import numpy as np
from fastapi.testclient import TestClient

from app.main import ACADEMY, LessonIn, app
from app.physics import MAX_STEPS, MIN_PLANES

client = TestClient(app)


def setup_function() -> None:
    ACADEMY.reset_flight_setup(persist=False)
    ACADEMY.reset_models()
    ACADEMY.set_max_steps(MAX_STEPS, persist=False)
    ACADEMY.set_n_planes(MIN_PLANES, persist=False)


def test_health_and_index():
    assert client.get("/api/health").json()["lab"] == "dogfight-ai"
    page = client.get("/")
    assert page.status_code == 200
    assert "Dogfight" in page.text
    assert "Hangar" in page.text
    assert "Brain library" in page.text
    assert "Burst training off" in page.text
    assert 'id="burst"' in page.text
    assert "Start burst training" not in page.text
    assert "Stop running training burst" not in page.text
    assert "Train this burst" not in page.text
    assert "Graph" in page.text
    assert 'id="winner-read"' in page.text
    assert "red-kills" not in page.text
    assert 'href="static/styles.css?v=draw-loss"' in page.text
    assert 'src="static/app.js?v=burst-keep"' in page.text
    js = client.get("/static/app.js")
    assert js.status_code == 200
    assert "red-kills" not in js.text
    assert "winner-read" in js.text
    assert "timeout loss" in js.text
    assert "burst.running === false" in js.text
    assert page.headers.get("cache-control") == "no-store"
    assert "Numbers" in page.text
    assert "/data" in page.text
    assert "Reset statistics" not in page.text
    assert "Wipe all brains" not in page.text
    assert "Sortie timeout" in page.text
    assert "loss if more than one is still up" in page.text
    assert "Planes in the fight" in page.text
    assert "Last plane standing" in page.text
    assert "One against the pack" in page.text
    assert "Fight mode" in page.text
    assert 'id="mode"' in page.text
    assert "Brain library" in page.text


def test_empty_then_lesson():
    empty = client.get("/api/state").json()
    assert empty["empty"] is True
    assert empty["score"]["episodes"] == 0
    res = client.post("/api/lesson", json={"episodes": 6, "lr": 0.015})
    assert res.status_code == 200
    body = res.json()
    assert len(body["trained"]) == 6
    assert body["watch"]["trace"]
    assert body["empty"] is False
    assert body["score"]["episodes"] == 6


def test_watch_and_reset():
    client.post("/api/lesson", json={"episodes": 4})
    watch = client.post("/api/watch")
    assert watch.status_code == 200
    assert watch.json()["trace"]
    reset = client.post("/api/reset").json()
    assert reset["empty"] is True
    assert reset["score"]["red_kills"] == 0


def test_burst_start_and_stop():
    import time

    started = client.post("/api/burst/start", json={}).json()
    assert started["running"] is True
    assert started["burst"]["running"] is True
    deadline = time.time() + 8
    trained = 0
    while time.time() < deadline:
        trained = client.get("/api/burst").json()["trained"]
        if trained >= 2:
            break
        time.sleep(0.05)
    assert trained >= 1
    client.post("/api/burst/stop")
    deadline = time.time() + 8
    final = {"running": True}
    while time.time() < deadline:
        final = client.get("/api/burst").json()
        if not final["running"]:
            break
        time.sleep(0.05)
    assert final["running"] is False
    assert final["trained"] >= 1
    assert client.get("/api/state").json()["score"]["episodes"] >= 1


def test_burst_default_is_one_million():
    assert LessonIn().episodes == 1_000_000
    assert LessonIn(episodes=10_000_000).episodes == 10_000_000


def test_state_reports_stored_brains():
    empty = client.get("/api/state").json()
    assert empty["data_dir"]
    client.post("/api/lesson", json={"episodes": 4})
    body = client.get("/api/state").json()
    assert body["stored"] is True
    assert body["empty"] is False
    assert body["data_dir"]


def test_state_includes_brain_and_training_stats():
    empty = client.get("/api/state").json()
    assert empty["action_names"]
    assert empty["brains"]["p1"]["shape"]["hidden"] == 24
    assert empty["brains"]["p1"]["updates"] == 0
    assert abs(sum(empty["brains"]["p1"]["probe"]["mean_probs"]) - 1.0) < 1e-6
    assert empty["training"]["episodes"] == 0
    client.post("/api/lesson", json={"episodes": 4})
    body = client.get("/api/state").json()
    assert body["brains"]["p1"]["updates"] == 4
    assert body["training"]["episodes"] == 4
    assert "kill_rate" in body["training"]
    assert "cosine" in body["training"]["divergence"]
    assert len(body["brains"]["p1"]["w2"]) == 6
    assert len(body["brains"]["p1"]["w2"][0]) == 24
    assert len(body["brains"]["p1"]["w1"]) == 24
    assert len(body["brains"]["p1"]["w1"][0]) == 49
    assert body["brains"]["p1"]["shape"]["obs"] == 49
    assert len(body["brains"]["p1"]["obs_names"]) == 49


def test_reset_stats_clears_score_keeps_brains():
    client.post("/api/lesson", json={"episodes": 4})
    trained = ACADEMY.red.W2.copy()
    updates = ACADEMY.red.updates
    reset = client.post("/api/reset-stats").json()
    assert reset["empty"] is False
    assert reset["stored"] is True
    assert reset["score"]["episodes"] == 0
    assert reset["score"]["red_kills"] == 0
    assert reset["score"]["blue_kills"] == 0
    assert reset["score"]["red_walls"] == 0
    assert reset["score"]["blue_walls"] == 0
    assert reset["score"]["midairs"] == 0
    assert reset["score"]["draws"] == 0
    assert reset["curve"] == []
    assert reset["training"]["episodes"] == 0
    assert reset["brains"]["p1"]["updates"] == updates
    assert np.allclose(ACADEMY.red.W2, trained)
    still = client.get("/api/state").json()
    assert still["score"]["episodes"] == 0
    assert still["curve"] == []


def test_timeout_updates_and_survives_wipe():
    empty = client.get("/api/state").json()
    assert empty["physics"]["timeout"] == 600.0
    assert empty["physics"]["max_steps"] == 12000
    body = client.post("/api/timeout", json={"seconds": 45}).json()
    assert body["physics"]["timeout"] == 45.0
    assert body["physics"]["max_steps"] == 900
    reset = client.post("/api/reset").json()
    assert reset["physics"]["max_steps"] == 900
    stats = client.post("/api/reset-stats").json()
    assert stats["physics"]["max_steps"] == 900
    bad = client.post("/api/timeout", json={"seconds": 1})
    assert bad.status_code == 422
    too_short = client.post("/api/timeout", json={"seconds": 9})
    assert too_short.status_code == 422
    too_long = client.post("/api/timeout", json={"seconds": 601})
    assert too_long.status_code == 422


def test_plane_count_gives_each_seat_its_own_brain():
    empty = client.get("/api/state").json()
    assert empty["physics"]["n_planes"] == 2
    assert empty["lineup"][0]["brain_id"] != empty["lineup"][1]["brain_id"]
    body = client.post("/api/planes", json={"n": 5}).json()
    assert body["physics"]["n_planes"] == 5
    ids = [slot["brain_id"] for slot in body["lineup"]]
    assert len(set(ids)) == 5
    reset = client.post("/api/reset").json()
    assert reset["physics"]["n_planes"] == 5
    sortie = client.post("/api/sortie").json()
    assert len(sortie["trace"][0]["planes"]) == 5
    bad = client.post("/api/planes", json={"n": 1})
    assert bad.status_code == 422


def test_library_starts_empty_and_stores_hangar_revisions():
    empty = client.get("/api/state").json()
    assert empty["library"] == []
    assert all(row["assigned"] for row in empty["roster"])
    assert empty["roster"][0]["wins"] == 0
    assert empty["roster"][0]["kills"] == 0
    revised = client.post("/api/brains/p1/revise", json={"seat": 0}).json()
    parent = next(row for row in revised["roster"] if row["id"] == "p1")
    child_id = revised["lineup"][0]["brain_id"]
    child = revised["brains"][child_id]
    assert parent["assigned"] is False
    assert child["assigned"] is True
    assert child["parent_id"] == "p1"
    assert parent["learn"] is False
    assert child["learn"] is True
    assert any(row["id"] == "p1" for row in revised["library"])
    assert child_id not in {row["id"] for row in revised["library"]}
    assert parent["stored"] is True
    assert child["stored"] is False


def test_swap_does_not_put_old_brain_in_library():
    empty = client.get("/api/state").json()
    p1 = empty["lineup"][0]["brain_id"]
    p2 = empty["lineup"][1]["brain_id"]
    swapped = client.post(
        "/api/roster",
        json={
            "brains": empty["roster"],
            "lineup": [{"brain_id": p1, "learn": True}, {"brain_id": p1, "learn": True}],
        },
    ).json()
    assert swapped["library"] == []
    assert p2 not in swapped["brains"]
    assert [slot["brain_id"] for slot in swapped["lineup"]] == [p1, p1]
    grown = client.post("/api/planes", json={"n": 4}).json()
    assert grown["library"] == []
    shrunk = client.post("/api/planes", json={"n": 2}).json()
    assert shrunk["library"] == []
    assert shrunk["physics"]["n_planes"] == 2
    revised = client.post("/api/brains/p1/revise", json={"seat": 0}).json()
    child_id = revised["lineup"][0]["brain_id"]
    restored = client.post(
        "/api/roster",
        json={
            "brains": revised["roster"],
            "lineup": [
                {"brain_id": "p1", "learn": False},
                {"brain_id": revised["lineup"][1]["brain_id"], "learn": True},
            ],
        },
    ).json()
    assert child_id not in restored["brains"]
    assert any(row["id"] == "p1" for row in restored["library"])
    assert restored["lineup"][0]["brain_id"] != "p1"
    assert restored["brains"]["p1"]["stored"] is True
    assert restored["brains"]["p1"]["assigned"] is False
    assert restored["brains"]["p1"]["learn"] is False
    flyer = restored["brains"][restored["lineup"][0]["brain_id"]]
    assert flyer["parent_id"] == "p1"
    assert flyer["stored"] is False


def test_library_snapshot_does_not_change_when_flown():
    client.post("/api/brains/p1/revise", json={"seat": 0})
    snap = ACADEMY.brains["p1"].policy.W2.copy()
    updates = ACADEMY.brains["p1"].policy.updates
    p2 = ACADEMY.lineup[1]["brain_id"]
    flown = client.post(
        "/api/roster",
        json={
            "brains": [slot.meta() for slot in ACADEMY.brains.values()],
            "lineup": [{"brain_id": "p1", "learn": True}, {"brain_id": p2, "learn": True}],
        },
    ).json()
    flyer_id = flown["lineup"][0]["brain_id"]
    assert flyer_id != "p1"
    client.post("/api/lesson", json={"episodes": 4})
    assert np.allclose(ACADEMY.brains["p1"].policy.W2, snap)
    assert ACADEMY.brains["p1"].policy.updates == updates
    assert ACADEMY.brains[flyer_id].policy.updates > 0


def test_hangar_pick_does_not_clobber_library_entries():
    client.post(
        "/api/roster",
        json={
            "brains": [{"id": "p1", "label": "Snap", "learn": True}, {"id": "p2", "label": "Other", "learn": True}],
            "lineup": [{"brain_id": "p1"}, {"brain_id": "p2"}],
        },
    )
    client.post("/api/brains/p1/revise", json={"seat": 0})
    snap = ACADEMY.brains["p1"].policy.W2.copy()
    before = [row["id"] for row in client.get("/api/state").json()["library"]]
    assert "p1" in before
    child = ACADEMY.lineup[0]["brain_id"]
    hijack = client.post(
        "/api/roster",
        json={
            "brains": [
                {"id": "p1", "label": "P1 hijack", "learn": True},
                {"id": child, "label": "P1 hijack", "learn": True},
                {"id": "p2", "label": "Other", "learn": True},
            ],
            "lineup": [{"brain_id": "p1", "learn": True}, {"brain_id": "p2", "learn": True}],
        },
    ).json()
    assert hijack["brains"]["p1"]["label"] == "Snap"
    assert hijack["brains"]["p1"]["stored"] is True
    assert {row["id"] for row in hijack["library"]} == set(before)
    assert hijack["lineup"][0]["brain_id"] != "p1"
    assert np.allclose(ACADEMY.brains["p1"].policy.W2, snap)


def test_roster_share_revise_and_delete():
    empty = client.get("/api/state").json()
    assert empty["brains"]["p1"]["label"] == "P1"
    named = client.post(
        "/api/roster",
        json={
            "brains": [
                {"id": "p1", "label": "Ace", "learn": False},
                {"id": "p2", "label": "Rookie", "learn": True},
            ],
            "lineup": [{"brain_id": "p1", "learn": False}, {"brain_id": "p2", "learn": True}],
        },
    ).json()
    assert named["brains"]["p1"]["label"] == "Ace"
    assert named["brains"]["p1"]["learn"] is False
    shared = client.post(
        "/api/roster",
        json={
            "brains": named["roster"],
            "lineup": [
                {"brain_id": "p1", "learn": False},
                {"brain_id": "p1", "learn": True},
            ],
        },
    ).json()
    ids = [slot["brain_id"] for slot in shared["lineup"]]
    assert ids[0] != ids[1]
    child = shared["brains"][ids[1]]
    assert child["parent_id"] == "p1"
    assert child["stored"] is False
    assert child["learn"] is True
    assert shared["brains"]["p1"]["learn"] is False
    assert shared["brains"]["p1"]["stored"] is False
    assert shared["library"] == []
    revised = client.post("/api/brains/p1/revise", json={}).json()
    extra = next(row for row in revised["roster"] if row["parent_id"] == "p1" and row["id"] not in ids)
    gone = client.delete(f"/api/brains/{extra['id']}").json()
    assert extra["id"] not in gone["brains"]


def test_mode_switches_keep_brains_and_separate_stats():
    empty = client.get("/api/state").json()
    assert empty["mode"] == "ffa"
    assert empty["physics"]["mode"] == "ffa"
    client.post("/api/lesson", json={"episodes": 4})
    trained = client.get("/api/state").json()
    ffa_eps = trained["score"]["episodes"]
    assert ffa_eps == 4
    hunt = client.post("/api/mode", json={"mode": "hunt"}).json()
    assert hunt["mode"] == "hunt"
    assert hunt["score"]["episodes"] == 0
    assert hunt["score"]["hunts"] == 0
    assert hunt["score"]["escapes"] == 0
    assert hunt["empty"] is False
    assert [slot["brain_id"] for slot in hunt["lineup"]] == [slot["brain_id"] for slot in trained["lineup"]]
    back = client.post("/api/mode", json={"mode": "ffa"}).json()
    assert back["mode"] == "ffa"
    assert back["score"]["episodes"] == ffa_eps
    fallback = client.post("/api/mode", json={"mode": "nope"}).json()
    assert fallback["mode"] == "ffa"


def test_hunt_sortie_has_hunt_outcome():
    switched = client.post("/api/mode", json={"mode": "hunt"}).json()
    assert switched["mode"] == "hunt"
    body = client.post("/api/sortie").json()
    assert body["mode"] == "hunt"
    assert body["summary"]["mode"] == "hunt"
    assert body["summary"]["outcome"] in {"escape", "wipe", "hunt", "clean_hunt", "prey_crash", "midair"}
    assert "prey_kills" in body["score"]
    assert "pack_losses" in body["score"]
    trace = body["trace"][0]
    assert trace["mode"] == "hunt"
    assert trace["planes"][0]["role"] == "prey"
    assert all(plane["role"] == "pack" for plane in trace["planes"][1:])


def test_repeated_sorties_keep_score():
    first = client.post("/api/sortie")
    second = client.post("/api/sortie")
    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json()["trace"]
    assert second.json()["trace"]
    assert second.json()["score"]["episodes"] == 2
