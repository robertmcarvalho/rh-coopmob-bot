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
  // CX
  GCLOUD_PROJECT, CX_LOCATION, CX_AGENT_ID,
  // Sheets / Pipefy
  SHEETS_VAGAS_ID, SHEETS_LEADS_ID,
  SHEETS_VAGAS_TAB = 'Vagas',
  SHEETS_LEADS_TAB = 'Leads',
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

// ---- Helpers ----
const t = (msg) => ({ text: { text: [String(msg)] } });
const payload = (obj) => ({ payload: obj });
const nowISO = () => new Date().toISOString();
const unaccent = (s='') => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const eqCity = (a,b) => unaccent(a).toUpperCase().trim() === unaccent(b).toUpperCase().trim();

// Texto / boolean
const norm = (s='') => unaccent(String(s)).toLowerCase();
const hasAny = (s, terms=[]) => terms.some(t => norm(s).includes(norm(t)));
function boolish(v) {
  if (typeof v === 'boolean') return v;
  const s = String(v ?? '').trim().toLowerCase();
  if (['true','verdadeiro','sim','s','y','yes','1'].includes(s)) return true;
  if (['false','falso','nao','não','n','no','0'].includes(s)) return false;
  return false;
}
const within5min = (s) => {
  const txt = norm(s);
  if (/(imediat|na hora|instant)/.test(txt)) return true;
  const m = txt.match(/(\d+)\s*min/);
  return m ? Number(m[1]) <= 5 : false;
};

// Avaliação comportamental (regra)
function evalQ1(a){ const txt=norm(a);
  const alinhamento = hasAny(txt,['confirmo','alinho','combino','valido','consulto','falo']) &&
                      hasAny(txt,['lider','supervisor','coordenador','central','cooperativa','dispatch','gestor']);
  const sozinho = hasAny(txt,['sozinho','por conta','eu decido','eu escolho']);
  return alinhamento && !sozinho ? {ok:true,motivo:'Alinhou rota com liderança/central.'}
                                 : {ok:false,motivo:'Deveria alinhar a rota com liderança/central.'};
}
function evalQ2(a){ const txt=norm(a);
  const contata = hasAny(txt,['ligo','whatsapp','chamo','entro em contato','tento contato','contactar','contatar']);
  const atualiza = hasAny(txt,['atualizo','registro','marco no app','sistema','plataforma','app']);
  const rapido = within5min(txt);
  return contata && atualiza && rapido ? {ok:true,motivo:'Contato + atualização ≤5 min.'}
                                       : {ok:false,motivo:'Esperado contato e atualização rápida (≤5 min).'};
}
function evalQ3(a){ const txt=norm(a);
  const aciona = hasAny(txt,['aciono','consulto','informo','alinho','escalo']) &&
                 hasAny(txt,['lider','coordenador','central','cooperativa','gestor']);
  return aciona ? {ok:true,motivo:'Escala/alinha com liderança/central.'}
                : {ok:false,motivo:'Deveria escalar para liderança/central.'};
}
function evalQ4(a){ const txt=norm(a);
  const registra = hasAny(txt,['registro','foto','nota','app','sistema','comprovante']);
  const informa  = hasAny(txt,['farmacia','expedicao','balcao','responsavel','lider','coordenador']);
  return (registra && informa) ? {ok:true,motivo:'Registra evidência e informa farmácia/liderança.'}
                               : {ok:false,motivo:'Registrar (app/foto) e informar farmácia/liderança.'};
}
function evalQ5(a){ const txt=norm(a);
  const cliente = hasAny(txt,['cliente','clientes']);
  const base    = hasAny(txt,['farmacia','lider','coordenador','central','cooperativa']);
  const ant     = hasAny(txt,['antecedencia','o quanto antes','imediat']) || within5min(txt);
  const prior   = hasAny(txt,['priorizo','prioridade','rota','urgente','urgencias']);
  const pontos  = [cliente, base, ant, prior].filter(Boolean).length;
  return pontos >= 2 ? {ok:true,motivo:'Comunica e ajusta priorização.'}
                     : {ok:false,motivo:'Comunicar (cliente/base), avisar cedo e priorizar.'};
}
function scorePerfil({q1,q2,q3,q4,q5}){
  const avals=[evalQ1(q1),evalQ2(q2),evalQ3(q3),evalQ4(q4),evalQ5(q5)];
  const nota=avals.filter(a=>a.ok).length;
  const aprovado = nota >= 3; // corte = 3
  const feedback = avals.map((a,i)=>`Q${i+1}: ${a.ok?'OK':'Ajustar'} — ${a.motivo}`);
  return { aprovado, nota, feedback };
}

// ---- Vagas helpers ----
function serializeVagas(list){
  return list.map(v => ({
    VAGA_ID: v.VAGA_ID,
    CIDADE: v.CIDADE,
    FARMACIA: v.FARMACIA,
    TAXA_ENTREGA: v.TAXA_ENTREGA,
    TURNO: v.TURNO,
    STATUS: v.STATUS
  }));
}
function taxaStr(v){ const n=Number(v); return Number.isFinite(n) ? n.toFixed(2) : String(v||''); }
function vagaLine(v){ return `ID ${v.VAGA_ID} — ${v.FARMACIA} — ${v.TURNO} — R$ ${taxaStr(v.TAXA_ENTREGA)}`; }

// Cria payload de LISTA (WhatsApp interactive list)
function makeWaListPayload(cidade, lista){
  const rows = lista.slice(0,10).map(v => ({
    id: `vaga:${String(v.VAGA_ID)}`,
    title: String(v.FARMACIA || '').slice(0,24) || `Vaga ${v.VAGA_ID}`,
    description: `${String(v.TURNO||'').slice(0,48)} — R$ ${taxaStr(v.TAXA_ENTREGA)}`
  }));
  return {
    type: 'wa_list',
    header: `Vagas em ${cidade}`,
    body: 'Toque para escolher uma vaga:',
    button: 'Selecionar',
    rows
  };
}

// ---------------- CX WEBHOOK (/cx) ----------------
app.post('/cx', async (req,res)=>{
  try{
    const body = req.body || {};
    const tag = body.fulfillmentInfo?.tag;
    const params = body.sessionInfo?.parameters || {};
    let session_params = {};
    let messages = [];

    // Sheets apenas quando necessário
    const { rows } = await (
      tag==='verificar_cidade' || tag==='listar_vagas'
        ? getRows(SHEETS_VAGAS_ID, `${SHEETS_VAGAS_TAB}!A1:Z`)
        : { rows: [] }
    );

    if (tag === 'verificar_cidade'){
      const raw = params.cidade || params['sys.geo-city'] || params['sys.location'] || params.location || '';
      const cidade = typeof raw==='object' ? (raw.city || raw['admin-area'] || raw.original || '') : String(raw);
      const nome = (params.nome || '').toString().trim();
      const first = nome ? nome.split(' ')[0] : '';
      const bolha = t(`Obrigado${first?`, ${first}`:''}! Vou verificar vagas na sua cidade…`);

      if (!cidade || cidade.toLowerCase()==='geo-city'){
        session_params = { vagas_abertas:false };
        messages = [bolha, t(`${first?first+', ':''}não entendi a cidade. Pode informar de novo?`)];
      } else {
        const abertas = rows.filter(r => eqCity(r.CIDADE,cidade) && String(r.STATUS||'').toLowerCase()==='aberto');
        const vagas_abertas = abertas.length>0;
        session_params = { vagas_abertas, cidade };
        messages = [ bolha, vagas_abertas ? t(`Ótimo! ${first?first+', ':''}temos vagas em ${cidade}.`)
                                          : t(`Poxa… ${first?first+', ':''}no momento não há vagas em ${cidade}.`) ];
      }
    }

    else if (tag === 'gate_requisitos'){
      const nome=(params.nome||'').toString().trim(); const first=nome?nome.split(' ')[0]:'';
      const moto=boolish(params.moto_ok), cnh=boolish(params.cnh_ok), android=boolish(params.android_ok);
      if (moto && cnh && android){
        session_params = { requisitos_ok:true };
        messages = [ t(`${first?first+', ':''}perfeito! Você atende aos requisitos básicos.`),
                     t('Vamos fazer uma avaliação rápida do seu perfil com 5 situações reais do dia a dia. Responda de forma objetiva, combinado?') ];
      } else {
        const faltas=[]; if(!moto) faltas.push('moto com documentação em dia'); if(!cnh) faltas.push('CNH A válida'); if(!android) faltas.push('celular Android com internet');
        session_params = { requisitos_ok:false };
        messages = [ t(`Poxa${first?`, ${first}`:''}… para atuar conosco é necessário atender a todos os requisitos:`),
                     t(faltas.map(f=>'• '+f).join('\n') || 'Requisitos não atendidos.'),
                     t('Se quiser, posso te avisar quando abrirmos oportunidades que não exijam todos esses itens. Tudo bem?') ];
      }
    }

    else if (tag === 'analisar_perfil'){
      const { q1,q2,q3,q4,q5, nome } = params;
      const r = scorePerfil({ q1,q2,q3,q4,q5 });
      const first=(nome||'').toString().trim().split(' ')[0]||'';
      session_params = { perfil_aprovado:r.aprovado, perfil_nota:r.nota, perfil_resumo:r.feedback.join(' | ') };
      if (r.aprovado){
        messages = [ t('✅ Perfil aprovado! Vamos seguir.') ];
      } else {
        messages = [ t('Obrigado por se candidatar! Pelo perfil informado, neste momento não seguiremos com a vaga. Podemos te avisar quando houver oportunidades mais compatíveis?') ];
      }
    }

else if (tag === 'listar_vagas') {
  const cidade = params.cidade || '';
  const candidatas = rows.filter(
    r => eqCity(r.CIDADE, cidade) && String(r.STATUS||'').toLowerCase()==='aberto'
  );
  const total = candidatas.length;

  if (!total) {
    session_params = { listado: true, vagas_lista: [], vagas_idx: 0, vagas_total: 0, vaga_id: '', menu_action: '' };
    messages = [ t('Não encontrei vagas abertas neste momento.') ];
  } else {
    const lista = serializeVagas(candidatas);
    const idx = 0;
    // ⚠️ LIMPE a seleção anterior e o menu_action aqui:
    session_params = {
      listado: true,
      vagas_lista: lista,
      vagas_idx: idx,
      vagas_total: total,
      vaga_id: '',          // <— limpa qualquer escolha antiga
      menu_action: ''       // <— limpa qualquer comando "next" deixado na sessão
    };
    messages = browseMessage(lista[idx], idx, total);
  }
}

    else if (tag === 'navegar_vagas'){
      const lista = params.vagas_lista || [];
      const total = Number(params.vagas_total || lista.length || 0);
      if (!total){
        messages = [ t('Não há mais vagas para navegar.') ];
      } else {
        let idx = Number(params.vagas_idx || 0);
        idx = (idx + 1) % total;
        session_params = { vagas_idx: idx, menu_action: '' }; // limpa a action depois de usar
        const v = lista[idx];
        messages = [ t(`Opção ${idx+1}/${total}: ${vagaLine(v)}`) ];
      }
    }

    else if (tag === 'selecionar_vaga'){
      const lista = params.vagas_lista || [];
      if (!lista.length){
        // Seleção não deve ocorrer sem lista pronta
        messages = [ t('Use o menu acima para escolher a vaga 😉') ];
      } else {
        let raw = (params.vaga_id || params.VAGA_ID || '').toString().trim();
        // aceita formatos: "vaga:12", "select:12", "12"
        const m = raw.match(/(?:vaga|select):(\d+)/i);
        const vagaId = m ? m[1] : raw.replace(/\D+/g,'');
        const v = lista.find(x => String(x.VAGA_ID).trim() === vagaId);
        if (!vagaId || !v){
          messages = [ t('Não encontrei a vaga selecionada. Por favor, escolha uma opção no menu.') ];
        } else {
          session_params = {
            vaga_id: v.VAGA_ID,
            vaga_farmacia: v.FARMACIA,
            vaga_turno: v.TURNO,
            vaga_taxa: Number(v.TAXA_ENTREGA || 0)
          };
          messages = [ t(`Perfeito! Você escolheu: ${vagaLine(v)}.`) ];
        }
      }
    }

    else if (tag === 'salvar_lead'){
      const { nome, telefone, q1,q2,q3,q4,q5, perfil_aprovado, perfil_nota, perfil_resumo } = params;
      const protocolo = `LEAD-${Date.now().toString().slice(-6)}`;
      const dataISO1 = nowISO();
      const dataISO2 = dataISO1;
      const linha = [
        dataISO1, (nome||''), (telefone||''), dataISO2,
        (q1||''),(q2||''),(q3||''),(q4||''),(q5||''),
        (perfil_aprovado ? 'Aprovado':'Reprovado'),
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
  }catch(e){
    console.error('CX webhook error:', e?.response?.data || e);
    res.json({ fulfillment_response: { messages: [t('Erro interno no webhook.')] } });
  }
});

// ---------------- WhatsApp middleware (/wa/webhook) ----------------
const WA_BASE = 'https://graph.facebook.com/v20.0';

async function waSendText(to, text){
  return axios.post(`${WA_BASE}/${WA_PHONE_ID}/messages`, {
    messaging_product:'whatsapp', to, type:'text', text:{ body:String(text).slice(0,4096) }
  }, { headers:{ Authorization:`Bearer ${WA_TOKEN}` }});
}
async function waSendButtons(to, bodyText, buttons){
  const actionButtons = buttons.slice(0,3).map(b=>({
    type:'reply', reply:{ id:b.id, title:(b.title||'Opção').slice(0,20) }
  }));
  return axios.post(`${WA_BASE}/${WA_PHONE_ID}/messages`, {
    messaging_product:'whatsapp', to, type:'interactive',
    interactive:{ type:'button', body:{ text: String(bodyText).slice(0,1024) }, action:{ buttons: actionButtons } }
  }, { headers:{ Authorization:`Bearer ${WA_TOKEN}` }});
}
// Envia LIST (menu)
async function waSendList(to, payload){
  const header = (payload.header || 'Vagas').slice(0,60);
  const body   = (payload.body || 'Escolha uma opção:').slice(0,1024);
  const button = (payload.button || 'Selecionar').slice(0,20);
  const rows = (payload.rows || []).slice(0,10).map(r => ({
    id: r.id,
    title: String(r.title || 'Opção').slice(0,24),
    description: String(r.description || '').slice(0,72)
  }));
  if (!rows.length) return waSendText(to, 'Sem opções no momento.');
  return axios.post(`${WA_BASE}/${WA_PHONE_ID}/messages`, {
    messaging_product:'whatsapp', to, type:'interactive',
    interactive:{
      type:'list',
      header:{ type:'text', text: header },
      body:{ text: body },
      action:{ button, sections:[{ title: header, rows }] }
    }
  }, { headers:{ Authorization:`Bearer ${WA_TOKEN}` }});
}

// Pequena pausa entre envios
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
function splitIntoSegments(text){
  if(!text) return [];
  const blocks = String(text).split(/\n{2,}/g).map(s=>s.trim()).filter(Boolean);
  const out=[]; const max=900;
  for(const b of blocks){
    if(b.length<=max){ out.push(b); continue; }
    const lines=b.split('\n'); let acc='';
    for(const ln of lines){
      const next = acc ? acc+'\n'+ln : ln;
      if(next.length>max){ if(acc) out.push(acc); acc=ln; } else acc=next;
    }
    if(acc) out.push(acc);
  }
  return out;
}
async function waSendBurst(to, raw, delay=450){
  for(const seg of splitIntoSegments(raw)){ await waSendText(to, seg); await sleep(delay); }
}

// CX regional client
const DFCX_ENDPOINT = `${CX_LOCATION}-dialogflow.googleapis.com`;
const cxClient = new SessionsClient({ apiEndpoint: DFCX_ENDPOINT });
function sessionPath(waId){
  return cxClient.projectLocationAgentSessionPath(GCLOUD_PROJECT, CX_LOCATION, CX_AGENT_ID, waId);
}
async function cxDetectText(waId, text, params={}){
  const request = {
    session: sessionPath(waId),
    queryInput: { text: { text }, languageCode: 'pt-BR' },
    queryParams: { parameters: struct.encode(params) }
  };
  const [resp] = await cxClient.detectIntent(request);
  return resp;
}

// Payload helpers
function decodePayload(m){
  try{ if(m.payload && m.payload.fields) return require('pb-util').struct.decode(m.payload); }
  catch(_e){}
  return m.payload || {};
}
function isChoicesPayload(m){ // legado
  const p = m && m.payload;
  return !!(p && ((p.fields && p.fields.type && p.fields.type.stringValue==='choices') || p.type==='choices'));
}
function isWaListPayload(m){
  const p = m && m.payload;
  if(!p) return false;
  if(p.type==='wa_list') return true;
  if(p.fields && p.fields.type && p.fields.type.stringValue==='wa_list') return true;
  return false;
}

// Verify endpoint (WA)
app.get('/wa/webhook', (req,res)=>{
  const { ['hub.mode']:mode, ['hub.verify_token']:token, ['hub.challenge']:challenge } = req.query;
  if(mode==='subscribe' && token===WA_VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// Receive messages (WA → CX → WA)
app.post('/wa/webhook', async (req,res)=>{
  try{
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const messages = changes?.value?.messages;
    const contacts = changes?.value?.contacts;
    if(!messages || !messages.length) return res.sendStatus(200);

    for(const msg of messages){
      const from = msg.from;
      const profileName = contacts?.[0]?.profile?.name;
      let userText = null;
      const extraParams = { nome: profileName, telefone: from };

      if (msg.type === 'interactive' && msg.interactive?.type === 'list_reply'){
        const id = msg.interactive.list_reply?.id || '';
        // id esperado: "vaga:123"
        extraParams.vaga_id = id;
        userText = 'selecionar'; // texto irrelevante; a rota em CX usa a sessão
      } else if (msg.type === 'interactive' && msg.interactive?.type === 'button_reply'){
        const id = msg.interactive.button_reply?.id || '';
        if (id === 'next'){ extraParams.menu_action = 'next'; userText = 'próxima'; }
        else { extraParams.menu_action = ''; userText = id || 'ok'; }
      } else if (msg.type === 'text'){
        userText = msg.text?.body?.trim();
      } else {
        userText = '[anexo]';
      }

      // Dialogflow CX
      const cxResp = await cxDetectText(from, userText || 'oi', extraParams);
      const outputs = cxResp.queryResult?.responseMessages || [];

      for(const m of outputs){
        if (isWaListPayload(m)){
          const pl = decodePayload(m);
          await waSendList(from, pl);
          continue;
        }
        if (isChoicesPayload(m)){
          const pl = decodePayload(m);
          await waSendButtons(from, 'Toque para escolher:', (pl.choices||[]).map(c=>({id:c.id,title:c.title})));
          continue;
        }
        if (m.text && Array.isArray(m.text.text)){
          for(const raw of m.text.text){
            const line = (raw||'').trim(); if(!line) continue;
            await waSendBurst(from, line, 420);
          }
          continue;
        }
        // fallback visível
        await waSendText(from, '[mensagem recebida]');
      }
    }
    res.sendStatus(200);
  }catch(e){
    console.error('WA handler error:', e?.response?.data || e);
    res.sendStatus(200);
  }
});

app.listen(PORT, ()=>console.log(`Kelly combined on :${PORT} (CX: ${CX_LOCATION}-dialogflow.googleapis.com)`));
