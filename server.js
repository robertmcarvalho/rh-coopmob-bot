// Combined server: Dialogflow CX Webhook (/cx) + WhatsApp middleware (/wa/webhook)
// Extras: Memória (Upstash Redis), Áudio→Texto (Google Speech), Avaliação HÍBRIDA (OpenAI + regras)
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { google } = require('googleapis');
const { SessionsClient } = require('@google-cloud/dialogflow-cx');
const { struct } = require('pb-util');
const { Redis } = require('@upstash/redis');
const speech = require('@google-cloud/speech');

// ---- ENV ----
const {
  PORT = 8080,
  // WhatsApp Business (Graph API)
  WA_TOKEN, WA_PHONE_ID, WA_VERIFY_TOKEN,

  // Dialogflow CX
  GCLOUD_PROJECT, CX_LOCATION, CX_AGENT_ID,

  // Google Sheets + Pipefy
  SHEETS_VAGAS_ID, SHEETS_LEADS_ID,
  SHEETS_VAGAS_TAB = 'Vagas',
  SHEETS_LEADS_TAB = 'Leads',
  PIPEFY_LINK = 'https://seu-link-do-pipefy-aqui',

  // Memória (Upstash Redis)
  UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN,
  MEM_TTL_SECONDS = 60 * 60 * 24 * 30, // 30 dias

  // IA (OpenAI) para avaliação
  OPENAI_API_KEY,
  AI_MODEL = 'gpt-4o-mini',
  AI_TIMEOUT_MS = 8000
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
// normaliza respostas tipo sim/não/true/false para boolean
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

// ---- Regras de avaliação (determinísticas) ----
function evalQ1(a) { // rota urgente
  const txt = norm(a);
  const alinhamento = hasAny(txt, ['confirmo','alinho','combino','valido','consulto','falo'])
                   && hasAny(txt, ['lider','lideranca','supervisor','coordenador','central','cooperativa','dispatch','gestor']);
  const sozinho = hasAny(txt, ['sozinho','por conta','eu decido','eu escolho']);
  return alinhamento && !sozinho
    ? { ok:true, motivo:'Alinhou rota com liderança/central.' }
    : { ok:false, motivo:'Deveria alinhar a rota com liderança/central em urgências.' };
}
function evalQ2(a) { // cliente ausente
  const txt = norm(a);
  const contata = hasAny(txt, ['ligo','ligar','whatsapp','chamo','entro em contato','tento contato','tento contactar','tento contatar','contato']);
  const atualiza = hasAny(txt, ['atualizo','registro','marco no app','sistema','plataforma','app']);
  const rapido = within5min(txt) || hasAny(txt, ['agora','na hora','imediat']);
  return (contata && atualiza && rapido)
    ? { ok:true, motivo:'Tenta contato e atualiza o sistema em até 5 min.' }
    : { ok:false, motivo:'Esperado: tentar contato e atualizar o sistema rapidamente (≤5 min).' };
}
function evalQ3(a) { // conflito
  const txt = norm(a);
  const aciona = hasAny(txt, ['aciono','consulto','informo','alinho','escalo','falo'])
              && hasAny(txt, ['lider','lideranca','coordenador','central','cooperativa','gestor','supervisor']);
  return aciona
    ? { ok:true, motivo:'Escala/alinha com liderança/central no conflito.' }
    : { ok:false, motivo:'Deveria escalar para liderança/central quando há conflito.' };
}
function evalQ4(a) { // item faltando
  const txt = norm(a);
  const registra = hasAny(txt, ['registro','foto','nota','app','sistema','comprovante']);
  const informa = hasAny(txt, ['farmacia','expedicao','balcao','responsavel','lider','coordenador','lideranca']);
  return (registra && informa)
    ? { ok:true, motivo:'Registra evidência e informa farmácia/liderança.' }
    : { ok:false, motivo:'Esperado: registrar (app/foto) e informar farmácia/liderança.' };
}
function evalQ5(a) { // atraso
  const txt = norm(a);
  const comunicaCliente = hasAny(txt, ['cliente','clientes']);
  const comunicaBase = hasAny(txt, ['farmacia','lider','coordenador','central','cooperativa','base']);
  const antecedencia = hasAny(txt, ['antecedencia','assim que','o quanto antes','imediat']) || within5min(txt);
  const prioriza = hasAny(txt, ['priorizo','prioridade','rota','urgente','urgencias','otimizo']);
  const pontos = [comunicaCliente, comunicaBase, antecedencia, prioriza].filter(Boolean).length;
  return pontos >= 2
    ? { ok:true, motivo:'Comunica e ajusta priorização diante do atraso.' }
    : { ok:false, motivo:'Esperado: comunicar (cliente/base), avisar com antecedência e priorizar entregas.' };
}
function scorePerfil({ q1, q2, q3, q4, q5 }) {
  const avals = [evalQ1(q1), evalQ2(q2), evalQ3(q3), evalQ4(q4), evalQ5(q5)];
  const nota = avals.filter(a => a.ok).length;
  const aprovado = nota >= 3; // nota mínima = 3
  const feedback = avals.map((a, i) => `Q${i+1}: ${a.ok ? 'OK' : 'Ajustar'} — ${a.motivo}`);
  return { aprovado, nota, feedback };
}

// ---- IA: avaliação com rubric (híbrido) ----
async function aiScorePerfil({ q1, q2, q3, q4, q5 }) {
  if (!OPENAI_API_KEY) return null; // sem chave, use fallback
  const rubric = `
Você é um avaliador de perfil operacional. Avalie 5 respostas (Q1..Q5) de um candidato a entregas de farmácia.
Regras do rubric (cada item vale 1 ponto):
- Q1 (rota urgente/múltiplas coletas): positivo se APONTA alinhar/confirmar rota com liderança/central (não decide sozinho).
- Q2 (cliente ausente): positivo se TENTA CONTATO e ATUALIZA SISTEMA em até ~5 min (aceite “na hora”, “imediato”).
- Q3 (conflito farmácia x líder): positivo se ESCALA/ALINHA com liderança/central para decidir.
- Q4 (item faltando): positivo se REGISTRA evidência (app/foto/nota) e INFORMA farmácia/liderança.
- Q5 (atraso trânsito/chuva): positivo se COMUNICA cliente e base (farmácia/central), com antecedência/rapidez, e INDICA priorização adequada.
Aprovação: score_total >= 3.
Responda EXCLUSIVAMENTE em JSON com o esquema:
{
  "score_total": 0-5,
  "aprovado": true|false,
  "q": {
    "q1": {"ok": true|false, "motivo": "..." },
    "q2": {"ok": true|false, "motivo": "..." },
    "q3": {"ok": true|false, "motivo": "..." },
    "q4": {"ok": true|false, "motivo": "..." },
    "q5": {"ok": true|false, "motivo": "..." }
  }
}
`;
  const user = { q1, q2, q3, q4, q5 };
  try {
    const resp = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: AI_MODEL,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: rubric },
          { role: 'user', content: JSON.stringify(user) }
        ]
      },
      {
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
        timeout: Number(AI_TIMEOUT_MS) || 8000
      }
    );
    const txt = resp.data?.choices?.[0]?.message?.content || '';
    const parsed = JSON.parse(txt);
    if (
      typeof parsed.score_total === 'number' &&
      typeof parsed.aprovado === 'boolean' &&
      parsed.q && parsed.q.q1 && parsed.q.q2 && parsed.q.q3 && parsed.q.q4 && parsed.q.q5
    ) {
      return parsed;
    }
    return null;
  } catch (err) {
    console.error('AI evaluation error:', err?.response?.data || err?.message || err);
    return null;
  }
}

// ---- Google Sheets helpers ----
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

// ---- Vagas helpers ----
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

// ---- Memória (Upstash Redis) ----
const redis = (UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN)
  ? new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN })
  : null;

const MEM_TTL = Number(MEM_TTL_SECONDS) || (60*60*24*30);
async function memGet(key) {
  if (!redis) return null;
  try { return await redis.get(key); } catch { return null; }
}
async function memSet(key, value) {
  if (!redis) return;
  try { await redis.set(key, value, { ex: MEM_TTL }); } catch {}
}
async function memMerge(key, patch) {
  const cur = (await memGet(key)) || {};
  const next = { ...cur, ...patch };
  await memSet(key, next);
  return next;
}

// ---------------- CX WEBHOOK (/cx) ----------------
app.post('/cx', async (req, res) => {
  try {
    const body = req.body || {};
    const tag = body.fulfillmentInfo?.tag;
    const params = body.sessionInfo?.parameters || {};
    let session_params = {};
    let messages = [];

    const needVagas = (tag === 'verificar_cidade' || tag === 'listar_vagas');
    const { rows } = needVagas
      ? await getRows(SHEETS_VAGAS_ID, `${SHEETS_VAGAS_TAB}!A1:Z`)
      : { rows: [] };

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

      const nome = (params.nome || '').toString().trim();
      const firstName = nome ? nome.split(' ')[0] : '';
      const prefixo = firstName ? `${firstName}, ` : '';

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

    } else if (tag === 'gate_requisitos') {
      // Valida requisitos coletados no formulário do CX
      const nome = (params.nome || '').toString().trim();
      const firstName = nome ? nome.split(' ')[0] : '';
      const moto = boolish(params.moto_ok);
      const cnh = boolish(params.cnh_ok);
      const android = boolish(params.android_ok);

      if (moto && cnh && android) {
        session_params = { requisitos_ok: true };
        messages = [
          t(`${firstName ? firstName + ',' : ''} perfeito! Você atende aos requisitos básicos.`),
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
      const { q1, q2, q3, q4, q5 } = params;

      // HÍBRIDO: tenta IA, se falhar usa regras
      let aprovado = false, nota = 0, resumo = '';
      const ai = await aiScorePerfil({ q1, q2, q3, q4, q5 });
      if (ai) {
        aprovado = !!ai.aprovado;
        nota = Number(ai.score_total) || 0;
        resumo = `AI: ${JSON.stringify(ai.q)}`; // guardado para auditoria, não exibido ao candidato
      } else {
        const r = scorePerfil({ q1, q2, q3, q4, q5 });
        aprovado = r.aprovado;
        nota = r.nota;
        resumo = `Rules: ${r.feedback.join(' | ')}`;
      }

      session_params = {
        perfil_aprovado: aprovado,
        perfil_nota: nota,
        perfil_resumo: resumo
      };

      // Mensagens ao candidato: SOMENTE resultado (sem bullets)
      if (aprovado) {
        messages = [ t('✅ Perfil aprovado! Vamos seguir.') ];
      } else {
        messages = [
          t('Obrigado por se candidatar! Neste momento não seguiremos com a vaga. Podemos te avisar quando houver oportunidades mais compatíveis?')
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

    } else if (tag === 'salvar_lead') {
      const {
        nome, telefone,
        q1, q2, q3, q4, q5,
        perfil_aprovado, perfil_nota, perfil_resumo
      } = params;

      const protocolo = `LEAD-${Date.now().toString().slice(-6)}`;
      const dataISO1 = nowISO();
      const dataISO2 = dataISO1; // segundo timestamp igual, conforme solicitado

      // Colunas: DATA_ISO | NOME | TELEFONE | DATA_ISO | Q1 | Q2 | Q3 | Q4 | Q5 | PERFIL_APROVADO | PERFIL_NOTA | PERFIL_RESUMO | PROTOCOLO
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

      session_params = { protocolo, pipefy_link: PIPEFY_LINK };
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

// ---------------- WhatsApp MIDDLEWARE (/wa/webhook) ----------------
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

// pacing de envio (bolhas separadas)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

// Helpers payload → WhatsApp
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
  try { return JSON.parse(id); } catch {}
  return { action: id };
}

// ---- Áudio: WhatsApp media download + Google Speech ----
const speechClient = new speech.SpeechClient();

async function waGetMediaInfo(mediaId) {
  const url = `${WA_BASE}/${mediaId}`;
  const { data } = await axios.get(url, { headers: { Authorization: `Bearer ${WA_TOKEN}` } });
  // data: { id, mime_type, sha256, file_size, url }
  return data;
}
async function waDownloadMedia(mediaUrl) {
  // Alguns ambientes exigem sem Authorization no 2º GET; tentamos sem e com como fallback
  try {
    const resp = await axios.get(mediaUrl, { responseType: 'arraybuffer' });
    return { buffer: Buffer.from(resp.data), mime: resp.headers['content-type'] || 'application/octet-stream' };
  } catch {
    const resp2 = await axios.get(mediaUrl, {
      responseType: 'arraybuffer',
      headers: { Authorization: `Bearer ${WA_TOKEN}` }
    });
    return { buffer: Buffer.from(resp2.data), mime: resp2.headers['content-type'] || 'application/octet-stream' };
  }
}
function guessEncoding(mime) {
  const m = (mime || '').toLowerCase();
  if (m.includes('ogg')) return 'OGG_OPUS';
  if (m.includes('mpeg') || m.includes('mp3')) return 'MP3';
  if (m.includes('wav')) return 'LINEAR16';
  if (m.includes('amr')) return 'AMR';
  if (m.includes('3gpp')) return 'AMR_WB';
  return 'OGG_OPUS';
}
async function transcribeBuffer(buf, mime) {
  const encoding = guessEncoding(mime);
  const audio = { content: buf.toString('base64') };
  const config = {
    languageCode: 'pt-BR',
    encoding,
    enableAutomaticPunctuation: true,
    model: 'default'
  };
  const request = { audio, config };
  const [response] = await speechClient.recognize(request);
  const transcription = response.results?.map(r => r.alternatives?.[0]?.transcript).filter(Boolean).join(' ') || '';
  return transcription.trim();
}

// ---- Verificação do webhook do WhatsApp (GET) ----
app.get('/wa/webhook', (req, res) => {
  const { ['hub.mode']: mode, ['hub.verify_token']: token, ['hub.challenge']: challenge } = req.query;
  if (mode === 'subscribe' && token === WA_VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// ---- Recebe mensagens do WhatsApp → CX → WhatsApp ----
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
      const memoryKey = `lead:${from}`;

      // Carrega memória
      const mem = (await memGet(memoryKey)) || {};
      const extraParams = { ...mem, nome: profileName || mem.nome, telefone: from };

      // Tipo de mensagem
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
      } else if (msg.type === 'audio' && msg.audio?.id) {
        try {
          const info = await waGetMediaInfo(msg.audio.id);
          const { buffer, mime } = await waDownloadMedia(info.url);
          const transcript = await transcribeBuffer(buffer, info.mime_type || mime);
          if (transcript) {
            userText = transcript;
            extraParams.audio_transcript = transcript;
          } else {
            await waSendText(from, 'Não consegui entender seu áudio. Pode digitar em texto, por favor?');
            continue;
          }
        } catch (err) {
          console.error('STT error:', err?.response?.data || err);
          await waSendText(from, 'Tive um problema para ouvir seu áudio. Pode enviar em texto?');
          continue;
        }
      } else {
        userText = '[anexo recebido]';
      }

      // Dialogflow CX
      const cxResp = await cxDetectText(from, userText, extraParams);
      const outputs = cxResp.queryResult?.responseMessages || [];

      // Atualiza memória com parâmetros retornados
      try {
        const returnedParams = cxResp.queryResult?.parameters
          ? require('pb-util').struct.decode(cxResp.queryResult.parameters)
          : {};
        const mergeFields = [
          'nome','telefone','cidade','vagas_abertas',
          'moto_ok','cnh_ok','android_ok','requisitos_ok',
          'q1','q2','q3','q4','q5',
          'perfil_aprovado','perfil_nota','perfil_resumo',
          'vaga_id','vaga_farmacia','vaga_turno','vaga_taxa','protocolo'
        ];
        const patch = {};
        for (const k of mergeFields) if (returnedParams[k] !== undefined) patch[k] = returnedParams[k];
        if (Object.keys(patch).length) await memMerge(memoryKey, patch);
      } catch (e) {
        console.error('Memory merge error:', e?.response?.data || e);
      }

      // Entrega das mensagens
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
            await waSendBurst(from, line, 450);
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
