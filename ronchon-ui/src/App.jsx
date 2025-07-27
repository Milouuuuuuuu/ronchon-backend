import React, { useState, useEffect, useRef } from 'react';
import './style.css';
import logo from './assets/icon.png';

const personalities = ['Doudou', 'Trouillard', 'Énervé', 'Hater'];

function App() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [personality, setPersonality] = useState('Doudou');
  const chatEndRef = useRef(null);
  const logoRef = useRef(null);

  const handleSend = async (e) => {
    e.preventDefault();

    if (!input.trim()) return;

    // ➤ animation du logo : saut
    if (logoRef.current) {
      logoRef.current.classList.add("jump");
      setTimeout(() => {
        logoRef.current.classList.remove("jump");
      }, 3000);
    }

    const userMessage = input.trim();
    setMessages((prev) => [...prev, { role: 'user', content: userMessage }]);
    setInput('');
    setLoading(true);
    // juste après avoir envoyé la requête :
    const logo = document.querySelector('.logo');
    logo.classList.add('send-bounce');

// retire l'animation après 3 secondes
    setTimeout(() => {
    logo.classList.remove('send-bounce');
    }, 3000);


    try {
      const res = await fetch('https://ronchon-backend.onrender.com/api/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: userMessage,
          personality: personality,
        }),
      });

      const data = await res.json();

      if (!res.ok || !data.response) {
        throw new Error(data.error || 'Réponse invalide.');
      }

      setMessages((prev) => [...prev, { role: 'ronchon', content: data.response }]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: 'ronchon', content: 'Erreur de réponse du serveur.' },
      ]);
    }

    setLoading(false);
  };

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div className="app">
      <header>
        <img ref={logoRef} src={logo} alt="Ronchon" className="logo" />
        <h1>Ronchon</h1>
      </header>

      <div className="personality-selector">
        {personalities.map((p) => (
          <button
            key={p}
            className={`personality-button ${personality === p ? 'active' : ''}`}
            onClick={() => setPersonality(p)}
          >
            {p}
          </button>
        ))}
      </div>

      <div className="chat-container">
        {messages.map((msg, idx) => (
          <div
            key={idx}
            className={msg.role === 'user' ? 'user-message' : 'ai-message'}
          >
            {msg.content}
          </div>
        ))}
        {loading && <div className="ai-message">Ronchon réfléchit...</div>}
        <div ref={chatEndRef} />
      </div>

      <footer>
        <form onSubmit={handleSend}>
          <input
            type="text"
            placeholder="Dis quelque chose à Ronchon..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <button type="submit">➤</button>
        </form>
      </footer>
    </div>
  );
}

export default App;
