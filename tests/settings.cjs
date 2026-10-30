const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    server.close(() => resolve(port));
  });
});

test('settings persist and remote model proxy keeps the API key on the backend', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stackmate-settings-'));
  const backendPort = await freePort();
  const mockPort = await freePort();
  const received = [];
  const mock = createServer((req, res) => {
    received.push({ path: req.url, authorization: req.headers.authorization });
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
    } else if (req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n');
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => mock.listen(mockPort, '127.0.0.1', resolve));
  const startBackend = () => spawn(process.execPath, ['terminal-server.cjs'], {
    cwd: path.join(__dirname, '..'), env: { ...process.env, STACKMATE_PORT: String(backendPort), STACKMATE_DATA_DIR: dataDir }, stdio: 'ignore',
  });
  let backend = startBackend();
  const url = `http://127.0.0.1:${backendPort}`;
  const origin = 'http://localhost:5173';
  const post = (route, body) => fetch(url + route, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const get = route => fetch(url + route, { headers: { Origin: origin } });
  const waitReady = async () => {
    for (let attempt = 0; attempt < 30; attempt++) {
      try { if ((await get('/api/os')).ok) return; } catch { /* startup */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Backend başlamadı');
  };
  try {
    await waitReady();
    const initial = await (await get('/api/settings')).json();
    assert.equal(initial.ai.provider, 'local');
    assert.equal(initial.ai.apiKey, undefined);
    const savedResponse = await post('/api/settings', {
      ai: { provider: 'remote', remoteBaseUrl: `http://127.0.0.1:${mockPort}/v1`, apiKey: 'test-secret', model: 'mock-model', temperature: 0.4, maxTokens: 1024, autoContinue: false, useNativeTools: false, maxAutoSteps: 3 },
      editor: { fontSize: 16, minimap: false }, appearance: { density: 'compact', accent: 'violet' },
    });
    assert.equal(savedResponse.status, 200);
    const saved = await savedResponse.json();
    assert.equal(saved.ai.apiKey, undefined);
    assert.equal(saved.ai.apiKeySet, true);
    assert.equal(saved.ai.useNativeTools, false);
    assert.equal(saved.editor.fontSize, 16);
    assert.equal(saved.appearance.accent, 'violet');
    assert.equal((await post('/api/settings', { ai: { remoteBaseUrl: 'http://example.com/v1' } })).status, 400);
    const testResult = await (await get('/api/settings/test')).json();
    assert.deepEqual(testResult.models, ['mock-model']);
    const models = await (await get('/api/ai-models')).json();
    assert.equal(models.selectedModel, 'mock-model');
    const chat = await post('/api/ai-chat', { model: 'mock-model', messages: [{ role: 'user', content: 'hello' }], stream: true });
    assert.equal(chat.status, 200);
    assert.match(await chat.text(), /OK/);
    assert.ok(received.every(request => request.authorization === 'Bearer test-secret'));
    backend.kill();
    await new Promise(resolve => backend.once('exit', resolve));
    backend = startBackend();
    await waitReady();
    const restored = await (await get('/api/settings')).json();
    assert.equal(restored.ai.provider, 'remote');
    assert.equal(restored.ai.apiKeySet, true);
    assert.equal(restored.ai.apiKey, undefined);
  } finally {
    backend.kill();
    await new Promise(resolve => mock.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
