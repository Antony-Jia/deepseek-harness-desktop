from akshare_service.indicators import atr, bollinger, ema, macd, rsi, sma


def test_moving_averages_have_warmup_windows() -> None:
    values = [1, 2, 3, 4, 5]
    assert sma(values, 3) == [None, None, 2.0, 3.0, 4.0]
    assert ema(values, 3) == [None, None, 2.0, 3.0, 4.0]


def test_macd_rsi_bollinger_and_atr_are_aligned() -> None:
    values = [float(index) for index in range(1, 80)]
    dif, dea, histogram = macd(values)
    assert len(dif) == len(dea) == len(histogram) == len(values)
    assert rsi(values)[-1] == 100.0
    upper, middle, lower = bollinger(values)
    assert upper[-1] is not None and middle[-1] is not None and lower[-1] is not None
    assert upper[-1] > middle[-1] > lower[-1]

    bars = [{"high": value + 1, "low": value - 1, "close": value} for value in values]
    result = atr(bars, 14)
    assert len(result) == len(bars)
    assert result[-1] == 2.0
