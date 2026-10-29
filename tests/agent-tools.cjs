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
