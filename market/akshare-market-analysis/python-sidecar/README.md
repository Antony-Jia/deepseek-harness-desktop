# AKShare sidecar

This is the development and packaging project for the Windows x64 sidecar in
the parent npm plugin. It is intentionally independent from the repository's
other Python environments.

```powershell
uv sync --frozen --group dev
uv run pytest
uv run pyinstaller --noconfirm .\akshare-service.spec
```

The service binds to `127.0.0.1` on an ephemeral port and requires the bearer
token supplied in `DSH_AKSHARE_TOKEN`. It exposes only `/health`,
`/v1/market/snapshot`, `/v1/stock/history`, and `/v1/stock/analysis`. It never
accepts a function name, URL, local path, or Python expression from a caller.

The default test suite never calls the public data sources. Use the explicitly
invoked release smoke separately when validating an AKShare upgrade.
