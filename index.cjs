const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors({
  origin: '*',
  allowedHeaders: ['Content-Type', 'X-License-Key']
}));
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Personnalités
const personalities = {
  Doudou: "Tu es une intelligence artificielle gentille, douce, compréhensive, rassurante.",
  Trouillard: "Tu es une intelligence artificielle anxieuse, hésitante, qui doute tout le temps.",
  Énervé: "Tu es une intelligence artificielle impatiente, directe, qui n'aime pas qu'on tourne autour du pot.",
  Hater: "Tu es une intelligence artificielle arrogante, méprisante, qui ne supporte pas la bêtise humaine."
};
function getSystemPromptFor(p) { return personalities[p] || personalities.Doudou; }

// Licences + quota
const VALID_KEYS = new Set((process.env.LICENSE_KEYS || '').split(',').map(s => s.trim()).filter(Boolean));
const MAX_FREE = Number(process.env.MAX_FREE_PER_DAY || 10);
const hits = new Map(); // key: ip_YYYY-MM-DD -> count

function isPremiumFromReq(req) {
  const k = (req.headers['x-license-key'] || '').trim();
  return VALID_KEYS.has(k);
}
function keyForIpDay(req) {
  const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
  const day = new Date().toISOString().slice(0,10);
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

app.post('/api/message', async (req, res) => {
  try {
    const { messages, personality } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "Messages invalides." });
    }

    const premium = isPremiumFromReq(req);
    if (!premium) {
      if (currentHits(req) >= MAX_FREE) {
        return res.status(429).json({ error: "Quota gratuit atteint. Passe en premium pour continuer." });
      }
      incHit(req);
    }

    const cleaned = messages.filter(m => ['user','assistant'].includes(m.role));
    const systemInstruction = getSystemPromptFor(personality);

    const response = await openai.chat.completions.create({
      model: "gpt-4-turbo",
      messages: [
        { role: 'system', content: systemInstruction },
        ...cleaned
      ],
      temperature: 0.7,
    });

    return res.json({ response: response.choices[0].message.content, premium });
  } catch (err) {
    console.error("Erreur API OpenAI:", err?.response?.data || err.message);
    return res.status(500).json({ error: "Erreur serveur." });
  }
});

app.listen(port, () => console.log(`✅ Ronchon backend sur ${port}`));
