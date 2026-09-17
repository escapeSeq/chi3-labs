"""Static host and health check for the browser-side dogfight academy."""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

STATIC = Path(__file__).parent / "static"

app = FastAPI(
    title="Dogfight AI Lab",
    description="Last-plane-standing academy. Training runs in the browser.",
    version="0.3.0",
)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "lab": "dogfight-ai"}


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
