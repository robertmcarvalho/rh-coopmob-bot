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
const unaccent = (s='') => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const eqCity = (a,b) => unaccent(String(a)).toUpperCase().trim() === unaccent(String(b)).toUpperCase().trim();
const norm = (s='') => unaccent(String(s)).toLowerCase();
const hasAny = (s, terms=[]) => terms.some(x => norm(s).includes(norm(x)));
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

// currency
function parseTaxa(v) {
  if (v === null || v === undefined) return NaN;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isNaN(n) ? NaN : n;
}
function fmtBRL(n) {
  if (Number.isNaN(n)) return '';
  return `R$ ${n.toFixed(2).replace('.', ',')}`;
}

// Avaliação perfil
function evalQ1(a) {
  const txt = norm(a);
  const alinhamento = hasAny(txt, ['confirmo','alinho','combino','valido','consulto','falo'])
                    && hasAny(txt, ['lider','supervisor','coordenador','central','cooperativa','dispatch','gestor']);
  const sozinho = hasAny(txt, ['sozinho','por conta','eu decido','eu escolho']);
  return alinhamento && !sozinho
    ? { ok:true, motivo:'Alinhou rota com liderança/central.' }
    : { ok:false, motivo:'Deveria alinhar rota com liderança/central em urgências.' };
}
function evalQ2(a) {
  const txt = norm(a);
  const contata = hasAny(txt, ['ligo','ligar','whatsapp','chamo','entro em contato','tento contato','tento contatar','tento contactar']);
  const atualiza = hasAny(txt, ['atualizo','registro','marco no app','sistema','plataforma','app']);
  const rapido = within5min(txt);
  return (contata && atualiza && rapido)
    ? { ok:true, motivo:'Tenta contato e atualiza o sistema em até 5 min.' }
    : { ok:false, motivo:'Esperado: tentar contato e atualizar o sistema rapidamente (≤5 min).' };
}
function evalQ3(a) {
  const txt = norm(a);
  const aciona = hasAny(txt, ['aciono','consulto','informo','alinho','escalo'])
              && hasAny(txt, ['lider','coordenador','central','cooperativa','gestor']);
  return aciona
    ? { ok:true, motivo:'Escala/alinha com liderança/central no conflito.' }
    : { ok:false, motivo:'Deveria escalar para liderança/central quando há conflito.' };
}
function evalQ4(a) {
  const txt = norm(a);
  const registra = hasAny(txt, ['registro','foto','nota','app','sistema','comprovante']);
  const informa = hasAny(txt, ['farmacia','expedicao','balcao','responsavel','lider','coordenador']);
  return (registra && informa)
    ? { ok:true, motivo:'Registra evidência e informa farmácia/liderança.' }
    : { ok:false, motivo:'Esperado: registrar (app/foto) e informar farmácia/liderança.' };
}
function evalQ5(a) {
  const txt = norm(a);
  const comunicaCliente = hasAny(txt, ['cliente','clientes']);
  const comunicaBase = hasAny(txt, ['farmacia','lider','coordenador','central','cooperativa']);
  const antecedencia = hasAny(txt, ['antecedencia','assim que','o quanto antes','imediat']) || within5min(txt);
  const prioriza = hasAny(txt, ['priorizo','prioridade','rota','urgente','urgencias']);
  const pontos = [comunicaCliente, comunicaBase, antecedencia, prioriza].filter(Boolean).length;
  return pontos >= 2
    ? { ok:true, motivo:'Comunica e ajusta priorização diante do atraso.' }
    : { ok:false, motivo:'Esperado: comunicar (cliente/base), avisar com antecedência e priorizar entregas.' };
}
function scorePerfil({ q1,q2,q3,q4,q5 }) {
  const avals = [evalQ1(q1), evalQ2(q2), evalQ3(q3), evalQ4(q4), evalQ5(q5)];
  const nota = avals.filter(a => a.ok).length;
  const aprovado = nota >= 3; // corte = 3
  const feedback = avals.map((a,i)=>`Q${i+1}: ${a.ok ? 'OK' : 'Ajustar'} — ${a.motivo}`);
  return { aprovado, nota, feedback };
}

// Sheets helpers
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
    spreadsheetId, range: rangeA1,
    valueInputOption:'USER_ENTERED', insertDataOption:'INSERT_ROWS',
    requestBody:{ values:[rowArray] }
  });
}

// ---- Vacancy helpers ----
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
function vagaTitleShort(v) {
  // título curtinho (limite do WhatsApp list title)
  return `ID ${v.VAGA_ID} — ${v.FARMACIA} — ${v.TURNO}`;
}
function vagaDesc(v) {
  const n = parseTaxa(v.TAXA_ENTREGA);
  const taxa = Number.isNaN(n) ? String(v.TAXA_ENTREGA || '') : fmtBRL(n);
  return `${v.TURNO} — ${taxa}`;
}

// ---------------- CX WEBHOOK (/cx) ----------------
app.post('/cx', async (req, res) => {
  try {
    const body = req.body || {};
    const tag = body.fulfillmentInfo?.tag;
    const params = body.sessionInfo?.parameters || {};
    let session_params = {};
    let messages = [];

    // *** LOG PARA DEBUG ***
    console.log('=== CX WEBHOOK ===');
    console.log('Tag:', tag);
    console.log('Params:', JSON.stringify(params, null, 2));

    const needVagas = (tag === 'verificar_cidade' || tag === 'listar_vagas');
    const { rows } = await (needVagas ? getRows(SHEETS_VAGAS_ID, `${SHEETS_VAGAS_TAB}!A1:Z`) : { rows:[] });

    if (tag === 'verificar_cidade') {
      const raw = params.cidade || params['sys.geo-city'] || params['sys.location'] || params.location || '';
      const cidade = typeof raw === 'object' ? (raw.city || raw['admin-area'] || raw.original || '') : String(raw);
      const nome = (params.nome || '').toString().trim();
      const first = nome ? nome.split(' ')[0] : '';

      const bolhaBusca = t(`Obrigado${first ? `, ${first}` : ''}! Vou verificar vagas na sua cidade…`);

      if (!cidade || cidade.toLowerCase() === 'geo-city') {
        session_params = { vagas_abertas:false };
        messages = [bolhaBusca, t(`${first ? first+', ' : ''}não entendi a cidade. Pode informar de novo?`)];
      } else {
        const abertas = rows.filter(r => eqCity(r.CIDADE, cidade) && String(r.STATUS||'').toLowerCase()==='aberto');
        const vagas_abertas = abertas.length>0;
        session_params = { vagas_abertas, cidade };
        messages = [
          bolhaBusca,
          vagas_abertas ? t(`Ótimo! ${first ? first+', ' : ''}temos vagas em ${cidade}.`)
                        : t(`Poxa… ${first ? first+', ' : ''}no momento não há vagas em ${cidade}.`)
        ];
      }
    }

    else if (tag === 'gate_requisitos') {
      const nome = (params.nome || '').toString().trim();
      const first = nome ? nome.split(' ')[0] : '';
      const moto = boolish(params.moto_ok);
      const cnh = boolish(params.cnh_ok);
      const android = boolish(params.android_ok);

      if (moto && cnh && android) {
        session_params = { requisitos_ok:true };
        messages = [
          t(`${first ? first+', ' : ''}perfeito! Você atende aos requisitos básicos.`),
          t('Vamos fazer uma avaliação rápida do seu perfil com 5 situações reais do dia a dia. Responda de forma objetiva, combinado?')
        ];
      } else {
        const faltas = [];
        if (!moto) faltas.push('moto com documentação em dia');
        if (!cnh) faltas.push('CNH A válida');
        if (!android) faltas.push('celular Android com internet');
        session_params = { requisitos_ok:false };
        messages = [
          t(`Poxa${first ? ', '+first : ''}… para atuar conosco é necessário atender a todos os requisitos:`),
          t(faltas.map(f=>`• ${f}`).join('\n')),
          t('Se quiser, posso te avisar quando abrirmos oportunidades que não exijam todos esses itens. Tudo bem?')
        ];
      }
    }

    else if (tag === 'analisar_perfil') {
      const { q1,q2,q3,q4,q5, nome } = params;
      const r = scorePerfil({ q1,q2,q3,q4,q5 });
      session_params = { perfil_aprovado:r.aprovado, perfil_nota:r.nota, perfil_resumo:r.feedback.join(' | ') };
      if (r.aprovado) {
        messages = [ t('✅ Perfil aprovado! Vamos seguir.') ];
      } else {
        messages = [ t('Obrigado por se candidatar! Pelo perfil informado, neste momento não seguiremos com a vaga. Podemos te avisar quando houver oportunidades mais compatíveis?') ];
      }
    }

    else if (tag === 'listar_vagas') {
      const cidade = params.cidade || '';
      const candidatas = rows.filter(r => eqCity(r.CIDADE, cidade) && String(r.STATUS||'').toLowerCase()==='aberto');
      const total = candidatas.length;

      if (!total) {
        session_params = { listado:true, vagas_lista:[], vagas_total:0 };
        messages = [ t('Não encontrei vagas abertas neste momento.') ];
      } else {
        const lista = serializeVagas(candidatas);
        session_params = { listado:true, vagas_lista:lista, vagas_total:lista.length };
        // payload especial para o middleware do WhatsApp enviar LISTA nativa
        const rowsList = lista.map(v => ({
          id: `select:${v.VAGA_ID}`,
          title: vagaTitleShort(v).slice(0, 24),       // limite seguro no título
          description: `${v.TURNO} — ${fmtBRL(parseTaxa(v.TAXA_ENTREGA))}`.slice(0, 72)
        }));
        messages = [
          t('Aí vão as vagas disponíveis 👇'),
          payload({
            type: 'wa_list',
            header: `Vagas em ${cidade}`,
            body: 'Toque para escolher uma vaga:',
            button: 'Selecionar',
            rows: rowsList
          })
        ];
      }
    }

    else if (tag === 'selecionar_vaga') {
      // Seleção chega via EVENTO 'menu_select' (middleware converte)
      const lista = params.vagas_lista || [];
      const vagaId = (params.vaga_id || '').toString().trim();
      const v = lista.find(x => String(x.VAGA_ID).trim() === vagaId);
      
      console.log('=== SELECIONAR VAGA ===');
      console.log('Lista de vagas:', JSON.stringify(lista, null, 2));
      console.log('Vaga ID procurado:', vagaId);
      console.log('Vaga encontrada:', v);
      
      if (!v) {
        messages = [ t('Não encontrei a vaga selecionada.') ];
      } else {
        const n = parseTaxa(v.TAXA_ENTREGA);
        session_params = {
          vaga_id: v.VAGA_ID,
          vaga_farmacia: v.FARMACIA,
          vaga_turno: v.TURNO,
          vaga_taxa: Number.isNaN(n) ? '' : Number(n)
        };
        messages = [ t(`Perfeito! Você escolheu: ID ${v.VAGA_ID} — ${v.FARMACIA} — ${v.TURNO} — ${fmtBRL(Number(n))}`) ];
      }
    }

    else if (tag === 'salvar_lead') {
      const {
        nome, telefone, q1,q2,q3,q4,q5,
        perfil_aprovado, perfil_nota, perfil_resumo
      } = params;

      const protocolo = `LEAD-${Date.now().toString().slice(-6)}`;
      const dataISO1 = nowISO();
      const dataISO2 = dataISO1;

      const linha = [
        dataISO1, (nome||''), (telefone||''), dataISO2,
        q1||'', q2||'', q3||'', q4||'', q5||'',
        (perfil_aprovado ? 'Aprovado' : 'Reprovado'),
        (perfil_nota ?? ''), (perfil_resumo ?? ''), protocolo
      ];
      await appendRow(SHEETS_LEADS_ID, `${SHEETS_LEADS_TAB}!A1:Z1`, linha);

      session_params = { protocolo };
      messages = [ t(`Cadastro concluído! Protocolo: ${protocolo}`), t(`Finalize sua inscrição: ${PIPEFY_LINK}`) ];
    }

    res.json({
      fulfillment_response: { messages },
      session_info: { parameters: { ...params, ...session_params } }
    });
  } catch (e) {
    console.error('CX webhook error:', e?.response?.data || e);
    res.json({ fulfillment_response:{ messages:[t('Erro interno no webhook.')] } });
  }
});

// ---------------- WA MIDDLEWARE (/wa/webhook) ----------------
const WA_BASE = 'https://graph.facebook.com/v20.0';

// send list
async function waSendList(to, { header, body, button, rows }) {
  const sections = [{
    title: header?.slice(0,24) || 'Vagas',
    rows: rows.map(r => ({
      id: r.id,
      title: (r.title || '').slice(1, 25).trim() ? r.title.slice(0,24) : 'Opção',
      description: (r.description || '').slice(0,72)
    }))
  }];

  return axios.post(`${WA_BASE}/${WA_PHONE_ID}/messages`, {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: header?.slice(0,60) || 'Vagas' },
      body: { text: body?.slice(0,1024) || 'Escolha uma vaga:' },
      action: { button: (button || 'Selecionar').slice(0,20), sections }
    }
  }, { headers:{ Authorization:`Bearer ${WA_TOKEN}` }});
}

async function waSendText(to, text) {
  return axios.post(`${WA_BASE}/${WA_PHONE_ID}/messages`, {
    messaging_product:'whatsapp', to, type:'text', text:{ body:text }
  }, { headers:{ Authorization:`Bearer ${WA_TOKEN}` } });
}

// small delay between messages
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- CX Sessions (endpoint regional) ----
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
async function cxDetectEvent(waId, event, params = {}) {
  const request = {
    session: sessionPath(waId),
    queryInput: { event: { event }, languageCode: 'pt-BR' },
    queryParams: { parameters: struct.encode(params) }
  };
  const [resp] = await cxClient.detectIntent(request);
  return resp;
}

// Helper para payloads
function isWaListPayload(m) {
  const p = m?.payload;
  if (!p) return false;
  if (p.type === 'wa_list') return true;
  if (p.fields && p.fields.type && p.fields.type.stringValue === 'wa_list') return true;
  return false;
}
function decodePayload(m) {
  try {
    if (m.payload && m.payload.fields) return require('pb-util').struct.decode(m.payload);
  } catch {}
  return m.payload || {};
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
    const messages = changes?.value?.messages;
    const contacts = changes?.value?.contacts;
    if (!messages || !messages.length) return res.sendStatus(200);

    for (const msg of messages) {
      const from = msg.from;
      const profileName = contacts?.[0]?.profile?.name || '';
      let extraParams = { nome: profileName, telefone: from };

      // *** CORREÇÃO DEFINITIVA: Simular a condição que o CX está esperando ***
      if (msg.type === 'interactive' && msg.interactive?.type === 'list_reply') {
        const id = msg.interactive.list_reply?.id || '';
        let vagaId = '';
        if (id.startsWith('select:')) vagaId = id.split(':')[1]?.trim() || '';

        console.log('=== LISTA SELECIONADA ===');
        console.log('ID selecionado:', id);
        console.log('Vaga ID extraído:', vagaId);
        console.log('From:', from);

        // *** SOLUÇÃO: Fazer 2 chamadas sequenciais ***
        // 1. Definir os parâmetros na sessão
        await cxDetectText(from, 'definir_parametros_selecao', { 
          ...extraParams,
          menu_action: 'select', 
          vaga_id: vagaId
        });

        // 2. Simular uma entrada qualquer para triggerar a condição
        const resp = await cxDetectText(from, 'continuar', extraParams);
        
        const outputs = resp.queryResult?.responseMessages || [];

        for (const m of outputs) {
          if (isWaListPayload(m)) {
            const decoded = decodePayload(m);
            await waSendList(from, decoded);
            await sleep(200);
            continue;
          }
          if (m.text && Array.isArray(m.text.text)) {
            for (const line of m.text.text) if (line && line.trim()) { 
              await waSendText(from, line); 
              await sleep(200); 
            }
            continue;
          }
        }
        continue;
      }

      // 2) Botões (se existirem): mapear para eventos também
      if (msg.type === 'interactive' && msg.interactive?.type === 'button_reply') {
        const id = msg.interactive.button_reply?.id || '';
        if (id === 'next') {
          const resp = await cxDetectEvent(from, 'menu_next', { ...extraParams, menu_action:'next' });
          const outputs = resp.queryResult?.responseMessages || [];
          for (const m of outputs) {
            if (isWaListPayload(m)) { await waSendList(from, decodePayload(m)); await sleep(200); continue; }
            if (m.text?.text) { for (const line of m.text.text) if (line?.trim()) { await waSendText(from, line); await sleep(200); } }
          }
          continue;
        }
      }

      // 3) Texto comum → Dialogflow (saudação, respostas etc.)
      let userText = (msg.type === 'text') ? (msg.text?.body?.trim() || '') : '[anexo]';
      const cxResp = await cxDetectText(from, userText, extraParams);
      const outputs = cxResp.queryResult?.responseMessages || [];

      for (const m of outputs) {
        if (isWaListPayload(m)) {
          const decoded = decodePayload(m);
          await waSendList(from, decoded);
          await sleep(200);
          continue;
        }
        if (m.text && Array.isArray(m.text.text)) {
          for (const line of m.text.text) if (line && line.trim()) { await waSendText(from, line); await sleep(200); }
          continue;
        }
        // fallback silencioso
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
