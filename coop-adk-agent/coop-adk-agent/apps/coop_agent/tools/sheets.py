import os, json
from typing import List, Dict, Any, Optional
from google.oauth2.service_account import Credentials
import gspread
from .utils import get_env, iso_now
from .telemetry import log_event, timeit

SPREADSHEET_ID = get_env("SPREADSHEET_ID", required=True)
SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]
SA_JSON = os.getenv("SA_JSON")  # opcional

def _get_creds():
    # 3 caminhos: SA_JSON (inline), GOOGLE_APPLICATION_CREDENTIALS (arquivo), ADC (Cloud Run)
    if SA_JSON:
        info = json.loads(SA_JSON)
        return Credentials.from_service_account_info(info, scopes=SCOPES)
    path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
    if path and os.path.exists(path):
        return Credentials.from_service_account_file(path, scopes=SCOPES)
    from google.auth import default
    creds, _ = default(scopes=SCOPES)
    return creds

def _gc():
    creds = _get_creds()
    return gspread.authorize(creds)

def get_coop_info() -> Dict[str, Any]:
    """Lê config/coop.yaml e retorna dados de apresentação."""
    import yaml, os
    base = os.path.dirname(os.path.dirname(__file__))
    path = os.path.join(base, "config", "coop.yaml")
    if not os.path.exists(path):
        return {"text": "Cooperativa: informações indisponíveis no momento.", "mensagens": {}}
    with open(path, "r", encoding="utf-8") as f:
        cfg = yaml.safe_load(f)
    texto = f"Cooperativa: {cfg.get('nome','(nome)')}\n"
    if cfg.get("cota"): texto += f"- Cota: {cfg['cota']}\n"
    if cfg.get("uniforme_bag"): texto += f"- Uniforme/Bag: {cfg['uniforme_bag']}\n"
    if cfg.get("beneficios"): texto += f"- Benefícios: {cfg['beneficios']}\n"
    return {"text": texto.strip(), "mensagens": cfg.get("mensagens", {}), "raw": cfg}

def get_open_positions(cidade: str) -> Dict[str, Any]:
    """Lista vagas com status=Aberto na aba Vagas (filtra por cidade)."""
    with timeit('sheets_get_open_positions'):
        gc = _gc()
        sh = gc.open_by_key(SPREADSHEET_ID)
        ws = sh.worksheet("Vagas")
        records = ws.get_all_records()
    cidade_lower = (cidade or "").strip().lower()
    def ok(r):
        return str(r.get("status","")).strip().lower() == "aberto" and cidade_lower in str(r.get("cidade","")).strip().lower()
    rows = [{
        "id_vaga": r.get("id_vaga"),
        "farmacia": r.get("farmacia"),
        "cidade": r.get("cidade"),
        "turno": r.get("turno"),
        "taxa_entrega": r.get("taxa_entrega"),
        "status": r.get("status"),
    } for r in records if ok(r)]
    log_event('sheets.vagas.count', total=len(rows), cidade=cidade)
    return {"vagas": rows}

def get_position_by_id(id_vaga: str) -> Dict[str, Any]:
    """Recupera uma vaga específica pelo id_vaga na aba Vagas."""
    with timeit('sheets_get_position_by_id'):
        gc = _gc()
        sh = gc.open_by_key(SPREADSHEET_ID)
        ws = sh.worksheet("Vagas")
        records = ws.get_all_records()
    for r in records:
        if str(r.get("id_vaga")) == str(id_vaga):
            return {"vaga": {
                "id_vaga": r.get("id_vaga"),
                "farmacia": r.get("farmacia"),
                "cidade": r.get("cidade"),
                "turno": r.get("turno"),
                "taxa_entrega": r.get("taxa_entrega"),
                "status": r.get("status"),
            }}
    return {"vaga": None}

def save_lead(
    lead_nome: Optional[str],
    whatsapp: Optional[str],
    cidade: Optional[str],
    aprovado: Optional[bool],
    vaga_escolhida: Optional[str],
    farmacia: Optional[str]=None,
    turno: Optional[str]=None,
    taxa_entrega: Optional[str]=None,
    observacoes: Optional[str]=None,
) -> Dict[str, Any]:
    """Insere linha na aba Leads."""
    with timeit('sheets_save_lead_open'):
        gc = _gc()
        sh = gc.open_by_key(SPREADSHEET_ID)
    try:
        ws = sh.worksheet("Leads")
    except gspread.WorksheetNotFound:
        ws = sh.add_worksheet(title="Leads", rows=2000, cols=20)
        ws.append_row(["timestamp_iso","lead_nome","whatsapp","cidade","aprovado","id_vaga_escolhida","farmacia_escolhida","turno","taxa_entrega","observacoes"])
    row = [
        iso_now(), lead_nome or "", whatsapp or "", cidade or "",
        "TRUE" if aprovado else "FALSE",
        vaga_escolhida or "", farmacia or "", turno or "", taxa_entrega or "", observacoes or ""
    ]
    with timeit('sheets_save_lead_append'):
        ws.append_row(row)
    log_event('sheets.lead.saved', aprovado=aprovado, cidade=cidade, vaga=vaga_escolhida)
    return {"status":"ok","saved": True}
