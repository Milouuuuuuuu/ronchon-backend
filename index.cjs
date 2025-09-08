require('dotenv').config();
const express = require('express');
const Stripe = require('stripe');
const bodyParser = require('body-parser');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();

// ---------------------------
// Globals (fallback in-memory stores)
// ---------------------------
if (!global.__hits) global.__hits = new Map(); // key -> number
if (!global.__premium) global.__premium = new Set(); // key
if (!global.__cust2key) global.__cust2key = new Map(); // customerId -> key

// ---------------------------
// Helpers: quota & premium
// ---------------------------
function getClientKey(req) {
  const fromHeader = req.headers['x-client-id'];
  const xfwd = req.headers['x-forwarded-for'];
  const ip = xfwd ? xfwd.split(',')[0].trim() : (req.ip || 'unknown');
  return String(fromHeader || ip);
}

async function isPremium(key) {
  return global.__premium.has(key);
}

async function setPremium(key, value) {
  if (!key) return;
  if (value) { global.__premium.add(key); } else { global.__premium.delete(key); }
}

async function incrementHits(key) {
  const cur = global.__hits.get(key) || 0;
  const next = cur + 1;
  global.__hits.set(key, next);
  return next;
}

async function getHits(key) {
  return global.__hits.get(key) || 0;
}

// Mapping customerId -> key
async function saveCustomerKey(customerId, key) {
  if (!customerId || !key) return;
  global.__cust2key.set(customerId, key);
}

async function getKeyFromCustomer(customerId) {
  if (!customerId) return null;
  return global.__cust2key.get(customerId) || null;
}

// ---------------------------
// JSON for normal routes; RAW only for webhook
// ---------------------------
app.use((req, res, next) => {
  if (req.originalUrl === '/api/stripe/webhook') return next();
  express.json({ limit: '1mb' })(req, res, next);
});

// ---------------------------
// Healthcheck
// ---------------------------
app.get('/', (req, res) => {
  res.json({ ok: true, env: process.env.NODE_ENV || 'development' });
});

// ---------------------------
// Stripe Checkout (subscription)
// ---------------------------
app.post('/api/stripe/checkout', async (req, res) => {
  try {
    const key = getClientKey(req);

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      client_reference_id: key,
      subscription_data: { metadata: { ronchon_key: key } },
      success_url: (process.env.FRONTEND_BASE_URL || 'https://example.com') + '/success',
      cancel_url: (process.env.FRONTEND_BASE_URL || 'https://example.com') + '/cancel'
    });

    return res.json({ url: session.url });
  } catch (e) {
    console.error('Stripe checkout error:', e);
    res.status(500).json({ error: 'stripe_checkout_failed' });
  }
});

// ---------------------------
// Expose plan (for UI)
// ---------------------------
app.get('/api/me/plan', async (req, res) => {
  const key = getClientKey(req);
  const premium = await isPremium(key);
  res.json({ plan: premium ? 'premium' : 'free' });
});

// ---------------------------
// Example protected endpoint with quota
// ---------------------------
app.post('/api/message', async (req, res) => {
  try {
    const key = getClientKey(req);
    const premium = await isPremium(key);
    const freeDailyLimit = Number(process.env.FREE_DAILY_LIMIT || 20);

    if (!premium) {
      const hits = await getHits(key);
      if (hits >= freeDailyLimit) {
        return res.status(429).json({ error: 'quota_exceeded', message: 'Limite atteinte. Passe en premium pour continuer.' });
      }
    }

    await incrementHits(key);

    return res.json({ ok: true, reply: 'Réponse mock (branche OpenAI ici).' });
  } catch (e) {
    console.error('API /api/message error:', e);
    res.status(500).json({ error: 'server_error' });
  }
});

// ---------------------------
// Stripe Webhook (RAW BODY)
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

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const key = session.client_reference_id;
      const customerId = session.customer;
      if (key) { await setPremium(key, true); }
      if (customerId && key) { await saveCustomerKey(customerId, key); }
      console.log('✅ checkout.session.completed → premium ON for key=' + key + ', customer=' + customerId);
    }

    if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      const customerId = subscription.customer;
      let key = null;
      if (subscription && subscription.metadata && subscription.metadata.ronchon_key) {
        key = subscription.metadata.ronchon_key;
      }
      if (!key && customerId) { key = await getKeyFromCustomer(customerId); }
      if (key) {
        await setPremium(key, false);
        console.log('🧹 customer.subscription.deleted → premium OFF for customer=' + customerId + ', key=' + key);
      } else {
        console.warn('⚠️ subscription.deleted but key not found');
      }
    }

    return res.json({ received: true });
  } catch (e) {
    console.error('🔥 Webhook handler error:', e);
    res.status(500).send('Webhook handler error');
  }
});

// ---------------------------
// Server
// ---------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('🚀 Ronchon backend listening on :' + PORT);
});








