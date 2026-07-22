#!/usr/bin/env python3
"""One-time Ring sign-in: captures a refresh token for the dashboard.

Run this ON THE PI, once:

    cd /data/dashboard/backend
    .venv/bin/python ../deploy/scripts/ring_auth.py

It asks for your Ring email + password, then the 2FA code Ring texts/emails you, and
writes a long-lived refresh token to the token file. The dashboard then refreshes
tokens by itself with no further 2FA prompts.

Your password is used only for this exchange and is never stored — only the resulting
token is written, 0600, to the writable data partition (never into the git repo).

Re-run it if auth ever breaks (e.g. you change your Ring password, or revoke sessions).
"""
from __future__ import annotations

import asyncio
import getpass
import json
import os
import sys
from pathlib import Path

# Import the app package so we reuse its config + token-path logic.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))

from app import config  # noqa: E402
from app.providers import ring as ring_provider  # noqa: E402

_UA = "PiDeskDashboard/1.0"


async def main() -> int:
    from ring_doorbell import Auth
    from ring_doorbell.exceptions import Requires2FAError

    config.load()
    cfg = config.get()
    dest = ring_provider._token_path(cfg)  # noqa: SLF001 - same module family

    print(f"Ring sign-in — the token will be written to:\n  {dest}\n")
    email = input("Ring email: ").strip()
    password = getpass.getpass("Ring password (not stored): ")

    auth = Auth(_UA, None, None)
    # async_fetch_token returns the token dict itself (and stores it on the Auth object).
    try:
        token = await auth.async_fetch_token(email, password)
    except Requires2FAError:
        code = input("2FA code Ring just sent you: ").strip()
        token = await auth.async_fetch_token(email, password, code)

    if not token:
        print("ERROR: signed in but could not read the token back.", file=sys.stderr)
        return 2

    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".tmp")
    tmp.write_text(json.dumps(token), encoding="utf-8")
    os.chmod(tmp, 0o600)
    os.replace(tmp, dest)

    print(f"\n✅ Token written to {dest} (0600).")
    print("Now set  ring.enabled: true  in your config.yaml and restart the backend:")
    print("   sudo systemctl restart dashboard-backend")
    try:
        await auth.async_close()
    except Exception:  # noqa: BLE001
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
