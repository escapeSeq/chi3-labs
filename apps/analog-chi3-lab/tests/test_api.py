from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health():
    res = client.get("/api/health")
    assert res.status_code == 200
    assert res.json()["status"] == "ok"


def test_index_served():
    res = client.get("/")
    assert res.status_code == 200
    assert "χ³ Analog Lab" in res.text
    assert "Glossary" in res.text
    assert "term-cut" in res.text
    assert "term-couplings" in res.text
    assert "Relax both machines" in res.text


def test_primer_glossary():
    res = client.get("/api/primer")
    assert res.status_code == 200
    body = res.json()
    terms = {item["id"]: item["term"] for item in body["glossary"]}
    assert terms["ising"] == "Ising machine"
    assert terms["cut"] == "Cut"
    assert terms["couplings"] == "Couplings / instant"
    assert terms["oscillators"] == "Oscillators N"
    assert terms["knobs"] == "Analog χ³ knobs"
    assert terms["relax"] == "Relax"
    assert terms["seed"] == "Seed"
    assert body["how_to_read"]


def test_run_endpoint():
    res = client.post(
        "/api/run",
        json={
            "instance": {"kind": "ring_chords", "n": 10, "seed": 2},
            "analog": {"steps": 80, "noise": 0.01},
            "digital": {"method": "greedy", "steps": 40},
        },
    )
    assert res.status_code == 200
    body = res.json()
    assert body["instance"]["n"] == 10
    assert len(body["analog"]["cuts"]) == 80
    assert body["digital"]["updates"] == 40
    assert "lesson" in body["comparison"]


def test_field_endpoint():
    res = client.post("/api/field", json={"size": 24, "gamma": 1.2, "pattern": "lattice"})
    assert res.status_code == 200
    body = res.json()
    assert body["pixels"] == 576
    assert len(body["output"]) == 24


def test_rejects_huge_n():
    res = client.post("/api/instance", json={"kind": "planted_cut", "n": 400})
    assert res.status_code in (400, 422)
