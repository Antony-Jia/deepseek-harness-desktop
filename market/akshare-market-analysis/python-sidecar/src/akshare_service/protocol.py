"""Protocol validation and JSON-safe normalization for the sidecar."""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
import hashlib
import json
import math
from typing import Any, Mapping

SCHEMA_VERSION = 1
MARKETS = {"a-share", "hk", "us"}
PERIODS = {"daily", "weekly", "monthly"}
ADJUSTMENTS = {"none", "qfq", "hfq"}
SNAPSHOT_FIELDS = {"price", "changePct", "volume", "amount", "turnoverRate"}
FILTER_OPERATORS = {"gte", "lte"}
ANALYSIS_INDICATORS = {"sma", "macd", "rsi", "boll", "volume-ma", "atr"}
MAX_QUERY_LENGTH = 100
MAX_SNAPSHOT_LIMIT = 100
MAX_HISTORY_BARS = 600


class ProtocolError(ValueError):
    """A caller supplied a value outside the fixed sidecar contract."""

    def __init__(self, message: str, code: str = "INVALID_ARGUMENT") -> None:
        super().__init__(message)
        self.code = code


def _assert_keys(payload: Mapping[str, Any], allowed: set[str], label: str) -> None:
    unknown = sorted(set(payload) - allowed)
    if unknown:
        raise ProtocolError(f"{label} 包含未知字段: {unknown[0]}")


def _finite_number(value: Any, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ProtocolError(f"{field} 必须是有限数字。")
    result = float(value)
    if not math.isfinite(result):
        raise ProtocolError(f"{field} 必须是有限数字。")
    return result


def parse_date(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ProtocolError(f"{field} 必须是 YYYYMMDD 或 YYYY-MM-DD。")
    raw = value.strip()
    parsed: date | None = None
    for pattern in ("%Y%m%d", "%Y-%m-%d"):
        try:
            parsed = datetime.strptime(raw, pattern).date()
            break
        except ValueError:
            continue
    if parsed is None:
        raise ProtocolError(f"{field} 必须是 YYYYMMDD 或 YYYY-MM-DD。")
    return parsed.isoformat()


def _default_dates() -> tuple[str, str]:
    today = datetime.now(timezone.utc).astimezone(timezone(timedelta(hours=8))).date()
    return (today - timedelta(days=365)).isoformat(), today.isoformat()


def normalize_symbol(market: str, value: Any) -> str:
    if market not in MARKETS:
        raise ProtocolError("market 必须是 a-share、hk 或 us。")
    if market == "us":
        if not isinstance(value, str):
            raise ProtocolError("美股 symbol 必须是 ticker 字符串。")
        raw = value.strip().upper()
        if not 1 <= len(raw) <= 15 or not all(char.isalnum() or char in ".-_" for char in raw) or not any(char.isalnum() for char in raw):
            raise ProtocolError("美股 symbol 必须是 1 到 15 位字母、数字、点、短横线或下划线。")
        return raw
    if not isinstance(value, (str, int)) or isinstance(value, bool):
        raise ProtocolError("symbol 必须是数字代码字符串。")
    raw = str(value).strip()
    if not raw.isdigit():
        raise ProtocolError("symbol 只能包含数字。")
    width = 6 if market == "a-share" else 5
    if len(raw) > width:
        raise ProtocolError(f"{market} symbol 最多 {width} 位数字。")
    return raw.zfill(width)


def normalize_snapshot_request(payload: Mapping[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, Mapping):
        raise ProtocolError("snapshot 请求必须是对象。")
    _assert_keys(payload, {"market", "query", "filters", "sort", "limit"}, "snapshot")
    market = payload.get("market")
    if market not in MARKETS:
        raise ProtocolError("market 必须是 a-share、hk 或 us。")
    query = payload.get("query", "")
    if not isinstance(query, str) or len(query.strip()) > MAX_QUERY_LENGTH:
        raise ProtocolError("query 必须是有限长度字符串。")
    if market == "us" and not query.strip():
        raise ProtocolError("美股快照需要在 query 中传入 ticker，例如 AAPL。")

    raw_filters = payload.get("filters", {})
    if raw_filters is None:
        raw_filters = {}
    if not isinstance(raw_filters, Mapping):
        raise ProtocolError("filters 必须是对象。")
    filters: dict[str, dict[str, float]] = {}
    for field, operators in raw_filters.items():
        if field not in SNAPSHOT_FIELDS:
            raise ProtocolError(f"不支持的筛选字段: {field}")
        if not isinstance(operators, Mapping):
            raise ProtocolError(f"filters.{field} 必须是对象。")
        normalized: dict[str, float] = {}
        for operator, value in operators.items():
            if operator not in FILTER_OPERATORS:
                raise ProtocolError(f"不支持的筛选操作符: {operator}")
            normalized[operator] = _finite_number(value, f"filters.{field}.{operator}")
        if "gte" in normalized and "lte" in normalized and normalized["gte"] > normalized["lte"]:
            raise ProtocolError(f"filters.{field}.gte 不能大于 lte。")
        filters[field] = normalized

    raw_sort = payload.get("sort")
    sort: dict[str, str] | None = None
    if raw_sort is not None:
        if not isinstance(raw_sort, Mapping):
            raise ProtocolError("sort 必须是对象。")
        field = raw_sort.get("field")
        direction = raw_sort.get("direction")
        if field not in SNAPSHOT_FIELDS or direction not in {"asc", "desc"}:
            raise ProtocolError("sort.field 或 sort.direction 不在白名单内。")
        sort = {"field": field, "direction": direction}

    limit = payload.get("limit", 20)
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_SNAPSHOT_LIMIT:
        raise ProtocolError(f"limit 必须是 1 到 {MAX_SNAPSHOT_LIMIT} 的整数。")
    return {
        "market": market,
        "query": query.strip(),
        "filters": filters,
        "sort": sort,
        "limit": limit,
    }


def normalize_history_request(payload: Mapping[str, Any], *, analysis: bool = False) -> dict[str, Any]:
    if not isinstance(payload, Mapping):
        raise ProtocolError("history 请求必须是对象。")
    allowed = {"market", "symbol", "period", "startDate", "endDate", "adjust", "maxBars"}
    if analysis:
        allowed.add("indicators")
    _assert_keys(payload, allowed, "history")
    market = payload.get("market")
    if market not in MARKETS:
        raise ProtocolError("market 必须是 a-share、hk 或 us。")
    symbol = normalize_symbol(market, payload.get("symbol"))
    period = payload.get("period", "daily")
    if period not in PERIODS:
        raise ProtocolError("period 必须是 daily、weekly 或 monthly。")
    start_default, end_default = _default_dates()
    start_date = parse_date(payload.get("startDate", start_default), "startDate")
    end_date = parse_date(payload.get("endDate", end_default), "endDate")
    if start_date > end_date:
        raise ProtocolError("startDate 不能晚于 endDate。")
    adjust = payload.get("adjust", "none")
    if adjust not in ADJUSTMENTS:
        raise ProtocolError("adjust 必须是 none、qfq 或 hfq。")
    if market == "us" and adjust == "hfq":
        raise ProtocolError("当前美股新浪接口不提供 hfq，改用 none 或 qfq。")
    max_bars = payload.get("maxBars", 240)
    if isinstance(max_bars, bool) or not isinstance(max_bars, int) or not 1 <= max_bars <= MAX_HISTORY_BARS:
        raise ProtocolError(f"maxBars 必须是 1 到 {MAX_HISTORY_BARS} 的整数。")
    result: dict[str, Any] = {
        "market": market,
        "symbol": symbol,
        "period": period,
        "startDate": start_date,
        "endDate": end_date,
        "adjust": adjust,
        "maxBars": max_bars,
    }
    if analysis:
        raw_indicators = payload.get("indicators", sorted(ANALYSIS_INDICATORS))
        if not isinstance(raw_indicators, list) or not raw_indicators:
            raise ProtocolError("indicators 必须是非空字符串数组。")
        if any(item not in ANALYSIS_INDICATORS for item in raw_indicators):
            raise ProtocolError("indicators 包含不支持的指标。")
        result["indicators"] = list(dict.fromkeys(raw_indicators))
    return result


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone(timezone(timedelta(hours=8))).isoformat(timespec="seconds")


def json_safe(value: Any) -> Any:
    """Convert Pandas/NumPy/date values and non-finite floats to JSON values."""
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, Mapping):
        return {str(key): json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(item) for item in value]
    item = getattr(value, "item", None)
    if callable(item):
        try:
            return json_safe(item())
        except Exception:
            return None
    isoformat = getattr(value, "isoformat", None)
    if callable(isoformat):
        try:
            return isoformat()
        except Exception:
            return None
    return str(value)


def stable_hash(value: Any) -> str:
    payload = json.dumps(json_safe(value), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()
