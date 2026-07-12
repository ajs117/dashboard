"""FastAPI entrypoint: serves the API and the static frontend."""
from __future__ import annotations

import asyncio
import contextlib
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from starlette.types import Scope

from . import config, trackers
from .providers import aclose, ecoflow
from .routers import api, config_api, remote_api, trackers_api

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


async def _poll_loop(interval: float, fn) -> None:
    """Run `fn` now and then every `interval` seconds, surviving any single failure."""
    while True:
        try:
            await fn()
        except Exception:  # noqa: BLE001 - a bad poll must never kill the loop
            pass
        await asyncio.sleep(max(300.0, interval))


@asynccontextmanager
async def lifespan(app: FastAPI):
    config.load()
    ecoflow.start_background(config.get())     # EcoFlow solar over MQTT (no-op if unconfigured)
    tr = config.get().get("trackers") or {}
    # Holiday/DVLA move slowly -> daily; parcels -> hourly (so alerts fire even when the
    # tracker page isn't open; the page view also refreshes them off the 15-min cache).
    tasks = [
        asyncio.create_task(_poll_loop(float(tr.get("interval_seconds", 86400)),
                                       trackers.check_all_auto)),
        asyncio.create_task(_poll_loop(float(tr.get("parcel_interval_seconds", 3600)),
                                       trackers.refresh_parcels)),
    ]
    yield
    for t in tasks:
        t.cancel()
    for t in tasks:
        with contextlib.suppress(asyncio.CancelledError):
            await t
    ecoflow.stop()
    await aclose()


app = FastAPI(title="Pi Desk Dashboard", lifespan=lifespan)

app.include_router(api.router)
app.include_router(config_api.router)
app.include_router(trackers_api.router)
app.include_router(remote_api.router)


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
