import numpy as np
from fastapi.testclient import TestClient

from app.main import ACADEMY, LessonIn, app
from app.physics import MAX_STEPS

client = TestClient(app)


def setup_function() -> None:
    ACADEMY.reset_models()
    ACADEMY.set_max_steps(MAX_STEPS, persist=False)


def test_health_and_index():
    assert client.get("/api/health").json()["lab"] == "dogfight-ai"
    page = client.get("/")
    assert page.status_code == 200
    assert "Dogfight" in page.text
    assert "Continuous flights" in page.text
    assert "Reset statistics" in page.text
    assert "Red brain" in page.text
    assert "Graph" in page.text
    assert "Numbers" in page.text
    assert "/data" in page.text
    assert "1000000" in page.text
    assert "Sortie timeout" in page.text


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


def test_burst_default_is_one_hundred():
    assert LessonIn().episodes == 100
    assert LessonIn(episodes=1_000_000).episodes == 1_000_000


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
    assert empty["brains"]["red"]["shape"]["hidden"] == 24
    assert empty["brains"]["red"]["updates"] == 0
    assert abs(sum(empty["brains"]["red"]["probe"]["mean_probs"]) - 1.0) < 1e-6
    assert empty["training"]["episodes"] == 0
    client.post("/api/lesson", json={"episodes": 4})
    body = client.get("/api/state").json()
    assert body["brains"]["red"]["updates"] == 4
    assert body["training"]["episodes"] == 4
    assert "kill_rate" in body["training"]
    assert "cosine" in body["training"]["divergence"]
    assert len(body["brains"]["red"]["w2"]) == 6
    assert len(body["brains"]["red"]["w2"][0]) == 24
    assert len(body["brains"]["red"]["w1"]) == 24
    assert len(body["brains"]["red"]["w1"][0]) == 10


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
    assert reset["brains"]["red"]["updates"] == updates
    assert np.allclose(ACADEMY.red.W2, trained)
    still = client.get("/api/state").json()
    assert still["score"]["episodes"] == 0
    assert still["curve"] == []


def test_timeout_updates_and_survives_wipe():
    empty = client.get("/api/state").json()
    assert empty["physics"]["timeout"] == 12.0
    assert empty["physics"]["max_steps"] == 240
    body = client.post("/api/timeout", json={"seconds": 8}).json()
    assert body["physics"]["timeout"] == 8.0
    assert body["physics"]["max_steps"] == 160
    reset = client.post("/api/reset").json()
    assert reset["physics"]["max_steps"] == 160
    stats = client.post("/api/reset-stats").json()
    assert stats["physics"]["max_steps"] == 160
    bad = client.post("/api/timeout", json={"seconds": 1})
    assert bad.status_code == 422


def test_repeated_sorties_keep_score():
    first = client.post("/api/sortie")
    second = client.post("/api/sortie")
    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json()["trace"]
    assert second.json()["trace"]
    assert second.json()["score"]["episodes"] == 2
