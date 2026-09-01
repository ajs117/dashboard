"""National Rail departures.

`RailProvider` is the interface; `DarwinSoapProvider` implements it against the legacy
OpenLDBWS SOAP service. When the Rail Data Marketplace REST API replaces the SOAP token,
add a `RailDataMarketplaceProvider` with the same `.fetch()` shape and switch in `get_provider`.

zeep is synchronous, so calls run in a worker thread via asyncio.to_thread.
"""
from __future__ import annotations

import asyncio
import re
import time
from abc import ABC, abstractmethod
from typing import Any

_TAG_RE = re.compile(r"<[^>]+>")
_HHMM = re.compile(r"^\d{1,2}:\d{2}$")


def shift(t: str | None, mins: int) -> str | None:
    """Clock time `t` moved on by `mins`, wrapping past midnight."""
    if not _HHMM.match(t or "") or not mins:
        return t
    h, m = (int(x) for x in t.split(":"))
    v = (h * 60 + m + mins) % 1440
    return f"{v // 60:02d}:{v % 60:02d}"


def _gap(a: str | None, b: str | None) -> int:
    """Whole minutes from clock time `a` to `b`, 0 if either isn't a time."""
    if not (_HHMM.match(a or "") and _HHMM.match(b or "")):
        return 0
    ha, ma = (int(x) for x in a.split(":"))
    hb, mb = (int(x) for x in b.split(":"))
    d = (hb * 60 + mb) - (ha * 60 + ma)
    return d if 0 < d < 60 else 0


def _strip_html(text: str) -> str:
    return _TAG_RE.sub("", text or "").strip()

_WSDL = "https://lite.realtime.nationalrail.co.uk/OpenLDBWS/wsdl.aspx?ver=2021-11-01"
_TOKEN_NS = "http://thalesgroup.com/RTTI/2013-11-28/Token/types"


class RailProvider(ABC):
    @abstractmethod
    async def fetch(self, cfg: dict[str, Any]) -> dict[str, Any]:
        ...

    @abstractmethod
    async def fetch_service(self, cfg: dict[str, Any], service_id: str) -> dict[str, Any]:
        ...


class DarwinSoapProvider(RailProvider):
    def __init__(self) -> None:
        self._client = None
        self._header = None
        self._token = None

    def _ensure_client(self, token: str):
        # (Re)build the zeep client if missing or the token changed.
        if self._client is not None and self._token == token:
            return
        from zeep import Client, xsd  # imported lazily so the app starts without it
        from zeep.transports import Transport

        # Bound both WSDL loading and SOAP operations. The call runs in a worker thread,
        # but an unbounded socket would still occupy that worker forever after an outage.
        client = Client(wsdl=_WSDL, transport=Transport(timeout=10, operation_timeout=15))
        header = xsd.Element(
            f"{{{_TOKEN_NS}}}AccessToken",
            xsd.ComplexType([
                xsd.Element(f"{{{_TOKEN_NS}}}TokenValue", xsd.String()),
            ]),
        )
        self._client = client
        self._header = header(TokenValue=token)
        self._token = token

    def _call(self, cfg: dict[str, Any]) -> dict[str, Any]:
        from zeep.helpers import serialize_object

        trains = cfg.get("trains", {})
        token = trains.get("token") or ""
        crs = trains.get("station_crs")
        rows = int(trains.get("rows", 10))
        dest = (trains.get("destination_crs") or "").strip() or None

        self._ensure_client(token)
        kwargs: dict[str, Any] = {"numRows": rows, "crs": crs}
        if dest:
            kwargs["filterCrs"] = dest
            kwargs["filterType"] = "to"
        board = self._client.service.GetDepBoardWithDetails(
            _soapheaders=[self._header], **kwargs
        )
        return self._parse(serialize_object(board))

    @staticmethod
    def _parse(board: dict[str, Any]) -> dict[str, Any]:
        services_raw = ((board.get("trainServices") or {}).get("service")) or []
        services = []
        for s in services_raw:
            dest = ((s.get("destination") or {}).get("location")) or []
            dest_name = dest[0].get("locationName") if dest else None
            calling = []
            cps = ((s.get("subsequentCallingPoints") or {}).get("callingPointList")) or []
            if cps:
                for cp in (cps[0].get("callingPoint") or []):
                    calling.append({
                        "name": cp.get("locationName"),
                        "st": cp.get("st"),
                        "et": cp.get("et"),
                    })
            services.append({
                "service_id": s.get("serviceID"),   # opaque Darwin handle; needed to watch it
                "std": s.get("std"),            # scheduled departure
                "etd": s.get("etd"),            # estimated/expected ("On time", "Delayed", time)
                "platform": s.get("platform"),
                "operator": s.get("operator"),
                "destination": dest_name,
                "cancelled": s.get("isCancelled") or False,
                "cancel_reason": s.get("cancelReason"),
                "delay_reason": s.get("delayReason"),
                "calling_points": calling,
            })
        nrcc = ((board.get("nrccMessages") or {}).get("message")) or []
        messages = []
        for m in nrcc:
            # message can be a dict with '_value_1' or a plain string
            if isinstance(m, dict):
                raw = m.get("_value_1") or m.get("value") or str(m)
            else:
                raw = str(m)
            cleaned = _strip_html(raw)
            if cleaned:
                messages.append(cleaned)
        return {
            "station": board.get("locationName"),
            "crs": board.get("crs"),
            "generated_at": str(board.get("generatedAt")) if board.get("generatedAt") else None,
            "platform_available": board.get("platformAvailable") or False,
            "messages": messages,
            "services": services,
        }

    async def fetch(self, cfg: dict[str, Any]) -> dict[str, Any]:
        return await asyncio.to_thread(self._call, cfg)

    # --- following one service ------------------------------------------------------
    @staticmethod
    def _stop(cp: dict[str, Any], scheduled: str | None = None,
              est: str | None = None, act: str | None = None) -> dict[str, Any]:
        st = scheduled if scheduled is not None else cp.get("st")

        # Darwin writes "On time" into the time fields instead of a clock value, including
        # into `at` for a stop already made. Left as-is that is not a time, so the journey
        # reads as never having reached those stops - the progress marker sticks at the
        # last incidentally-late station. On time means it happened at the scheduled time.
        def clock(v: str | None) -> str | None:
            return st if (v or "").strip().lower() == "on time" and st else v

        return {
            "name": cp.get("locationName"),
            "crs": cp.get("crs"),
            "st": st,
            "et": clock(est if est is not None else cp.get("et")),
            "at": clock(act if act is not None else cp.get("at")),
            "cancelled": bool(cp.get("isCancelled")),
        }

    @classmethod
    def _points(cls, block: dict[str, Any] | None) -> list[dict[str, Any]]:
        lists = ((block or {}).get("callingPointList")) or []
        out = []
        for lst in lists:
            for cp in (lst.get("callingPoint") or []):
                out.append(cls._stop(cp))
        return out

    def _call_service(self, cfg: dict[str, Any], service_id: str) -> dict[str, Any]:
        from zeep.helpers import serialize_object

        token = (cfg.get("trains") or {}).get("token") or ""
        self._ensure_client(token)
        d = serialize_object(self._client.service.GetServiceDetails(
            _soapheaders=[self._header], serviceID=service_id))
        return self._parse_service(d, service_id)

    @classmethod
    def _parse_service(cls, d: dict[str, Any], service_id: str) -> dict[str, Any]:
        # The board station sits BETWEEN its previous and subsequent calling points, and is
        # the only stop whose times arrive as flat fields rather than in a calling-point list.
        here = cls._stop(d, scheduled=d.get("std") or d.get("sta"),
                         est=d.get("etd") or d.get("eta"),
                         act=d.get("atd") or d.get("ata"))
        stops = cls._points(d.get("previousCallingPoints")) + [here] \
            + cls._points(d.get("subsequentCallingPoints"))
        origin = ((d.get("origin") or {}).get("location") or [{}])[0]
        dest = ((d.get("destination") or {}).get("location") or [{}])[0]
        # Darwin leaves origin/destination null on some services; the route we just built
        # already knows both ends, so fall back to it rather than showing a blank header.
        first, last = (stops[0] if stops else {}), (stops[-1] if stops else {})
        return {
            "service_id": service_id,
            "operator": d.get("operator"),
            "platform": d.get("platform"),
            "cancelled": bool(d.get("isCancelled")),
            "cancel_reason": _strip_html(d.get("cancelReason") or "") or None,
            "delay_reason": _strip_html(d.get("delayReason") or "") or None,
            "overdue": _strip_html(d.get("overdueMessage") or "") or None,
            "board_crs": d.get("crs"),
            "origin": origin.get("locationName") or first.get("name"),
            "origin_crs": origin.get("crs") or first.get("crs"),
            "destination": dest.get("locationName") or last.get("name"),
            "destination_crs": dest.get("crs") or last.get("crs"),
            "generated_at": str(d.get("generatedAt")) if d.get("generatedAt") else None,
            "stops": stops,
        }

    async def fetch_service(self, cfg: dict[str, Any], service_id: str) -> dict[str, Any]:
        return await asyncio.to_thread(self._call_service, cfg, service_id)

    # --- departure times ---------------------------------------------------------------
    # A calling point carries only the ARRIVAL time; National Rail's own boards show the
    # departure, which at a stop with a dwell is a minute or two later. The only place
    # LDBWS publishes a departure for an intermediate stop is that station's own arr/dep
    # board, so each one costs a separate call - hence the hour-long cache. The dwell is a
    # timetable property; lateness is carried by `et`/`at` and is not baked in here.
    def _call_dwells(self, cfg: dict[str, Any], targets: list[dict[str, Any]],
                     destination: str | None) -> dict[str, int]:
        from zeep.helpers import serialize_object

        token = (cfg.get("trains") or {}).get("token") or ""
        self._ensure_client(token)
        out: dict[str, int] = {}
        for t in targets:
            crs, sta = t.get("crs"), t.get("st")
            if not crs or not _HHMM.match(sta or ""):
                continue
            try:
                b = serialize_object(self._client.service.GetArrDepBoardWithDetails(
                    _soapheaders=[self._header], numRows=25, crs=crs))
            except Exception:  # noqa: BLE001 - one unreachable station shouldn't lose the rest
                continue
            for svc in ((b.get("trainServices") or {}).get("service") or []):
                loc = ((svc.get("destination") or {}).get("location") or [{}])[0]
                if svc.get("sta") != sta or (
                        destination and loc.get("locationName") != destination):
                    continue
                gap = _gap(sta, svc.get("std"))
                if gap:
                    out[crs] = gap
                break
        return out

    async def fetch_dwells(self, cfg: dict[str, Any], targets: list[dict[str, Any]],
                           destination: str | None) -> dict[str, int]:
        return await asyncio.to_thread(self._call_dwells, cfg, targets, destination)


_provider: RailProvider | None = None


def get_provider() -> RailProvider:
    global _provider
    if _provider is None:
        _provider = DarwinSoapProvider()
    return _provider


async def fetch(cfg: dict[str, Any]) -> dict[str, Any]:
    return await get_provider().fetch(cfg)


async def fetch_service(cfg: dict[str, Any], service_id: str) -> dict[str, Any]:
    return await get_provider().fetch_service(cfg, service_id)


_DWELL_TTL = 3600.0
_dwells: dict[str, tuple[float, dict[str, int]]] = {}
_dwell_busy: set[str] = set()


def dwell_map(service_id: str) -> dict[str, int]:
    got = _dwells.get(service_id)
    return dict(got[1]) if got and time.time() - got[0] < _DWELL_TTL else {}


def ensure_dwells(cfg: dict[str, Any], service_id: str, targets: list[dict[str, Any]],
                  destination: str | None) -> None:
    """Start filling the dwell map if it isn't already known.

    Deliberately fire-and-forget: it is a dozen SOAP calls, and blocking the watch on it
    would leave the board empty for ten seconds every time a train is pushed. The next
    30-second poll picks the answer up.
    """
    if service_id in _dwell_busy or dwell_map(service_id):
        return
    _dwell_busy.add(service_id)

    async def run() -> None:
        try:
            got = await get_provider().fetch_dwells(cfg, targets, destination)
            _dwells[service_id] = (time.time(), got)
        except Exception:  # noqa: BLE001 - departures are a nicety; the board still works
            pass
        finally:
            _dwell_busy.discard(service_id)

    asyncio.get_running_loop().create_task(run())
