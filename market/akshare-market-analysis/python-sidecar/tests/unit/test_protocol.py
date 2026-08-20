from datetime import date

import pytest

from akshare_service.protocol import (
    ProtocolError,
    json_safe,
    normalize_history_request,
    normalize_snapshot_request,
    normalize_symbol,
    parse_date,
    stable_hash,
)


def test_normalizes_market_symbols_and_dates() -> None:
    assert normalize_symbol("a-share", "600519") == "600519"
    assert normalize_symbol("hk", 700) == "00700"
    assert normalize_symbol("us", "aapl") == "AAPL"
    assert parse_date("2026-08-19", "date") == "2026-08-19"
    assert parse_date("20260819", "date") == "2026-08-19"


def test_rejects_unknown_keys_and_unsafe_values() -> None:
    with pytest.raises(ProtocolError):
        normalize_snapshot_request({"market": "a-share", "arbitrary": True})
    with pytest.raises(ProtocolError):
        normalize_snapshot_request({"market": "a-share", "filters": {"price": {"gte": float("nan")}}})
    with pytest.raises(ProtocolError):
        normalize_history_request({"market": "a-share", "symbol": "600519", "unknown": 1})
    with pytest.raises(ProtocolError):
        normalize_history_request({"market": "hk", "symbol": "123456"})
    with pytest.raises(ProtocolError):
        normalize_snapshot_request({"market": "us"})
    with pytest.raises(ProtocolError):
        normalize_history_request({"market": "us", "symbol": "AAPL", "adjust": "hfq"})
    with pytest.raises(ProtocolError):
        normalize_symbol("us", "AAPL/$")
    with pytest.raises(ProtocolError):
        parse_date("2026-02-30", "date")


def test_normalized_requests_keep_fixed_contract() -> None:
    snapshot = normalize_snapshot_request({
        "market": "hk",
        "query": "  腾讯 ",
        "filters": {"changePct": {"gte": -5, "lte": 5}},
        "sort": {"field": "amount", "direction": "desc"},
        "limit": 10,
    })
    assert snapshot["query"] == "腾讯"
    assert snapshot["filters"]["changePct"] == {"gte": -5.0, "lte": 5.0}

    analysis = normalize_history_request({
        "market": "a-share",
        "symbol": 1,
        "period": "weekly",
        "startDate": "20260101",
        "endDate": "20260819",
        "adjust": "qfq",
        "indicators": ["sma", "rsi", "sma"],
    }, analysis=True)
    assert analysis["symbol"] == "000001"
    assert analysis["indicators"] == ["sma", "rsi"]

    us_snapshot = normalize_snapshot_request({"market": "us", "query": " aapl ", "limit": 1})
    assert us_snapshot["query"] == "aapl"
    us_history = normalize_history_request({"market": "us", "symbol": "msft", "adjust": "qfq"})
    assert us_history["symbol"] == "MSFT"


def test_json_safe_and_hash_are_deterministic() -> None:
    class Scalar:
        def item(self):
            return 3.5

    assert json_safe({"scalar": Scalar(), "date": date(2026, 8, 19), "bad": float("inf")}) == {
        "scalar": 3.5,
        "date": "2026-08-19",
        "bad": None,
    }
    assert stable_hash({"b": 2, "a": 1}) == stable_hash({"a": 1, "b": 2})
