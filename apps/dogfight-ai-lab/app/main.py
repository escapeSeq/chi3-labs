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
    description="Named brains last-plane-standing. Learners are revisions of frozen nets.",
    version="0.2.0",
)


class LessonIn(BaseModel):
    episodes: int = Field(default=1_000_000, ge=4, le=10_000_000)
    lr: float = Field(default=0.018, gt=0.001, le=0.08)
    seconds: float | None = Field(default=None, ge=10.0, le=600.0)


class BurstIn(BaseModel):
    lr: float = Field(default=0.018, gt=0.001, le=0.08)
    seconds: float | None = Field(default=None, ge=10.0, le=600.0)


class TimeoutIn(BaseModel):
    seconds: float = Field(default=600.0, ge=10.0, le=600.0)


class PlanesIn(BaseModel):
    n: int = Field(default=2, ge=2, le=9)


class ModeIn(BaseModel):
    mode: str = Field(default="ffa", min_length=3, max_length=32)


class SlotIn(BaseModel):
    brain_id: str = Field(min_length=1, max_length=24)
    learn: bool | None = None


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


class ReviseIn(BaseModel):
    seat: int | None = Field(default=None, ge=0, le=8)


ACADEMY = Academy(np.random.default_rng(7), data_dir=DATA_DIR)


def _status() -> dict:
    paths = ACADEMY.brain_paths() or {}
    stored = bool(paths) and all(paths[bid].is_file() for bid in ACADEMY.brains if bid in paths)
    roster = ACADEMY.roster_report()
    brains = {row["id"]: row for row in roster}
    return {
        "empty": ACADEMY.empty,
        "score": ACADEMY.score.as_dict(),
        "curve": ACADEMY.curve[-80:],
        "data_dir": str(ACADEMY.data_dir) if ACADEMY.data_dir is not None else None,
        "stored": stored,
        "action_names": list(ACTION_NAMES),
        "brains": brains,
        "roster": roster,
        "library": [row for row in roster if row.get("in_library")],
        "lineup": list(ACADEMY.lineup),
        "mode": ACADEMY.mode,
        "burst": ACADEMY.burst_status(),
        "training": ACADEMY.training_report(),
        "physics": {
            "mode": ACADEMY.mode,
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


@app.post("/api/mode")
def mode(body: ModeIn) -> dict:
    ACADEMY.set_mode(body.mode)
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


@app.post("/api/brains/{brain_id}/revise")
def revise_brain(brain_id: str, body: ReviseIn | None = None) -> dict:
    try:
        ACADEMY.revise_brain(brain_id, assign_seat=None if body is None else body.seat)
    except KeyError as exc:
        raise HTTPException(404, f"unknown brain {brain_id}") from exc
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


@app.get("/api/burst")
def burst_state() -> dict:
    return ACADEMY.burst_status()


@app.post("/api/burst/start")
def burst_start(body: BurstIn | None = None) -> dict:
    body = body or BurstIn()
    if body.seconds is not None:
        ACADEMY.set_max_steps(physics.steps_from_seconds(body.seconds), persist=False)
    burst = ACADEMY.start_burst(lr=body.lr)
    return {**burst, "burst": burst}


@app.post("/api/burst/stop")
def burst_stop() -> dict:
    burst = ACADEMY.stop_burst()
    return {**burst, "burst": burst}


@app.post("/api/watch")
def watch() -> dict:
    duel = ACADEMY.play(learn=False, record=False)
    return {**duel, **_status()}


@app.post("/api/sortie")
def sortie() -> dict:
    try:
        result = ACADEMY.play(learn=True)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {**result, **_status()}


@app.middleware("http")
async def no_store_ui(request, call_next):
    response = await call_next(request)
    path = request.url.path
    if path == "/" or path.startswith("/static/") or path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-store"})


app.mount("/static", StaticFiles(directory=STATIC), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="", port=int(os.environ.get("PORT", "8082")))
