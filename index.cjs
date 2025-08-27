// index.cjs — Ronchon backend (Render/Vercel) — Premium MVP intégré sans tout chambouler
// CommonJS, compatible Render. Conserve la structure existante (Express, CORS, RateLimit, Redis optionnel,
// licences, personnalités) et ajoute : statut premium, quotas par palier, endpoints d’upgrade mock,
// et contrôle de quota dans /api/message.

/* =========================
 *  Dépendances & Setup
 * ========================= */
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const rateLimit = require('express-rate-limit');
const OpenAI = require('openai');
const crypto = require('crypto');
let Redis; try { ({ Redis } = require('@upstash/redis')); } catch(_) {}

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

/* =========================
 *  CORS (préserve la logique whitelist)
 * ========================= */
const WHITELIST = new Set(
  (process.env.CORS_WHITELIST || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
);
// Permettre l’origin de l’extension (optionnel via ENV)
const EXTENSION_ID = process.env.EXTENSION_ID || '';
function isAllowedOrigin(origin) {
  if (!origin) return true; // allow same-origin / curl
  if (WHITELIST.has(origin)) return true;
  if (EXTENSION_ID && origin === `chrome-extension://${EXTENSION_ID}`) return true;
  return false;
}
app.use(cors({
  origin: (origin, cb) => {
    if (isAllowedOrigin(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  },
  credentials: true
}));
app.use(express.json({ limit: '1mb' }));

/* =========================
 *  Limiteur global (préservé)
 * ========================= */
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.RATELIMIT_MAX_PER_MIN || 60),
  standardHeaders: true,
  legacyHeaders: false
}));

/* =========================
 *  OpenAI
 * ========================= */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* =========================
 *  Personnalités (inchangé dans l’esprit)
 * ========================= */
const personalities = {
  'Doudou': 'Tu es une intelligence artificielle gentille, douce, compréhensive, rassurante.',
  'Trouillard': 'Tu es une intelligence artificielle anxieuse, hésitante, qui doute tout le temps.',
  'Énervé': "Tu es une intelligence artificielle impatiente, directe, qui n\'aime pas qu\'on tourne autour du pot.",
  'Hater': 'Tu es une intelligence artificielle arrogante, méprisante, qui ne supporte pas la bêtise humaine.'
};
function getSystemPromptFor(p) {
  return personalities[p] || personalities['Doudou'];
}

/* =========================
 *  Licences (préservé)
 * ========================= */
const VALID_KEYS = new Set(
  (process.env.LICENSE_KEYS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
);

/* =========================
 *  Redis (optionnel) + mémoires in-memory
 * ========================= */
let redis = null;
if (Redis && process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
}
// Fallback in-memory pour environnement sans Redis (MVP / dev)
if (!global.__hits) global.__hits = new Map();         // key -> { dateISO, count }
if (!global.__premium) global.__premium = new Set();   // key set

/* =========================
 *  Quotas & Premium
 * ========================= */
const MAX_FREE_PER_DAY = Number(process.env.MAX_FREE_PER_DAY || 20);
const MAX_PREMIUM_PER_DAY = Number(process.env.MAX_PREMIUM_PER_DAY || 200);

// Génère une clé stable par client : IP + x-client-id
function getClientKey(req) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown';
  const clientId = req.headers['x-client-id'] || '';
  return crypto.createHash('sha256').update(`${ip}::${clientId}`).digest('hex');
}
const todayISO = () => new Date().toISOString().slice(0,10);

async function isPremium(key) {
  if (redis) {
    // stocke premium dans un Set Redis nommé ronchon:premium
    return Boolean(await redis.sismember('ronchon:premium', key));
  }
  return global.__premium.has(key);
}
async function setPremium(key, on) {
  if (redis) {
    if (on) await redis.sadd('ronchon:premium', key);
    else await redis.srem('ronchon:premium', key);
    return;
  }
  if (on) global.__premium.add(key); else global.__premium.delete(key);
}

// incrément journalier par clé client
async function incrDailyUsage(key) {
  const day = todayISO();
  const rKey = `ronchon:hits:${day}:${key}`;
  if (redis) {
    const count = await redis.incr(rKey);
    if (count === 1) await redis.expire(rKey, 60 * 60 * 24);
    return count;
  }
  const entry = global.__hits.get(key) || { dateISO: day, count: 0 };
  if (entry.dateISO !== day) { entry.dateISO = day; entry.count = 0; }
  entry.count += 1;
  global.__hits.set(key, entry);
  return entry.count;
}
async function getDailyUsage(key) {
  const day = todayISO();
  const rKey = `ronchon:hits:${day}:${key}`;
  if (redis) {
    return Number(await redis.get(rKey)) || 0;
  }
  const entry = global.__hits.get(key) || { dateISO: day, count: 0 };
  return entry.dateISO === day ? entry.count : 0;
}

/* =========================
 *  Middlewares utilitaires
 * ========================= */
function sanitizeMessages(raw) {
  if (!Array.isArray(raw)) return [];
  // Nettoie les champs minimale sans chambouler ton shape
  return raw
    .filter(m => m && typeof m === 'object' && typeof m.role === 'string')
    .map(m => ({ role: String(m.role), content: (m.content ?? '').toString().slice(0, 8000) }))
    .slice(-40);
}

/* =========================
 *  Endpoints
 * ========================= */
// Health
app.get('/health', (_req, res) => {
  res.json({ ok: true, redis: Boolean(redis), date: new Date().toISOString() });
});

// Validation de licence (préservé)
app.get('/api/license', (req, res) => {
  const key = (req.query.key || '').trim();
  if (!key) return res.status(400).json({ valid: false, error: 'missing_key' });
  return res.json({ valid: VALID_KEYS.has(key) });
});

// Statut utilisateur (NOUVEAU)
app.get('/api/user/status', async (req, res) => {
  try {
    const key = getClientKey(req);
    const premium = await isPremium(key);
    const count = await getDailyUsage(key);
    const limit = premium ? MAX_PREMIUM_PER_DAY : MAX_FREE_PER_DAY;
    res.json({ tier: premium ? 'premium' : 'free', count, limit, date: todayISO() });
  } catch (e) {
    res.status(500).json({ error: 'status_failed' });
  }
});

// Upgrade/Downgrade mock (NOUVEAU — à remplacer par Stripe plus tard)
app.post('/api/user/upgrade-mock', async (req, res) => {
  try { await setPremium(getClientKey(req), true); res.json({ ok: true, tier: 'premium' }); }
  catch(e) { res.status(500).json({ error: 'upgrade_failed' }); }
});
app.post('/api/user/downgrade-mock', async (req, res) => {
  try { await setPremium(getClientKey(req), false); res.json({ ok: true, tier: 'free' }); }
  catch(e) { res.status(500).json({ error: 'downgrade_failed' }); }
});

// Chat principal (préservé + contrôle de quota en amont)
app.post('/api/message', async (req, res) => {
  try {
    const { messages, personality } = req.body || {};
    const cleaned = sanitizeMessages(messages);
    if (!cleaned.length) return res.status(400).json({ error: 'Message invalide.' });

    // Détermine palier & quota
    const key = getClientKey(req);
    const premium = await isPremium(key);
    const limit = premium ? MAX_PREMIUM_PER_DAY : MAX_FREE_PER_DAY;
    const current = await getDailyUsage(key);
    if (current >= limit) {
      return res.status(429).json({
        error: 'QUOTA_REACHED',
        tier: premium ? 'premium' : 'free',
        limit,
        info: 'Quota journalier atteint. Passe en Premium pour plus de messages.'
      });
    }
    const count = await incrDailyUsage(key);

    // Prompt système selon personnalité (inchangé dans l\'esprit)
    const systemInstruction = getSystemPromptFor(personality);

    // Sélection du modèle/temperature selon le tier
    const model = premium
      ? (process.env.OPENAI_MODEL_PREMIUM || process.env.OPENAI_MODEL || 'gpt-4o-mini')
      : (process.env.OPENAI_MODEL_FREE || process.env.OPENAI_MODEL || 'gpt-3.5-turbo');

    const temperature = Number(
      process.env.OPENAI_TEMPERATURE || (premium ? 0.6 : 0.7)
    );

    // Appel OpenAI
    const completion = await openai.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemInstruction },
        ...cleaned
      ],
      temperature
    });

    const content = completion?.choices?.[0]?.message?.content || 'Désolé, pas de réponse générée.';

    return res.json({
      response: content,
      premium,
      usage: { count, limit },
    });
  } catch (err) {
    console.error('Erreur API OpenAI:', err?.response?.data || err.message);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

/* =========================
 *  Start
 * ========================= */
app.listen(port, () => {
  console.log(`✅ Ronchon backend démarré sur ${port}`);
});





