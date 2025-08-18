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

// ---- Helpers ----
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

// ---- Avaliação de perfil (nota mínima = 3) ----
function evalQ1(a) {
  const txt = norm(a);
  const alinhamento = hasAny(txt, ['confirmo','alinho','combino','valido','consulto','falo'])
                    && hasAny(txt, ['lider','supervisor','coordenador','central','cooperativa','dispatch','gestor']);
  const sozinho = hasAny(txt, ['sozinho','por conta','eu decido','eu escolho']);
  return alinhamento && !sozinho;
}
function evalQ2(a) {
  const txt = norm(a);
  const contata  = hasAny(txt, ['ligo','whatsapp','chamo','entro em contato','tento contato','contatar']);
  const atualiza = hasAny(txt, ['atualizo','registro','marco no app','sistema','plataforma','app']);
  const rapido   = within5min(txt);
  return contata && atualiza && rapido;
}
function evalQ3(a) {
  const txt = norm(a);
  return hasAny(txt, ['aciono','consulto','informo','alinho','escalo'])
      && hasAny(txt, ['lider','coordenador','central','cooperativa','gestor']);
}
function evalQ4(a) {
  const txt = norm(a);
  const registra = hasAny(txt, ['registro','foto','nota','app','sistema','comprovante']);
  const informa  = hasAny(txt, ['farmacia','expedicao','balcao','responsavel','lider','coordenador']);
  return registra && informa;
}
function evalQ5(a) {
  const txt = norm(a);
  const comunicaCliente = hasAny(txt, ['cliente','clientes']);
  const comunicaBase    = hasAny(txt, ['farmacia','lider','coordenador','central','cooperativa']);
  const antecedencia    = hasAny(txt, ['antecedencia','assim que','o quanto antes','imediat']) || within5min(txt);
  const prioriza        = hasAny(txt, ['priorizo','prioridade','rota','urgente','urgencias']);
  const pontos = [comunicaCliente, comunicaBase, antecedencia, prioriza].filter(Boolean).length;
  return pontos >= 2;
}
function scorePerfil({ q1,q2,q3,q4,q5 }) {
  const oks = [evalQ1(q1), evalQ2(q2), evalQ3(q3), evalQ4(q4), evalQ5(q5)];
  const nota = oks.filter(Boolean).length;
  const aprovado = nota >= 3;
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

// ---- Vagas helpers ----
function serializeVagas(list) {
  return list.map(v => ({
    VAGA_ID: v.VAGA_ID, CIDADE: v.CIDADE, FARMACIA: v.FARMACIA,
    TAXA_ENTREGA: v.TAXA_ENTREGA, TURNO: v.TURNO, STATUS: v.STATUS
  }));
}
function formatPreco(raw) {
  const num = Number(String(raw || '').replace(/[^\d.,-]/g, '').replace(',', '.'));
  if (!Number.isNaN(num)) return `R$ ${num.toFixed(2)}`;
  return String(raw || '').replace(/^\s*R\$\s*R\$\s*/i, 'R$ ').trim();
}
function vagaToLine(v) {
  return `ID ${v.VAGA_ID} — ${v.FARMACIA} — ${v.TURNO} — ${formatPreco(v.TAXA_ENTREGA)}`;
}
function vagaRow(v) {
  return {
    id: `select:${v.VAGA_ID}`,
    title: `${v.FARMACIA}`.slice(0, 24),
    description: `${v.TURNO} — ${formatPreco(v.TAXA_ENTREGA)}`
  };
}

// ---------------- CX WEBHOOK (/cx) ----------------
app.post('/cx', async (req, res) => {
  const body = req.body || {};
  const tag = body.fulfillmentInfo?.tag;
  const params = body.sessionInfo?.parameters || {};

  let session_params = {};
  let messages = [];

  try {
    const needSheet = ['verificar_cidade', 'listar_vagas'].includes(tag);
    const { rows } = needSheet
      ? await getRows(SHEETS_VAGAS_ID, `${SHEETS_VAGAS_TAB}!A1:Z`)
      : { rows: [] };

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
        if (!moto)   faltas.push('moto com documentação em dia');
        if (!cnh)    faltas.push('CNH A válida');
        if (!android)faltas.push('celular Android com internet');
        session_params = { requisitos_ok: false };
        messages = [
          t(`Poxa${firstName ? ', ' + firstName : ''}… para atuar conosco é necessário atender a todos os requisitos:`),
          t(faltas.map(f=>`• ${f}`).join('\n') || 'Requisitos não atendidos.'),
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
        ? [ t('✅ Perfil aprovado! Vamos seguir.') ]
        : [ t(cabecalho), t('Obrigado por se candidatar! Pelo perfil informado, neste momento não seguiremos com a vaga. Podemos te avisar quando houver oportunidades mais compatíveis?') ];

    } else if (tag === 'listar_vagas') {
      // Só menu interativo (sem aceitar digitação)
      const cidade = params.cidade || '';
      const candidatas = rows.filter(r => eqCity(r.CIDADE, cidade) && String(r.STATUS||'').toLowerCase()==='aberto');
      const total = candidatas.length;

      if (!total) {
        session_params = { listado:true, vagas_lista:[], vagas_total:0, vagas_page:0, per_page:10 };
        messages = [ t('No momento não há vagas abertas nesta cidade.') ];
      } else {
        const lista = serializeVagas(candidatas);
        const perPage = 10;
        const page = 0;
        const slice = lista.slice(0, perPage);
        const rowsList = slice.map(vagaRow);
        if (total > perPage) rowsList.push({ id:'next', title:'Mais opções…', description:`Mostrando ${perPage}/${total}` });

        session_params = { listado:true, vagas_lista:lista, vagas_total:total, vagas_page:page, per_page:perPage };

        messages = [
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
        if (total > (start + perPage)) rowsList.push({ id:'next', title:'Mais opções…', description:`Mostrando ${Math.min(start + perPage, total)}/${total}` });
        session_params = { vagas_page: page };

        messages = [
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
        messages = [ t(`Não encontrei a vaga selecionada.`) ];
      } else {
        session_params = {
          vaga_id: v.VAGA_ID,
          vaga_farmacia: v.FARMACIA,
          vaga_turno: v.TURNO,
          vaga_taxa: formatPreco(v.TAXA_ENTREGA)
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
      const dataISO2 = dataISO1;

      const linha = [
        dataISO1, nome || '', telefone || '', dataISO2,
        q1 || '', q2 || '', q3 || '', q4 || '', q5 || '',
        (perfil_aprovado ? 'Aprovado' : 'Reprovado'),
        (perfil_nota ?? ''), (perfil_resumo ?? ''), protocolo
      ];
      await appendRow(SHEETS_LEADS_ID, `${SHEETS_LEADS_TAB}!A1:Z1`, linha);

      session_params = { protocolo };
      messages = [ t(`Cadastro concluído! Protocolo: ${protocolo}`), t(`Finalize sua inscrição: ${PIPEFY_LINK}`) ];
    }

  } catch (err) {
    console.error('Webhook error (tag=' + tag + '):', err?.response?.data || err);
    messages = [ t('Erro interno no webhook.') ];
  }

  res.json({ fulfillment_response:{ messages }, session_info:{ parameters:{ ...params, ...session_params } } });
});

// ---------------- WhatsApp middleware (/wa/webhook) ----------------
const WA_BASE = 'https://graph.facebook.com/v20.0';

async function waSendText(to, text) {
  return axios.post(`${WA_BASE}/${WA_PHONE_ID}/messages`, {
    messaging_product:'whatsapp', to, type:'text', text:{ body:text }
  }, { headers:{ Authorization:`Bearer ${WA_TOKEN}` } });
}
async function waSendList(to, { header='Vagas', body='Escolha uma opção', button='Selecionar', rows=[] }) {
  const safeRows = rows.slice(0,10).map(r => ({
    id: String(r.id).slice(0,200),
    title: String(r.title).slice(0,24),
    description: r.description ? String(r.description).slice(0,72) : undefined
  }));
  return axios.post(`${WA_BASE}/${WA_PHONE_ID}/messages`, {
    messaging_product:'whatsapp', to, type:'interactive',
    interactive:{
      type:'list',
      header:{ type:'text', text: header.slice(0,60) },
      body:{ text: body.slice(0,1024) },
      footer:{ text:'Toque para escolher' },
      action:{ button: button.slice(0,20), sections:[{ title:'Vagas', rows: safeRows }] }
    }
  }, { headers:{ Authorization:`Bearer ${WA_TOKEN}` } });
}

// pacing + de-dup simples
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function splitIntoSegments(text) {
  if (!text) return [];
  const rough = String(text).split(/\n{2,}/g).map(s => s.trim()).filter(Boolean);
  const maxLen = 900;
  const segs = [];
  for (const part of rough) {
    if (part.length <= maxLen) { segs.push(part); continue; }
    const lines = part.split('\n'); let acc = '';
    for (const ln of lines) {
      if ((acc + (acc?'\n':'') + ln).length > maxLen) { if (acc) segs.push(acc); acc = ln; }
      else { acc = acc ? acc + '\n' + ln : ln; }
    }
    if (acc) segs.push(acc);
  }
  return segs;
}
async function waSendBurst(to, rawText, delayMs=450, lastCache) {
  const segments = splitIntoSegments(rawText);
  for (const seg of segments) {
    if (!seg) continue;
    if (!lastCache || seg !== lastCache.last) {
      await waSendText(to, seg);
      if (lastCache) lastCache.last = seg;
      await sleep(delayMs);
    }
  }
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

// Recognize DF payloads
function isListPayload(m) {
  const p = m && m.payload;
  if (!p) return false;
  if (p.fields && p.fields.type && p.fields.type.stringValue === 'list') return true;
  if (p.type === 'list') return true;
  return false;
}
function decodePayload(m) {
  try {
    if (m.payload && m.payload.fields) return require('pb-util').struct.decode(m.payload);
  } catch {}
  return m.payload || {};
}

// Verify endpoint (WhatsApp)
app.get('/wa/webhook', (req, res) => {
  const { ['hub.mode']: mode, ['hub.verify_token']: token, ['hub.challenge']: challenge } = req.query;
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

      if (msg.type === 'interactive') {
        if (msg.interactive.type === 'list_reply') {
          const id = msg.interactive.list_reply?.id || '';
          if (id === 'next') {
            // somente menu "próxima página"
            extraParams.menu_action = 'next';
            userText = 'MENU'; // texto neutro (será roteado por condição no CX)
          } else {
            // id esperado: select:<VAGA_ID>
            const m = id.match(/^select:(.+)$/);
            if (m) {
              extraParams.vaga_id = String(m[1]).trim();
              userText = 'MENU';
            } else {
              userText = 'MENU';
            }
          }
        } else {
          // ignoramos outros tipos de interactive (não usados)
          userText = 'MENU';
        }
      } else if (msg.type === 'text') {
        // Não aceitamos digitação para escolher vaga; apenas repassamos texto ao CX
        userText = msg.text?.body?.trim() || '';
      } else {
        userText = '[anexo]';
      }

      // Dialogflow CX
      const cxResp = await cxDetectText(from, userText || 'MENU', extraParams);
      const outputs = cxResp.queryResult?.responseMessages || [];

      const lastCache = { last: '' };
      for (const m of outputs) {
        if (isListPayload(m)) {
          const decoded = decodePayload(m);
          await waSendList(from, {
            header: decoded.header || 'Vagas',
            body: decoded.body || 'Toque para escolher uma vaga:',
            button: decoded.button || 'Selecionar',
            rows: decoded.rows || []
          });
          continue;
        }
        if (m.text && Array.isArray(m.text.text)) {
          for (const raw of m.text.text) {
            const line = (raw || '').trim();
            if (!line) continue;
            await waSendBurst(from, line, 420, lastCache);
          }
        }
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
