from fastapi.testclient import TestClient
import numpy as np

from app.digits import generate_digit
from app.main import LabState, STATE, app

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
    assert 'data-mode="inspect"' in page.text
    assert "Inspect the net" in page.text


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


def test_inspect_explains_architecture_and_units():
    body = client.get("/api/inspect").json()
    assert len(body["hidden"]) == 20
    assert len(body["digits"]) == 10
    assert len(body["votes"]) == 10
    assert len(body["votes"][0]) == 20
    assert "ReLU" in body["architecture"]["story"]
    assert body["hidden"][0]["blurb"]
    assert body["digits"][7]["blurb"]
    assert "template" in body["legend"]


def test_train_persists_weights_for_restart():
    trained = client.post("/api/train", json={"epochs": 6, "lr": 0.3})
    assert trained.status_code == 200
    snap = client.get("/api/state").json()
    assert snap["trained"] is True
    assert snap["persisted"] is True
    assert snap["data_dir"]
    weights = np.array(STATE.model.W1, copy=True)
    restored = LabState(data_dir=STATE.data_dir)
    assert restored.trained is True
    assert restored.last_metrics is not None
    assert np.allclose(restored.model.W1, weights)


def test_forget_persists_untrained_weights():
    client.post("/api/train", json={"epochs": 4, "lr": 0.3})
    client.post("/api/reset-model")
    restored = LabState(data_dir=STATE.data_dir)
    assert restored.trained is False
    assert restored.last_metrics is None
