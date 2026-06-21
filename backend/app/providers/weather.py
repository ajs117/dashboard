"""Open-Meteo weather provider (no API key required)."""
from __future__ import annotations

from typing import Any

from . import client
from . import moon
from .geo import compass16 as _compass

_URL = "https://api.open-meteo.com/v1/forecast"

# WMO weather interpretation codes -> short text + emoji-ish label.
WMO = {
    0: "Clear", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Fog", 48: "Rime fog", 51: "Light drizzle", 53: "Drizzle",
    55: "Dense drizzle", 56: "Freezing drizzle", 57: "Freezing drizzle",
    61: "Light rain", 63: "Rain", 65: "Heavy rain", 66: "Freezing rain",
    67: "Freezing rain", 71: "Light snow", 73: "Snow", 75: "Heavy snow",
    77: "Snow grains", 80: "Light showers", 81: "Showers", 82: "Violent showers",
    85: "Snow showers", 86: "Snow showers", 95: "Thunderstorm",
    96: "Thunderstorm + hail", 99: "Thunderstorm + hail",
}


async def fetch(cfg: dict[str, Any]) -> dict[str, Any]:
    loc = cfg.get("location", {})
    units = cfg.get("units", {})
    params = {
        "latitude": loc.get("lat"),
        "longitude": loc.get("lon"),
        "timezone": loc.get("timezone", "auto"),
        "current": "temperature_2m,relative_humidity_2m,apparent_temperature,"
                   "dew_point_2m,is_day,weather_code,wind_speed_10m,wind_direction_10m,"
                   "wind_gusts_10m",
        "daily": "weather_code,temperature_2m_max,temperature_2m_min,"
                 "precipitation_probability_max,sunrise,sunset",
        "forecast_days": 5,
        "temperature_unit": units.get("temperature", "celsius"),
        "wind_speed_unit": units.get("wind", "kmh"),
    }
    resp = await client().get(_URL, params=params)
    resp.raise_for_status()
    raw = resp.json()

    current = raw.get("current", {})
    cur_code = current.get("weather_code")
    daily = raw.get("daily", {})

    def at(key: str, i: int):
        """Index a daily array safely: a partially-missing field shouldn't crash the day."""
        arr = daily.get(key) or []
        return arr[i] if i < len(arr) else None

    days = []
    for i, date in enumerate(daily.get("time", [])):
        code = at("weather_code", i)
        days.append({
            "date": date,
            "code": code,
            "text": WMO.get(code, "—"),
            "tmax": at("temperature_2m_max", i),
            "tmin": at("temperature_2m_min", i),
            "precip_prob": at("precipitation_probability_max", i),
            "sunrise": at("sunrise", i),
            "sunset": at("sunset", i),
        })

    today = days[0] if days else {}
    return {
        "label": loc.get("label", ""),
        "sun": {
            "sunrise": today.get("sunrise"),
            "sunset": today.get("sunset"),
        },
        "moon": moon.phase(),
        "units": {
            "temperature": raw.get("current_units", {}).get("temperature_2m", "°"),
            "wind": raw.get("current_units", {}).get("wind_speed_10m", ""),
        },
        "current": {
            "temperature": current.get("temperature_2m"),
            "apparent": current.get("apparent_temperature"),
            "humidity": current.get("relative_humidity_2m"),
            "dew_point": current.get("dew_point_2m"),
            "is_day": bool(current.get("is_day", 1)),
            "code": cur_code,
            "text": WMO.get(cur_code, "—"),
            "wind_speed": current.get("wind_speed_10m"),
            "wind_gust": current.get("wind_gusts_10m"),
            "wind_dir": current.get("wind_direction_10m"),
            "wind_compass": _compass(current.get("wind_direction_10m")),
        },
        "daily": days,
    }
