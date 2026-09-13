"""HTTP API and briefing-room UI for the dogfight academy."""

from __future__ import annotations

import os
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import physics
from .agents import ACTION_NAMES
from .trainer import Academy

STATIC = Path(__file__).parent / "static"
DATA_DIR = Path(
    os.environ.get("DOGFIGHT_DATA")
    or os.environ.get("RAILWAY_VOLUME_MOUNT_PATH")
    or "/data"
)

app = FastAPI(
    title="Dogfight AI Lab",
    description="Two empty policies learn a turn-radius gun fight by trial and error.",
    version="0.1.0",
)


class LessonIn(BaseModel):
    episodes: int = Field(default=100, ge=4, le=1_000_000)
    lr: float = Field(default=0.018, gt=0.001, le=0.08)
    seconds: float | None = Field(default=None, ge=2.0, le=60.0)


class TimeoutIn(BaseModel):
    seconds: float = Field(default=12.0, ge=2.0, le=60.0)


ACADEMY = Academy(np.random.default_rng(7), data_dir=DATA_DIR)


def _status() -> dict:
    paths = ACADEMY.brain_paths() or {}
    stored = bool(paths) and paths["red"].is_file() and paths["blue"].is_file()
    return {
        "empty": ACADEMY.empty,
        "score": ACADEMY.score.as_dict(),
        "curve": ACADEMY.curve[-80:],
        "data_dir": str(ACADEMY.data_dir) if ACADEMY.data_dir is not None else None,
        "stored": stored,
        "action_names": list(ACTION_NAMES),
        "brains": {"red": ACADEMY.red.inspect(), "blue": ACADEMY.blue.inspect()},
        "training": ACADEMY.training_report(),
        "physics": {
            "turn_radius": physics.TURN_RADIUS,
            "speed": physics.SPEED,
            "gun_range": physics.GUN_RANGE,
            "arena": physics.ARENA,
            "dt": physics.DT,
            "max_steps": ACADEMY.max_steps,
            "timeout": physics.seconds_from_steps(ACADEMY.max_steps),
            "min_timeout": physics.seconds_from_steps(physics.MIN_STEPS),
            "max_timeout": physics.seconds_from_steps(physics.MAX_STEPS_CAP),
        },
    }


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "lab": "dogfight-ai"}


@app.get("/api/state")
def state() -> dict:
    return _status()


@app.post("/api/reset")
def reset() -> dict:
    ACADEMY.reset_models()
    return _status()


@app.post("/api/reset-stats")
def reset_stats() -> dict:
    ACADEMY.reset_stats()
    return _status()


@app.post("/api/timeout")
def timeout(body: TimeoutIn) -> dict:
    ACADEMY.set_max_steps(physics.steps_from_seconds(body.seconds))
    return _status()


@app.post("/api/lesson")
def lesson(body: LessonIn) -> dict:
    if body.seconds is not None:
        ACADEMY.set_max_steps(physics.steps_from_seconds(body.seconds), persist=False)
    result = ACADEMY.lesson(episodes=body.episodes, lr=body.lr)
    return {**result, **_status()}


@app.post("/api/watch")
def watch() -> dict:
    if ACADEMY.score.episodes == 0:
        # Still allowed: watch the empty flailing.
        pass
    duel = ACADEMY.play(learn=False, record=False)
    return {**duel, **_status()}


@app.post("/api/sortie")
def sortie() -> dict:
    """One training duel (used if the UI wants a slower live lesson)."""
    try:
        result = ACADEMY.play(learn=True)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {**result, **_status()}


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC / "index.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")
