"""HTTP API and notebook UI for the handwriting training / inference lab."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import json
import os
import threading
import time

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import digits, network

STATIC = Path(__file__).parent / "static"
DATA_DIR = Path(
    os.environ.get("HANDWRITING_DATA")
    or os.environ.get("RAILWAY_VOLUME_MOUNT_PATH")
    or "/data"
)

app = FastAPI(
    title="Handwriting AI Lab",
    description="Educational visualization of training versus using a neural net.",
    version="0.2.0",
)


class ExampleIn(BaseModel):
    pixels: list[list[float]]
    label: int = Field(ge=0, le=9)


class TrainIn(BaseModel):
    epochs: int = Field(default=14, ge=2, le=40)
    lr: float = Field(default=0.28, gt=0.01, le=1.5)


class InferIn(BaseModel):
    pixels: list[list[float]]


class LabState:
    def __init__(self, data_dir: Path | None = DATA_DIR) -> None:
        self.data_dir = Path(data_dir) if data_dir is not None else None
        self.rng = np.random.default_rng(4)
        self.model = network.MLP(self.rng)
        self.x = np.zeros((0, 16, 16), dtype=float)
        self.y = np.zeros((0,), dtype=int)
        self.user_count = 0
        self.trained = False
        self.last_metrics: dict | None = None
        self.saved_at: str | None = None
        self._lock = threading.RLock()
        self.seed_classroom(persist=False)
        self.restore()

    def seed_classroom(self, per_class: int = 10, persist: bool = True) -> None:
        xs, ys = digits.classroom(per_class=per_class, seed=3)
        self.x = xs
        self.y = ys
        self.user_count = 0
        self.trained = False
        self.last_metrics = None
        self.model.reset()
        if persist:
            self.persist()

    def add_example(self, grid: np.ndarray, label: int) -> None:
        self.x = np.concatenate([self.x, grid[None, ...]], axis=0)
        self.y = np.concatenate([self.y, np.array([label], dtype=int)])
        self.user_count += 1

    def counts(self) -> list[int]:
        return [int(np.sum(self.y == k)) for k in range(10)]

    def model_path(self) -> Path | None:
        if self.data_dir is None:
            return None
        return self.data_dir / "model.npz"

    def meta_path(self) -> Path | None:
        if self.data_dir is None:
            return None
        return self.data_dir / "lab.json"

    def persist(self) -> None:
        model_path = self.model_path()
        meta_path = self.meta_path()
        if model_path is None or meta_path is None or self.data_dir is None:
            return
        with self._lock:
            self.data_dir.mkdir(parents=True, exist_ok=True)
            self.model.save(model_path)
            stamp = datetime.now(timezone.utc).isoformat()
            tmp = meta_path.with_name(f".lab.{os.getpid()}.{time.time_ns()}.json.tmp")
            tmp.write_text(
                json.dumps(
                    {
                        "trained": self.trained,
                        "metrics": self.last_metrics,
                        "saved_at": stamp,
                    }
                )
            )
            tmp.replace(meta_path)
            self.saved_at = stamp

    def restore(self) -> bool:
        model_path = self.model_path()
        meta_path = self.meta_path()
        if model_path is None or not model_path.is_file():
            return False
        try:
            self.model.load(model_path)
            if meta_path is not None and meta_path.is_file():
                payload = json.loads(meta_path.read_text())
                self.trained = bool(payload.get("trained", False))
                metrics = payload.get("metrics")
                self.last_metrics = metrics if isinstance(metrics, dict) else None
                saved = payload.get("saved_at")
                self.saved_at = saved if isinstance(saved, str) else None
            else:
                self.trained = True
            return True
        except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
            self.model.reset()
            self.trained = False
            self.last_metrics = None
            self.saved_at = None
            return False

    def snapshot(self) -> dict:
        return {
            "examples": int(len(self.y)),
            "user_examples": self.user_count,
            "counts": self.counts(),
            "trained": self.trained,
            "metrics": self.last_metrics,
            "hidden": network.HIDDEN,
            "grid": 16,
            "data_dir": str(self.data_dir) if self.data_dir is not None else None,
            "persisted": bool(self.model_path() is not None and self.model_path().is_file()),
            "saved_at": self.saved_at,
        }

    def inspect(self) -> dict:
        body = self.snapshot()
        body.update(self.model.inspect(trained=self.trained))
        return body


STATE = LabState()


def _grid(pixels: list[list[float]]) -> np.ndarray:
    arr = np.asarray(pixels, dtype=float)
    if arr.shape != (16, 16):
        raise ValueError("Send a 16×16 ink grid. The pad downsamples the drawing for you.")
    if float(np.max(arr)) <= 1e-6:
        raise ValueError("The pad is empty — write a digit first.")
    peak = float(arr.max()) or 1.0
    return digits.fit_ink(np.clip(arr / peak, 0.0, 1.0))


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "lab": "handwriting-ai"}


@app.get("/api/state")
def lab_state() -> dict:
    return STATE.snapshot()


@app.get("/api/inspect")
def inspect() -> dict:
    return STATE.inspect()


@app.post("/api/seed")
def seed(per_class: int = 10) -> dict:
    STATE.seed_classroom(per_class=per_class)
    return lab_state()


@app.post("/api/reset-model")
def reset_model() -> dict:
    STATE.model.reset()
    STATE.trained = False
    STATE.last_metrics = None
    STATE.persist()
    return lab_state()


@app.post("/api/example")
def add_example(body: ExampleIn) -> dict:
    try:
        grid = _grid(body.pixels)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    STATE.add_example(grid, body.label)
    return {"ok": True, "examples": int(len(STATE.y)), "counts": STATE.counts()}


@app.post("/api/train")
def train(body: TrainIn) -> dict:
    if len(STATE.y) < 10:
        raise HTTPException(400, "Need a classroom of examples before a lesson.")
    if len(set(STATE.y.tolist())) < 3:
        raise HTTPException(400, "Teach at least three different digits so the net has a real choice.")
    x = STATE.x.reshape(len(STATE.y), network.INPUT)
    before_loss, before_acc = STATE.model.loss_acc(x, STATE.y)
    trace = network.train_trace(STATE.model, x, STATE.y, epochs=body.epochs, lr=body.lr)
    STATE.trained = True
    STATE.last_metrics = {
        "loss": trace["final_loss"],
        "acc": trace["final_acc"],
        "epochs": body.epochs,
    }
    STATE.persist()
    return {
        "before": {"loss": before_loss, "acc": before_acc},
        **trace,
        "counts": STATE.counts(),
        "examples": int(len(STATE.y)),
        "lesson": (
            f"The net looked at {len(STATE.y)} labeled pages {body.epochs} times. "
            f"Loss moved {before_loss:.2f} → {trace['final_loss']:.2f}; "
            f"classroom accuracy {before_acc:.0%} → {trace['final_acc']:.0%}. "
            "Those new weights are saved on disk and used when you ask it to read."
        ),
    }


@app.post("/api/infer")
def infer(body: InferIn) -> dict:
    try:
        grid = _grid(body.pixels)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    out = STATE.model.forward(grid)
    probs = out["probs"][0]
    hidden = out["hidden"][0]
    guess = int(np.argmax(probs))
    return {
        "grid": grid.tolist(),
        "hidden": hidden.tolist(),
        "probs": probs.tolist(),
        "guess": guess,
        "confidence": float(probs[guess]),
        "trained": STATE.trained,
        "templates": STATE.model.templates().tolist(),
        "note": (
            "Weights stayed frozen — this is using the model, not teaching it."
            if STATE.trained
            else "This net has not had a lesson yet, so the guess is close to random."
        ),
    }


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC / "index.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")
