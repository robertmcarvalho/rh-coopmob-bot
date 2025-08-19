import os
from typing import Dict
def get_pipefy_link() -> Dict[str, str]:
    return {"pipefy_url": os.getenv("PIPEFY_URL", "https://app.pipefy.com")}
