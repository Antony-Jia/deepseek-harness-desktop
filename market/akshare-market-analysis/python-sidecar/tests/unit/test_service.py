from datetime import date, timedelta

from akshare_service.service import MarketService


class FixtureProvider:
    version = "fixture-akshare"

    def __init__(self):
        self.snapshot_calls = 0
        self.history_calls = 0

    def snapshot(self, market):
        self.snapshot_calls += 1
        return [
            {"代码": "600519", "名称": "贵州茅台", "最新价": 1700, "涨跌幅": 2.5, "成交额": 9000},
            {"代码": "000001", "名称": "平安银行", "最新价": 10, "涨跌幅": -1.2, "成交额": 1000},
        ]

    def history(self, market, symbol, period, start_date, end_date, adjust):
        self.history_calls += 1
        return [
            {"日期": (date(2026, 6, 1) + timedelta(days=index)).isoformat(), "开盘": index, "最高": index + 1, "最低": index - 1, "收盘": index + 0.5, "成交量": index * 10}
            for index in range(1, 75)
        ]


def test_snapshot_filter_sort_limit_and_cache(tmp_path) -> None:
    provider = FixtureProvider()
    service = MarketService(provider=provider, cache_dir=tmp_path / "cache")
    request = {
        "market": "a-share",
        "query": "",
        "filters": {"changePct": {"gte": 0}},
        "sort": {"field": "amount", "direction": "desc"},
        "limit": 1,
    }
    result = service.snapshot(request)
    assert result["rows"][0]["symbol"] == "600519"
    assert result["truncated"] is False
    assert result["cache"]["hit"] is False
    cached = service.snapshot(request)
    assert cached["cache"]["hit"] is True
    assert provider.snapshot_calls == 1


def test_history_is_bounded_and_analysis_is_descriptive(tmp_path) -> None:
    provider = FixtureProvider()
    service = MarketService(provider=provider, cache_dir=tmp_path / "cache")
    result = service.analysis({
        "market": "a-share",
        "symbol": "600519",
        "startDate": "2026-08-01",
        "endDate": "2026-08-19",
        "maxBars": 60,
        "indicators": ["sma", "macd", "rsi", "boll", "volume-ma", "atr"],
    })
    assert result["kind"] == "analysis"
    assert len(result["bars"]) == 60
    assert result["quality"]["truncated"] is True
    assert set(("trend", "momentum", "volatility", "volumePrice", "warnings")) <= set(result["analysisSummary"])
    assert result["metrics"]["latestClose"] is not None
    assert provider.history_calls == 1
