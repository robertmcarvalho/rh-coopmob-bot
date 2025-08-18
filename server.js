// server.js — Kelly (CX + WhatsApp) — versão: menu de vagas (list) e anti-falhas

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
  // WhatsApp
  WA_TOKEN, WA_PHONE_ID, WA_VERIFY_TOKEN,
  // Dialogflow CX
  GCLOUD_PROJECT, CX_LOCATION, CX_AGENT_ID,
  // Google Sheets
  SHEETS_VAGAS_ID, SHEETS_LEADS_ID,
  SHEETS_VAGAS_TAB = 'Vagas',
  SHEETS_LEADS_TAB = 'Leads',
  // Link final
  PIPEFY_LINK = 'https://seu-link-do-pipefy-aqui'
} = process.env;

// ---- App ----
const app = express();
app.use(bodyParser.json());

// ---- Google Sheets (ADC no Cloud Run) ----
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
async function sheetsClient() {
  const auth = new google.auth.GoogleAuth({ scopes: SCOPES });
  const gauth = await auth.getClient();
  return google.sheets({ version: 'v4', auth: gauth });
}
async function getRows(spreadsheetId, rangeA1) {
  const sheets = await sheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: rangeA1 });
  const values = res.data.values || [];
  if (!values.length) return { header: [], rows: [] };
  const header = values[0];
  const rows = values.slice(1).map(r => {
    const o = {}; header.forEach((h,i)=>o[h]=r[i]);
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

// ---- Helpers ----
const t = (msg) => ({ text: { text: [msg] } });
const payload = (obj) => ({ payload: obj });
const nowISO = () => new Date().toISOString();
const unaccent = (s='') => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const eqCity = (a,b) => unaccent(String(a)).toUpperCase().trim() === unaccent(String(b)).toUpperCase().trim();

// normaliza respostas de sim/não para boolean
function boolish(v) {
  if (typeof v === 'boolean') return v;
  if (v === 1 || v === '1') return true;
  if (v === 0 || v === '0') return false;
  const s = String(v || '').trim().toLowerCase();
  if (['true','verdadeiro','sim','s','y','yes'].includes(s)) return true;
  if (['false','falso','não','nao','n','no'].includes(s)) return false;
  return false;
}

// Texto
const norm = (s='') => unaccent(String(s)).toLowerCase();
const hasAny = (s, terms=[]) => terms.some(t => norm(s).includes(norm(t)));
const within5min = (s) => {
  const txt = norm(s);
  if (/(imediat|na hora|instant)/.test(txt)) return true;
  const m = txt.match(/(\d+)\s*min/);
  return m ? Number(m[1]) <= 5 : false;
};

// Avaliação de perfil (regras)
function evalQ1(a) {
  const txt = norm(a);
  const alinh = hasAny(txt, ['confirmo','alinho','combino','valido','consulto','falo']) &&
                hasAny(txt, ['lider','supervisor','coordenador','central','cooperativa','dispatch','gestor']);
  const sozinho = hasAny(txt, ['sozinho','por conta','eu decido','eu escolho']);
  return alinh && !sozinho
    ? { ok:true, motivo:'Alinhou rota com liderança/central.' }
    : { ok:false, motivo:'Deveria alinhar a rota com liderança/central em urgências.' };
}
function evalQ2(a) {
  const txt = norm(a);
  const contata = hasAny(txt, ['ligo','whatsapp','chamo','entro em contato','tento contato','tento contactar','tento contatar']);
  const atualiza = hasAny(txt, ['atualizo','registro','marco no app','sistema','plataforma','app']);
  const rapido = within5min(txt);
  return (contata && atualiza && rapido)
    ? { ok:true, motivo:'Tenta contato e atualiza o sistema em até 5 min.' }
    : { ok:false, motivo:'Esperado: tentar contato e atualizar o sistema rapidamente (≤5 min).' };
}
function evalQ3(a) {
  const txt = norm(a);
  const aciona = hasAny(txt, ['aciono','consulto','informo','alinho','escalo']) &&
                 hasAny(txt, ['lider','coordenador','central','cooperativa','gestor']);
  return aciona
    ? { ok:true, motivo:'Escala/alinha com liderança/central no conflito.' }
    : { ok:false, motivo:'Deveria escalar para liderança/central quando há conflito.' };
}
function evalQ4(a) {
  const txt = norm(a);
  const registra = hasAny(txt, ['registro','foto','nota','app','sistema','comprovante']);
  const informa  = hasAny(txt, ['farmacia','expedicao','balcao','responsavel','lider','coordenador']);
  return (registra && informa)
    ? { ok:true, motivo:'Registra evidência e informa farmácia/liderança.' }
    : { ok:false, motivo:'Esperado: registrar (app/foto) e informar farmácia/liderança.' };
}
function evalQ5(a) {
  const txt = norm(a);
  const cCliente = hasAny(txt, ['cliente','clientes']);
  const cBase    = hasAny(txt, ['farmacia','lider','coordenador','central','cooperativa']);
  const anteced  = hasAny(txt, ['antecedencia','assim que','o quanto antes','imediat']) || within5min(txt);
  const prioriza = hasAny(txt, ['priorizo','prioridade','rota','urgente','urgencias']);
  const pontos = [cCliente, cBase, anteced, prioriza].filter(Boolean).length;
  return pontos >= 2
    ? { ok:true, motivo:'Comunica e ajusta priorização diante do atraso.' }
    : { ok:false, motivo:'Esperado: comunicar (cliente/base), avisar com antecedência e priorizar entregas.' };
}
function scorePerfil({ q1,q2,q3,q4,q5 }) {
  const avals = [evalQ1(q1), evalQ2(q2), evalQ3(q3), evalQ4(q4), evalQ5(q5)];
  const nota = avals.filter(a => a.ok).length;
  const aprovado = nota >= 3;  // corte mínimo = 3
  return { aprovado, nota };
}

// ---- Vagas helpers ----
function serializeVagas(list) {
  return list.map(v => ({
    VAGA_ID: v.VAGA_ID,
    CIDADE: v.CIDADE,
    FARMACIA: v.FARMACIA,
    TAXA_ENTREGA: v.TAXA_ENTREGA,
    TURNO: v.TURNO,
    STATUS: v.STATUS
  }));
}
function vagaTitle(v) {
  const taxa = Number(v.TAXA_ENTREGA || 0);
  const taxaFmt = isNaN(taxa) ? v.TAXA_ENTREGA : `R$ ${taxa.toFixed(2)}`;
  return `ID ${v.VAGA_ID} — ${v.FARMACIA} — ${v.TURNO} — ${taxaFmt}`;
}
function buildListPayload(cidade, lista) {
  // payload “list” (interpretado pelo middleware do WhatsApp)
  return payload({
    type: 'list',
    title: `Vagas em ${cidade}`,
    body: 'Toque para escolher uma vaga:',
    items: lista.map(v => ({
      id: `select:${v.VAGA_ID}`,
      title: vagaTitle(v)
    }))
  });
}

// ---------------- CX WEBHOOK (/cx) ----------------
const DFCX_ENDPOINT = `${CX_LOCATION}-dialogflow.googleapis.com`;
const cxClient = new SessionsClient({ apiEndpoint: DFCX_ENDPOINT });

app.post('/cx', async (req, res) => {
  try {
    const body   = req.body || {};
    const tag    = body.fulfillmentInfo?.tag;
    const params = body.sessionInfo?.parameters || {};

    let session_params = {};
    let messages = [];

    // Planilha de vagas quando necessário
    const needVagas = tag === 'verificar_cidade' || tag === 'listar_vagas';
    const { rows } = needVagas
      ? await getRows(SHEETS_VAGAS_ID, `${SHEETS_VAGAS_TAB}!A1:Z`)
      : { rows: [] };

    if (tag === 'verificar_cidade') {
      const raw = params.cidade || params['sys.geo-city'] || params['sys.location'] || params.location || '';
      const cidade = typeof raw === 'object'
        ? (raw.city || raw['admin-area'] || raw.original || '')
        : String(raw);

      const nome = (params.nome || '').toString().trim();
      const first = nome ? nome.split(' ')[0] : '';

      const bolhaBusca = t(`Obrigado${first ? `, ${first}` : ''}! Vou verificar vagas na sua cidade…`);

      if (!cidade || cidade.toLowerCase() === 'geo-city') {
        session_params = { vagas_abertas: false };
        messages = [ bolhaBusca, t(`${first ? first+', ' : ''}não entendi a cidade. Pode informar de novo?`) ];
      } else {
        const abertas = rows.filter(r => eqCity(r.CIDADE, cidade) && String(r.STATUS||'').toLowerCase()==='aberto');
        const vagas_abertas = abertas.length > 0;
        session_params = { vagas_abertas, cidade };
        messages = [
          bolhaBusca,
          vagas_abertas
            ? t(`Ótimo! ${first ? first+', ' : ''}temos vagas em ${cidade}.`)
            : t(`Poxa… ${first ? first+', ' : ''}no momento não há vagas em ${cidade}.`)
        ];
      }
    }

    else if (tag === 'gate_requisitos') {
      const nome = (params.nome || '').toString().trim();
      const first = nome ? nome.split(' ')[0] : '';
      const moto = boolish(params.moto_ok);
      const cnh  = boolish(params.cnh_ok);
      const andr = boolish(params.android_ok);

      if (moto && cnh && andr) {
        session_params = { requisitos_ok: true };
        messages = [
          t(`${first ? first+', ' : ''}perfeito! Você atende aos requisitos básicos.`),
          t('Vamos fazer uma avaliação rápida do seu perfil com 5 situações reais do dia a dia. Responda de forma objetiva, combinado?')
        ];
      } else {
        const faltas = [];
        if (!moto) faltas.push('moto com documentação em dia');
        if (!cnh)  faltas.push('CNH A válida');
        if (!andr) faltas.push('celular Android com internet');
        const lista = faltas.map(f => `• ${f}`).join('\n');
        session_params = { requisitos_ok: false };
        messages = [
          t(`Poxa${first ? ', ' + first : ''}… para atuar conosco é necessário atender a todos os requisitos:`),
          t(lista || 'Requisitos não atendidos.'),
          t('Se quiser, posso te avisar quando abrirmos oportunidades que não exijam todos esses itens. Tudo bem?')
        ];
      }
    }

    else if (tag === 'analisar_perfil') {
      const { q1,q2,q3,q4,q5, nome } = params;
      const r = scorePerfil({ q1,q2,q3,q4,q5 });
      session_params = { perfil_aprovado: r.aprovado, perfil_nota: r.nota };

      if (r.aprovado) {
        messages = [ t('✅ Perfil aprovado! Vamos seguir.') ];
      } else {
        messages = [
          t('Obrigado por se candidatar! Pelo perfil informado, neste momento não seguiremos com a vaga. Podemos te avisar quando houver oportunidades mais compatíveis?')
        ];
      }
    }

    else if (tag === 'listar_vagas') {
      const cidade = params.cidade || '';
      const candidatas = rows.filter(r => eqCity(r.CIDADE, cidade) && String(r.STATUS||'').toLowerCase()==='aberto');
      const total = candidatas.length;

      if (!total) {
        session_params = {
          listado: true, vagas_lista: [], vagas_idx: 0, vagas_total: 0,
          vaga_id: '', menu_action: ''
        };
        messages = [ t('Não encontrei vagas abertas neste momento.') ];
      } else {
        const lista = serializeVagas(candidatas);
        // ⚠️ Zeramos qualquer seleção antiga
        session_params = {
          listado: true, vagas_lista: lista, vagas_idx: 0, vagas_total: total,
          vaga_id: '', menu_action: ''
        };
        messages = [
          t('Aí vão as vagas disponíveis 👇'),
          buildListPayload(cidade, lista)  // <- menu interativo (no WA)
        ];
      }
    }

    else if (tag === 'navegar_vagas') {
      // (mantido apenas se você ainda tiver um botão "próxima" em algum canal)
      const lista = params.vagas_lista || [];
      const total = Number(params.vagas_total || lista.length || 0);
      if (!total) {
        messages = [ t('Não há mais vagas para navegar.') ];
      } else {
        const cidade = params.cidade || '';
        session_params = { menu_action: '' }; // limpa
        messages = [
          t('Aí vão as vagas disponíveis 👇'),
          buildListPayload(cidade, lista)
        ];
      }
    }

    else if (tag === 'selecionar_vaga') {
      const lista = params.vagas_lista || [];
      const vagaId = (params.vaga_id || params.VAGA_ID || '').toString().trim();
      const v = lista.find(x => String(x.VAGA_ID).trim() === vagaId);
      if (!v) {
        messages = [ t('Não encontrei a vaga selecionada. Use o menu para escolher 😉') ];
      } else {
        session_params = {
          vaga_id: v.VAGA_ID,
          vaga_farmacia: v.FARMACIA,
          vaga_turno: v.TURNO,
          vaga_taxa: Number(v.TAXA_ENTREGA || 0)
        };
        messages = [
          t(`Perfeito! Você escolheu: ${vagaTitle(v)}.`),
          t('Vou registrar seus dados e te enviar o link de inscrição.')
        ];
      }
    }

    else if (tag === 'salvar_lead') {
      const {
        nome, telefone,
        q1, q2, q3, q4, q5,
        perfil_aprovado, perfil_nota, perfil_resumo
      } = params;

      const protocolo = `LEAD-${Date.now().toString().slice(-6)}`;
      const dataISO1 = nowISO();
      const dataISO2 = dataISO1;

      // Planilha Leads: DATA_ISO | NOME | TELEFONE | DATA_ISO | Q1..Q5 | PERFIL_APROVADO | PERFIL_NOTA | PERFIL_RESUMO | PROTOCOLO
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

    // resposta
    res.json({
      fulfillment_response: { messages },
      session_info: { parameters: { ...params, ...session_params } }
    });

  } catch (e) {
    console.error('CX webhook error:', e?.response?.data || e);
    res.json({ fulfillment_response: { messages: [ t('Erro interno no webhook.') ] } });
  }
});

// ---------------- WhatsApp Middleware (/wa/webhook) ----------------
const WA_BASE = 'https://graph.facebook.com/v20.0';

async function waSendText(to, text) {
  return axios.post(`${WA_BASE}/${WA_PHONE_ID}/messages`, {
    messaging_product:'whatsapp', to, type:'text', text:{ body:text }
  }, { headers:{ Authorization:`Bearer ${WA_TOKEN}` } });
}
async function waSendList(to, title, body, items) {
  // WhatsApp interactive "list"
  return axios.post(`${WA_BASE}/${WA_PHONE_ID}/messages`, {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: title.slice(0,60) },
      body: { text: body.slice(0,1024) },
      action: {
        button: 'Selecionar',
        sections: [{
          title: 'Vagas',
          rows: items.map(it => ({
            id: it.id,
            title: it.title.slice(0,72)
          }))
        }]
      }
    }
  }, { headers:{ Authorization:`Bearer ${WA_TOKEN}` } });
}

// util
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function splitIntoSegments(text) {
  if (!text) return [];
  const rough = String(text).split(/\n{2,}/g).map(s=>s.trim()).filter(Boolean);
  const maxLen = 900;
  const out = [];
  for (const part of rough) {
    if (part.length <= maxLen) out.push(part);
    else {
      const lines = part.split('\n');
      let acc = '';
      for (const ln of lines) {
        const cand = acc ? acc + '\n' + ln : ln;
        if (cand.length > maxLen) { if (acc) out.push(acc); acc = ln; }
        else acc = cand;
      }
      if (acc) out.push(acc);
    }
  }
  return out;
}
async function waSendBurst(to, rawText, delayMs=450) {
  const parts = splitIntoSegments(rawText);
  for (const p of parts) { await waSendText(to, p); await sleep(delayMs); }
}

// CX Sessions
function sessionPath(waId) {
  return cxClient.projectLocationAgentSessionPath(GCLOUD_PROJECT, CX_LOCATION, CX_AGENT_ID, waId);
}
async function cxDetectText(waId, text, params={}) {
  const request = {
    session: sessionPath(waId),
    queryInput: { text: { text }, languageCode: 'pt-BR' },
    queryParams: { parameters: struct.encode(params) }
  };
  const [resp] = await cxClient.detectIntent(request);
  return resp;
}

// Payload helpers
function decodePayload(m) {
  try { if (m.payload && m.payload.fields) return require('pb-util').struct.decode(m.payload); }
  catch(_) {}
  return m.payload || {};
}
function isListPayload(m) {
  // payload.type === 'list'
  if (!m || !m.payload) return false;
  if (m.payload.type === 'list') return true;
  if (m.payload.fields && m.payload.fields.type && m.payload.fields.type.stringValue === 'list') return true;
  return false;
}

// Verificação (WhatsApp)
app.get('/wa/webhook', (req, res) => {
  const { ['hub.mode']:mode, ['hub.verify_token']:token, ['hub.challenge']:challenge } = req.query;
  if (mode === 'subscribe' && token === WA_VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// Recebimento (WhatsApp → CX → WhatsApp)
app.post('/wa/webhook', async (req, res) => {
  try {
    const entry   = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const msgs    = changes?.value?.messages;
    const contacts= changes?.value?.contacts;
    if (!msgs || !msgs.length) return res.sendStatus(200);

    for (const msg of msgs) {
      const from = msg.from;
      const profileName = contacts?.[0]?.profile?.name;
      let userText = null;
      const extraParams = { nome: profileName, telefone: from };

      if (msg.type === 'text') {
        userText = msg.text?.body?.trim() || '.';
      } else if (msg.type === 'interactive') {
        if (msg.interactive.type === 'list_reply') {
          const id = msg.interactive.list_reply?.id || '';
          // id esperado: select:VAGA_ID
          const [action, rest] = String(id).split(':');
          if (action === 'select' && rest) {
            extraParams.vaga_id = String(rest).trim();
            userText = '[menu]'; // qualquer texto serve; rota dispara por condição
          } else {
            userText = '[menu]';
          }
        } else {
          userText = '[interativo]';
        }
      } else {
        userText = '[anexo]';
      }

      const cxResp  = await cxDetectText(from, userText || '.', extraParams);
      const outputs = cxResp.queryResult?.responseMessages || [];

      for (const m of outputs) {
        if (isListPayload(m)) {
          const p = decodePayload(m);
          await waSendList(from, p.title || 'Vagas', p.body || 'Escolha uma opção:', p.items || []);
          continue;
        }
        if (m.text && Array.isArray(m.text.text)) {
          for (const raw of m.text.text) {
            const line = (raw || '').trim();
            if (!line) continue;
            await waSendBurst(from, line, 420);
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

app.listen(PORT, () => {
  console.log(`Kelly combined on :${PORT} (/cx, /wa/webhook) — CX endpoint: ${CX_LOCATION}-dialogflow.googleapis.com`);
});
