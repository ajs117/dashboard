"""EcoFlow solar-output provider (official IoT Open developer API).

Every request is HMAC-SHA256 signed: sort the request params as key=value joined by '&',
append accessKey/nonce/timestamp, sign that string with the secret key, and send the four
values as headers. We read the device's "quota" (its full live state) and pull the solar
input watts out of it.

  GET https://api-e.ecoflow.com/iot-open/sign/device/quota/all?sn=<serial>
  GET https://api-e.ecoflow.com/iot-open/sign/device/list        (to auto-find the serial)

Needs ecoflow.access_key + ecoflow.secret_key in config; the serial is optional (we take
the first device on the account when it's blank). Returns {enabled:false} until configured.
"""
from __future__ import annotations

import hashlib
import hmac
import random
import time
from typing import Any

from . import client

_BASE = "https://api-e.ecoflow.com"


def _flatten(obj: Any, prefix: str = "") -> dict[str, Any]:
    """Flatten nested params to EcoFlow's `a.b` / `a[0]` dotted form for signing."""
    out: dict[str, Any] = {}
    if isinstance(obj, dict):
        for k, v in obj.items():
            out.update(_flatten(v, f"{prefix}.{k}" if prefix else str(k)))
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            out.update(_flatten(v, f"{prefix}[{i}]"))
    elif prefix:
        out[prefix] = obj
    return out


def _sign_headers(access_key: str, secret_key: str,
                  params: dict[str, Any] | None = None) -> dict[str, str]:
    """Build the accessKey/nonce/timestamp/sign headers for a request."""
    nonce = str(random.randint(100000, 999999))
    ts = str(int(time.time() * 1000))
    flat = _flatten(params or {})
    parts = [f"{k}={flat[k]}" for k in sorted(flat)]
    parts += [f"accessKey={access_key}", f"nonce={nonce}", f"timestamp={ts}"]
    base = "&".join(parts)
    sign = hmac.new(secret_key.encode(), base.encode(), hashlib.sha256).hexdigest()
    return {"accessKey": access_key, "nonce": nonce, "timestamp": ts, "sign": sign,
            "Content-Type": "application/json;charset=UTF-8"}


def parse_solar(quota: dict[str, Any], pv_field: str | None = None) -> dict[str, Any]:
    """Pure: pull solar input watts (and today's kWh if present) from a device quota.

    The exact field depends on the device model (e.g. `inv.inputWatts`, MPPT/PV fields),
    so `pv_field` lets config point at the right one; otherwise we try common keys.
    """
    def num(key: str):
        v = quota.get(key)
        return float(v) if isinstance(v, (int, float)) else None

    candidates = [pv_field] if pv_field else [
        "mppt.pv1InputWatts", "mppt.pvInWatts", "inv.inputWatts", "pd.wattsInSum",
        "20_1.pv1InputWatts", "pv.inputWatts",
    ]
    watts = next((num(k) for k in candidates if k and num(k) is not None), None)
    if watts is not None and abs(watts) > 100000:      # some models report deciwatts
        watts /= 10.0
    for tk in ("pd.kwhDay", "pd.chgSunPower", "mppt.dayEnergy"):
        today = num(tk)
        if today is not None:
            break
    else:
        today = None
    return {"enabled": True, "watts_now": watts, "kwh_today": today}


async def _get(path: str, access_key: str, secret_key: str,
               params: dict[str, Any] | None = None) -> dict[str, Any]:
    headers = _sign_headers(access_key, secret_key, params)
    resp = await client().get(f"{_BASE}{path}", params=params or None, headers=headers)
    resp.raise_for_status()
    return resp.json()


async def fetch(cfg: dict[str, Any]) -> dict[str, Any]:
    e = (cfg.get("ecoflow") or {})
    ak, sk = e.get("access_key"), e.get("secret_key")
    if not (e.get("enabled") and ak and sk):
        return {"enabled": False}
    try:
        serial = (e.get("serial") or "").strip()
        if not serial:                                  # discover: first device on the account
            js = await _get("/iot-open/sign/device/list", ak, sk)
            devs = js.get("data") or []
            serial = (devs[0].get("sn") if devs else "") or ""
            if not serial:
                return {"enabled": True, "watts_now": None, "kwh_today": None,
                        "error": "no EcoFlow device found on the account"}
        js = await _get("/iot-open/sign/device/quota/all", ak, sk, {"sn": serial})
        if js.get("code") not in (0, "0", None):
            return {"enabled": True, "watts_now": None, "kwh_today": None,
                    "error": f"EcoFlow {js.get('code')}: {js.get('message')}"}
        return parse_solar(js.get("data") or {}, e.get("pv_field") or None)
    except Exception as ex:  # noqa: BLE001 - never break the Solar tile
        return {"enabled": True, "watts_now": None, "kwh_today": None, "error": str(ex)[:80]}
