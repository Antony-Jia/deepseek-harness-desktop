"""Small, dependency-free technical indicator implementation."""

from __future__ import annotations

import math
from typing import Iterable


def _mean(values: Iterable[float]) -> float:
    items = list(values)
    return sum(items) / len(items)


def sma(values: list[float | None], window: int) -> list[float | None]:
    output: list[float | None] = [None] * len(values)
    for index in range(window - 1, len(values)):
        chunk = values[index - window + 1 : index + 1]
        if all(value is not None and math.isfinite(float(value)) for value in chunk):
            output[index] = _mean(float(value) for value in chunk if value is not None)
    return output


def ema(values: list[float | None], window: int) -> list[float | None]:
    output: list[float | None] = [None] * len(values)
    previous: float | None = None
    multiplier = 2 / (window + 1)
    for index, value in enumerate(values):
        if value is None or not math.isfinite(float(value)):
            continue
        number = float(value)
        if previous is None:
            if index < window - 1:
                continue
            chunk = values[index - window + 1 : index + 1]
            if not all(item is not None and math.isfinite(float(item)) for item in chunk):
                continue
            previous = _mean(float(item) for item in chunk if item is not None)
        else:
            previous = (number - previous) * multiplier + previous
        output[index] = previous
    return output


def macd(values: list[float | None]) -> tuple[list[float | None], list[float | None], list[float | None]]:
    fast = ema(values, 12)
    slow = ema(values, 26)
    dif = [None if fast[index] is None or slow[index] is None else fast[index] - slow[index] for index in range(len(values))]
    dea = ema(dif, 9)
    hist = [None if dif[index] is None or dea[index] is None else dif[index] - dea[index] for index in range(len(values))]
    return dif, dea, hist


def rsi(values: list[float | None], window: int = 14) -> list[float | None]:
    output: list[float | None] = [None] * len(values)
    changes: list[float | None] = [None]
    for index in range(1, len(values)):
        if values[index] is None or values[index - 1] is None:
            changes.append(None)
        else:
            changes.append(float(values[index]) - float(values[index - 1]))
    if len(changes) <= window:
        return output
    initial = changes[1 : window + 1]
    if not all(item is not None for item in initial):
        return output
    gains = _mean(max(item, 0.0) for item in initial if item is not None)
    losses = _mean(max(-item, 0.0) for item in initial if item is not None)
    output[window] = 100.0 if losses == 0 else 100 - 100 / (1 + gains / losses)
    for index in range(window + 1, len(values)):
        change = changes[index]
        if change is None:
            continue
        gains = (gains * (window - 1) + max(change, 0.0)) / window
        losses = (losses * (window - 1) + max(-change, 0.0)) / window
        output[index] = 100.0 if losses == 0 else 100 - 100 / (1 + gains / losses)
    return output


def bollinger(values: list[float | None], window: int = 20, multiplier: float = 2.0) -> tuple[list[float | None], list[float | None], list[float | None]]:
    middle: list[float | None] = [None] * len(values)
    upper: list[float | None] = [None] * len(values)
    lower: list[float | None] = [None] * len(values)
    for index in range(window - 1, len(values)):
        chunk = values[index - window + 1 : index + 1]
        if not all(item is not None and math.isfinite(float(item)) for item in chunk):
            continue
        numbers = [float(item) for item in chunk if item is not None]
        average = _mean(numbers)
        deviation = math.sqrt(_mean((item - average) ** 2 for item in numbers))
        middle[index] = average
        upper[index] = average + multiplier * deviation
        lower[index] = average - multiplier * deviation
    return upper, middle, lower


def atr(bars: list[dict[str, float | None]], window: int = 14) -> list[float | None]:
    true_ranges: list[float | None] = [None] * len(bars)
    for index, bar in enumerate(bars):
        high, low = bar.get("high"), bar.get("low")
        if high is None or low is None:
            continue
        if index == 0 or bars[index - 1].get("close") is None:
            true_ranges[index] = float(high) - float(low)
            continue
        previous_close = float(bars[index - 1]["close"])
        true_ranges[index] = max(float(high) - float(low), abs(float(high) - previous_close), abs(float(low) - previous_close))
    output: list[float | None] = [None] * len(bars)
    for index in range(window - 1, len(bars)):
        chunk = true_ranges[index - window + 1 : index + 1]
        if all(item is not None for item in chunk):
            output[index] = _mean(float(item) for item in chunk if item is not None)
    return output


def calculate_indicators(bars: list[dict[str, float | None]]) -> dict[str, list[float | None]]:
    closes = [bar.get("close") for bar in bars]
    volumes = [bar.get("volume") for bar in bars]
    dif, dea, hist = macd(closes)
    boll_upper, boll_middle, boll_lower = bollinger(closes)
    return {
        "sma5": sma(closes, 5),
        "sma10": sma(closes, 10),
        "sma20": sma(closes, 20),
        "sma60": sma(closes, 60),
        "macdDif": dif,
        "macdDea": dea,
        "macdHist": hist,
        "rsi14": rsi(closes, 14),
        "bollUpper": boll_upper,
        "bollMiddle": boll_middle,
        "bollLower": boll_lower,
        "vma5": sma(volumes, 5),
        "vma10": sma(volumes, 10),
        "atr14": atr(bars, 14),
    }
