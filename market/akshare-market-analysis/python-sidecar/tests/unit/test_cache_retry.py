import gzip
import json

import pytest

from akshare_service.cache import JsonGzipCache
from akshare_service.retry import retry_call


def test_cache_round_trip_expiry_and_corrupt_recovery(tmp_path) -> None:
    cache = JsonGzipCache(tmp_path / "cache")
    key = cache.key({"symbol": "600519", "period": "daily"})
    cache.set(key, {"value": 3}, now=100)
    assert cache.get(key, 10, now=105) == {"value": 3}
    assert cache.get(key, 4, now=105) is None

    path = tmp_path / "cache" / f"{key}.json.gz"
    with gzip.open(path, "wt", encoding="utf-8") as handle:
        handle.write("not-json")
    assert cache.get(key, 100, now=100) is None
    assert not path.exists()


def test_retry_is_bounded_and_only_retries_selected_errors() -> None:
    attempts = []

    def operation():
        attempts.append(1)
        if len(attempts) < 3:
            raise TimeoutError("temporary")
        return "ok"

    assert retry_call(operation, attempts=3, retryable=lambda error: isinstance(error, TimeoutError), sleep=lambda _delay: None, jitter=lambda: 0) == "ok"
    assert len(attempts) == 3

    with pytest.raises(RuntimeError):
        retry_call(lambda: (_ for _ in ()).throw(RuntimeError("permanent")), attempts=3, retryable=lambda _error: False, sleep=lambda _delay: None)
