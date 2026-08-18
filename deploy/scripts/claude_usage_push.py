#!/usr/bin/env python3
"""Push Claude Pro usage to the dashboard. Runs on a machine that has Claude Code logged in.

Why a pusher instead of the Pi fetching directly: Anthropic's usage endpoint needs the
Claude Code OAuth token, and that token rotates on refresh. If the Pi held a copy and
refreshed it, the workstation's Claude Code login would be silently invalidated (and vice
versa). So only the machine that owns the login ever touches the token; the Pi receives
percentages, which are not secret.

This script deliberately NEVER refreshes the token for the same reason. If the access
token has expired it exits 2 and leaves it alone — Claude Code will refresh it itself the
next time it runs, and the next push succeeds.

Usage:
    python claude_usage_push.py --url http://<pi>:8080 --token <admin_token>
Environment fallbacks: DASHBOARD_URL, DASHBOARD_ADMIN_TOKEN, CLAUDE_CONFIG_DIR.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
OAUTH_BETA = "oauth-2025-04-20"


def credentials_path() -> Path:
    base = os.environ.get("CLAUDE_CONFIG_DIR") or (Path.home() / ".claude")
    return Path(base) / ".credentials.json"


def read_token(path: Path) -> tuple[str, str | None]:
    """(access_token, subscription_type). Raises SystemExit with a readable message."""
    try:
        blob = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise SystemExit(f"cannot read Claude credentials at {path}: {exc}")
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Claude credentials at {path} are not valid JSON: {exc}")
    oauth = blob.get("claudeAiOauth") or {}
    token = oauth.get("accessToken")
    if not token:
        raise SystemExit(f"no accessToken in {path} — is Claude Code logged in?")
    return token, oauth.get("subscriptionType")


def get_json(url: str, headers: dict[str, str], body: bytes | None = None) -> dict:
    req = urllib.request.Request(url, data=body, headers=headers,
                                 method="POST" if body is not None else "GET")
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8") or "{}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=os.environ.get("DASHBOARD_URL"),
                    help="dashboard base URL, e.g. http://192.168.11.42:8080")
    ap.add_argument("--token", default=os.environ.get("DASHBOARD_ADMIN_TOKEN"),
                    help="dashboard admin_token")
    ap.add_argument("--dry-run", action="store_true", help="print the usage, push nothing")
    args = ap.parse_args()

    access_token, plan = read_token(credentials_path())
    try:
        usage = get_json(USAGE_URL, {
            "Authorization": f"Bearer {access_token}",
            "anthropic-beta": OAUTH_BETA,
            "Accept": "application/json",
        })
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            # Expected once the access token ages out. Do NOT refresh it here.
            print("access token rejected — run Claude Code once to refresh it", file=sys.stderr)
            return 2
        print(f"usage request failed: HTTP {exc.code} {exc.reason}", file=sys.stderr)
        return 1
    except urllib.error.URLError as exc:
        print(f"usage request failed: {exc.reason}", file=sys.stderr)
        return 1

    usage["plan"] = plan          # "pro" / "max" — the endpoint itself doesn't say
    session = (usage.get("five_hour") or {}).get("utilization")
    weekly = (usage.get("seven_day") or {}).get("utilization")
    print(f"session {session}%  weekly {weekly}%  plan {plan}")

    if args.dry_run:
        return 0
    if not args.url or not args.token:
        print("need --url and --token (or DASHBOARD_URL / DASHBOARD_ADMIN_TOKEN)",
              file=sys.stderr)
        return 1

    try:
        get_json(args.url.rstrip("/") + "/api/claude-usage", {
            "Content-Type": "application/json",
            "X-Admin-Token": args.token,
        }, body=json.dumps(usage).encode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:200]
        print(f"push failed: HTTP {exc.code} {detail}", file=sys.stderr)
        return 1
    except urllib.error.URLError as exc:
        print(f"push failed: {exc.reason}", file=sys.stderr)
        return 1
    print("pushed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
