from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


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
    assert "Wipe the prey brain" in page.text
    assert "Wipe the hive brain" in page.text
    assert "this browser" in page.text
    assert "/data" not in page.text
    assert 'id="share"' in page.text
    assert 'id="prey-plus"' in page.text
    assert 'id="hive-plus"' in page.text
    assert 'href="static/styles.css?v=swarm5"' in page.text
    assert 'src="static/app.js?v=client-academy"' in page.text
    js = client.get("/static/app.js")
    assert js.status_code == 200
    assert "createAcademyClient" in js.text
    assert "resetBrain" in js.text
    assert "burst.running === false" in js.text
    assert page.headers.get("cache-control") == "no-store"
    for name in ("physics.js", "agents.js", "trainer.js", "memory.js", "swarm.js", "academy-worker.js", "client.js", "rng.js"):
        res = client.get(f"/static/{name}")
        assert res.status_code == 200, name
