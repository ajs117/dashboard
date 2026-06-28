"""Hive heating -> indoor temperature provider.

Hive has no official API and the account uses 2FA, so we can't do a headless username/
password (SRP) login. Instead we hold a long-lived Cognito **refresh token** (captured once
from the Hive web app) and mint a fresh short-lived idToken on demand — refreshing needs no
SRP and no 2FA. The idToken then authorises Hive's data API:

  POST https://cognito-idp.eu-west-1.amazonaws.com/   (REFRESH_TOKEN_AUTH) -> IdToken
  GET  https://beekeeper-uk.hivehome.com/1.0/nodes/all  (authorization: <IdToken>)

The response carries `products[]`; the main thermostat is `type == "heating"` with
`props.temperature` (current indoor °C) + `state.target`/`state.mode`. Verified live.
"""
from __future__ import annotations

import time
from typing import Any

from . import client

# Hive's public web Cognito client (not a secret — it ships in the browser app).
_COGNITO = "https://cognito-idp.eu-west-1.amazonaws.com/"
_CLIENT_ID = "jivhemv3fvn8cr32qrggqpcf8"
_NODES = "https://beekeeper-uk.hivehome.com/1.0/nodes/all"

# Cache the minted idToken so we don't refresh on every poll (idTokens last ~1h).
_tok: dict[str, Any] = {"id": None, "exp": 0.0}


def parse_indoor(js: dict[str, Any]) -> dict[str, Any]:
    """Pure: average the temperature across all Hive products (thermostat + room TRVs).

    Every heating product (`type` heating/trvcontrol) reports `props.temperature`; the
    house "indoor" reading is the mean of them all. Returns the average and the room count.
    """
    products = js.get("products") or []
    temps = [
        float((p.get("props") or {}).get("temperature"))
        for p in products
        if isinstance((p.get("props") or {}).get("temperature"), (int, float))
    ]
    if not temps:
        return {"enabled": True, "temperature_c": None, "rooms": 0}
    return {"enabled": True, "temperature_c": round(sum(temps) / len(temps), 1),
            "rooms": len(temps)}


async def _id_token(refresh_token: str) -> str | None:
    now = time.time()
    if _tok["id"] and _tok["exp"] - 300 > now:    # reuse until ~5 min before expiry
        return _tok["id"]
    resp = await client().post(
        _COGNITO,
        headers={"content-type": "application/x-amz-json-1.1",
                 "x-amz-target": "AWSCognitoIdentityProviderService.InitiateAuth"},
        json={"AuthFlow": "REFRESH_TOKEN_AUTH", "ClientId": _CLIENT_ID,
              "AuthParameters": {"REFRESH_TOKEN": refresh_token}},
    )
    resp.raise_for_status()
    res = resp.json().get("AuthenticationResult", {}) or {}
    _tok["id"] = res.get("IdToken")
    _tok["exp"] = now + float(res.get("ExpiresIn", 3600))
    return _tok["id"]


async def fetch(cfg: dict[str, Any]) -> dict[str, Any]:
    h = (cfg.get("hive") or {})
    if not (h.get("enabled") and h.get("refresh_token")):
        return {"enabled": False}
    token = await _id_token(h["refresh_token"])
    if not token:
        return {"enabled": True, "temperature_c": None, "target_c": None, "mode": None}
    resp = await client().get(_NODES, headers={"authorization": token})
    resp.raise_for_status()
    return parse_indoor(resp.json())
