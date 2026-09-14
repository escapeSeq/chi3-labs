"""HTTP API and static educational UI for the wave lab."""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

STATIC = Path(__file__).parent / "static"
ASSETS = STATIC / "assets"
ASSETS.mkdir(parents=True, exist_ok=True)

app = FastAPI(
    title="Wave Lab",
    description="Educational seakeeping bench: Gerstner seas and strip-theory hulls.",
    version="1.0.0",
)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "lab": "wave-rider"}


@app.get("/")
def index() -> FileResponse:
    index_file = STATIC / "index.html"
    if not index_file.is_file():
        raise HTTPException(status_code=503, detail="frontend not built")
    return FileResponse(index_file)


@app.get("/favicon.svg")
def favicon() -> FileResponse:
    path = STATIC / "favicon.svg"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="not found")
    return FileResponse(path)


app.mount("/assets", StaticFiles(directory=ASSETS), name="assets")
