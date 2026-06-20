"""Darwin board parsing — tests the pure _parse() with a serialized-board shape.

This is the highest-value train test: it validates the brittle nested SOAP structure
without needing network or the zeep client.
"""
from __future__ import annotations

from app.providers.trains import DarwinSoapProvider

SAMPLE_BOARD = {
    "locationName": "London Kings Cross",
    "crs": "KGX",
    "generatedAt": "2026-06-20T09:00:00",
    "platformAvailable": True,
    "nrccMessages": {"message": [{"_value_1": "Reduced service today."}]},
    "trainServices": {
        "service": [
            {
                "std": "09:06",
                "etd": "On time",
                "platform": "1",
                "operator": "LNER",
                "isCancelled": False,
                "destination": {"location": [{"locationName": "Edinburgh"}]},
                "subsequentCallingPoints": {
                    "callingPointList": [
                        {"callingPoint": [
                            {"locationName": "Stevenage", "st": "09:25", "et": "On time"},
                            {"locationName": "York", "st": "10:55", "et": "10:58"},
                        ]}
                    ]
                },
            },
            {
                "std": "09:12",
                "etd": "Cancelled",
                "platform": None,
                "operator": "Thameslink",
                "isCancelled": True,
                "cancelReason": "a fault with the train",
                "destination": {"location": [{"locationName": "Cambridge"}]},
                "subsequentCallingPoints": None,
            },
        ]
    },
}


def test_parse_board():
    out = DarwinSoapProvider._parse(SAMPLE_BOARD)
    assert out["station"] == "London Kings Cross"
    assert out["crs"] == "KGX"
    assert out["messages"] == ["Reduced service today."]
    assert len(out["services"]) == 2

    first = out["services"][0]
    assert first["destination"] == "Edinburgh"
    assert first["etd"] == "On time"
    assert first["platform"] == "1"
    assert len(first["calling_points"]) == 2
    assert first["calling_points"][1]["name"] == "York"

    second = out["services"][1]
    assert second["cancelled"] is True
    assert second["cancel_reason"] == "a fault with the train"
    assert second["calling_points"] == []


def test_parse_empty_board():
    out = DarwinSoapProvider._parse({"locationName": "Nowhere", "crs": "XXX"})
    assert out["services"] == []
    assert out["messages"] == []
