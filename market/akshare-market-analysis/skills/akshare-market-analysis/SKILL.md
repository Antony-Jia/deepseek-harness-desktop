---
name: akshare-market-analysis
description: Use the registered AKShare market tools for A-share, Hong Kong, or U.S. stock snapshots, history, K-lines, and descriptive technical analysis; do not use for trading execution or arbitrary Python.
---

# AKShare 行情与 K 线分析

只在用户需要 A 股、港股或美股行情、历史日/周/月 K 线、筛选排行或 SMA/MACD/RSI/BOLL/VMA/ATR 分析时使用本 Skill。

## 工具纪律

- 只能调用本插件注册的 `akshare_market_snapshot`、`akshare_stock_history`、`akshare_technical_analysis`；不要运行 Python、curl、shell，也不要拼接任意 AKShare 函数名。
- 当前行情使用 `akshare_market_snapshot`；趋势和指标必须使用历史/分析工具，不能从实时快照推断。
- A 股代码规范化为 6 位字符串，港股代码规范化为 5 位字符串并保留前导零，美股使用 ticker（例如 `AAPL`）。美股快照的 `query` 必须传 ticker；市场有歧义时先澄清。
- 只传 schema 允许的字段、操作符和范围；默认 `limit`/`maxBars` 受工具上限约束。
- 技术分析只能输出历史数据的描述性事实，不生成买卖、目标价、收益保证或仓位建议。

## 回答纪律

最终回答必须引用同一次工具结果里的 `analysisSummary`，不得重新抓取或自行改算数值，并明确说明：

- 数据抓取时间、数据源、市场、代码/名称、周期和复权方式。
- 港股和美股数据的延迟或最近交易日标签（若返回中存在）。
- 数据是否截断、指标窗口是否不足、缺失/丢弃行等质量告警。
- 结果仅为历史数据与指标描述，不构成投资建议。

数据不足时明确写“该指标暂不可计算”，不要用较短窗口冒充完整指标。上游失败时说明数据源暂不可用，不根据记忆填充最新价格。

需要更详细的字段和规则时，读取：

- [data-contract.md](references/data-contract.md)
- [analysis-rules.md](references/analysis-rules.md)
