"""Small gzip JSON cache with a deterministic key and corrupt-entry recovery."""

from __future__ import annotations

import gzip
import json
from pathlib import Path
import threading
import time
from typing import Any

from .protocol import stable_hash


class JsonGzipCache:
    def __init__(self, directory: str | Path | None) -> None:
        self.directory = Path(directory) if directory else None
        self._lock = threading.RLock()

    def key(self, payload: Any) -> str:
        return stable_hash(payload).removeprefix("sha256:")

    def _path(self, key: str) -> Path:
        if self.directory is None:
            raise RuntimeError("cache is disabled")
        return self.directory / f"{key}.json.gz"

    def get(self, key: str, ttl: float, *, now: float | None = None) -> Any | None:
        if self.directory is None:
            return None
        path = self._path(key)
        try:
            with self._lock, gzip.open(path, "rt", encoding="utf-8") as handle:
                envelope = json.load(handle)
            created = float(envelope["createdAt"])
            if (time.time() if now is None else now) - created > ttl:
                return None
            return envelope["value"]
        except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass
            return None

    def set(self, key: str, value: Any, *, now: float | None = None) -> None:
        if self.directory is None:
            return
        with self._lock:
            self.directory.mkdir(parents=True, exist_ok=True)
            target = self._path(key)
            temporary = target.with_suffix(target.suffix + ".tmp")
            with gzip.open(temporary, "wt", encoding="utf-8") as handle:
                json.dump({"createdAt": time.time() if now is None else now, "value": value}, handle, ensure_ascii=False, separators=(",", ":"))
            temporary.replace(target)
