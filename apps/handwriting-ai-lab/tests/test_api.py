from fastapi.testclient import TestClient

from app.digits import generate_digit
from app.main import STATE, app

client = TestClient(app)


def setup_function() -> None:
    STATE.seed_classroom(per_class=6)


def test_health_and_index():
    assert client.get("/api/health").json()["lab"] == "handwriting-ai"
    page = client.get("/")
    assert page.status_code == 200
    assert "Handwriting" in page.text
    assert 'href="static/styles.css"' in page.text
    assert 'src="static/app.js"' in page.text


def test_add_example_and_infer():
    grid = generate_digit(3).tolist()
    added = client.post("/api/example", json={"pixels": grid, "label": 3})
    assert added.status_code == 200
    assert added.json()["counts"][3] >= 1
    guess = client.post("/api/infer", json={"pixels": grid})
    assert guess.status_code == 200
    body = guess.json()
    assert len(body["probs"]) == 10
    assert abs(sum(body["probs"]) - 1) < 1e-5
    assert 0 <= body["guess"] <= 9


def test_train_returns_trace():
    res = client.post("/api/train", json={"epochs": 6, "lr": 0.3})
    assert res.status_code == 200
    body = res.json()
    assert len(body["losses"]) == 6
    assert body["final_acc"] >= body["before"]["acc"] - 1e-9
    assert client.get("/api/state").json()["trained"] is True


def test_empty_drawing_rejected():
    blank = [[0.0] * 16 for _ in range(16)]
    res = client.post("/api/infer", json={"pixels": blank})
    assert res.status_code == 400
