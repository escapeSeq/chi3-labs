"""HTTP API and briefing-room UI for the dogfight academy."""

from __future__ import annotations

import os
from pathlib import Path

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


class PlanesIn(BaseModel):
    n: int = Field(default=2, ge=2, le=9)


class SlotIn(BaseModel):
    team: str = Field(pattern="^(red|blue)$")
    brain_id: str = Field(min_length=1, max_length=24)


class BrainMetaIn(BaseModel):
    id: str = Field(min_length=1, max_length=24)
    label: str = Field(default="", min_length=0, max_length=32)
    learn: bool = True


class RosterIn(BaseModel):
    brains: list[BrainMetaIn]
    lineup: list[SlotIn] | None = None


class BrainAddIn(BaseModel):
    label: str = Field(default="New brain", min_length=1, max_length=32)
    learn: bool = True


ACADEMY = Academy(np.random.default_rng(7), data_dir=DATA_DIR)


def _status() -> dict:
    paths = ACADEMY.brain_paths() or {}
    stored = bool(paths) and all(
        paths[bid].is_file() for bid in ACADEMY.brains if bid in paths
    )
    roster = ACADEMY.roster_report()
    brains = {row["id"]: row for row in roster}
    n_red = sum(1 for slot in ACADEMY.lineup if slot["team"] == "red")
    n_blue = sum(1 for slot in ACADEMY.lineup if slot["team"] == "blue")
    return {
        "empty": ACADEMY.empty,
        "score": ACADEMY.score.as_dict(),
        "curve": ACADEMY.curve[-80:],
        "data_dir": str(ACADEMY.data_dir) if ACADEMY.data_dir is not None else None,
        "stored": stored,
        "action_names": list(ACTION_NAMES),
        "brains": brains,
        "roster": roster,
        "lineup": list(ACADEMY.lineup),
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
            "n_planes": ACADEMY.n_planes,
            "min_planes": physics.MIN_PLANES,
            "max_planes": physics.MAX_PLANES,
            "teams": {"red": n_red, "blue": n_blue},
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


@app.post("/api/planes")
def planes(body: PlanesIn) -> dict:
    ACADEMY.set_n_planes(body.n)
    return _status()


@app.post("/api/roster")
def roster(body: RosterIn) -> dict:
    ACADEMY.set_roster(
        [item.model_dump() for item in body.brains],
        [item.model_dump() for item in body.lineup] if body.lineup is not None else None,
    )
    return _status()


@app.post("/api/brains")
def add_brain(body: BrainAddIn) -> dict:
    try:
        ACADEMY.add_brain(label=body.label, learn=body.learn)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return _status()


@app.delete("/api/brains/{brain_id}")
def remove_brain(brain_id: str) -> dict:
    try:
        ACADEMY.remove_brain(brain_id)
    except KeyError as exc:
        raise HTTPException(404, f"unknown brain {brain_id}") from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return _status()


@app.post("/api/brains/{brain_id}/wipe")
def wipe_brain(brain_id: str) -> dict:
    try:
        ACADEMY.wipe_brain(brain_id)
    except KeyError as exc:
        raise HTTPException(404, f"unknown brain {brain_id}") from exc
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


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8082")))
