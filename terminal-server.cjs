const { WebSocketServer } = require('ws');
const { createServer } = require('http');
const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

const PORT = 3001;
const PLATFORM = os.platform(); // 'darwin' | 'linux' | 'win32'
const HOME = os.homedir();
const USER = os.userInfo().username;

// ─── Platform'a göre shell seçimi ──────────────────────────────────────────
const getShell = () => {
  if (PLATFORM === 'win32') return process.env.COMSPEC || 'cmd.exe';
  return process.env.SHELL || (PLATFORM === 'darwin' ? '/bin/zsh' : '/bin/bash');
};

const SHELL = getShell();

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
const parseBody = (req) => new Promise((resolve, reject) => {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
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

  // ─── API: LM Studio proxy (CORS bypass) — chat completions ────────
  if (req.method === 'POST' && req.url === '/api/ai-chat') {
    const body = await parseBody(req);
    try {
      const http = require('http');
      const postData = JSON.stringify(body);

      const proxyReq = http.request({
        hostname: '127.0.0.1',
        port: 1234,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
      }, (proxyRes) => {
        // Streaming header'larını kopyala
        res.writeHead(proxyRes.statusCode, {
          'Content-Type': proxyRes.headers['content-type'] || 'text/event-stream',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        // Veriyi olduğu gibi pipe et (streaming destekli)
        proxyRes.pipe(res);
      });

      proxyReq.on('error', (err) => {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'LM Studio bağlantı hatası: ' + err.message }));
      });

      proxyReq.write(postData);
      proxyReq.end();
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ─── API: LM Studio proxy — model listesi ────────────────────────
  if (req.method === 'GET' && req.url === '/api/ai-models') {
    try {
      const http = require('http');
      const proxyReq = http.request({
        hostname: '127.0.0.1',
        port: 1234,
        path: '/v1/models',
        method: 'GET',
      }, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        proxyRes.pipe(res);
      });

      proxyReq.on('error', (err) => {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'LM Studio bağlantı hatası: ' + err.message }));
      });

      proxyReq.end();
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.end('Terminal OK');
});
const wss = new WebSocketServer({ server });

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

server.listen(PORT, () => {
  console.log(`Terminal backend: http://localhost:${PORT}`);
  console.log(`Platform: ${PLATFORM} | Shell: ${SHELL}`);
  console.log('WebSocket hazır');
});
