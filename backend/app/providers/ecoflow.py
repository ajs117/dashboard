"""EcoFlow solar-output provider (official IoT Open developer API, MQTT).

The STREAM microinverter doesn't serve live data over the REST quota endpoints (they return
an empty body) — it pushes it over EcoFlow's MQTT broker instead. So we:

  1. GET /iot-open/sign/certification            -> MQTT account/password + broker
  2. connect to mqtts://mqtt-e.ecoflow.com:8883, subscribe to /open/<account>/<sn>/quota
  3. accumulate the (incremental) quota messages into a running state dict

Every REST call is HMAC-SHA256 signed, but only over the cert params (accessKey/nonce/
timestamp) — the query `sn` is NOT part of the signed string (verified against the live
API; signing it gives "signature is wrong"). Solar output = sum of the PV-input watts
(`powGetPv`, `powGetPv2`, …). Runs a background MQTT thread; `fetch` just reads the state.

Needs ecoflow.access_key + ecoflow.secret_key in config; serial is auto-discovered when
blank. Returns {enabled:false} until configured.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import random
import ssl
import threading
import time
import urllib.request
from typing import Any

_BASE = "https://api-e.ecoflow.com"

# The PV-input fields the STREAM pushes (sum = total solar generation watts).
_PV_KEYS = ("powGetPv", "powGetPv1", "powGetPv2", "powGetPv3", "powGetPv4")

# Shared state written by the MQTT thread, read by fetch(). Dict writes are atomic under the
# GIL; the lock just keeps the snapshot copy consistent.
_state: dict[str, Any] = {}
_meta: dict[str, Any] = {"connected": False, "last_msg": 0.0, "error": None, "sn": None}
_lock = threading.Lock()
_worker: threading.Thread | None = None
_stop = threading.Event()


def _sign_headers(access_key: str, secret_key: str) -> dict[str, str]:
    nonce = str(random.randint(100000, 999999))
    ts = str(int(time.time() * 1000))
    base = f"accessKey={access_key}&nonce={nonce}&timestamp={ts}"
    sign = hmac.new(secret_key.encode(), base.encode(), hashlib.sha256).hexdigest()
    return {"accessKey": access_key, "nonce": nonce, "timestamp": ts, "sign": sign,
            "Content-Type": "application/json;charset=UTF-8"}


def _signed_get(path: str, access_key: str, secret_key: str,
                query: str = "") -> dict[str, Any]:
    url = f"{_BASE}{path}" + (f"?{query}" if query else "")
    req = urllib.request.Request(url, headers=_sign_headers(access_key, secret_key))
    with urllib.request.urlopen(req, timeout=15) as resp:  # noqa: S310 - fixed EcoFlow host
        return json.loads(resp.read())


# --- Certificate caching -------------------------------------------------------------------
# EcoFlow rate-limits /sign/certification hard, and signals it with a MISLEADING error:
#   code 8524 "some parameter is empty: accessKey,nonce,timestamp,sign"
# for parameters that are demonstrably present (the identical call succeeds when not
# throttled). Once tripped, the penalty window outlasts a 60s wait and gets worse the more
# you retry - and without a certificate the MQTT broker answers "Not authorized", so solar
# goes dead. So: persist the certificate and reuse it, including across restarts, instead of
# asking for a new one on every reconnect.
_CERT_TTL = 12 * 3600


def _cert_cache_path() -> "Path":
    from pathlib import Path
    from .. import config as _config
    src = _config.source_path()
    return (src.parent if src else Path.cwd()) / "ecoflow_cert.json"


def _load_cached_cert() -> dict[str, Any] | None:
    try:
        p = _cert_cache_path()
        blob = json.loads(p.read_text("utf-8"))
        if time.time() - float(blob.get("saved_at", 0)) < _CERT_TTL and blob.get("cert"):
            return blob["cert"]
    except Exception:  # noqa: BLE001 - no/oldcache is fine, we just fetch one
        pass
    return None


def _save_cached_cert(cert: dict[str, Any]) -> None:
    try:
        p = _cert_cache_path()
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps({"saved_at": time.time(), "cert": cert}), encoding="utf-8")
        os.chmod(tmp, 0o600)          # MQTT password is a credential
        os.replace(tmp, p)
    except Exception:  # noqa: BLE001 - caching is an optimisation, never fatal
        pass


def _get_cert(access_key: str, secret_key: str, force: bool = False) -> dict[str, Any]:
    """A usable MQTT certificate, from cache when possible."""
    if not force:
        cached = _load_cached_cert()
        if cached:
            return cached
    js = _signed_get("/iot-open/sign/certification", access_key, secret_key)
    cert = js.get("data")
    if not cert:
        raise RuntimeError(
            f"cert refused (code {js.get('code')}: {js.get('message')}) - "
            "EcoFlow throttles this endpoint; reusing cache if available"
        )
    _save_cached_cert(cert)
    return cert


def parse_solar(state: dict[str, Any], pv_field: str | None = None) -> dict[str, Any]:
    """Pure: total solar watts (sum of PV inputs) + grid power from an accumulated quota."""
    if pv_field:
        v = state.get(pv_field)
        watts = float(v) if isinstance(v, (int, float)) else None
    else:
        vals = [float(state[k]) for k in _PV_KEYS if isinstance(state.get(k), (int, float))]
        watts = round(sum(vals), 1) if vals else None
    grid = state.get("gridConnectionPower")
    grid = round(float(grid), 1) if isinstance(grid, (int, float)) else None
    return {"enabled": True, "watts_now": watts, "kwh_today": None, "grid_w": grid}


def _build_client(cert: dict[str, Any], sn: str):
    import paho.mqtt.client as mqtt

    acct = cert["certificateAccount"]
    topic = f"/open/{acct}/{sn}/quota"
    c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2,
                    client_id=f"dash_{random.randint(10000, 99999)}", protocol=mqtt.MQTTv311)
    c.username_pw_set(acct, cert["certificatePassword"])
    c.tls_set(cert_reqs=ssl.CERT_REQUIRED)          # validate the broker's TLS cert
    c.reconnect_delay_set(min_delay=2, max_delay=60)

    def on_connect(cl, userdata, flags, reason_code, properties=None):
        ok = not getattr(reason_code, "is_failure", bool(reason_code))
        _meta["connected"] = ok
        _meta["error"] = None if ok else f"connect: {reason_code}"
        # "Not authorized" means the cached certificate is stale/revoked - flag it so the
        # next loop fetches a fresh one (and only then spends a rate-limited request).
        if not ok and "auth" in str(reason_code).lower():
            _meta["cert_bad"] = True
        cl.subscribe(topic)

    def on_disconnect(cl, userdata, flags, reason_code, properties=None):
        _meta["connected"] = False

    def on_message(cl, userdata, msg):
        try:
            data = json.loads(msg.payload.decode())
            if isinstance(data, dict):
                with _lock:
                    _state.update(data)
                _meta["last_msg"] = time.time()
        except Exception:  # noqa: BLE001 - ignore a malformed frame
            pass

    c.on_connect = on_connect
    c.on_disconnect = on_disconnect
    c.on_message = on_message
    return c


def _worker_loop(access_key: str, secret_key: str, serial: str) -> None:
    """Daemon thread: keep an MQTT subscription alive, refreshing the cert periodically.

    paho's own loop handles short network blips (auto-reconnect); we rebuild the connection
    with a fresh certificate every ~45 min in case the MQTT password rotates.
    """
    backoff = 30.0
    while not _stop.is_set():
        client = None
        try:
            sn = serial or _meta.get("sn") or ""
            if not sn:
                js = _signed_get("/iot-open/sign/device/list", access_key, secret_key)
                devs = js.get("data") or []
                sn = (devs[0].get("sn") if devs else "") or ""
            if not sn:
                _meta["error"] = "no EcoFlow device on the account"
                _stop.wait(120)
                continue
            _meta["sn"] = sn
            # Reuse the cached certificate; only force a new one if the cached credentials
            # were themselves rejected (tracked below), never on a plain reconnect.
            cert = _get_cert(access_key, secret_key, force=_meta.get("cert_bad", False))
            _meta["cert_bad"] = False
            client = _build_client(cert, sn)
            client.connect(cert["url"], int(cert["port"]), keepalive=30)
            client.loop_start()
            backoff = 30.0                          # a good connect resets the backoff
            # Hold the connection while data is flowing. Don't tear down a HEALTHY session on
            # a timer: EcoFlow's certificate credentials are single-session and the REST API
            # throttles repeated cert requests (returning a bogus "some parameter is empty"),
            # after which MQTT answers "Not authorized" and solar goes dead. Only rebuild
            # when messages actually stop arriving.
            while not _stop.is_set():
                _stop.wait(60)
                last = float(_meta.get("last_msg") or 0.0)
                if not _meta.get("connected") or (last and time.time() - last > 600):
                    break                           # silent for 10 min -> reconnect
        except Exception as ex:  # noqa: BLE001 - never let the thread die
            _meta["error"] = str(ex)[:120]
            # Exponential backoff: hammering the cert endpoint every 30s is what gets the
            # account throttled in the first place.
            _stop.wait(backoff)
            backoff = min(backoff * 2, 900.0)
        finally:
            if client is not None:
                try:
                    client.loop_stop()
                    client.disconnect()
                except Exception:  # noqa: BLE001
                    pass


def start_background(cfg: dict[str, Any]) -> None:
    """Spawn the MQTT worker once, if EcoFlow is configured. Idempotent."""
    global _worker
    e = cfg.get("ecoflow") or {}
    if not (e.get("enabled") and e.get("access_key") and e.get("secret_key")):
        return
    if _worker and _worker.is_alive():
        return
    _stop.clear()
    _worker = threading.Thread(target=_worker_loop, daemon=True,
                               args=(e["access_key"], e["secret_key"], (e.get("serial") or "").strip()))
    _worker.start()


def stop() -> None:
    _stop.set()


async def fetch(cfg: dict[str, Any]) -> dict[str, Any]:
    e = (cfg.get("ecoflow") or {})
    if not (e.get("enabled") and e.get("access_key") and e.get("secret_key")):
        return {"enabled": False}
    start_background(cfg)                            # lazy-start the MQTT thread if needed
    with _lock:
        st = dict(_state)
    out = parse_solar(st, e.get("pv_field") or None)
    out["connected"] = bool(_meta.get("connected"))

    # Age the reading. The MQTT broker can drop us (EcoFlow's cert credentials are
    # single-session, and the API throttles reconnects), in which case _state keeps holding
    # whatever arrived last - previously served forever as if live, so the tile silently
    # froze on an old wattage. Past max_age we report the value as stale and blank the
    # number instead of lying about it.
    last = float(_meta.get("last_msg") or 0.0)
    age = (time.time() - last) if last else None
    max_age = float(e.get("max_age_seconds", 300))
    out["age"] = round(age, 1) if age is not None else None
    out["stale"] = bool(age is None or age > max_age)
    if out["stale"]:
        out["watts_now"] = None                      # don't present an old figure as "now"
        out["grid_w"] = None
    if _meta.get("error") and (out["stale"] or not st):
        out["error"] = _meta["error"]
    return out
