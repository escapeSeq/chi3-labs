"""Start the lab with `python main.py` (Railway Railpack's default)."""

from __future__ import annotations

import os

import uvicorn

if __name__ == "__main__":
    uvicorn.run(
        "app.main:app",
        host="",
        port=int(os.environ.get("PORT", "8082")),
    )
