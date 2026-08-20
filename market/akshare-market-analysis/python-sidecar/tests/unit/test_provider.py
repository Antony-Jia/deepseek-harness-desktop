from akshare_service.provider import AkShareProvider


class Frame:
    def __init__(self, rows):
        self.rows = rows

    @property
    def empty(self):
        return not self.rows

    def to_dict(self, orient=None):
        assert orient == "records"
        return self.rows


class FakeAkShare:
    __version__ = "fixture"

    def __init__(self):
        self.calls = []

    def stock_zh_a_daily(self, **kwargs):
        self.calls.append(("stock_zh_a_daily", kwargs))
        return Frame([{"date": "2026-08-19", "open": 1, "high": 2, "low": 1, "close": 1.5}])

    def stock_zh_a_hist_tx(self, **kwargs):
        self.calls.append(("stock_zh_a_hist_tx", kwargs))
        return Frame([])

    def stock_us_daily(self, **kwargs):
        self.calls.append(("stock_us_daily", kwargs))
        return Frame([
            {"date": "2026-08-18", "open": 220, "high": 225, "low": 219, "close": 223},
            {"date": "2026-08-19", "open": 224, "high": 228, "low": 222, "close": 227},
        ])


def test_provider_uses_fixed_sina_mapping_and_records_source() -> None:
    fake = FakeAkShare()
    provider = AkShareProvider(module=fake)

    history = provider.history("a-share", "000651", "daily", "2026-08-01", "2026-08-19", "none")
    snapshot = provider.snapshot("us", "AAPL")

    assert history.rows[0]["close"] == 1.5
    assert provider.source("history", "a-share") == "AKShare/stock_zh_a_daily"
    assert snapshot[0]["symbol"] == "AAPL"
    assert snapshot[0]["close"] == 227
    assert provider.source("snapshot", "us") == "AKShare/stock_us_daily"
    assert fake.calls[0][1]["symbol"] == "sz000651"
    assert fake.calls[-1][1] == {"symbol": "AAPL", "adjust": ""}


def test_provider_falls_through_to_next_fixed_source() -> None:
    class FallbackAkShare(FakeAkShare):
        def stock_zh_a_daily(self, **_kwargs):
            raise ConnectionError("sina unavailable")

        def stock_zh_a_hist_tx(self, **kwargs):
            self.calls.append(("stock_zh_a_hist_tx", kwargs))
            return Frame([{"date": "2026-08-19", "open": 1, "high": 2, "low": 1, "close": 1.5}])

    fake = FallbackAkShare()
    provider = AkShareProvider(module=fake)
    provider.history("a-share", "000651", "daily", "2026-08-01", "2026-08-19", "none")
    assert provider.source("history", "a-share") == "AKShare/stock_zh_a_hist_tx"
