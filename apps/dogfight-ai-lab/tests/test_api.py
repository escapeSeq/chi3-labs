from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health_and_index():
    assert client.get("/api/health").json()["lab"] == "dogfight-ai"
    page = client.get("/")
    assert page.status_code == 200
    assert "Dogfight" in page.text
    assert "Hangar" in page.text
    assert "Brain library" in page.text
    assert "Burst training off" in page.text
    assert 'id="burst"' in page.text
    assert "this browser" in page.text
    assert "/data" not in page.text
    assert "Graph" in page.text
    assert 'id="winner-read"' in page.text
    assert "red-kills" not in page.text
    assert 'href="static/styles.css?v=draw-loss"' in page.text
    assert 'src="static/app.js?v=client-academy"' in page.text
    js = client.get("/static/app.js")
    assert js.status_code == 200
    assert "createAcademyClient" in js.text
    assert "winner-read" in js.text
    assert "timeout loss" in js.text
    assert page.headers.get("cache-control") == "no-store"
    assert "Sortie timeout" in page.text
    assert "loss if more than one is still up" in page.text
    assert "Planes in the fight" in page.text
    assert "Last plane standing" in page.text
    assert "One against the pack" in page.text
    assert 'id="mode"' in page.text
    for name in ("physics.js", "agents.js", "trainer.js", "academy-worker.js", "client.js", "rng.js"):
        res = client.get(f"/static/{name}")
        assert res.status_code == 200, name
