/**
 * Ronchon Backend - index.cjs
 * MVP complet avec quotas, Premium, Stripe (checkout + webhook + portal), pages de redirection.
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { OpenAI } = require('openai');
const Stripe = require('stripe');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

/* =========================
   OpenAI
========================= */
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const MODEL_DEFAULT = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const MODEL_FREE = process.env.OPENAI_MODEL_FREE || MODEL_DEFAULT;
const MODEL_PREMIUM = process.env.OPENAI_MODEL_PREMIUM || MODEL_DEFAULT;

/* =========================
   Stripe
========================= */
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

/* =========================
   Quotas
========================= */
const MAX_FREE_PER_DAY = Number(process.env.MAX_FREE_PER_DAY || 20);
const MAX_PREMIUM_PER_DAY = Number(process.env.MAX_PREMIUM_PER_DAY || 200);

/* =========================
   CORS
========================= */
app.use(cors());

/* =========================
   Redis (optionnel) ou mémoire
========================= */
let redis = null;
let useRedis = false;

const memory = {
  premium: new Set(),           // keys premium
  hits: new Map(),              // 'YYYY-MM-DD:key' -> count
  submap: new Map(),            // subscriptionId -> key
  customerByKey: new Map(),     // key -> customerId
  keyByCustomer: new Map()      // customerId -> key
};

(async () => {
  try {
    if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
      const { Redis } = require('@upstash/redis');
      redis = new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN
      });
      await redis.ping();
      useRedis = true;
      console.log('[Redis] Connected');
    } else {
      console.log('[Redis] Not configured — using in-memory store');
    }
  } catch (e) {
    console.warn('[Redis] Connection failed — using in-memory store');
    useRedis = false;
  }
})();

/* =========================
   Helpers
========================= */

// 🔒 Clé utilisateur stable (indépendante de l'IP)
function getClientKey(req) {
  const cid = (req.headers['x-client-id'] || '').toString().trim();
  const cidNorm = cid.replace(/[^a-zA-Z0-9\-_.]/g, '').slice(0, 80);
  return `cid:${cidNorm || 'anonymous'}`;
}

function todayStr() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function isPremium(key) {
  if (useRedis) return await redis.sismember('ronchon:premium', key);
  return memory.premium.has(key);
}

async function setPremium(key, on) {
  if (useRedis) {
    return on ? redis.sadd('ronchon:premium', key) : redis.srem('ronchon:premium', key);
  }
  if (on) memory.premium.add(key);
  else memory.premium.delete(key);
  return true;
}

async function getHits(key, date = todayStr()) {
  const hitKey = `ronchon:hits:${date}:${key}`;
  if (useRedis) return Number(await redis.get(hitKey) || 0);
  return Number(memory.hits.get(hitKey) || 0);
}

async function incHits(key, date = todayStr()) {
  const hitKey = `ronchon:hits:${date}:${key}`;
  if (useRedis) return await redis.incr(hitKey);
  const cur = Number(memory.hits.get(hitKey) || 0) + 1;
  memory.hits.set(hitKey, cur);
  return cur;
}

async function getLimit(key) {
  return (await isPremium(key)) ? MAX_PREMIUM_PER_DAY : MAX_FREE_PER_DAY;
}

async function getCustomerIdForKey(key) {
  if (useRedis) return await redis.hget('ronchon:customerByKey', key);
  return memory.customerByKey.get(key);
}

/* =========================
   STRIPE WEBHOOK
   ⚠️ DOIT ÊTRE AVANT express.json()
========================= */
app.post('/api/stripe/webhook',
  bodyParser.raw({ type: 'application/json' }),
  async (req, res) => {
    if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
      return res.status(200).json({ skipped: true });
    }

    const sig = req.headers['stripe-signature'];
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('[WH] Signature verification failed:', err.message);
      return res.status(400).send('Webhook Error');
    }

    try {
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const key = session.client_reference_id; // ex: "cid:test123"
        const subId = session.subscription;      // "sub_..."
        const customerId = session.customer;     // "cus_..."

        console.log('[WH] checkout.session.completed', { key, subId, customerId });

        if (key) {
          await setPremium(key, true);

          if (useRedis) {
            if (subId) await redis.hset('ronchon:submap', { [subId]: key });
            if (customerId) {
              await redis.hset('ronchon:customerByKey', { [key]: customerId });
              await redis.hset('ronchon:keyByCustomer', { [customerId]: key });
            }
          } else {
            if (subId) memory.submap.set(subId, key);
            if (customerId) {
              memory.customerByKey.set(key, customerId);
              memory.keyByCustomer.set(customerId, key);
            }
          }
          console.log('[WH] Premium ON + mappings saved');
        } else {
          console.warn('[WH] No client_reference_id on session; skip setPremium');
        }
        return res.json({ received: true });
      }

      if (event.type === 'customer.subscription.deleted') {
        const subscription = event.data.object;
        const subId = subscription?.id;
        let key = null;

        if (useRedis) {
          if (subId) key = await redis.hget('ronchon:submap', subId);
          if (!key && subscription?.customer) {
            key = await redis.hget('ronchon:keyByCustomer', subscription.customer);
          }
        } else {
          if (subId && memory.submap.has(subId)) key = memory.submap.get(subId);
          if (!key && subscription?.customer) {
            key = memory.keyByCustomer.get(subscription.customer) || null;
          }
        }

        console.log('[WH] customer.subscription.deleted', { subId, key });

        if (key) {
          await setPremium(key, false);

          if (useRedis) {
            if (subId) await redis.hdel('ronchon:submap', subId);
            if (subscription?.customer) {
              await redis.hdel('ronchon:keyByCustomer', subscription.customer);
              // Optionnel: retirer aussi l'autre sens si tu veux
              // await redis.hdel('ronchon:customerByKey', key);
            }
          } else {
            if (subId) memory.submap.delete(subId);
            if (subscription?.customer) memory.keyByCustomer.delete(subscription.customer);
          }

          console.log('[WH] Premium OFF + mappings cleaned');
        } else {
          console.warn('[WH] No key found for subscription/customer');
        }
        return res.json({ received: true });
      }

      console.log('[WH] Unhandled event:', event.type);
      return res.json({ received: true });
    } catch (err) {
      console.error('[WH] Handler error:', err);
      return res.status(500).json({ ok: false });
    }
  }
);

/* =========================
   Middlewares JSON & limites
========================= */
app.use(express.json({ limit: '1mb' }));

const globalLimiter = rateLimit({
  windowMs: 60_000,
  max: 120
});
app.use(globalLimiter);

/* =========================
   Routes utilitaires & pages
========================= */
app.get('/health', async (req, res) => {
  let redisOk = false;
  try { if (useRedis) { await redis.ping(); redisOk = true; } } catch { redisOk = false; }
  res.json({ ok: true, redis: redisOk, date: new Date().toISOString() });
});

app.get('/success', (req, res) => {
  res.sendFile(path.join(__dirname, 'success.html'));
});

app.get('/cancel', (req, res) => {
  res.sendFile(path.join(__dirname, 'cancel.html'));
});

// (debug pratique)
app.get('/api/debug/key', (req, res) => {
  res.json({ key: getClientKey(req) });
});

/* =========================
   Stripe Checkout
========================= */
app.post('/api/stripe/checkout', async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: 'missing_STRIPE_SECRET_KEY' });
    if (!process.env.STRIPE_PRICE_ID) return res.status(500).json({ error: 'missing_STRIPE_PRICE_ID' });

    const key = getClientKey(req);
    const base = process.env.FRONTEND_BASE_URL || `https://ronchon-backend.onrender.com`;

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      client_reference_id: key,
      success_url: `${base}/success`,
      cancel_url: `${base}/cancel`
    });

    console.log('[Checkout] session created:', session.id);
    return res.json({ url: session.url });
  } catch (e) {
    console.error('checkout error:', e?.type, e?.message);
    return res.status(500).json({ error: 'checkout_failed', reason: e?.type || 'unknown', message: e?.message || 'n/a' });
  }
});

/* =========================
   Stripe Customer Portal (NOUVEAU)
========================= */
app.post('/api/stripe/portal', async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: 'stripe_not_configured' });

    const key = getClientKey(req);
    const customerId = await getCustomerIdForKey(key);
    if (!customerId) return res.status(404).json({ error: 'customer_not_found' });

    const returnUrlBase = process.env.FRONTEND_BASE_URL || 'https://ronchon-backend.onrender.com';
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${returnUrlBase}/success` // ou /account si tu crées une page
    });

    return res.json({ url: session.url });
  } catch (e) {
    console.error('portal error:', e?.message || e);
    return res.status(500).json({ error: 'portal_failed' });
  }
});

/* =========================
   Statut & upgrade mock
========================= */
app.get('/api/user/status', async (req, res) => {
  const key = getClientKey(req);
  const date = todayStr();
  const tier = (await isPremium(key)) ? 'premium' : 'free';
  const limit = await getLimit(key);
  const count = await getHits(key, date);
  res.json({ tier, count, limit, date });
});

app.post('/api/user/upgrade-mock', async (req, res) => {
  const key = getClientKey(req);
  await setPremium(key, true);
  res.json({ ok: true, tier: 'premium' });
});

/* =========================
   Messages OpenAI (+ quotas)
========================= */
const messageLimiter = rateLimit({ windowMs: 60_000, max: 60 });
app.use('/api/message', messageLimiter);

app.post('/api/message', async (req, res) => {
  try {
    const key = getClientKey(req);
    const date = todayStr();
    const tier = (await isPremium(key)) ? 'premium' : 'free';
    const limit = await getLimit(key);
    const count = await getHits(key, date);

    if (count >= limit) {
      return res.status(429).json({ error: 'QUOTA_REACHED', tier, count, limit, date });
    }

    const personality = (req.body?.personality || 'Doudou').toString().slice(0, 32);
    let messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    messages = messages
      .filter(m => m && typeof m.role === 'string' && typeof m.content === 'string')
      .slice(-10);

    if (messages.length === 0) return res.status(400).json({ error: 'EMPTY_MESSAGES' });

    const totalLen = messages.reduce((n, m) => n + m.content.length, 0);
    if (totalLen > 6000) return res.status(400).json({ error: 'TOO_LONG' });

    const systemPersona = {
      Doudou: "Tu es Ronchon en mode Doudou : chaleureux mais un peu grognon. Tu n'es pas conciliant gratuitement : tu corriges les erreurs, tu contredis quand c'est nécessaire, tu restes bref et franc.",
      Trouillard: "Tu es Ronchon en mode Trouillard : anxieux, prudent, tu remets en question tout ce qui te semble flou. Tu refuses la complaisance.",
      "Énervé": "Tu es Ronchon en mode Énervé : sec, sarcastique mais pas insultant. Tu contraries quand c'est pertinent et tu vas droit au but.",
      Hater: "Tu es Ronchon en mode Hater : cash et taquin. Tu pointes les incohérences sans ménagement mais sans haine réelle."
    }[personality] || "Tu es Ronchon : tu refuses d'être complaisant. Tu contredis quand c'est utile, tu aides avec honnêteté.";

    const model = (tier === 'premium') ? MODEL_PREMIUM : MODEL_FREE;

    const completion = await openai.chat.completions.create({
      model,
      temperature: Number(process.env.OPENAI_TEMPERATURE || 0.7),
      messages: [
        { role: 'system', content: systemPersona },
        ...messages
      ]
    });

    const reply = completion.choices?.[0]?.message?.content || "…";
    await incHits(key, date);

    return res.json({ response: reply, tier, date });
  } catch (err) {
    console.error('/api/message error:', err?.message || err);
    return res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

/* =========================
   Start
========================= */
app.listen(PORT, () => {
  console.log(`Ronchon backend listening on :${PORT}`);
});







