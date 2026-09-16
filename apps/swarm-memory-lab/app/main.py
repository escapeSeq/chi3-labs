"""HTTP API and briefing-room UI for the swarm memory lab."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

if __package__:
    from . import physics
    from .agents import ACTION_NAMES
    from .trainer import Academy
else:
    import physics
    from agents import ACTION_NAMES
    from trainer import Academy

STATIC = Path(__file__).parent / "static"
DATA_DIR = Path(
    os.environ.get("SWARM_DATA")
    or os.environ.get("DOGFIGHT_DATA")
    or os.environ.get("RAILWAY_VOLUME_MOUNT_PATH")
    or "/data"
)

app = FastAPI(
    title="Swarm Memory Lab",
    description="Shared maps and hive weights on the dogfight hunting ground.",
    version="0.1.0",
)


class LessonIn(BaseModel):
    episodes: int = Field(default=40, ge=4, le=10_000)
    lr: float = Field(default=0.014, gt=0.001, le=0.08)
    seconds: Optional[float] = Field(default=None, ge=10.0, le=600.0)


class BurstIn(BaseModel):
    lr: float = Field(default=0.014, gt=0.001, le=0.08)
    seconds: Optional[float] = Field(default=None, ge=10.0, le=600.0)


class TimeoutIn(BaseModel):
    seconds: float = Field(default=120.0, ge=10.0, le=600.0)


class PlanesIn(BaseModel):
    n: int = Field(default=5, ge=2, le=8)


class TeamCountIn(BaseModel):
    n: Optional[int] = Field(default=None, ge=1, le=8)
    delta: Optional[int] = Field(default=None, ge=-8, le=8)


class BrainIn(BaseModel):
    brain: str = Field(default="prey", min_length=3, max_length=16)


class ModeIn(BaseModel):
    mode: str = Field(default="hunt", min_length=3, max_length=32)


class ShareIn(BaseModel):
    share: str = Field(default="hive", min_length=3, max_length=32)


class GainsIn(BaseModel):
    swarm_gain: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    memory_gain: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    memory_on: Optional[bool] = None


ACADEMY = Academy(np.random.default_rng(11), data_dir=DATA_DIR)


def _status() -> dict:
    roster = ACADEMY.roster_report()
    return {
        "empty": ACADEMY.empty,
        "score": ACADEMY.score.as_dict(),
        "curve": ACADEMY.curve[-80:],
        "data_dir": str(ACADEMY.data_dir) if ACADEMY.data_dir is not None else None,
        "action_names": list(ACTION_NAMES),
        "roster": roster,
        "lineup": ACADEMY.lineup(),
        "mode": ACADEMY.mode,
        "share": ACADEMY.share,
        "burst": ACADEMY.burst_status(),
        "training": ACADEMY.training_report(),
        "memory": ACADEMY.memory.snapshot() if ACADEMY.uses_memory() else None,
        "memory_on": ACADEMY.uses_memory(),
        "gains": {
            "swarm": ACADEMY.swarm_gain,
            "memory": ACADEMY.memory_gain,
        },
        "physics": {
            "mode": ACADEMY.mode,
            "share": ACADEMY.share,
            "turn_radius": physics.TURN_RADIUS,
            "speed": physics.SPEED,
            "gun_range": physics.GUN_RANGE,
            "sense_range": physics.SENSE_RANGE,
            "arena": physics.ARENA,
            "dt": physics.DT,
            "max_steps": ACADEMY.max_steps,
            "timeout": physics.seconds_from_steps(ACADEMY.max_steps),
            "min_timeout": physics.seconds_from_steps(physics.MIN_STEPS),
            "max_timeout": physics.seconds_from_steps(physics.MAX_STEPS_CAP),
            "n_planes": ACADEMY.n_planes,
            "n_prey": ACADEMY.n_prey,
            "n_hive": ACADEMY.n_hive,
            "min_planes": physics.MIN_PLANES,
            "max_planes": physics.MAX_PLANES,
            "min_prey": physics.MIN_PREY,
            "min_hive": physics.MIN_HIVE,
            "swarm_gain": ACADEMY.swarm_gain,
            "memory_gain": ACADEMY.memory_gain,
        },
    }


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "lab": "swarm-memory"}


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


@app.post("/api/reset-memory")
def reset_memory() -> dict:
    ACADEMY.reset_memory()
    return _status()


@app.post("/api/reset-brain")
def reset_brain(body: BrainIn) -> dict:
    try:
        ACADEMY.reset_brain(body.brain)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _status()


@app.post("/api/timeout")
def timeout(body: TimeoutIn) -> dict:
    ACADEMY.set_max_steps(physics.steps_from_seconds(body.seconds))
    return _status()


@app.post("/api/planes")
def planes(body: PlanesIn) -> dict:
    ACADEMY.set_n_planes(body.n)
    return _status()


@app.post("/api/prey")
def prey_count(body: Optional[TeamCountIn] = None) -> dict:
    body = body or TeamCountIn()
    if body.n is not None:
        ACADEMY.set_n_prey(body.n)
    elif body.delta:
        ACADEMY.set_n_prey(ACADEMY.n_prey + int(body.delta))
    return _status()


@app.post("/api/hive")
def hive_count(body: Optional[TeamCountIn] = None) -> dict:
    body = body or TeamCountIn()
    if body.n is not None:
        ACADEMY.set_n_hive(body.n)
    elif body.delta:
        ACADEMY.set_n_hive(ACADEMY.n_hive + int(body.delta))
    return _status()


@app.post("/api/mode")
def mode(body: ModeIn) -> dict:
    ACADEMY.set_mode(body.mode)
    return _status()


@app.post("/api/share")
def share(body: ShareIn) -> dict:
    ACADEMY.set_share(body.share)
    return _status()


@app.post("/api/gains")
def gains(body: GainsIn) -> dict:
    ACADEMY.set_gains(swarm_gain=body.swarm_gain, memory_gain=body.memory_gain, memory_on=body.memory_on)
    return _status()


@app.post("/api/lesson")
def lesson(body: LessonIn) -> dict:
    if body.seconds is not None:
        ACADEMY.set_max_steps(physics.steps_from_seconds(body.seconds), persist=False)
    result = ACADEMY.lesson(episodes=body.episodes, lr=body.lr)
    return {**result, **_status()}


@app.get("/api/burst")
def burst_state() -> dict:
    return ACADEMY.burst_status()


@app.post("/api/burst/start")
def burst_start(body: Optional[BurstIn] = None) -> dict:
    body = body or BurstIn()
    if body.seconds is not None:
        ACADEMY.set_max_steps(physics.steps_from_seconds(body.seconds), persist=False)
    burst = ACADEMY.start_burst(lr=body.lr)
    return {**burst, **_status()}


@app.post("/api/burst/stop")
def burst_stop() -> dict:
    burst = ACADEMY.stop_burst()
    return {**burst, **_status()}


@app.post("/api/watch")
def watch() -> dict:
    duel = ACADEMY.play(learn=False, record=False)
    return {**duel, **_status()}


@app.post("/api/sortie")
def sortie() -> dict:
    result = ACADEMY.play(learn=True)
    return {**result, **_status()}


@app.middleware("http")
async def no_store_ui(request, call_next):
    response = await call_next(request)
    path = request.url.path
    if path == "/" or path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-store"})


app.mount("/static", StaticFiles(directory=STATIC), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="", port=int(os.environ.get("PORT", "8083")))
