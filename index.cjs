// index.cjs — corrigé sans rien casser, avec Stripe webhooks fiables
// - Fix: raw body pour webhook + condition startsWith()
// - Ajout: subscription_data.metadata.ronchon_key
// - Ajout: mapping customerId -> key pour relier les webhooks
// - Ajout: handler customer.subscription.deleted (downgrade FREE)
// - Compat: garde des endpoints existants (plan, message)

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const Stripe = require('stripe');

// Optionnel: Upstash Redis (si variables présentes). Sinon, fallback mémoire.
let redis = null;
try {
  const { Redis } = require('@upstash/redis');
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
  }
} catch (_) {}

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();

// ---------------------------
// Stores (mémoire avec option Redis)
// ---------------------------
if (!global.__hits) global.__hits = new Map();
if (!global.__premium) global.__premium = new Set();
if (!global.__cust2key) global.__cust2key = new Map(); // customerId -> key
if (!global.__processedEvents) global.__processedEvents = new Set();

function getClientKey(req) {
  const h = req.headers['x-client-id'];
  const xfwd = req.headers['x-forwarded-for'];
  const ip = xfwd ? xfwd.split(',')[0].trim() : (req.ip || 'unknown');
  return String(h || ip);
}

async function isPremium(key) {
  if (redis) return !!(await redis.sismember('ronchon:premium', key));
  return global.__premium.has(key);
}
async function setPremium(key, value) {
  if (!key) return;
  if (redis) {
    if (value) await redis.sadd('ronchon:premium', key); else await redis.srem('ronchon:premium', key);
  } else {
    if (value) global.__premium.add(key); else global.__premium.delete(key);
  }
}
async function incrementHits(key) {
  if (redis) return await redis.hincrby('ronchon:hits', key, 1);
  const n = (global.__hits.get(key) || 0) + 1; global.__hits.set(key, n); return n;
}
async function getHits(key) {
  if (redis) { const v = await redis.hget('ronchon:hits', key); return Number(v || 0); }
  return global.__hits.get(key) || 0;
}
async function saveCustomerKey(customerId, key) {
  if (!customerId || !key) return;
  if (redis) await redis.hset('ronchon:cust2key', { [customerId]: key });
  else global.__cust2key.set(customerId, key);
}
async function getKeyFromCustomer(customerId) {
  if (!customerId) return null;
  if (redis) return await redis.hget('ronchon:cust2key', customerId);
  return global.__cust2key.get(customerId) || null;
}
async function hasProcessed(eventId) {
  if (!eventId) return false;
  if (redis) return !!(await redis.sismember('ronchon:events', eventId));
  return global.__processedEvents.has(eventId);
}
async function markProcessed(eventId) {
  if (!eventId) return;
  if (redis) await redis.sadd('ronchon:events', eventId);
  else global.__processedEvents.add(eventId);
}

// ---------------------------
// Middlewares: JSON partout SAUF le webhook Stripe
// ---------------------------
app.use((req, res, next) => {
  // 🔧 Important: startsWith pour gérer les querystrings et les / finaux
  if (req.originalUrl && req.originalUrl.startsWith('/api/stripe/webhook')) return next();
  return express.json({ limit: '1mb' })(req, res, next);
});

// ---------------------------
// Healthcheck
// ---------------------------
app.get('/', (req, res) => {
  res.json({ ok: true, env: process.env.NODE_ENV || 'development' });
});

// ---------------------------
// Stripe: Checkout (subscription)
// ---------------------------
app.post('/api/stripe/checkout', async (req, res) => {
  try {
    const key = getClientKey(req);
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      client_reference_id: key,
      // 👇 On copie la key dans la meta de l'abonnement pour la retrouver en webhook
      subscription_data: { metadata: { ronchon_key: key } },
      success_url: (process.env.FRONTEND_BASE_URL || 'https://example.com') + '/success',
      cancel_url: (process.env.FRONTEND_BASE_URL || 'https://example.com') + '/cancel',
    });
    return res.json({ url: session.url });
  } catch (e) {
    console.error('Stripe checkout error:', e);
    res.status(500).json({ error: 'stripe_checkout_failed' });
  }
});

// ---------------------------
// Plan côté client
// ---------------------------
app.get('/api/me/plan', async (req, res) => {
  const key = getClientKey(req);
  const premium = await isPremium(key);
  res.json({ plan: premium ? 'premium' : 'free' });
});

// ---------------------------
// Exemple endpoint message (garde ton implémentation OpenAI si tu en as une)
// ---------------------------
app.post('/api/message', async (req, res) => {
  try {
    const key = getClientKey(req);
    const premium = await isPremium(key);
    const limit = Number(process.env.FREE_DAILY_LIMIT || 20);

    if (!premium) {
      const hits = await getHits(key);
      if (hits >= limit) return res.status(429).json({ error: 'quota_exceeded', message: 'Limite atteinte. Passe en premium pour continuer.' });
    }

    await incrementHits(key);

    // ⬇️ Conserve ta logique OpenAI existante ici si tu en as une.
    // Placeholder neutre pour ne rien casser si l'appel OpenAI est ailleurs.
    return res.json({ ok: true, reply: 'Réponse mock (branche OpenAI ici si besoin).' });
  } catch (e) {
    console.error('API /api/message error:', e);
    res.status(500).json({ error: 'server_error' });
  }
});

// ---------------------------
// Webhook Stripe (RAW BODY)
// ---------------------------
app.post('/api/stripe/webhook', bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('❌ Webhook signature verification failed:', err.message);
    return res.status(400).send('Webhook Error: ' + err.message);
  }

  if (await hasProcessed(event.id)) {
    return res.status(200).send('Event already processed');
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const key = session && session.client_reference_id;
        const customerId = session && session.customer;
        if (key) await setPremium(key, true);
        if (customerId && key) await saveCustomerKey(customerId, key);
        console.log('✅ checkout.session.completed → premium ON', { key, customerId });
        break;
      }
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        const customerId = invoice && invoice.customer;
        const key = customerId ? (await getKeyFromCustomer(customerId)) : null;
        if (key) await setPremium(key, true);
        console.log('💳 invoice.payment_succeeded', { customerId, key });
        break;
      }
      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const customerId = subscription && subscription.customer;
        const cancelAtPeriodEnd = subscription && subscription.cancel_at_period_end;
        const keyMeta = subscription && subscription.metadata && subscription.metadata.ronchon_key;
        const key = keyMeta || (customerId ? (await getKeyFromCustomer(customerId)) : null);
        if (key) {
          await setPremium(key, true); // premium reste actif jusqu'à fin de période si cancel_at_period_end
          console.log('🔁 subscription.updated', { customerId, key, cancelAtPeriodEnd });
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const customerId = subscription && subscription.customer;
        const keyMeta = subscription && subscription.metadata && subscription.metadata.ronchon_key;
        let key = keyMeta || null;
        if (!key && customerId) key = await getKeyFromCustomer(customerId);
        if (key) {
          await setPremium(key, false); // downgrade
          console.log('🧹 subscription.deleted → premium OFF', { customerId, key });
        } else {
          console.warn('⚠️ subscription.deleted reçu mais key introuvable', { customerId });
        }
        break;
      }
      default:
        console.log('ℹ️ Unhandled event', event.type);
    }

    await markProcessed(event.id);
    return res.status(200).send('ok');
  } catch (e) {
    console.error('🔥 Webhook handler error:', e);
    return res.status(500).send('Webhook handler error');
  }
});

// ---------------------------
// (Optionnel) simulateurs DEV — à supprimer en prod
// ---------------------------
if (process.env.DEV_TEST_SECRET) {
  app.post('/dev/simulate/checkout-completed', express.json(), async (req, res) => {
    try {
      if (req.headers['x-dev-secret'] !== process.env.DEV_TEST_SECRET) return res.status(403).json({ error: 'forbidden' });
      const { key, customerId } = req.body || {};
      if (!key) return res.status(400).json({ error: 'missing_key' });
      await setPremium(key, true);
      if (customerId) await saveCustomerKey(customerId, key);
      res.json({ ok: true, simulated: 'checkout.session.completed', key, customerId });
    } catch (e) { res.status(500).json({ error: 'server_error' }); }
  });
  app.post('/dev/simulate/sub-deleted', express.json(), async (req, res) => {
    try {
      if (req.headers['x-dev-secret'] !== process.env.DEV_TEST_SECRET) return res.status(403).json({ error: 'forbidden' });
      const { key, customerId } = req.body || {};
      let k = key || (customerId ? await getKeyFromCustomer(customerId) : null);
      if (!k) return res.status(400).json({ error: 'key_not_found' });
      await setPremium(k, false);
      res.json({ ok: true, simulated: 'customer.subscription.deleted', key: k, customerId });
    } catch (e) { res.status(500).json({ error: 'server_error' }); }
  });
}

// ---------------------------
// Start server
// ---------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Ronchon backend listening on :${PORT}`);
});











