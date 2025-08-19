# Kelly Combined v3

Webhook do Dialogflow CX + Middleware WhatsApp + Memória (Upstash Redis) + Áudio (STT).

## Novidades
- **Memória persistente** por telefone (Upstash Redis): lembra nome, cidade, progresso e dados do lead entre conversas.
- **Áudio**: baixa mídia do WhatsApp e transcreve via Google Cloud Speech (`pt-BR`), enviando a transcrição ao CX.
- **Correções** no handler `/cx` (estrutura `if/else if`, respostas em bolhas separadas).
- **Salvar Lead** exatamente neste formato:  
  `DATA_ISO | NOME | TELEFONE | DATA_ISO | Q1 | Q2 | Q3 | Q4 | Q5 | PERFIL_APROVADO | PERFIL_NOTA | PERFIL_RESUMO | PROTOCOLO`.

## Variáveis de ambiente
Veja `.env.example`. Principais:
- `WA_TOKEN`, `WA_PHONE_ID`, `WA_VERIFY_TOKEN`
- `GCLOUD_PROJECT`, `CX_LOCATION`, `CX_AGENT_ID`
- `SHEETS_VAGAS_ID`, `SHEETS_LEADS_ID`
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`
- `MEM_TTL_SECONDS` (opcional; padrão 30 dias)

## Deploy (Cloud Run)
1. Configure as variáveis no serviço (ou use Secrets).
2. Garanta **Allow unauthenticated**.
3. Endpoint do CX (regional) é automático via `CX_LOCATION` (ex.: `us-central1-dialogflow.googleapis.com`).

## Webhooks
- **Dialogflow CX** → `POST /cx`
- **WhatsApp**  
  - Verify: `GET /wa/webhook?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...`  
  - Receive: `POST /wa/webhook`

## Dicas de CX
- Em `ColetarCidade → rota status FINAL`, **apenas** chame o webhook `verificar_cidade` (não mande a frase “vou verificar…” ali; já sai do webhook).
- `Requisitos`: use entidade `@bool_pt` (Map) com values `"true"`/`"false"` e sinônimos `sim/não`; rotas de corte com `"false"`, avanço com `"true"` AND ...
- `PerguntasComportamentais`: prompts humanizados (1–2 frases), parâmetros `q1..q5` como Required.

## Testes
- Curl `/cx`:
```bash
curl -s -X POST "$RUN_URL/cx" -H "Content-Type: application/json" -d '{
  "fulfillmentInfo": { "tag": "analisar_perfil" },
  "sessionInfo": { "parameters": { "q1":"confirmo com o líder", "q2":"tento contato e atualizo em 2 min", "q3":"aciono a central", "q4":"registro no app e aviso a farmácia", "q5":"aviso clientes com antecedência e priorizo urgentes", "nome":"João" } }
}'
```
- Envie **áudio** pelo WhatsApp: deve virar texto e seguir o fluxo normalmente.

## Licença
MIT
