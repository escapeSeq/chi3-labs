from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health():
    res = client.get("/api/health")
    assert res.status_code == 200
    assert res.json()["lab"] == "drone-attitude"


def test_index_served():
    for path in ("/", "/drone/"):
        res = client.get(path)
        assert res.status_code == 200
        assert "Drone Attitude Lab" in res.text
    assert "term-gimbal" in res.text
    assert "term-quaternion" in res.text
    assert 'href="static/styles.css"' in res.text
    assert 'src="static/app.js"' in res.text


def test_static_served_under_prefix():
    assert client.get("/static/app.js").status_code == 200
    assert client.get("/drone/static/styles.css").status_code == 200


def test_primer():
    body = client.get("/api/primer").json()
    ids = {g["id"] for g in body["glossary"]}
    assert {"euler", "gimbal", "quaternion", "rotvec", "thrust", "torque"} <= ids
    assert body["conventions"]["world"].startswith("NED")


def test_attitude():
    res = client.post("/api/attitude", json={"roll": 0, "pitch": 0, "yaw": 90})
    body = res.json()
    assert abs(body["angle_deg"] - 90) < 1e-9
    assert abs(body["axis"][2] - 1) < 1e-9
    assert abs(body["body_axes_world"]["forward"][1] - 1) < 1e-9
    assert abs(body["quaternion_norm"] - 1) < 1e-12


def test_attitude_rejects_out_of_range_pitch():
    assert client.post("/api/attitude", json={"pitch": 120}).status_code == 422


def test_forces_hover():
    body = client.post("/api/forces", json={"thrusts": [1.2 * 9.81 / 4] * 4}).json()
    assert max(abs(x) for x in body["net_world"]) < 1e-9
    assert "hover" in body["lesson"]


def test_mix():
    body = client.post("/api/mix", json={"collective": 12, "torque": [0, 0, 0]}).json()
    assert all(abs(f - 3) < 1e-9 for f in body["thrusts"])
    assert body["feasible"]


def test_spin_and_interpolate():
    spin = client.post("/api/spin", json={"rates": [5, 90, 0], "duration": 4}).json()
    assert spin["euler_rate_gain"] > 10
    interp = client.post("/api/interpolate", json={}).json()
    assert interp["euler_arc_deg"] > interp["slerp_arc_deg"]
