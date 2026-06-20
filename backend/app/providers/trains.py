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

        client = Client(wsdl=_WSDL)
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


_provider: RailProvider | None = None


def get_provider() -> RailProvider:
    global _provider
    if _provider is None:
        _provider = DarwinSoapProvider()
    return _provider


async def fetch(cfg: dict[str, Any]) -> dict[str, Any]:
    return await get_provider().fetch(cfg)
