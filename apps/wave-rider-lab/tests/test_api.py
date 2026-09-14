from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app

STATIC = Path(__file__).resolve().parent.parent / "app" / "static"
client = TestClient(app)


def test_health():
    res = client.get("/api/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok", "lab": "wave-rider"}


@pytest.mark.skipif(not (STATIC / "index.html").is_file(), reason="npm run build first")
def test_index_served():
    res = client.get("/")
    assert res.status_code == 200
    assert "Wave Lab" in res.text
    assert "strip-theory" in res.text
    assert "Glossary" in res.text
