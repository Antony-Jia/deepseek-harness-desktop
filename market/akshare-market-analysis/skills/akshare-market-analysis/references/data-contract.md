# Data contract

## Tools

- `akshare_market_snapshot({ market, query?, filters?, sort?, limit? })`
- `akshare_stock_history({ market, symbol, period?, startDate?, endDate?, adjust?, maxBars? })`
- `akshare_technical_analysis({ market, symbol, period?, startDate?, endDate?, adjust?, maxBars?, indicators? })`

`market` is `a-share` or `hk`; `period` is `daily`, `weekly`, or `monthly`; `adjust` is `none`, `qfq`, or `hfq`. Snapshot filters only allow `price`, `changePct`, `volume`, `amount`, and `turnoverRate`, each with `gte`/`lte`. Snapshot sort only allows those same numeric fields. Unknown keys, non-finite numbers, invalid dates, and out-of-range limits are rejected before the sidecar is called.

## Snapshot result

The value contains `rows`, `totalMatched`, `truncated`, `fetchedAt`, `source`, `quality`, and, for Hong Kong data, a delay label. Rows use normalized English keys (`symbol`, `name`, `price`, `changePct`, `volume`, `amount`, `turnoverRate`, `currency`) and preserve unavailable source fields as `null`.

## History/analysis result

`bars` are ascending normalized records with `date`, `open`, `high`, `low`, `close`, `volume`, `amount`, `changePct`, and `turnoverRate`. `series` is only present for technical analysis and has fixed keys. `presentationMeta` is a bounded `ChartSnapshotV1` with at most 240 bars; it is the replay authority and must not trigger a new network request.

The `quality` object reports `missingBars`, `droppedRows`, and `truncated`. `NaN`, infinity, Pandas timestamps, and NumPy scalars never cross the JSON boundary.
