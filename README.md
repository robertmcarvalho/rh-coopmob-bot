# RH CoopMob Bot

Agente de IA para RH focado no processo seletivo de entregadores motoboys via WhatsApp.

## Estrutura do Repositório

- `docker-compose.yml` — blueprint para desenvolvimento local de n8n + Redis  
- `rh-coopmob-workflow.json` — workflow n8n pronto para importar  
- `README.md` — guia de uso e deploy

## Uso Local

```bash
git clone git@github.com:<seu-usuario>/<seu-repo>.git
cd <seu-repo>
echo "N8N_BASIC_AUTH_USER=seu_usuario" > .env
echo "N8N_BASIC_AUTH_PASSWORD=sua_senha" >> .env
docker-compose up -d
```

Acesse `http://localhost:5678`, importe o workflow e configure credenciais.

## Deploy no Render

1. Push para GitHub (`main`)  
2. No Render: crie Redis Instance e Web Service apontando para este repo  
3. Defina vars:
   - `N8N_BASIC_AUTH_USER`
   - `N8N_BASIC_AUTH_PASSWORD`
   - `GENERIC_TIMEZONE=America/Sao_Paulo`
   - `N8N_REDIS_URL=<URL da Redis Instance>`
4. Configure Twilio Webhook para `https://<app>.onrender.com/webhook/whatsapp-inbound`
