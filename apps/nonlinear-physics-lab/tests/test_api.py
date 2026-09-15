from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health():
    res = client.get("/api/health")
    assert res.status_code == 200
    assert res.json()["lab"] == "nonlinear-physics"


def test_index_served():
    res = client.get("/")
    assert res.status_code == 200
    assert "Nonlinear Physics Lab" in res.text
    res_prefixed = client.get("/physics/")
    assert res_prefixed.status_code == 200
    assert "Nonlinear Physics Lab" in res_prefixed.text
    assert "Glossary" in res.text
    assert "term-superposition" in res.text
    assert "term-kerr" in res.text
    assert 'href="static/styles.css"' in res.text
    assert 'src="static/app.js"' in res.text


def test_primer_glossary():
    res = client.get("/api/primer")
    assert res.status_code == 200
    body = res.json()
    terms = {item["id"]: item["term"] for item in body["glossary"]}
    assert terms["linear"] == "Linear / χ¹"
    assert terms["quadratic"] == "Quadratic / χ²"
    assert terms["cubic"] == "Cubic / χ³"
    assert terms["superposition"] == "Superposition"
    assert terms["kerr"] == "Kerr index"
    assert terms["well"] == "Saturating well"
    assert body["how_to_read"]


def test_probe_linear():
    res = client.post(
        "/api/probe",
        json={
            "tones": [{"amplitude": 1.1, "frequency": 1.0}],
            "chi1": 1.0,
            "chi2": 0.0,
            "chi3": 0.0,
        },
    )
    assert res.status_code == 200
    body = res.json()
    assert body["superposition_error"] == 0.0
    assert body["harmonics"]["second"] == 0.0
    assert body["harmonics"]["third"] == 0.0
    assert "copy" in body["lesson"].lower() or "linear" in body["lesson"].lower()


def test_probe_two_tone_mixer():
    res = client.post(
        "/api/probe",
        json={
            "tones": [
                {"amplitude": 1.0, "frequency": 1.0},
                {"amplitude": 0.9, "frequency": 1.625},
            ],
            "chi1": 0.4,
            "chi2": 0.7,
            "chi3": 0.0,
        },
    )
    assert res.status_code == 200
    labels = {p["label"] for p in res.json()["peaks"]}
    assert "sum frequency" in labels
    assert "difference frequency" in labels


def test_kerr_endpoint():
    res = client.post("/api/kerr", json={"n2": 1.5, "waist": 0.3})
    assert res.status_code == 200
    body = res.json()
    assert body["phase_span"] > 0
    assert len(body["carrier"]) == len(body["x"])


def test_saturate_endpoint():
    res = client.post("/api/saturate", json={"pump": 1.6, "chi3": 1.0, "x0": 0.1})
    assert res.status_code == 200
    body = res.json()
    assert len(body["wells"]) == 2
    assert body["final"] != 0
    assert not body["runaway"]


def test_rejects_too_many_tones():
    res = client.post(
        "/api/probe",
        json={
            "tones": [
                {"amplitude": 1, "frequency": 1},
                {"amplitude": 1, "frequency": 1.2},
                {"amplitude": 1, "frequency": 1.4},
                {"amplitude": 1, "frequency": 1.6},
            ]
        },
    )
    assert res.status_code in (400, 422)
