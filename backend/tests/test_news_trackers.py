"""News RSS parsing + custom tracker value/alert/ack logic (no network)."""
from __future__ import annotations

import asyncio

import pytest

from app.providers import news
from app import trackers


def test_news_parse_titles_and_entities():
    xml = (
        "<rss><channel>"
        "<item><title>Big &amp; bold</title><link>http://x/1</link></item>"
        "<item><title>No link</title></item>"
        "<item><title></title><link>http://x/3</link></item>"  # skipped: empty title
        "</channel></rss>"
    )
    out = news.parse(xml, scope="UK")
    assert out == [
        {"title": "Big & bold", "link": "http://x/1", "scope": "UK"},
        {"title": "No link", "link": "", "scope": "UK"},
    ]


def test_news_parse_caps_per_feed():
    items = "".join(f"<item><title>h{i}</title></item>" for i in range(50))
    out = news.parse(f"<rss><channel>{items}</channel></rss>")
    assert len(out) == news._PER_FEED


def test_news_interleave_dedupes_and_rounds_robin():
    uk = [{"title": "A", "link": "", "scope": "UK"}, {"title": "Dup", "link": "", "scope": "UK"}]
    world = [{"title": "B", "link": "", "scope": "World"}, {"title": "Dup", "link": "", "scope": "World"}]
    out = news.interleave([uk, world])
    titles = [i["title"] for i in out]
    assert titles == ["A", "B", "Dup"]   # round-robin, duplicate title kept once


@pytest.fixture
def fresh_trackers(tmp_path, monkeypatch):
    # Isolate persistence + module state per test.
    monkeypatch.setattr(trackers, "_state_path", lambda: tmp_path / "trackers_state.json")
    monkeypatch.setattr(trackers, "_state", {})
    monkeypatch.setattr(trackers, "_loaded", False)
    return trackers


def test_tracker_first_value_no_alert(fresh_trackers):
    async def go():
        await fresh_trackers.set_value("holiday", 1000.0)
        pub = await fresh_trackers.list_public()
        h = pub["trackers"][0]
        assert h["value"] == 1000.0
        assert h["baseline"] == 1000.0
        assert h["change"] == 0.0
        assert h["alert"] is None
        assert pub["alert"] is False
    asyncio.run(go())


def test_tracker_change_raises_alert(fresh_trackers):
    async def go():
        await fresh_trackers.set_value("holiday", 1000.0)
        await fresh_trackers.set_value("holiday", 940.0)
        pub = await fresh_trackers.list_public()
        h = pub["trackers"][0]
        assert h["alert"]["active"] is True
        assert h["alert"]["direction"] == "down"
        assert h["alert"]["delta"] == -60.0
        assert h["change"] == -60.0          # vs baseline 1000
        assert pub["alert"] is True
    asyncio.run(go())


def test_tracker_ack_clears_alert(fresh_trackers):
    async def go():
        await fresh_trackers.set_value("holiday", 1000.0)
        await fresh_trackers.set_value("holiday", 1100.0)
        await fresh_trackers.ack("holiday")
        pub = await fresh_trackers.list_public()
        assert pub["trackers"][0]["alert"]["active"] is False
        assert pub["alert"] is False
    asyncio.run(go())


def test_tracker_unknown_id(fresh_trackers):
    async def go():
        with pytest.raises(KeyError):
            await fresh_trackers.set_value("nope", 1.0)
    asyncio.run(go())
