import React, { useState, useRef, useEffect } from 'react';
import { Send, Bot, User } from 'lucide-react';
import './AIPanel.css';

const AIPanel = () => {
  const [messages, setMessages] = useState([
    { role: 'assistant', content: 'Merhaba! Size nasıl yardımcı olabilirim?' }
  ]);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const messagesEndRef = useRef(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim()) return;

    const userMessage = { role: 'user', content: input };
    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setIsTyping(true);

    setTimeout(() => {
      const responses = [
        'Bu kod için yardımcı olabilirim. Ne yapmak istiyorsunuz?',
        'Anladım, hemen düzeltmeye çalışayım.',
        'İşte önerim: Bu şekilde optimize edebiliriz.',
        'Bu yaklaşım daha iyi performans sağlayabilir.',
        'Başka bir şey var mı yardımcı olabileceğim?'
      ];
      const randomResponse = responses[Math.floor(Math.random() * responses.length)];
      setMessages(prev => [...prev, { role: 'assistant', content: randomResponse }]);
      setIsTyping(false);
    }, 1000);
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
        <Bot className="header-icon" />
        AI ASSISTANT
      </div>

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
              <p>{message.content}</p>
            </div>
            {message.role === 'user' && (
              <div className="avatar user-avatar">
                <User className="avatar-icon" />
              </div>
            )}
          </div>
        ))}
        {isTyping && (
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
          onKeyPress={handleKeyPress}
          placeholder="Bir soru sorun..."
          className="message-input"
        />
        <button
          onClick={handleSend}
          disabled={!input.trim() || isTyping}
          className="send-button"
        >
          <Send className="send-icon" />
        </button>
      </div>
    </div>
  );
};

export default AIPanel;
