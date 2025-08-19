import json, time, logging
from contextlib import contextmanager

log = logging.getLogger("coop-telemetry")

def log_event(event: str, **kwargs):
    try:
        log.info(json.dumps({"event": event, **kwargs}, ensure_ascii=False))
    except Exception:
        log.info(f"{event} | {kwargs}")

@contextmanager
def timeit(label: str):
    t0 = time.perf_counter()
    try:
        yield
    finally:
        dt = int((time.perf_counter() - t0) * 1000)
        log_event("timing", label=label, ms=dt)
