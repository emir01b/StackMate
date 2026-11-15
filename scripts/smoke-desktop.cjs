const assert = require('node:assert/strict');
const { mkdtemp, mkdir, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright-core');
const WebSocket = require('ws');

const origin = 'app://stackmate';
const executable = process.argv[2];

function checkWebSocket(baseUrl, token, requestOrigin, command) {
  const url = new URL(baseUrl);
  url.protocol = 'ws:';
  if (token) url.searchParams.set('token', token);
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { origin: requestOrigin, handshakeTimeout: 5000 });
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error('StackMate terminal did not respond'));
    }, 8000);
    socket.once('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    socket.once('unexpected-response', (_request, response) => {
      clearTimeout(timeout);
      response.resume();
      resolve(response.statusCode);
    });
    socket.once('open', () => {
      if (command) {
        socket.send(command);
        socket.send('\r');
      } else {
        clearTimeout(timeout);
        socket.close();
        resolve(101);
      }
    });
    let output = '';
    socket.on('message', message => {
      output += message.toString();
      // Demand shell output on a separate line from the echoed command.
      if (command && /\r?\nstackmate_smoke\r?\n/.test(output)) {
        clearTimeout(timeout);
        socket.close();
        resolve(101);
      }
    });
  });
}

async function main() {
  const temp = await mkdtemp(path.join(tmpdir(), 'stackmate-desktop-smoke-'));
  const project = path.join(temp, 'project');
  await mkdir(project);
  const sample = path.join(project, 'hello.ts');
  await writeFile(sample, 'const stackmateSmoke: string = "hello";\n');
  const env = {
    ...process.env,
    STACKMATE_DATA_DIR: path.join(temp, 'data'),
    XDG_STATE_HOME: path.join(temp, 'state'),
    LOCALAPPDATA: path.join(temp, 'local'),
  };
  delete env.STACKMATE_DEV_URL;
  delete env.ELECTRON_RUN_AS_NODE;
  let desktop;
  let lastUrl;
  try {
    desktop = await electron.launch({
      executablePath: executable && path.resolve(executable),
      args: [...(executable ? [] : [path.resolve(__dirname, '..')]), '--user-data-dir=' + path.join(temp, 'profile')],
      env,
      chromiumSandbox: true,
      timeout: 30000,
    });
    const page = await desktop.firstWindow();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error' && /CORS policy|content security policy/i.test(message.text())) {
        pageErrors.push(message.text());
      }
    });
    await page.locator('.app-root').waitFor({ timeout: 15000 });
    assert.ok(page.url().startsWith(origin + '/'), page.url());

    const preferences = await desktop.evaluate(({ BrowserWindow }) => {
      const { contextIsolation, nodeIntegration, sandbox, webSecurity } = BrowserWindow.getAllWindows()[0]
        .webContents.getLastWebPreferences();
      return { contextIsolation, nodeIntegration, sandbox, webSecurity };
    });
    assert.deepEqual(preferences, { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true });
    const renderer = await page.evaluate(async () => ({
      nodeGlobals: [typeof window.require, typeof window.process, typeof window.module],
      methods: Object.keys(window.stackmate).sort(),
      connection: await window.stackmate.getConnection(),
    }));
    assert.deepEqual(renderer.nodeGlobals, ['undefined', 'undefined', 'undefined']);
    assert.deepEqual(renderer.methods, ['getConnection', 'onConnectionChanged', 'retryBackend', 'setDirty']);
    const { baseUrl, token } = renderer.connection;
    lastUrl = baseUrl;
    assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.match(token, /^[a-f0-9]{64}$/);
    const request = (route, options = {}) => fetch(baseUrl + route, {
      ...options,
      signal: AbortSignal.timeout(8000),
      headers: { Origin: origin, ...options.headers },
    });
    const auth = { Authorization: 'Bearer ' + token };
    assert.equal((await request('/api/os')).status, 401);
    assert.equal((await request('/api/os', { headers: { Authorization: 'Bearer ' + '0'.repeat(token.length) } })).status, 401);
    assert.equal((await request('/api/os?token=' + token)).status, 401);
    assert.equal((await request('/api/os', { headers: { ...auth, Origin: 'https://example.test' } })).status, 403);
    assert.equal(await page.evaluate(async ({ baseUrl, token }) => (
      await fetch(baseUrl + '/api/os', { headers: { Authorization: 'Bearer ' + token } })
    ).status, renderer.connection), 200);

    assert.equal((await request('/api/project-root', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: project }),
    })).status, 200);
    const sse = '/api/fs-watch?' + new URLSearchParams({ path: project });
    assert.equal((await request(sse)).status, 401);
    assert.equal((await request(sse + '&token=wrong')).status, 401);
    const changes = await request(sse + '&token=' + token);
    assert.equal(changes.status, 200);
    assert.match(changes.headers.get('content-type'), /text\/event-stream/);
    await changes.body.cancel();

    assert.equal(await checkWebSocket(baseUrl, null, origin), 401);
    assert.equal(await checkWebSocket(baseUrl, 'wrong', origin), 401);
    assert.equal(await checkWebSocket(baseUrl, token, 'https://example.test'), 401);
    assert.equal(await checkWebSocket(baseUrl, token, origin, 'echo stackmate_smoke'), 101);

    await page.evaluate(projectPath => localStorage.setItem('stackmate_verified_project_path', projectPath), project);
    await page.reload({ waitUntil: 'domcontentloaded' });
    const projectFile = page.getByRole('treeitem', { name: 'hello.ts' });
    await projectFile.waitFor({ timeout: 15000 });
    const [worker] = await Promise.all([
      page.waitForEvent('worker', { predicate: worker => /ts\.worker/.test(worker.url()), timeout: 15000 }),
      projectFile.click(),
    ]);
    assert.match(worker.url(), /^app:\/\/stackmate\//);
    const editor = page.locator('.monaco-editor');
    await editor.waitFor({ timeout: 10000 });
    assert.equal(await page.locator('.editor-filename').innerText(), 'hello.ts');
    const [rendererSocket] = await Promise.all([
      page.waitForEvent('websocket', { timeout: 10000 }),
      page.locator('button[title^="Terminal\'i Göster/Gizle"]').click(),
    ]);
    const socketUrl = new URL(rendererSocket.url());
    assert.equal(socketUrl.host, new URL(baseUrl).host);
    assert.equal(socketUrl.searchParams.get('token'), token);
    await page.locator('.terminal-panel .xterm').waitFor({ timeout: 10000 });

    const disconnect = page.evaluate(() => new Promise(resolve => {
      const unsubscribe = window.stackmate.onConnectionChanged(connection => {
        if (connection === null) {
          unsubscribe();
          resolve();
        }
      });
    }));
    const backendPid = await desktop.evaluate(({ app }) => (
      app.getAppMetrics().find(metric => metric.name === 'StackMate Terminal')?.pid
    ));
    assert.ok(backendPid, 'Electron utility backend is running');
    process.kill(backendPid);
    let disconnectTimer;
    try {
      await Promise.race([disconnect, new Promise((_, reject) => {
        disconnectTimer = setTimeout(() => reject(new Error('Backend disconnect was not announced')), 10000);
      })]);
    } finally {
      clearTimeout(disconnectTimer);
    }
    assert.equal(await page.evaluate(() => window.stackmate.getConnection()), null);
    const restarted = await page.evaluate(() => window.stackmate.retryBackend());
    lastUrl = restarted.baseUrl;
    assert.notEqual(restarted.token, token);
    assert.equal((await fetch(lastUrl + '/api/os', {
      headers: { Origin: origin, ...auth },
      signal: AbortSignal.timeout(5000),
    })).status, 401);
    await page.waitForFunction(async ({ baseUrl, token, sample }) => {
      const response = await fetch(baseUrl + '/api/read-file', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: sample }),
      });
      return response.ok && (await response.json()).content.includes('stackmateSmoke');
    }, { ...restarted, sample }, { polling: 250, timeout: 10000 });
    assert.equal(await page.locator('.editor-filename').innerText(), 'hello.ts');
    assert.deepEqual(pageErrors, []);
    await desktop.close();
    desktop = undefined;
    await assert.rejects(fetch(lastUrl + '/api/os', { signal: AbortSignal.timeout(3000) }));
    console.log('StackMate desktop smoke passed (renderer, backend auth, terminal, Monaco worker, restart, shutdown)');
  } finally {
    await desktop?.close();
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
