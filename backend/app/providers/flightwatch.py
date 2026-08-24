"""Watch specific flights by callsign (e.g. family travelling), anywhere in the world.

Two free sources are combined:

  * airplanes.live  /v2/callsign/{callsign}  -> live position, altitude, ground speed
  * adsbdb.com      (via providers.route)    -> origin/destination airports + coordinates

With both we can say more than "here is a dot": how far along the flight is, how far is
left, and roughly when it lands.

Coverage caveat, deliberately surfaced to the UI rather than hidden: airplanes.live is fed
by volunteer ADS-B receivers, so a flight over an ocean or a sparsely-covered landmass
simply isn't visible. "Not being tracked right now" therefore does NOT mean "not flying" -
we keep showing the route and the last known fix so a long-haul gap reads as a gap.
"""
from __future__ import annotations

import time
from typing import Any

from . import RateLimiter, client
from .geo import KM_PER_NM, MI_PER_KM, bearing, compass16, haversine_km

# Several independent community networks expose the SAME readsb "re-api" shape, so we can
# union their coverage for free just by trying each in turn. They have different feeders,
# so one often hears an aircraft the others don't - which is the whole point. Verified all
# three answer identically for a flight they can all see.
_SOURCES = [
    ("airplanes.live", "https://api.airplanes.live/v2/callsign"),
    ("adsb.lol", "https://api.adsb.lol/v2/callsign"),
    ("adsb.fi", "https://opendata.adsb.fi/api/v2/callsign"),
]
_limiter = RateLimiter(min_interval=1.05)     # these ask for <=1 req/sec

# Last known fix per callsign, so a flight that drops out of ADS-B coverage mid-ocean still
# shows where it was rather than vanishing. Bounded: a handful of watched flights only.
_last_seen: dict[str, dict[str, Any]] = {}
_MAX_REMEMBERED = 40


def normalise(callsign: str) -> str:
    return (callsign or "").strip().upper().replace(" ", "")


def progress(cur_lat: float, cur_lon: float,
             origin: dict | None, dest: dict | None) -> dict[str, Any]:
    """Pure: how far along a flight is, given its position and the two airports.

    Uses great-circle distances: flown = origin->aircraft, remaining = aircraft->destination.
    Percentage is measured against (flown + remaining) rather than the direct origin->dest
    distance, so a diversion or a long dog-leg can't report >100%.
    """
    out: dict[str, Any] = {"percent": None, "remaining_nm": None, "flown_nm": None}
    o_ok = origin and origin.get("lat") is not None and origin.get("lon") is not None
    d_ok = dest and dest.get("lat") is not None and dest.get("lon") is not None
    if d_ok:
        rem_km = haversine_km(cur_lat, cur_lon, dest["lat"], dest["lon"])
        out["remaining_nm"] = round(rem_km / KM_PER_NM)
    if o_ok:
        flown_km = haversine_km(origin["lat"], origin["lon"], cur_lat, cur_lon)
        out["flown_nm"] = round(flown_km / KM_PER_NM)
    if o_ok and d_ok:
        total = (out["flown_nm"] or 0) + (out["remaining_nm"] or 0)
        if total > 0:
            out["percent"] = max(0, min(100, round(100 * (out["flown_nm"] or 0) / total)))
    return out


def has_landed(prev: dict[str, Any] | None, live: dict[str, Any] | None,
               remaining_nm: float | None, now: float | None = None) -> bool:
    """Pure: is this flight finished?

    Only ever true for a flight we actually watched get airborne - otherwise a callsign
    entered before departure (sitting on stand) would instantly read as "landed".

    Two ways to finish:
      * we can see it on the ground close to its destination, or
      * it was near destination and then dropped off ADS-B for a good while, which is what
        landing looks like when the destination has poor low-level coverage.
    """
    if not prev or not prev.get("seen_airborne"):
        return False
    now = now if now is not None else time.time()
    if live is not None:
        on_ground = (live.get("altitude") or 0) <= 500
        return bool(on_ground and remaining_nm is not None and remaining_nm < 30)
    quiet_min = (now - float(prev.get("seen_at") or 0)) / 60.0
    was_close = prev.get("remaining_nm") is not None and prev["remaining_nm"] < 80
    return bool(quiet_min > 25 and was_close)


def eta_minutes(remaining_nm: float | None, ground_speed_kt: float | None) -> int | None:
    """Pure: minutes to destination at the current ground speed.

    Deliberately crude - it ignores descent, holding and taxi - so the UI labels it as an
    estimate. Below 80kt the aircraft is manoeuvring or on the ground and the figure would
    be nonsense, so return nothing rather than a wild number.
    """
    if not remaining_nm or not ground_speed_kt or ground_speed_kt < 80:
        return None
    return int(round(remaining_nm / ground_speed_kt * 60))


def _shape(ac: dict[str, Any], home_lat: float, home_lon: float) -> dict[str, Any]:
    """Live position fields for one aircraft, plus where to look from home."""
    lat, lon = ac.get("lat"), ac.get("lon")
    alt = ac.get("alt_baro")
    if alt == "ground":
        alt = 0
    out = {
        "hex": ac.get("hex"),
        "registration": ac.get("r"),
        "type": ac.get("t"),
        "type_name": ac.get("desc"),
        "lat": lat,
        "lon": lon,
        "altitude": alt if isinstance(alt, (int, float)) else None,
        "speed": ac.get("gs"),
        "heading": ac.get("track"),
        "squawk": ac.get("squawk"),
    }
    if lat is not None and lon is not None:
        km = haversine_km(home_lat, home_lon, lat, lon)
        brg = bearing(home_lat, home_lon, lat, lon)
        out["distance_mi"] = round(km * MI_PER_KM)
        out["distance_nm"] = round(km / KM_PER_NM)
        out["compass"] = compass16(brg)
    return out


async def _lookup(callsign: str) -> tuple[dict[str, Any], str] | None:
    """First network that can actually hear this callsign wins.

    Each source is tried in turn and a single failure never aborts the search - one being
    down or answering with junk (adsb.lol has been seen returning a non-JSON body) must not
    cost us a hit from the others.
    """
    got_valid_response = False
    last_error: Exception | None = None
    for name, base in _SOURCES:
        try:
            await _limiter.wait()
            resp = await client().get(f"{base}/{callsign}")
            if resp.status_code != 200:
                last_error = RuntimeError(f"{name} returned HTTP {resp.status_code}")
                continue
            body = resp.json()
            if not isinstance(body, dict):
                raise TypeError(f"{name} returned a non-object response")
            got_valid_response = True
            for ac in body.get("ac") or []:
                if ac.get("lat") is not None and ac.get("lon") is not None:
                    return ac, name
        except Exception as exc:  # noqa: BLE001 - try the next network
            last_error = exc
            continue
    # A valid empty response means the flight genuinely is not being heard. If every
    # provider failed, propagate that distinction so callers cannot infer "landed" from
    # a network outage and permanently latch the wrong state.
    if not got_valid_response:
        raise RuntimeError(f"all ADS-B sources failed: {last_error}") from last_error
    return None


async def fetch(cfg: dict[str, Any]) -> dict[str, Any]:
    from . import route as route_provider

    loc = cfg.get("location", {})
    home_lat = float(loc.get("lat") or 0.0)
    home_lon = float(loc.get("lon") or 0.0)
    wanted = [normalise(c) for c in (cfg.get("watch_flights") or []) if normalise(c)]

    # Forget callsigns that are no longer watched, so removing a flight and adding it again
    # later starts clean rather than resurrecting an old "landed" verdict.
    for gone in [k for k in _last_seen if k not in wanted]:
        _last_seen.pop(gone, None)

    flights: list[dict[str, Any]] = []
    for cs in wanted:
        entry: dict[str, Any] = {"callsign": cs, "status": "unknown"}
        prev = _last_seen.get(cs)

        # Finished flights stop costing upstream lookups entirely: the panel just reports
        # the result until a new flight number is set.
        if prev and prev.get("landed"):
            entry.update({k: v for k, v in prev.items() if k != "status"})
            entry["status"] = "landed"
            try:
                entry["route"] = await route_provider.fetch(cs)
            except Exception:  # noqa: BLE001
                entry["route"] = None
            flights.append(entry)
            continue
        # Route first: it's useful even when the aircraft isn't currently being tracked,
        # and it's what makes the panel readable ("Hong Kong -> London").
        try:
            entry["route"] = await route_provider.fetch(cs)
        except Exception:  # noqa: BLE001 - route is a nicety, never fail the panel for it
            entry["route"] = None
        # Query the ICAO callsign the aircraft actually transmits (CPA255), not the IATA
        # flight number people quote (CX255) - the latter never matches ADS-B. Try both,
        # ICAO first, so either form can be typed on the remote page.
        rt0 = entry.get("route") or {}
        candidates = []
        for c in (rt0.get("callsign_icao"), cs, rt0.get("callsign_iata")):
            c = normalise(c or "")
            if c and c not in candidates:
                candidates.append(c)
        entry["query_callsign"] = candidates[0] if candidates else cs
        try:
            ac = None
            for cand in candidates:
                found = await _lookup(cand)
                if found:
                    ac, entry["source"] = found
                    entry["query_callsign"] = cand
                    break
        except Exception as exc:  # noqa: BLE001
            entry["status"] = "error"
            entry["error"] = str(exc)[:120]
            flights.append(entry)
            continue

        if ac:
            live = _shape(ac, home_lat, home_lon)
            entry.update(live)
            airborne = (live.get("altitude") or 0) > 500
            entry["status"] = "airborne" if airborne else "ground"
            rt = entry.get("route") or {}
            prog = progress(live["lat"], live["lon"], rt.get("origin"), rt.get("destination"))
            entry.update(prog)
            entry["eta_minutes"] = eta_minutes(prog.get("remaining_nm"), live.get("speed"))
            entry["seen_at"] = time.time()
            entry["seen_airborne"] = bool(airborne or (prev or {}).get("seen_airborne"))
            if has_landed(prev, live, prog.get("remaining_nm")):
                entry["status"] = "landed"
                entry["landed"] = True
            _last_seen[cs] = {k: entry[k] for k in entry if k != "route"}
            if len(_last_seen) > _MAX_REMEMBERED:
                oldest = min(_last_seen, key=lambda k: _last_seen[k].get("seen_at", 0))
                _last_seen.pop(oldest, None)
        else:
            # No current fix. Show the last one we had (with its age) so a mid-ocean
            # coverage gap is obviously a gap rather than the flight disappearing.
            entry["status"] = "not_tracked"
            if prev:
                entry.update({k: v for k, v in prev.items() if k != "status"})
                if has_landed(prev, None, prev.get("remaining_nm")):
                    entry["status"] = "landed"
                    entry["landed"] = True
                    _last_seen[cs] = {**prev, "landed": True}
                else:
                    entry["status"] = "stale"
                    entry["last_seen_minutes"] = int((time.time() - prev.get("seen_at", 0)) / 60)
        flights.append(entry)

    return {"flights": flights, "count": len(flights)}
