// index.cjs — Ronchon backend (Render) CommonJS propre

const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const OpenAI = require('openai');
const rateLimit = require('express-rate-limit');
const { Redis } = require('@upstash/redis');

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

/* ---------- CORS ---------- */
const WHITELIST = new Set([
  // ID d’extension (optionnel via ENV)
  process.env.EXTENSION_ID ? `chrome-extension://${process.env.EXTENSION_ID}` : null,
  'chrome-extension://mbfcngdankjjdmdkflfpgnfeeoijpddn',
  'http://localhost:5173',
  'https://ronchon.com'
].filter(Boolean));

const corsOptions = {
  origin(origin, cb) {
    // Autorise aussi l’absence d’origin (curl/healthchecks)
    if (!origin || WHITELIST.has(origin)) return cb(null, true);
    return cb(new Error(`Origin not allowed: ${origin}`), false);
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  optionsSuccessStatus: 204
};
app.use(cors(corsOptions));

/* ---------- Préflights / Body / Rate-limit ---------- */
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '200kb' }));
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false
}));

/* ---------- OpenAI ---------- */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ---------- Personnalités ---------- */
const personalities = {
  'Doudou': 'Tu es une intelligence artificielle gentille, douce, compréhensive, rassurante.',
  'Trouillard': 'Tu es une intelligence artificielle anxieuse, hésitante, qui doute tout le temps.',
  'Énervé': "Tu es une intelligence artificielle impatiente, directe, qui n'aime pas qu'on tourne autour du pot.",
  'Hater': 'Tu es une intelligence artificielle arrogante, méprisante, qui ne supporte pas la bêtise humaine.'
};
function getSystemPromptFor(p) {
  return personalities[p] || personalities['Doudou'];
}

/* ---------- Licences + Quota ---------- */
const VALID_KEYS = new Set(
  (process.env.LICENSE_KEYS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
);
const MAX_FREE = Number(process.env.MAX_FREE_PER_DAY || 20);

function isPremiumFromReq(req) {
  const k = (req.headers['x-license-key'] || '').trim();
  return VALID_KEYS.has(k);
}

/* ---------- Redis (Upstash) pour quota (optionnel) ---------- */
const redis =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN
      })
    : null;

function todayISO() { return new Date().toISOString().slice(0, 10); }
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || req.ip || '')
    .toString()
    .split(',')[0]
    .trim();
}
function hitsKey(req) { return `hits:${clientIp(req)}:${todayISO()}`; }

// Fallback mémoire si pas de Redis
global.__hits = global.__hits || new Map();

async function incHit(req) {
  if (!redis) {
    const k = hitsKey(req);
    const n = (global.__hits.get(k) || 0) + 1;
    global.__hits.set(k, n);
    return n;
    }
  const key = hitsKey(req);
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 60 * 60 * 24);
  return count;
}

async function currentHits(req) {
  if (!redis) return global.__hits.get(hitsKey(req)) || 0;
  return Number(await redis.get(hitsKey(req))) || 0;
}

/* ---------- Endpoints ---------- */

// Healthcheck
app.get('/health', (_req, res) => {
  res.json({ ok: true, redis: !!redis, date: new Date().toISOString() });
});

// Validation de licence
app.get('/api/license', (req, res) => {
  const key = (req.query.key || '').trim();
  if (!key) return res.status(400).json({ valid: false, error: 'missing_key' });
  return res.json({ valid: VALID_KEYS.has(key) });
});

// Chat principal
app.post('/api/message', async (req, res) => {
  try {
    const { messages, personality } = req.body;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Messages invalides.' });
    }

    const premium = isPremiumFromReq(req);
    const licenseHeader = (req.headers['x-license-key'] || '').trim();
    console.log(`🔑 Licence ${premium ? 'valide' : 'invalide'} reçue: ${licenseHeader || '(vide)'}`);

    if (!premium) {
      const used = await currentHits(req);
      if (used >= MAX_FREE) {
        return res.status(429).json({
          error: 'Quota gratuit atteint. Passe en premium pour continuer.',
          premium: false,
          quota: { used, limit: MAX_FREE }
        });
      }
      await incHit(req);
    }

    // Filtre de sécurité et coupe du contexte
    const cleaned = (messages || [])
      .filter(m => m && (m.role === 'user' || m.role === 'assistant'))
      .slice(-20);

    const systemInstruction = getSystemPromptFor(personality);

    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: systemInstruction },
        ...cleaned
      ],
      temperature: 0.7
    });

    const content =
      completion?.choices?.[0]?.message?.content || 'Désolé, pas de réponse générée.';

    return res.json({ response: content, premium });
  } catch (err) {
    console.error('Erreur API OpenAI:', err?.response?.data || err.message);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

/* ---------- Start ---------- */
app.listen(port, () => {
  console.log(`✅ Ronchon backend sur ${port}`);
});








