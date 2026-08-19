"""Fixed AKShare provider mapping; no dynamic function dispatch is exposed."""

from __future__ import annotations

from typing import Any


class DataSourceError(RuntimeError):
    def __init__(self, message: str, code: str = "DATA_SOURCE_UNAVAILABLE", retryable: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable


class AkShareProvider:
    def __init__(self, module: Any | None = None) -> None:
        if module is None:
            try:
                import akshare as module  # type: ignore[import-not-found]
            except Exception as error:
                raise DataSourceError("AKShare 运行时不可用。", "AKSHARE_UNAVAILABLE") from error
        self.ak = module
        self.version = str(getattr(module, "__version__", "unknown"))

    def snapshot(self, market: str) -> Any:
        if market == "a-share":
            function = getattr(self.ak, "stock_zh_a_spot_em", None)
        elif market == "hk":
            function = getattr(self.ak, "stock_hk_spot_em", None)
        else:
            function = None
        if not callable(function):
            raise DataSourceError(f"AKShare 缺少 {market} 快照接口。", "AKSHARE_FIELD_DRIFT")
        try:
            return function()
        except (TimeoutError, ConnectionError) as error:
            raise DataSourceError("行情数据源暂时不可用。", "UPSTREAM_TEMPORARY", True) from error
        except Exception as error:
            raise DataSourceError("行情数据源请求失败。", "UPSTREAM_ERROR", True) from error

    def history(self, market: str, symbol: str, period: str, start_date: str, end_date: str, adjust: str) -> Any:
        function_name = "stock_zh_a_hist" if market == "a-share" else "stock_hk_hist"
        function = getattr(self.ak, function_name, None)
        if not callable(function):
            raise DataSourceError(f"AKShare 缺少 {function_name} 接口。", "AKSHARE_FIELD_DRIFT")
        arguments = {
            "symbol": symbol,
            "period": period,
            "start_date": start_date.replace("-", ""),
            "end_date": end_date.replace("-", ""),
            "adjust": "" if adjust == "none" else adjust,
        }
        try:
            return function(**arguments)
        except (TimeoutError, ConnectionError) as error:
            raise DataSourceError("历史行情数据源暂时不可用。", "UPSTREAM_TEMPORARY", True) from error
        except Exception as error:
            raise DataSourceError("历史行情数据源请求失败。", "UPSTREAM_ERROR", True) from error
