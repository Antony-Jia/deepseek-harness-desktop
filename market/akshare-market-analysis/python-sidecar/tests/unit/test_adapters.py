from datetime import datetime

from akshare_service.adapters import normalize_history, normalize_snapshot


class Frame:
    def __init__(self, rows):
        self.rows = rows

    def to_dict(self, orient=None):
        assert orient == "records"
        return self.rows


def test_normalizes_snapshot_aliases_for_a_share() -> None:
    rows, quality = normalize_snapshot(Frame([
        {"代码": "1", "名称": "平安银行", "最新价": "10.5", "涨跌幅": "1.2%", "成交额": "2,000"},
        {"代码": None, "名称": "坏行"},
    ]), "a-share")
    assert rows[0]["symbol"] == "000001"
    assert rows[0]["price"] == 10.5
    assert rows[0]["changePct"] == 1.2
    assert rows[0]["amount"] == 2000
    assert quality["droppedRows"] == 1


def test_normalizes_history_orders_and_deduplicates() -> None:
    rows, quality = normalize_history(Frame([
        {"日期": "2026-08-19", "开盘": 12, "最高": 13, "最低": 11, "收盘": 12.5, "成交量": 100},
        {"日期": "20260818", "开盘": 11, "最高": 12, "最低": 10, "收盘": 11.5},
        {"日期": datetime(2026, 8, 19), "开盘": 12.2, "最高": 13.2, "最低": 11.2, "收盘": 12.8},
        {"日期": "not-a-date", "开盘": 1, "最高": 1, "最低": 1, "收盘": 1},
    ]), "a-share")
    assert [row["date"] for row in rows] == ["2026-08-18", "2026-08-19"]
    assert rows[-1]["close"] == 12.8
    assert quality["droppedRows"] == 2
    assert any("重复交易日" in warning for warning in quality["warnings"])
