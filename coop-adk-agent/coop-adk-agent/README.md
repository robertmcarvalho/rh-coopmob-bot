# Coop Bot (ADK + Gemini + Cloud Run + WhatsApp)

Agente conversacional para triagem de entregadores (leads) usando **Google ADK (Python)**, **Gemini (AI Studio)**,
**Google Sheets** e **Upstash Redis** (memória por 5 dias). Integração direta com **WhatsApp Cloud API** (webhook).

## Requisitos
- Python 3.10+
- Conta no **AI Studio** (Gemini) — `GOOGLE_API_KEY`
- **Google Sheets** com abas `Vagas` e `Leads`
- **Upstash Redis** (REST URL/TOKEN)
- **WhatsApp Cloud API** (Phone Number ID, Permanent Token)
- `gcloud` para deploy no **Cloud Run**

## Estrutura
```
apps/
  coop_agent/
    agent.py
    prompts.py
    config/coop.yaml
    tools/
      audio.py
      assessment.py
      memory.py
      pipefy.py
      requirements_check.py
      sheets.py
      telemetry.py
      utils.py
      whatsapp.py
server.py
Dockerfile
requirements.txt
.env.example
README.md
tests/payloads/whatsapp_text.json
tests/payloads/whatsapp_list_reply.json
scripts/simulate_whatsapp.sh
```

## Rodando local
1. `cp .env.example .env` (preencher variáveis)
2. `pip install -r requirements.txt`
3. `uvicorn server:app --reload`

Docs do webhook: você mesmo define no Facebook Developers; este app expõe:
- `GET /webhook` (verificação)
- `POST /webhook` (mensagens)

## Sheets
- **Vagas**: `id_vaga, farmacia, cidade, turno, taxa_entrega, status`
- **Leads**: `timestamp_iso, lead_nome, whatsapp, cidade, aprovado, id_vaga_escolhida, farmacia_escolhida, turno, taxa_entrega, observacoes`

## Deploy Cloud Run
```bash
gcloud run deploy coop-adk-agent   --source=.   --region=us-central1   --allow-unauthenticated   --service-account=coop-adk-sa@SEU-PROJETO.iam.gserviceaccount.com   --set-env-vars=GOOGLE_API_KEY=***,GOOGLE_GENAI_USE_VERTEXAI=false,GENAI_MODEL=gemini-2.0-flash,SPREADSHEET_ID=***,PIPEFY_URL=***,UPSTASH_REDIS_REST_URL=***,UPSTASH_REDIS_REST_TOKEN=***,REDIS_TTL_SECONDS=432000,WHATSAPP_VERIFY_TOKEN=***,WHATSAPP_TOKEN=***,WHATSAPP_PHONE_NUMBER_ID=***
```

## Workload Identity (WIA) — sem SA_JSON
1. Habilite **Sheets API**.
2. Use um **Service Account** no Cloud Run (`--service-account ...`).
3. **Compartilhe a planilha** com o e-mail da SA (permissão Editor).
4. O código usa **ADC** (Application Default Credentials) por padrão.

## Mensagens interativas (WhatsApp List)
- O agente chama `send_vagas_list(to, vagas)` que envia **lista interativa** (até 10 linhas).
- A seleção do usuário chega como `interactive.list_reply.id` (`vaga:<ID>`). O webhook traduz para `selecionar_vaga <ID>` e envia ao agente.

## Observabilidade
- Logs estruturados (JSON) e **latência por etapa** (`timing`).
- Política de retenção: mensagens ao WhatsApp **limitadas a 4096 chars**.

Boa implantação! :)
