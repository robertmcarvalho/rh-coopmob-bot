import os, requests
from typing import List, Dict, Any
from .telemetry import log_event, timeit

WA_TOKEN = os.getenv("WHATSAPP_TOKEN")
WA_PHONE_ID = os.getenv("WHATSAPP_PHONE_NUMBER_ID")

def _endpoint(path: str) -> str:
    return f"https://graph.facebook.com/v20.0/{path}"

def send_text(to: str, body: str) -> Dict[str, Any]:
    if not (WA_TOKEN and WA_PHONE_ID):
        return {"sent": False, "reason": "missing_whatsapp_env"}
    body = (body or "")[:4096]
    url = _endpoint(f"{WA_PHONE_ID}/messages")
    payload = {"messaging_product": "whatsapp", "to": to, "type": "text", "text": {"body": body}}
    with timeit("wa_send_text_tool"):
        r = requests.post(url, headers={"Authorization": f"Bearer {WA_TOKEN}", "Content-Type": "application/json"}, json=payload, timeout=30)
    ok = r.status_code < 300
    log_event("wa.send.text.tool", ok=ok, status=r.status_code)
    if not ok:
        return {"sent": False, "status": r.status_code, "body": r.text}
    return {"sent": True}

def send_vagas_list(to: str, vagas: List[Dict[str, Any]], title: str="Vagas Abertas", prompt: str="Escolha uma vaga") -> Dict[str, Any]:
    if not (WA_TOKEN and WA_PHONE_ID):
        return {"sent": False, "reason": "missing_whatsapp_env"}
    rows = []
    for v in vagas[:10]:
        rid = f"vaga:{v.get('id_vaga')}"
        ttl = f\"{v.get('farmacia','?')} — {v.get('turno','?')}\"
        desc = f\"Taxa {v.get('taxa_entrega','?')}\"
        rows.append({"id": rid, "title": ttl[:24] or "Vaga", "description": desc[:72]})
    payload = {
        "messaging_product": "whatsapp",
        "to": to,
        "type": "interactive",
        "interactive": {"type": "list", "body": {"text": prompt[:1024]},
                        "action": {"button": "Ver vagas", "sections":[{"title": title[:24] or "Vagas", "rows": rows}]}
        }
    }
    url = _endpoint(f"{WA_PHONE_ID}/messages")
    with timeit("wa_send_list_tool"):
        r = requests.post(url, headers={"Authorization": f"Bearer {WA_TOKEN}", "Content-Type":"application/json"}, json=payload, timeout=30)
    ok = r.status_code < 300
    log_event("wa.send.list.tool", ok=ok, status=r.status_code, rows=len(rows))
    if not ok:
        return {"sent": False, "status": r.status_code, "body": r.text}
    return {"sent": True}
