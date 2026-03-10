import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Send, Bot, User, Loader2, Trash2, Eraser, Copy, Check, X,
  FileCode, FolderPlus, Terminal as TerminalIcon, Play, AlertTriangle,
  ChevronDown, ChevronRight
} from 'lucide-react';
import './AIPanel.css';

// ─── Sabitler ────────────────────────────────────────────────────────────────
const LM_STUDIO_URL = 'http://localhost:3001/api/ai-chat';
const LM_STUDIO_MODELS_URL = 'http://localhost:3001/api/ai-models';
const OS_URL = 'http://localhost:3001/api/os';
const READ_DIR_URL = 'http://localhost:3001/api/read-dir';

const TOKEN_SAVE_THRESHOLD = 12;
const TOKEN_SAVE_KEEP_LAST = 8;
const CONNECTION_POLL_MS = 10_000;
const PROGRESS_TIMEOUT_MS = 6_000;

// ─── Yardımcı Fonksiyonlar ──────────────────────────────────────────────────
const formatDirTree = (node, indent = '') => {
  const prefix = node.type === 'folder' ? node.name + '/' : node.name;
  let s = indent + prefix + '\n';
  if (node.children?.length) {
    for (const c of node.children) s += formatDirTree(c, indent + '  ');
  }
  return s;
};

const EXT_LANG_MAP = {
  js: 'javascript', jsx: 'jsx', ts: 'typescript', tsx: 'tsx',
  py: 'python', rb: 'ruby', java: 'java', go: 'go', rs: 'rust',
  html: 'html', css: 'css', scss: 'scss', json: 'json', xml: 'xml',
  md: 'markdown', yaml: 'yaml', yml: 'yaml', sh: 'bash', bat: 'batch',
  sql: 'sql', php: 'php', c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
  vue: 'vue', svelte: 'svelte', cjs: 'javascript', mjs: 'javascript',
};
const getLanguageFromPath = (p) => EXT_LANG_MAP[(p.split('.').pop() || '').toLowerCase()] || 'code';

const getFileTypeLabel = (p) => {
  const ext = (p.split('.').pop() || '').toLowerCase();
  if (['js', 'jsx', 'cjs', 'mjs', 'ts', 'tsx'].includes(ext)) return 'JS';
  if (ext === 'html') return 'HTML';
  if (['css', 'scss'].includes(ext)) return 'CSS';
  if (ext === 'py') return 'PY';
  if (ext === 'json') return 'JSON';
  if (ext === 'md') return 'MD';
  return ext.toUpperCase() || 'FILE';
};

const suggestFileName = (language) => {
  const map = {
    html: 'index.html', css: 'style.css', javascript: 'script.js', js: 'script.js',
    python: 'main.py', typescript: 'index.ts', json: 'data.json', jsx: 'App.jsx',
    tsx: 'App.tsx', php: 'index.php', go: 'main.go', rust: 'main.rs',
    java: 'Main.java', sql: 'query.sql', bash: 'script.sh', sh: 'script.sh',
    bat: 'script.bat', yaml: 'config.yaml', yml: 'config.yml', xml: 'data.xml',
    scss: 'style.scss', vue: 'App.vue', svelte: 'App.svelte', md: 'README.md',
    markdown: 'README.md',
  };
  return map[language] || 'dosya.txt';
};

const DANGEROUS_PATTERNS = [
  /\brm\s/, /\brmdir\s/, /\bdel\s/, /\bformat\s/, /\brd\s/,
  /--force/, /\bdrop\s/, /\btruncate\s/, /\bsudo\s/, /\bmkfs/, /\bdd\s/,
];
const isDangerousCommand = (cmd) => DANGEROUS_PATTERNS.some(p => p.test(cmd.toLowerCase()));

// ─── Yol çözümleme: AI'dan gelen göreceli/mutlak yolları güvenli şekilde birleştirir ──
const resolveActionPath = (baseDirPath, actionPath) => {
  if (!baseDirPath || !actionPath) return actionPath;
  let p = actionPath.replace(/\//g, '\\').replace(/^\\+/, '');
  // Mutlak yolsa (C:\... veya D:\...) doğrudan döndür
  if (/^[A-Za-z]:\\/.test(p)) return p;
  // Proje klasör adı zaten yolda varsa çıkar (örn: "smartify/pages/x.html" → "pages/x.html")
  const baseName = baseDirPath.replace(/\\/g, '/').split('/').pop();
  if (baseName && p.toLowerCase().startsWith(baseName.toLowerCase() + '\\')) {
    p = p.slice(baseName.length + 1);
  }
  // Baştaki gereksiz ayırıcıları temizle
  p = p.replace(/^[\\/]+/, '');
  return baseDirPath + '\\' + p;
};

const normalizeTerminalCommand = (cmd) =>
  typeof cmd === 'string' ? cmd.replace(/^\s*cmd\s*:\s*/i, '').trim() : cmd;

const stripCodeFence = (s) => {
  if (typeof s !== 'string') return s;
  const t = s.trim();
  const m = t.match(/^```[a-zA-Z0-9]*\n?([\s\S]*?)\n?```$/);
  if (m) return m[1].trim();
  if (t.startsWith('`') && t.endsWith('`') && t.length > 1) {
    const inner = t.slice(1, -1).trim();
    if (!inner.includes('`')) return inner;
  }
  return t;
};

// ─── FSAA (File System Access API) yardımcıları ─────────────────────────────
const fsaResolvePath = async (dirHandle, relativePath, { create = false } = {}) => {
  const parts = relativePath.replace(/\\/g, '/').split('/').filter(Boolean);
  const fileName = parts.pop();
  let dir = dirHandle;
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create });
  return { dir, fileName };
};

const fsaaWriteFile = async (dirHandle, relativePath, content) => {
  const { dir, fileName } = await fsaResolvePath(dirHandle, relativePath, { create: true });
  const fileHandle = await dir.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
};

const fsaaDeleteFile = async (dirHandle, relativePath) => {
  const { dir, fileName } = await fsaResolvePath(dirHandle, relativePath);
  await dir.removeEntry(fileName, { recursive: false });
};

const fsaaMkdir = async (dirHandle, relativePath) => {
  const parts = relativePath.replace(/\\/g, '/').split('/').filter(Boolean);
  let dir = dirHandle;
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
};

// ─── Diff hesaplama ──────────────────────────────────────────────────────────
const computeInlineDiff = (oldText, newText) => {
  const oldLines = (oldText || '').split(/\r?\n/);
  const newLines = (newText || '').split(/\r?\n/);
  let prefixEnd = 0;
  while (prefixEnd < oldLines.length && prefixEnd < newLines.length && oldLines[prefixEnd] === newLines[prefixEnd]) prefixEnd++;
  let suffixOld = oldLines.length;
  let suffixNew = newLines.length;
  while (suffixOld > prefixEnd && suffixNew > prefixEnd && oldLines[suffixOld - 1] === newLines[suffixNew - 1]) { suffixOld--; suffixNew--; }
  const segments = [];
  for (let i = 0; i < prefixEnd; i++) segments.push({ type: 'context', line: oldLines[i] });
  for (let i = prefixEnd; i < suffixOld; i++) segments.push({ type: 'remove', line: oldLines[i] });
  for (let i = prefixEnd; i < suffixNew; i++) segments.push({ type: 'add', line: newLines[i] });
  for (let i = suffixNew; i < newLines.length; i++) segments.push({ type: 'context', line: newLines[i] });
  return { segments, addCount: Math.max(0, suffixNew - prefixEnd), removeCount: Math.max(0, suffixOld - prefixEnd) };
};

// ─── Mesaj ayrıştırma ────────────────────────────────────────────────────────
const parseMessageParts = (content) => {
  const segments = [];
  let remaining = content;

  while (remaining.length > 0) {
    const candidates = [];

    const codeIdx = remaining.indexOf('```');
    if (codeIdx !== -1) candidates.push({ type: 'code', index: codeIdx });

    const fileMatch = remaining.match(/\[\s*FILE:\s*([^\]]+?)\s*\]/);
    const delMatch = remaining.match(/\[\s*DELETE_FILE:\s*([^\]]+?)\s*\]/);
    const mkdirMatch = remaining.match(/\[\s*MKDIR:\s*([^\]]+?)\s*\]/);
    const cmdMatch = remaining.match(/\[\s*CMD:\s*([^\]]+?)\s*\]/);
    const editMatch = remaining.match(/\[\s*EDIT:\s*([^\]]+?)\s*\]/);

    if (fileMatch) candidates.push({ type: 'file', index: fileMatch.index, match: fileMatch });
    if (delMatch) candidates.push({ type: 'delete', index: delMatch.index, match: delMatch });
    if (mkdirMatch) candidates.push({ type: 'mkdir', index: mkdirMatch.index, match: mkdirMatch });
    if (cmdMatch) candidates.push({ type: 'cmd', index: cmdMatch.index, match: cmdMatch });
    if (editMatch) candidates.push({ type: 'edit', index: editMatch.index, match: editMatch });

    // Bare CMD (köşeli parantez olmadan)
    if (!cmdMatch) {
      const bareCmdMatch = remaining.match(/^[ \t]*CMD:\s*(.+)$/m);
      if (bareCmdMatch) candidates.push({ type: 'bare_cmd', index: bareCmdMatch.index, match: bareCmdMatch });
    }

    // Model iç token formatı
    const modelCmdMatch = remaining.match(/(?:<\|channel\|>|<channel\s*\/?>)\s*commentary\s+to=(?:CMD|container\.exec|assistant)\s*[^<]*(?:<\|constrain\|>\s*json\s*)?<\|message\|>(\{[\s\S]*?\})/);
    const modelCmdMatch2 = remaining.match(/<\|message\|>\s*(\{\s*"cmd"\s*:\s*\[[\s\S]*\]\s*\})/);
    if (modelCmdMatch) candidates.push({ type: 'model_cmd', index: modelCmdMatch.index, match: modelCmdMatch });
    else if (modelCmdMatch2) candidates.push({ type: 'model_cmd', index: modelCmdMatch2.index, match: modelCmdMatch2 });

    if (candidates.length === 0) {
      if (remaining) segments.push({ type: 'text', content: remaining });
      break;
    }

    candidates.sort((a, b) => a.index - b.index);
    const earliest = candidates[0];

    if (earliest.index > 0) segments.push({ type: 'text', content: remaining.slice(0, earliest.index) });

    switch (earliest.type) {
      case 'code': {
        const afterOpen = remaining.slice(codeIdx + 3);
        const langEnd = afterOpen.indexOf('\n');
        const language = langEnd >= 0 ? afterOpen.slice(0, langEnd).trim() : '';
        const codeStartOffset = langEnd >= 0 ? langEnd + 1 : afterOpen.length;
        const codeStart = codeIdx + 3 + codeStartOffset;
        const closeIdx = remaining.indexOf('```', codeStart);

        if (closeIdx !== -1) {
          const innerContent = remaining.slice(codeStart, closeIdx);
          const cmdOnlyMatch = innerContent.match(/^\s*\[\s*CMD\s*:\s*([^\]]+?)\s*\]\s*$/im);
          if (cmdOnlyMatch) {
            segments.push({ type: 'terminal_action', command: normalizeTerminalCommand(cmdOnlyMatch[1]) });
            remaining = remaining.slice(closeIdx + 3);
            break;
          }
          const lang = (language || '').toLowerCase();
          if (['cmd', 'bash', 'sh', 'shell'].includes(lang) && !/\[\s*(?:FILE|EDIT|MKDIR|DELETE_FILE)\s*[:\]]/i.test(innerContent)) {
            const cmd = normalizeTerminalCommand(innerContent.trim());
            if (cmd.length > 0 && cmd.length < 3000) {
              segments.push({ type: 'terminal_action', command: cmd });
              remaining = remaining.slice(closeIdx + 3);
              break;
            }
          }
          if (/\[\s*(?:FILE|EDIT|CMD|MKDIR|DELETE_FILE|OLD|NEW)\s*(?::|\])/i.test(innerContent)) {
            remaining = remaining.slice(0, codeIdx) + innerContent.trim() + remaining.slice(closeIdx + 3);
            continue;
          }
          segments.push({ type: 'code', language, content: innerContent });
          remaining = remaining.slice(closeIdx + 3);
        } else {
          segments.push({ type: 'code', language, content: remaining.slice(codeStart), incomplete: true });
          remaining = '';
        }
        break;
      }
      case 'file': {
        const filePath = earliest.match[1].trim();
        const afterTag = remaining.slice(earliest.index + earliest.match[0].length);
        const closeMatch = afterTag.match(/\[\s*\/\s*FILE\s*\]/);
        if (closeMatch) {
          let fileContent = afterTag.slice(0, closeMatch.index).trim();
          const mdM = fileContent.match(/^```[a-zA-Z]*\n?([\s\S]*?)\n?```$/);
          if (mdM) fileContent = mdM[1];
          segments.push({ type: 'file_action', path: filePath, content: fileContent });
          remaining = afterTag.slice(closeMatch.index + closeMatch[0].length);
        } else {
          segments.push({ type: 'file_action', path: filePath, content: afterTag.trim(), incomplete: true });
          remaining = '';
        }
        break;
      }
      case 'delete':
        segments.push({ type: 'delete_action', path: earliest.match[1].trim() });
        remaining = remaining.slice(earliest.index + earliest.match[0].length);
        break;
      case 'mkdir':
        segments.push({ type: 'mkdir_action', path: earliest.match[1].trim() });
        remaining = remaining.slice(earliest.index + earliest.match[0].length);
        break;
      case 'cmd':
      case 'bare_cmd':
        segments.push({ type: 'terminal_action', command: normalizeTerminalCommand(earliest.match[1]) });
        remaining = remaining.slice(earliest.index + earliest.match[0].length);
        break;
      case 'edit': {
        const editPath = earliest.match[1].trim();
        const afterEditTag = remaining.slice(earliest.index + earliest.match[0].length);
        const editCloseMatch = afterEditTag.match(/\[\s*\/\s*EDIT\s*\]/i);
        if (editCloseMatch) {
          let editBody = afterEditTag.slice(0, editCloseMatch.index).trim();
          const mdM = editBody.match(/^```[a-zA-Z]*\n?([\s\S]*?)\n?```$/);
          if (mdM) editBody = mdM[1].trim();

          let oldTextVal = '', newTextVal = '';
          const oldMatch = editBody.match(/\[\s*OLD\s*\]\s*([\s\S]*?)\s*\[\s*\/\s*OLD\s*\]/i);
          const newMatch = editBody.match(/\[\s*NEW\s*\]\s*([\s\S]*?)\s*\[\s*\/\s*NEW\s*\]/i);

          if (oldMatch && newMatch) {
            oldTextVal = stripCodeFence(oldMatch[1].trim());
            newTextVal = stripCodeFence(newMatch[1].trim());
          } else {
            const idxOld = editBody.search(/\[\s*OLD\s*\]/i);
            const idxNew = editBody.search(/\[\s*NEW\s*\]/i);
            if (idxOld !== -1 && idxNew > idxOld) {
              const oldTag = editBody.slice(idxOld).match(/\[\s*OLD\s*\]/i);
              const newTag = editBody.slice(idxNew).match(/\[\s*NEW\s*\]/i);
              if (oldTag && newTag) {
                const afterOld = editBody.slice(idxOld + oldTag[0].length);
                const newIdxInAfter = afterOld.search(/\[\s*NEW\s*\]/i);
                oldTextVal = stripCodeFence((newIdxInAfter === -1 ? afterOld : afterOld.slice(0, newIdxInAfter)).trim());
                newTextVal = stripCodeFence(editBody.slice(idxNew + newTag[0].length).trim());
              }
            }
          }

          if (oldTextVal !== '' || newTextVal !== '') {
            segments.push({ type: 'edit_action', path: editPath, oldText: oldTextVal, newText: newTextVal });
          } else {
            segments.push({ type: 'text', content: `[EDIT: ${editPath}]\n${editBody}\n[/EDIT]` });
          }
          remaining = afterEditTag.slice(editCloseMatch.index + editCloseMatch[0].length);
        } else {
          remaining = afterEditTag;
        }
        break;
      }
      case 'model_cmd': {
        try {
          const json = JSON.parse(earliest.match[1]);
          const shellArgs = ['bash', 'sh', 'cmd', 'cmd.exe', 'powershell', '-lc', '-c', '-l', '/c'];
          let cmd = '';
          if (Array.isArray(json.cmd)) cmd = json.cmd.filter(c => !shellArgs.includes(c)).join(' ');
          else if (typeof json.cmd === 'string') cmd = json.cmd;
          else if (typeof json.command === 'string') cmd = json.command;
          if (cmd.trim()) segments.push({ type: 'terminal_action', command: normalizeTerminalCommand(cmd) });
        } catch (_) { /* JSON parse hatası — atla */ }
        remaining = remaining.slice(earliest.index + earliest.match[0].length);
        break;
      }
      default:
        remaining = remaining.slice(1);
    }
  }
  return segments;
};

// ─── Alt Bileşenler ──────────────────────────────────────────────────────────
const renderInlineText = (text) => {
  if (!text) return null;
  const regex = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  const parts = [];
  let lastIndex = 0, m;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > lastIndex) parts.push(text.slice(lastIndex, m.index));
    const raw = m[0];
    parts.push(raw.startsWith('`')
      ? <code className="inline-code" key={m.index}>{raw.slice(1, -1)}</code>
      : <strong key={m.index}>{raw.slice(2, -2)}</strong>
    );
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts.length > 0 ? parts : text;
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
    setShowSave(v => !v);
    setSaveStatus(null);
  };

  const handleSaveFile = async () => {
    if (!fileName.trim() || !canSave) return;
    setSaveStatus('saving');
    try {
      if (currentDirPath) {
        const res = await fetch('http://localhost:3001/api/save-file', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: resolveActionPath(currentDirPath, fileName.trim()), content: code }),
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
              <FileCode size={12} /><span>Kaydet</span>
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
            type="text" value={fileName} onChange={(e) => setFileName(e.target.value)}
            placeholder="dosya-adi.uzanti" className="save-file-input"
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
          <button className="save-file-cancel" onClick={() => setShowSave(false)}><X size={12} /></button>
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
        <div className="action-header-info" onClick={() => setCollapsed(v => !v)} style={{ cursor: 'pointer' }}>
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          <FileCode size={14} />
          <span className="action-path">{filePath}</span>
          <span className="action-lang">{lang}</span>
        </div>
        {!incomplete && (status === 'pending' || status === 'auto_applied') && (
          <div className="action-buttons">
            <button className="action-btn approve"
              onClick={() => status === 'auto_applied'
                ? onApprove(actionId, { type: 'mark_done' })
                : onApprove(actionId, { type: 'file_action', path: filePath, content })}>
              <Check size={12} /> {status === 'auto_applied' ? 'Kaydet' : 'Uygula'}
            </button>
            <button className="action-btn reject"
              onClick={() => onReject(actionId, status === 'auto_applied', { type: 'file_action', path: filePath })}>
              <X size={12} /> {status === 'auto_applied' ? 'Geri Al' : 'Reddet'}
            </button>
          </div>
        )}
        {status === 'running' && <span className="action-status running"><Loader2 size={12} className="spin" /> Uygulanıyor...</span>}
        {status === 'done' && <span className="action-status done"><Check size={12} /> Uygulandı</span>}
        {status === 'auto_applied' && <span className="action-status auto-applied" style={{ marginLeft: 'auto', fontSize: '11px', color: '#8b949e' }}>Geçici olarak oluşturuldu</span>}
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
  return (
    <div className={`action-block delete-action${status !== 'pending' ? ` state-${status}` : ''}`}>
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
  return (
    <div className={`action-block mkdir-action${status !== 'pending' ? ` state-${status}` : ''}`}>
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

const EditActionBlock = ({ path: filePath, oldText, newText, actionId, state, onApprove, onReject }) => {
  const status = state?.status || 'pending';
  const displayName = filePath.replace(/^.*[/\\]/, '') || filePath;
  const { segments, addCount, removeCount } = computeInlineDiff(oldText, newText);

  return (
    <div className={`action-block edit-action-block${status !== 'pending' ? ` state-${status}` : ''}`}>
      <div className="action-block-header edit-diff-header">
        <div className="action-header-info">
          <FileCode size={14} />
          <span className="action-path edit-diff-title">
            <span className="edit-diff-filetype">{getFileTypeLabel(filePath)}</span>
            <span className="edit-diff-filename">{displayName}</span>
            {(addCount > 0 || removeCount > 0) && (
              <span className="edit-diff-stats">+{addCount} −{removeCount}</span>
            )}
          </span>
        </div>
        {status === 'pending' && (
          <div className="action-buttons">
            <button className="action-btn approve" onClick={() => onApprove(actionId, { type: 'edit_action', path: filePath, oldText, newText })}>
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
      <div className="edit-diff-single">
        {segments.map((item, idx) => (
          <div key={idx} className={`edit-diff-line edit-diff-${item.type}`}>
            <span className="edit-diff-content">{item.line || ' '}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

const ERROR_PATTERNS = ['Error:', 'error:', 'ERR!', 'EADDRINUSE', 'MODULE_NOT_FOUND', 'Cannot find module', 'SyntaxError', 'TypeError', 'ReferenceError', 'ENOENT', 'command not found', 'is not recognized', 'hata', 'bulunamadı', 'başarısız'];
const SUCCESS_PATTERNS = ['listening on', 'ready', 'started', 'running on', 'compiled', 'Local:', 'http://localhost', 'http://127.0.0.1', 'Server running', 'serving', 'VITE', 'webpack compiled', 'Successfully compiled', 'çalışıyor', 'portunda', 'dinliyor', 'başlatıldı', 'hazır', ':3000', ':3001', ':4000', ':5000', ':5173', ':8000', ':8080', ':8888'];

const TerminalActionBlock = ({ command, actionId, state, onApprove, onReject, onContinue }) => {
  const status = state?.status || 'pending';
  const dangerous = isDangerousCommand(command);
  const result = state?.result;
  const continued = state?.continued;
  const hasOutput = result && (result.stdout || result.stderr);
  const isSuccess = result?.exitCode === 0;

  return (
    <div className={`terminal-block${dangerous ? ' terminal-dangerous' : ''}${status !== 'pending' ? ` state-${status}` : ''}`}>
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
              <button className="terminal-skip-btn" onClick={() => onReject(actionId, false, { type: 'terminal_action', command })}>
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
        {status === 'pending' && (
          <div className="terminal-pending-indicator">
            <AlertTriangle size={14} />
            <span>Komut henüz çalıştırılmadı. Devam etmek için <strong>Çalıştır</strong> veya <strong>Atla</strong> seçin.</span>
          </div>
        )}
        {status === 'running' && (
          <div className="terminal-running-indicator">
            <Loader2 size={14} className="spin" />
            <span>Komut çalışıyor... Sonuç gelene kadar bekleyin.</span>
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

      {/* Devam Et / Hata Bildir — SADECE kullanıcı butonuna basarak tetiklenir */}
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
          case 'edit_action':
            return <EditActionBlock key={i} path={part.path} oldText={part.oldText} newText={part.newText} actionId={actionId} state={state} onApprove={onApprove} onReject={onReject} />;
          default:
            return <span key={i} className="message-text">{renderInlineText(part.content)}</span>;
        }
      })}
    </div>
  );
};

// ─── Ana Bileşen ─────────────────────────────────────────────────────────────
const AIPanel = ({ currentDirPath, currentDirHandle, projectName, openTabs, activeTab, onFileChange }) => {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [isConnected, setIsConnected] = useState(null);
  const [activeModel, setActiveModel] = useState(null);
  const [isProcessingPrompt, setIsProcessingPrompt] = useState(false);
  const [processingProgress, setProcessingProgress] = useState(0);
  const [actionStates, setActionStates] = useState({});
  const [exploredFiles, setExploredFiles] = useState([]);
  const [exploredFilesOpen, setExploredFilesOpen] = useState(true);

  const messagesEndRef = useRef(null);
  const messagesContainerRef = useRef(null);
  const abortControllerRef = useRef(null);
  const progressIntervalRef = useRef(null);
  const progressTimeoutRef = useRef(null);
  const autoTriggeredRef = useRef(new Set());
  const requestInFlightRef = useRef(false);
  const terminalInProgressRef = useRef(false);
  const commandRetryCountRef = useRef({}); // komut bazlı başarısız deneme sayacı (max 3)

  // ─── Live refs — her zaman en güncel state değerini tutar ────────────────────
  // handleSend bir useRef içine alındığı için closure sorunu yok;
  // bu ref'ler aracılığıyla güncel değere erişir.
  const messagesRef = useRef(messages);
  const isTypingRef = useRef(isTyping);
  const activeModelRef = useRef(activeModel);
  const inputRef = useRef(input);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { isTypingRef.current = isTyping; }, [isTyping]);
  useEffect(() => { activeModelRef.current = activeModel; }, [activeModel]);
  useEffect(() => { inputRef.current = input; }, [input]);

  // ─── Bağlantı kontrolü ──────────────────────────────────────────────────────
  useEffect(() => {
    const checkConnection = async () => {
      try {
        const res = await fetch(LM_STUDIO_MODELS_URL);
        if (res.ok) {
          const data = await res.json();
          setIsConnected(true);
          if (data.data?.length > 0) setActiveModel(data.data[0].id);
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
    const interval = setInterval(checkConnection, CONNECTION_POLL_MS);
    return () => clearInterval(interval);
  }, []);

  // ─── Otomatik scroll ────────────────────────────────────────────────────────
  useEffect(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, actionStates]);

  // ─── Progress temizleme yardımcısı ──────────────────────────────────────────
  const clearProgress = useCallback(() => {
    clearInterval(progressIntervalRef.current);
    if (progressTimeoutRef.current) clearTimeout(progressTimeoutRef.current);
    setIsProcessingPrompt(false);
  }, []);

  // ─── handleSend ─────────────────────────────────────────────────────────────
  // useRef içine alındı: her render'da yeniden oluşmaz, stale closure yok.
  // Tüm state değerlerine live ref'ler üzerinden erişir.
  const handleSendRef = useRef(null);
  handleSendRef.current = async (overrideContent) => {
    const isOverride = typeof overrideContent === 'string';
    const currentMsgs = messagesRef.current;
    const msgContent = (isOverride ? overrideContent : inputRef.current).trim();
    if (!msgContent || isTypingRef.current || requestInFlightRef.current) return;

    // Kilidi HEMEN al — race condition'ı önle
    requestInFlightRef.current = true;
    isTypingRef.current = true; // synchronous — useEffect'i bekleme

    const userMsg = { role: 'user', content: msgContent, hidden: isOverride };
    const updatedMessages = [...currentMsgs, userMsg];
    setMessages(updatedMessages);
    if (!isOverride) setInput('');
    setIsTyping(true);

    // Progress başlat
    setIsProcessingPrompt(true);
    setProcessingProgress(0);
    progressIntervalRef.current = setInterval(() => {
      setProcessingProgress(prev => {
        const step = (99.99 - prev) * 0.05 + Math.random() * 1.5;
        return Math.min(prev + step, 99.99);
      });
    }, 100);
    progressTimeoutRef.current = setTimeout(() => setIsProcessingPrompt(false), PROGRESS_TIMEOUT_MS);

    abortControllerRef.current = new AbortController();

    try {
      // Mesajları filtrele
      const filtered = updatedMessages.filter(m => {
        if (m.hiddenFromUI || !m?.content) return false;
        if (typeof m.content === 'string') {
          return !m.content.startsWith('(Yanıt alınamadı)') && !m.content.startsWith('⚠️') && !m.content.startsWith('❌');
        }
        return true;
      });

      const apiMessages = [];
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

      // Token tasarrufu: eski mesajları kırp
      const systemMsgs = apiMessages.filter(m => m.role === 'system');
      const nonSystemMsgs = apiMessages.filter(m => m.role !== 'system');
      let trimSummary = '';
      let trimmedNonSys = nonSystemMsgs;
      if (nonSystemMsgs.length > TOKEN_SAVE_THRESHOLD) {
        trimmedNonSys = nonSystemMsgs.slice(-TOKEN_SAVE_KEEP_LAST);
        trimSummary = `Sohbet kısaltıldı; önceki mesajlar özetlendi. Son ${TOKEN_SAVE_KEEP_LAST} mesaj aşağıda.\n\n`;
      }

      // OS bilgisi
      let osLabel = '';
      try {
        const osRes = await fetch(OS_URL);
        if (osRes.ok) {
          const { label } = await osRes.json();
          osLabel = label || '';
        }
      } catch (_) { /* sessiz */ }

      const osLine = osLabel ? `İşletim sistemi: ${osLabel}. Tüm terminal komutlarını buna göre kullan (Windows: dir, type, cd; Mac/Linux: ls -la, cat, cd).\n\n` : '';

      const systemPrompt = `${osLine}${trimSummary}StackMate IDE agent'ısın. Proje hakkında başlangıçta bilgi verilmez; sadece OS bilgisi vardır.

DİZİN/KEŞİF: Kök ve alt dizinleri sadece isimlerle bil (içerik okuma). Windows \`dir\` / \`dir /s /b\`, Mac/Linux \`ls -la\` / \`ls -R\`. Dosya içeriğini sadece kullanıcı isteği veya düzenleme gerektiğinde oku (type/cat). Önce dizin listele, sonra sadece ilgili dosyayı incele.

## ÖNEMLİ FORMAT KURALLARI (MUTLAKA UYULMALI)
Dosya/klasör/komut oluşturmak için AŞAĞIDAKİ ETİKETLERİ KULLAN. Köşeli parantez ZORUNLU:
- Dosya oluşturma: [FILE: yol/dosya.ext]içerik[/FILE]
- Klasör oluşturma: [MKDIR: yol/klasor]
- Terminal komutu: [CMD: komut]
- Dosya düzenleme: [EDIT: yol/dosya.ext][OLD]eski[/OLD][NEW]yeni[/NEW][/EDIT]
- Dosya silme: [DELETE_FILE: yol/dosya.ext]

KRİTİK KURALLAR:
1. HER MESAJDA YALNIZCA BİR [CMD: ...] etiketi kullan. Birden fazla komut gönderme. Komut sonucu sana otomatik bildirilecek.
2. echo ile dosya oluşturma YAPMA. Bunun yerine [FILE: yol][/FILE] kullan.
3. copy/cp ile dosya kopyalama yerine [FILE:] ile yeni dosyayı doğrudan oluştur.
4. ASLA düz metin olarak "CMD: komut" yazma, MUTLAKA [CMD: komut] formatını kullan.
5. Küçük değişiklikte [EDIT], büyük değişiklikte [FILE] kullan.
6. Terminal komutu çalıştırdıktan sonra DUR ve sonucu bekle. Sonuç otomatik gelecek.
7. Markdown kod bloğu (\`\`\`bash ... \`\`\`) kullanma; bunun yerine [CMD: ...] kullan.
8. [SİSTEM - Terminal çıktısı] mesajı aldığında sonucu analiz et ve sıradaki adımı belirle.
9. Görev birden fazla adım gerektiriyorsa her adımdan sonra bir sonrakini belirle.
10. AYNI BAŞARISIZ KOMUTU TEKRAR ÇALIŞTIRMA. Bir komut hata verdiyse, farklı bir yaklaşım veya farklı parametrelerle dene. Aynı komutu 2 kereden fazla deneme.`;

      const finalMessages = [{ role: 'system', content: systemPrompt }, ...systemMsgs, ...trimmedNonSys];

      const response = await fetch(LM_STUDIO_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: activeModelRef.current,
          messages: finalMessages,
          temperature: 0.7,
          max_tokens: 4096,
          stream: true,
        }),
        signal: abortControllerRef.current.signal,
      });

      if (!response.ok) {
        const errBody = await response.text();
        let errMsg = `LM Studio hatası (${response.status})`;
        try { const p = JSON.parse(errBody); errMsg = p.error?.message || p.error || errMsg; } catch (_) { }
        throw new Error(errMsg);
      }

      const decoder = new TextDecoder();
      const stream = response.body.getReader();
      let assistantContent = '';
      let isFirstChunk = true;
      let stopAfterFirstCmd = false;

      setMessages(prev => [...prev, { role: 'assistant', content: '' }]);

      while (true) {
        const { done, value } = await stream.read();

        if (isFirstChunk) {
          isFirstChunk = false;
          clearProgress();
          setProcessingProgress(100);
        }

        if (done || stopAfterFirstCmd) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n').filter(l => l.trim().startsWith('data:'));

        for (const line of lines) {
          const data = line.replace('data: ', '').trim();
          if (data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta?.content;
            if (!delta) continue;

            assistantContent += delta;

            // İlk [CMD:] veya bare CMD gelince akışı kes
            const cmdTagMatch = assistantContent.match(/\[\s*CMD\s*:\s*([^\]]+?)\s*\]/i);
            if (cmdTagMatch) {
              assistantContent = assistantContent.slice(0, assistantContent.indexOf(cmdTagMatch[0]) + cmdTagMatch[0].length);
              stopAfterFirstCmd = true;
            }

            if (!stopAfterFirstCmd) {
              const bareCmdMatch = assistantContent.match(/^[ \t]*CMD:\s*(.+)$/m);
              if (bareCmdMatch) {
                assistantContent = assistantContent.slice(0, assistantContent.indexOf(bareCmdMatch[0]) + bareCmdMatch[0].length);
                stopAfterFirstCmd = true;
              }
            }

            if (!stopAfterFirstCmd) {
              const codeBlockRe = /```(?:cmd|bash|sh|shell)\s*\n[\s\S]*?```/gi;
              let lastBlock = null, blockMatch;
              while ((blockMatch = codeBlockRe.exec(assistantContent)) !== null) lastBlock = blockMatch;
              if (lastBlock && !/\[\s*(?:FILE|EDIT|MKDIR|DELETE_FILE)\s*[:\]]/i.test(lastBlock[0])) {
                assistantContent = assistantContent.slice(0, lastBlock.index + lastBlock[0].length);
                stopAfterFirstCmd = true;
              }
            }

            setMessages(prev => {
              const next = [...prev];
              next[next.length - 1] = { role: 'assistant', content: assistantContent };
              return next;
            });

            if (stopAfterFirstCmd) break;
          } catch (_) { /* JSON parse hatası — atla */ }
        }
      }

      // Model iç token algılama: dosya ağacı gönder
      const hasCmdInResp = /\[\s*CMD\s*:/i.test(assistantContent) || /^[ \t]*CMD:\s*.+$/m.test(assistantContent);
      const looksStuck = !hasCmdInResp && /<channel|to-repo|browser\.(print_tree|list)|<message>\s*\{\s*"path"/i.test(assistantContent.trim());
      if (looksStuck && currentDirPath) {
        try {
          const dirRes = await fetch(READ_DIR_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: currentDirPath, deep: true }),
          });
          if (dirRes.ok) {
            const dirData = await dirRes.json();
            const treeText = formatDirTree(dirData);
            handleSendRef.current(`[SİSTEM: Model dosya ağacı istedi. Proje dizini:\n\`\`\`\n${treeText}\`\`\`\nBu çıktıya göre devam et.]`);
          }
        } catch (_) { /* sessiz */ }
      }

      if (!assistantContent.trim()) {
        setMessages(prev => {
          const next = [...prev];
          next[next.length - 1] = { role: 'assistant', content: '(Yanıt alınamadı)' };
          return next;
        });
      }

    } catch (err) {
      if (err.name === 'AbortError') {
        setMessages(prev => [...prev, { role: 'assistant', content: '⚠️ Yanıt iptal edildi.' }]);
      } else {
        setMessages(prev => [...prev, { role: 'assistant', content: `❌ Bağlantı hatası: ${err.message}\n\nLM Studio'nun çalıştığından emin olun (http://127.0.0.1:1234)` }]);
        setIsConnected(false);
      }
    } finally {
      requestInFlightRef.current = false;
      isTypingRef.current = false; // synchronous
      abortControllerRef.current = null;
      setIsTyping(false);
      clearProgress();
    }
  };

  // Stabil referans — dışarıya bu verilir, her render'da değişmez
  const handleSend = useCallback((overrideContent) => {
    return handleSendRef.current(overrideContent);
  }, []); // dependency yok — kasıtlı olarak boş

  // ─── FILE/MKDIR otomatik uygulama ─────────────────────────────────────────
  // Terminal action'larına DOKUNMAZ — sadece file/mkdir'i hızlıca uygular.
  useEffect(() => {
    if (isTyping || requestInFlightRef.current || terminalInProgressRef.current) return;

    const lastMsg = messages[messages.length - 1];
    if (lastMsg?.role !== 'assistant') return;

    const parts = parseMessageParts(lastMsg.content);
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const actionId = `msg-${messages.length - 1}-part-${i}`;
      if (part.incomplete || autoTriggeredRef.current.has(actionId) || actionStates[actionId]) continue;

      if (part.type === 'file_action' || part.type === 'mkdir_action') {
        autoTriggeredRef.current.add(actionId);
        handleActionApprove(actionId, part, true);
      }
      // terminal_action: kullanıcı "Çalıştır" butonuna basana kadar bekle — hiçbir şey yapma
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, isTyping, actionStates]);

  // ─── handleActionApprove ────────────────────────────────────────────────────
  const handleActionApprove = useCallback(async (actionId, action, isAuto = false) => {
    if (action.type === 'mark_done') {
      setActionStates(prev => ({ ...prev, [actionId]: { status: 'done' } }));
      return;
    }

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
            const res = await fetch('http://localhost:3001/api/save-file', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ path: resolveActionPath(currentDirPath, action.path), content: action.content }),
            });
            if (!res.ok) {
              const errData = await res.json().catch(() => ({}));
              throw new Error(errData.error || 'Dosya kaydedilemedi');
            }
          } else {
            await fsaaWriteFile(currentDirHandle, action.path, action.content);
          }
          setActionStates(prev => ({ ...prev, [actionId]: { status: isAuto ? 'auto_applied' : 'done' } }));
          setTimeout(() => onFileChange?.(), 300);
          break;
        }
        case 'delete_action': {
          if (useBackend) {
            const res = await fetch('http://localhost:3001/api/delete-file', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ path: resolveActionPath(currentDirPath, action.path) }),
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
            const res = await fetch('http://localhost:3001/api/mkdir', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ path: resolveActionPath(currentDirPath, action.path) }),
            });
            if (!res.ok) throw new Error('Klasör oluşturulamadı');
          } else {
            await fsaaMkdir(currentDirHandle, action.path);
          }
          setActionStates(prev => ({ ...prev, [actionId]: { status: 'done' } }));
          setTimeout(() => onFileChange?.(), 300);
          break;
        }
        case 'edit_action': {
          if (!useBackend) throw new Error('Dosya düzenleme özelliği şu anda sadece Masaüstü IDE (Backend) modunda çalışır.');
          const editRes = await fetch('http://localhost:3001/api/edit-file', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: resolveActionPath(currentDirPath, action.path), oldText: action.oldText, newText: action.newText }),
          });
          if (!editRes.ok) {
            const errData = await editRes.json();
            throw new Error(errData.error || 'Düzenleme başarısız');
          }
          setActionStates(prev => ({ ...prev, [actionId]: { status: 'done' } }));
          setTimeout(() => onFileChange?.(), 300);
          break;
        }
        case 'terminal_action': {
          // Terminal kilidi al — paralel çalışmayı engelle
          terminalInProgressRef.current = true;

          const startRes = await fetch('http://localhost:3001/api/agent-run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: normalizeTerminalCommand(action.command), cwd: currentDirPath || undefined }),
          });
          const { procId } = await startRes.json();
          if (!procId) throw new Error('Process başlatılamadı');

          let pollCount = 0;
          const maxPolls = 24; // 2 dakika

          const pollStatus = async () => {
            pollCount++;
            try {
              const statusRes = await fetch('http://localhost:3001/api/agent-status', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ procId }),
              });
              const status = await statusRes.json();

              const currentResult = {
                stdout: status.stdout || '',
                stderr: status.stderr || '',
                exitCode: status.exitCode,
              };

              // ─── Process tamamlandı: sadece state'i güncelle, AI'ı tetikleme ───
              // AI tetikleme TAMAMEN kullanıcının "Devam Et" / "Hatayı Bildir"
              // butonlarına bağlı — handleTerminalContinue burada çağrılmaz.
              if (!status.running) {
                setActionStates(prev => ({
                  ...prev,
                  [actionId]: { status: 'done', result: currentResult },
                }));
                terminalInProgressRef.current = false;
                return;
              }

              // Canlı çıktı göster
              setActionStates(prev => ({
                ...prev,
                [actionId]: { status: 'running', result: currentResult },
              }));

              const combined = currentResult.stdout + '\n' + currentResult.stderr;
              const hasError = ERROR_PATTERNS.some(p => combined.includes(p));
              const hasSuccess = SUCCESS_PATTERNS.some(p => combined.toLowerCase().includes(p.toLowerCase()));

              if (hasError && !hasSuccess) {
                await fetch('http://localhost:3001/api/agent-kill', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ procId }),
                });
                setActionStates(prev => ({
                  ...prev,
                  [actionId]: { status: 'done', result: { ...currentResult, exitCode: 1 } },
                }));
                terminalInProgressRef.current = false;
                return;
              }

              if (hasSuccess) {
                setActionStates(prev => ({
                  ...prev,
                  [actionId]: { status: 'done', result: { ...currentResult, exitCode: 0 }, serverRunning: true, procId },
                }));
                terminalInProgressRef.current = false;
                return;
              }

              if (pollCount < maxPolls) {
                setTimeout(pollStatus, 5000);
              } else {
                setActionStates(prev => ({
                  ...prev,
                  [actionId]: { status: 'done', result: { ...currentResult, exitCode: 0 } },
                }));
                terminalInProgressRef.current = false;
              }
            } catch (err) {
              setActionStates(prev => ({
                ...prev,
                [actionId]: { status: 'error', error: 'Polling hatası: ' + err.message },
              }));
              terminalInProgressRef.current = false;
            }
          };

          // İlk kontrol 500ms sonra (hızlı komutlar için)
          setTimeout(pollStatus, 500);
          break;
        }
      }
    } catch (err) {
      setActionStates(prev => ({ ...prev, [actionId]: { status: 'error', error: err.message } }));
      if (action.type === 'terminal_action') terminalInProgressRef.current = false;

      // Terminal hataları için otomatik AI geri bildirimi yapma — kullanıcı Devam Et/Hatayı Bildir butonuyla kontrol eder
      // Sadece dosya/düzenleme hatalarını AI'a ilet
      if (action.type !== 'terminal_action') {
        handleSendRef.current(`[SİSTEM: "${action.path || action.command}" işlemi sırasında hata: ${err.message}. Lütfen analiz edip çözüm üret.]`);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentDirPath, currentDirHandle, onFileChange]);

  // ─── handleActionReject ─────────────────────────────────────────────────────
  const handleActionReject = useCallback(async (actionId, isRollback = false, action = null) => {
    if (isRollback && action?.type === 'file_action') {
      setActionStates(prev => ({ ...prev, [actionId]: { status: 'running' } }));
      try {
        if (currentDirPath) {
          await fetch('http://localhost:3001/api/delete-file', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: currentDirPath + '\\' + action.path.replace(/\//g, '\\') }),
          });
        }
        setTimeout(() => onFileChange?.(), 300);
      } catch (err) {
        console.error('Geri alma hatası', err);
      }
      setActionStates(prev => ({ ...prev, [actionId]: { status: 'rejected' } }));
    } else {
      setActionStates(prev => ({ ...prev, [actionId]: { status: 'rejected' } }));
      if (action?.type === 'terminal_action') {
        handleSendRef.current(`[SİSTEM: Kullanıcı \`${action.command}\` komutunu çalıştırmayı reddetti (Atlandı). Lütfen duruma göre alternatif bir komut veya yöntem öner.]`);
      }
    }
  }, [currentDirPath, onFileChange]);

  // ─── handleTerminalContinue ─────────────────────────────────────────────────
  // SADECE kullanıcı "Devam Et" veya "Hatayı Bildir" butonuna basınca çağrılır.
  // Doğrudan handleSendRef.current çağırır — araya kuyruk/useEffect girmez.
  const handleTerminalContinue = useCallback((actionId, result, isSuccess) => {
    terminalInProgressRef.current = false;

    setActionStates(prev => ({
      ...prev,
      [actionId]: { ...prev[actionId], continued: isSuccess ? 'continue' : 'error' },
    }));

    // Dosya okuma tespiti
    const [, msgIdxStr] = actionId.match(/^msg-(\d+)-/) || [];
    if (msgIdxStr !== undefined) {
      const msgIdx = parseInt(msgIdxStr, 10);
      const msg = messagesRef.current[msgIdx];
      if (msg) {
        const parts = parseMessageParts(msg.content);
        const [, , partIdxStr] = actionId.match(/^msg-\d+-part-(\d+)$/) || [];
        if (partIdxStr !== undefined) {
          const part = parts[parseInt(partIdxStr, 10)];
          if (part?.type === 'terminal_action' && isSuccess) {
            const readMatch = (part.command || '').match(/^\s*(type|cat)\s+(.+)$/im);
            if (readMatch) {
              const filePath = readMatch[2].trim().replace(/^["']|["']$/g, '');
              const lineCount = (result?.stdout || '').split(/\r?\n/).length;
              setExploredFiles(prev => [...prev, { path: filePath, lineRange: lineCount > 0 ? `L1-${lineCount}` : null }]);
            }
          }
        }
      }
    }

    const output = [result?.stdout?.trim(), result?.stderr?.trim()].filter(Boolean).join('\n');
    const truncated = output.length > 2000 ? output.slice(-2000) + '\n...(kısaltıldı)' : output;
    const portMatch = output.match(/(?:localhost|127\.0\.0\.1|portunda|port\s*)[:\s]*(\d{4,5})/i);
    const portInfo = portMatch ? `http://localhost:${portMatch[1]}` : '';

    // ─── Yeniden deneme sayacı kontrolü ────────────────────────────────────
    // Komutu tespit et
    let executedCommand = '';
    if (msgIdxStr !== undefined) {
      const mi = parseInt(msgIdxStr, 10);
      const m = messagesRef.current[mi];
      if (m) {
        const pp = parseMessageParts(m.content);
        const [, , pi] = actionId.match(/^msg-\d+-part-(\d+)$/) || [];
        if (pi !== undefined) {
          const pt = pp[parseInt(pi, 10)];
          if (pt?.type === 'terminal_action') executedCommand = pt.command || '';
        }
      }
    }
    const cmdKey = executedCommand.trim().toLowerCase();

    let retryWarning = '';
    if (!isSuccess && cmdKey) {
      const count = (commandRetryCountRef.current[cmdKey] || 0) + 1;
      commandRetryCountRef.current[cmdKey] = count;
      if (count >= 3) {
        retryWarning = '\n\n⚠️ Bu komut artık 3 kez başarısız oldu. AYNI KOMUTU TEKRAR ÇALIŞTIRMA. Tamamen farklı bir yaklaşım dene veya kullanıcıya sorunu açıkla.';
      } else {
        retryWarning = `\n\n(Bu komut ${count}. kez başarısız oldu. Aynı komutu tekrar gönderme, farklı parametreler veya yaklaşım dene.)`;
      }
    } else if (isSuccess && cmdKey) {
      // Başarılı olursa sayacı sıfırla
      delete commandRetryCountRef.current[cmdKey];
    }

    let feedbackMsg;
    if (isSuccess) {
      feedbackMsg = `[SİSTEM - Terminal çıktısı, exit code: ${result?.exitCode ?? '?'}]\n\`\`\`\n${truncated || '(çıktı yok)'}\n\`\`\`\n${portInfo ? `Sunucu ${portInfo} adresinde çalışıyor.\n` : ''}Komut başarıyla tamamlandı. Sonucu analiz et ve sıradaki adımı belirle.`;
    } else {
      feedbackMsg = `[SİSTEM - Terminal çıktısı, exit code: ${result?.exitCode ?? '?'}]\n\`\`\`\n${truncated || '(çıktı yok)'}\n\`\`\`\nKomut başarısız oldu. Hatayı analiz et ve nedenini açıkla.${retryWarning}`;
    }

    // Doğrudan çağır — kuyruk/useEffect zinciri yok, gecikme yok
    handleSendRef.current(feedbackMsg);
  }, []);

  // ─── handleStop ─────────────────────────────────────────────────────────────
  const handleStop = useCallback(() => {
    abortControllerRef.current?.abort();
    clearProgress();
  }, [clearProgress]);

  // ─── Chat temizleme ─────────────────────────────────────────────────────────
  const handleClearChat = useCallback(() => {
    if (window.confirm('Tüm sohbet geçmişi tamamen silinecek. Emin misiniz?')) {
      setMessages([]);
      setActionStates({});
      setExploredFiles([]);
      autoTriggeredRef.current.clear();
      commandRetryCountRef.current = {};
    }
  }, []);

  const handleHideChat = useCallback(() => {
    setMessages(prev => prev.map(m => ({ ...m, hiddenFromUI: true })));
  }, []);

  const handleKeyPress = useCallback((e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendRef.current();
    }
  }, []);

  // ─── Terminal bloklama durumu (input disable mantığı) ─────────────────────
  // Running terminaller: tüm mesajlarda aranır (aktif process olabilir).
  // Pending / done-not-continued: SADECE en son asistan mesajında kontrol edilir.
  // Eski mesajlardaki yetim CMD blokları inputu KİLİTLEMEMELİ.
  const { hasRunningTerminal, hasPendingTerminal, hasDoneNotContinued } = (() => {
    let hasRunningTerminal = false, hasPendingTerminal = false, hasDoneNotContinued = false;

    // 1. Aktif (running) terminaller — tüm mesajlarda ara
    for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
      const msg = messages[msgIdx];
      if (msg.hidden || msg.hiddenFromUI || msg.role !== 'assistant') continue;
      const parts = parseMessageParts(msg.content || '');
      for (let partIdx = 0; partIdx < parts.length; partIdx++) {
        if (parts[partIdx].type !== 'terminal_action') continue;
        const actionId = `msg-${msgIdx}-part-${partIdx}`;
        if (actionStates[actionId]?.status === 'running') hasRunningTerminal = true;
      }
    }

    // 2. Pending ve done-not-continued — SADECE en son asistan mesajında kontrol et
    for (let msgIdx = messages.length - 1; msgIdx >= 0; msgIdx--) {
      const msg = messages[msgIdx];
      if (msg.hidden || msg.hiddenFromUI) continue;
      if (msg.role !== 'assistant') continue;
      // Bu en son görünür asistan mesajı
      const parts = parseMessageParts(msg.content || '');
      for (let partIdx = 0; partIdx < parts.length; partIdx++) {
        if (parts[partIdx].type !== 'terminal_action') continue;
        const actionId = `msg-${msgIdx}-part-${partIdx}`;
        const s = actionStates[actionId]?.status;
        const continued = actionStates[actionId]?.continued;
        if (!s || s === 'pending') hasPendingTerminal = true;
        else if (s === 'done' && !continued) hasDoneNotContinued = true;
      }
      break; // sadece en son asistan mesajını kontrol et
    }

    return { hasRunningTerminal, hasPendingTerminal, hasDoneNotContinued };
  })();

  const terminalBlocking = hasRunningTerminal || hasPendingTerminal || hasDoneNotContinued;
  let inputPlaceholder = 'Mesajınızı yazın...';
  if (isConnected === false) inputPlaceholder = 'LM Studio bağlantısı yok...';
  else if (hasRunningTerminal) inputPlaceholder = 'Terminal çalışıyor, sonuç bekleniyor...';
  else if (hasPendingTerminal) inputPlaceholder = 'Terminal bekleniyor — Çalıştır veya Atla seçin';
  else if (hasDoneNotContinued) inputPlaceholder = 'Terminal sonucunu onaylayın (Devam Et / Hata Bildir)';

  const visibleMessages = messages.filter(m => !m.hidden && !m.hiddenFromUI);

  // ─── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="ai-panel-container">
      <div className="ai-panel-header">
        <div className="ai-header-left">
          <Bot className="header-icon" />
          <span>StackMate AGENT</span>
          <div
            className={`connection-dot ${isConnected === true ? 'connected' : isConnected === false ? 'disconnected' : 'checking'}`}
            title={
              isConnected === true
                ? `LM Studio bağlı — ${activeModel || 'model yüklü'}`
                : isConnected === false
                  ? 'LM Studio bağlantısı yok'
                  : 'Kontrol ediliyor...'
            }
          />
        </div>
        <div className="header-actions" style={{ display: 'flex', gap: '8px' }}>
          <button className="clear-chat-btn" onClick={handleHideChat} title="Ekranı Temizle (Beni unutmaz)">
            <Eraser size={14} />
          </button>
          <button className="clear-chat-btn" onClick={handleClearChat} title="Hafızayı Temizle (Yepyeni sohbet)">
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {isConnected === true && activeModel && (
        <div className="model-info">{activeModel}</div>
      )}

      {isConnected === false && (
        <div className="connection-warning">
          LM Studio bağlantısı yok. <code>http://127.0.0.1:1234</code> adresinde çalıştığından emin olun.
        </div>
      )}

      {exploredFiles.length > 0 && (
        <div className="explored-files-bar">
          <button
            type="button"
            className="explored-files-header"
            onClick={() => setExploredFilesOpen(v => !v)}
            aria-expanded={exploredFilesOpen}
          >
            {exploredFilesOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <span>Explored {exploredFiles.length} file{exploredFiles.length !== 1 ? 's' : ''}</span>
          </button>
          {exploredFilesOpen && (
            <div className="explored-files-list">
              {exploredFiles.map((item, i) => (
                <div key={i} className="explored-file-item">
                  Read {item.path}{item.lineRange ? ` ${item.lineRange}` : ''}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="messages-container" ref={messagesContainerRef}>
        {visibleMessages.map((message, index) => (
          <div key={index} className={`message ${message.role === 'user' ? 'user-message' : 'assistant-message'}`}>
            <div className="message-header">
              {message.role === 'assistant' ? (
                <><Bot size={14} className="message-author-icon" /><span>AI</span></>
              ) : (
                <><span>Sen</span><User size={14} className="message-author-icon" /></>
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
              <Bot size={14} className="message-author-icon" /><span>AI</span>
            </div>
            <div className="message-body">
              {isProcessingPrompt ? (
                <div className="processing-prompt-bar">
                  <span className="pp-zero">0</span>
                  <span className="pp-text">PROCESSING PROMPT</span>
                  <span className="pp-percent">{processingProgress.toFixed(2)}%</span>
                  <div className="pp-spinner"></div>
                </div>
              ) : (
                <div className="typing-indicator">
                  <div className="typing-dot"></div>
                  <div className="typing-dot"></div>
                  <div className="typing-dot"></div>
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
            placeholder={inputPlaceholder}
            className="message-input"
            disabled={isConnected === false || terminalBlocking}
          />
          {isTyping ? (
            <button onClick={handleStop} className="send-button stop-btn" title="Yanıtı durdur">
              <div className="stop-icon" />
            </button>
          ) : (
            <button
              onClick={() => handleSendRef.current()}
              disabled={!input.trim() || isTyping || isConnected === false || terminalBlocking}
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
