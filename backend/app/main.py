"""FastAPI entrypoint: serves the API and the static frontend."""
from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from . import config
from .providers import aclose
from .routers import api, config_api

_FRONTEND = Path(__file__).resolve().parents[2] / "frontend"


@asynccontextmanager
async def lifespan(app: FastAPI):
    config.load()
    yield
    await aclose()


app = FastAPI(title="Pi Desk Dashboard", lifespan=lifespan)

app.include_router(api.router)
app.include_router(config_api.router)


@app.get("/healthz")
async def healthz() -> dict[str, object]:
    return {
        "ok": True,
        "config_source": str(config.source_path()),
        "using_example_config": config.is_fallback(),
    }


# Static frontend last, so /api/* and /healthz win. html=True serves index.html at /.
if _FRONTEND.is_dir():
    app.mount("/", StaticFiles(directory=str(_FRONTEND), html=True), name="frontend")
