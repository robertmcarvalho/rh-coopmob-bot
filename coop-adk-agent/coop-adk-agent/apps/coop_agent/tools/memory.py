import json
from upstash_redis import Redis
from .utils import get_env

_redis = Redis(
    url=get_env("UPSTASH_REDIS_REST_URL", required=True),
    token=get_env("UPSTASH_REDIS_REST_TOKEN", required=True),
)

TTL = int(get_env("REDIS_TTL_SECONDS", "432000"))  # 5 dias

def _key(user_id: str) -> str:
    return f"coop_agent:userstate:{user_id}"

async def load_user_memory(session) -> dict:
    user_id = session.user_id or "anon"
    data = _redis.get(_key(user_id))
    if data is None:
        return {}
    try:
        payload = json.loads(data)
    except Exception:
        return {}
    for k, v in payload.items():
        if k.startswith("user:"):
            session.state[k] = v
    return payload

async def save_user_memory(session) -> None:
    user_id = session.user_id or "anon"
    user_state = {k: v for k, v in session.state.items() if k.startswith("user:")}
    _redis.set(_key(user_id), json.dumps(user_state), ex=TTL)
