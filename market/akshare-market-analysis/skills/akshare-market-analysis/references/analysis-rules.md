# Analysis rules

The sidecar computes indicators locally from normalized OHLCV data. A missing value stays missing; no shorter window is silently substituted.

- SMA: 5, 10, 20, and 60 periods.
- MACD: EMA12, EMA26, DEA9, and histogram (`DIF - DEA`).
- RSI: 14-period Wilder-style gain/loss average.
- BOLL: 20-period middle average and population standard deviation multiplied by 2.
- Volume averages: VMA5 and VMA10.
- ATR: 14-period true-range average, used only as a volatility description.
- `rangeHigh20`, `rangeLow20`, `rangeHigh60`, and `rangeLow60` describe observation ranges; they are not certain support or resistance.

The first summary layer is deterministic: it compares the latest close with SMA20/SMA60, describes MACD sign and recent histogram direction, classifies RSI as below 30 / 30–70 / above 70, locates the close against BOLL, and compares volume with VMA5/VMA10. It must not contain imperative trading language.
