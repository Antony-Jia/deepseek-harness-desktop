"""Loopback-only HTTP entrypoint for the DSH AKShare sidecar."""

from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hmac
import json
import logging
import os
from pathlib import Path
import secrets
import sys
from time import monotonic
from typing import Any

if __package__ in (None, ""):
    # PyInstaller executes the entrypoint as ``__main__``. Keep the source
    # module runnable with ``python -m`` while allowing the frozen exe to
    # resolve the package modules through the spec's ``src`` pathex.
    from akshare_service.protocol import ProtocolError, json_safe
    from akshare_service.provider import DataSourceError
    from akshare_service.service import MarketService
else:
    from .protocol import ProtocolError, json_safe
    from .provider import DataSourceError
    from .service import MarketService

MAX_BODY_BYTES = 256 * 1024
MAX_ERROR_TEXT = 512
LOGGER = logging.getLogger("akshare-sidecar")


def configure_logging() -> None:
    try:
        sys.stderr.reconfigure(encoding="utf-8", errors="backslashreplace")
    except (AttributeError, ValueError):
        pass
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] [akshare-sidecar] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
        stream=sys.stderr,
        force=True,
    )


def body_summary(body: dict[str, Any]) -> str:
    keys = ",".join(sorted(str(key) for key in body))
    market = body.get("market", "")
    return (
        f"keys=[{keys}] market={market!s} "
        f"symbolPresent={bool(body.get('symbol'))} "
        f"queryPresent={bool(body.get('query'))}"
    )


class _Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, server_address: tuple[str, int], token: str, service: MarketService) -> None:
        super().__init__(server_address, RequestHandler)
        self.token = token
        self.service = service
        self.nonce = secrets.token_urlsafe(18)


class RequestHandler(BaseHTTPRequestHandler):
    server: _Server

    def log_message(self, _format: str, *_args: Any) -> None:
        # Never print URLs, query data, or payloads to the sidecar log.
        return

    def _authorized(self) -> bool:
        raw = self.headers.get("Authorization", "")
        prefix = "Bearer "
        return raw.startswith(prefix) and hmac.compare_digest(raw[len(prefix) :], self.server.token)

    def _log_path(self) -> str:
        return self.path.split("?", 1)[0]

    def _write(self, status: int, body: Any) -> None:
        encoded = json.dumps(json_safe(body), ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def _body(self) -> dict[str, Any]:
        raw_length = self.headers.get("Content-Length")
        try:
            length = int(raw_length or "0")
        except ValueError as error:
            raise ProtocolError("Content-Length 无效。") from error
        if length < 0 or length > MAX_BODY_BYTES:
            raise ProtocolError("请求体超出大小限制。", "PAYLOAD_TOO_LARGE")
        raw = self.rfile.read(length)
        try:
            value = json.loads(raw.decode("utf-8")) if raw else {}
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ProtocolError("请求体不是合法 JSON。") from error
        if not isinstance(value, dict):
            raise ProtocolError("请求体必须是 JSON 对象。")
        return value

    def do_GET(self) -> None:  # noqa: N802
        started_at = monotonic()
        if not self._authorized():
            self._write(401, {"ok": False, "error": {"code": "UNAUTHORIZED", "message": "需要 sidecar bearer token。"}})
            LOGGER.warning("GET unauthorized path=%s elapsedMs=%d", self._log_path(), int((monotonic() - started_at) * 1000))
            return
        if self.path != "/health":
            self._write(404, {"ok": False, "error": {"code": "NOT_FOUND", "message": "未知 sidecar 路由。"}})
            LOGGER.warning("GET rejected path=%s status=404 elapsedMs=%d", self._log_path(), int((monotonic() - started_at) * 1000))
            return
        try:
            self._write(200, self.server.service.health())
            LOGGER.info("GET health status=200 elapsedMs=%d", int((monotonic() - started_at) * 1000))
        except Exception as error:
            self._write(503, {"ok": False, "error": {"code": "HEALTH_FAILED", "message": str(error)[:MAX_ERROR_TEXT]}})
            LOGGER.exception("GET health failed status=503 elapsedMs=%d", int((monotonic() - started_at) * 1000))

    def do_POST(self) -> None:  # noqa: N802
        started_at = monotonic()
        if not self._authorized():
            self._write(401, {"ok": False, "error": {"code": "UNAUTHORIZED", "message": "需要 sidecar bearer token。"}})
            LOGGER.warning("POST unauthorized path=%s elapsedMs=%d", self.path, int((monotonic() - started_at) * 1000))
            return
        try:
            body = self._body()
            LOGGER.info("POST start path=%s %s", self._log_path(), body_summary(body))
            self._write(200, self.server.service.dispatch(self.path, body))
            LOGGER.info("POST success path=%s status=200 elapsedMs=%d", self._log_path(), int((monotonic() - started_at) * 1000))
        except ProtocolError as error:
            status = 413 if error.code == "PAYLOAD_TOO_LARGE" else 404 if error.code == "NOT_FOUND" else 400
            self._write(status, {"ok": False, "error": {"code": error.code, "message": str(error)[:MAX_ERROR_TEXT]}})
            LOGGER.warning("POST rejected path=%s status=%d code=%s elapsedMs=%d", self._log_path(), status, error.code, int((monotonic() - started_at) * 1000))
        except DataSourceError as error:
            self._write(503, {"ok": False, "error": {"code": error.code, "message": str(error)[:MAX_ERROR_TEXT], "retryable": error.retryable}})
            LOGGER.warning(
                "POST upstream failed path=%s status=503 code=%s retryable=%s elapsedMs=%d message=%s",
                self._log_path(),
                error.code,
                error.retryable,
                int((monotonic() - started_at) * 1000),
                str(error)[:MAX_ERROR_TEXT],
                exc_info=True,
            )
        except Exception:
            self._write(500, {"ok": False, "error": {"code": "SIDECAR_INTERNAL", "message": "sidecar 内部错误。"}})
            LOGGER.exception("POST internal failed path=%s status=500 elapsedMs=%d", self._log_path(), int((monotonic() - started_at) * 1000))


def main() -> int:
    configure_logging()
    token = os.environ.get("DSH_AKSHARE_TOKEN", "")
    if not token:
        LOGGER.error("sidecar startup rejected: DSH_AKSHARE_TOKEN missing")
        print(json.dumps({"ready": False, "error": "DSH_AKSHARE_TOKEN missing"}), flush=True)
        return 2
    cache_dir = os.environ.get("DSH_AKSHARE_CACHE_DIR") or str(Path(os.environ.get("TEMP", ".")) / "dsh-akshare-cache")
    LOGGER.info("sidecar starting cacheDir=%s", cache_dir)
    server = _Server(("127.0.0.1", 0), token, MarketService(cache_dir=cache_dir))
    print(json.dumps({
        "ready": True,
        "protocolVersion": 1,
        "port": server.server_address[1],
        "nonce": server.nonce,
    }, separators=(",", ":")), flush=True)
    LOGGER.info("sidecar ready port=%d", server.server_address[1])
    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        LOGGER.info("sidecar stopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
