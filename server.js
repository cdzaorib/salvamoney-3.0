const express = require('express');
const axios = require('axios');
const { initializeApp } = require('firebase/app');
const { getDatabase, ref, get, push, set } = require('firebase/database');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '1mb' }));

const REQUIRED_ENV = [
  'ZAPI_INSTANCE',
  'ZAPI_TOKEN',
  'FIREBASE_API_KEY',
  'FIREBASE_AUTH_DOMAIN',
  'FIREBASE_DB_URL',
  'FIREBASE_PROJECT_ID',
  'FIREBASE_APP_ID',
];

const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missingEnv.length) {
  console.error(`❌ Variáveis de ambiente ausentes: ${missingEnv.join(', ')}`);
  process.exit(1);
}

if (!process.env.ZAPI_CLIENT_TOKEN) {
  console.warn('⚠️ ZAPI_CLIENT_TOKEN não configurado. A Z-API pode recusar envios sem o header Client-Token.');
}

if (!process.env.GROQ_API_KEY) {
  console.warn('⚠️ GROQ_API_KEY não configurado. Bot vai usar comandos simples sem IA.');
}

// ─── FIREBASE ────────────────────────────────────────────
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  databaseURL: process.env.FIREBASE_DB_URL,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID,
};

const firebaseApp = initializeApp(firebaseConfig);
const db = getDatabase(firebaseApp);

// ─── Z-API ───────────────────────────────────────────────
const ZAPI_INSTANCE = process.env.ZAPI_INSTANCE;
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN;
const ZAPI_URL = `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}`;

async function sendMessage(phone, message, messageId) {
  const headers = { 'Content-Type': 'application/json' };
  if (ZAPI_CLIENT_TOKEN) headers['Client-Token'] = ZAPI_CLIENT_TOKEN;

  const payload = { phone, message };
  if (messageId) payload.messageId = messageId;

  try {
    await axios.post(`${ZAPI_URL}/send-text`, payload, { headers, timeout: 15000 });
  } catch (e) {
    console.error('Erro ao enviar mensagem:', e.response?.status || '', e.response?.data || e.message);
  }
}

// ─── GROQ AI ─────────────────────────────────────────────
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

async function chamarIA(mensagens) {
  const resp = await axios.post(GROQ_URL, {
    model: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
    messages: mensagens,
    temperature: 0.3,
    max_tokens: 350,
  }, {
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    timeout: 15000,
  });
  return resp.data?.choices?.[0]?.message?.content?.trim() || '';
}

// ─── CATEGORIAS ──────────────────────────────────────────
const CATEGORIAS = {
  Alimentação: ['supermercado', 'restaurante', 'hamburguer', 'mercado', 'comida', 'almoço', 'jantar', 'café', 'lanche', 'ifood', 'pizza', 'padaria', 'açaí', 'delivery', 'rappi', 'marmita', 'hortifruti', 'feira'],
  Transporte: ['combustível', 'combustivel', 'estacionamento', 'gasolina', 'ônibus', 'metrô', 'metro', 'táxi', 'taxi', 'passagem', 'posto', 'uber', '99'],
  Saúde: ['farmácia', 'farmacia', 'médico', 'medico', 'remédio', 'remedio', 'consulta', 'exame', 'hospital', 'dentista', 'plano', 'unimed'],
  Lazer: ['cinema', 'show', 'teatro', 'jogo', 'netflix', 'spotify', 'disney', 'prime', 'youtube', 'bar', 'balada', 'festa', 'ingresso', 'parque'],
  Moradia: ['condomínio', 'condominio', 'aluguel', 'internet', 'energia', 'luz', 'água', 'agua', 'gás', 'gas', 'iptu', 'wifi'],
  Educação: ['faculdade', 'apostila', 'curso', 'livro', 'escola', 'udemy', 'aula'],
  Roupas: ['camisa', 'calça', 'vestido', 'roupa', 'sapato', 'tênis', 'tenis', 'loja'],
  Academia: ['musculação', 'musculacao', 'academia', 'pilates', 'crossfit', 'gym'],
};

function normalizeText(text = '') {
  return String(text).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function detectarCategoria(texto) {
  const normalized = normalizeText(texto);
  for (const [cat, palavras] of Object.entries(CATEGORIAS)) {
    for (const palavra of palavras) {
      const p = normalizeText(palavra);
      const isShort = p.length <= 3;
      const regex = isShort ? new RegExp(`(^|\\W)${escapeRegExp(p)}(\\W|$)`, 'i') : null;
      if (isShort ? regex.test(normalized) : normalized.includes(p)) return cat;
    }
  }
  return 'Outros';
}

// ─── DATA / FORMATO DO SITE ─────────────────────────────
const TIME_ZONE = process.env.TZ || 'America/Sao_Paulo';
const MONTH_INDEX_MODE = process.env.MONTH_INDEX_MODE === 'one' ? 'one' : 'zero';

function dateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
}

function monthKey(date = new Date()) {
  const parts = dateParts(date);
  const monthOneBased = Number(parts.month);
  const storedMonth = MONTH_INDEX_MODE === 'one' ? monthOneBased : monthOneBased - 1;
  return `${parts.year}_${storedMonth}`;
}

function todayIso(date = new Date()) {
  const parts = dateParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function sanitizeFirebaseKey(value) {
  return String(value || '').trim().replace(/[.#$\[\]/]/g, '-');
}

async function getSession(phone) {
  const snap = await get(ref(db, `bot_sessions/${phone}`));
  return snap.val();
}

async function saveSession(phone, data) {
  await set(ref(db, `bot_sessions/${phone}`), data);
}

function fmt(v) {
  return `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ─── PARSER DE GASTO ─────────────────────────────────────
function parseMoney(rawValue) {
  const cleaned = String(rawValue || '').replace(/r\$/gi, '').replace(/\s/g, '').trim();
  let normalized = cleaned;
  if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(cleaned)) {
    normalized = cleaned.replace(/\./g, '').replace(',', '.');
  } else if (cleaned.includes(',') && !cleaned.includes('.')) {
    normalized = cleaned.replace(',', '.');
  }
  const value = Number.parseFloat(normalized);
  return Number.isFinite(value) ? value : null;
}

function parsearGasto(texto) {
  const text = String(texto || '').trim()
    .replace(/^gastei\s*/i, '')
    .replace(/\breais?\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  const moneyPattern = '(?:R\\$\\s*)?\\d{1,3}(?:\\.\\d{3})*(?:[,.]\\d{1,2})?|(?:R\\$\\s*)?\\d+(?:[,.]\\d{1,2})?';

  let match = text.match(new RegExp(`^(${moneyPattern})\\s+(.+)$`, 'i'));
  if (match) {
    const valor = parseMoney(match[1]);
    const desc = match[2].replace(/^no |^na |^em /i, '').trim();
    if (valor && valor > 0 && desc) return { valor, desc };
  }

  match = text.match(new RegExp(`^(.+?)\\s+(${moneyPattern})$`, 'i'));
  if (match) {
    const valor = parseMoney(match[2]);
    const desc = match[1].replace(/^no |^na |^em /i, '').trim();
    if (valor && valor > 0 && desc) return { valor, desc };
  }

  return null;
}

// ─── HELPERS ─────────────────────────────────────────────
function isHelpCommand(msgMin) {
  return ['ajuda', 'help', 'oi', 'olá', 'ola', 'menu', 'start', '/start'].includes(msgMin);
}

function isSummaryCommand(msgMin) {
  return ['resumo', 'extrato', 'total'].includes(msgMin);
}

function getTextFromWebhook(body) {
  return body?.text?.message || body?.body || body?.message?.text || '';
}

function getPhoneFromWebhook(body) {
  return String(body?.phone || body?.sender || '').replace(/\D/g, '');
}

const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
               'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

// ─── BUSCAR GASTOS DO MÊS ────────────────────────────────
async function getGastosMes(group, user) {
  const snap = await get(ref(db, `grupos/${group}/usuarios/${user}/gastos/${monthKey()}`));
  return Object.values(snap.val() || {}).filter((item) => item && Number.isFinite(Number(item.value)));
}

async function getResumoTexto(group, user) {
  const items = await getGastosMes(group, user);
  if (!items.length) return 'Nenhum gasto registrado este mes ainda.';

  const total = items.reduce((a, e) => a + Number(e.value || 0), 0);
  const porCat = {};
  items.forEach(e => { porCat[e.cat || 'Outros'] = (porCat[e.cat || 'Outros'] || 0) + Number(e.value || 0); });

  const cats = Object.entries(porCat)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, val]) => `${cat}: ${fmt(val)}`)
    .join(', ');

  const monthIndex = Number(dateParts().month) - 1;
  return `Mes: ${MESES[monthIndex]}. Total gasto: ${fmt(total)}. Por categoria: ${cats}.`;
}

async function montarResumoFormatado(sessao) {
  const items = await getGastosMes(sessao.group, sessao.user);
  if (!items.length) return `📭 Nenhum gasto registrado em ${MESES[Number(dateParts().month) - 1]} ainda.`;

  const total = items.reduce((a, e) => a + Number(e.value || 0), 0);
  const porCat = {};
  items.forEach(e => { porCat[e.cat || 'Outros'] = (porCat[e.cat || 'Outros'] || 0) + Number(e.value || 0); });

  const cats = Object.entries(porCat)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, val]) => `  • ${cat}: ${fmt(val)}`)
    .join('\n');

  const monthIndex = Number(dateParts().month) - 1;
  return `📊 *Resumo de ${MESES[monthIndex]}*\nUsuário: ${sessao.user} | Grupo: ${sessao.group}\n\n${cats}\n\n💸 *Total: ${fmt(total)}*`;
}

// ─── PROCESSAR COM IA ─────────────────────────────────────
async function processarComIA(textoUsuario, sessao) {
  const resumo = await getResumoTexto(sessao.group, sessao.user);
  const hoje = todayIso();

  const systemPrompt = `Você é o assistente financeiro do SalvaMoney, um app de controle de gastos brasileiro.
Você conversa via WhatsApp de forma direta, amigável e em português brasileiro informal.
Use emojis com moderação.

USUÁRIO ATUAL: ${sessao.user} | GRUPO: ${sessao.group}
DATA DE HOJE: ${hoje}
RESUMO FINANCEIRO DO MÊS: ${resumo}

CATEGORIAS DISPONÍVEIS: Alimentação, Moradia, Transporte, Saúde, Lazer, Educação, Roupas, Academia, Outros.

SUA MISSÃO:
1. Se o usuário está registrando um gasto (qualquer forma que ele escrever), responda APENAS com JSON:
{"acao":"registrar","desc":"descrição do gasto","valor":00.00,"cat":"Categoria","data":"${hoje}"}

2. Se quer ver resumo/extrato/total/quanto gastou, responda APENAS com JSON:
{"acao":"resumo"}

3. Se é uma dúvida, conversa, pedido de dica financeira ou qualquer outra coisa, responda normalmente em texto.

EXEMPLOS DE REGISTRO (sempre JSON):
"almocei, gastei 30" → {"acao":"registrar","desc":"almoço","valor":30.00,"cat":"Alimentação","data":"${hoje}"}
"paguei 150 de mercado ontem" → {"acao":"registrar","desc":"mercado","valor":150.00,"cat":"Alimentação","data":"${hoje}"}
"uber pra trabalhar 22 conto" → {"acao":"registrar","desc":"uber trabalho","valor":22.00,"cat":"Transporte","data":"${hoje}"}
"netflix tá 37" → {"acao":"registrar","desc":"Netflix","valor":37.00,"cat":"Lazer","data":"${hoje}"}
"35 conto no almoço" → {"acao":"registrar","desc":"almoço","valor":35.00,"cat":"Alimentação","data":"${hoje}"}

IMPORTANTE: Nunca invente valores. Se o usuário não informar o valor, pergunte.`;

  const resposta = await chamarIA([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: textoUsuario },
  ]);

  // Tenta extrair JSON da resposta
  try {
    const jsonMatch = resposta.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) throw new Error('sem json');
    const json = JSON.parse(jsonMatch[0]);

    if (json.acao === 'registrar') {
      if (!json.valor || json.valor <= 0) return `Qual foi o valor? 💸`;

      await push(ref(db, `grupos/${sessao.group}/usuarios/${sessao.user}/gastos/${monthKey()}`), {
        desc: json.desc,
        value: json.valor,
        cat: json.cat || detectarCategoria(json.desc),
        date: json.data || hoje,
        user: sessao.user,
        viaBot: true,
        createdAt: new Date().toISOString(),
      });

      return `✅ *${json.desc}* registrado!\n💸 ${fmt(json.valor)} · 📂 ${json.cat}`;
    }

    if (json.acao === 'resumo') {
      return await montarResumoFormatado(sessao);
    }

  } catch (e) {
    // Não é JSON — resposta de texto normal da IA
    return resposta;
  }

  return resposta;
}

// ─── PROCESSAR MENSAGEM ──────────────────────────────────
async function processarMensagem(phone, texto) {
  const msg = String(texto || '').trim();
  const msgMin = msg.toLowerCase();
  const sessao = await getSession(phone);

  // ── AJUDA ──
  if (isHelpCommand(msgMin)) {
    return `💰 *SalvaMoney Bot*\n\nOlá! Fale naturalmente ou use comandos:\n\n📌 *Registrar gasto:*\n_almocei e gastei 35_\n_paguei 150 de mercado_\n_netflix 37 reais_\n\n📊 *Ver resumo:*\n_resumo_ ou _quanto gastei?_\n\n👤 *Vincular conta:*\n_entrar SEU NOME CODIGODOGRUPO_\n\n${sessao ? `✅ Conta: *${sessao.user}* (grupo *${sessao.group}*)` : '⚠️ Conta não vinculada. Use: _entrar NOME GRUPO_'}`;
  }

  // ── ENTRAR NO GRUPO ──
  const matchEntrar = msg.match(/^entrar\s+(.+)\s+([A-Za-z0-9_-]+)$/i);
  if (matchEntrar) {
    const user = sanitizeFirebaseKey(matchEntrar[1]);
    const group = sanitizeFirebaseKey(matchEntrar[2].toUpperCase());

    if (!user || !group) return '❌ Use assim: _entrar SEU NOME CODIGODOGRUPO_';

    const snap = await get(ref(db, `grupos/${group}`));
    if (!snap.exists()) return `❌ Grupo *${group}* não encontrado.\nVerifique o código e tente novamente.`;

    await saveSession(phone, { user, group, updatedAt: todayIso() });
    return `✅ Pronto! Você entrou como *${user}* no grupo *${group}*.\n\nAgora fale naturalmente:\n_"almocei e gastei 35"_\n_"paguei 150 de mercado"_\n_"quanto gastei esse mês?"_`;
  }

  // ── SEM SESSÃO ──
  if (!sessao) {
    return '⚠️ Primeiro vincule sua conta:\n*entrar SEU NOME CODIGODOGRUPO*\n\nEx: _entrar João CASA2024_';
  }

  // ── RESUMO DIRETO (sem gastar IA) ──
  if (isSummaryCommand(msgMin) || /quanto\s+(eu\s+)?gastei|gastos?\s+do\s+m[eê]s|total\s+do\s+m[eê]s/i.test(msg)) {
    return await montarResumoFormatado(sessao);
  }

  // ── PARSER SIMPLES PRIMEIRO (mais rápido, barato e confiável) ──
  const gasto = parsearGasto(msg);
  if (gasto) {
    const cat = detectarCategoria(gasto.desc);
    await push(ref(db, `grupos/${sessao.group}/usuarios/${sessao.user}/gastos/${monthKey()}`), {
      desc: gasto.desc,
      value: gasto.valor,
      cat,
      date: todayIso(),
      user: sessao.user,
      viaBot: true,
      createdAt: new Date().toISOString(),
    });
    return `✅ *${gasto.desc}* registrado!\n💸 Valor: ${fmt(gasto.valor)}\n📂 Categoria: ${cat}\n\nDigite _resumo_ pra ver o total do mês.`;
  }

  // ── IA SÓ COMO FALLBACK PARA MENSAGENS LIVRES/AMBÍGUAS ──
  if (GROQ_API_KEY) {
    try {
      return await processarComIA(msg, sessao);
    } catch (err) {
      console.error('Erro na IA:', err.response?.data || err.message);
    }
  }

  return '🤔 Não entendi. Tente:\n_gastei 50 almoço_\n_35 uber_\n_mercado 120,50_\n\nOu *ajuda* pra ver os comandos.';
}

// ─── WEBHOOK Z-API ───────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body || {};
    if (body.fromMe) return;
    if (body.isGroup) return;
    if (body.type && body.type !== 'ReceivedCallback') return;

    const phone = getPhoneFromWebhook(body);
    const texto = getTextFromWebhook(body);
    const messageId = body.messageId || body.zaapId || body.id;

    if (!phone || !texto) return;

    console.log(`📩 [${phone}] ${texto}`);
    const resposta = await processarMensagem(phone, texto);
    if (resposta) await sendMessage(phone, resposta, messageId);

  } catch (err) {
    console.error('Erro no webhook:', err);
  }
});

app.get('/', (_req, res) => {
  res.json({ status: 'ok', bot: 'SalvaMoney + Groq AI', version: '2.0.0' });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 SalvaMoney Bot (IA) rodando na porta ${PORT}`));
