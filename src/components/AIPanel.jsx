import React, { useState, useRef, useEffect } from 'react';
import { Send, Bot, User, Loader2, Trash2, Copy, Check, X, FileCode, FolderPlus, Terminal as TerminalIcon, Play, AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import './AIPanel.css';

const LM_STUDIO_URL = 'http://localhost:3001/api/ai-chat';
const LM_STUDIO_MODELS_URL = 'http://localhost:3001/api/ai-models';
const PROJECT_CONTEXT_URL = 'http://localhost:3001/api/get-project-context';
const AGENT_EXEC_URL = 'http://localhost:3001/api/agent-exec';

const getLanguageFromPath = (p) => {
  const ext = (p.split('.').pop() || '').toLowerCase();
  const map = { js: 'javascript', jsx: 'jsx', ts: 'typescript', tsx: 'tsx', py: 'python', rb: 'ruby', java: 'java', go: 'go', rs: 'rust', html: 'html', css: 'css', scss: 'scss', json: 'json', xml: 'xml', md: 'markdown', yaml: 'yaml', yml: 'yaml', sh: 'bash', bat: 'batch', sql: 'sql', php: 'php', c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', vue: 'vue', svelte: 'svelte', cjs: 'javascript', mjs: 'javascript' };
  return map[ext] || ext || 'code';
};

const isDangerousCommand = (cmd) => {
  const lower = cmd.toLowerCase();
  return [/\brm\s/, /\brmdir\s/, /\bdel\s/, /\bformat\s/, /\brd\s/, /--force/, /\bdrop\s/, /\btruncate\s/, /\bsudo\s/, /\bmkfs/, /\bdd\s/].some(p => p.test(lower));
};

const fsaaWriteFile = async (dirHandle, relativePath, content) => {
  const parts = relativePath.replace(/\\/g, '/').split('/').filter(Boolean);
  const fileName = parts.pop();
  let dir = dirHandle;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
  const fileHandle = await dir.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
};

const fsaaDeleteFile = async (dirHandle, relativePath) => {
  const parts = relativePath.replace(/\\/g, '/').split('/').filter(Boolean);
  const fileName = parts.pop();
  let dir = dirHandle;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part);
  }
  await dir.removeEntry(fileName, { recursive: false });
};

const fsaaMkdir = async (dirHandle, relativePath) => {
  const parts = relativePath.replace(/\\/g, '/').split('/').filter(Boolean);
  let dir = dirHandle;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
};

const parseMessageParts = (content) => {
  const segments = [];
  let remaining = content;

  while (remaining.length > 0) {
    const candidates = [];

    const codeIdx = remaining.indexOf('```');
    if (codeIdx !== -1) candidates.push({ type: 'code', index: codeIdx });

    const fileMatch = remaining.match(/\[\s*FILE:\s*([^\]]+?)\s*\]/);
    if (fileMatch) candidates.push({ type: 'file', index: fileMatch.index, match: fileMatch });

    const delMatch = remaining.match(/\[\s*DELETE_FILE:\s*([^\]]+?)\s*\]/);
    if (delMatch) candidates.push({ type: 'delete', index: delMatch.index, match: delMatch });

    const mkdirMatch = remaining.match(/\[\s*MKDIR:\s*([^\]]+?)\s*\]/);
    if (mkdirMatch) candidates.push({ type: 'mkdir', index: mkdirMatch.index, match: mkdirMatch });

    const cmdMatch = remaining.match(/\[\s*CMD:\s*([^\]]+?)\s*\]/);
    if (cmdMatch) candidates.push({ type: 'cmd', index: cmdMatch.index, match: cmdMatch });

    if (candidates.length === 0) {
      if (remaining) segments.push({ type: 'text', content: remaining });
      break;
    }

    candidates.sort((a, b) => a.index - b.index);
    const earliest = candidates[0];

    if (earliest.index > 0) {
      segments.push({ type: 'text', content: remaining.slice(0, earliest.index) });
    }

    switch (earliest.type) {
      case 'code': {
        const afterOpen = remaining.slice(codeIdx + 3);
        const langEnd = afterOpen.indexOf('\n');
        const language = langEnd >= 0 ? afterOpen.slice(0, langEnd).trim() : '';
        const codeStartOffset = langEnd >= 0 ? langEnd + 1 : afterOpen.length;
        const codeStart = codeIdx + 3 + codeStartOffset;
        const closeIdx = remaining.indexOf('```', codeStart);
        if (closeIdx === -1) {
          segments.push({ type: 'code', language, content: remaining.slice(codeStart), incomplete: true });
          remaining = '';
        } else {
          segments.push({ type: 'code', language, content: remaining.slice(codeStart, closeIdx) });
          remaining = remaining.slice(closeIdx + 3);
        }
        break;
      }
      case 'file': {
        const filePath = earliest.match[1].trim();
        const afterTag = remaining.slice(earliest.index + earliest.match[0].length);
        const closeMatch = afterTag.match(/\[\s*\/\s*FILE\s*\]/);
        if (closeMatch) {
          let fileContent = afterTag.slice(0, closeMatch.index).trim();
          const mdBlock = /^```[a-zA-Z]*\n?([\s\S]*?)\n?```$/;
          const mdM = fileContent.match(mdBlock);
          if (mdM) fileContent = mdM[1];
          segments.push({ type: 'file_action', path: filePath, content: fileContent });
          remaining = afterTag.slice(closeMatch.index + closeMatch[0].length);
        } else {
          segments.push({ type: 'file_action', path: filePath, content: afterTag.trim(), incomplete: true });
          remaining = '';
        }
        break;
      }
      case 'delete': {
        segments.push({ type: 'delete_action', path: earliest.match[1].trim() });
        remaining = remaining.slice(earliest.index + earliest.match[0].length);
        break;
      }
      case 'mkdir': {
        segments.push({ type: 'mkdir_action', path: earliest.match[1].trim() });
        remaining = remaining.slice(earliest.index + earliest.match[0].length);
        break;
      }
      case 'cmd': {
        segments.push({ type: 'terminal_action', command: earliest.match[1].trim() });
        remaining = remaining.slice(earliest.index + earliest.match[0].length);
        break;
      }
      default:
        remaining = remaining.slice(1);
    }
  }
  return segments;
};

const suggestFileName = (language) => {
  const map = { html: 'index.html', css: 'style.css', javascript: 'script.js', js: 'script.js', python: 'main.py', typescript: 'index.ts', json: 'data.json', jsx: 'App.jsx', tsx: 'App.tsx', php: 'index.php', go: 'main.go', rust: 'main.rs', java: 'Main.java', sql: 'query.sql', bash: 'script.sh', sh: 'script.sh', bat: 'script.bat', yaml: 'config.yaml', yml: 'config.yml', xml: 'data.xml', scss: 'style.scss', vue: 'App.vue', svelte: 'App.svelte', md: 'README.md', markdown: 'README.md' };
  return map[language] || 'dosya.txt';
};

const CodeBlock = ({ language, code, incomplete, currentDirPath, currentDirHandle, onFileChange }) => {
  const [copied, setCopied] = useState(false);
  const [showSave, setShowSave] = useState(false);
  const [fileName, setFileName] = useState('');
  const [saveStatus, setSaveStatus] = useState(null);

  const canSave = !!(currentDirPath || currentDirHandle);

  const handleCopy = () => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleSaveToggle = () => {
    if (!showSave) setFileName(suggestFileName(language));
    setShowSave(!showSave);
    setSaveStatus(null);
  };

  const handleSaveFile = async () => {
    if (!fileName.trim() || !canSave) return;
    setSaveStatus('saving');
    try {
      if (currentDirPath) {
        const fullPath = currentDirPath + '\\' + fileName.trim().replace(/\//g, '\\');
        const res = await fetch('http://localhost:3001/api/save-file', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: fullPath, content: code })
        });
        if (!res.ok) throw new Error();
      } else {
        await fsaaWriteFile(currentDirHandle, fileName.trim(), code);
      }
      setSaveStatus('saved');
      setTimeout(() => onFileChange?.(), 300);
      setTimeout(() => { setShowSave(false); setSaveStatus(null); }, 2000);
    } catch {
      setSaveStatus('error');
    }
  };

  const lines = code.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();

  return (
    <div className={`code-block${incomplete ? ' code-block-incomplete' : ''}`}>
      <div className="code-block-header">
        <span className="code-block-lang">{language || 'code'}</span>
        <div className="code-header-actions">
          {canSave && (
            <button className="code-copy-btn" onClick={handleSaveToggle} title="Dosya olarak kaydet">
              <FileCode size={12} />
              <span>Kaydet</span>
            </button>
          )}
          <button className="code-copy-btn" onClick={handleCopy} title="Kopyala">
            {copied ? <Check size={12} /> : <Copy size={12} />}
            <span>{copied ? 'Kopyalandı' : 'Kopyala'}</span>
          </button>
        </div>
      </div>
      {showSave && (
        <div className="save-file-bar">
          <FileCode size={12} className="save-file-icon" />
          <input
            type="text"
            value={fileName}
            onChange={(e) => setFileName(e.target.value)}
            placeholder="dosya-adi.uzanti"
            className="save-file-input"
            onKeyDown={(e) => e.key === 'Enter' && handleSaveFile()}
          />
          {saveStatus === 'saved' ? (
            <span className="save-status saved"><Check size={12} /> Kaydedildi</span>
          ) : saveStatus === 'error' ? (
            <span className="save-status error"><AlertTriangle size={12} /> Hata</span>
          ) : (
            <button className="save-file-btn" onClick={handleSaveFile} disabled={saveStatus === 'saving'}>
              {saveStatus === 'saving' ? <Loader2 size={12} className="spin" /> : <Check size={12} />}
              {saveStatus === 'saving' ? 'Kaydediliyor...' : 'Kaydet'}
            </button>
          )}
          <button className="save-file-cancel" onClick={() => setShowSave(false)}>
            <X size={12} />
          </button>
        </div>
      )}
      <div className="code-block-body">
        {lines.map((line, i) => (
          <div key={i} className="code-line">
            <span className="line-number">{i + 1}</span>
            <span className="line-content">{line || ' '}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

const FileActionBlock = ({ path: filePath, content, incomplete, actionId, state, onApprove, onReject }) => {
  const [collapsed, setCollapsed] = useState(false);
  const lang = getLanguageFromPath(filePath);
  const lines = (content || '').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const status = state?.status || 'pending';
  const stateClass = status !== 'pending' ? ` state-${status}` : '';

  return (
    <div className={`action-block file-action${stateClass}`}>
      <div className="action-block-header">
        <div className="action-header-info" onClick={() => setCollapsed(!collapsed)} style={{ cursor: 'pointer' }}>
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          <FileCode size={14} />
          <span className="action-path">{filePath}</span>
          <span className="action-lang">{lang}</span>
        </div>
        {!incomplete && status === 'pending' && (
          <div className="action-buttons">
            <button className="action-btn approve" onClick={() => onApprove(actionId, { type: 'file_action', path: filePath, content })}>
              <Check size={12} /> Uygula
            </button>
            <button className="action-btn reject" onClick={() => onReject(actionId)}>
              <X size={12} /> Reddet
            </button>
          </div>
        )}
        {status === 'running' && <span className="action-status running"><Loader2 size={12} className="spin" /> Uygulanıyor...</span>}
        {status === 'done' && <span className="action-status done"><Check size={12} /> Uygulandı</span>}
        {status === 'rejected' && <span className="action-status rejected">Reddedildi</span>}
        {status === 'error' && <span className="action-status error"><AlertTriangle size={12} /> {state.error}</span>}
      </div>
      {!collapsed && content && (
        <div className="code-block-body file-code-preview">
          {lines.map((line, i) => (
            <div key={i} className="code-line">
              <span className="line-number">{i + 1}</span>
              <span className="line-content">{line || ' '}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

const DeleteActionBlock = ({ path: filePath, actionId, state, onApprove, onReject }) => {
  const status = state?.status || 'pending';
  const stateClass = status !== 'pending' ? ` state-${status}` : '';

  return (
    <div className={`action-block delete-action${stateClass}`}>
      <div className="action-block-header">
        <div className="action-header-info">
          <Trash2 size={14} />
          <span className="action-path">{filePath}</span>
          <span className="action-label danger-label">Silme</span>
        </div>
        {status === 'pending' && (
          <div className="action-buttons">
            <button className="action-btn approve danger" onClick={() => onApprove(actionId, { type: 'delete_action', path: filePath })}>
              <Trash2 size={12} /> Sil
            </button>
            <button className="action-btn reject" onClick={() => onReject(actionId)}>
              <X size={12} /> İptal
            </button>
          </div>
        )}
        {status === 'running' && <span className="action-status running"><Loader2 size={12} className="spin" /> Siliniyor...</span>}
        {status === 'done' && <span className="action-status done"><Check size={12} /> Silindi</span>}
        {status === 'rejected' && <span className="action-status rejected">İptal edildi</span>}
        {status === 'error' && <span className="action-status error"><AlertTriangle size={12} /> {state.error}</span>}
      </div>
    </div>
  );
};

const MkdirActionBlock = ({ path: dirPath, actionId, state }) => {
  const status = state?.status || 'pending';
  const stateClass = status !== 'pending' ? ` state-${status}` : '';

  return (
    <div className={`action-block mkdir-action${stateClass}`}>
      <div className="action-block-header">
        <div className="action-header-info">
          <FolderPlus size={14} />
          <span className="action-path">{dirPath}</span>
        </div>
        {status === 'running' && <span className="action-status running"><Loader2 size={12} className="spin" /> Oluşturuluyor...</span>}
        {status === 'done' && <span className="action-status done"><Check size={12} /> Oluşturuldu</span>}
        {status === 'error' && <span className="action-status error"><AlertTriangle size={12} /> Hata</span>}
      </div>
    </div>
  );
};

const TerminalActionBlock = ({ command, actionId, state, onApprove, onReject, onContinue }) => {
  const status = state?.status || 'pending';
  const dangerous = isDangerousCommand(command);
  const stateClass = status !== 'pending' ? ` state-${status}` : '';
  const result = state?.result;
  const continued = state?.continued;
  const hasOutput = result && (result.stdout || result.stderr);
  const isSuccess = result?.exitCode === 0;

  return (
    <div className={`terminal-block${dangerous ? ' terminal-dangerous' : ''}${stateClass}`}>
      <div className="terminal-block-header">
        <div className="terminal-header-left">
          <TerminalIcon size={13} />
          <span className="terminal-header-title">Terminal</span>
          {status === 'running' && <Loader2 size={12} className="spin terminal-header-spinner" />}
          {status === 'done' && isSuccess && <Check size={12} className="terminal-header-success" />}
          {status === 'done' && !isSuccess && <AlertTriangle size={12} className="terminal-header-error" />}
          {status === 'error' && <AlertTriangle size={12} className="terminal-header-error" />}
        </div>
        <div className="terminal-header-right">
          {status === 'pending' && (
            <div className="terminal-header-actions">
              <button className="terminal-run-btn" onClick={() => onApprove(actionId, { type: 'terminal_action', command })}>
                <Play size={11} /> Çalıştır
              </button>
              <button className="terminal-skip-btn" onClick={() => onReject(actionId)}>
                <X size={11} /> Atla
              </button>
            </div>
          )}
          {status === 'rejected' && <span className="terminal-status-badge skipped">Atlandı</span>}
          {status === 'error' && <span className="terminal-status-badge errored">{state.error}</span>}
        </div>
      </div>

      {dangerous && status === 'pending' && (
        <div className="terminal-warning-bar">
          <AlertTriangle size={12} /> Bu komut tehlikeli olabilir. Çalıştırmadan önce kontrol edin.
        </div>
      )}

      <div className="terminal-body">
        <div className="terminal-prompt-line">
          <span className="terminal-prompt-symbol">❯</span>
          <span className="terminal-prompt-cmd">{command}</span>
        </div>

        {status === 'running' && (
          <div className="terminal-running-indicator">
            <Loader2 size={14} className="spin" />
            <span>Komut çalışıyor...</span>
          </div>
        )}

        {hasOutput && (
          <div className="terminal-output-area">
            {result.stdout && <pre className="terminal-stdout">{result.stdout}</pre>}
            {result.stderr && <pre className="terminal-stderr">{result.stderr}</pre>}
          </div>
        )}

        {result && (
          <div className={`terminal-exitcode-line ${isSuccess ? 'exit-success' : 'exit-failure'}`}>
            <span>Process exited with code {result.exitCode}</span>
          </div>
        )}
      </div>

      {status === 'done' && !continued && (
        <div className="terminal-continue-bar">
          <button className="terminal-continue-btn" onClick={() => onContinue(actionId, result, true)}>
            <Check size={12} /> Devam Et
          </button>
          <button className="terminal-error-btn" onClick={() => onContinue(actionId, result, false)}>
            <AlertTriangle size={12} /> Hatayı Bildir
          </button>
        </div>
      )}
      {continued && (
        <div className="terminal-continued-badge">
          <Check size={11} /> {continued === 'continue' ? 'Devam edildi' : 'Hata bildirildi'}
        </div>
      )}
    </div>
  );
};

const renderInlineText = (text) => {
  if (!text) return null;
  const regex = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  const parts = [];
  let lastIndex = 0;
  let m;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > lastIndex) parts.push(text.slice(lastIndex, m.index));
    const raw = m[0];
    if (raw.startsWith('`')) {
      parts.push(<code className="inline-code" key={m.index}>{raw.slice(1, -1)}</code>);
    } else {
      parts.push(<strong key={m.index}>{raw.slice(2, -2)}</strong>);
    }
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts.length > 0 ? parts : text;
};

const MessageContent = ({ content, messageIndex, actionStates, onApprove, onReject, onContinue, currentDirPath, currentDirHandle, onFileChange }) => {
  const parts = parseMessageParts(content);
  return (
    <div className="message-content">
      {parts.map((part, i) => {
        const actionId = `msg-${messageIndex}-part-${i}`;
        const state = actionStates?.[actionId];
        switch (part.type) {
          case 'code':
            return <CodeBlock key={i} language={part.language} code={part.content} incomplete={part.incomplete} currentDirPath={currentDirPath} currentDirHandle={currentDirHandle} onFileChange={onFileChange} />;
          case 'file_action':
            return <FileActionBlock key={i} path={part.path} content={part.content} incomplete={part.incomplete} actionId={actionId} state={state} onApprove={onApprove} onReject={onReject} />;
          case 'delete_action':
            return <DeleteActionBlock key={i} path={part.path} actionId={actionId} state={state} onApprove={onApprove} onReject={onReject} />;
          case 'mkdir_action':
            return <MkdirActionBlock key={i} path={part.path} actionId={actionId} state={state} />;
          case 'terminal_action':
            return <TerminalActionBlock key={i} command={part.command} actionId={actionId} state={state} onApprove={onApprove} onReject={onReject} onContinue={onContinue} />;
          default:
            return <span key={i} className="message-text">{renderInlineText(part.content)}</span>;
        }
      })}
    </div>
  );
};

const AIPanel = ({ currentDirPath, currentDirHandle, projectName, openTabs, activeTab, onFileChange }) => {
  const [messages, setMessages] = useState([
    { role: 'assistant', content: 'Merhaba! Ben StackMate AI asistanınım. Dosya oluşturma, silme ve terminal komutları çalıştırma yetkilerim var. Size nasıl yardımcı olabilirim?' }
  ]);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [includeProject, setIncludeProject] = useState(false);
  const [isConnected, setIsConnected] = useState(null);
  const [activeModel, setActiveModel] = useState(null);
  const [isProcessingPrompt, setIsProcessingPrompt] = useState(false);
  const [processingProgress, setProcessingProgress] = useState(0);
  const [actionStates, setActionStates] = useState({});

  const messagesEndRef = useRef(null);
  const abortControllerRef = useRef(null);
  const progressIntervalRef = useRef(null);
  const autoTriggeredRef = useRef(new Set());

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, actionStates]);

  useEffect(() => {
    const checkConnection = async () => {
      try {
        const res = await fetch(LM_STUDIO_MODELS_URL);
        if (res.ok) {
          const data = await res.json();
          setIsConnected(true);
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
    const interval = setInterval(checkConnection, 10000);
    return () => clearInterval(interval);
  }, []);

  const handleActionApprove = async (actionId, action) => {
    setActionStates(prev => ({ ...prev, [actionId]: { status: 'running' } }));
    try {
      const useBackend = !!currentDirPath;
      const useHandle = !useBackend && !!currentDirHandle;

      if (!useBackend && !useHandle && action.type !== 'terminal_action') {
        throw new Error('Klasör açılmamış — lütfen önce bir proje klasörü açın.');
      }

      switch (action.type) {
        case 'file_action': {
          if (useBackend) {
            const fullPath = currentDirPath + '\\' + action.path.replace(/\//g, '\\');
            const res = await fetch('http://localhost:3001/api/save-file', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ path: fullPath, content: action.content })
            });
            if (!res.ok) throw new Error('Dosya kaydedilemedi');
          } else {
            await fsaaWriteFile(currentDirHandle, action.path, action.content);
          }
          setActionStates(prev => ({ ...prev, [actionId]: { status: 'done' } }));
          setTimeout(() => onFileChange?.(), 300);
          break;
        }
        case 'delete_action': {
          if (useBackend) {
            const fullPath = currentDirPath + '\\' + action.path.replace(/\//g, '\\');
            const res = await fetch('http://localhost:3001/api/delete-file', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ path: fullPath })
            });
            if (!res.ok) throw new Error('Dosya silinemedi');
          } else {
            await fsaaDeleteFile(currentDirHandle, action.path);
          }
          setActionStates(prev => ({ ...prev, [actionId]: { status: 'done' } }));
          setTimeout(() => onFileChange?.(), 300);
          break;
        }
        case 'mkdir_action': {
          if (useBackend) {
            const fullPath = currentDirPath + '\\' + action.path.replace(/\//g, '\\');
            const res = await fetch('http://localhost:3001/api/mkdir', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ path: fullPath })
            });
            if (!res.ok) throw new Error('Klasör oluşturulamadı');
          } else {
            await fsaaMkdir(currentDirHandle, action.path);
          }
          setActionStates(prev => ({ ...prev, [actionId]: { status: 'done' } }));
          setTimeout(() => onFileChange?.(), 300);
          break;
        }
        case 'terminal_action': {
          if (!currentDirPath) {
            throw new Error('Terminal komutları çalıştırmak için backend modu gerekli — klasörü terminal üzerinden açın.');
          }
          const res = await fetch(AGENT_EXEC_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: action.command, cwd: currentDirPath })
          });
          const result = await res.json();
          setActionStates(prev => ({ ...prev, [actionId]: { status: 'done', result } }));
          break;
        }
      }
    } catch (err) {
      setActionStates(prev => ({ ...prev, [actionId]: { status: 'error', error: err.message } }));
    }
  };

  const handleActionReject = (actionId) => {
    setActionStates(prev => ({ ...prev, [actionId]: { status: 'rejected' } }));
  };

  const sendMessageProgrammatically = useRef(null);

  const handleTerminalContinue = (actionId, result, isSuccess) => {
    setActionStates(prev => ({
      ...prev,
      [actionId]: { ...prev[actionId], continued: isSuccess ? 'continue' : 'error' }
    }));

    const output = [
      result?.stdout ? result.stdout.trim() : '',
      result?.stderr ? result.stderr.trim() : ''
    ].filter(Boolean).join('\n');

    const truncated = output.length > 2000 ? output.slice(-2000) + '\n...(kısaltıldı)' : output;

    let feedbackMsg;
    if (isSuccess) {
      feedbackMsg = `[Terminal çıktısı - exit code: ${result?.exitCode ?? '?'}]\n\`\`\`\n${truncated || '(çıktı yok)'}\n\`\`\`\nKomut başarıyla tamamlandı, devam edebilirsin.`;
    } else {
      feedbackMsg = `[Terminal çıktısı - exit code: ${result?.exitCode ?? '?'}]\n\`\`\`\n${truncated || '(çıktı yok)'}\n\`\`\`\nKomutta hata var. Lütfen hatayı analiz et ve çözüm öner.`;
    }

    if (sendMessageProgrammatically.current) {
      sendMessageProgrammatically.current(feedbackMsg);
    }
  };

  // Auto-execute safe actions (mkdir, non-dangerous terminal commands)
  useEffect(() => {
    const lastMsg = messages[messages.length - 1];
    const lastIdx = messages.length - 1;
    if (!lastMsg || lastMsg.role !== 'assistant' || !currentDirPath) return;

    const parts = parseMessageParts(lastMsg.content);
    parts.forEach((part, partIdx) => {
      if (part.incomplete) return;
      const actionId = `msg-${lastIdx}-part-${partIdx}`;
      if (autoTriggeredRef.current.has(actionId)) return;

      if (part.type === 'mkdir_action') {
        autoTriggeredRef.current.add(actionId);
        handleActionApprove(actionId, part);
      }
    });
  }, [messages]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSend = async (overrideContent) => {
    const msgContent = overrideContent || input.trim();
    if (!msgContent || isTyping) return;

    const userMessage = { role: 'user', content: msgContent };
    const updatedMessages = [...messages, userMessage];
    setMessages(updatedMessages);
    if (!overrideContent) setInput('');
    setIsTyping(true);

    setIsProcessingPrompt(true);
    setProcessingProgress(0);
    progressIntervalRef.current = setInterval(() => {
      setProcessingProgress(prev => {
        const remaining = 99.99 - prev;
        const step = (remaining * 0.05) + (Math.random() * 1.5);
        return prev + step >= 99.99 ? 99.99 : prev + step;
      });
    }, 100);

    abortControllerRef.current = new AbortController();

    try {
      const apiMessages = [];
      const filtered = updatedMessages.filter(m =>
        !m.content.startsWith('(Yanıt alınamadı)') &&
        !m.content.startsWith('⚠️') &&
        !m.content.startsWith('❌')
      );

      for (let i = 0; i < filtered.length; i++) {
        const m = filtered[i];
        if (i === 0 && m.role === 'assistant') {
          apiMessages.push({ role: 'system', content: m.content });
        } else {
          const lastRole = apiMessages.length > 0 ? apiMessages[apiMessages.length - 1].role : null;
          if (lastRole === m.role && m.role !== 'system') {
            apiMessages[apiMessages.length - 1].content += '\n' + m.content;
          } else {
            apiMessages.push({ role: m.role, content: m.content });
          }
        }
      }

      const globalSysMsg = `Sen StackMate IDE'nin AI agent'ısın. Dosya ve terminal işlemlerini özel etiketlerle yaparsın.

KRİTİK KURAL: Kod yazdığında ASLA \`\`\`html veya \`\`\`css gibi markdown blokları kullanma! Dosya oluşturmak için HER ZAMAN [FILE: ...][/FILE] etiketlerini kullan.

ARAÇLAR:
[FILE: dosya.uzanti]kod buraya[/FILE]  → Dosya oluşturur
[DELETE_FILE: dosya.uzanti]           → Dosya siler
[MKDIR: klasor]                       → Klasör oluşturur
[CMD: komut]                          → Terminal komutu çalıştırır

DOĞRU ÖRNEK:
Kullanıcı: "bir login sayfası oluştur"
Yanıt: Login sayfanızı oluşturuyorum:
[FILE: login.html]
<!DOCTYPE html>
<html><head><title>Login</title></head>
<body><form><input type="text"><button>Giriş</button></form></body>
</html>
[/FILE]
login.html dosyası oluşturuldu.

YANLIŞ ÖRNEK (ASLA YAPMA):
\`\`\`html
<html>...</html>
\`\`\`
↑ Bu YANLIŞ! Markdown kod blokları dosya oluşturmaz!

TERMİNAL KURALLARI:
- Terminal komutu çalıştırmak için [CMD: komut] kullan.
- BİR MESAJDA SADECE BİR [CMD:] etiketi kullan!
- Komut çalıştırdıktan sonra DUR ve kullanıcının çıktıyı onaylamasını bekle.
- Kullanıcı çıktıyı paylaştığında analiz et: başarılıysa sonraki adıma geç, hata varsa çözüm öner.
- Birden fazla komut gerekiyorsa her birini ayrı adımda çalıştır — hepsini tek seferde yazma.

GENEL KURALLAR:
- Dosya oluştururken SADECE [FILE: ...][/FILE] kullan, \`\`\`html KULLANMA.
- Her dosya için ayrı [FILE:] etiketi aç, iç içe kullanma.
- "Dosya oluşturamam" gibi bahaneler üretme.
- İşlem sonrası ne yaptığını kısaca açıkla.`;

      apiMessages.unshift({ role: 'system', content: globalSysMsg });

      let openFilesContext = '';
      if (openTabs && openTabs.length > 0) {
        openFilesContext = 'AÇIK DOSYALAR (IDE\'de şu an aktif):\n';
        for (const tab of openTabs) {
          openFilesContext += `\n[DOSYA BAŞI: ${tab.name}]\n${tab.content || '(Boş Dosya)'}\n[DOSYA SONU: ${tab.name}]\n`;
        }
      }

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

      if (openFilesContext || fullProjectContext) {
        const systemContextInjection = `\n\n=== IDE SİSTEM BİLGİSİ ===\n${openFilesContext}\n${fullProjectContext}\n====================\n\nYukarıdaki dosya bilgilerini referans alarak cevap ver.`;
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
          max_tokens: 4096,
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

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let assistantContent = '';

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

  sendMessageProgrammatically.current = handleSend;

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
    setActionStates({});
    autoTriggeredRef.current.clear();
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
          <span>StackMate AGENT</span>
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
          {activeModel}
        </div>
      )}

      {isConnected === false && (
        <div className="connection-warning">
          LM Studio bağlantısı yok. <code>http://127.0.0.1:1234</code> adresinde çalıştığından emin olun.
        </div>
      )}

      {projectName && currentDirPath && (
        <div className="project-context-toggle" onClick={() => setIncludeProject(!includeProject)}>
          <input type="checkbox" checked={includeProject} readOnly />
          <span>Proje Analizi: <strong>{projectName}</strong></span>
        </div>
      )}

      <div className="messages-container">
        {messages.map((message, index) => (
          <div
            key={index}
            className={`message ${message.role === 'user' ? 'user-message' : 'assistant-message'}`}
          >
            <div className="message-header">
              {message.role === 'assistant' ? (
                <>
                  <Bot size={14} className="message-author-icon" />
                  <span>{activeModel ? activeModel.split('/').pop() : 'AI'}</span>
                </>
              ) : (
                <>
                  <span>Sen</span>
                  <User size={14} className="message-author-icon" />
                </>
              )}
            </div>
            <div className="message-body">
              {message.role === 'assistant' ? (
                <MessageContent
                  content={message.content}
                  messageIndex={index}
                  actionStates={actionStates}
                  onApprove={handleActionApprove}
                  onReject={handleActionReject}
                  onContinue={handleTerminalContinue}
                  currentDirPath={currentDirPath}
                  currentDirHandle={currentDirHandle}
                  onFileChange={onFileChange}
                />
              ) : (
                <p>{message.content}</p>
              )}
            </div>
          </div>
        ))}
        {isTyping && messages[messages.length - 1]?.content === '' && (
          <div className="message assistant-message">
            <div className="message-header">
              <Bot size={14} className="message-author-icon" />
              <span>AI</span>
            </div>
            <div className="message-body">
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
        <div className="input-wrapper">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyPress}
            placeholder={isConnected === false ? 'LM Studio bağlantısı yok...' : 'Mesajınızı yazın...'}
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
              <Send size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default AIPanel;
