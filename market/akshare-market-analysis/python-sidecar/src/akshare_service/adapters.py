"""Fixed AKShare column adapters; UI and tools only consume normalized DTOs."""

from __future__ import annotations

from datetime import date, datetime
import math
from collections.abc import Iterable, Mapping
from typing import Any

from .protocol import normalize_symbol

SNAPSHOT_ALIASES = {
    "symbol": ("代码", "股票代码", "H股代码", "code", "symbol"),
    "name": ("名称", "中文名称", "股票名称", "name", "cname"),
    "price": ("最新价", "最新价-HKD", "最新价-RMB", "价格", "price", "close"),
    "changePct": ("涨跌幅", "H股-涨跌幅", "涨跌幅(%)", "changePct", "change_pct"),
    "volume": ("成交量", "成交量(股)", "volume"),
    "amount": ("成交额", "成交额(元)", "成交额(HKD)", "amount"),
    "turnoverRate": ("换手率", "换手率(%)", "turnoverRate", "turnover_rate"),
    "open": ("今开", "开盘", "open"),
    "high": ("最高", "high"),
    "low": ("最低", "low"),
    "previousClose": ("昨收", "previousClose", "prev_close"),
}

HISTORY_ALIASES = {
    "date": ("日期", "交易日期", "date", "datetime"),
    "open": ("开盘", "open"),
    "high": ("最高", "high"),
    "low": ("最低", "low"),
    "close": ("收盘", "最新价", "close"),
    "volume": ("成交量", "volume"),
    "amount": ("成交额", "amount"),
    "changePct": ("涨跌幅", "changePct", "change_pct"),
    "turnoverRate": ("换手率", "turnoverRate", "turnover_rate"),
}


def _records(frame: Any) -> list[Mapping[str, Any]]:
    if frame is None:
        return []
    to_dict = getattr(frame, "to_dict", None)
    if callable(to_dict):
        try:
            value = to_dict(orient="records")
        except TypeError:
            value = to_dict()
        if isinstance(value, list):
            return [item for item in value if isinstance(item, Mapping)]
    if isinstance(frame, Mapping):
        return [frame]
    if isinstance(frame, Iterable) and not isinstance(frame, (str, bytes)):
        return [item for item in frame if isinstance(item, Mapping)]
    return []


def _pick(row: Mapping[str, Any], aliases: tuple[str, ...]) -> Any:
    for key in aliases:
        if key in row:
            return row[key]
    normalized = {str(key).strip().lower(): value for key, value in row.items()}
    for key in aliases:
        if key.lower() in normalized:
            return normalized[key.lower()]
    return None


def _number(value: Any) -> float | int | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        result = float(value)
    else:
        raw = str(value).strip().replace(",", "")
        if raw.endswith("%"):
            raw = raw[:-1]
        try:
            result = float(raw)
        except (TypeError, ValueError):
            return None
    if not math.isfinite(result):
        return None
    return int(result) if result.is_integer() and abs(result) < 2**53 else result


def _date(value: Any) -> str | None:
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    raw = str(value).strip() if value is not None else ""
    for pattern in ("%Y-%m-%d", "%Y/%m/%d", "%Y%m%d", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(raw, pattern).date().isoformat()
        except ValueError:
            continue
    return None


def _clean_symbol(value: Any, market: str) -> str | None:
    if value is None:
        return None
    raw = str(value).strip()
    if market == "us":
        try:
            return normalize_symbol(market, raw)
        except ValueError:
            return None
    digits = "".join(char for char in raw if char.isdigit())
    if not digits:
        return None
    try:
        return normalize_symbol(market, digits)
    except ValueError:
        return None


def normalize_snapshot(frame: Any, market: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    dropped = 0
    for source in _records(frame):
        symbol = _clean_symbol(_pick(source, SNAPSHOT_ALIASES["symbol"]), market)
        name = _pick(source, SNAPSHOT_ALIASES["name"])
        if symbol is None or name is None or not str(name).strip():
            dropped += 1
            continue
        row: dict[str, Any] = {
            "symbol": symbol,
            "name": str(name).strip(),
            "price": _number(_pick(source, SNAPSHOT_ALIASES["price"])),
            "changePct": _number(_pick(source, SNAPSHOT_ALIASES["changePct"])),
            "volume": _number(_pick(source, SNAPSHOT_ALIASES["volume"])),
            "amount": _number(_pick(source, SNAPSHOT_ALIASES["amount"])),
            "turnoverRate": _number(_pick(source, SNAPSHOT_ALIASES["turnoverRate"])),
            "open": _number(_pick(source, SNAPSHOT_ALIASES["open"])),
            "high": _number(_pick(source, SNAPSHOT_ALIASES["high"])),
            "low": _number(_pick(source, SNAPSHOT_ALIASES["low"])),
            "previousClose": _number(_pick(source, SNAPSHOT_ALIASES["previousClose"])),
            "currency": {"a-share": "CNY", "hk": "HKD", "us": "USD"}.get(market),
        }
        rows.append(row)
    return rows, {
        "missingBars": 0,
        "droppedRows": dropped,
        "truncated": False,
        "warnings": [] if dropped == 0 else [f"丢弃 {dropped} 行缺少代码或名称。"],
    }


def normalize_history(frame: Any, market: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    by_date: dict[str, dict[str, Any]] = {}
    dropped = 0
    warnings: list[str] = []
    for source in _records(frame):
        day = _date(_pick(source, HISTORY_ALIASES["date"]))
        values = {key: _number(_pick(source, aliases)) for key, aliases in HISTORY_ALIASES.items() if key != "date"}
        required = (values.get("open"), values.get("high"), values.get("low"), values.get("close"))
        if day is None or any(item is None for item in required):
            dropped += 1
            continue
        if day in by_date:
            dropped += 1
            warnings.append(f"重复交易日 {day}，保留最后一行。")
        by_date[day] = {
            "date": day,
            "open": values["open"],
            "high": values["high"],
            "low": values["low"],
            "close": values["close"],
            "volume": values.get("volume"),
            "amount": values.get("amount"),
            "changePct": values.get("changePct"),
            "turnoverRate": values.get("turnoverRate"),
        }
    bars = [by_date[key] for key in sorted(by_date)]
    return bars, {
        "missingBars": 0,
        "droppedRows": dropped,
        "truncated": False,
        "warnings": warnings,
    }
