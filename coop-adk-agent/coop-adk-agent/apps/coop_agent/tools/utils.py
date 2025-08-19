import os, base64, datetime as dt
from typing import Optional

def get_env(name: str, default: Optional[str]=None, required: bool=False) -> Optional[str]:
    val = os.getenv(name, default)
    if required and (val is None or val == ""):
        raise RuntimeError(f"Missing env var: {name}")
    return val

def iso_now() -> str:
    return dt.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"

def b64_to_bytes(data_b64: str) -> bytes:
    return base64.b64decode(data_b64)
