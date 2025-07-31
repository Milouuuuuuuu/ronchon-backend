import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { OpenAI } from 'openai';

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.use(cors());
app.use(express.json());

const personalities = {
  Doudou: "Tu es une intelligence artificielle douce, gentille, rassurante, qui parle comme une peluche.",
  Trouillard: "Tu es une IA qui doute de tout et qui panique facilement, mais essaie quand même d'aider.",
  Énervé: "Tu es une IA impatiente et agacée qui dit les choses de manière directe, sans filtre.",
  Hater: "Tu es une IA cynique et sarcastique, qui aime contredire et provoquer, mais sans être injurieuse.",
};

app.post('/api/message', async (req, res) => {
  const { messages, personality } = req.body;


  console.log('[POST /api/message] Reçu:', { message, personality });

  // Vérification des champs
 if (!Array.isArray(messages) || messages.length === 0) {
  return res.status(400).json({ error: 'Historique de messages manquant ou invalide.' });
}

  const systemInstruction = personalities[personality];
  if (!systemInstruction) {
    return res.status(400).json({ error: 'Personnalité invalide.' });
  }

  try {
   const chatResponse = await openai.chat.completions.create({
  model: 'gpt-3.5-turbo',
  messages: [
    { role: 'system', content: systemInstruction },
    ...messages
  ],
});


    const content = chatResponse.choices[0].message.content;
    res.json({ response: content });

  } catch (error) {
    console.error('[ERREUR OpenAI]', error);
    res.status(500).json({ error: 'Erreur serveur OpenAI.' });
  }
});

app.listen(port, () => {
  console.log(`✅ Serveur Ronchon lancé sur http://localhost:${port}`);
});
