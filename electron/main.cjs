const { app, BrowserWindow, dialog, ipcMain, net, protocol, shell, utilityProcess, session } = require('electron');
const { execFile } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const APP_ORIGIN = 'app://stackmate';
const DIST = path.join(__dirname, '..', 'build', 'renderer');
const BACKEND = path.join(__dirname, '..', 'terminal-server.cjs');
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}]);

function getDevUrl() {
  if (app.isPackaged || !process.env.STACKMATE_DEV_URL) return null;
  const url = new URL(process.env.STACKMATE_DEV_URL);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password) {
    throw new Error('STACKMATE_DEV_URL must point to a local HTTP development server');
  }
  return url;
}

const devUrl = getDevUrl();
const rendererUrl = devUrl?.href ?? `${APP_ORIGIN}/index.html`;
const rendererOrigin = devUrl?.origin ?? APP_ORIGIN;
const rendererPermissions = new Set([
  'clipboard-read',
  'clipboard-sanitized-write',
  'local-network-access',
  'loopback-network',
]);
let window;
let backend;
let backendCleanup;
let connection = null;
let dirty = false;
let quitting = false;
let mayQuit = false;
let folderDialogOpen = false;

function isRendererUrl(value) {
  if (!value) return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  if (devUrl) return url.origin === rendererOrigin;
  return url.protocol === 'app:' && url.host === 'stackmate' && !url.username && !url.password;
}

function isRenderer(event) {
  return event.sender === window?.webContents &&
    event.senderFrame === window.webContents.mainFrame &&
    isRendererUrl(event.senderFrame.url);
}

function showExternal(url) {
  let destination;
  try { destination = new URL(url); } catch { return; }
  if (!['http:', 'https:'].includes(destination.protocol) || destination.username || destination.password) return;
  void shell.openExternal(destination.href).catch(error => console.error('[stackmate] Could not open link:', error.message));
}

function announce(nextConnection) {
  connection = nextConnection;
  if (window && !window.isDestroyed()) window.webContents.send('stackmate:connection-changed', nextConnection);
}

async function showFolder(child, { id, startPath }) {
  if (folderDialogOpen || !window || window.isDestroyed() || quitting) {
    if (backend?.child === child) child.postMessage({ type: 'folder-result', id, path: null });
    return;
  }
  folderDialogOpen = true;
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog(window, {
      title: 'Proje klasörünü seçin',
      defaultPath: startPath,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (backend?.child === child) child.postMessage({ type: 'folder-result', id, path: canceled ? null : filePaths[0] });
  } catch (error) {
    if (backend?.child === child) child.postMessage({ type: 'folder-result', id, error: error.message });
  } finally {
    folderDialogOpen = false;
  }
}

function windowsProcessSnapshot() {
  return new Promise(resolve => {
    execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | ' +
        'Select-Object ProcessId,ParentProcessId,@{Name="StartedAt";Expression={([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}} | ' +
        'ConvertTo-Json -Compress',
    ], { windowsHide: true, timeout: 3000 }, (error, stdout) => {
      try { resolve(error ? [] : JSON.parse(stdout)); }
      catch { resolve([]); }
    });
  });
}

async function killRemainingCommands(commands) {
  if (!commands.size) return;
  if (process.platform !== 'win32') {
    for (const pid of commands.keys()) {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* Process group already exited. */ }
    }
    return;
  }
  // Windows may remove the shell when Electron's utility process crashes, leaving its children alive.
  const snapshot = await windowsProcessSnapshot();
  const processes = new Map(snapshot.map(proc => [proc.ProcessId, proc]));
  const children = new Map();
  for (const proc of snapshot) {
    if (!children.has(proc.ParentProcessId)) children.set(proc.ParentProcessId, []);
    children.get(proc.ParentProcessId).push(proc);
  }
  const targets = new Map();
  for (const [pid, { startedAfter, startedBefore }] of commands) {
    const root = processes.get(pid);
    if (root && !(root.StartedAt >= startedAfter - 5 && root.StartedAt <= startedBefore + 5)) continue;
    targets.set(pid, root?.StartedAt ?? startedAfter - 5);
  }
  for (const [pid, startedAt] of targets) {
    for (const child of children.get(pid) ?? []) {
      if (child.StartedAt >= startedAt && !targets.has(child.ProcessId)) targets.set(child.ProcessId, child.StartedAt);
    }
  }
  const identities = [...targets.keys()].filter(pid => processes.has(pid))
    .map(pid => ({ pid, startedAt: processes.get(pid).StartedAt }));
  if (!identities.length) return;
  await new Promise(resolve => {
    execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      'foreach ($identity in (ConvertFrom-Json $env:STACKMATE_COMMAND_IDENTITIES)) { ' +
        '$target = $null; try { $target = [Diagnostics.Process]::GetProcessById($identity.pid); ' +
        '$null = $target.SafeHandle; ' +
        'if (([DateTimeOffset]$target.StartTime).ToUnixTimeMilliseconds() -eq $identity.startedAt) { $target.Kill() } ' +
        '} catch {} finally { if ($null -ne $target) { $target.Dispose() } } }',
    ], {
      env: { ...process.env, STACKMATE_COMMAND_IDENTITIES: JSON.stringify(identities) },
      windowsHide: true,
      timeout: 3000,
    }, () => resolve());
  });
}

function startBackend() {
  if (quitting) return Promise.resolve(null);
  if (backend) return backend.ready;
  if (backendCleanup) return backendCleanup.then(startBackend);
  const token = randomBytes(32).toString('hex');
  let child;
  try {
    child = utilityProcess.fork(BACKEND, [], { cwd: app.getPath('home'), serviceName: 'StackMate Terminal' });
  } catch (error) {
    console.error('[stackmate] Could not launch terminal:', error.message);
    return Promise.resolve(null);
  }

  let resolveReady;
  let resolveExit;
  const commands = new Map();
  const instance = {
    child,
    ready: new Promise(resolve => { resolveReady = resolve; }),
    exited: new Promise(resolve => { resolveExit = resolve; }),
    stopping: false,
  };
  backend = instance;
  const timeout = setTimeout(() => {
    console.error('[stackmate] Terminal startup timed out');
    void stopBackend(instance);
  }, 12000);

  child.once('spawn', () => {
    if (!instance.stopping) child.postMessage({ type: 'init', token, origin: rendererOrigin });
  });
  child.on('message', (message) => {
    if (message.type === 'command-started' && Number.isInteger(message.pid) && message.pid > 0) {
      commands.set(message.pid, { startedAfter: message.startedAfter, startedBefore: message.startedBefore });
    }
    if (message.type === 'command-ended') commands.delete(message.pid);
    if (backend !== instance || instance.stopping) return;
    if (message.type === 'ready' && Number.isInteger(message.port) && message.port > 0 && message.port <= 65535) {
      clearTimeout(timeout);
      const next = { baseUrl: `http://127.0.0.1:${message.port}`, token };
      announce(next);
      resolveReady(next);
    }
    if (message.type === 'pick-folder') void showFolder(child, message);
  });
  child.once('exit', async (code) => {
    clearTimeout(timeout);
    if (!instance.stopping) console.error(`[stackmate] Terminal process exited (${code})`);
    const cleanup = killRemainingCommands(commands);
    backendCleanup = cleanup;
    if (backend === instance) {
      backend = undefined;
      announce(null);
    }
    resolveReady(null);
    await cleanup;
    if (backendCleanup === cleanup) backendCleanup = undefined;
    resolveExit();
  });
  return instance.ready;
}

async function stopBackend(instance = backend) {
  if (!instance) return backendCleanup;
  if (instance.stopping) return instance.exited;
  instance.stopping = true;
  const force = setTimeout(() => instance.child.kill(), 3500);
  instance.child.postMessage({ type: 'shutdown' });
  try {
    await instance.exited;
  } finally {
    clearTimeout(force);
  }
}

function retryBackend() {
  if (backend?.stopping) return backend.exited.then(startBackend);
  return startBackend();
}

function confirmDiscard() {
  if (!dirty || !window || window.isDestroyed()) return true;
  return dialog.showMessageBoxSync(window, {
    type: 'warning',
    title: 'Kaydedilmemiş değişiklikler',
    message: 'Kaydedilmemiş değişiklikler var. StackMate kapatılsın mı?',
    buttons: ['Vazgeç', 'Kapat'],
    defaultId: 0,
    cancelId: 0,
  }) === 1;
}

function createWindow() {
  const mainWindow = new BrowserWindow({
    icon: path.join(__dirname, 'assets', 'icon.png'),
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  window = mainWindow;
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!isRendererUrl(url)) showExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', event => {
    if (isRendererUrl(event.url)) return;
    event.preventDefault();
    showExternal(event.url);
  });
  mainWindow.webContents.on('will-redirect', event => {
    if (!isRendererUrl(event.url)) event.preventDefault();
  });
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !dirty) return;
    if (input.key === 'F5' || (input.control || input.meta) && input.key.toLowerCase() === 'r') {
      event.preventDefault();
    }
  });
  mainWindow.on('close', event => {
    if (mayQuit) return;
    event.preventDefault();
    app.quit();
  });
  mainWindow.on('closed', () => {
    if (window === mainWindow) window = undefined;
  });
  void mainWindow.loadURL(rendererUrl).catch(error => console.error('[stackmate] Could not load interface:', error.message));
}

function serveRenderer(request) {
  const url = new URL(request.url);
  if (!isRendererUrl(url.href) || !['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 404 });
  let file;
  try { file = path.resolve(DIST, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`); }
  catch { return new Response(null, { status: 400 }); }
  const relative = path.relative(DIST, file);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return new Response(null, { status: 404 });
  }
  return net.fetch(pathToFileURL(file).href).then(response => {
    const headers = new Headers(response.headers);
    headers.set('Content-Security-Policy', CSP);
    headers.set('Referrer-Policy', 'no-referrer');
    return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers });
  }).catch(() => new Response(null, { status: 404 }));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  app.on('before-quit', event => {
    if (mayQuit) return;
    event.preventDefault();
    if (quitting || !confirmDiscard()) return;
    quitting = true;
    void stopBackend().finally(() => {
      mayQuit = true;
      app.quit();
    });
  });
  if (devUrl && process.env.STACKMATE_DEV_PARENT === '1' && process.connected) {
    process.on('message', message => { if (message === 'quit') app.quit(); });
    process.on('disconnect', () => app.quit());
  }
  void app.whenReady().then(() => {
    if (!devUrl) protocol.handle('app', serveRenderer);
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      callback(contents === window?.webContents && rendererPermissions.has(permission) && isRendererUrl(details.requestingUrl));
    });
    session.defaultSession.setPermissionCheckHandler((contents, permission, origin) => (
      contents === window?.webContents && rendererPermissions.has(permission) && isRendererUrl(origin)
    ));
    ipcMain.handle('stackmate:get-connection', event => {
      if (!isRenderer(event)) throw new Error('Untrusted renderer');
      return backend && !backend.stopping ? backend.ready : connection;
    });
    ipcMain.handle('stackmate:retry-backend', event => {
      if (!isRenderer(event)) throw new Error('Untrusted renderer');
      return retryBackend();
    });
    ipcMain.on('stackmate:set-dirty', (event, value) => {
      if (isRenderer(event) && typeof value === 'boolean') dirty = value;
    });
    void startBackend();
    createWindow();
  });
}
