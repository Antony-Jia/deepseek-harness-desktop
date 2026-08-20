"""Business service for the four fixed loopback API endpoints."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import logging
from time import monotonic
from typing import Any, Mapping

from .adapters import normalize_history, normalize_snapshot
from .analysis import build_analysis
from .cache import JsonGzipCache
from .protocol import (
    SCHEMA_VERSION,
    ProtocolError,
    json_safe,
    normalize_history_request,
    normalize_snapshot_request,
    now_iso,
    stable_hash,
)
from .provider import AkShareProvider, DataSourceError
from .retry import retry_call

SERVICE_VERSION = "0.1.1"
MAX_RESPONSE_ROWS = 100
LOGGER = logging.getLogger("akshare-sidecar")

DEFAULT_SOURCES = {
    ("snapshot", "a-share"): "AKShare/stock_zh_a_spot",
    ("snapshot", "hk"): "AKShare/stock_hk_spot",
    ("snapshot", "us"): "AKShare/stock_us_daily",
    ("history", "a-share"): "AKShare/stock_zh_a_daily",
    ("history", "hk"): "AKShare/stock_hk_daily",
    ("history", "us"): "AKShare/stock_us_daily",
}


def _provider_source(provider: Any, operation: str, market: str) -> str:
    source = getattr(provider, "source", None)
    if callable(source):
        try:
            value = source(operation, market)
            if value:
                return str(value)
        except Exception:
            pass
    return DEFAULT_SOURCES.get((operation, market), "AKShare")


def _aggregate_bars(bars: list[dict[str, Any]], period: str) -> list[dict[str, Any]]:
    if period == "daily":
        return bars
    grouped: dict[tuple[int, int], list[dict[str, Any]]] = {}
    for bar in bars:
        try:
            day = datetime.fromisoformat(str(bar["date"])).date()
        except (KeyError, TypeError, ValueError):
            continue
        key = day.isocalendar()[:2] if period == "weekly" else (day.year, day.month)
        grouped.setdefault((int(key[0]), int(key[1])), []).append(bar)

    result: list[dict[str, Any]] = []
    for entries in grouped.values():
        first = entries[0]
        last = entries[-1]
        aggregated = {
            "date": last["date"],
            "open": first.get("open"),
            "high": max((item["high"] for item in entries if item.get("high") is not None), default=None),
            "low": min((item["low"] for item in entries if item.get("low") is not None), default=None),
            "close": last.get("close"),
            "volume": None,
            "amount": None,
            "changePct": None,
            "turnoverRate": last.get("turnoverRate"),
        }
        for field in ("volume", "amount"):
            values = [item[field] for item in entries if item.get(field) is not None]
            aggregated[field] = sum(values) if values else None
        if first.get("close") not in (None, 0) and last.get("close") is not None:
            aggregated["changePct"] = (last["close"] / first["close"] - 1) * 100
        result.append(aggregated)
    return result


class MarketService:
    def __init__(self, provider: Any | None = None, cache_dir: str | None = None) -> None:
        self._provider = provider
        self._provider_error: DataSourceError | None = None
        self.cache = JsonGzipCache(cache_dir)

    @property
    def provider(self) -> Any:
        if self._provider is None:
            if self._provider_error is not None:
                raise self._provider_error
            try:
                self._provider = AkShareProvider()
            except DataSourceError as error:
                self._provider_error = error
                raise
        return self._provider

    @property
    def akshare_version(self) -> str:
        return str(getattr(self._provider, "version", "unknown"))

    def health(self) -> dict[str, Any]:
        return {
            "ok": True,
            "schemaVersion": SCHEMA_VERSION,
            "serviceVersion": SERVICE_VERSION,
            "akshareVersion": self.akshare_version,
            "markets": ["a-share", "hk", "us"],
            "providers": {
                "a-share": ["stock_zh_a_spot", "stock_zh_a_daily", "stock_zh_a_hist_tx", "stock_zh_a_spot_em", "stock_zh_a_hist"],
                "hk": ["stock_hk_spot", "stock_hk_daily", "stock_hk_spot_em", "stock_hk_hist"],
                "us": ["stock_us_daily", "stock_us_spot_em", "stock_us_hist"],
            },
            "endpoints": [
                "/health",
                "/v1/market/snapshot",
                "/v1/stock/history",
                "/v1/stock/analysis",
            ],
        }

    def _call(self, operation: Any, label: str) -> Any:
        return retry_call(
            operation,
            attempts=3,
            retryable=lambda error: isinstance(error, DataSourceError) and error.retryable,
            on_retry=lambda attempt, total, error, delay: LOGGER.warning(
                "upstream retry operation=%s attempt=%d/%d delayMs=%d code=%s message=%s",
                label,
                attempt + 1,
                total,
                int(delay * 1000),
                getattr(error, "code", ""),
                str(error)[:512],
            ),
        )

    def snapshot(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        args = normalize_snapshot_request(payload)
        started_at = monotonic()
        LOGGER.info("snapshot normalized market=%s queryPresent=%s limit=%d", args["market"], bool(args.get("query")), args["limit"])
        cache_key = self.cache.key({"schemaVersion": SCHEMA_VERSION, "akshareVersion": self.akshare_version, "endpoint": "snapshot", "args": args})
        ttl = 60 if args["market"] in {"hk", "us"} else 20
        cached = self.cache.get(cache_key, ttl)
        if cached is not None:
            LOGGER.info("snapshot cache hit market=%s ttlSeconds=%d elapsedMs=%d", args["market"], ttl, int((monotonic() - started_at) * 1000))
            return {**cached, "cache": {"hit": True, "ttlSeconds": ttl}}
        frame = self._call(lambda: self.provider.snapshot(args["market"], args.get("query", "")), "snapshot")
        source_rows, quality = normalize_snapshot(frame, args["market"])
        filtered = [row for row in source_rows if self._matches(row, args)]
        if args["sort"] is not None:
            field = args["sort"]["field"]
            reverse = args["sort"]["direction"] == "desc"
            filtered.sort(key=lambda row: (row.get(field) is None, row.get(field) if row.get(field) is not None else 0), reverse=reverse)
        total = len(filtered)
        rows = filtered[: args["limit"]]
        result = {
            "schemaVersion": SCHEMA_VERSION,
            "kind": "snapshot",
            "market": args["market"],
            "query": args["query"],
            "filters": args["filters"],
            "sort": args["sort"],
            "rows": rows,
            "totalMatched": total,
            "truncated": total > len(rows),
            "fetchedAt": now_iso(),
            "source": _provider_source(self.provider, "snapshot", args["market"]),
            "akshareVersion": self.akshare_version,
            "delayMinutes": 15 if args["market"] in {"hk", "us"} else None,
            "quality": quality,
            "cache": {"hit": False, "ttlSeconds": ttl},
        }
        self.cache.set(cache_key, result)
        LOGGER.info("snapshot success market=%s sourceRows=%d matched=%d returned=%d elapsedMs=%d", args["market"], len(source_rows), total, len(rows), int((monotonic() - started_at) * 1000))
        return json_safe(result)

    @staticmethod
    def _matches(row: Mapping[str, Any], args: Mapping[str, Any]) -> bool:
        query = str(args.get("query", "")).casefold()
        if query and query not in str(row.get("symbol", "")).casefold() and query not in str(row.get("name", "")).casefold():
            return False
        for field, operators in args.get("filters", {}).items():
            value = row.get(field)
            if value is None:
                return False
            numeric = float(value)
            if "gte" in operators and numeric < operators["gte"]:
                return False
            if "lte" in operators and numeric > operators["lte"]:
                return False
        return True

    def _history(self, payload: Mapping[str, Any], *, analysis: bool = False) -> dict[str, Any]:
        args = normalize_history_request(payload, analysis=analysis)
        started_at = monotonic()
        endpoint = "analysis" if analysis else "history"
        LOGGER.info("history normalized operation=%s market=%s symbolPresent=%s period=%s maxBars=%d", endpoint, args["market"], bool(args.get("symbol")), args["period"], args["maxBars"])
        cache_key = self.cache.key({"schemaVersion": SCHEMA_VERSION, "akshareVersion": self.akshare_version, "endpoint": endpoint, "args": args})
        today = datetime.now(timezone.utc).astimezone(timezone(timedelta(hours=8))).date().isoformat()
        ttl = 600 if args["endDate"] >= today else 43200
        cached = self.cache.get(cache_key, ttl)
        if cached is not None:
            LOGGER.info("history cache hit operation=%s market=%s ttlSeconds=%d elapsedMs=%d", endpoint, args["market"], ttl, int((monotonic() - started_at) * 1000))
            return {**cached, "cache": {"hit": True, "ttlSeconds": ttl}}
        frame = self._call(lambda: self.provider.history(args["market"], args["symbol"], args["period"], args["startDate"], args["endDate"], args["adjust"]), endpoint)
        bars, quality = normalize_history(frame, args["market"])
        bars = [bar for bar in bars if args["startDate"] <= bar["date"] <= args["endDate"]]
        if args["period"] != "daily":
            bars = _aggregate_bars(bars, args["period"])
            quality["warnings"].append(f"已使用日线数据聚合为{args['period']}。")
        truncated = len(bars) > args["maxBars"]
        if truncated:
            bars = bars[-args["maxBars"] :]
        quality["truncated"] = truncated
        result: dict[str, Any] = {
            "schemaVersion": SCHEMA_VERSION,
            "kind": "analysis" if analysis else "history",
            "market": args["market"],
            "symbol": args["symbol"],
            "name": args["symbol"],
            "period": args["period"],
            "adjust": args["adjust"],
            "currency": {"a-share": "CNY", "hk": "HKD", "us": "USD"}[args["market"]],
            "startDate": args["startDate"],
            "endDate": args["endDate"],
            "fetchedAt": now_iso(),
            "source": _provider_source(self.provider, "history", args["market"]),
            "akshareVersion": self.akshare_version,
            "bars": bars,
            "quality": quality,
            "cache": {"hit": False, "ttlSeconds": ttl},
        }
        if analysis:
            calculated = build_analysis(bars, args["indicators"])
            result["indicators"] = args["indicators"]
            result["series"] = calculated["series"]
            result["metrics"] = calculated["metrics"]
            result["analysisSummary"] = calculated["analysisSummary"]
            result["quality"]["warnings"] = list(dict.fromkeys(result["quality"].get("warnings", []) + calculated["analysisSummary"]["warnings"]))
        self.cache.set(cache_key, result)
        LOGGER.info("history success operation=%s market=%s bars=%d truncated=%s elapsedMs=%d", endpoint, args["market"], len(bars), truncated, int((monotonic() - started_at) * 1000))
        return json_safe(result)

    def history(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        return self._history(payload, analysis=False)

    def analysis(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        return self._history(payload, analysis=True)

    def dispatch(self, path: str, payload: Mapping[str, Any] | None = None) -> dict[str, Any]:
        if path == "/health":
            return self.health()
        body = payload or {}
        if path == "/v1/market/snapshot":
            return self.snapshot(body)
        if path == "/v1/stock/history":
            return self.history(body)
        if path == "/v1/stock/analysis":
            return self.analysis(body)
        raise ProtocolError("未知 sidecar 路由。", "NOT_FOUND")
