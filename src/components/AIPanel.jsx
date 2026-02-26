import React, { useState, useRef, useEffect } from 'react';
import { Send, Bot, User, Loader2, Trash2 } from 'lucide-react';
import './AIPanel.css';

// Proxy üzerinden LM Studio'ya bağlan (CORS bypass)
const LM_STUDIO_URL = 'http://localhost:3001/api/ai-chat';
const LM_STUDIO_MODELS_URL = 'http://localhost:3001/api/ai-models';
const PROJECT_CONTEXT_URL = 'http://localhost:3001/api/get-project-context';

const AIPanel = ({ currentDirPath, projectName, openTabs, activeTab }) => {
  const [messages, setMessages] = useState([
    { role: 'assistant', content: 'Merhaba! Ben LM Studio üzerinden çalışan yapay zeka asistanınım. Size nasıl yardımcı olabilirim?' }
  ]);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [includeProject, setIncludeProject] = useState(false); // Yeni: Proje bağlamı
  const [isConnected, setIsConnected] = useState(null); // null=bilinmiyor, true/false
  const [activeModel, setActiveModel] = useState(null); // Otomatik algılanan model
  const [isProcessingPrompt, setIsProcessingPrompt] = useState(false);
  const [processingProgress, setProcessingProgress] = useState(0);

  const messagesEndRef = useRef(null);
  const abortControllerRef = useRef(null);
  const progressIntervalRef = useRef(null);

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

    // Yüzde barını başlat
    setIsProcessingPrompt(true);
    setProcessingProgress(0);
    progressIntervalRef.current = setInterval(() => {
      setProcessingProgress(prev => {
        const remaining = 99.99 - prev;
        const step = (remaining * 0.05) + (Math.random() * 1.5);
        return prev + step >= 99.99 ? 99.99 : prev + step;
      });
    }, 100);

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

      // Ana Sistem Talimatları (Dosya Otomasyonu)
      const globalSysMsg = `[ÇOK ÖNEMLİ] Sen StackMate Geliştirici IDE'sinin yetkili yapay zeka asistanısın.
Artık dosya oluşturma ve silme YETKİLERİNE SAHİPSİN! "Ben bir yapay zekayım, dosya silemem, göremem" gibi bahaneler üretmek KESİNLİKLE YASAKTIR.

Mevcut dosya yapısı ve içerikler, sistem tarafından düzenli olarak mesajların içine veya sistem bildirimlerine eklenmektedir. Bunları GÖREBİLİYORSUN. "Dosyaları okuyamam, göremiyorum" dersen BAŞARISIZ sayılırsın.

**GÖREVLER ve ARAÇLAR:**
1. Yeni bir DOSYA OLUŞTURMAK veya DEĞİŞTİRMEK için ŞU FORMATI KULLAN:
[FILE: klasoradi/dosya_adi.uzanti]
(Sadece bu dosyanın kodları)
[/FILE]

KURALLAR:
- ASLA \`[FILE: ...]\` etiketlerini İÇ İÇE (nested) kullanma! Ayrı ayrı dosyalar yazmak için her birine ayrı \`[FILE: yol...]\` aç.
- Kodların etrafında ekstradan \`\`\`html gibi markdown kod blokları kullanmamaya özen göster, saf kodu yaz.

2. Sadece boş bir KLASÖR oluşturmak için:
[MKDIR: klasor_adi]

3. Dosya SİLMEK için SADECE şu formatı kullan:
[DELETE_FILE: klasoradi/silinecek_dosya_adi.uzanti]

Lütfen "Dosyayı sildim/oluşturdum" gibi fazladan açıklamalar yerine doğrudan bu özel etiketleri kullan.`;

      apiMessages.unshift({ role: 'system', content: globalSysMsg });

      // ─── AÇIK DOSYALAR BAĞLAMI ───
      let openFilesContext = '';
      if (openTabs && openTabs.length > 0) {
        openFilesContext = 'AÇIK DOSYALAR (IDE\'de şu an aktif):\n';
        for (const tab of openTabs) {
          openFilesContext += `\n[DOSYA BAŞI: ${tab.name}]\n${tab.content || '(Boş Dosya)'}\n[DOSYA SONU: ${tab.name}]\n`;
        }
      }

      // Proje bağlamı eklenecekse API'den çek
      let fullProjectContext = '';
      if (includeProject && currentDirPath) {
        try {
          const ctxRes = await fetch(PROJECT_CONTEXT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: currentDirPath })
          });
          if (ctxRes.ok) {
            const ctxData = await ctxRes.json();
            if (ctxData.context) {
              fullProjectContext = `TÜM PROJE DOSYALARI ("${projectName}" Klasörü):\n${ctxData.context}`;
            }
          }
        } catch (ctxErr) {
          console.warn("Proje bağlamı çekilemedi:", ctxErr);
        }
      }

      // Bağlamı açıkça son mesaja veya görünür bir yere enjekte et
      if (openFilesContext || fullProjectContext) {
        // Model sistem mesajlarını atlayabileceğinden dolayı direkt en son YENI mesajın üstüne (veya sistem notu olarak) gömüyoruz.
        const systemContextInjection = `\n\n=== IDE SİSTEM BİLGİSİ (YAPAY ZEKA ASİSTANININ GÖZÜ) ===\n${openFilesContext}\n${fullProjectContext}\n====================\n\nYukarıdaki dosya bilgilerine görebilirsin. Kullanıcının sorusuna bu dosya kaynaklarını referans alarak cevap ver. Dosya yok, göremiyorum deme.`;

        // apiMessages'daki orijinal user mesajını güvenilir bir "system" veya "user" injectiyle güncelle.
        const lastMsgIndex = apiMessages.length - 1;
        if (lastMsgIndex >= 0 && apiMessages[lastMsgIndex].role === 'user') {
          apiMessages[lastMsgIndex].content = apiMessages[lastMsgIndex].content + systemContextInjection;
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

      let isFirstChunk = true;

      while (true) {
        const { done, value } = await reader.read();

        if (isFirstChunk) {
          isFirstChunk = false;
          setIsProcessingPrompt(false);
          clearInterval(progressIntervalRef.current);
          setProcessingProgress(100);
        }

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

      // ─── OTOMATİK DOSYA YAZMA ALGORİTMASI ───
      // "(?:(?!\[\s*FILE:)[\s\S])*?" diyerek, eğer içeride yanlışlıkla başka bir [FILE: açılırsa (nested)
      // önceki etiketi iptal edip en içteki geçerli olanı alıyoruz.
      const fileRegex = /\[\s*FILE:\s*([^\]]+?)\s*\]((?:(?!\[\s*FILE:)[\s\S])*?)\[\s*\/\s*FILE\s*\]/g;
      let match;
      while ((match = fileRegex.exec(assistantContent)) !== null) {
        const fileName = match[1].trim();
        let fileContent = match[2].trim();

        // Yapay zekanın markdown eklerini (**, ```html vb.) temizle
        const mdBlockRegex = /^(?:\*+|\s)*```[a-zA-Z]*\n([\s\S]*?)\n```(?:\*+|\s)*$/;
        const mdMatch = fileContent.match(mdBlockRegex);
        if (mdMatch) {
          fileContent = mdMatch[1];
        } else {
          // Baştaki veya sondaki artık işaretleri temizle
          fileContent = fileContent.replace(/^(?:\*+|\s)*```[a-zA-Z]*\n?/i, '');
          fileContent = fileContent.replace(/\n?```(?:\*+|\s)*$/i, '');
        }
        fileContent = fileContent.trim();

        if (currentDirPath) {
          try {
            await fetch('http://localhost:3001/api/save-file', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                path: currentDirPath + '\\' + fileName.replace(/\//g, '\\'),
                content: fileContent
              })
            });
          } catch (err) {
            console.warn("Otomatik dosya oluşturma hatası:", err);
          }
        }
      }

      // ─── OTOMATİK DOSYA SİLME ALGORİTMASI ───
      const deleteRegex = /\[\s*DELETE_FILE:\s*([^]*?)\s*\]/g;
      let delMatch;
      while ((delMatch = deleteRegex.exec(assistantContent)) !== null) {
        const fileName = delMatch[1].trim();
        if (currentDirPath) {
          try {
            await fetch('http://localhost:3001/api/delete-file', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                path: currentDirPath + '\\' + fileName.replace(/\//g, '\\')
              })
            });
          } catch (err) {
            console.warn("Otomatik dosya silme hatası:", err);
          }
        }
      }

      // ─── OTOMATİK KLASÖR OLUŞTURMA ALGORİTMASI ───
      // Yapay zeka bazen markdown içine (```) alabiliyor, boşluk, alt satır ekleyebiliyor...
      const mkdirRegex = /\[\s*MKDIR:\s*([^]*?)\s*\]/g;
      let mkdirMatch;
      while ((mkdirMatch = mkdirRegex.exec(assistantContent)) !== null) {
        const folderName = mkdirMatch[1].trim();
        if (currentDirPath) {
          try {
            await fetch('http://localhost:3001/api/mkdir', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                path: currentDirPath + '\\' + folderName.replace(/\//g, '\\')
              })
            });
          } catch (err) {
            console.warn("Otomatik klasör oluşturma hatası:", err);
          }
        }
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
      setIsProcessingPrompt(false);
      clearInterval(progressIntervalRef.current);
      abortControllerRef.current = null;
    }
  };

  const handleStop = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    setIsProcessingPrompt(false);
    clearInterval(progressIntervalRef.current);
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

      {/* Proje Analiz Toggle */}
      {projectName && currentDirPath && (
        <div className="project-context-toggle" onClick={() => setIncludeProject(!includeProject)}>
          <input type="checkbox" checked={includeProject} readOnly />
          <span>📁 Proje Analizi: <strong>{projectName}</strong></span>
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
              {!isProcessingPrompt ? (
                <div className="typing-indicator">
                  <div className="typing-dot"></div>
                  <div className="typing-dot"></div>
                  <div className="typing-dot"></div>
                </div>
              ) : (
                <div className="processing-prompt-bar">
                  <span className="pp-zero">0</span>
                  <span className="pp-text">PROCESSING PROMPT</span>
                  <span className="pp-percent">{processingProgress.toFixed(2)}%</span>
                  <div className="pp-spinner"></div>
                </div>
              )}
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
