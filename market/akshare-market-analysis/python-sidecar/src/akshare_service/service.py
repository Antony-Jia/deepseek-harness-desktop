"""Business service for the four fixed loopback API endpoints."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
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

SERVICE_VERSION = "0.1.0"
MAX_RESPONSE_ROWS = 100


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
            "endpoints": [
                "/health",
                "/v1/market/snapshot",
                "/v1/stock/history",
                "/v1/stock/analysis",
            ],
        }

    def _call(self, operation: Any) -> Any:
        return retry_call(
            operation,
            attempts=3,
            retryable=lambda error: isinstance(error, DataSourceError) and error.retryable,
        )

    def snapshot(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        args = normalize_snapshot_request(payload)
        cache_key = self.cache.key({"schemaVersion": SCHEMA_VERSION, "akshareVersion": self.akshare_version, "endpoint": "snapshot", "args": args})
        ttl = 60 if args["market"] == "hk" else 20
        cached = self.cache.get(cache_key, ttl)
        if cached is not None:
            return {**cached, "cache": {"hit": True, "ttlSeconds": ttl}}
        frame = self._call(lambda: self.provider.snapshot(args["market"]))
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
            "source": "AKShare/stock_zh_a_spot_em" if args["market"] == "a-share" else "AKShare/stock_hk_spot_em",
            "akshareVersion": self.akshare_version,
            "delayMinutes": 15 if args["market"] == "hk" else None,
            "quality": quality,
            "cache": {"hit": False, "ttlSeconds": ttl},
        }
        self.cache.set(cache_key, result)
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
        endpoint = "analysis" if analysis else "history"
        cache_key = self.cache.key({"schemaVersion": SCHEMA_VERSION, "akshareVersion": self.akshare_version, "endpoint": endpoint, "args": args})
        today = datetime.now(timezone.utc).astimezone(timezone(timedelta(hours=8))).date().isoformat()
        ttl = 600 if args["endDate"] >= today else 43200
        cached = self.cache.get(cache_key, ttl)
        if cached is not None:
            return {**cached, "cache": {"hit": True, "ttlSeconds": ttl}}
        frame = self._call(lambda: self.provider.history(args["market"], args["symbol"], args["period"], args["startDate"], args["endDate"], args["adjust"]))
        bars, quality = normalize_history(frame, args["market"])
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
            "currency": "CNY" if args["market"] == "a-share" else "HKD",
            "startDate": args["startDate"],
            "endDate": args["endDate"],
            "fetchedAt": now_iso(),
            "source": "AKShare/stock_zh_a_hist" if args["market"] == "a-share" else "AKShare/stock_hk_hist",
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
