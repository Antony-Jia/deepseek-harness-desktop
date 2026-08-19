"""Deterministic, descriptive analysis built from the normalized bars."""

from __future__ import annotations

from typing import Any

from .indicators import calculate_indicators


def _latest(values: list[float | None]) -> float | None:
    for value in reversed(values):
        if value is not None:
            return float(value)
    return None


def _round(value: float | None, digits: int = 4) -> float | None:
    return None if value is None else round(float(value), digits)


def _range(bars: list[dict[str, Any]], window: int, field: str) -> float | None:
    values = [bar.get(field) for bar in bars[-window:]]
    numbers = [float(value) for value in values if value is not None]
    return max(numbers) if field == "high" and numbers else min(numbers) if field == "low" and numbers else None


def _missing_warnings(series: dict[str, list[float | None]], bars: list[dict[str, Any]]) -> list[str]:
    warnings: list[str] = []
    required = {"sma60": 60, "macdDif": 34, "rsi14": 15, "bollMiddle": 20, "atr14": 14}
    for key, length in required.items():
        if _latest(series[key]) is None:
            warnings.append(f"数据不足以计算 {key}（至少需要约 {length} 个周期）。")
    if len(bars) < 60:
        warnings.append("当前数据少于 60 个周期，长窗口指标不可完整计算。")
    return warnings


def build_analysis(bars: list[dict[str, Any]], requested: list[str]) -> dict[str, Any]:
    series = calculate_indicators(bars)
    if not bars:
        return {
            "series": series,
            "analysisSummary": {
                "trend": "暂无数据，无法描述趋势。",
                "momentum": "暂无数据，无法描述动量。",
                "volatility": "暂无数据，无法描述波动。",
                "volumePrice": "暂无数据，无法描述量价。",
                "warnings": ["历史数据为空。"],
            },
            "metrics": {},
        }

    close = float(bars[-1]["close"])
    first_close = float(bars[0]["close"])
    change_pct = None if first_close == 0 else (close / first_close - 1) * 100
    sma20, sma60 = _latest(series["sma20"]), _latest(series["sma60"])
    dif, dea, hist = _latest(series["macdDif"]), _latest(series["macdDea"]), _latest(series["macdHist"])
    rsi14 = _latest(series["rsi14"])
    boll_mid, boll_upper, boll_lower = _latest(series["bollMiddle"]), _latest(series["bollUpper"]), _latest(series["bollLower"])
    vma5, vma10, volume = _latest(series["vma5"]), _latest(series["vma10"]), bars[-1].get("volume")
    atr14 = _latest(series["atr14"])

    if sma20 is None:
        trend = "SMA20 尚不可计算，趋势判断受数据长度限制。"
    else:
        relation = "上方" if close >= sma20 else "下方"
        long_relation = ""
        if sma60 is not None:
            long_relation = f"，收盘位于 SMA60{'上方' if close >= sma60 else '下方'}"
        trend = f"最新收盘位于 SMA20 {relation}{long_relation}。"

    if dif is None or dea is None:
        momentum = "MACD 尚不可完整计算。"
    else:
        macd_relation = "DIF 高于 DEA" if dif >= dea else "DIF 低于 DEA"
        hist_phrase = "柱体为正" if (hist is not None and hist >= 0) else "柱体为负" if hist is not None else "柱体尚不可计算"
        momentum = f"MACD {macd_relation}，{hist_phrase}。"
        if rsi14 is not None:
            zone = "低于 30 的区间" if rsi14 < 30 else "高于 70 的区间" if rsi14 > 70 else "30–70 的区间"
            momentum += f"RSI14 位于 {zone}。"

    if atr14 is None:
        volatility = "ATR14 尚不可计算。"
    else:
        volatility = f"ATR14 为 {_round(atr14, 4)}，约占最新收盘的 {_round(atr14 / close * 100, 2) if close else None}%。"
        if boll_mid is not None and boll_upper is not None and boll_lower is not None:
            band = "中轨上方" if close >= boll_mid else "中轨下方"
            volatility += f"收盘位于布林带{band}。"

    if volume is None:
        volume_price = "成交量缺失，无法与 VMA5/VMA10 比较。"
    elif vma5 is None or vma10 is None:
        volume_price = "VMA5/VMA10 尚不可完整计算。"
    else:
        volume_price = f"成交量相对 VMA5 为 {_round(float(volume) / vma5, 2)} 倍、相对 VMA10 为 {_round(float(volume) / vma10, 2)} 倍。"

    warnings = _missing_warnings(series, bars)
    requested_set = set(requested)
    if "sma" not in requested_set:
        trend = "已请求的指标集合不包含 SMA；" + trend
    if "macd" not in requested_set and "rsi" not in requested_set:
        momentum = "已请求的指标集合不包含 MACD/RSI；" + momentum

    metrics = {
        "latestClose": _round(close),
        "rangeChangePct": _round(change_pct, 2),
        "rangeHigh20": _round(_range(bars, 20, "high")),
        "rangeLow20": _round(_range(bars, 20, "low")),
        "rangeHigh60": _round(_range(bars, 60, "high")),
        "rangeLow60": _round(_range(bars, 60, "low")),
        "latestSma20": _round(sma20),
        "latestSma60": _round(sma60),
        "latestRsi14": _round(rsi14, 2),
        "latestAtr14": _round(atr14),
    }
    return {
        "series": series,
        "analysisSummary": {
            "trend": trend,
            "momentum": momentum,
            "volatility": volatility,
            "volumePrice": volume_price,
            "warnings": warnings,
        },
        "metrics": metrics,
    }
