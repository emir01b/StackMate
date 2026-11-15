const assert = require('node:assert/strict');
const test = require('node:test');

test('renderer sends API credentials only to the active backend origin', async (t) => {
  const { apiFetch, setBackendConnection, streamUrl } = await import('../src/utils/backend.js');
  const connection = { baseUrl: 'http://127.0.0.1:48231', token: 'session-one' };
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response());
  setBackendConnection(connection);
  t.after(() => setBackendConnection(null));

  await apiFetch('/api/settings', { headers: { 'Content-Type': 'application/json' } });
  const [url, options] = fetch.mock.calls[0].arguments;
  assert.equal(url.href, connection.baseUrl + '/api/settings');
  assert.equal(url.search, '');
  assert.equal(options.headers.get('Authorization'), 'Bearer session-one');
  assert.equal(options.headers.get('Content-Type'), 'application/json');

  await assert.rejects(apiFetch('http://127.0.0.1:48232/api/settings'), /Geçersiz/);
  assert.throws(() => streamUrl('//example.test/api/fs-watch'), /Geçersiz/);
  assert.equal(fetch.mock.callCount(), 1);
});

test('transport stays disconnected while project restoration uses a replacement token', async (t) => {
  const { apiFetch, setBackendConnection, streamUrl } = await import('../src/utils/backend.js');
  const first = { baseUrl: 'http://127.0.0.1:48231', token: 'session-one' };
  const next = { baseUrl: 'http://127.0.0.1:48232', token: 'session-two' };
  const path = 'C:\\Örnek Proje\\#dosya';
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response());
  setBackendConnection(first);
  t.after(() => setBackendConnection(null));

  const initialTerminal = streamUrl('/', undefined, true);
  assert.equal(initialTerminal.protocol, 'ws:');
  assert.equal(initialTerminal.port, '48231');
  assert.equal(initialTerminal.searchParams.get('token'), first.token);

  setBackendConnection(null);
  await assert.rejects(apiFetch('/api/os'), /ulaşılamadı/);
  assert.throws(() => streamUrl('/api/fs-watch', { path }), /ulaşılamadı/);
  await apiFetch('/api/project-root', { method: 'POST' }, next);
  const [url, options] = fetch.mock.calls[0].arguments;
  assert.equal(url.href, next.baseUrl + '/api/project-root');
  assert.equal(options.headers.get('Authorization'), 'Bearer session-two');
  assert.throws(() => streamUrl('/api/fs-watch', { path }), /ulaşılamadı/);

  setBackendConnection(next);
  const watcher = streamUrl('/api/fs-watch', { path });
  assert.equal(watcher.origin, next.baseUrl);
  assert.equal(watcher.searchParams.get('path'), path);
  assert.equal(watcher.searchParams.get('token'), next.token);
  assert.equal(streamUrl('/', undefined, true).searchParams.get('token'), next.token);
});
