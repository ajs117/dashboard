"""FastAPI entrypoint: serves the API and the static frontend."""
from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from starlette.types import Scope

from . import config
from .providers import aclose
from .routers import api, config_api, trackers_api

_FRONTEND = Path(__file__).resolve().parents[2] / "frontend"


class NoCacheStaticFiles(StaticFiles):
    """Serve the frontend with no caching.

    It's a single-user kiosk on localhost, so caching only causes harm: WebKit
    could load a new module against a stale one (e.g. new home.js + old app.js)
    and crash. no-store guarantees every page load fetches a consistent set.
    """

    def is_not_modified(self, response_headers, request_headers) -> bool:
        return False  # never answer 304

    async def get_response(self, path: str, scope: Scope):
        resp = await super().get_response(path, scope)
        resp.headers["Cache-Control"] = "no-store, must-revalidate"
        resp.headers["Pragma"] = "no-cache"
        resp.headers["Expires"] = "0"
        return resp


@asynccontextmanager
async def lifespan(app: FastAPI):
    config.load()
    yield
    await aclose()


app = FastAPI(title="Pi Desk Dashboard", lifespan=lifespan)

app.include_router(api.router)
app.include_router(config_api.router)
app.include_router(trackers_api.router)


@app.get("/healthz")
async def healthz() -> dict[str, object]:
    return {
        "ok": True,
        "config_source": str(config.source_path()),
        "using_example_config": config.is_fallback(),
    }


# Static frontend last, so /api/* and /healthz win. html=True serves index.html at /.
if _FRONTEND.is_dir():
    app.mount("/", NoCacheStaticFiles(directory=str(_FRONTEND), html=True), name="frontend")
