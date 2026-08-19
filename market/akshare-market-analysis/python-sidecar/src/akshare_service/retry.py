"""Bounded retry helper used only for transient upstream failures."""

from __future__ import annotations

import random
import time
from collections.abc import Callable
from typing import TypeVar

T = TypeVar("T")


def retry_call(
    operation: Callable[[], T],
    *,
    attempts: int = 3,
    retryable: Callable[[Exception], bool] | None = None,
    on_retry: Callable[[int, int, Exception, float], None] | None = None,
    sleep: Callable[[float], None] = time.sleep,
    jitter: Callable[[], float] = random.random,
) -> T:
    if attempts < 1 or attempts > 3:
        raise ValueError("attempts must be between 1 and 3")
    should_retry = retryable or (lambda _error: False)
    for index in range(attempts):
        try:
            return operation()
        except Exception as error:
            if index == attempts - 1 or not should_retry(error):
                raise
            delay = min(2.0, 0.25 * (2**index) + 0.1 * max(0.0, jitter()))
            if on_retry is not None:
                on_retry(index + 1, attempts, error, delay)
            sleep(delay)
    raise AssertionError("unreachable")
