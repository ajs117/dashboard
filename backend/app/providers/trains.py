"""National Rail departures.

`RailProvider` is the interface; `DarwinSoapProvider` implements it against the legacy
OpenLDBWS SOAP service. When the Rail Data Marketplace REST API replaces the SOAP token,
add a `RailDataMarketplaceProvider` with the same `.fetch()` shape and switch in `get_provider`.

zeep is synchronous, so calls run in a worker thread via asyncio.to_thread.
"""
from __future__ import annotations

import asyncio
import re
from abc import ABC, abstractmethod
from typing import Any

_TAG_RE = re.compile(r"<[^>]+>")


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
