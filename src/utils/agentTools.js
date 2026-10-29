const stringField = { type: 'string' };

const defineTool = (name, description, properties) => ({
  type: 'function',
  function: {
    name, description,
    parameters: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false },
  },
});

export const AGENT_TOOLS = [
  defineTool('run_command', 'Run one shell command in the selected project after user approval.', { command: stringField }),
  defineTool('read_file', 'Read the current contents of a project file before editing it. Runs automatically.', { path: stringField }),
  defineTool('write_file', 'Create or replace a project file. Applies immediately and the user can undo it.', { path: stringField, content: stringField }),
  defineTool('edit_file', 'Replace one exact piece of text in a project file. Read the file first. Applies immediately and the user can undo it.', { path: stringField, oldText: stringField, newText: stringField }),
  defineTool('delete_file', 'Delete a project file after user approval.', { path: stringField }),
  defineTool('make_directory', 'Create a project directory after user approval.', { path: stringField }),
  defineTool('search_web', 'Search the web after user approval.', { query: stringField }),
];

export const toolCallToAction = (call) => {
  let args;
  try { args = JSON.parse(call.function?.arguments || '{}'); } catch { return null; }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const values = Object.values(args);
  if (values.some(value => typeof value !== 'string')) return null;
  switch (call.function?.name) {
    case 'run_command': return args.command?.trim() ? { type: 'terminal_action', command: args.command.trim() } : null;
    case 'read_file': return args.path?.trim() ? { type: 'read_action', path: args.path.trim() } : null;
    case 'write_file': return args.path?.trim() && typeof args.content === 'string' ? { type: 'file_action', path: args.path.trim(), content: args.content } : null;
    case 'edit_file': return args.path?.trim() && args.oldText && typeof args.newText === 'string' ? { type: 'edit_action', path: args.path.trim(), oldText: args.oldText, newText: args.newText } : null;
    case 'delete_file': return args.path?.trim() ? { type: 'delete_action', path: args.path.trim() } : null;
    case 'make_directory': return args.path?.trim() ? { type: 'mkdir_action', path: args.path.trim() } : null;
    case 'search_web': return args.query?.trim() ? { type: 'web_action', query: args.query.trim() } : null;
    default: return null;
  }
};
