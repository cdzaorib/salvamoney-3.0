'use strict';

const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const { initializeApp } = require('firebase/app');
const { getDatabase, ref, get, push, set, remove } = require('firebase/database');
require('dotenv').config();

// ─── APP ─────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: process.env.JSON_LIMIT || '25mb' }));

// ─── CONFIG GERAL ─────────────────────────────────────────
const WHATSAPP_PROVIDER = process.env.WHATSAPP_PROVIDER || 'zapi';
const SITE_URL = process.env.SITE_URL || 'https://cdzaorib.github.io/Salvamoney2.0/';

// ─── VALIDAÇÃO DE ENV ─────────────────────────────────────
const REQUIRED_ENV = [
  'FIREBASE_API_KEY',
  'FIREBASE_AUTH_DOMAIN',
  'FIREBASE_DB_URL',
  'FIREBASE_PROJECT_ID',
  'FIREBASE_APP_ID',
];

if (WHATSAPP_PROVIDER === 'evolution') {
  REQUIRED_ENV.push('EVOLUTION_API_URL', 'EVOLUTION_API_KEY', 'EVOLUTION_INSTANCE');
} else {
  REQUIRED_ENV.push('ZAPI_INSTANCE', 'ZAPI_TOKEN');
}

const missingEnv = REQUIRED_ENV.filter((k) => !process.env[k]);

if (missingEnv.length) {
  console.error(`❌ Variáveis ausentes: ${missingEnv.join(', ')}`);
  process.exit(1);
}

if (WHATSAPP_PROVIDER !== 'evolution' && !process.env.ZAPI_CLIENT_TOKEN) {
  console.warn('⚠️ ZAPI_CLIENT_TOKEN não configurado. A Z-API pode recusar envios.');
}

if (!process.env.GROQ_API_KEY) {
  console.warn('⚠️ GROQ_API_KEY ausente. Sem IA, sem áudio e sem imagem.');
}

// ─── FIREBASE ─────────────────────────────────────────────
const db = getDatabase(initializeApp({
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  databaseURL: process.env.FIREBASE_DB_URL,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET || '',
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '',
  appId: process.env.FIREBASE_APP_ID,
}));

// ─── CACHE DE SESSÃO ──────────────────────────────────────
const sessionCache = new Map();
const SESSION_TTL = 5 * 60 * 1000;

async function getSession(phone) {
  const cached = sessionCache.get(phone);

  if (cached && Date.now() - cached.ts < SESSION_TTL) {
    return cached.data;
  }

  const snap = await get(ref(db, `bot_sessions/${phone}`));
  const data = snap.val();

  sessionCache.set(phone, { data, ts: Date.now() });

  return data;
}

async function saveSession(phone, data) {
  await set(ref(db, `bot_sessions/${phone}`), data);
  sessionCache.set(phone, { data, ts: Date.now() });
}

// ─── RATE LIMIT ───────────────────────────────────────────
const lastMsg = new Map();
const RATE_MS = 2000;

function isRateLimited(phone) {
  const last = lastMsg.get(phone) || 0;

  if (Date.now() - last < RATE_MS) {
    return true;
  }

  lastMsg.set(phone, Date.now());

  return false;
}

// ─── WHATSAPP: Z-API / EVOLUTION ─────────────────────────
const ZAPI_URL = process.env.ZAPI_INSTANCE && process.env.ZAPI_TOKEN
  ? `https://api.z-api.io/instances/${process.env.ZAPI_INSTANCE}/token/${process.env.ZAPI_TOKEN}`
  : null;

const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL;
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY;
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || 'salvamoney';

async function sendMessage(phone, message, messageId) {
  try {
    if (WHATSAPP_PROVIDER === 'evolution') {
      await axios.post(
        `${EVOLUTION_API_URL}/message/sendText/${EVOLUTION_INSTANCE}`,
        {
          number: String(phone).replace(/\D/g, ''),
          text: message,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            apikey: EVOLUTION_API_KEY,
          },
          timeout: 15000,
        }
      );

      return;
    }

    if (!ZAPI_URL) {
      throw new Error('Z-API não configurada.');
    }

    const headers = { 'Content-Type': 'application/json' };

    if (process.env.ZAPI_CLIENT_TOKEN) {
      headers['Client-Token'] = process.env.ZAPI_CLIENT_TOKEN;
    }

    const payload = { phone, message };

    if (messageId) {
      payload.messageId = messageId;
    }

    await axios.post(`${ZAPI_URL}/send-text`, payload, {
      headers,
      timeout: 15000,
    });
  } catch (e) {
    console.error('Erro ao enviar msg:', e.response?.status, e.response?.data || e.message);
  }
}

// ─── GROQ AI ─────────────────────────────────────────────
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_CHAT = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_AUDIO = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';
const GROQ_VISION = process.env.GROQ_VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';
const GROQ_WHISPER = process.env.GROQ_AUDIO_MODEL || 'whisper-large-v3-turbo';

function limparBase64(v = '') {
  return String(v).replace(/^data:.*?;base64,/, '').trim();
}

async function chamarIA(mensagens) {
  if (!GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY ausente.');
  }

  const r = await axios.post(
    GROQ_CHAT,
    {
      model: GROQ_MODEL,
      messages: mensagens,
      temperature: 0.2,
      max_tokens: 500,
    },
    {
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    }
  );

  return r.data?.choices?.[0]?.message?.content?.trim() || '';
}

async function transcreverAudio(base64Audio, mimeType = 'audio/ogg') {
  if (!GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY ausente.');
  }

  const buffer = Buffer.from(limparBase64(base64Audio), 'base64');

  if (buffer.length > 24 * 1024 * 1024) {
    throw new Error('Áudio maior que 24MB.');
  }

  const form = new FormData();

  form.append('file', buffer, {
    filename: 'audio.ogg',
    contentType: mimeType || 'audio/ogg',
  });

  form.append('model', GROQ_WHISPER);
  form.append('language', 'pt');
  form.append('response_format', 'json');

  const r = await axios.post(GROQ_AUDIO, form, {
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      ...form.getHeaders(),
    },
    timeout: 60000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });

  return r.data?.text?.trim() || '';
}

async function analisarImagem(base64Image, mimeType = 'image/jpeg') {
  if (!GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY ausente.');
  }

  const imageUrl = `data:${mimeType || 'image/jpeg'};base64,${limparBase64(base64Image)}`;

  const r = await axios.post(
    GROQ_CHAT,
    {
      model: GROQ_VISION,
      messages: [
        {
          role: 'system',
          content: `Você é o leitor de comprovantes do SalvaMoney.

Extraia dados financeiros de imagens, prints, notas fiscais e comprovantes.

Responda APENAS JSON válido, sem markdown.

Formato quando encontrar gasto:
{"encontrou_gasto":true,"desc":"descrição curta","valor":00.00,"cat":"Categoria","data":"YYYY-MM-DD"}

Categorias permitidas:
Alimentação, Moradia, Transporte, Saúde, Lazer, Educação, Roupas, Academia, Outros.

Regras de categoria:
- mercado, supermercado, restaurante, almoço, jantar, lanche, ifood, padaria, pizza, comida → Alimentação
- uber, 99, gasolina, posto, ônibus, estacionamento → Transporte
- farmácia, remédio, consulta, médico, exame → Saúde
- aluguel, luz, água, internet, condomínio, gás → Moradia
- netflix, spotify, cinema, bar, festa, ingresso → Lazer
- academia, gym, musculação, pilates → Academia

Se não encontrar gasto claro:
{"encontrou_gasto":false}

Nunca invente valor.`,
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Analise esta imagem e extraia o gasto principal. Não invente valor.',
            },
            {
              type: 'image_url',
              image_url: {
                url: imageUrl,
              },
            },
          ],
        },
      ],
      temperature: 0.1,
      max_tokens: 400,
    },
    {
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 60000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    }
  );

  return r.data?.choices?.[0]?.message?.content?.trim() || '';
}

// ─── CATEGORIAS ───────────────────────────────────────────
const CATEGORIAS = {
  Alimentação: [
    'supermercado',
    'restaurante',
    'hamburguer',
    'hambúrguer',
    'mercado',
    'comida',
    'almoço',
    'almoco',
    'almocei',
    'jantar',
    'jantei',
    'café',
    'cafe',
    'lanche',
    'ifood',
    'pizza',
    'padaria',
    'açaí',
    'acai',
    'delivery',
    'rappi',
    'marmita',
    'hortifruti',
    'feira',
    'pastel',
    'sorvete',
    'churrasco',
    'bebida',
    'bebidas',
    'restaurante',
    'lanchonete',
  ],
  Transporte: [
    'combustível',
    'combustivel',
    'estacionamento',
    'gasolina',
    'ônibus',
    'onibus',
    'metrô',
    'metro',
    'táxi',
    'taxi',
    'passagem',
    'posto',
    'uber',
    '99',
    'pedágio',
    'pedagio',
    'transporte',
  ],
  Saúde: [
    'farmácia',
    'farmacia',
    'médico',
    'medico',
    'remédio',
    'remedio',
    'consulta',
    'exame',
    'hospital',
    'dentista',
    'plano',
    'unimed',
    'saúde',
    'saude',
  ],
  Lazer: [
    'cinema',
    'show',
    'teatro',
    'jogo',
    'netflix',
    'spotify',
    'disney',
    'prime',
    'youtube',
    'bar',
    'balada',
    'festa',
    'ingresso',
    'parque',
    'lazer',
  ],
  Moradia: [
    'condomínio',
    'condominio',
    'aluguel',
    'internet',
    'energia',
    'luz',
    'água',
    'agua',
    'gás',
    'gas',
    'iptu',
    'wifi',
    'moradia',
    'casa',
  ],
  Educação: [
    'faculdade',
    'apostila',
    'curso',
    'livro',
    'escola',
    'udemy',
    'aula',
    'educação',
    'educacao',
  ],
  Roupas: [
    'camisa',
    'calça',
    'calca',
    'vestido',
    'roupa',
    'sapato',
    'tênis',
    'tenis',
    'loja',
    'short',
    'blusa',
  ],
  Academia: [
    'musculação',
    'musculacao',
    'academia',
    'pilates',
    'crossfit',
    'gym',
    'creatina',
    'whey',
  ],
};

const CATEGORIAS_VALIDAS = [
  'Alimentação',
  'Moradia',
  'Transporte',
  'Saúde',
  'Lazer',
  'Educação',
  'Roupas',
  'Academia',
  'Outros',
];

function normalizeText(t = '') {
  return String(t)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function escapeRE(v) {
  return String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function detectarCategoria(texto) {
  const n = normalizeText(texto);

  for (const [cat, palavras] of Object.entries(CATEGORIAS)) {
    for (const p of palavras) {
      const pn = normalizeText(p);

      if (pn.length <= 3) {
        if (new RegExp(`(^|\\W)${escapeRE(pn)}(\\W|$)`, 'i').test(n)) {
          return cat;
        }
      } else if (n.includes(pn)) {
        return cat;
      }
    }
  }

  return 'Outros';
}

function categoriaFinal(desc, categoriaSugerida) {
  const sugerida = CATEGORIAS_VALIDAS.includes(categoriaSugerida)
    ? categoriaSugerida
    : 'Outros';

  const detectada = detectarCategoria(desc);

  if (sugerida === 'Outros' && detectada !== 'Outros') {
    return detectada;
  }

  if (!sugerida || !CATEGORIAS_VALIDAS.includes(sugerida)) {
    return detectada;
  }

  return sugerida;
}

// ─── HELPERS DE DATA ──────────────────────────────────────
const TIME_ZONE = process.env.TZ || 'America/Sao_Paulo';
const MONTH_INDEX_MODE = process.env.MONTH_INDEX_MODE === 'one' ? 'one' : 'zero';

function dateParts(date = new Date()) {
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(date)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, p.value])
  );
}

function monthKey(date = new Date()) {
  const p = dateParts(date);
  const m = MONTH_INDEX_MODE === 'one' ? Number(p.month) : Number(p.month) - 1;

  return `${p.year}_${m}`;
}

function todayIso(date = new Date()) {
  const p = dateParts(date);

  return `${p.year}-${p.month}-${p.day}`;
}

function sanitizeKey(v) {
  return String(v || '')
    .trim()
    .replace(/[.#$\[\]\/]/g, '-');
}

function fmt(v) {
  return `R$ ${Number(v || 0).toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

const MESES = [
  'Janeiro',
  'Fevereiro',
  'Março',
  'Abril',
  'Maio',
  'Junho',
  'Julho',
  'Agosto',
  'Setembro',
  'Outubro',
  'Novembro',
  'Dezembro',
];

// ─── CRIAR CÓDIGO DE GRUPO ────────────────────────────────
function gerarCodigoGrupo(nome = '') {
  const base = normalizeText(nome)
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 6)
    .toUpperCase();

  const prefix = base || 'GRUPO';
  const numero = Math.floor(1000 + Math.random() * 9000);

  return `${prefix}${numero}`;
}

function isCreateCodeCommand(msg = '') {
  return /^(criar|gerar|novo)\s+(codigo|código)\b/i.test(msg);
}

function extrairNomeDoCriarCodigo(msg = '') {
  return msg
    .replace(/^(criar|gerar|novo)\s+(codigo|código)\s*/i, '')
    .trim();
}

async function criarCodigoGrupo(phone, nomeInformado) {
  const nome = sanitizeKey(nomeInformado);

  if (!nome) {
    return `💰 *Criar código do SalvaMoney*

Para criar seu código, digite assim:

_criar código SEU NOME_

Exemplo:
_criar código Carlos_

Esse código serve para conectar você ao site e também para dividir contas com outras pessoas.

Se alguém entrar no mesmo código que você, essa pessoa conseguirá ver as contas divididas do grupo.

🌐 Site:
${SITE_URL}`;
  }

  for (let i = 0; i < 8; i++) {
    const codigo = sanitizeKey(gerarCodigoGrupo(nome));
    const snap = await get(ref(db, `grupos/${codigo}`));

    if (!snap.exists()) {
      await set(ref(db, `grupos/${codigo}/info`), {
        criador: nome,
        criadoVia: 'whatsapp',
        criadoEm: new Date().toISOString(),
      });

      await saveSession(phone, {
        user: nome,
        group: codigo,
        updatedAt: todayIso(),
      });

      return `✅ Código criado com sucesso!

👤 Nome: *${nome}*
🔑 Código do grupo: *${codigo}*

Para outra pessoa entrar no mesmo grupo, ela deve mandar:
_entrar NOME ${codigo}_

Esse código serve para vincular sua conta ao site e também para dividir contas com outras pessoas.

Se uma pessoa estiver no mesmo código que você, as contas divididas desse grupo ficarão visíveis para ela.

🌐 Ver no site:
${SITE_URL}`;
    }
  }

  return 'Não consegui gerar um código agora. Tente novamente em alguns segundos.';
}

// ─── FIREBASE: GASTOS ─────────────────────────────────────
async function getGastosMesComIds(group, user, date) {
  const snap = await get(ref(db, `grupos/${group}/usuarios/${user}/gastos/${monthKey(date)}`));

  return Object.entries(snap.val() || {})
    .map(([id, item]) => ({ id, ...item }))
    .filter((item) => item && Number.isFinite(Number(item.value)));
}

async function getResumoTexto(group, user) {
  const items = await getGastosMesComIds(group, user);

  if (!items.length) {
    return 'Nenhum gasto registrado este mês ainda.';
  }

  const total = items.reduce((a, e) => a + Number(e.value || 0), 0);
  const porCat = {};

  items.forEach((e) => {
    porCat[e.cat || 'Outros'] = (porCat[e.cat || 'Outros'] || 0) + Number(e.value || 0);
  });

  const cats = Object.entries(porCat)
    .sort((a, b) => b[1] - a[1])
    .map(([c, v]) => `${c}: ${fmt(v)}`)
    .join(', ');

  return `Mês: ${MESES[Number(dateParts().month) - 1]}. Total: ${fmt(total)}. Por categoria: ${cats}.`;
}

async function montarResumoFormatado(sessao) {
  const items = await getGastosMesComIds(sessao.group, sessao.user);
  const mes = MESES[Number(dateParts().month) - 1];

  if (!items.length) {
    return `📭 Nenhum gasto registrado em ${mes} ainda.

🌐 Ver no site:
${SITE_URL}`;
  }

  const total = items.reduce((a, e) => a + Number(e.value || 0), 0);
  const porCat = {};

  items.forEach((e) => {
    porCat[e.cat || 'Outros'] = (porCat[e.cat || 'Outros'] || 0) + Number(e.value || 0);
  });

  const cats = Object.entries(porCat)
    .sort((a, b) => b[1] - a[1])
    .map(([c, v]) => `  • ${c}: ${fmt(v)}`)
    .join('\n');

  const ultimos = items
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .slice(0, 5)
    .map((e, i) => `  ${i + 1}. ${e.desc || 'Gasto'} — ${fmt(e.value)} (${e.cat || 'Outros'})`)
    .join('\n');

  return [
    `📊 *Resumo de ${mes}*`,
    `👤 ${sessao.user} | Grupo: ${sessao.group}`,
    '',
    cats,
    '',
    `💸 *Total: ${fmt(total)}*`,
    '',
    '🧾 *Últimos gastos:*',
    ultimos,
    '',
    '🌐 Ver no site:',
    SITE_URL,
    '',
    'Para apagar: _apagar último_ ou _apagar [valor]_',
  ].join('\n');
}

// ─── PARSER DE VALORES MONETÁRIOS ────────────────────────
function parseMoney(raw) {
  const c = String(raw || '')
    .replace(/r\$/gi, '')
    .replace(/\s/g, '')
    .trim();

  let n = c;

  if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(c)) {
    n = c.replace(/\./g, '').replace(',', '.');
  } else if (c.includes(',') && !c.includes('.')) {
    n = c.replace(',', '.');
  }

  const v = parseFloat(n);

  return isFinite(v) ? v : null;
}

function parsearGasto(texto) {
  const t = String(texto || '')
    .trim()
    .replace(/^gastei\s*/i, '')
    .replace(/\breais?\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  const mp = '(?:R\\$\\s*)?\\d{1,3}(?:\\.\\d{3})*(?:[,.]\\d{1,2})?|(?:R\\$\\s*)?\\d+(?:[,.]\\d{1,2})?';

  let m = t.match(new RegExp(`^(${mp})\\s+(.+)$`, 'i'));

  if (m) {
    const v = parseMoney(m[1]);
    const d = m[2].replace(/^(no|na|em)\s+/i, '').trim();

    if (v && v > 0 && d) {
      return { valor: v, desc: d };
    }
  }

  m = t.match(new RegExp(`^(.+?)\\s+(${mp})$`, 'i'));

  if (m) {
    const v = parseMoney(m[2]);
    const d = m[1].replace(/^(no|na|em)\s+/i, '').trim();

    if (v && v > 0 && d) {
      return { valor: v, desc: d };
    }
  }

  return null;
}

// ─── PARCELAMENTO ─────────────────────────────────────────
function parsearParcelamento(texto) {
  let m = texto.match(/(?:parcelei|comprei parcelado?)\s+([\d.,]+)\s+(.+?)\s+em\s+(\d+)\s*[xX]/i);

  if (m) {
    return {
      valor: parseMoney(m[1]),
      desc: m[2].trim(),
      parcelas: parseInt(m[3], 10),
    };
  }

  m = texto.match(/(?:parcelei|comprei parcelado?)\s+(.+?)\s+([\d.,]+)\s+em\s+(\d+)\s*[xX]/i);

  if (m) {
    return {
      valor: parseMoney(m[2]),
      desc: m[1].trim(),
      parcelas: parseInt(m[3], 10),
    };
  }

  return null;
}

async function registrarParcelamento(sessao, { valor, desc, parcelas }) {
  if (!valor || valor <= 0) {
    return 'Qual foi o valor total? 💸';
  }

  if (parcelas < 2 || parcelas > 60) {
    return 'Parcelas devem ser entre 2 e 60.';
  }

  const cat = detectarCategoria(desc);
  const valorParcela = Math.round((valor / parcelas) * 100) / 100;
  const hoje = new Date();

  for (let i = 0; i < parcelas; i++) {
    const data = new Date(hoje.getFullYear(), hoje.getMonth() + i, hoje.getDate());

    await push(ref(db, `grupos/${sessao.group}/usuarios/${sessao.user}/gastos/${monthKey(data)}`), {
      desc: `${desc} (${i + 1}/${parcelas})`,
      value: valorParcela,
      cat,
      date: todayIso(data),
      user: sessao.user,
      viaBot: true,
      origem: 'parcelamento',
      parcela: {
        numero: i + 1,
        total: parcelas,
        valorTotal: valor,
      },
      createdAt: new Date().toISOString(),
    });
  }

  return `💳 *${desc}* parcelado!
💸 Total: ${fmt(valor)}
📅 ${parcelas}x de ${fmt(valorParcela)}
📂 Categoria: ${cat}

As parcelas foram lançadas nos próximos ${parcelas} meses.

🌐 Ver no site:
${SITE_URL}`;
}

// ─── REGISTRAR GASTO ──────────────────────────────────────
async function registrarGasto(sessao, gasto, origem = 'texto') {
  const valor = Number(gasto.valor || gasto.value || 0);
  const desc = String(gasto.desc || gasto.descricao || 'Gasto').trim();

  if (!valor || valor <= 0) {
    return 'Qual foi o valor? 💸';
  }

  const cat = categoriaFinal(desc, gasto.cat);

  await push(ref(db, `grupos/${sessao.group}/usuarios/${sessao.user}/gastos/${monthKey()}`), {
    desc,
    value: valor,
    cat,
    date: gasto.data || todayIso(),
    user: sessao.user,
    viaBot: true,
    origem,
    createdAt: new Date().toISOString(),
  });

  return `✅ *${desc}* registrado!
💸 Valor: ${fmt(valor)}
📂 Categoria: ${cat}

🌐 Ver no site:
${SITE_URL}

Se foi errado: _apagar último_`;
}

// ─── APAGAR GASTO ─────────────────────────────────────────
async function apagarGastoPorId(sessao, id) {
  await remove(ref(db, `grupos/${sessao.group}/usuarios/${sessao.user}/gastos/${monthKey()}/${id}`));
}

async function apagarGastoPorTexto(sessao, texto) {
  const items = await getGastosMesComIds(sessao.group, sessao.user);

  if (!items.length) {
    return '📭 Não encontrei nenhum gasto para apagar neste mês.';
  }

  const msg = normalizeText(texto);
  const valorInformado = parseMoney((texto.match(/(?:R\$\s*)?\d+(?:[,.]\d{1,2})?/) || [])[0]);
  const isUltimo = /ultimo|último|desfazer|cancelar|errado|duplicado|repetido|ja tinha|já tinha/.test(msg);

  if (isUltimo && !valorInformado) {
    const ultimo = items.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0];

    await apagarGastoPorId(sessao, ultimo.id);

    return `🗑️ Apaguei:
*${ultimo.desc || 'Gasto'}* — ${fmt(ultimo.value)} (${ultimo.cat || 'Outros'})`;
  }

  let candidatos = [...items];

  if (valorInformado) {
    candidatos = candidatos.filter((i) => Math.abs(Number(i.value) - valorInformado) < 0.01);
  }

  const palavras = msg
    .replace(/apagar|deletar|excluir|remover|desfazer|cancelar|errado|lancei|valor|ja|já|tinha|pago|duplicado|repetido|ultimo|último/g, '')
    .replace(/\d+[,.]?\d*/g, '')
    .split(/\s+/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 3);

  if (palavras.length) {
    candidatos = candidatos.filter((i) => {
      const d = normalizeText(`${i.desc || ''} ${i.cat || ''}`);

      return palavras.some((p) => d.includes(p));
    });
  }

  if (!candidatos.length) {
    return `Não achei esse gasto.
Tente:
_apagar último_
_apagar 35_
_apagar mercado_`;
  }

  const escolhido = candidatos.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0];

  await apagarGastoPorId(sessao, escolhido.id);

  return `🗑️ Apaguei:
*${escolhido.desc || 'Gasto'}* — ${fmt(escolhido.value)} (${escolhido.cat || 'Outros'})`;
}

// ─── DETECTORES DE INTENÇÃO ───────────────────────────────
function isHelpCommand(s) {
  return ['ajuda', 'help', 'oi', 'olá', 'ola', 'menu', 'start', '/start'].includes(s);
}

function isSummaryCommand(s) {
  return ['resumo', 'extrato', 'total'].includes(s) || /quanto\s+(eu\s+)?gastei|gastos?\s+do\s+m[eê]s/i.test(s);
}

function isDeleteCommand(s) {
  return /^(apagar|deletar|excluir|remover|desfazer|cancelar)\b/i.test(s) ||
    /\b(errado|lancei errado|valor errado|já tinha pago|ja tinha pago|duplicado|repetido)\b/i.test(s);
}

function isParcelamento(s) {
  return /parcelei|parcelado|comprei parcelado/i.test(s);
}

// ─── WEBHOOK: PARSERS ─────────────────────────────────────
function getEvolutionMsg(body) {
  return (body?.data || body)?.message || {};
}

function getTextFromWebhook(body) {
  const z = body?.text?.message || body?.body || body?.message?.text;

  if (z) {
    return z;
  }

  const msg = getEvolutionMsg(body);

  return (
    msg?.conversation ||
    msg?.extendedTextMessage?.text ||
    msg?.imageMessage?.caption ||
    msg?.videoMessage?.caption ||
    ''
  );
}

function getPhoneFromWebhook(body) {
  const z = body?.phone || body?.sender;

  if (z) {
    return String(z).replace(/\D/g, '');
  }

  const data = body?.data || body;

  return String(data?.key?.remoteJid || data?.remoteJid || '')
    .replace('@s.whatsapp.net', '')
    .replace('@c.us', '')
    .replace(/\D/g, '');
}

function isFromMeWebhook(body) {
  return Boolean(body?.fromMe || (body?.data || body)?.key?.fromMe);
}

function isGroupWebhook(body) {
  if (body?.isGroup) {
    return true;
  }

  const jid = (body?.data || body)?.key?.remoteJid || (body?.data || body)?.remoteJid || '';

  return String(jid).includes('@g.us');
}

function getMessageId(body) {
  return body?.messageId || body?.zaapId || body?.id || body?.data?.key?.id || body?.key?.id;
}

function getMediaInfo(body) {
  const msg = getEvolutionMsg(body);
  const audioMsg = msg?.audioMessage || null;
  const imageMsg = msg?.imageMessage || null;

  const base64 = body?.base64 ||
    body?.data?.base64 ||
    msg?.base64 ||
    audioMsg?.base64 ||
    imageMsg?.base64 ||
    body?.data?.message?.base64;

  if (audioMsg) {
    return {
      type: 'audio',
      base64,
      mimeType: audioMsg?.mimetype || 'audio/ogg',
    };
  }

  if (imageMsg) {
    return {
      type: 'image',
      base64,
      mimeType: imageMsg?.mimetype || 'image/jpeg',
    };
  }

  return {
    type: null,
    base64: null,
    mimeType: null,
  };
}

// ─── PROCESSAR COM IA ─────────────────────────────────────
async function processarComIA(texto, sessao) {
  const resumo = await getResumoTexto(sessao.group, sessao.user);
  const hoje = todayIso();

  const system = `Você é o assistente financeiro do SalvaMoney, app de controle de gastos brasileiro.
WhatsApp: direto, amigável, português brasileiro informal. Emojis com moderação.

USUÁRIO: ${sessao.user} | GRUPO: ${sessao.group} | HOJE: ${hoje}
RESUMO DO MÊS: ${resumo}

CATEGORIAS PERMITIDAS:
Alimentação, Moradia, Transporte, Saúde, Lazer, Educação, Roupas, Academia, Outros.

REGRAS DE CATEGORIA:
- almoço, almocei, jantar, mercado, supermercado, ifood, padaria, lanche, restaurante, pizza, comida → Alimentação
- uber, 99, gasolina, posto, ônibus, passagem, estacionamento, táxi → Transporte
- farmácia, remédio, médico, consulta, exame, dentista → Saúde
- aluguel, luz, água, internet, condomínio, gás → Moradia
- netflix, spotify, cinema, bar, show, festa, ingresso → Lazer
- academia, musculação, gym, pilates → Academia
- curso, faculdade, escola, livro, aula → Educação
- roupa, camisa, calça, tênis, sapato → Roupas

RESPONDA APENAS JSON para ações, ou texto livre para conversa/dúvidas:
• Registrar:  {"acao":"registrar","desc":"...","valor":0.00,"cat":"...","data":"${hoje}"}
• Resumo:     {"acao":"resumo"}
• Apagar:     {"acao":"apagar","texto":"pedido original"}
• Parcelar:   {"acao":"parcelar","desc":"...","valor":0.00,"parcelas":12}

EXEMPLOS:
"almocei, gastei 30"       → {"acao":"registrar","desc":"almoço","valor":30.00,"cat":"Alimentação","data":"${hoje}"}
"almoço 35"                → {"acao":"registrar","desc":"almoço","valor":35.00,"cat":"Alimentação","data":"${hoje}"}
"paguei 150 no mercado"    → {"acao":"registrar","desc":"mercado","valor":150.00,"cat":"Alimentação","data":"${hoje}"}
"uber 22 conto"            → {"acao":"registrar","desc":"uber","valor":22.00,"cat":"Transporte","data":"${hoje}"}
"netflix 37"               → {"acao":"registrar","desc":"Netflix","valor":37.00,"cat":"Lazer","data":"${hoje}"}
"apagar último"            → {"acao":"apagar","texto":"apagar último"}
"lancei errado 50"         → {"acao":"apagar","texto":"lancei errado 50"}
"parcelei TV 1200 em 12x"  → {"acao":"parcelar","desc":"TV","valor":1200.00,"parcelas":12}

Nunca invente valores. Se não informou valor ao registrar, pergunte.`;

  const resposta = await chamarIA([
    { role: 'system', content: system },
    { role: 'user', content: texto },
  ]);

  try {
    const m = resposta.match(/\{[\s\S]*?\}/);

    if (!m) {
      throw new Error('sem json');
    }

    const json = JSON.parse(m[0]);

    if (json.acao === 'registrar') {
      return await registrarGasto(sessao, json, 'ia');
    }

    if (json.acao === 'resumo') {
      return await montarResumoFormatado(sessao);
    }

    if (json.acao === 'apagar') {
      return await apagarGastoPorTexto(sessao, json.texto || texto);
    }

    if (json.acao === 'parcelar') {
      return await registrarParcelamento(sessao, json);
    }
  } catch (_) {
    // Retorna texto livre da IA
  }

  return resposta;
}

// ─── PROCESSAR IMAGEM ─────────────────────────────────────
async function processarImagem(base64, mimeType, sessao) {
  if (!base64) {
    return '⚠️ Imagem recebida sem arquivo. Ative *webhookBase64* na Evolution API.';
  }

  const resposta = await analisarImagem(base64, mimeType);
  const m = resposta.match(/\{[\s\S]*?\}/);

  if (!m) {
    throw new Error('sem json na resposta de visão');
  }

  const json = JSON.parse(m[0]);

  if (!json.encontrou_gasto) {
    return 'Recebi a imagem, mas não encontrei um gasto claro. Tente mandar com legenda: _mercado 45,90_';
  }

  return await registrarGasto(sessao, {
    desc: json.desc,
    valor: Number(json.valor || 0),
    cat: json.cat,
    data: json.data,
  }, 'imagem');
}

// ─── MENSAGEM PRINCIPAL ───────────────────────────────────
async function processarMensagem(phone, texto, mediaInfo = null) {
  const msg = String(texto || '').trim();
  const msgMin = msg.toLowerCase();
  const sessao = await getSession(phone);

  // ── AJUDA ──
  if (isHelpCommand(msgMin)) {
    return [
      '💰 *SalvaMoney Bot*',
      '',
      'Para começar, você precisa vincular sua conta.',
      '',
      '👤 *Entrar em um grupo existente:*',
      '_entrar SEU NOME CODIGODOGRUPO_',
      '',
      'Exemplo:',
      '_entrar Carlos CASA2024_',
      '',
      '🆕 *Não tem código?*',
      'Digite:',
      '_criar código SEU NOME_',
      '',
      'Exemplo:',
      '_criar código Carlos_',
      '',
      '🔑 *Para que serve o código?*',
      'O código conecta sua conta do WhatsApp com o site.',
      'Ele também serve para dividir contas com outras pessoas.',
      'Se outra pessoa entrar no mesmo código que você, as contas divididas desse grupo ficarão visíveis para ela.',
      '',
      '📌 *Registrar gasto:*',
      '_almocei e gastei 35_',
      '_paguei 150 mercado_',
      '_netflix 37_',
      '',
      '💳 *Parcelamento:*',
      '_parcelei TV 1200 em 12x_',
      '',
      '🎙️ *Áudio:*',
      'Mande um áudio falando o gasto.',
      '',
      '🧾 *Foto:*',
      'Mande foto de comprovante ou nota fiscal.',
      '',
      '🗑️ *Apagar gasto:*',
      '_apagar último_',
      '_apagar 35_',
      '_lancei errado_',
      '',
      '📊 *Resumo:*',
      '_resumo_ ou _quanto gastei?_',
      '',
      '🌐 *Ver no site:*',
      SITE_URL,
      '',
      sessao
        ? `✅ Conta atual: *${sessao.user}* | Grupo: *${sessao.group}*`
        : '⚠️ Você ainda não vinculou uma conta.',
    ].join('\n');
  }

  // ── CRIAR CÓDIGO ──
  if (isCreateCodeCommand(msg)) {
    const nome = extrairNomeDoCriarCodigo(msg);

    return await criarCodigoGrupo(phone, nome);
  }

  // ── ENTRAR ──
  const matchEntrar = msg.match(/^entrar\s+(.+)\s+([A-Za-z0-9_-]+)$/i);

  if (matchEntrar) {
    const user = sanitizeKey(matchEntrar[1]);
    const group = sanitizeKey(matchEntrar[2].toUpperCase());

    if (!user || !group) {
      return '❌ Use: _entrar SEU NOME CODIGODOGRUPO_';
    }

    const snap = await get(ref(db, `grupos/${group}`));

    if (!snap.exists()) {
      return `❌ Grupo *${group}* não encontrado.

Verifique se o código está certo.

Se você ainda não tem um código, digite:
_criar código SEU NOME_

Exemplo:
_criar código Carlos_`;
    }

    await saveSession(phone, {
      user,
      group,
      updatedAt: todayIso(),
    });

    return `✅ Pronto! Você entrou como *${user}* no grupo *${group}*.

Agora você pode registrar gastos pelo WhatsApp.

Exemplos:
_"almocei e gastei 35"_
_"paguei 150 de mercado"_
_"quanto gastei esse mês?"_

🔑 Esse código também serve para dividir contas.
Se outra pessoa entrar no mesmo código, as contas divididas do grupo ficarão visíveis para ela.

🌐 Ver no site:
${SITE_URL}`;
  }

  // ── SEM SESSÃO ──
  if (!sessao) {
    return `⚠️ Para usar o SalvaMoney, primeiro vincule sua conta.

Se você já tem um código, digite:
_entrar SEU NOME CODIGODOGRUPO_

Exemplo:
_entrar João CASA2024_

Se você ainda não tem código, digite:
_criar código SEU NOME_

Exemplo:
_criar código João_

🔑 O código serve para conectar sua conta ao site e também para dividir contas com outras pessoas.

Se outra pessoa entrar no mesmo código que você, as contas divididas do grupo ficarão visíveis para ela.

🌐 Site:
${SITE_URL}`;
  }

  // ── ÁUDIO ──
  if (mediaInfo?.type === 'audio') {
    if (!mediaInfo.base64) {
      return '⚠️ Áudio recebido sem arquivo. Ative *webhookBase64* na Evolution API.';
    }

    try {
      const transcricao = await transcreverAudio(mediaInfo.base64, mediaInfo.mimeType);

      if (!transcricao) {
        return 'Não entendi o áudio. Fale o valor e a descrição com clareza.';
      }

      console.log(`🎙️ [${phone}] Transcrito: ${transcricao}`);

      return await processarMensagem(phone, transcricao, null);
    } catch (err) {
      console.error('Erro áudio:', err.message);

      return 'Erro ao processar áudio. Tente mandar em texto.';
    }
  }

  // ── IMAGEM ──
  if (mediaInfo?.type === 'image') {
    try {
      return await processarImagem(mediaInfo.base64, mediaInfo.mimeType, sessao);
    } catch (err) {
      console.error('Erro imagem:', err.message);

      return 'Não consegui ler a imagem. Tente mandar com legenda: _mercado 45,90_';
    }
  }

  // ── RESUMO ──
  if (isSummaryCommand(msgMin)) {
    return await montarResumoFormatado(sessao);
  }

  // ── APAGAR ──
  if (isDeleteCommand(msgMin)) {
    return await apagarGastoPorTexto(sessao, msg);
  }

  // ── PARCELAMENTO ──
  if (isParcelamento(msg)) {
    const parcela = parsearParcelamento(msg);

    if (parcela) {
      return await registrarParcelamento(sessao, parcela);
    }
  }

  // ── PARSER SIMPLES ──
  const gasto = parsearGasto(msg);

  if (gasto) {
    return await registrarGasto(sessao, {
      desc: gasto.desc,
      valor: gasto.valor,
      cat: detectarCategoria(gasto.desc),
      data: todayIso(),
    }, 'texto');
  }

  // ── IA ──
  if (GROQ_API_KEY) {
    try {
      return await processarComIA(msg, sessao);
    } catch (err) {
      console.error('Erro IA:', err.response?.data || err.message);
    }
  }

  return `🤔 Não entendi. Tente:
_gastei 50 almoço_
_35 uber_
_apagar último_

Ou *ajuda* para ver os comandos.`;
}

// ─── WEBHOOK ──────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body || {};

    if (body.event && body.event !== 'messages.upsert') {
      return;
    }

    if (isFromMeWebhook(body)) {
      return;
    }

    if (isGroupWebhook(body)) {
      return;
    }

    if (body.type && body.type !== 'ReceivedCallback') {
      return;
    }

    const phone = getPhoneFromWebhook(body);
    const texto = getTextFromWebhook(body);
    const messageId = getMessageId(body);
    const mediaInfo = getMediaInfo(body);

    if (!phone) {
      console.log('⚠️ Webhook sem phone:', JSON.stringify(body).slice(0, 300));

      return;
    }

    if (!texto && !mediaInfo?.type) {
      return;
    }

    if (isRateLimited(phone)) {
      return;
    }

    console.log(`📩 [${phone}] ${texto || `[${mediaInfo.type}]`}`);

    const resposta = await processarMensagem(phone, texto, mediaInfo);

    if (resposta) {
      await sendMessage(phone, resposta, messageId);
    }
  } catch (err) {
    console.error('Erro no webhook:', err);
  }
});

// ─── DASHBOARD API ────────────────────────────────────────
app.get('/api/dashboard', async (req, res) => {
  try {
    const phone = String(req.query.phone || req.query.numero || '').replace(/\D/g, '');

    if (!phone) {
      return res.status(400).json({
        ok: false,
        error: 'Informe o telefone. Ex: ?phone=5541999999999',
      });
    }

    const sessao = await getSession(phone);

    if (!sessao) {
      return res.status(404).json({
        ok: false,
        error: 'Telefone não vinculado. Use _entrar NOME GRUPO_ no WhatsApp.',
      });
    }

    const items = await getGastosMesComIds(sessao.group, sessao.user);
    const total = items.reduce((a, e) => a + Number(e.value || 0), 0);
    const porCat = {};
    const porDia = {};

    items.forEach((e) => {
      const cat = e.cat || 'Outros';
      const date = e.date || 'Sem data';

      porCat[cat] = (porCat[cat] || 0) + Number(e.value || 0);
      porDia[date] = (porDia[date] || 0) + Number(e.value || 0);
    });

    return res.json({
      ok: true,
      sessao,
      mes: MESES[Number(dateParts().month) - 1],
      total,
      porCat,
      porDia,
      ultimos: items
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
        .slice(0, 20)
        .map((e) => ({
          id: e.id,
          desc: e.desc || 'Gasto',
          value: Number(e.value || 0),
          cat: e.cat || 'Outros',
          date: e.date || '',
          createdAt: e.createdAt || '',
          origem: e.origem || 'texto',
        })),
    });
  } catch (err) {
    console.error('Erro dashboard API:', err);

    return res.status(500).json({
      ok: false,
      error: 'Erro interno.',
    });
  }
});

// ─── APAGAR VIA API ───────────────────────────────────────
app.delete('/api/gasto/:id', async (req, res) => {
  try {
    const phone = String(req.query.phone || '').replace(/\D/g, '');

    if (!phone) {
      return res.status(400).json({
        ok: false,
        error: 'Informe o phone.',
      });
    }

    const sessao = await getSession(phone);

    if (!sessao) {
      return res.status(404).json({
        ok: false,
        error: 'Sessão não encontrada.',
      });
    }

    const { id } = req.params;

    await remove(ref(db, `grupos/${sessao.group}/usuarios/${sessao.user}/gastos/${monthKey()}/${id}`));

    return res.json({ ok: true });
  } catch (err) {
    console.error('Erro ao apagar gasto via API:', err);

    return res.status(500).json({
      ok: false,
      error: 'Erro interno.',
    });
  }
});

// ─── DASHBOARD UI ─────────────────────────────────────────
app.get('/dashboard', (_, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>SalvaMoney Dashboard</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#0a1628;color:#f0f4ff;min-height:100vh}
header{background:#0f2040;border-bottom:1px solid rgba(255,255,255,.1);padding:18px 24px;display:flex;align-items:center;gap:12px}
header h1{font-size:1.1rem;color:#00c896;font-weight:700}
header p{color:#8ba0cc;font-size:.8rem;margin-left:auto}
main{max-width:960px;margin:0 auto;padding:24px 16px}
.card{background:#1a3060;border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:20px;margin-bottom:16px}
h2{font-size:.8rem;color:#8ba0cc;text-transform:uppercase;letter-spacing:.6px;margin-bottom:14px}
.total{font-size:2.2rem;font-weight:700;color:#00c896;margin:4px 0}
.sub{font-size:.78rem;color:#8ba0cc;margin-bottom:4px}
input{width:100%;background:#0f2040;border:1px solid rgba(255,255,255,.18);border-radius:8px;color:#f0f4ff;padding:10px 14px;font-size:.9rem;margin-bottom:10px;outline:none}
input:focus{border-color:#00c896}
button{background:#00c896;color:#03120e;border:none;border-radius:8px;padding:10px 22px;font-size:.88rem;font-weight:700;cursor:pointer;transition:opacity .15s}
button:hover{opacity:.88}
.btn-sm{background:transparent;color:#ff6b6b;border:1px solid rgba(255,107,107,.35);padding:4px 10px;font-size:.75rem;border-radius:6px;cursor:pointer}
.btn-sm:hover{background:rgba(255,107,107,.12)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}
.cat-item{background:#0f2040;border-radius:10px;padding:12px}
.cat-name{font-size:.8rem;color:#8ba0cc;margin-bottom:4px}
.cat-val{font-weight:700;color:#f0f4ff;margin-bottom:6px;font-size:.95rem}
.bar{height:5px;background:rgba(255,255,255,.1);border-radius:3px;overflow:hidden}
.bar-inner{height:100%;background:#00c896;border-radius:3px;transition:width .5s}
table{width:100%;border-collapse:collapse;font-size:.83rem}
th{color:#8ba0cc;font-size:.7rem;text-transform:uppercase;letter-spacing:.5px;padding:8px;border-bottom:1px solid rgba(255,255,255,.1);text-align:left}
td{padding:10px 8px;border-bottom:1px solid rgba(255,255,255,.05)}
.origem{display:inline-block;font-size:.65rem;background:rgba(0,200,150,.12);color:#00c896;border-radius:4px;padding:1px 5px}
.err{color:#ff6b6b;font-size:.8rem;margin-top:6px}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.row input{margin-bottom:0;flex:1;min-width:200px}
.hidden{display:none}
</style>
</head>
<body>
<header><h1>💰 SalvaMoney</h1><p>Dashboard de gastos</p></header>
<main>
  <div class="card">
    <h2>Entrar</h2>
    <p class="sub" style="margin-bottom:10px">Digite o telefone com DDI+DDD. Ex: 5521999999999</p>
    <div class="row">
      <input id="phone" placeholder="Telefone WhatsApp"/>
      <button onclick="carregar()">Carregar</button>
    </div>
    <p id="erro" class="err"></p>
  </div>

  <div id="resumo-card" class="card hidden">
    <h2 id="tituloMes">Resumo</h2>
    <p class="sub" id="conta"></p>
    <div class="total" id="total">R$ 0,00</div>
  </div>

  <div id="cats-card" class="card hidden">
    <h2>Por categoria</h2>
    <div id="categorias" class="grid"></div>
  </div>

  <div id="ultimos-card" class="card hidden">
    <h2>Últimos gastos</h2>
    <div id="ultimos"></div>
  </div>
</main>

<script>
const params = new URLSearchParams(location.search);
const phoneParam = params.get('phone') || '';
document.getElementById('phone').value = phoneParam;

function moeda(v) {
  return Number(v||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
}

async function carregar() {
  const phone = document.getElementById('phone').value.trim();
  const erro = document.getElementById('erro');
  erro.textContent = '';

  if (!phone) {
    erro.textContent = 'Digite o telefone.';
    return;
  }

  const r = await fetch('/api/dashboard?phone=' + encodeURIComponent(phone));
  const dados = await r.json();

  if (!dados.ok) {
    erro.textContent = dados.error || 'Erro ao carregar.';
    return;
  }

  document.getElementById('tituloMes').textContent = 'Resumo de ' + dados.mes;
  document.getElementById('conta').textContent = dados.sessao.user + ' · Grupo ' + dados.sessao.group;
  document.getElementById('total').textContent = moeda(dados.total);

  ['resumo-card','cats-card','ultimos-card'].forEach(id => {
    document.getElementById(id).classList.remove('hidden');
  });

  const cats = Object.entries(dados.porCat||{}).sort((a,b)=>b[1]-a[1]);
  const maior = cats.length ? cats[0][1] : 1;

  document.getElementById('categorias').innerHTML = cats.map(([c,v]) =>
    '<div class="cat-item"><div class="cat-name">'+c+'</div><div class="cat-val">'+moeda(v)+'</div>' +
    '<div class="bar"><div class="bar-inner" style="width:'+Math.round(v/maior*100)+'%"></div></div></div>'
  ).join('') || '<p style="color:#8ba0cc">Nenhum gasto.</p>';

  renderTabela(dados.ultimos, phone);
}

function renderTabela(ultimos, phone) {
  if (!ultimos.length) {
    document.getElementById('ultimos').innerHTML = '<p style="color:#8ba0cc">Nenhum gasto.</p>';
    return;
  }

  document.getElementById('ultimos').innerHTML =
    '<table><thead><tr><th>Data</th><th>Descrição</th><th>Categoria</th><th>Origem</th><th>Valor</th><th></th></tr></thead><tbody>' +
    ultimos.map(i =>
      '<tr><td>'+i.date+'</td><td>'+i.desc+'</td><td>'+i.cat+'</td>' +
      '<td><span class="origem">'+i.origem+'</span></td>' +
      '<td>'+moeda(i.value)+'</td>' +
      '<td><button class="btn-sm" onclick="apagar(\\''+i.id+'\\',\\''+encodeURIComponent(phone)+'\\')">Apagar</button></td></tr>'
    ).join('') + '</tbody></table>';
}

async function apagar(id, phoneEnc) {
  if (!confirm('Apagar este gasto?')) return;

  const r = await fetch('/api/gasto/'+id+'?phone='+phoneEnc, { method: 'DELETE' });
  const d = await r.json();

  if (d.ok) carregar();
  else alert(d.error || 'Erro ao apagar.');
}

if (phoneParam) carregar();
</script>
</body>
</html>`);
});

// ─── HOME / HEALTH ────────────────────────────────────────
app.get('/', (_, res) => res.json({
  status: 'ok',
  bot: 'SalvaMoney',
  version: '5.1.0',
  provider: WHATSAPP_PROVIDER,
  site: SITE_URL,
  features: {
    text: true,
    audio: Boolean(GROQ_API_KEY),
    image: Boolean(GROQ_API_KEY),
    parcelamento: true,
    apagar: true,
    dashboard: true,
    deleteViaApi: true,
    criarCodigo: true,
    siteLink: true,
  },
}));

app.get('/health', (_, res) => {
  res.json({
    ok: true,
    ts: new Date().toISOString(),
  });
});

// ─── GRACEFUL SHUTDOWN ────────────────────────────────────
process.on('SIGTERM', () => {
  console.log('🛑 Encerrando...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('🛑 Encerrando...');
  process.exit(0);
});

// ─── START ────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 SalvaMoney v5.1 · porta ${PORT} · provider: ${WHATSAPP_PROVIDER}`);
  console.log(`🌐 Site: ${SITE_URL}`);

  if (GROQ_API_KEY) {
    console.log('✅ Groq AI ativado (texto + áudio + imagem)');
  } else {
    console.log('⚠️ Groq AI desativado (só parser simples)');
  }
});
