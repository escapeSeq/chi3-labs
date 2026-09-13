import numpy as np

from app.digits import classroom, fit_ink, generate_digit
from app.network import MLP, train_trace


def test_all_digits_have_ink():
    rng = np.random.default_rng(0)
    for label in range(10):
        g = generate_digit(label, rng)
        assert g.shape == (16, 16)
        assert 0.08 < float(g.mean()) < 0.55
        assert float(g.max()) == 1.0


def test_training_lowers_loss_and_beats_chance():
    xs, ys = classroom(per_class=8, seed=2)
    model = MLP(np.random.default_rng(1))
    x = xs.reshape(len(ys), 256)
    before, _ = model.loss_acc(x, ys)
    trace = train_trace(model, x, ys, epochs=12, lr=0.3)
    assert trace["final_loss"] < before
    assert trace["final_acc"] >= 0.70
    assert model.predict(xs[0]) in range(10)


def test_fit_ink_centers_a_corner_stroke():
    g = np.zeros((16, 16))
    g[0:3, 0:8] = 1.0
    g[0:10, 6:8] = 1.0
    fitted = fit_ink(g)
    assert fitted[0, 0] < 0.2
    assert float(fitted[:2, :].max()) < 0.2
    assert float(fitted[2:14, 2:14].sum()) > 4.0


def test_softmax_probs_sum_to_one():
    model = MLP(np.random.default_rng(0))
    out = model.forward(np.zeros((16, 16)))
    assert out["probs"].shape == (1, 10)
    assert abs(float(out["probs"].sum()) - 1.0) < 1e-6
