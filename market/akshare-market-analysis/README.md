# @p-dsh-market/akshare-market-analysis

DSH 市场插件：通过受控 AKShare sidecar 提供 A 股/港股实时快照、日/周/月历史行情、K 线和有限的描述性技术指标分析。

## 能力

- `akshare_market_snapshot`：A 股/港股快照、查询、白名单数值过滤、排序和限量。
- `akshare_stock_history`：A 股/港股历史 OHLCV，支持 daily、weekly、monthly 与 none/qfq/hfq。
- `akshare_technical_analysis`：SMA、MACD、RSI、BOLL、VMA、ATR 和确定性摘要。
- `akshare-market-analysis` Skill：约束数据时间、复权、延迟说明和描述性文案。
- 对话 Tool View：快照表、K 线/指标图和“在右侧打开”。
- `shell.overlay`：每个会话只维护一份当前分析；通过受控 `pluginRpc` 接收桌面“行情”入口。

## 安装与挂载

```powershell
dsh plugin --profile web add @p-dsh-market/akshare-market-analysis@0.1.3
```

安装后将包内 `cordis.patch.yml` 的 insert 挂载到 web profile。市场安装器会在安装后提示重启 DSH。

Windows x64 发布包必须包含 `runtime/win32-x64/akshare-service.exe` 及其同目录依赖；sidecar 只绑定 `127.0.0.1` 随机端口。npm 安装阶段不会下载、安装或启动 Python。

## 边界与数据说明

本插件不提供下单、持仓、目标价或个性化投资建议，不支持分钟线、逐笔、Level-2、美股、期货或任意 AKShare 函数调用。港股快照必须显示数据源可能约 15 分钟延迟。字段漂移、数据不足和上游不可用均 fail closed，不以记忆补全最新行情。

默认测试只使用固定 fixture；联网 smoke、DSH 宿主安装、启停、会话回放和桌面外框联调留给集成测试。
