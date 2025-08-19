import os, json, logging, requests, time
from typing import Optional
from fastapi import FastAPI, Request, Response
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types
from apps.coop_agent.agent import agent as coop_agent
from apps.coop_agent.tools.telemetry import log_event, timeit

APP_NAME = "apps/coop_agent"

VERIFY_TOKEN = os.getenv("WHATSAPP_VERIFY_TOKEN", "verify-me")
WA_TOKEN = os.getenv("WHATSAPP_TOKEN")
WA_PHONE_ID = os.getenv("WHATSAPP_PHONE_NUMBER_ID")
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()
logging.basicConfig(level=LOG_LEVEL)
log = logging.getLogger("whatsapp-webhook")

session_service = InMemorySessionService()
runner = Runner(agent=coop_agent, app_name=APP_NAME, session_service=session_service)

app = FastAPI(title="Coop ADK Agent + WhatsApp Webhook")

@app.get("/healthz")
def healthz():
    return {"ok": True}

@app.get("/webhook")
def verify(mode: Optional[str] = None, hub_mode: Optional[str] = None, hub_challenge: Optional[str] = None, hub_verify_token: Optional[str] = None, **kwargs):
    mode = mode or hub_mode
    token = hub_verify_token or kwargs.get("hub.verify_token")
    challenge = hub_challenge or kwargs.get("hub.challenge")
    if mode == "subscribe" and token == VERIFY_TOKEN:
        return Response(content=challenge or "", media_type="text/plain")
    return Response(status_code=403)

@app.post("/webhook")
async def webhook(request: Request):
    body = await request.json()
    log_event('webhook.received')
    try:
        value = body["entry"][0]["changes"][0]["value"]
    except Exception:
        return {"status": "ignored"}

    messages = value.get("messages", [])
    if not messages:
        return {"status": "no_messages"}

    msg = messages[0]
    from_id = msg.get("from") or (value.get("contacts", [{}])[0].get("wa_id"))
    name = (value.get("contacts", [{}])[0].get("profile", {}) or {}).get("name")
    user_id = session_id = from_id

    # ensure session and store wa_id/name
    try:
        await session_service.create_session(app_name=APP_NAME, user_id=user_id, session_id=session_id)
    except Exception:
        pass
    try:
        s = await session_service.get_session(app_name=APP_NAME, user_id=user_id, session_id=session_id)
        s.state['user:wa_id'] = from_id
        if name:
            s.state['user:lead_nome'] = name
    except Exception:
        pass

    text_to_agent: Optional[str] = None

    if msg.get("type") == "text":
        text_to_agent = msg["text"]["body"]

    elif msg.get("type") == "interactive" and msg.get("interactive", {}).get("type") == "list_reply":
        lr = msg["interactive"]["list_reply"]
        sel_id = lr.get("id")
        if sel_id and sel_id.startswith("vaga:"):
            pass_id = sel_id.split(":",1)[1]
            text_to_agent = f"selecionar_vaga {pass_id}"
        else:
            text_to_agent = lr.get("title") or "Seleção recebida"

    elif msg.get("type") == "audio":
        media_id = (msg.get("audio") or {}).get("id")
        if WA_TOKEN and media_id:
            try:
                url_meta = f"https://graph.facebook.com/v20.0/{media_id}"
                meta_r = requests.get(url_meta, headers={"Authorization": f"Bearer {WA_TOKEN}"}, timeout=30)
                meta_r.raise_for_status()
                media_url = meta_r.json().get("url")
                file_r = requests.get(media_url, headers={"Authorization": f"Bearer {WA_TOKEN}"}, timeout=60)
                file_r.raise_for_status()
                from apps.coop_agent.tools.audio import _transcribe_bytes
                text_to_agent = _transcribe_bytes(file_r.content, mime="audio/ogg")
            except Exception as e:
                log.exception("Falha ao transcrever áudio: %s", e)
                text_to_agent = "Observação: Não consegui transcrever seu áudio. Você pode enviar como texto?"

    if not text_to_agent:
        text_to_agent = msg.get("text", {}).get("body") or "Olá"

    if name:
        text_to_agent = f"(Nome: {name}) {text_to_agent}"

    content = types.Content(role="user", parts=[types.Part(text=text_to_agent)])

    final_text = ""
    try:
        with timeit('agent_run'):
            events = runner.run(user_id=user_id, session_id=session_id, new_message=content)
            for event in events:
                if event.is_final_response():
                    parts = event.content.parts
                    if parts and parts[0].text:
                        final_text = parts[0].text
    except Exception as e:
        log.exception("Erro ao executar agente: %s", e)
        final_text = "Desculpe, ocorreu um erro momentâneo. Tente novamente em instantes."

    send_ok = False
    if WA_TOKEN and WA_PHONE_ID and from_id:
        with timeit('wa_send_text_server'):
            send_ok = send_whatsapp_text(to=from_id, body=final_text)

    return {"ok": True, "sent": send_ok}

def send_whatsapp_text(to: str, body: str) -> bool:
    body = (body or "")[:4096]
    try:
        url = f"https://graph.facebook.com/v20.0/{WA_PHONE_ID}/messages"
        payload = {"messaging_product": "whatsapp","to": to,"type": "text","text": {"body": body}}
        r = requests.post(url, headers={"Authorization": f"Bearer {WA_TOKEN}", "Content-Type": "application/json"}, json=payload, timeout=30)
        r.raise_for_status()
        return True
    except Exception as e:
        log.exception("Falha ao enviar WhatsApp: %s | resp=%s", e, getattr(e, "response", None))
        return False
