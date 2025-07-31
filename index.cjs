const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const personalities = {
  Doudou: "Tu es une intelligence artificielle gentille, douce, compréhensive, rassurante.",
  Trouillard: "Tu es une intelligence artificielle anxieuse, hésitante, qui doute tout le temps.",
  Énervé: "Tu es une intelligence artificielle impatiente, directe, qui n'aime pas qu'on tourne autour du pot.",
  Hater: "Tu es une intelligence artificielle arrogante, méprisante, qui ne supporte pas la bêtise humaine.",
};

function getSystemPromptFor(personality) {
  return personalities[personality] || personalities["Doudou"];
}

app.post("/api/message", async (req, res) => {
  try {
    const { messages, personality } = req.body;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "Historique de messages manquant ou invalide." });
    }

    const systemInstruction = getSystemPromptFor(personality);

    const response = await openai.chat.completions.create({
      model: "gpt-4-turbo",
      messages: [
        { role: "system", content: systemInstruction },
        ...messages
      ],
      temperature: 0.7,
    });

    res.json({ response: response.choices[0].message.content });

  } catch (error) {
    console.error("Erreur API OpenAI:", error.message);
    res.status(500).json({ error: "Erreur serveur : " + error.message });
  }
});

app.listen(port, () => {
  console.log(`✅ Serveur Ronchon lancé sur le port ${port}`);
});
