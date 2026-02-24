import React, { useState, useRef, useEffect } from 'react';
import { Send, Bot, User, Loader2, Trash2 } from 'lucide-react';
import './AIPanel.css';

// Proxy üzerinden LM Studio'ya bağlan (CORS bypass)
const LM_STUDIO_URL = 'http://localhost:3001/api/ai-chat';
const LM_STUDIO_MODELS_URL = 'http://localhost:3001/api/ai-models';

const AIPanel = () => {
  const [messages, setMessages] = useState([
    { role: 'assistant', content: 'Merhaba! Ben LM Studio üzerinden çalışan yapay zeka asistanınım. Size nasıl yardımcı olabilirim?' }
  ]);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [isConnected, setIsConnected] = useState(null); // null=bilinmiyor, true/false
  const [activeModel, setActiveModel] = useState(null); // Otomatik algılanan model
  const messagesEndRef = useRef(null);
  const abortControllerRef = useRef(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Bağlantı kontrolü + aktif model algılama
  useEffect(() => {
    const checkConnection = async () => {
      try {
        const res = await fetch(LM_STUDIO_MODELS_URL);
        if (res.ok) {
          const data = await res.json();
          setIsConnected(true);
          // LM Studio'da yüklü ilk modeli kullan
          if (data.data && data.data.length > 0) {
            setActiveModel(data.data[0].id);
          }
        } else {
          setIsConnected(false);
          setActiveModel(null);
        }
      } catch {
        setIsConnected(false);
        setActiveModel(null);
      }
    };
    checkConnection();
    // Her 10 saniyede bir kontrol et (model değişirse yakalar)
    const interval = setInterval(checkConnection, 10000);
    return () => clearInterval(interval);
  }, []);

  const handleSend = async () => {
    if (!input.trim() || isTyping) return;

    const userMessage = { role: 'user', content: input };
    const updatedMessages = [...messages, userMessage];
    setMessages(updatedMessages);
    setInput('');
    setIsTyping(true);

    // Abort controller — yanıt beklerken iptal edilebilsin
    abortControllerRef.current = new AbortController();

    try {
      // Mesaj geçmişini API formatına çevir
      // 1. İlk karşılama mesajını system rolüne çevir
      // 2. Başarısız yanıtları filtrele
      // 3. user/assistant dönüşümlü sırasını garanti et
      const apiMessages = [];
      const filtered = updatedMessages.filter(m =>
        !m.content.startsWith('(Yanıt alınamadı)') &&
        !m.content.startsWith('⚠️') &&
        !m.content.startsWith('❌')
      );

      for (let i = 0; i < filtered.length; i++) {
        const m = filtered[i];
        if (i === 0 && m.role === 'assistant') {
          // İlk karşılama mesajını system olarak ekle
          apiMessages.push({ role: 'system', content: m.content });
        } else {
          // Dönüşümlü sırayı kontrol et
          const lastRole = apiMessages.length > 0 ? apiMessages[apiMessages.length - 1].role : null;
          // system'den sonra her rol gelebilir, ama user/assistant ardışık olmamalı
          if (lastRole === m.role && m.role !== 'system') {
            // Aynı rolden ardışık mesaj — birleştir
            apiMessages[apiMessages.length - 1].content += '\n' + m.content;
          } else {
            apiMessages.push({ role: m.role, content: m.content });
          }
        }
      }

      const response = await fetch(LM_STUDIO_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: activeModel,
          messages: apiMessages,
          temperature: 0.7,
          max_tokens: 2048,
          stream: true,
        }),
        signal: abortControllerRef.current.signal,
      });

      if (!response.ok) {
        const errBody = await response.text();
        let errMsg = `LM Studio hatası (${response.status})`;
        try {
          const parsed = JSON.parse(errBody);
          errMsg = parsed.error?.message || parsed.error || errMsg;
        } catch { /* text olarak kalır */ }
        throw new Error(errMsg);
      }

      // Streaming yanıt oku
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let assistantContent = '';

      // Boş asistan mesajı ekle (streaming için)
      setMessages(prev => [...prev, { role: 'assistant', content: '' }]);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n').filter(l => l.trim().startsWith('data:'));

        for (const line of lines) {
          const data = line.replace('data: ', '').trim();
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              assistantContent += delta;
              // Son mesajı güncelle (streaming)
              setMessages(prev => {
                const newMsgs = [...prev];
                newMsgs[newMsgs.length - 1] = {
                  role: 'assistant',
                  content: assistantContent,
                };
                return newMsgs;
              });
            }
          } catch {
            // Parse hatası — atla
          }
        }
      }

      // Streaming bitti, eğer içerik boşsa bildir
      if (!assistantContent.trim()) {
        setMessages(prev => {
          const newMsgs = [...prev];
          newMsgs[newMsgs.length - 1] = {
            role: 'assistant',
            content: '(Yanıt alınamadı)',
          };
          return newMsgs;
        });
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        // Kullanıcı iptal etti
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: '⚠️ Yanıt iptal edildi.',
        }]);
      } else {
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: `❌ Bağlantı hatası: ${err.message}\n\nLM Studio'nun çalıştığından emin olun (http://127.0.0.1:1234)`,
        }]);
        setIsConnected(false);
      }
    } finally {
      setIsTyping(false);
      abortControllerRef.current = null;
    }
  };

  const handleStop = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
  };

  const handleClearChat = () => {
    setMessages([
      { role: 'assistant', content: 'Sohbet temizlendi. Size nasıl yardımcı olabilirim?' }
    ]);
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="ai-panel-container">
      <div className="ai-panel-header">
        <div className="ai-header-left">
          <Bot className="header-icon" />
          <span>AI ASSISTANT</span>
          <div className={`connection-dot ${isConnected === true ? 'connected' : isConnected === false ? 'disconnected' : 'checking'}`}
            title={isConnected === true ? `LM Studio bağlı — ${activeModel || 'model yüklü'}` : isConnected === false ? 'LM Studio bağlantısı yok' : 'Kontrol ediliyor...'}
          />
        </div>
        <button className="clear-chat-btn" onClick={handleClearChat} title="Sohbeti temizle">
          <Trash2 size={14} />
        </button>
      </div>

      {isConnected === true && activeModel && (
        <div className="model-info">
          🤖 {activeModel}
        </div>
      )}

      {isConnected === false && (
        <div className="connection-warning">
          ⚠️ LM Studio bağlantısı yok. <code>http://127.0.0.1:1234</code> adresinde çalıştığından emin olun.
        </div>
      )}

      <div className="messages-container">
        {messages.map((message, index) => (
          <div
            key={index}
            className={`message ${message.role === 'user' ? 'user-message' : 'assistant-message'}`}
          >
            {message.role === 'assistant' && (
              <div className="avatar assistant-avatar">
                <Bot className="avatar-icon" />
              </div>
            )}
            <div className={`message-bubble ${message.role}-bubble`}>
              <p style={{ whiteSpace: 'pre-wrap' }}>{message.content}</p>
            </div>
            {message.role === 'user' && (
              <div className="avatar user-avatar">
                <User className="avatar-icon" />
              </div>
            )}
          </div>
        ))}
        {isTyping && messages[messages.length - 1]?.content === '' && (
          <div className="message assistant-message">
            <div className="avatar assistant-avatar">
              <Bot className="avatar-icon" />
            </div>
            <div className="message-bubble assistant-bubble">
              <div className="typing-indicator">
                <div className="typing-dot"></div>
                <div className="typing-dot"></div>
                <div className="typing-dot"></div>
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="input-container">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyPress}
          placeholder={isConnected === false ? 'LM Studio bağlantısı yok...' : 'Bir soru sorun...'}
          className="message-input"
          disabled={isConnected === false}
        />
        {isTyping ? (
          <button onClick={handleStop} className="send-button stop-btn" title="Yanıtı durdur">
            <div className="stop-icon" />
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!input.trim() || isTyping || isConnected === false}
            className="send-button"
          >
            <Send className="send-icon" />
          </button>
        )}
      </div>
    </div>
  );
};

export default AIPanel;
