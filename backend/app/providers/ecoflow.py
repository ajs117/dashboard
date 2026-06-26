"""EcoFlow solar-output provider.

Phase 1 ships this disabled (no API keys yet — the developer portal needs ~3–7 days to
approve access). Once `ecoflow.access_key/secret_key/serial` are set in config, Phase 2
fills in `parse_solar` + the HMAC-SHA256 signed call to
`https://api-e.ecoflow.com/iot-open/sign/device/quota/all`.

Until then `fetch` returns {"enabled": False} so the Solar tile shows a neutral state.
"""
from __future__ import annotations

from typing import Any


def parse_solar(quota: dict[str, Any], pv_field: str | None = None) -> dict[str, Any]:
    """Pure: pull solar input watts (and today's kWh if present) from a device quota.

    The exact field depends on the device model (e.g. `inv.inputWatts`, MPPT/PV fields),
    so `pv_field` lets config point at the right one; otherwise we try common keys.
    """
    def num(key: str):
        v = quota.get(key)
        return float(v) if isinstance(v, (int, float)) else None

    candidates = [pv_field] if pv_field else [
        "inv.inputWatts", "mppt.pv.inWatts", "pd.wattsInSum", "20_1.pv1InputWatts",
    ]
    watts = next((num(k) for k in candidates if k and num(k) is not None), None)
    today = num("pd.kwhDay") if "pd.kwhDay" in quota else None
    return {"enabled": True, "watts_now": watts, "kwh_today": today}


async def fetch(cfg: dict[str, Any]) -> dict[str, Any]:
    e = (cfg.get("ecoflow") or {})
    if not (e.get("enabled") and e.get("access_key") and e.get("secret_key") and e.get("serial")):
        return {"enabled": False}
    # Phase 2: build the HMAC-SHA256 signed request, GET the device quota, parse_solar(...).
    return {"enabled": False}
