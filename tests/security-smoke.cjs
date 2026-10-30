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
    if (process.platform === 'win32') {
      const listed = await (await post('/api/agent-run', { command: 'ls -la', cwd: root })).json();
      assert.equal(listed.command, 'dir');
      let listing;
      for (let attempt = 0; attempt < 30; attempt++) {
        listing = await (await post('/api/agent-status', { procId: listed.procId })).json();
        if (!listing.running) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.equal(listing.exitCode, 0);
      assert.match(listing.stdout, /inside\.txt/);
    }
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
    const htmlPath = path.join(root, 'index.html');
    const minifiedHtml = '<main><section id="booking"  class="container">Book</section><footer>End</footer></main>';
    fs.writeFileSync(htmlPath, minifiedHtml);
    const formattedEdit = await (await post('/api/agent-stage', {
      path: htmlPath, type: 'edit',
      oldText: '<section id="booking"\n class="container">',
      newText: '<section id="booking" class="container animate-on-scroll">',
    })).json();
    assert.ok(formattedEdit.token);
    assert.match(fs.readFileSync(htmlPath, 'utf8'), /class="container animate-on-scroll"/);
    assert.equal((await post('/api/agent-revert', { token: formattedEdit.token })).status, 200);
    assert.equal(fs.readFileSync(htmlPath, 'utf8'), minifiedHtml);
    const protectedEdit = await (await post('/api/agent-stage', { path: editPath, type: 'edit', oldText: 'inside', newText: 'staged' })).json();
    fs.writeFileSync(editPath, 'manual');
    assert.equal((await post('/api/agent-revert', { token: protectedEdit.token })).status, 409);
    assert.equal(fs.readFileSync(editPath, 'utf8'), 'manual');
    assert.equal((await post('/api/agent-commit', { token: protectedEdit.token })).status, 200);
    assert.equal(fs.readFileSync(editPath, 'utf8'), 'manual');
    const jqueryPath = path.join(root, 'app.js');
    fs.writeFileSync(jqueryPath, 'start();\n');
    const jqueryEdit = await (await post('/api/agent-stage', { path: jqueryPath, type: 'edit', oldText: 'start();', newText: "$('#a').show();" })).json();
    assert.equal(fs.readFileSync(jqueryPath, 'utf8'), "$('#a').show();\n");
    assert.equal(jqueryEdit.content, "$('#a').show();\n");
    assert.equal((await post('/api/agent-revert', { token: jqueryEdit.token })).status, 200);
    assert.equal((await post('/api/agent-stage', { path: jqueryPath, type: 'edit', oldText: 'start();', newText: 'start();' })).status, 409);
    const listing = await (await post('/api/list-dir', { path: root })).json();
    assert.match(listing.listing, /inside\.txt/);
    assert.equal((await post('/api/list-dir', { path: parent })).status, 403);
    const dirRead = await post('/api/read-file', { path: root });
    assert.equal(dirRead.status, 400);
    assert.equal((await dirRead.json()).directory, true);
    // Explorer işlemleri: üzerine yazmama, ad doğrulama, gizli dosyalar, doğal sıralama, ikili dosya.
    fs.writeFileSync(path.join(root, '.env'), 'X=1');
    fs.writeFileSync(path.join(root, 'file10.txt'), '');
    fs.writeFileSync(path.join(root, 'file2.txt'), '');
    fs.writeFileSync(path.join(root, 'image.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    const listed = await (await post('/api/read-subdir', { path: root })).json();
    const names = listed.children.map(child => child.name);
    assert.ok(names.includes('.env'));
    assert.ok(names.indexOf('file2.txt') < names.indexOf('file10.txt'));
    assert.equal((await (await post('/api/read-file', { path: path.join(root, 'image.bin') })).json()).binary, true);
    fs.writeFileSync(path.join(root, 'keep.txt'), 'keep');
    assert.equal((await post('/api/create-file', { path: path.join(root, 'keep.txt') })).status, 409);
    assert.equal(fs.readFileSync(path.join(root, 'keep.txt'), 'utf8'), 'keep');
    assert.equal((await post('/api/create-file', { path: path.join(root, 'nested', 'deep', 'new.txt') })).status, 200);
    assert.equal(fs.existsSync(path.join(root, 'nested', 'deep', 'new.txt')), true);
    assert.equal((await post('/api/create-file', { path: path.join(root, 'CON.txt') })).status, 400);
    assert.equal((await post('/api/mkdir', { path: path.join(root, 'nested'), exclusive: true })).status, 409);
    assert.equal((await post('/api/rename', { oldPath: path.join(root, 'file2.txt'), newPath: path.join(root, 'file10.txt') })).status, 409);
    assert.equal((await post('/api/rename', { oldPath: path.join(root, 'file2.txt'), newPath: path.join(root, 'File2.txt') })).status, 200);
    assert.ok(fs.readdirSync(root).includes('File2.txt'));
    assert.equal((await post('/api/rename', { oldPath: path.join(root, 'nested'), newPath: path.join(root, 'nested', 'deep', 'x') })).status, 400);
    assert.equal((await post('/api/delete', { path: root, permanent: true })).status, 400);
    assert.equal((await post('/api/delete', { path: path.join(root, 'nested'), permanent: true })).status, 200);
    assert.equal(fs.existsSync(path.join(root, 'nested')), false);
    assert.equal((await post('/api/delete', { path: path.join(parent, 'outside.txt'), permanent: true })).status, 403);
    assert.equal((await post('/api/project-root', { path: `"${root}"` })).status, 200);
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
