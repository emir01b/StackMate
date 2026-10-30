const { test } = require('node:test');
const assert = require('node:assert/strict');

test('structured tool calls become agent actions without executing them', async () => {
  const { AGENT_TOOLS, toolCallToAction } = await import('../src/utils/agentTools.js');
  assert.equal(AGENT_TOOLS.length, 7);
  assert.deepEqual(toolCallToAction({ function: { name: 'read_file', arguments: '{"path":"index.html"}' } }),
    { type: 'read_action', path: 'index.html' });
  assert.deepEqual(toolCallToAction({ function: { name: 'run_command', arguments: '{"command":"dir"}' } }),
    { type: 'terminal_action', command: 'dir' });
  assert.deepEqual(toolCallToAction({ function: { name: 'write_file', arguments: '{"path":"a.txt","content":"line\\n"}' } }),
    { type: 'file_action', path: 'a.txt', content: 'line\n' });
  assert.equal(toolCallToAction({ function: { name: 'run_command', arguments: '{"command":1}' } }), null);
  assert.equal(toolCallToAction({ function: { name: 'unknown', arguments: '{}' } }), null);
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
