# Kelly — Docker (Webhook CX + Middleware WhatsApp)

Este pacote roda **num único container**:
- **/cx (POST)** → Webhook do Dialogflow CX (tags: `verificar_cidade`, `analisar_perfil`, `listar_vagas`, `navegar_vagas`, `selecionar_vaga`, `salvar_lead`)
- **/wa/webhook (GET/POST)** → Webhook do WhatsApp Cloud API (renderiza botões, envia/recebe via CX)

## Como usar (local)

1) **Crie o arquivo `.env`** a partir de `.env.example` e preencha:
   - `WA_TOKEN`, `WA_PHONE_ID`, `WA_VERIFY_TOKEN`
   - `GCLOUD_PROJECT`, `CX_LOCATION`, `CX_AGENT_ID`
   - `SHEETS_VAGAS_ID`, `SHEETS_LEADS_ID`, `PIPEFY_LINK`

2) **Credenciais Google**  
   - Baixe o JSON da **Service Account** com acesso ao Sheets e ao CX.  
   - Salve como `service-account.json` na pasta raiz.  
   - O `docker-compose.yml` já monta o arquivo em `/secrets/sa.json` e define `GOOGLE_APPLICATION_CREDENTIALS`.

3) **Suba o container**
```bash
docker compose up --build
# App em http://localhost:8080
```

4) **Configurar o WhatsApp Cloud API** (Facebook Developers → Webhooks):
   - **Callback URL**: `https://<seu-host>/wa/webhook`
   - **Verify token**: mesmo valor de `WA_VERIFY_TOKEN`
   - Assine o campo **messages**.

5) **Configurar Webhook no Dialogflow CX**:
   - **Manage → Webhooks → Create**
   - **Display name**: Kelly Webhook
   - **URL**: `https://<seu-host>/cx` (ou `http://localhost:8080/cx` durante testes com ngrok)
   - Salvar

6) **Rotas nas páginas** (resumo):
   - `ColetarCidade` → rota FINAL → Webhook `verificar_cidade`
   - `AnalisePerfil` → Entry → Webhook `analisar_perfil`
   - `OfertarVagas` → Entry → Webhook `listar_vagas`
     - Intent **ProximaVaga** → Webhook `navegar_vagas` (permanece na mesma página)
     - Intent **EscolherVaga** (`vaga_id`) → Webhook `selecionar_vaga` → **SalvarLead**
     - (Opcional) Condition `$session.params.vaga_id != null` → **SalvarLead**
   - `SalvarLead` → Entry → Webhook `salvar_lead`

## Endpoints
- **POST /cx** — Webhook CX (corpo padrão do CX).
- **GET /wa/webhook** — verificação do WhatsApp (usa `WA_VERIFY_TOKEN`).
- **POST /wa/webhook** — mensagens do WhatsApp Cloud API.

## Dica: usar ngrok
```bash
ngrok http 8080
# configure no Dashboard do WhatsApp a URL do ngrok: https://<subdominio>.ngrok.io/wa/webhook
# no CX, use https://<subdominio>.ngrok.io/cx
```

## Templates de planilhas
Veja em `templates/`:
- `Vagas_template.csv`: `VAGA_ID,CIDADE,FARMACIA,TAXA_ENTREGA,TURNO,STATUS`
- `Leads_template.csv`: `DATA_ISO,NOME,TELEFONE,CIDADE,Q1,Q2,Q3,Q4,Q5,PERFIL_APROVADO,PERFIL_NOTA,PERFIL_RESUMO,VAGA_ID,FARMACIA,TURNO,TAXA_ENTREGA,PROTOCOLO`

