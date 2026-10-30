const { WebSocketServer } = require('ws');
const { createServer } = require('http');
const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { readSettings, publicSettings, updateSettings, activeConnection, endpointUrl } = require('./settings-store.cjs');

const PORT = Number(process.env.STACKMATE_PORT || 3001);
const ALLOWED_ORIGINS = new Set(['http://localhost:5173', 'http://127.0.0.1:5173']);
let projectRoot = null;
let appSettings = readSettings();
const withinRoot = (target, root) => {
  if (!root || typeof target !== 'string') return false;
  try {
    const resolved = path.resolve(target);
    const relative = path.relative(root, resolved);
    if (!(relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)))) return false;
    let existing = resolved;
    while (!fs.existsSync(existing)) existing = path.dirname(existing);
    const real = fs.realpathSync(existing);
    const realRelative = path.relative(root, real);
    return realRelative === '' || (realRelative !== '..' && !realRelative.startsWith('..' + path.sep) && !path.isAbsolute(realRelative));
  } catch { return false; }
};
const withinProject = (target) => withinRoot(target, projectRoot);
const PLATFORM = os.platform(); // 'darwin' | 'linux' | 'win32'
const HOME = os.homedir();
const USER = os.userInfo().username;

// ─── Platform'a göre shell seçimi ──────────────────────────────────────────
const getShell = () => {
  if (PLATFORM === 'win32') return process.env.COMSPEC || 'cmd.exe';
  return process.env.SHELL || (PLATFORM === 'darwin' ? '/bin/zsh' : '/bin/bash');
};

const SHELL = getShell();

// Agent process yönetimi (uzun süren komutlar için)
const agentProcesses = new Map();
const stagedChanges = new Map();
const stageStoreDir = path.join(PLATFORM === 'win32'
  ? (process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'))
  : (process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state')),
'StackMate', 'staged-changes');
fs.mkdirSync(stageStoreDir, { recursive: true, mode: 0o700 });
const stageRecordPath = (token) => path.join(stageStoreDir, `${token}.json`);
for (const filename of fs.readdirSync(stageStoreDir)) {
  if (!/^[0-9a-f-]{36}\.json$/i.test(filename)) continue;
  try {
    const record = JSON.parse(fs.readFileSync(path.join(stageStoreDir, filename), 'utf8'));
    if (typeof record.filePath === 'string' && typeof record.root === 'string' && typeof record.after === 'string') {
      stagedChanges.set(filename.slice(0, -5), record);
    }
  } catch { /* geçersiz kayıtları yok say */ }
}
let agentProcCounter = 1;
const killAgentProcess = (proc) => {
  if (!proc?.pid) return;
  if (PLATFORM === 'win32') {
    spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true });
  } else {
    proc.kill('SIGTERM');
  }
};

// Komutu platforma göre çalıştır
const spawnCommand = (cmd, cwd) => {
  if (PLATFORM === 'win32') {
    return spawn(SHELL, ['/c', cmd], {
      cwd,
      env: { ...process.env, FORCE_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
  }
  return spawn(SHELL, ['-c', cmd], {
    cwd,
    env: { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
};

// ANSI renk kodları
const c = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
};

// ─── HTTP API — Dosya sistemi işlemleri (Brave/Firefox fallback) ─────────
const parseBody = (req) => req.parsedBody ? Promise.resolve(req.parsedBody) : new Promise((resolve, reject) => {
  let body = '';
  let tooLarge = false;
  req.on('data', chunk => {
    if (tooLarge) return;
    body += chunk;
    if (body.length > 10 * 1024 * 1024) { body = ''; tooLarge = true; }
  });
  req.on('end', () => {
    if (tooLarge) { resolve({}); return; }
    try { resolve(JSON.parse(body)); }
    catch (_) { resolve({}); }
  });
  req.on('error', reject);
});

// Rekürsif dizin okuma (sadece ilk seviye)
const readDirTree = (dirPath) => {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue; // Gizli dosyaları atla
    result.push({
      name: entry.name,
      type: entry.isDirectory() ? 'folder' : 'file',
      children: entry.isDirectory() ? [] : undefined,
    });
  }
  result.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return result;
};

// Rekürsif dizin okuma (tüm derinlik)
const readDirTreeDeep = (dirPath) => {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) {
      result.push({
        name: entry.name,
        type: 'folder',
        children: readDirTreeDeep(path.join(dirPath, entry.name)),
      });
    } else {
      result.push({ name: entry.name, type: 'file' });
    }
  }
  result.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return result;
};

const server = createServer(async (req, res) => {
  // CORS
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) { res.writeHead(403); res.end(); return; }
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/api/project-root') {
    const body = await parseBody(req);
    if (typeof body.path !== 'string' || !path.isAbsolute(body.path)) { res.writeHead(400); res.end(); return; }
    try {
      const root = fs.realpathSync(body.path);
      if (!fs.statSync(root).isDirectory()) throw new Error('Dizin değil');
      projectRoot = root;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ path: root }));
    } catch (err) { res.writeHead(400); res.end(JSON.stringify({ error: err.message })); }
    return;
  }

  const guardedPaths = {
    '/api/read-dir': ['path'], '/api/read-subdir': ['path'], '/api/read-file': ['path'],
    '/api/save-file': ['path'], '/api/edit-file': ['path'], '/api/rename': ['oldPath', 'newPath'],
    '/api/delete': ['path'], '/api/delete-file': ['path'], '/api/mkdir': ['path'],
    '/api/agent-stage': ['path'],
    '/api/agent-exec': ['cwd'], '/api/agent-run': ['cwd'],
  };
  if (req.method === 'POST' && guardedPaths[req.url]) {
    const body = await parseBody(req);
    if (guardedPaths[req.url].some(key => !withinProject(body[key]))) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'İşlem etkin proje dizini dışında' }));
      return;
    }
    // Reuse the parsed body in the endpoint below.
    req.parsedBody = body;
  }

  // ─── API: İşletim sistemi (agent için tek bağlam bilgisi) ─────────────
  if (req.method === 'GET' && req.url === '/api/os') {
    const label = PLATFORM === 'win32' ? 'Windows' : PLATFORM === 'darwin' ? 'macOS' : 'Linux';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ platform: PLATFORM, label }));
    return;
  }

  // ─── API: Dizin oku ─────────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/api/read-dir') {
    const body = await parseBody(req);
    const dirPath = body.path;
    if (!dirPath || !fs.existsSync(dirPath)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Geçersiz dizin yolu' }));
      return;
    }
    try {
      const deep = body.deep === true;
      const children = deep ? readDirTreeDeep(dirPath) : readDirTree(dirPath);
      const tree = {
        name: path.basename(dirPath),
        type: 'folder',
        children,
        _serverPath: dirPath,
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(tree));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ─── API: Dosya kaydet ──────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/api/agent-stage') {
    const { path: filePath, type, content, oldText, newText } = await parseBody(req);
    try {
      if (!['file', 'edit'].includes(type)) throw new Error('Geçersiz işlem türü');
      const existed = fs.existsSync(filePath);
      if (existed && !fs.statSync(filePath).isFile()) throw new Error('Hedef normal dosya değil');
      if (type === 'edit' && !existed) throw new Error('Düzenlenecek dosya bulunamadı');
      const before = existed ? fs.readFileSync(filePath, 'utf8') : null;
      let after;
      if (type === 'file') {
        if (typeof content !== 'string') throw new Error('Dosya içeriği geçersiz');
        after = content;
      } else {
        if (typeof oldText !== 'string' || !oldText || typeof newText !== 'string') throw new Error('Düzenleme metni geçersiz');
        if (before.split(oldText).length === 2) {
          after = before.replace(oldText, newText);
        } else if (before.replace(/\r\n/g, '\n').trim() === oldText.replace(/\r\n/g, '\n').trim()) {
          const newline = before.includes('\r\n') ? '\r\n' : '\n';
          after = newText.replace(/\r\n/g, '\n').replace(/\n/g, newline);
          if (before.endsWith(newline) && !after.endsWith(newline)) after += newline;
        } else {
          throw new Error('Eski metin dosyada tam olarak bir kez bulunmalı');
        }
      }
      const token = randomUUID();
      const record = { filePath, before, after, existed, root: projectRoot, type, oldText, newText };
      fs.writeFileSync(stageRecordPath(token), JSON.stringify(record), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, after, 'utf8');
      } catch (error) {
        fs.rmSync(stageRecordPath(token), { force: true });
        throw error;
      }
      stagedChanges.set(token, record);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ token, created: !existed }));
    } catch (err) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.method === 'GET' && req.url === '/api/agent-pending') {
    const pending = [...stagedChanges.entries()]
      .filter(([, change]) => change.root === projectRoot && withinProject(change.filePath))
      .map(([token, change]) => ({ token, path: change.filePath, type: change.type || 'file', content: change.after, oldText: change.oldText, newText: change.newText }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ pending }));
    return;
  }

  if (req.method === 'POST' && ['/api/agent-commit', '/api/agent-revert'].includes(req.url)) {
    const { token } = await parseBody(req);
    const change = stagedChanges.get(token);
    if (!change) { res.writeHead(404); res.end(JSON.stringify({ error: 'Bekleyen değişiklik bulunamadı' })); return; }
    try {
      if (req.url === '/api/agent-revert') {
        if (!withinRoot(change.filePath, change.root) || !fs.existsSync(change.filePath) || fs.readFileSync(change.filePath, 'utf8') !== change.after) {
          throw new Error('Dosya sonradan değişti; geri alma uygulanmadı');
        }
        if (change.existed) fs.writeFileSync(change.filePath, change.before, 'utf8');
        else fs.unlinkSync(change.filePath);
      }
      fs.unlinkSync(stageRecordPath(token));
      stagedChanges.delete(token);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/api/save-file') {
    const body = await parseBody(req);
    const filePath = body.path;
    const content = body.content;
    if (!filePath || content === undefined) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'path ve content gerekli' }));
      return;
    }
    try {
      // Üst dizini oluştur (yoksa)
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: filePath }));
    } catch (err) {
      console.error('[save-file] Hata:', err.message, '| Yol:', filePath);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ─── API: Dosya düzenle (kısmi değişiklik) ──────────────────────────
  if (req.method === 'POST' && req.url === '/api/edit-file') {
    const body = await parseBody(req);
    const { path: filePath, oldText, newText } = body;
    if (!filePath || typeof oldText !== 'string' || !oldText || typeof newText !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'path, oldText ve newText gerekli' }));
      return;
    }
    try {
      if (!fs.existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Dosya bulunamadı' }));
        return;
      }
      let content = fs.readFileSync(filePath, 'utf-8');
      const norm = (s) => (s || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      let newContent;
      if (content.includes(oldText)) {
        if (content.split(oldText).length !== 2) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Eski metin birden fazla yerde bulunuyor' }));
          return;
        }
        newContent = content.replace(oldText, newText);
      } else {
        const contentNorm = norm(content);
        const oldNorm = norm(oldText);
        if (!contentNorm.includes(oldNorm)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Eski metin dosyada bulunamadı' }));
          return;
        }
        if (contentNorm.split(oldNorm).length !== 2) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Eski metin birden fazla yerde bulunuyor' }));
          return;
        }
        newContent = contentNorm.replace(oldNorm, norm(newText));
      }
      fs.writeFileSync(filePath, newContent, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: filePath }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ─── API: Dosya oku ─────────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/api/read-file') {
    const body = await parseBody(req);
    const filePath = body.path;
    if (!filePath || !fs.existsSync(filePath)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Dosya bulunamadı' }));
      return;
    }
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ content, name: path.basename(filePath) }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ─── API: Alt dizin oku (lazy load) ─────────────────────────────────
  if (req.method === 'POST' && req.url === '/api/read-subdir') {
    const body = await parseBody(req);
    const dirPath = body.path;
    if (!dirPath || !fs.existsSync(dirPath)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Dizin bulunamadı' }));
      return;
    }
    try {
      const children = readDirTree(dirPath);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ children }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ─── API: Dosya/klasör yeniden adlandır ────────────────────────────
  if (req.method === 'POST' && req.url === '/api/rename') {
    const body = await parseBody(req);
    const { oldPath, newPath } = body;
    if (!oldPath || !newPath) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'oldPath ve newPath gerekli' }));
      return;
    }
    if (!fs.existsSync(oldPath)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Kaynak bulunamadı' }));
      return;
    }
    try {
      fs.renameSync(oldPath, newPath);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, oldPath, newPath }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ─── API: Dosya/klasör sil ──────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/api/delete') {
    const body = await parseBody(req);
    const targetPath = body.path;
    if (!targetPath) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'path gerekli' }));
      return;
    }
    if (!fs.existsSync(targetPath)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Hedef bulunamadı' }));
      return;
    }
    try {
      const stat = fs.statSync(targetPath);
      if (stat.isDirectory()) {
        fs.rmSync(targetPath, { recursive: true, force: true });
      } else {
        fs.unlinkSync(targetPath);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: targetPath }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ─── API: Klasör oluştur ────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/api/mkdir') {
    const body = await parseBody(req);
    const dirPath = body.path;
    if (!dirPath) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'path gerekli' }));
      return;
    }
    try {
      fs.mkdirSync(dirPath, { recursive: true });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: dirPath }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ─── API: Dosya İzleme (SSE) ──────────────────────────────────────────
  if (req.method === 'GET' && req.url.startsWith('/api/fs-watch')) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const watchPath = url.searchParams.get('path');
    if (!withinProject(watchPath) || !fs.existsSync(watchPath)) {
      res.writeHead(400); res.end(); return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': req.headers.origin || 'http://localhost:5173'
    });

    res.write('retry: 1000\n\n');
    let debounceTimer;

    try {
      const watcher = fs.watch(watchPath, { recursive: true }, (eventType, filename) => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          res.write(`data: ${JSON.stringify({ type: 'fs-change', eventType, filename })}\n\n`);
        }, 500);
      });

      req.on('close', () => {
        watcher.close();
      });
    } catch (err) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
    }
    return;
  }

  // ─── API: Dosya Silme (Yapay Zeka veya Client İçin) ────────────────────
  if (req.method === 'POST' && req.url === '/api/delete-file') {
    const body = await parseBody(req);
    const targetPath = body.path;
    try {
      if (targetPath && fs.existsSync(targetPath)) {
        const stats = fs.statSync(targetPath);
        if (stats.isDirectory()) {
          fs.rmSync(targetPath, { recursive: true, force: true });
        } else {
          fs.unlinkSync(targetPath);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Dosya veya klasör bulunamadı' }));
      }
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ─── API: Web Search (Araştırma) ──────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/api/search-web') {
    const body = await parseBody(req);
    const query = body.query;
    if (!query) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Sorgu gerekli' }));
      return;
    }
    try {
      const fetch = require('node-fetch');
      const cheerio = require('cheerio');
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7'
        }
      });
      const html = await response.text();
      const cher = cheerio.load(html);
      
      const results = [];
      cher('.result').slice(0, 5).each(function() {
        const title = cher(this).find('.result__title').text().trim();
        const link = cher(this).find('.result__url').attr('href') || cher(this).find('.result__a').attr('href');
        const snippet = cher(this).find('.result__snippet').text().trim();
        
        if (title && snippet) {
          let cleanUrl = link;
          if (link && link.startsWith('//duckduckgo.com/l/?uddg=')) {
            try { cleanUrl = decodeURIComponent(link.split('uddg=')[1].split('&')[0]); } catch(e){}
          }
          results.push({ title, url: cleanUrl, description: snippet });
        }
      });
      
      if (results.length === 0) {
        results.push({ title: "Arama Sonuçsuz Kaldı", url: "https://duckduckgo.com/?q=" + encodeURIComponent(query), description: "Bu arama bot engeline takılmış olabilir." })
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ results }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/api/get-project-context') {
    const body = await parseBody(req);
    const dirPath = body.path;
    if (!dirPath || !fs.existsSync(dirPath)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Proje yolu bulunamadı' }));
      return;
    }
    try {
      let combined = '';
      const ignoreDirs = ['.git', 'node_modules', 'dist', 'build', '.next', 'out', 'public', '.vscode'];
      const ignoreExts = ['.png', '.jpg', '.jpeg', '.gif', '.mp4', '.svg', '.ico', '.zip', '.exe', '.dll', '.pdf', '.woff', '.ttf', '.eot', '.log', '.lock'];

      const walk = (d) => {
        if (combined.length > 50000) return; // ~50k karakter sınırı (model çökmesin diye)
        const entries = fs.readdirSync(d, { withFileTypes: true });

        // Tree yapısı oluştur
        for (const entry of entries) {
          if (ignoreDirs.includes(entry.name)) continue;
          const fullPath = path.join(d, entry.name);

          if (entry.isDirectory()) {
            walk(fullPath);
          } else {
            const ext = path.extname(entry.name).toLowerCase();
            if (ignoreExts.includes(ext)) continue;
            if (entry.name === 'package-lock.json' || entry.name === 'yarn.lock') continue;

            try {
              const stat = fs.statSync(fullPath);
              if (stat.size > 100000) continue; // 100kb+ dosyaları dahil etme

              const content = fs.readFileSync(fullPath, 'utf-8');
              if (content.indexOf('\x00') !== -1) continue; // İkili dosyaları atla

              const relativePath = path.relative(dirPath, fullPath).replace(/\\/g, '/');
              combined += `\n\n=== DOSYA: ${relativePath} ===\n${content}\n`;
            } catch (err) { }
          }
        }
      }

      walk(dirPath);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ context: combined }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ─── API: Uygulama ayarları ────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/api/settings') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(publicSettings(appSettings)));
    return;
  }

  if (req.method === 'POST' && req.url === '/api/settings') {
    try {
      appSettings = updateSettings(appSettings, await parseBody(req));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(publicSettings(appSettings)));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (req.method === 'GET' && req.url === '/api/settings/test') {
    try {
      const { base, apiKey } = activeConnection(appSettings);
      const upstream = await fetch(endpointUrl(base, 'models'), {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(10000),
      });
      if (!upstream.ok) throw new Error(`Model listesi alınamadı (${upstream.status})`);
      const data = await upstream.json();
      const models = Array.isArray(data.data) ? data.data.map(model => model.id).filter(Boolean) : [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, models }));
    } catch (error) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // ─── API: OpenAI uyumlu chat proxy ────────────────────────────────
  if (req.method === 'POST' && req.url === '/api/ai-chat') {
    const body = await parseBody(req);
    try {
      const { base, apiKey } = activeConnection(appSettings);
      const upstreamUrl = endpointUrl(base, 'chat/completions');
      const transport = require(upstreamUrl.protocol === 'https:' ? 'https' : 'http');
      const postData = JSON.stringify({ ...body, model: body.model || appSettings.ai.model });

      let upstreamResponse;
      const proxyReq = transport.request(upstreamUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
      }, (proxyRes) => {
        upstreamResponse = proxyRes;
        // Streaming header'larını kopyala
        res.writeHead(proxyRes.statusCode, {
          'Content-Type': proxyRes.headers['content-type'] || 'text/event-stream',
          'Access-Control-Allow-Origin': req.headers.origin || 'http://localhost:5173',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        // Veriyi olduğu gibi pipe et (streaming destekli)
        proxyRes.pipe(res);
      });

      proxyReq.on('error', (err) => {
        if (res.destroyed) return;
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'LM Studio bağlantı hatası: ' + err.message }));
      });

      res.on('close', () => {
        if (!res.writableEnded) {
          upstreamResponse?.destroy();
          proxyReq.destroy();
        }
      });

      proxyReq.setTimeout(600000, () => proxyReq.destroy(new Error('Model yanıtı zaman aşımına uğradı')));
      proxyReq.write(postData);
      proxyReq.end();
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ─── API: Aktif sağlayıcı model listesi ───────────────────────────
  if (req.method === 'GET' && req.url === '/api/ai-models') {
    try {
      const { base, apiKey } = activeConnection(appSettings);
      const upstream = await fetch(endpointUrl(base, 'models'), {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(10000),
      });
      if (!upstream.ok) throw new Error(`Model listesi alınamadı (${upstream.status})`);
      const data = await upstream.json();
      const models = Array.isArray(data.data) ? data.data : [];
      if (appSettings.ai.provider === 'remote' && appSettings.ai.model && !models.some(model => model.id === appSettings.ai.model)) models.unshift({ id: appSettings.ai.model });
      const selectedModel = models.some(model => model.id === appSettings.ai.model) ? appSettings.ai.model : models[0]?.id || '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: models, selectedModel }));
    } catch (error) {
      if (appSettings.ai.provider === 'remote' && appSettings.ai.model) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: appSettings.ai.model }], selectedModel: appSettings.ai.model, warning: error.message }));
      } else {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
    }
    return;
  }

  // ─── API: Agent Komut Çalıştırma ──────────────────────────────────
  if (req.method === 'POST' && req.url === '/api/agent-exec') {
    const body = await parseBody(req);
    const { command, cwd: execCwd } = body;
    if (!command) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'command gerekli' }));
      return;
    }
    const { exec } = require('child_process');
    const options = {
      cwd: execCwd || process.cwd(),
      timeout: 60000,
      maxBuffer: 1024 * 1024,
      shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash',
    };
    exec(command, options, (error, stdout, stderr) => {
      let exitCode = 0;
      if (error) {
        exitCode = typeof error.code === 'number' ? error.code : 1;
        if (error.killed) stderr = (stderr || '') + '\n[Komut zaman aşımına uğradı]';
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': req.headers.origin || 'http://localhost:5173' });
      res.end(JSON.stringify({
        exitCode,
        stdout: (stdout || '').slice(-10000),
        stderr: (stderr || '').slice(-5000),
      }));
    });
    return;
  }

  // ─── Agent uzun süren process yönetimi ──────────────────────────────

  // Process başlat — procId döner
  if (req.method === 'POST' && req.url === '/api/agent-run') {
    const body = await parseBody(req);
    let { command, cwd: execCwd } = body;
    if (!command) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'command gerekli' }));
      return;
    }
    command = (typeof command === 'string' ? command : '').trim();
    command = command.replace(/^\s*cmd\s*:\s*/i, '').trim();
    if (PLATFORM === 'win32' && command.toLowerCase().startsWith('cat ')) {
      const rest = command.slice(4).trim().replace(/^["']|["']$/g, '');
      command = 'type ' + rest;
    }

    const procId = agentProcCounter++;
    let stdout = '';
    let stderr = '';
    let exitCode = null;
    let running = true;
    let wasKilled = false;

    const proc = spawnCommand(command, execCwd);

    proc.stdout.on('data', (d) => { stdout = (stdout + d.toString()).slice(-10000); });
    proc.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-5000); });
    proc.on('close', (code) => {
      exitCode = wasKilled ? 130 : (code ?? 1);
      running = false;
      setTimeout(() => agentProcesses.delete(procId), 5 * 60 * 1000);
    });
    proc.on('error', (e) => { stderr += '\n' + e.message; running = false; exitCode = 1; });

    agentProcesses.set(procId, {
      proc,
      getStdout: () => stdout,
      getStderr: () => stderr,
      getExitCode: () => exitCode,
      isRunning: () => running,
      markKilled: () => { wasKilled = true; },
      startTime: Date.now(),
    });

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': req.headers.origin || 'http://localhost:5173' });
    res.end(JSON.stringify({ procId }));
    return;
  }

  // Process durumunu sorgula
  if (req.method === 'POST' && req.url === '/api/agent-status') {
    const body = await parseBody(req);
    const { procId } = body;
    const p = agentProcesses.get(procId);
    if (!p) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Process bulunamadı' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': req.headers.origin || 'http://localhost:5173' });
    res.end(JSON.stringify({
      running: p.isRunning(),
      stdout: p.getStdout().slice(-10000),
      stderr: p.getStderr().slice(-5000),
      exitCode: p.getExitCode(),
    }));
    return;
  }

  // Process durdur
  if (req.method === 'POST' && req.url === '/api/agent-kill') {
    const body = await parseBody(req);
    const { procId } = body;
    const p = agentProcesses.get(procId);
    if (p) {
      p.markKilled();
      try { killAgentProcess(p.proc); } catch (_) { }
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': req.headers.origin || 'http://localhost:5173' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.end('Terminal OK');
});
const wss = new WebSocketServer({ server, verifyClient: ({ req }) => ALLOWED_ORIGINS.has(req.headers.origin) });

// ─── Her bağlantı için ayrı state ──────────────────────────────────────────
wss.on('connection', (ws) => {
  let cwd = HOME;
  let line = '';
  let cursor = 0;
  let history = [];
  let histIdx = -1;
  let savedLine = '';
  let activeProc = null;

  // ─── Prompt ──────────────────────────────────────────────────────────────
  const prompt = () => {
    const short = cwd.replace(HOME, '~').replace(/\\/g, '/'); // Windows path fix
    return `${c.green}${USER}${c.reset} ${c.cyan}${short}${c.reset} % `;
  };

  const sendPrompt = () => ws.send('\r\n' + prompt());

  const redrawLine = () => {
    const after = line.length - cursor;
    let out = '\r\x1b[K' + prompt() + line;
    if (after > 0) out += `\x1b[${after}D`;
    ws.send(out);
  };

  setTimeout(sendPrompt, 100);

  // ─── Komut çalıştır ────────────────────────────────────────────────────
  const runCommand = (cmd) => {
    if (!cmd) { sendPrompt(); return; }

    history.push(cmd);
    if (history.length > 500) history.shift();
    histIdx = -1; savedLine = '';

    // cd komutu — tüm platformlarda özel işlem
    if (/^cd(\s+.*)?$/.test(cmd)) {
      const arg = cmd.slice(2).trim();
      let target;
      if (!arg || arg === '~') target = HOME;
      else if (arg === '-') target = cwd;
      else if (arg.startsWith('~/') || arg.startsWith('~\\'))
        target = path.join(HOME, arg.slice(2));
      else if (path.isAbsolute(arg)) target = arg;
      else target = path.join(cwd, arg);

      target = path.resolve(target);
      try {
        if (fs.statSync(target).isDirectory()) {
          cwd = target;
        } else {
          ws.send(`cd: not a directory: ${arg}\r\n`);
        }
      } catch (_) {
        ws.send(`cd: no such file or directory: ${arg}\r\n`);
      }
      sendPrompt();
      return;
    }

    // clear / cls
    if (cmd === 'clear' || cmd === 'cls') {
      ws.send('\x1b[2J\x1b[H' + prompt());
      return;
    }

    // Komutu çalıştır
    activeProc = spawnCommand(cmd, cwd);

    activeProc.stdout.on('data', (d) => ws.send(d.toString()));
    activeProc.stderr.on('data', (d) => ws.send(d.toString()));
    activeProc.on('close', () => { activeProc = null; sendPrompt(); });
    activeProc.on('error', (e) => {
      ws.send(`\r\n${c.red}Hata: ${e.message}${c.reset}\r\n`);
      activeProc = null;
      sendPrompt();
    });
  };

  // ─── Tab tamamlama ─────────────────────────────────────────────────────
  const doTab = () => {
    const parts = line.split(' ');
    const last = parts[parts.length - 1];

    const sep = PLATFORM === 'win32' ? '\\' : '/';
    const hasPath = last.includes('/') || last.includes('\\');
    const searchDir = hasPath
      ? path.dirname(path.resolve(cwd, last))
      : cwd;
    const prefix = hasPath ? path.basename(last) : last;

    let entries;
    try { entries = fs.readdirSync(searchDir); } catch (_) { return; }

    const matches = entries.filter(e => e.toLowerCase().startsWith(prefix.toLowerCase()));
    if (matches.length === 0) return;

    if (matches.length === 1) {
      const add = matches[0].slice(prefix.length);
      try {
        const full = path.join(searchDir, matches[0]);
        const isDir = fs.statSync(full).isDirectory();
        line += add + (isDir ? sep : '');
        cursor += add.length + (isDir ? 1 : 0);
      } catch (_) {
        line += add;
        cursor += add.length;
      }
      redrawLine();
    } else {
      // Ortak prefix bul
      let common = matches[0];
      for (const m of matches) {
        while (!m.toLowerCase().startsWith(common.toLowerCase())) {
          common = common.slice(0, -1);
        }
      }
      const add = common.slice(prefix.length);
      if (add) {
        line += add; cursor += add.length; redrawLine();
      } else {
        ws.send('\r\n' + matches.join('   ') + '\r\n');
        ws.send(prompt() + line);
      }
    }
  };

  // ─── Giriş işleme ──────────────────────────────────────────────────────
  ws.on('message', (msg) => {
    const raw = msg.toString();

    // JSON mesajları (chdir / resize)
    if (raw.startsWith('{')) {
      try {
        const data = JSON.parse(raw);
        if (data.type === 'chdir' && data.directory) {
          const dir = data.directory;
          const candidates = [
            dir,
            path.join(HOME, dir),
            path.join(HOME, 'Desktop', dir),
            path.join(HOME, 'Documents', dir),
            path.join(HOME, 'Downloads', dir),
          ];
          for (const c of candidates) {
            try {
              if (fs.existsSync(c) && fs.statSync(c).isDirectory()) {
                cwd = path.resolve(c);
                break;
              }
            } catch (_) { }
          }
          sendPrompt();
        }
        return;
      } catch (_) { }
    }

    // ─── Aktif interaktif process (python, node vb.) ────────────────────
    if (activeProc) {
      if (raw === '\x03') { // Ctrl+C
        try { activeProc.kill('SIGINT'); } catch (_) { }
        ws.send('^C\r\n');
        activeProc = null;
        sendPrompt();
        return;
      }
      if (raw === '\r' || raw === '\n') {
        try { activeProc.stdin.write('\n'); } catch (_) { }
        ws.send('\r\n');
        return;
      }
      if (raw === '\x7f' || raw === '\b') {
        try { activeProc.stdin.write(raw); } catch (_) { }
        ws.send('\b \b');
        return;
      }
      if (!raw.startsWith('\x1b') && (raw >= ' ' || raw === '\t')) {
        try { activeProc.stdin.write(raw); } catch (_) { }
        ws.send(raw);
      }
      return;
    }

    // ─── Readline ──────────────────────────────────────────────────────
    if (raw === '\x1b[A') { // Yukarı ok
      if (!history.length) return;
      if (histIdx === -1) { savedLine = line; histIdx = history.length - 1; }
      else if (histIdx > 0) histIdx--;
      line = history[histIdx]; cursor = line.length;
      redrawLine(); return;
    }
    if (raw === '\x1b[B') { // Aşağı ok
      if (histIdx === -1) return;
      if (histIdx < history.length - 1) { histIdx++; line = history[histIdx]; }
      else { histIdx = -1; line = savedLine; }
      cursor = line.length;
      redrawLine(); return;
    }
    if (raw === '\x1b[C') { // Sağ ok
      if (cursor < line.length) { cursor++; ws.send('\x1b[C'); }
      return;
    }
    if (raw === '\x1b[D') { // Sol ok
      if (cursor > 0) { cursor--; ws.send('\x1b[D'); }
      return;
    }
    if (raw === '\x1b[H' || raw === '\x01') { // Home / Ctrl+A
      if (cursor > 0) { ws.send(`\x1b[${cursor}D`); cursor = 0; }
      return;
    }
    if (raw === '\x1b[F' || raw === '\x05') { // End / Ctrl+E
      const rem = line.length - cursor;
      if (rem > 0) { ws.send(`\x1b[${rem}C`); cursor = line.length; }
      return;
    }
    if (raw === '\x15') { line = ''; cursor = 0; redrawLine(); return; } // Ctrl+U
    if (raw === '\x0b') { line = line.slice(0, cursor); redrawLine(); return; } // Ctrl+K
    if (raw === '\x03') { // Ctrl+C
      ws.send('^C');
      line = ''; cursor = 0; histIdx = -1;
      sendPrompt(); return;
    }
    if (raw === '\x04' && !line) { return; } // Ctrl+D boş satırda
    if (raw === '\r' || raw === '\n') { // Enter
      const cmd = line.trim();
      line = ''; cursor = 0; histIdx = -1;
      ws.send('\r\n');
      runCommand(cmd);
      return;
    }
    if (raw === '\x7f' || raw === '\b') { // Backspace
      if (cursor > 0) {
        line = line.slice(0, cursor - 1) + line.slice(cursor);
        cursor--;
        redrawLine();
      }
      return;
    }
    if (raw === '\x1b[3~') { // Delete
      if (cursor < line.length) {
        line = line.slice(0, cursor) + line.slice(cursor + 1);
        redrawLine();
      }
      return;
    }
    if (raw === '\t') { doTab(); return; }
    if (raw.startsWith('\x1b')) return; // Diğer escape'leri yoksay

    // Yazılabilir karakter
    line = line.slice(0, cursor) + raw + line.slice(cursor);
    cursor += raw.length;
    if (cursor === line.length) {
      ws.send(raw);
    } else {
      redrawLine();
    }
  });

  ws.on('close', () => {
    activeProc?.kill('SIGTERM');
  });

  ws.on('error', (e) => console.error('[terminal] WS hatası:', e.message));
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} kullanımda. Başka bir terminal-server.cjs çalışıyor olabilir.`);
    console.error(`Kapatmak için: lsof -ti:${PORT} | xargs kill -9`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Terminal backend: http://localhost:${PORT}`);
  console.log(`Platform: ${PLATFORM} | Shell: ${SHELL}`);
  console.log('WebSocket hazır');
});

const shutdown = () => {
  for (const entry of agentProcesses.values()) {
    if (entry.isRunning()) killAgentProcess(entry.proc);
  }
  wss.clients.forEach(client => client.terminate());
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
