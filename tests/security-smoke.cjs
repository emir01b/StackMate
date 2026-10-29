const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

test('local API rejects foreign origins and project escape', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'stackmate-test-'));
  const root = path.join(parent, 'project');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'inside.txt'), 'inside');
  fs.writeFileSync(path.join(parent, 'outside.txt'), 'outside');
  const port = await new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const chosen = listener.address().port;
      listener.close(() => resolve(chosen));
    });
  });
  const startBackend = () => spawn(process.execPath, ['terminal-server.cjs'], { cwd: path.join(__dirname, '..'), env: { ...process.env, STACKMATE_PORT: String(port) }, stdio: 'ignore' });
  let child = startBackend();
  const url = `http://127.0.0.1:${port}`;
  const origin = 'http://localhost:5173';
  const post = (route, body, requestOrigin = origin) => fetch(url + route, {
    method: 'POST', headers: { Origin: requestOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      if (child.exitCode !== null) throw new Error('Backend could not start');
      try { ready = (await fetch(url + '/api/os', { headers: { Origin: origin } })).ok; } catch { /* startup */ }
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(ready, true);
    assert.equal((await fetch(url + '/api/os', { headers: { Origin: 'https://example.com' } })).status, 403);
    assert.equal((await post('/api/project-root', { path: root })).status, 200);
    assert.equal((await post('/api/read-file', { path: path.join(root, 'inside.txt') })).status, 200);
    assert.equal((await post('/api/read-file', { path: path.join(parent, 'outside.txt') })).status, 403);
    assert.equal((await fetch(url + '/api/fs-watch?path=' + encodeURIComponent(parent), { headers: { Origin: origin } })).status, 400);
    assert.equal((await post('/api/save-file', { path: path.join(root, '..', 'outside.txt'), content: 'changed' })).status, 403);
    assert.equal((await post('/api/agent-run', { command: 'echo escape', cwd: parent })).status, 403);
    const started = await (await post('/api/agent-run', { command: 'node -e "setInterval(()=>{},1000)"', cwd: root })).json();
    assert.ok(started.procId);
    let status = await (await post('/api/agent-status', { procId: started.procId })).json();
    assert.equal(status.running, true);
    assert.equal((await post('/api/agent-kill', { procId: started.procId })).status, 200);
    for (let attempt = 0; attempt < 30; attempt++) {
      status = await (await post('/api/agent-status', { procId: started.procId })).json();
      if (!status.running) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(status.running, false);
    assert.equal(status.exitCode, 130);
    fs.writeFileSync(path.join(root, 'duplicate.txt'), 'same\nsame\n');
    assert.equal((await post('/api/edit-file', { path: path.join(root, 'duplicate.txt'), oldText: 'same', newText: 'different' })).status, 409);
    assert.equal(fs.readFileSync(path.join(root, 'duplicate.txt'), 'utf8'), 'same\nsame\n');
    const createdPath = path.join(root, 'created.txt');
    const create = await (await post('/api/agent-stage', { path: createdPath, type: 'file', content: 'new' })).json();
    assert.equal(fs.readFileSync(createdPath, 'utf8'), 'new');
    assert.equal((await post('/api/agent-revert', { token: create.token })).status, 200);
    assert.equal(fs.existsSync(createdPath), false);
    const editPath = path.join(root, 'inside.txt');
    const edit = await (await post('/api/agent-stage', { path: editPath, type: 'edit', oldText: 'inside', newText: 'changed' })).json();
    assert.equal(fs.readFileSync(editPath, 'utf8'), 'changed');
    assert.equal((await post('/api/agent-revert', { token: edit.token })).status, 200);
    assert.equal(fs.readFileSync(editPath, 'utf8'), 'inside');
    const protectedEdit = await (await post('/api/agent-stage', { path: editPath, type: 'edit', oldText: 'inside', newText: 'staged' })).json();
    fs.writeFileSync(editPath, 'manual');
    assert.equal((await post('/api/agent-revert', { token: protectedEdit.token })).status, 409);
    assert.equal(fs.readFileSync(editPath, 'utf8'), 'manual');
    assert.equal((await post('/api/agent-commit', { token: protectedEdit.token })).status, 200);
    assert.equal(fs.readFileSync(editPath, 'utf8'), 'manual');
    const restartEdit = await (await post('/api/agent-stage', { path: editPath, type: 'edit', oldText: 'manual', newText: 'after restart' })).json();
    child.kill();
    await new Promise(resolve => child.once('exit', resolve));
    child = startBackend();
    for (let attempt = 0; attempt < 30; attempt++) {
      try { if ((await fetch(url + '/api/os', { headers: { Origin: origin } })).ok) break; } catch { /* startup */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal((await post('/api/project-root', { path: root })).status, 200);
    const pending = await (await fetch(url + '/api/agent-pending', { headers: { Origin: origin } })).json();
    assert.ok(pending.pending.some(change => change.token === restartEdit.token && change.type === 'edit'));
    assert.equal((await post('/api/agent-revert', { token: restartEdit.token })).status, 200);
    assert.equal(fs.readFileSync(editPath, 'utf8'), 'manual');
    assert.equal(fs.readFileSync(path.join(parent, 'outside.txt'), 'utf8'), 'outside');
  } finally {
    child.kill();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
