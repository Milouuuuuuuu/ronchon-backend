const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const OpenAI = require('openai');
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

const WHITELIST = new Set([
  'chrome-extension://mbfcngdankjijdmdklffpgnfeeoijpddn',
  'http://localhost:5173',
  'https://ronchon.com'
]);

const corsOptions = {
  origin(origin, cb) {
    if (!origin || WHITELIST.has(origin)) return cb(null, true);
    return cb(new Error(`Origin not allowed: ${origin}`), false);
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  optionsSuccessStatus: 204
};

app.use(cors(corsOptions));
// Réponse générique aux préflights (aucun chemin wildcard)
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json());

// ---------- OpenAI ----------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- Personnalités ----------
const personalities = {
  Doudou: "Tu es une intelligence artificielle gentille, douce, compréhensive, rassurante.",
  Trouillard: "Tu es une intelligence artificielle anxieuse, hésitante, qui doute tout le temps.",
  Énervé: "Tu es une intelligence artificielle impatiente, directe, qui n'aime pas qu'on tourne autour du pot.",
  Hater: "Tu es une intelligence artificielle arrogante, méprisante, qui ne supporte pas la bêtise humaine."
};
function getSystemPromptFor(p) { return personalities[p] || personalities.Doudou; }

// ---------- Licences + Quota ----------
const VALID_KEYS = new Set(
  (process.env.LICENSE_KEYS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
);
const MAX_FREE = Number(process.env.MAX_FREE_PER_DAY || 10);

// Compteur mémoire-process (OK pour MVP). Pour persister, passer à Redis.
const hits = new Map(); // key: ip_YYYY-MM-DD -> count

function isPremiumFromReq(req) {
  const k = (req.headers['x-license-key'] || '').trim();
  return VALID_KEYS.has(k);
}
function keyForIpDay(req) {
  const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
  const day = new Date().toISOString().slice(0, 10);
  return `${ip}_${day}`;
}
function incHit(req) {
  const k = keyForIpDay(req);
  const n = hits.get(k) || 0;
  hits.set(k, n + 1);
  return n + 1;
}
function currentHits(req) {
  const k = keyForIpDay(req);
  return hits.get(k) || 0;
}

// ---------- Route principale ----------
app.post('/api/message', async (req, res) => {
  try {
    const { messages, personality } = req.body;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "Messages invalides." });
    }

    const premium = isPremiumFromReq(req);
    const licenseHeader = (req.headers['x-license-key'] || '').trim();
    console.log(`🔑 Licence ${premium ? "valide" : "invalide"} reçue: ${licenseHeader || "(vide)"}`);

    if (!premium) {
      if (currentHits(req) >= MAX_FREE) {
        return res.status(429).json({
          error: "Quota gratuit atteint. Passe en premium pour continuer.",
          premium: false
        });
      }
      incHit(req);
    }

    // On ne garde que user/assistant (sécurité)
    const cleaned = messages
      .filter(m => ['user', 'assistant'].includes(m.role))
      .slice(-20); // coupe le contexte (coût)

    const systemInstruction = getSystemPromptFor(personality);

    // ---- Appel OpenAI
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: 'system', content: systemInstruction },
        ...cleaned
      ],
      temperature: 0.7
    });

    const content = completion?.choices?.[0]?.message?.content || "Désolé, pas de réponse générée.";

    return res.json({
      response: content,
      premium
    });
  } catch (err) {
    console.error("Erreur API OpenAI:", err?.response?.data || err.message);
    return res.status(500).json({ error: "Erreur serveur." });
  }
});

// ---------- Démarrage ----------
app.listen(port, () => {
  console.log(`✅ Ronchon backend sur ${port}`);
});



