const { WebSocketServer } = require('ws');
const { createServer }    = require('http');
const { spawn }           = require('child_process');
const os   = require('os');
const fs   = require('fs');
const path = require('path');

const PORT     = 3001;
const PLATFORM = os.platform(); // 'darwin' | 'linux' | 'win32'
const HOME     = os.homedir();
const USER     = os.userInfo().username;

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
  reset : '\x1b[0m',
  green : '\x1b[32m',
  cyan  : '\x1b[36m',
  red   : '\x1b[31m',
};

const server = createServer((_req, res) => { res.end('Terminal OK'); });
const wss    = new WebSocketServer({ server });

// ─── Her bağlantı için ayrı state ──────────────────────────────────────────
wss.on('connection', (ws) => {
  let cwd        = HOME;
  let line       = '';
  let cursor     = 0;
  let history    = [];
  let histIdx    = -1;
  let savedLine  = '';
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
      if (!arg || arg === '~')        target = HOME;
      else if (arg === '-')           target = cwd;
      else if (arg.startsWith('~/') || arg.startsWith('~\\'))
                                      target = path.join(HOME, arg.slice(2));
      else if (path.isAbsolute(arg))  target = arg;
      else                            target = path.join(cwd, arg);

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
    const parts  = line.split(' ');
    const last   = parts[parts.length - 1];

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
        line   += add + (isDir ? sep : '');
        cursor += add.length + (isDir ? 1 : 0);
      } catch (_) {
        line   += add;
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
            } catch (_) {}
          }
          sendPrompt();
        }
        return;
      } catch (_) {}
    }

    // ─── Aktif interaktif process (python, node vb.) ────────────────────
    if (activeProc) {
      if (raw === '\x03') { // Ctrl+C
        try { activeProc.kill('SIGINT'); } catch (_) {}
        ws.send('^C\r\n');
        activeProc = null;
        sendPrompt();
        return;
      }
      if (raw === '\r' || raw === '\n') {
        try { activeProc.stdin.write('\n'); } catch (_) {}
        ws.send('\r\n');
        return;
      }
      if (raw === '\x7f' || raw === '\b') {
        try { activeProc.stdin.write(raw); } catch (_) {}
        ws.send('\b \b');
        return;
      }
      if (!raw.startsWith('\x1b') && (raw >= ' ' || raw === '\t')) {
        try { activeProc.stdin.write(raw); } catch (_) {}
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
    line   = line.slice(0, cursor) + raw + line.slice(cursor);
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
