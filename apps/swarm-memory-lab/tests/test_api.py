import numpy as np
from fastapi.testclient import TestClient

from app.main import ACADEMY, app
from app.physics import DEFAULT_PLANES, MAX_STEPS

client = TestClient(app)


def setup_function() -> None:
    ACADEMY.reset_models(persist=False)
    ACADEMY.set_max_steps(400, persist=False)
    ACADEMY.set_n_planes(DEFAULT_PLANES, persist=False)
    ACADEMY.set_share("hive", persist=False)
    ACADEMY.set_mode("hunt", persist=False)


def test_health_and_index():
    assert client.get("/api/health").json()["lab"] == "swarm-memory"
    page = client.get("/")
    assert page.status_code == 200
    assert "Swarm Memory" in page.text
    assert "Shared memory" in page.text
    assert "Hive" in page.text
    assert "Blackboard" in page.text
    assert "Isolated" in page.text
    assert "One against the pack" in page.text
    assert 'id="share"' in page.text
    assert 'href="static/styles.css?v=swarm1"' in page.text
    assert 'src="static/app.js?v=swarm1"' in page.text
    js = client.get("/static/app.js")
    assert js.status_code == 200
    assert "api/share" in js.text
    assert page.headers.get("cache-control") == "no-store"


def test_state_defaults():
    body = client.get("/api/state").json()
    assert body["empty"] is True
    assert body["share"] == "hive"
    assert body["mode"] == "hunt"
    assert body["physics"]["n_planes"] == DEFAULT_PLANES
    assert body["memory_on"] is True
    assert len(body["lineup"]) == DEFAULT_PLANES
    assert body["lineup"][0]["brain_id"] == "prey"
    assert {slot["brain_id"] for slot in body["lineup"][1:]} == {"hive"}


def test_share_isolated_uses_private_drones():
    body = client.post("/api/share", json={"share": "isolated"}).json()
    assert body["share"] == "isolated"
    assert body["memory_on"] is False
    ids = [slot["brain_id"] for slot in body["lineup"]]
    assert ids[0] == "prey"
    assert ids[1:] == [f"d{i}" for i in range(1, DEFAULT_PLANES)]


def test_lesson_and_watch():
    res = client.post("/api/lesson", json={"episodes": 4, "lr": 0.015})
    assert res.status_code == 200
    body = res.json()
    assert len(body["trained"]) == 4
    assert body["watch"]["trace"]
    assert body["empty"] is False
    watch = client.post("/api/watch")
    assert watch.status_code == 200
    assert watch.json()["trace"]


def test_burst_start_and_stop():
    started = client.post("/api/burst/start", json={}).json()
    assert started["running"] is True
    stopped = client.post("/api/burst/stop").json()
    assert "burst" in stopped
    ACADEMY.stop_burst(join=True)


def test_reset_memory_clears_map():
    client.post("/api/sortie")
    before = client.get("/api/state").json()["memory"]
    assert before is not None
    wiped = client.post("/api/reset-memory").json()
    energy = wiped["memory"]["energy"]
    assert energy["prey"] == 0
    assert energy["kill"] == 0


def test_gains_and_planes():
    body = client.post("/api/gains", json={"swarm_gain": 0.2, "memory_gain": 0.8}).json()
    assert body["gains"]["swarm"] == 0.2
    assert body["gains"]["memory"] == 0.8
    planes = client.post("/api/planes", json={"n": 6}).json()
    assert planes["physics"]["n_planes"] == 6
    timeout = client.post("/api/timeout", json={"seconds": 20}).json()
    assert timeout["physics"]["timeout"] == 20
    assert ACADEMY.max_steps < MAX_STEPS
