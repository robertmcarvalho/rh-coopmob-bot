// Combined server: Dialogflow CX Webhook (/cx) + WhatsApp middleware (/wa/webhook)
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { google } = require('googleapis');
const { SessionsClient } = require('@google-cloud/dialogflow-cx');
const { struct } = require('pb-util');

// ---- ENV ----
const {
  PORT = 8080,
  // WA
  WA_TOKEN, WA_PHONE_ID, WA_VERIFY_TOKEN,
  // CX Sessions
  GCLOUD_PROJECT, CX_LOCATION, CX_AGENT_ID,
  // Sheets + Pipefy
  SHEETS_VAGAS_ID, SHEETS_LEADS_ID,
  SHEETS_VAGAS_TAB = 'Vagas',
  SHEETS_LEADS_TAB = 'Leads',
  PIPEFY_LINK = 'https://seu-link-do-pipefy-aqui'
} = process.env;

// ---- App ----
const app = express();
app.use(bodyParser.json());

// ---- Google Sheets Auth (ADC no Cloud Run) ----
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
async function sheetsClient() {
  const auth = new google.auth.GoogleAuth({ scopes: SCOPES });
  const gauth = await auth.getClient();
  return google.sheets({ version: 'v4', auth: gauth });
}

// ---- Helpers ----
const t = (msg) => ({ text: { text: [msg] } });
const payload = (obj) => ({ payload: obj });
const nowISO = () => new Date().toISOString();
const unaccent = (s = '') => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const eqCity = (a, b) =>
  unaccent(String(a)).toUpperCase().trim() === unaccent(String(b)).toUpperCase().trim();
// Helpers de texto
const norm = (s='') => unaccent(String(s)).toLowerCase();
const hasAny = (s, terms=[]) => terms.some(t => norm(s).includes(norm(t)));
const within5min = (s) => {
  const txt = norm(s);
  if (/(imediat|na hora|instant)/.test(txt)) return true;
  const m = txt.match(/(\d+)\s*min/);
  return m ? Number(m[1]) <= 5 : false;
};

// Avaliação por questão (retorna {ok, motivo})
function evalQ1(a) { // Rota urgente / múltiplas coletas: decide sozinho x confirma com líder
  const txt = norm(a);
  const alinhamento = hasAny(txt, ['confirmo', 'alinho', 'combino', 'valido', 'consulto', 'falo'])
                   && hasAny(txt, ['lider', 'supervisor', 'coordenador', 'central', 'cooperativa', 'dispatch', 'gestor']);
  const sozinho = hasAny(txt, ['sozinho', 'por conta', 'eu decido', 'eu escolho']);
  return alinhamento && !sozinho
    ? { ok:true, motivo:'Alinhou rota com liderança/central.' }
    : { ok:false, motivo:'Deveria alinhar a rota com liderança/central em urgências.' };
}

function evalQ2(a) { // Cliente ausente: contato e atualização rápida
  const txt = norm(a);
  const contata = hasAny(txt, ['ligo', 'ligar', 'whatsapp', 'chamo', 'entro em contato', 'tento contato', 'tento contactar', 'tento contatar']);
  const atualiza = hasAny(txt, ['atualizo', 'registro', 'marco no app', 'sistema', 'plataforma']);
  const rapido = within5min(txt);
  return (contata && atualiza && rapido)
    ? { ok:true, motivo:'Tenta contato e atualiza o sistema em até 5 min.' }
    : { ok:false, motivo:'Esperado: tentar contato e atualizar o sistema rapidamente (≤5 min).' };
}

function evalQ3(a) { // Conflito orientação: quem aciona
  const txt = norm(a);
  const aciona = hasAny(txt, ['aciono', 'consulto', 'informo', 'alinho', 'escalo'])
              && hasAny(txt, ['lider', 'coordenador', 'central', 'cooperativa', 'gestor']);
  return aciona
    ? { ok:true, motivo:'Escala/alinha com liderança/central no conflito.' }
    : { ok:false, motivo:'Deveria escalar para liderança/central quando há conflito.' };
}

function evalQ4(a) { // Item faltando: registro + quem informa primeiro
  const txt = norm(a);
  const registra = hasAny(txt, ['registro', 'foto', 'nota', 'app', 'sistema', 'comprovante']);
  const informa = hasAny(txt, ['farmacia', 'expedicao', 'balcao', 'responsavel', 'lider', 'coordenador']);
  return (registra && informa)
    ? { ok:true, motivo:'Registra evidência e informa farmácia/liderança.' }
    : { ok:false, motivo:'Esperado: registrar (app/foto) e informar farmácia/liderança.' };
}

function evalQ5(a) { // Atraso: comunicação, antecedência, prioridade
  const txt = norm(a);
  const comunicaCliente = hasAny(txt, ['cliente', 'clientes']);
  const comunicaBase = hasAny(txt, ['farmacia', 'lider', 'coordenador', 'central', 'cooperativa']);
  const antecedencia = hasAny(txt, ['antecedencia', 'assim que', 'o quanto antes', 'imediat']);
  const prioriza = hasAny(txt, ['priorizo', 'prioridade', 'rota', 'urgente', 'urgencias']);
  const pontos = [comunicaCliente, comunicaBase, (antecedencia || within5min(txt)), prioriza].filter(Boolean).length;
  return pontos >= 2
    ? { ok:true, motivo:'Comunica e ajusta priorização diante do atraso.' }
    : { ok:false, motivo:'Esperado: comunicar (cliente/base), avisar com antecedência e priorizar entregas.' };
}

function scorePerfil({ q1, q2, q3, q4, q5 }) {
  const avals = [evalQ1(q1), evalQ2(q2), evalQ3(q3), evalQ4(q4), evalQ5(q5)];
  const nota = avals.filter(a => a.ok).length;
  const aprovado = nota >= 4; // ajuste de corte
  const feedback = avals.map((a, i) => `Q${i+1}: ${a.ok ? 'OK' : 'Ajustar'} — ${a.motivo}`);
  return { aprovado, nota, feedback };
}


async function getRows(spreadsheetId, rangeA1) {
  const sheets = await sheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: rangeA1 });
  const values = res.data.values || [];
  if (!values.length) return { header: [], rows: [] };
  const header = values[0];
  const rows = values.slice(1).map((r) => {
    const o = {};
    header.forEach((h, i) => (o[h] = r[i]));
    return o;
  });
  return { header, rows };
}
async function appendRow(spreadsheetId, rangeA1, rowArray) {
  const sheets = await sheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: rangeA1,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [rowArray] }
  });
}

// ---- Vacancy helpers ----
function serializeVagas(list) {
  return list.map((v) => ({
    VAGA_ID: v.VAGA_ID,
    CIDADE: v.CIDADE,
    FARMACIA: v.FARMACIA,
    TAXA_ENTREGA: v.TAXA_ENTREGA,
    TURNO: v.TURNO,
    STATUS: v.STATUS
  }));
}
function vagaToLine(v) {
  const taxa = Number(v.TAXA_ENTREGA || 0);
  const taxaFmt = isNaN(taxa) ? v.TAXA_ENTREGA : taxa.toFixed(2);
  return `ID ${v.VAGA_ID} — ${v.FARMACIA} — ${v.TURNO} — R$ ${taxaFmt}`;
}
function browseMessage(v, idx, total) {
  return [
    t(`Opção ${idx + 1}/${total}: ${vagaToLine(v)}`),
    payload({
      type: 'choices',
      choices: [
        {
          id: `select:${v.VAGA_ID}`,
          title: `Quero essa (ID ${v.VAGA_ID})`,
          data: { action: 'select', vaga_id: String(v.VAGA_ID) }
        },
        { id: `next`, title: 'Próxima', data: { action: 'next' } }
      ]
    }),
    t(`Responda "quero ${v.VAGA_ID}" para escolher, ou "próxima" para ver outra.`)
  ];
}

// ---------------- CX WEBHOOK (/cx) ----------------
app.post('/cx', async (req, res) => {
  try {
    const body = req.body || {};
    const tag = body.fulfillmentInfo?.tag;
    const params = body.sessionInfo?.parameters || {};
    let session_params = {};
    let messages = [];

    const { rows } = await (tag === 'verificar_cidade' || tag === 'listar_vagas'
      ? getRows(SHEETS_VAGAS_ID, `${SHEETS_VAGAS_TAB}!A1:Z`)
      : { rows: [] });

    if (tag === 'verificar_cidade') {
      // aceita @sys.geo-city (string) ou @sys.location (objeto) e ignora placeholder
      const raw =
        params.cidade ||
        params['sys.geo-city'] ||
        params['sys.location'] ||
        params.location ||
        '';

      const cidade =
        typeof raw === 'object'
          ? raw.city || raw['admin-area'] || raw.original || ''
          : String(raw);

      // nome do WhatsApp (primeiro nome)
      const nome = (params.nome || '').toString().trim();
      const firstName = nome ? nome.split(' ')[0] : '';
      const prefixo = firstName ? `${firstName}, ` : '';

      // bolha 1: sempre avisa que vai verificar (personalizada)
      const bolhaBusca = t(
        `Obrigado${firstName ? `, ${firstName}` : ''}! Vou verificar vagas na sua cidade…`
      );

      if (!cidade || cidade.toLowerCase() === 'geo-city') {
        session_params = { vagas_abertas: false };
        messages = [bolhaBusca, t(`${prefixo}não entendi a cidade. Pode informar de novo?`)];
      } else {
        const abertas = rows.filter(
          (r) => eqCity(r.CIDADE, cidade) && String(r.STATUS || '').toLowerCase() === 'aberto'
        );
        const vagas_abertas = abertas.length > 0;
        session_params = { vagas_abertas, cidade };
        messages = [
          bolhaBusca,
          vagas_abertas
            ? t(`Ótimo! ${prefixo}temos vagas em ${cidade}.`)
            : t(`Poxa… ${prefixo}no momento não há vagas em ${cidade}.`)
        ];
      }
else if (tag === 'analisar_perfil') {
  const { q1,q2,q3,q4,q5, nome } = params;
  const r = scorePerfil({ q1,q2,q3,q4,q5 });

  const firstName = (nome || '').toString().trim().split(' ')[0] || '';
  const cabecalho = firstName
    ? `Obrigado, ${firstName}! Vou analisar seu perfil rapidamente.`
    : 'Obrigado! Vou analisar seu perfil rapidamente.';

  const status = r.aprovado ? 'Aprovado' : 'Em avaliação/Reprovado';
  const resumo = `Perfil: ${status} (nota ${r.nota}/5).`;
  const bullets = r.feedback.map(l => `• ${l}`).join('\n');

  session_params = { perfil_aprovado:r.aprovado, perfil_nota:r.nota, perfil_resumo: r.feedback.join(' | ') };

  messages = [
    t(cabecalho),
    t(resumo),
    t(bullets)
  ];
}
    } else if (tag === 'listar_vagas') {
      const cidade = params.cidade || '';
      const candidatas = rows.filter(
        (r) => eqCity(r.CIDADE, cidade) && String(r.STATUS || '').toLowerCase() === 'aberto'
      );
      const total = candidatas.length;
      if (!total) {
        session_params = { listado: true, vagas_lista: [], vagas_idx: 0, vagas_total: 0 };
        messages = [t('Não encontrei vagas abertas neste momento.')];
      } else {
        const lista = serializeVagas(candidatas);
        const idx = 0;
        session_params = { listado: true, vagas_lista: lista, vagas_idx: idx, vagas_total: total };
        messages = browseMessage(lista[idx], idx, total);
      }
    } else if (tag === 'navegar_vagas') {
      const lista = params.vagas_lista || [];
      let idx = Number(params.vagas_idx || 0);
      const total = Number(params.vagas_total || lista.length || 0);
      if (!total) {
        messages = [t('Não há mais vagas para navegar.')];
      } else {
        idx = (idx + 1) % total;
        session_params = { vagas_idx: idx };
        messages = browseMessage(lista[idx], idx, total);
      }
    } else if (tag === 'selecionar_vaga') {
      const lista = params.vagas_lista || [];
      const vagaId = (params.vaga_id || params.VAGA_ID || '').toString().trim();
      const v = lista.find((x) => String(x.VAGA_ID).trim() === vagaId);
      if (!v) {
        messages = [t(`Não encontrei a vaga ID ${vagaId} nas opções.`)];
      } else {
        session_params = {
          vaga_id: v.VAGA_ID,
          vaga_farmacia: v.FARMACIA,
          vaga_turno: v.TURNO,
          vaga_taxa: Number(v.TAXA_ENTREGA || 0)
        };
        messages = [
          t(`Perfeito! Você escolheu: ${vagaToLine(v)}.`),
          t('Vou registrar seus dados e te enviar o link de inscrição.')
        ];
      }
  else if (tag === 'salvar_lead') {
  const {
    nome, telefone,
    q1, q2, q3, q4, q5,
    perfil_aprovado, perfil_nota, perfil_resumo
  } = params;

  const protocolo = `LEAD-${Date.now().toString().slice(-6)}`;
  const dataISO1 = nowISO();
  const dataISO2 = dataISO1; // você pediu dois DATA_ISO; gravamos o mesmo timestamp

  // Ordem das colunas na planilha Leads (A → M):
  // DATA_ISO | NOME | TELEFONE | DATA_ISO | Q1 | Q2 | Q3 | Q4 | Q5 | PERFIL_APROVADO | PERFIL_NOTA | PERFIL_RESUMO | PROTOCOLO
  const linha = [
    dataISO1,
    nome || '',
    telefone || '',
    dataISO2,
    q1 || '',
    q2 || '',
    q3 || '',
    q4 || '',
    q5 || '',
    (perfil_aprovado ? 'Aprovado' : 'Reprovado'),
    (perfil_nota ?? ''),
    (perfil_resumo ?? ''),
    protocolo
  ];

  await appendRow(SHEETS_LEADS_ID, `${SHEETS_LEADS_TAB}!A1:Z1`, linha);

  session_params = { protocolo };
  messages = [
    t(`Cadastro concluído! Protocolo: ${protocolo}`),
    t(`Finalize sua inscrição: ${PIPEFY_LINK}`)
  ];
}
    res.json({
      fulfillment_response: { messages },
      session_info: { parameters: { ...params, ...session_params } }
    });
  } catch (e) {
    console.error(e?.response?.data || e);
    res.json({ fulfillment_response: { messages: [t('Erro interno no webhook.')] } });
  }
});

// ---------------- WA MIDDLEWARE (/wa/webhook) ----------------
const WA_BASE = 'https://graph.facebook.com/v20.0';

async function waSendText(to, text) {
  return axios.post(
    `${WA_BASE}/${WA_PHONE_ID}/messages`,
    { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
    { headers: { Authorization: `Bearer ${WA_TOKEN}` } }
  );
}
async function waSendButtons(to, bodyText, buttons) {
  const actionButtons = buttons.slice(0, 3).map((b) => ({
    type: 'reply',
    reply: { id: b.id, title: (b.title || 'Opção').slice(0, 20) }
  }));
  return axios.post(
    `${WA_BASE}/${WA_PHONE_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: bodyText.slice(0, 1024) },
        action: { buttons: actionButtons }
      }
    },
    { headers: { Authorization: `Bearer ${WA_TOKEN}` } }
  );
}

// util: pequena pausa entre envios
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// util: divide um texto em parágrafos/bloquinhos (duas quebras de linha = novo bloco)
function splitIntoSegments(text) {
  if (!text) return [];
  const rough = String(text)
    .split(/\n{2,}/g)
    .map((s) => s.trim())
    .filter(Boolean);
  const maxLen = 900;
  const segments = [];
  for (const part of rough) {
    if (part.length <= maxLen) {
      segments.push(part);
    } else {
      const lines = part.split('\n');
      let acc = '';
      for (const ln of lines) {
        if ((acc + (acc ? '\n' : '') + ln).length > maxLen) {
          if (acc) segments.push(acc);
          acc = ln;
        } else {
          acc = acc ? acc + '\n' + ln : ln;
        }
      }
      if (acc) segments.push(acc);
    }
  }
  return segments;
}

// envia um "Agent response" em várias bolhas, com pacing
async function waSendBurst(to, rawText, delayMs = 450) {
  const segments = splitIntoSegments(rawText);
  if (!segments.length) return;
  for (const seg of segments) {
    await waSendText(to, seg);
    await sleep(delayMs);
  }
}

// ---- CX Sessions (endpoint regional) ----
const DFCX_ENDPOINT = `${CX_LOCATION}-dialogflow.googleapis.com`;
const cxClient = new SessionsClient({ apiEndpoint: DFCX_ENDPOINT });

function sessionPath(waId) {
  return cxClient.projectLocationAgentSessionPath(
    GCLOUD_PROJECT,
    CX_LOCATION,
    CX_AGENT_ID,
    waId
  );
}
async function cxDetectText(waId, text, params = {}) {
  const request = {
    session: sessionPath(waId),
    queryInput: { text: { text }, languageCode: 'pt-BR' },
    queryParams: { parameters: struct.encode(params) }
  };
  const [resp] = await cxClient.detectIntent(request);
  return resp;
}

// Helpers payload
function isChoicesPayload(m) {
  return (
    m &&
    m.payload &&
    ((m.payload.fields &&
      m.payload.fields.type &&
      m.payload.fields.type.stringValue === 'choices') ||
      m.payload.type === 'choices')
  );
}
function decodePayload(m) {
  try {
    if (m.payload && m.payload.fields) return require('pb-util').struct.decode(m.payload);
  } catch {}
  return m.payload || {};
}
function buttonsFromChoices(choices = []) {
  return choices.slice(0, 3).map((ch) => {
    const data = ch.data || {};
    let id = ch.id || '';
    if (!id && data.action)
      id = data.action === 'select' && data.vaga_id ? `select:${data.vaga_id}` : data.action;
    const title = ch.title || (data.action === 'next' ? 'Próxima' : `Quero ${data.vaga_id || ''}`);
    return { id, title };
  });
}
function parseButtonId(id) {
  if (!id) return { action: 'unknown' };
  const [action, rest] = id.split(':');
  if (action === 'select') return { action, vaga_id: (rest || '').trim() };
  if (action === 'next') return { action };
  try {
    return JSON.parse(id);
  } catch {}
  return { action: id };
}

// Verify endpoint (WhatsApp)
app.get('/wa/webhook', (req, res) => {
  const { ['hub.mode']: mode, ['hub.verify_token']: token, ['hub.challenge']: challenge } =
    req.query;
  if (mode === 'subscribe' && token === WA_VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// Receive messages (WhatsApp → CX → WhatsApp)
app.post('/wa/webhook', async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const messages = changes?.value?.messages;
    const contacts = changes?.value?.contacts;
    if (!messages || !messages.length) return res.sendStatus(200);

    for (const msg of messages) {
      const from = msg.from;
      const profileName = contacts?.[0]?.profile?.name;
      let userText = null;
      const extraParams = { nome: profileName, telefone: from };

      if (msg.type === 'text') {
        userText = msg.text?.body?.trim();
      } else if (msg.type === 'interactive') {
        if (msg.interactive.type === 'button_reply') {
          const id = msg.interactive.button_reply?.id;
          const parsed = parseButtonId(id);
          if (parsed.action === 'next') userText = 'próxima';
          else if (parsed.action === 'select') {
            userText = `quero ${parsed.vaga_id}`;
            extraParams.vaga_id = parsed.vaga_id;
          } else userText = parsed.action;
        } else if (msg.interactive.type === 'list_reply') {
          const id = msg.interactive.list_reply?.id;
          const parsed = parseButtonId(id);
          if (parsed.action === 'select') {
            userText = `quero ${parsed.vaga_id}`;
            extraParams.vaga_id = parsed.vaga_id;
          } else userText = 'próxima';
        }
      } else {
        userText = '[anexo recebido]';
      }

      // Dialogflow CX
      const cxResp = await cxDetectText(from, userText, extraParams);
      const outputs = cxResp.queryResult?.responseMessages || [];

      for (const m of outputs) {
        if (isChoicesPayload(m)) {
          const decoded = decodePayload(m);
          await waSendButtons(from, 'Escolha uma opção:', buttonsFromChoices(decoded.choices || []));
          continue;
        }
        if (m.text && Array.isArray(m.text.text)) {
          for (const raw of m.text.text) {
            const line = (raw || '').trim();
            if (!line) continue;
            await waSendBurst(from, line, 450); // bolhas separadas + pacing
          }
          continue;
        }
        // fallback
        await waSendText(from, '[mensagem recebida]');
      }
    }
    res.sendStatus(200);
  } catch (e) {
    console.error(e?.response?.data || e);
    res.sendStatus(200);
  }
});

app.listen(PORT, () =>
  console.log(
    `Kelly combined on :${PORT} (/cx, /wa/webhook) — CX endpoint: ${CX_LOCATION}-dialogflow.googleapis.com`
  )
);
