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
  // WhatsApp Cloud
  WA_TOKEN, WA_PHONE_ID, WA_VERIFY_TOKEN,
  // Dialogflow CX
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

// ---- Helpers básicos ----
const t = (msg) => ({ text: { text: [msg] } });
const payload = (obj) => ({ payload: obj });
const nowISO = () => new Date().toISOString();
const unaccent = (s = '') => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const eqCity = (a, b) =>
  unaccent(String(a)).toUpperCase().trim() === unaccent(String(b)).toUpperCase().trim();

const norm = (s='') => unaccent(String(s)).toLowerCase();
const hasAny = (s, terms=[]) => terms.some(t => norm(s).includes(norm(t)));
function boolish(v) {
  if (typeof v === 'boolean') return v;
  if (v === 1 || v === '1') return true;
  if (v === 0 || v === '0') return false;
  const s = String(v || '').trim().toLowerCase();
  if (['true','verdadeiro','sim','s','y','yes'].includes(s)) return true;
  if (['false','falso','não','nao','n','no'].includes(s)) return false;
  return false;
}
const within5min = (s) => {
  const txt = norm(s);
  if (/(imediat|na hora|instant)/.test(txt)) return true;
  const m = txt.match(/(\d+)\s*min/);
  return m ? Number(m[1]) <= 5 : false;
};

// ---- Avaliação de perfil (regras) ----
function evalQ1(a) { // rota urgente: confirma com liderança
  const txt = norm(a);
  const alinhamento = hasAny(txt, ['confirmo','alinho','combino','valido','consulto','falo'])
                   && hasAny(txt, ['lider','supervisor','coordenador','central','cooperativa','dispatch','gestor']);
  const sozinho = hasAny(txt, ['sozinho','por conta','eu decido','eu escolho']);
  return alinhamento && !sozinho;
}
function evalQ2(a) { // cliente ausente: contata + atualiza rápido
  const txt = norm(a);
  const contata = hasAny(txt, ['ligo','whatsapp','chamo','entro em contato','tento contato','contacto','contatar']);
  const atualiza = hasAny(txt, ['atualizo','registro','marco no app','sistema','plataforma','app']);
  const rapido = within5min(txt);
  return contata && atualiza && rapido;
}
function evalQ3(a) { // conflito: aciona liderança/central
  const txt = norm(a);
  return hasAny(txt, ['aciono','consulto','informo','alinho','escalo'])
      && hasAny(txt, ['lider','coordenador','central','cooperativa','gestor']);
}
function evalQ4(a) { // item faltando: registra + informa
  const txt = norm(a);
  const registra = hasAny(txt, ['registro','foto','nota','app','sistema','comprovante']);
  const informa = hasAny(txt, ['farmacia','expedicao','balcao','responsavel','lider','coordenador']);
  return registra && informa;
}
function evalQ5(a) { // atraso: comunica cliente/base + antecedência/prioriza
  const txt = norm(a);
  const comunicaCliente = hasAny(txt, ['cliente','clientes']);
  const comunicaBase = hasAny(txt, ['farmacia','lider','coordenador','central','cooperativa']);
  const antecedencia = hasAny(txt, ['antecedencia','assim que','o quanto antes','imediat']) || within5min(txt);
  const prioriza = hasAny(txt, ['priorizo','prioridade','rota','urgente','urgencias']);
  const pontos = [comunicaCliente, comunicaBase, antecedencia, prioriza].filter(Boolean).length;
  return pontos >= 2;
}
function scorePerfil({ q1,q2,q3,q4,q5 }) {
  const ok = [evalQ1(q1), evalQ2(q2), evalQ3(q3), evalQ4(q4), evalQ5(q5)];
  const nota = ok.filter(Boolean).length;
  const aprovado = nota >= 3; // corte = 3
  return { aprovado, nota };
}

// ---- Sheets helpers ----
async function getRows(spreadsheetId, rangeA1) {
  const sheets = await sheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: rangeA1 });
  const values = res.data.values || [];
  if (!values.length) return { header: [], rows: [] };
  const header = values[0];
  const rows = values.slice(1).map(r => {
    const o = {}; header.forEach((h,i)=>o[h]=r[i]); return o;
  });
  return { header, rows };
}
async function appendRow(spreadsheetId, rangeA1, rowArray) {
  const sheets = await sheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId, range: rangeA1,
    valueInputOption:'USER_ENTERED', insertDataOption:'INSERT_ROWS',
    requestBody:{ values:[rowArray] }
  });
}

// ---- Vagas helpers (lista completa + WhatsApp list) ----
function serializeVagas(list) {
  return list.map(v => ({
    VAGA_ID: v.VAGA_ID, CIDADE: v.CIDADE, FARMACIA: v.FARMACIA,
    TAXA_ENTREGA: v.TAXA_ENTREGA, TURNO: v.TURNO, STATUS: v.STATUS
  }));
}
function vagaPreco(v) {
  const raw = v.TAXA_ENTREGA || '';
  const num = Number(String(raw).replace(/[^\d.,-]/g, '').replace(',', '.'));
  if (!Number.isNaN(num)) return `R$ ${num.toFixed(2)}`;
  return String(raw).replace(/^\s*R\$\s*R\$\s*/i, 'R$ ').trim();
}
function vagaToLine(v) {
  return `ID ${v.VAGA_ID} — ${v.FARMACIA} — ${v.TURNO} — ${vagaPreco(v)}`;
}
function vagaRow(v) {
  return {
    id: `select:${v.VAGA_ID}`,
    title: `${v.FARMACIA}`.slice(0, 24),
    description: `${v.TURNO} — ${vagaPreco(v)}`
  };
}

// ---------------- CX WEBHOOK (/cx) ----------------
app.post('/cx', async (req, res) => {
  try {
    const body = req.body || {};
    const tag = body.fulfillmentInfo?.tag;
    const params = body.sessionInfo?.parameters || {};
    let session_params = {};
    let messages = [];

    const { rows } = await (
      tag === 'verificar_cidade' || tag === 'listar_vagas'
        ? getRows(SHEETS_VAGAS_ID, `${SHEETS_VAGAS_TAB}!A1:Z`)
        : { rows: [] }
    );

    if (tag === 'verificar_cidade') {
      const raw = params.cidade || params['sys.geo-city'] || params['sys.location'] || params.location || '';
      const cidade = typeof raw === 'object'
        ? raw.city || raw['admin-area'] || raw.original || ''
        : String(raw);

      const nome = (params.nome || '').toString().trim();
      const firstName = nome ? nome.split(' ')[0] : '';
      const prefixo = firstName ? `${firstName}, ` : '';

      const bolhaBusca = t(`Obrigado${firstName ? `, ${firstName}` : ''}! Vou verificar vagas na sua cidade…`);

      if (!cidade || cidade.toLowerCase() === 'geo-city') {
        session_params = { vagas_abertas: false };
        messages = [bolhaBusca, t(`${prefixo}não entendi a cidade. Pode informar de novo?`)];

      } else {
        const abertas = rows.filter(r => eqCity(r.CIDADE, cidade) && String(r.STATUS||'').toLowerCase()==='aberto');
        const vagas_abertas = abertas.length>0;
        session_params = { vagas_abertas, cidade };
        messages = [
          bolhaBusca,
          vagas_abertas ? t(`Ótimo! ${prefixo}temos vagas em ${cidade}.`)
                        : t(`Poxa… ${prefixo}no momento não há vagas em ${cidade}.`)
        ];
      }

    } else if (tag === 'gate_requisitos') {
      const nome = (params.nome || '').toString().trim();
      const firstName = nome ? nome.split(' ')[0] : '';
      const moto = boolish(params.moto_ok);
      const cnh = boolish(params.cnh_ok);
      const android = boolish(params.android_ok);

      if (moto && cnh && android) {
        session_params = { requisitos_ok: true };
        messages = [
          t(`${firstName ? firstName + ', ' : ''}perfeito! Você atende aos requisitos básicos.`),
          t('Vamos fazer uma avaliação rápida do seu perfil com 5 situações reais do dia a dia. Responda de forma objetiva, combinado?')
        ];
      } else {
        const faltas = [];
        if (!moto) faltas.push('moto com documentação em dia');
        if (!cnh) faltas.push('CNH A válida');
        if (!android) faltas.push('celular Android com internet');
        const lista = faltas.map(f => `• ${f}`).join('\n');
        session_params = { requisitos_ok: false };
        messages = [
          t(`Poxa${firstName ? ', ' + firstName : ''}… para atuar conosco é necessário atender a todos os requisitos:`),
          t(lista || 'Requisitos não atendidos.'),
          t('Se quiser, posso te avisar quando abrirmos oportunidades que não exijam todos esses itens. Tudo bem?')
        ];
      }

    } else if (tag === 'analisar_perfil') {
      const { q1,q2,q3,q4,q5, nome } = params;
      const r = scorePerfil({ q1,q2,q3,q4,q5 });

      const firstName = (nome || '').toString().trim().split(' ')[0] || '';
      const cabecalho = firstName
        ? `Obrigado, ${firstName}! Vou analisar seu perfil rapidamente.`
        : 'Obrigado! Vou analisar seu perfil rapidamente.';

      session_params = { perfil_aprovado: r.aprovado, perfil_nota: r.nota, perfil_resumo: r.aprovado ? 'Aprovado' : 'Reprovado' };

      messages = r.aprovado
        ? [ t(cabecalho), t('✅ Perfil aprovado! Vamos seguir.') ]
        : [ t(cabecalho), t('Obrigado por se candidatar! Pelo perfil informado, neste momento não seguiremos com a vaga. Podemos te avisar quando houver oportunidades mais compatíveis?') ];

    } else if (tag === 'listar_vagas') {
      const cidade = params.cidade || '';
      const candidatas = rows.filter(r => eqCity(r.CIDADE, cidade) && String(r.STATUS||'').toLowerCase()==='aberto');
      const total = candidatas.length;

      if (!total) {
        session_params = { listado:true, vagas_lista:[], vagas_total:0, vagas_page:0, per_page:10 };
        messages = [ t('Não encontrei vagas abertas neste momento.') ];
      } else {
        const lista = serializeVagas(candidatas);
        const perPage = 10;
        const page = 0;
        const slice = lista.slice(page*perPage, page*perPage + perPage);
        const rowsList = slice.map(vagaRow);
        if (total > perPage) {
          rowsList.push({ id:'next', title:'Mais opções…', description:`Mostrando ${perPage}/${total}` });
        }

        session_params = { listado:true, vagas_lista:lista, vagas_total:total, vagas_page:page, per_page:perPage };

        const texto = [
          'Aí vão as vagas disponíveis 👇',
          ...slice.map(v => `• ${vagaToLine(v)}  (responda: quero ${v.VAGA_ID})`),
          total>perPage ? 'Para ver mais, responda: próxima' : ''
        ].filter(Boolean).join('\n');

        messages = [
          t(texto),
          payload({
            type: 'list',
            header: `Vagas em ${cidade}`,
            body: 'Toque para escolher uma vaga:',
            button: 'Selecionar',
            rows: rowsList
          })
        ];
      }

    } else if (tag === 'navegar_vagas') {
      const lista = params.vagas_lista || [];
      const total = Number(params.vagas_total || lista.length || 0);
      const perPage = Number(params.per_page || 10);
      let page = Number(params.vagas_page || 0);

      if (!total) {
        messages = [ t('Não há mais vagas para navegar.') ];
      } else {
        page = (page + 1) % Math.ceil(total / perPage);
        const start = page * perPage;
        const slice = lista.slice(start, start + perPage);
        const rowsList = slice.map(vagaRow);
        if (total > (start + perPage)) {
          rowsList.push({ id:'next', title:'Mais opções…', description:`Mostrando ${Math.min(start + perPage, total)}/${total}` });
        }
        session_params = { vagas_page: page };

        const texto = [
          'Mais opções 👇',
          ...slice.map(v => `• ${vagaToLine(v)}  (responda: quero ${v.VAGA_ID})`),
          (start + perPage) < total ? 'Para ver mais, responda: próxima' : ''
        ].filter(Boolean).join('\n');

        messages = [
          t(texto),
          payload({
            type: 'list',
            header: 'Outras vagas',
            body: 'Toque para escolher uma vaga:',
            button: 'Selecionar',
            rows: rowsList
          })
        ];
      }

    } else if (tag === 'selecionar_vaga') {
      const lista = params.vagas_lista || [];
      const vagaId = (params.vaga_id || params.VAGA_ID || '').toString().trim();
      const v = lista.find(x => String(x.VAGA_ID).trim() === vagaId);

      if (!v) {
        messages = [ t(`Não encontrei a vaga ID ${vagaId} nas opções.`) ];
      } else {
        session_params = {
          vaga_id: v.VAGA_ID,
          vaga_farmacia: v.FARMACIA,
          vaga_turno: v.TURNO,
          vaga_taxa: vagaPreco(v)
        };
        messages = [
          t(`Perfeito! Você escolheu: ${vagaToLine(v)}.`),
          t('Vou registrar seus dados e te enviar o link de inscrição.')
        ];
      }

    } else if (tag === 'salvar_lead') {
      const { nome, telefone, q1,q2,q3,q4,q5, perfil_aprovado, perfil_nota, perfil_resumo } = params;

      const protocolo = `LEAD-${Date.now().toString().slice(-6)}`;
      const dataISO1 = nowISO();
      const dataISO2 = dataISO1; // duas colunas DATA_ISO, mesmo timestamp

      // Planilha Leads (A→M):
      // DATA_ISO | NOME | TELEFONE | DATA_ISO | Q1 | Q2 | Q3 | Q4 | Q5 | PERFIL_APROVADO | PERFIL_NOTA | PERFIL_RESUMO | PROTOCOLO
      const linha = [
        dataISO1,
        nome || '',
        telefone || '',
        dataISO2,
        q1 || '', q2 || '', q3 || '', q4 || '', q5 || '',
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
    res.json({ fulfillment_response: { messages:[t('Erro interno no webhook.')] } });
  }
});

// ---------------- WhatsApp middleware (/wa/webhook) ----------------
const WA_BASE = 'https://graph.facebook.com/v20.0';

async function waSendText(to, text) {
  return axios.post(`${WA_BASE}/${WA_PHONE_ID}/messages`, {
    messaging_product:'whatsapp', to, type:'text', text:{ body:text }
  }, { headers:{ Authorization:`Bearer ${WA_TOKEN}` } });
}
async function waSendButtons(to, bodyText, buttons) {
  const actionButtons = buttons.slice(0,3).map(b => ({
    type:'reply', reply:{ id:b.id, title: (b.title||'Opção').slice(0,20) }
  }));
  return axios.post(`${WA_BASE}/${WA_PHONE_ID}/messages`, {
    messaging_product:'whatsapp', to, type:'interactive',
    interactive:{ type:'button', body:{ text: bodyText.slice(0,1024) }, action:{ buttons: actionButtons } }
  }, { headers:{ Authorization:`Bearer ${WA_TOKEN}` } });
}
async function waSendList(to, { header='Vagas', body='Escolha uma opção', button='Selecionar', rows=[] }) {
  const safeRows = rows.slice(0,10).map(r => ({
    id: String(r.id).slice(0,200),
    title: String(r.title).slice(0,24),
    description: r.description ? String(r.description).slice(0,72) : undefined
  }));
  return axios.post(`${WA_BASE}/${WA_PHONE_ID}/messages`, {
    messaging_product:'whatsapp',
    to,
    type:'interactive',
    interactive:{
      type:'list',
      header:{ type:'text', text: header.slice(0,60) },
      body:{ text: body.slice(0,1024) },
      footer:{ text:'Toque para escolher' },
      action:{ button: button.slice(0,20), sections:[{ title:'Vagas', rows: safeRows }] }
    }
  }, { headers:{ Authorization:`Bearer ${WA_TOKEN}` } });
}

// util: pacing entre mensagens
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function splitIntoSegments(text) {
  if (!text) return [];
  const rough = String(text).split(/\n{2,}/g).map(s => s.trim()).filter(Boolean);
  const maxLen = 900;
  const segs = [];
  for (const part of rough) {
    if (part.length <= maxLen) { segs.push(part); continue; }
    const lines = part.split('\n'); let acc='';
    for (const ln of lines) {
      if ((acc + (acc?'\n':'') + ln).length > maxLen) { if (acc) segs.push(acc); acc = ln; }
      else { acc = acc ? acc+'\n'+ln : ln; }
    }
    if (acc) segs.push(acc);
  }
  return segs;
}
async function waSendBurst(to, rawText, delayMs=450) {
  const segments = splitIntoSegments(rawText);
  for (const seg of segments) { await waSendText(to, seg); await sleep(delayMs); }
}

// ---- Dialogflow CX Sessions (endpoint regional) ----
const DFCX_ENDPOINT = `${CX_LOCATION}-dialogflow.googleapis.com`;
const cxClient = new SessionsClient({ apiEndpoint: DFCX_ENDPOINT });
function sessionPath(waId) {
  return cxClient.projectLocationAgentSessionPath(GCLOUD_PROJECT, CX_LOCATION, CX_AGENT_ID, waId);
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

// Payload helpers
function isListPayload(m) {
  return m && m.payload && (
    (m.payload.fields && m.payload.fields.type && m.payload.fields.type.stringValue === 'list') ||
    (m.payload.type === 'list')
  );
}
function isChoicesPayload(m) {
  return m && m.payload && (
    (m.payload.fields && m.payload.fields.type && m.payload.fields.type.stringValue === 'choices') ||
    (m.payload.type === 'choices')
  );
}
function decodePayload(m) {
  try { if (m.payload && m.payload.fields) return require('pb-util').struct.decode(m.payload); }
  catch {}
  return m.payload || {};
}
function buttonsFromChoices(choices=[]) {
  return choices.slice(0,3).map(ch => {
    const data = ch.data || {};
    let id = ch.id || '';
    if (!id && data.action) id = data.action === 'select' && data.vaga_id ? `select:${data.vaga_id}` : data.action;
    const title = ch.title || (data.action === 'next' ? 'Próxima' : `Quero ${data.vaga_id || ''}`);
    return { id, title };
  });
}
function parseButtonId(id) {
  if (!id) return { action:'unknown' };
  const [action, rest] = id.split(':');
  if (action === 'select') return { action, vaga_id:(rest||'').trim() };
  if (action === 'next') return { action };
  try { return JSON.parse(id); } catch {}
  return { action:id };
}

// Verify endpoint (WhatsApp)
app.get('/wa/webhook', (req,res) => {
  const { ['hub.mode']:mode, ['hub.verify_token']:token, ['hub.challenge']:challenge } = req.query;
  if (mode === 'subscribe' && token === WA_VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// Receive messages (WhatsApp → CX → WhatsApp)
app.post('/wa/webhook', async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const msgs = changes?.value?.messages;
    const contacts = changes?.value?.contacts;
    if (!msgs || !msgs.length) return res.sendStatus(200);

    for (const msg of msgs) {
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
          else if (parsed.action === 'select') { userText = `quero ${parsed.vaga_id}`; extraParams.vaga_id = parsed.vaga_id; }
          else userText = parsed.action;

        } else if (msg.interactive.type === 'list_reply') {
          const id = msg.interactive.list_reply?.id;
          const parsed = parseButtonId(id);
          if (parsed.action === 'select') { userText = `quero ${parsed.vaga_id}`; extraParams.vaga_id = parsed.vaga_id; }
          else userText = 'próxima';
        }

      } else {
        userText = '[anexo recebido]';
      }

      // Dialogflow CX
      const cxResp = await cxDetectText(from, userText, extraParams);
      const outputs = cxResp.queryResult?.responseMessages || [];

      for (const m of outputs) {
        if (isListPayload(m)) {
          const data = decodePayload(m);
          await waSendList(from, {
            header: data.header || 'Vagas disponíveis',
            body: data.body || 'Escolha a melhor opção para você:',
            button: data.button || 'Selecionar',
            rows: data.rows || []
          });
          continue;
        }
        if (isChoicesPayload(m)) {
          const decoded = decodePayload(m);
          await waSendButtons(from, 'Escolha uma opção:', buttonsFromChoices(decoded.choices || []));
          continue;
        }
        if (m.text && Array.isArray(m.text.text)) {
          for (const raw of m.text.text) {
            const line = (raw || '').trim();
            if (!line) continue;
            await waSendBurst(from, line, 450);
          }
          continue;
        }
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
  console.log(`Kelly combined on :${PORT} (/cx, /wa/webhook) — CX endpoint: ${CX_LOCATION}-dialogflow.googleapis.com`)
);
