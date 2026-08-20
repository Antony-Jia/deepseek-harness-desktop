"""Fixed AKShare provider mapping with bounded, deterministic fallbacks."""

from __future__ import annotations

import logging
from time import monotonic
from typing import Any, Callable


class DataSourceError(RuntimeError):
    def __init__(self, message: str, code: str = "DATA_SOURCE_UNAVAILABLE", retryable: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable


LOGGER = logging.getLogger("akshare-sidecar")
MAX_DIAGNOSTIC_TEXT = 512


def diagnostic(error: Exception) -> str:
    return f"{type(error).__name__}: {str(error)[:MAX_DIAGNOSTIC_TEXT]}"


def _empty(value: Any) -> bool:
    if value is None:
        return True
    empty = getattr(value, "empty", None)
    if empty is not None:
        try:
            return bool(empty)
        except Exception:
            pass
    if isinstance(value, (list, tuple, dict, set)):
        return len(value) == 0
    return False


class AkShareProvider:
    """Expose only fixed functions; callers never select an AKShare name."""

    def __init__(self, module: Any | None = None) -> None:
        if module is None:
            try:
                import akshare as module  # type: ignore[import-not-found]
            except Exception as error:
                raise DataSourceError("AKShare 运行时不可用。", "AKSHARE_UNAVAILABLE") from error
        self.ak = module
        self.version = str(getattr(module, "__version__", "unknown"))
        self._sources: dict[tuple[str, str], str] = {}

    def source(self, operation: str, market: str) -> str:
        defaults = {
            ("snapshot", "a-share"): "AKShare/stock_zh_a_spot",
            ("snapshot", "hk"): "AKShare/stock_hk_spot",
            ("snapshot", "us"): "AKShare/stock_us_daily",
            ("history", "a-share"): "AKShare/stock_zh_a_daily",
            ("history", "hk"): "AKShare/stock_hk_daily",
            ("history", "us"): "AKShare/stock_us_daily",
        }
        return self._sources.get((operation, market), defaults.get((operation, market), "AKShare"))

    def _function(self, name: str) -> Callable[..., Any] | None:
        function = getattr(self.ak, name, None)
        return function if callable(function) else None

    def _call_candidates(
        self,
        operation: str,
        market: str,
        candidates: list[tuple[str, Callable[[], Any] | None]],
        empty_message: str,
    ) -> Any:
        available = False
        last_error: Exception | None = None
        for function_name, call in candidates:
            if not callable(call):
                LOGGER.warning("upstream unavailable operation=%s market=%s function=%s", operation, market, function_name)
                continue
            available = True
            started_at = monotonic()
            LOGGER.info("upstream start operation=%s market=%s function=%s", operation, market, function_name)
            try:
                value = call()
                if _empty(value):
                    raise DataSourceError(empty_message, "UPSTREAM_EMPTY", True)
                self._sources[(operation, market)] = f"AKShare/{function_name}"
                LOGGER.info(
                    "upstream success operation=%s market=%s function=%s elapsedMs=%d",
                    operation,
                    market,
                    function_name,
                    int((monotonic() - started_at) * 1000),
                )
                return value
            except Exception as error:
                last_error = error
                LOGGER.warning(
                    "upstream failure operation=%s market=%s function=%s elapsedMs=%d error=%s",
                    operation,
                    market,
                    function_name,
                    int((monotonic() - started_at) * 1000),
                    diagnostic(error),
                    exc_info=True,
                )

        if not available:
            raise DataSourceError(
                f"AKShare 缺少 {operation} 的可用接口。",
                "AKSHARE_FIELD_DRIFT",
            )
        raise DataSourceError(empty_message, "UPSTREAM_ERROR", True) from last_error

    @staticmethod
    def _a_symbol(symbol: str) -> str:
        if symbol.startswith(("6", "68")):
            return f"sh{symbol}"
        if symbol.startswith(("4", "8")):
            return f"bj{symbol}"
        return f"sz{symbol}"

    @staticmethod
    def _latest_us_snapshot(function: Callable[..., Any], symbol: str) -> list[dict[str, Any]]:
        frame = function(symbol=symbol, adjust="")
        to_dict = getattr(frame, "to_dict", None)
        records = to_dict(orient="records") if callable(to_dict) else []
        if not records:
            return []
        latest = dict(records[-1])
        latest.update({"symbol": symbol, "name": symbol})
        return [latest]

    def snapshot(self, market: str, query: str = "") -> Any:
        if market == "a-share":
            function = self._function("stock_zh_a_spot")
            fallback = self._function("stock_zh_a_spot_em")
            return self._call_candidates(
                "snapshot",
                market,
                [("stock_zh_a_spot", function), ("stock_zh_a_spot_em", fallback)],
                "行情数据源返回空结果。",
            )
        if market == "hk":
            function = self._function("stock_hk_spot")
            fallback = self._function("stock_hk_spot_em")
            return self._call_candidates(
                "snapshot",
                market,
                [("stock_hk_spot", function), ("stock_hk_spot_em", fallback)],
                "行情数据源返回空结果。",
            )
        if market == "us":
            symbol = str(query).strip().upper()
            function = self._function("stock_us_daily")
            return self._call_candidates(
                "snapshot",
                market,
                [
                    (
                        "stock_us_daily",
                        (lambda: self._latest_us_snapshot(function, symbol)) if function else None,
                    )
                ],
                "美股 ticker 返回空结果。",
            )
        raise DataSourceError("不支持的市场。", "INVALID_ARGUMENT")

    def history(self, market: str, symbol: str, period: str, start_date: str, end_date: str, adjust: str) -> Any:
        start = start_date.replace("-", "")
        end = end_date.replace("-", "")
        adjustment = "" if adjust == "none" else adjust

        if market == "a-share":
            prefixed = self._a_symbol(symbol)
            daily = self._function("stock_zh_a_daily")
            tencent = self._function("stock_zh_a_hist_tx")
            eastmoney = self._function("stock_zh_a_hist")
            return self._call_candidates(
                "history",
                market,
                [
                    (
                        "stock_zh_a_daily",
                        (lambda: daily(symbol=prefixed, start_date=start, end_date=end, adjust=adjustment)) if daily else None,
                    ),
                    (
                        "stock_zh_a_hist_tx",
                        (lambda: tencent(symbol=prefixed, start_date=start, end_date=end, adjust=adjustment, timeout=8)) if tencent else None,
                    ),
                    (
                        "stock_zh_a_hist",
                        (lambda: eastmoney(symbol=symbol, period="daily", start_date=start, end_date=end, adjust=adjustment)) if eastmoney else None,
                    ),
                ],
                "历史行情数据源返回空结果。",
            )

        if market == "hk":
            daily = self._function("stock_hk_daily")
            eastmoney = self._function("stock_hk_hist")
            return self._call_candidates(
                "history",
                market,
                [
                    ("stock_hk_daily", (lambda: daily(symbol=symbol, adjust=adjustment)) if daily else None),
                    (
                        "stock_hk_hist",
                        (lambda: eastmoney(symbol=symbol, period="daily", start_date=start, end_date=end, adjust=adjustment)) if eastmoney else None,
                    ),
                ],
                "历史行情数据源返回空结果。",
            )

        if market == "us":
            daily = self._function("stock_us_daily")
            eastmoney = self._function("stock_us_hist")
            eastmoney_symbol = f"105.{symbol}"
            return self._call_candidates(
                "history",
                market,
                [
                    ("stock_us_daily", (lambda: daily(symbol=symbol, adjust=adjustment)) if daily else None),
                    (
                        "stock_us_hist",
                        (lambda: eastmoney(symbol=eastmoney_symbol, period="daily", start_date=start, end_date=end, adjust=adjustment)) if eastmoney else None,
                    ),
                ],
                "历史行情数据源返回空结果。",
            )

        raise DataSourceError("不支持的市场。", "INVALID_ARGUMENT")
