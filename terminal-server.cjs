const { WebSocketServer } = require('ws');
const { createServer } = require('http');
const { spawn, execFile } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { readSettings, publicSettings, updateSettings, activeConnection, endpointUrl } = require('./settings-store.cjs');

const PORT = Number(process.env.STACKMATE_PORT || 3001);
const ALLOWED_ORIGINS = new Set(['http://localhost:5173', 'http://127.0.0.1:5173']);
let projectRoot = null;
let folderPickerOpen = false;
let appSettings = readSettings();
const isInside = (root, target) => {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
};
// Var olan en yakın üst dizinin gerçek yolunu alır; böylece /tmp → /private/tmp gibi
// sembolik bağlantılı yollar da proje kökünün (realpath) içinde sayılır.
const realTargetPath = (target) => {
  let existing = path.resolve(target);
  const missing = [];
  for (;;) {
    try { fs.lstatSync(existing); break; } catch {
      const parent = path.dirname(existing);
      if (parent === existing) break;
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }
  // Kırık sembolik bağlantıda realpath hata verir ve işlem reddedilir.
  return path.join(fs.realpathSync(existing), ...missing);
};
const withinRoot = (target, root) => {
  if (!root || typeof target !== 'string' || !target) return false;
  try { return isInside(root, realTargetPath(target)); } catch { return false; }
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
    const recordPath = path.join(stageStoreDir, filename);
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    if (typeof record.filePath === 'string' && typeof record.root === 'string' && typeof record.after === 'string') {
      // Eski kayıtlarda zaman yoksa dosya zamanını kullan; geri alma sırası kronolojik olmalı.
      record.createdAt ??= fs.statSync(recordPath).mtimeMs;
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

// ─── Platform yardımcıları: klasör seçici, çöp kutusu, dosya yöneticisinde gösterme ──
const runFile = (command, args, options = {}) => new Promise((resolve, reject) => {
  execFile(command, args, { windowsHide: true, maxBuffer: 1024 * 1024, ...options }, (error, stdout, stderr) => {
    if (error) reject(Object.assign(error, { stderr: String(stderr || '') }));
    else resolve(String(stdout || ''));
  });
});

// PowerShell'e betiği tırnak sorunu olmadan iletmek için UTF-16LE base64 kullanılır.
const runPowerShell = (script, env = {}) => runFile('powershell.exe', [
  '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass',
  '-EncodedCommand', Buffer.from(`[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n${script}`, 'utf16le').toString('base64'),
], { env: { ...process.env, ...env }, timeout: 10 * 60 * 1000 });

const appleScriptString = (value) => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

// İşletim sisteminin kendi klasör seçicisini açar; iptalde null döner.
const pickFolder = async (startPath) => {
  const start = startPath && fs.existsSync(startPath) ? startPath : HOME;
  if (PLATFORM === 'darwin') {
    try {
      const output = await runFile('osascript', [
        '-e', 'activate',
        '-e', `POSIX path of (choose folder with prompt "Proje klasörünü seçin" default location (POSIX file ${appleScriptString(start)}))`,
      ], { timeout: 10 * 60 * 1000 });
      const picked = output.trim();
      return picked.length > 1 ? picked.replace(/\/+$/, '') : picked;
    } catch (error) {
      if (/-128/.test(error.stderr)) return null; // Kullanıcı iptal etti.
      throw error;
    }
  }
  if (PLATFORM === 'win32') {
    const output = await runPowerShell(`
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Proje klasörünü seçin'
$dialog.ShowNewFolderButton = $true
$dialog.SelectedPath = $env:STACKMATE_START
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }
if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }
$owner.Dispose()`, { STACKMATE_START: start });
    return output.trim() || null;
  }
  for (const [command, args] of [
    ['zenity', ['--file-selection', '--directory', '--title=Proje klasörünü seçin', `--filename=${start}/`]],
    ['kdialog', ['--getexistingdirectory', start, '--title', 'Proje klasörünü seçin']],
  ]) {
    try {
      return (await runFile(command, args, { timeout: 10 * 60 * 1000 })).trim() || null;
    } catch (error) {
      if (error.code === 'ENOENT') continue; // Bu araç kurulu değil.
      if (error.code === 1) return null; // İptal.
      throw error;
    }
  }
  throw Object.assign(new Error('Bu sistemde klasör seçici bulunamadı (zenity veya kdialog kurun)'), { code: 'UNSUPPORTED' });
};

// Silinen öğeyi kalıcı silmek yerine çöp kutusuna / geri dönüşüm kutusuna taşır.
const moveToTrash = async (target) => {
  if (PLATFORM === 'darwin') {
    const trash = path.join(HOME, '.Trash');
    const base = path.basename(target);
    let destination = path.join(trash, base);
    // Çöp kutusu listelenemese de tek bir yol lstat ile denetlenebilir; çakışmada üzerine yazma.
    const taken = (candidate) => { try { fs.lstatSync(candidate); return true; } catch { return false; } };
    if (taken(destination)) {
      const ext = path.extname(base);
      destination = path.join(trash, `${path.basename(base, ext)} ${new Date().toISOString().replace(/[:.]/g, '-')}${ext}`);
    }
    try { fs.renameSync(target, destination); return; } catch (error) {
      if (!['EXDEV', 'EPERM', 'EACCES'].includes(error.code)) throw error;
    }
    // Farklı disk veya izin sorunu: Finder'ın kendisine taşıt.
    await runFile('osascript', ['-e', `tell application "Finder" to delete (POSIX file ${appleScriptString(target)} as alias)`], { timeout: 60 * 1000 });
    return;
  }
  if (PLATFORM === 'win32') {
    await runPowerShell(`
Add-Type -AssemblyName Microsoft.VisualBasic
$target = $env:STACKMATE_TARGET
if (Test-Path -LiteralPath $target -PathType Container) {
  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($target, 'OnlyErrorDialogs', 'SendToRecycleBin')
} else {
  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($target, 'OnlyErrorDialogs', 'SendToRecycleBin')
}`, { STACKMATE_TARGET: target });
    if (fs.existsSync(target)) throw new Error('Geri dönüşüm kutusuna taşınamadı');
    return;
  }
  await runFile('gio', ['trash', target], { timeout: 60 * 1000 });
};

const revealInFileManager = (target) => {
  if (PLATFORM === 'darwin') return runFile('open', ['-R', target]);
  // explorer.exe başarılı olsa bile 1 ile çıkabilir; sonucu beklemeden döner.
  if (PLATFORM === 'win32') { spawn('explorer.exe', [`/select,${target}`], { detached: true, stdio: 'ignore' }).unref(); return Promise.resolve(); }
  return runFile('xdg-open', [fs.statSync(target).isDirectory() ? target : path.dirname(target)]);
};

// Dosya sistemi hatalarını kullanıcıya anlaşılır biçimde aktar.
const fsErrorMessage = (error) => ({
  EEXIST: 'Bu adla bir dosya veya klasör zaten var',
  ENOENT: 'Dosya veya klasör bulunamadı',
  EACCES: 'Bu işlem için izin yok',
  EPERM: 'İzin yok veya dosya başka bir program tarafından kullanılıyor',
  EBUSY: 'Dosya başka bir program tarafından kullanılıyor',
  ENOTEMPTY: 'Klasör boş değil',
  ENOTDIR: 'Yol bir klasör değil',
  EISDIR: 'Yol bir klasör',
  EINVAL: 'Geçersiz ad veya yol',
  ENAMETOOLONG: 'Ad veya yol çok uzun',
}[error.code] || error.message);

// Explorer'da gösterilmeyen sistem dosyaları.
const HIDDEN_ENTRIES = new Set(['.git', '.DS_Store', 'Thumbs.db', 'desktop.ini', '.Spotlight-V100', '.Trashes', '$RECYCLE.BIN', 'System Volume Information']);
const naturalCompare = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

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

// Tek seviye dizin okuma (explorer klasörleri tıklandıkça yükler).
// Sembolik bağlantılar hedefinin türüyle gösterilir; kırık bağlantı dosya sayılır.
const readDirTree = (dirPath) => {
  const result = [];
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    if (HIDDEN_ENTRIES.has(entry.name)) continue;
    let isDirectory = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      try { isDirectory = fs.statSync(path.join(dirPath, entry.name)).isDirectory(); } catch { isDirectory = false; }
    }
    result.push({ name: entry.name, type: isDirectory ? 'folder' : 'file', ...(entry.isSymbolicLink() ? { symlink: true } : {}) });
  }
  return result.sort((a, b) => (a.type === b.type ? naturalCompare(a.name, b.name) : a.type === 'folder' ? -1 : 1));
};

// Büyük bağımlılık/çıktı klasörleri derin okumada açılmaz; explorer bunları tıklanınca yükler.
const HEAVY_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'vendor', '__pycache__', 'venv', 'target']);

// Rekürsif dizin okuma (tüm derinlik)
const readDirTreeDeep = (dirPath) => {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    if (HIDDEN_ENTRIES.has(entry.name)) continue;
    if (entry.isDirectory()) {
      result.push({
        name: entry.name,
        type: 'folder',
        children: HEAVY_DIRS.has(entry.name) ? [] : readDirTreeDeep(path.join(dirPath, entry.name)),
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

// Agent için girintili, sınırlı dizin listesi (klasörler "/" ile biter).
const listDirForAgent = (dirPath, { maxDepth = 3, maxEntries = 400 } = {}) => {
  const lines = [];
  let truncated = false;
  const walk = (current, depth) => {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    entries = entries.filter(entry => !entry.name.startsWith('.') || entry.name === '.env.example')
      .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
    for (const entry of entries) {
      if (lines.length >= maxEntries) { truncated = true; return; }
      const indent = '  '.repeat(depth);
      if (entry.isDirectory()) {
        const skipped = HEAVY_DIRS.has(entry.name);
        lines.push(`${indent}${entry.name}/${skipped ? ' (içerik listelenmedi)' : ''}`);
        if (!skipped && depth + 1 < maxDepth) walk(path.join(current, entry.name), depth + 1);
      } else {
        lines.push(`${indent}${entry.name}`);
      }
    }
  };
  walk(dirPath, 0);
  if (truncated) lines.push(`... (liste ${maxEntries} öğeyle sınırlandı; alt klasörü ayrıca listeleyin)`);
  return lines.join('\n');
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
    // Elle yazılan yolda tırnak (Windows "Yol olarak kopyala"), ~ ve sondaki ayırıcı tolere edilir.
    let requested = typeof body.path === 'string' ? body.path.trim().replace(/^["']|["']$/g, '') : '';
    if (requested === '~' || requested.startsWith('~/') || requested.startsWith('~\\')) requested = path.join(HOME, requested.slice(1));
    res.setHeader('Content-Type', 'application/json');
    if (!requested || !path.isAbsolute(requested)) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Tam klasör yolu girin (ör. ' + (PLATFORM === 'win32' ? 'C:\\Users\\ad\\proje' : '/Users/ad/proje') + ')' }));
      return;
    }
    try {
      const root = fs.realpathSync(requested);
      if (!fs.statSync(root).isDirectory()) throw Object.assign(new Error('Bu yol bir klasör değil'), { code: 'ENOTDIR' });
      projectRoot = root;
      res.writeHead(200);
      res.end(JSON.stringify({ path: root, name: path.basename(root) || root }));
    } catch (err) { res.writeHead(400); res.end(JSON.stringify({ error: fsErrorMessage(err) })); }
    return;
  }

  // ─── API: İşletim sisteminin klasör seçicisi ───────────────────────
  if (req.method === 'POST' && req.url === '/api/pick-folder') {
    const { startPath } = await parseBody(req);
    res.setHeader('Content-Type', 'application/json');
    if (folderPickerOpen) { res.writeHead(409); res.end(JSON.stringify({ error: 'Klasör seçici zaten açık' })); return; }
    folderPickerOpen = true;
    try {
      const picked = await pickFolder(typeof startPath === 'string' ? startPath : '');
      res.writeHead(200);
      res.end(JSON.stringify(picked ? { path: picked } : { cancelled: true }));
    } catch (error) {
      res.writeHead(error.code === 'UNSUPPORTED' ? 501 : 500);
      res.end(JSON.stringify({ error: error.code === 'UNSUPPORTED' ? error.message : `Klasör seçici açılamadı: ${error.stderr?.trim() || error.message}` }));
    } finally { folderPickerOpen = false; }
    return;
  }

  const guardedPaths = {
    '/api/read-dir': ['path'], '/api/read-subdir': ['path'], '/api/read-file': ['path'], '/api/list-dir': ['path'],
    '/api/save-file': ['path'], '/api/edit-file': ['path'], '/api/rename': ['oldPath', 'newPath'],
    '/api/delete': ['path'], '/api/delete-file': ['path'], '/api/mkdir': ['path'],
    '/api/create-file': ['path'], '/api/reveal': ['path'],
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
        const { replaceUniqueText, supportsWhitespaceMatch } = await import('./src/utils/editMatching.js');
        after = replaceUniqueText(before, oldText, newText, { allowWhitespace: supportsWhitespaceMatch(filePath) });
      }
      if (before === after) throw new Error('Değişiklik dosyada fark oluşturmuyor; içerik zaten aynı');
      const token = randomUUID();
      const record = { filePath, before, after, existed, root: projectRoot, type, oldText, newText, createdAt: Date.now() };
      fs.mkdirSync(stageStoreDir, { recursive: true, mode: 0o700 });
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
      res.end(JSON.stringify({ token, created: !existed, content: after }));
    } catch (err) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.method === 'GET' && req.url === '/api/agent-pending') {
    const pending = [...stagedChanges.entries()]
      .filter(([, change]) => change.root === projectRoot && withinProject(change.filePath))
      .sort(([, a], [, b]) => (a.createdAt || 0) - (b.createdAt || 0))
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
      const content = fs.readFileSync(filePath, 'utf-8');
      const { replaceUniqueText, supportsWhitespaceMatch } = await import('./src/utils/editMatching.js');
      let newContent;
      try {
        newContent = replaceUniqueText(content, oldText, newText, { allowWhitespace: supportsWhitespaceMatch(filePath) });
      } catch (error) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
        return;
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
      if (fs.statSync(filePath).isDirectory()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bu yol bir klasör, dosya değil', directory: true }));
        return;
      }
      const { size } = fs.statSync(filePath);
      const name = path.basename(filePath);
      // İkili veya çok büyük dosyalar metin olarak açılmaz; editör bunun yerine bilgi gösterir.
      if (size > 5 * 1024 * 1024) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ content: '', name, size, tooLarge: true }));
        return;
      }
      const buffer = fs.readFileSync(filePath);
      if (buffer.subarray(0, 8000).includes(0)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ content: '', name, size, binary: true }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ content: buffer.toString('utf8'), name, size }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ─── API: Agent için dizin listesi ─────────────────────────────────
  if (req.method === 'POST' && req.url === '/api/list-dir') {
    const { path: dirPath } = await parseBody(req);
    try {
      if (!fs.existsSync(dirPath)) throw new Error('Klasör bulunamadı');
      if (!fs.statSync(dirPath).isDirectory()) throw new Error('Bu yol bir dosya, klasör değil');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ listing: listDirForAgent(dirPath) }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
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

  // ─── API: Explorer dosya işlemleri ──────────────────────────────────
  // Tüm yollar proje kökü içinde doğrulanmıştır (guardedPaths). Adlar Windows kurallarına göre de denetlenir.
  const sendJson = (status, payload) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };
  const nameError = async (fullPath) => {
    const { validateEntryName } = await import('./src/utils/paths.js');
    // Kök realpath olduğu için yol da gerçek yoluna çevrilir (/tmp → /private/tmp gibi bağlantılar).
    return validateEntryName(path.relative(projectRoot, realTargetPath(fullPath)).split(path.sep).join('/'));
  };
  // Aynı dosyanın iki adı (ör. yalnızca büyük/küçük harf değişikliği) üzerine yazma sayılmaz.
  const sameEntry = (a, b) => {
    try {
      const first = fs.statSync(a);
      const second = fs.statSync(b);
      return first.ino === second.ino && first.dev === second.dev;
    } catch { return false; }
  };

  if (req.method === 'POST' && req.url === '/api/create-file') {
    const { path: filePath, content = '' } = await parseBody(req);
    try {
      const invalid = await nameError(filePath);
      if (invalid) return sendJson(400, { error: invalid });
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      // "wx": var olan dosyanın üzerine asla yazmaz.
      fs.writeFileSync(filePath, typeof content === 'string' ? content : '', { encoding: 'utf8', flag: 'wx' });
      sendJson(200, { ok: true, path: filePath });
    } catch (err) { sendJson(err.code === 'EEXIST' ? 409 : 500, { error: fsErrorMessage(err) }); }
    return;
  }

  if (req.method === 'POST' && req.url === '/api/rename') {
    const { oldPath, newPath } = await parseBody(req);
    try {
      if (realTargetPath(oldPath) === projectRoot) return sendJson(400, { error: 'Proje kök klasörü yeniden adlandırılamaz' });
      if (!fs.existsSync(oldPath)) return sendJson(404, { error: 'Kaynak bulunamadı' });
      const invalid = await nameError(newPath);
      if (invalid) return sendJson(400, { error: invalid });
      if (fs.existsSync(newPath) && !sameEntry(oldPath, newPath)) return sendJson(409, { error: fsErrorMessage({ code: 'EEXIST' }) });
      if (path.resolve(newPath).startsWith(path.resolve(oldPath) + path.sep)) return sendJson(400, { error: 'Klasör kendi içine taşınamaz' });
      fs.mkdirSync(path.dirname(newPath), { recursive: true });
      fs.renameSync(oldPath, newPath);
      sendJson(200, { ok: true, oldPath, newPath });
    } catch (err) { sendJson(500, { error: fsErrorMessage(err) }); }
    return;
  }

  // Explorer'dan silme: varsayılan olarak çöp kutusuna taşır; yalnızca açıkça istenirse kalıcı siler.
  if (req.method === 'POST' && ['/api/delete', '/api/delete-file'].includes(req.url)) {
    const { path: targetPath, permanent } = await parseBody(req);
    try {
      if (realTargetPath(targetPath) === projectRoot) return sendJson(400, { error: 'Proje kök klasörü silinemez' });
      if (!fs.existsSync(targetPath)) return sendJson(404, { error: 'Dosya veya klasör bulunamadı' });
      if (permanent === true) {
        fs.rmSync(targetPath, { recursive: true, force: true });
        return sendJson(200, { ok: true, permanent: true });
      }
      try {
        await moveToTrash(targetPath);
      } catch (error) {
        return sendJson(500, { error: `Çöp kutusuna taşınamadı: ${error.stderr?.trim() || fsErrorMessage(error)}`, trashFailed: true });
      }
      sendJson(200, { ok: true, trashed: true });
    } catch (err) { sendJson(500, { error: fsErrorMessage(err) }); }
    return;
  }

  if (req.method === 'POST' && req.url === '/api/mkdir') {
    const { path: dirPath, exclusive } = await parseBody(req);
    try {
      const invalid = await nameError(dirPath);
      if (invalid) return sendJson(400, { error: invalid });
      // Explorer yeni klasörde var olanı bildirmek ister; agent için var olan klasör hata değildir.
      if (exclusive === true && fs.existsSync(dirPath)) return sendJson(409, { error: fsErrorMessage({ code: 'EEXIST' }) });
      fs.mkdirSync(dirPath, { recursive: true });
      sendJson(200, { ok: true, path: dirPath });
    } catch (err) { sendJson(500, { error: fsErrorMessage(err) }); }
    return;
  }

  if (req.method === 'POST' && req.url === '/api/reveal') {
    const { path: targetPath } = await parseBody(req);
    try {
      await revealInFileManager(targetPath);
      sendJson(200, { ok: true });
    } catch (err) { sendJson(500, { error: fsErrorMessage(err) }); }
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
    const changed = new Set();
    const onChange = (eventType, filename) => {
      const relative = String(filename || '').split(path.sep).join('/');
      // Bağımlılık ve git klasörlerindeki değişiklikler explorer'ı gereksiz yere yeniler.
      if (/(^|\/)(node_modules|\.git)(\/|$)/.test(relative)) return;
      changed.add(relative);
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        res.write(`data: ${JSON.stringify({ type: 'fs-change', paths: [...changed].slice(0, 200) })}\n\n`);
        changed.clear();
      }, 300);
    };

    let watcher;
    try {
      watcher = fs.watch(watchPath, { recursive: true }, onChange);
    } catch {
      // Eski Node sürümlerinde Linux özyinelemeli izlemeyi desteklemez; en azından kök izlenir.
      try { watcher = fs.watch(watchPath, onChange); } catch (err) {
        res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
      }
    }
    watcher?.on('error', () => {});
    req.on('close', () => { clearTimeout(debounceTimer); watcher?.close(); });
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
      // LM Studio yüklü modelin gerçek bağlam uzunluğunu ayrı uç noktada bildirir; istem bütçesi bununla hesaplanır.
      if (appSettings.ai.provider === 'local') {
        try {
          const details = await fetch(new URL('/api/v0/models', base).href, { signal: AbortSignal.timeout(3000) });
          if (details.ok) {
            const byId = new Map(((await details.json()).data || []).map(model => [model.id, model]));
            for (const model of models) {
              const info = byId.get(model.id);
              if (info?.type === 'embeddings') model.embedding = true;
              if (info?.loaded_context_length) model.context_length = info.loaded_context_length;
            }
          }
        } catch { /* LM Studio dışındaki sunucular bu uç noktayı sunmaz */ }
      }
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
    if (PLATFORM === 'win32' && /^ls(?:\s+-[alh]+)?\s*$/i.test(command)) command = 'dir';
    if (PLATFORM === 'win32' && /^pwd\s*$/i.test(command)) command = 'cd';
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
    res.end(JSON.stringify({ procId, command }));
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
