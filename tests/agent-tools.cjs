const { test } = require('node:test');
const assert = require('node:assert/strict');

test('structured tool calls become agent actions without executing them', async () => {
  const { AGENT_TOOLS, toolCallToAction, READ_TAG_PATTERN } = await import('../src/utils/agentTools.js');
  assert.equal(AGENT_TOOLS.length, 8);
  assert.deepEqual(toolCallToAction({ function: { name: 'read_file', arguments: '{"path":"index.html"}' } }),
    { type: 'read_action', path: 'index.html' });
  assert.deepEqual(toolCallToAction({ function: { name: 'run_command', arguments: '{"command":"dir"}' } }),
    { type: 'terminal_action', command: 'dir' });
  assert.deepEqual(toolCallToAction({ function: { name: 'write_file', arguments: '{"path":"a.txt","content":"line\\n"}' } }),
    { type: 'file_action', path: 'a.txt', content: 'line\n' });
  assert.equal(toolCallToAction({ function: { name: 'run_command', arguments: '{"command":1}' } }), null);
  assert.equal(toolCallToAction({ function: { name: 'unknown', arguments: '{}' } }), null);
  assert.equal('[Dosya okuma: index.html]'.match(READ_TAG_PATTERN)?.[1], 'index.html');
  assert.equal('[READ: index.html]'.match(READ_TAG_PATTERN)?.[1], 'index.html');
});

test('text edit parser accepts completed inner tags without outer close and rejects cut-off edits', async () => {
  const { parseEditPayload } = await import('../src/utils/agentTools.js');
  const complete = '[OLD]\n  <section>old</section>\n[/OLD][NEW]\n  <section>new</section>\n[/NEW]';
  assert.deepEqual(parseEditPayload(complete, false), {
    oldText: '  <section>old</section>', newText: '  <section>new</section>', consumedLength: complete.length,
  });
  assert.equal(parseEditPayload('[OLD]<section>old</section>[/OLD][NEW]<section>new', false), null);
  assert.deepEqual(parseEditPayload('[OLD]old[NEW]new', true), { oldText: 'old', newText: 'new', consumedLength: 16 });
});

test('HTML edit finds one minified match despite model formatting and preserves other content', async () => {
  const { replaceUniqueText, supportsWhitespaceMatch } = await import('../src/utils/editMatching.js');
  const before = '<html><body>  <section id="booking"  class="container">Book</section>  <footer>End</footer></body></html>';
  const oldText = '<section id="booking"\n class="container">';
  const newText = '<section id="booking" class="container animate-on-scroll">';
  const after = replaceUniqueText(before, oldText, newText, { allowWhitespace: supportsWhitespaceMatch('index.html') });
  assert.match(after, /class="container animate-on-scroll"/);
  assert.match(after, /<footer>End<\/footer>/);
  assert.equal(replaceUniqueText('<div><span>Old</span></div>', '<div>\n  <span>Old</span>\n</div>', '<div><span>New</span></div>', { allowWhitespace: true }), '<div><span>New</span></div>');
  assert.throws(() => replaceUniqueText('<p>same</p><p>same</p>', '<p>same</p>', '<p>new</p>', { allowWhitespace: true }), /benzersiz/);
  assert.throws(() => replaceUniqueText('const label = "a b";', 'const label = "a   b";', 'changed', { allowWhitespace: supportsWhitespaceMatch('script.js') }), /benzersiz/);
});

test('tool calls accept common argument aliases and ignore extra non-string fields', async () => {
  const { toolCallToAction, LIST_TAG_PATTERN } = await import('../src/utils/agentTools.js');
  assert.deepEqual(toolCallToAction({ function: { name: 'edit_file', arguments: '{"file_path":"a.js","old_string":"x","new_string":"y","line":3}' } }),
    { type: 'edit_action', path: 'a.js', oldText: 'x', newText: 'y' });
  assert.deepEqual(toolCallToAction({ function: { name: 'list_directory', arguments: '{}' } }), { type: 'list_action', path: '.' });
  assert.deepEqual(toolCallToAction({ function: { name: 'read_file', arguments: { path: 'b.txt' } } }), { type: 'read_action', path: 'b.txt' });
  assert.deepEqual(toolCallToAction({ function: { name: 'read_file', arguments: '{"path":"c.txt"}}' } }), { type: 'read_action', path: 'c.txt' });
  assert.equal('[LIST: src]'.match(LIST_TAG_PATTERN)?.[1], 'src');
});

test('file tag content drops the leading newline and markdown fence', async () => {
  const { unwrapFileContent } = await import('../src/utils/agentTools.js');
  assert.equal(unwrapFileContent('\n```html\n<p>x</p>\n```\n'), '<p>x</p>\n');
  assert.equal(unwrapFileContent('\nconst a = 1;\n'), 'const a = 1;\n');
});

test('edits keep dollar sequences, adapt CRLF and tolerate indentation differences', async () => {
  const { replaceUniqueText } = await import('../src/utils/editMatching.js');
  assert.equal(replaceUniqueText("a();\nb();\n", 'a();', "$('#x').hide();"), "$('#x').hide();\nb();\n");
  assert.equal(replaceUniqueText('one\r\ntwo\r\nthree\r\n', 'one\ntwo', 'uno\ndos'), 'uno\r\ndos\r\nthree\r\n');
  const indented = 'function f() {\n    if (x) {\n        go();\n    }\n}\n';
  assert.equal(replaceUniqueText(indented, 'if (x) {\n    go();\n}', 'if (y) {\n    stop();\n}'),
    'function f() {\n    if (y) {\n        stop();\n    }\n}\n');
  assert.equal(replaceUniqueText('let a = 1;   \nlet b = 2;\n', 'let a = 1;\nlet b = 2;', 'let c = 3;'), 'let c = 3;\n');
  assert.throws(() => replaceUniqueText('x\ny\nx\ny\n', 'x\ny', 'z'), /2 kez/);
});

test('agent paths resolve with the server separator and stay relative to the project', async () => {
  const { resolveAgentPath, normalizeAgentPath, joinProjectPath, treePathToRelative } = await import('../src/utils/paths.js');
  assert.equal(resolveAgentPath('/Users/me/site', 'src/app.js'), '/Users/me/site/src/app.js');
  assert.equal(resolveAgentPath('/Users/me/site', './site/index.html'), '/Users/me/site/index.html');
  assert.equal(resolveAgentPath('/Users/me/site', '/Users/me/site/css/a.css'), '/Users/me/site/css/a.css');
  assert.equal(resolveAgentPath('/Users/me/site', '/index.html'), '/Users/me/site/index.html');
  assert.equal(resolveAgentPath('/Users/me/site', '`index.html`'), '/Users/me/site/index.html');
  assert.equal(resolveAgentPath('C:\\Proje\\site', 'src/app.js'), 'C:\\Proje\\site\\src\\app.js');
  assert.equal(resolveAgentPath('C:\\Proje\\site', 'c:/proje/site/a.js'), 'C:\\Proje\\site\\a.js');
  assert.equal(resolveAgentPath('/Users/me/site', '.'), '/Users/me/site');
  assert.equal(normalizeAgentPath('site/src/a.js', { projectName: 'site' }), 'src/a.js');
  assert.equal(joinProjectPath('/Users/me/site', treePathToRelative('site/src/a.js')), '/Users/me/site/src/a.js');
});

test('malformed edit copied from history summaries is still recognized', async () => {
  const { EDIT_TAG_PATTERN, normalizeActionTags, parseEditPayload, looksLikeBrokenAction } = await import('../src/utils/agentTools.js');
  // gemma-4-e4b'nin gerçekte ürettiği çıktı: özet kalıbıyla açılış, [/OLD] yok, "</EDIT]" ile kapanış.
  const raw = '[Dosya düzenleme istendi: index.html][OLD]    <nav><a href="#menu">Menü</a></nav>[NEW]    <nav><a href="#menu">Menü</a> <a href="#iletisim">İletişim</a></nav></EDIT]';
  const text = normalizeActionTags(raw);
  const open = text.match(EDIT_TAG_PATTERN);
  assert.equal(open?.[1], 'index.html');
  const rest = text.slice(open.index + open[0].length);
  const close = rest.match(/\[\s*\/\s*EDIT\s*\]/i);
  assert.ok(close);
  const edit = parseEditPayload(rest.slice(0, close.index), true);
  assert.equal(edit.oldText, '    <nav><a href="#menu">Menü</a></nav>');
  assert.match(edit.newText, /#iletisim/);
  assert.equal(normalizeActionTags('<p>a</p></div>'), '<p>a</p></div>');
  assert.equal(looksLikeBrokenAction('[Düzenleme istendi: a.html] yaptım'), true);
  assert.equal(looksLikeBrokenAction('Görev tamamlandı.'), false);
});

test('entry names are validated with Windows rules on every platform', async () => {
  const { validateEntryName, parentOfRelative } = await import('../src/utils/paths.js');
  assert.equal(validateEntryName('index.html'), '');
  assert.equal(validateEntryName('src/components/App.jsx'), '');
  assert.equal(validateEntryName('.env'), '');
  assert.match(validateEntryName(''), /boş/);
  assert.match(validateEntryName('a:b.txt'), /karakter/);
  assert.match(validateEntryName('CON'), /ayrılmış/);
  assert.match(validateEntryName('nul.txt'), /ayrılmış/);
  assert.match(validateEntryName('notes.'), /nokta/);
  assert.match(validateEntryName('../escape'), /Geçersiz/);
  assert.equal(parentOfRelative('a/b/c.txt'), 'a/b');
  assert.equal(parentOfRelative('c.txt'), '');
});
