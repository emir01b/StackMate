const stringField = { type: 'string' };
// Küçük modeller etiket adını geçmişteki özetlerden veya kendi dilinden türetebiliyor; bu yüzden eş anlamlılar da kabul edilir.
export const READ_TAG_PATTERN = /\[\s*(?:READ|READ_FILE|Dosya\s+okuma(?:\s+istendi)?|Dosya\s+okundu)\s*:\s*([^\]]+?)\s*\]/i;
export const LIST_TAG_PATTERN = /\[\s*(?:LIST|LIST_DIR|LS|Klasör\s+listeleme(?:\s+istendi)?|Klasör\s+listelendi)\s*:\s*([^\]]*?)\s*\]/i;
export const FILE_TAG_PATTERN = /\[\s*(?:FILE|WRITE|WRITE_FILE|CREATE_FILE|Dosya\s+yazımı(?:\s+istendi)?|Dosya\s+oluşturma)\s*:\s*([^\]]+?)\s*\]/i;
export const EDIT_TAG_PATTERN = /\[\s*(?:EDIT|EDIT_FILE|Dosya\s+düzenleme(?:\s+istendi)?|Düzenleme(?:\s+istendi)?)\s*:\s*([^\]]+?)\s*\]/i;

/**
 * Bozuk kapanış/açılış etiketlerini standart biçime çevirir:
 * "</EDIT]", "[/EDIT>", "</EDIT>" → "[/EDIT]"; "<OLD>" → "[OLD]".
 * Yalnızca büyük harfli biçimler dönüştürülür; HTML içeriğindeki etiketlere dokunulmaz.
 */
export const normalizeActionTags = (text) => text
  .replace(/(?:<\/|\[\/)\s*(EDIT|FILE|OLD|NEW)\s*[\]>]/g, '[/$1]')
  .replace(/<(OLD|NEW)>/g, '[$1]');

/** Ayrıştırılamayan bir işlem girişimi gibi görünen yanıtları yakalar. */
export const looksLikeBrokenAction = (text) =>
  /\[\s*\/?\s*(?:OLD|NEW|EDIT|FILE|READ|LIST|CMD|WRITE)\b|\bistendi\s*:|<\/?(?:EDIT|FILE|OLD|NEW)\b|"(?:oldText|old_string|newText|content)"\s*:/i.test(text);

const unwrapEditText = (value) => {
  const text = value.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
  const fence = text.match(/^```[a-zA-Z0-9+#-]*\r?\n([\s\S]*?)\r?\n```$/);
  return fence ? fence[1] : text;
};

/** [FILE] gövdesindeki baştaki satır sonunu ve modelin eklediği Markdown çitini kaldırır. */
export const unwrapFileContent = (value) => {
  const text = value.replace(/^[ \t]*\r?\n/, '');
  const fence = text.match(/^\s*```[a-zA-Z0-9+#-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```\s*$/);
  if (fence) return fence[1].endsWith('\n') ? fence[1] : fence[1] + '\n';
  return text.replace(/\r?\n[ \t]*$/, '\n');
};

export const parseEditPayload = (body, hasOuterClose) => {
  const oldMatch = body.match(/\[\s*OLD\s*\]([\s\S]*?)\[\s*\/\s*OLD\s*\]/i);
  const newMatch = body.match(/\[\s*NEW\s*\]([\s\S]*?)\[\s*\/\s*NEW\s*\]/i);
  if (oldMatch && newMatch && oldMatch.index + oldMatch[0].length <= newMatch.index) {
    const oldText = unwrapEditText(oldMatch[1]);
    return oldText ? { oldText, newText: unwrapEditText(newMatch[1]), consumedLength: newMatch.index + newMatch[0].length } : null;
  }
  if (!hasOuterClose) return null;
  const loose = body.match(/\[\s*OLD\s*\]([\s\S]*?)\[\s*NEW\s*\]([\s\S]*)/i);
  if (!loose) return null;
  const oldText = unwrapEditText(loose[1].replace(/\[\s*\/\s*OLD\s*\]\s*$/i, ''));
  return oldText ? {
    oldText,
    newText: unwrapEditText(loose[2].replace(/\[\s*\/\s*NEW\s*\]\s*$/i, '')),
    consumedLength: body.length,
  } : null;
};

const defineTool = (name, description, properties, required = Object.keys(properties)) => ({
  type: 'function',
  function: {
    name, description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
  },
});

export const AGENT_TOOLS = [
  defineTool('list_directory', 'List files and folders of a project directory (recursive, limited depth). Use "." for the project root. Runs automatically.', { path: stringField }),
  defineTool('read_file', 'Read the current contents of a project file before editing it. Runs automatically.', { path: stringField }),
  defineTool('write_file', 'Create or replace a project file with its complete content. Applies immediately and the user can undo it.', { path: stringField, content: stringField }),
  defineTool('edit_file', 'Replace one exact, unique piece of text in a project file. Read the file first and copy oldText verbatim. Applies immediately and the user can undo it.', { path: stringField, oldText: stringField, newText: stringField }),
  defineTool('run_command', 'Run one shell command in the selected project after user approval.', { command: stringField }),
  defineTool('delete_file', 'Delete a project file after user approval.', { path: stringField }),
  defineTool('make_directory', 'Create a project directory after user approval.', { path: stringField }),
  defineTool('search_web', 'Search the web after user approval.', { query: stringField }),
];

// Küçük modeller argüman adlarını farklı yazabiliyor.
const ARG_ALIASES = {
  path: ['path', 'file_path', 'filePath', 'filepath', 'filename', 'file', 'dir', 'directory'],
  content: ['content', 'contents', 'text', 'code', 'data'],
  oldText: ['oldText', 'old_text', 'old_string', 'oldString', 'old', 'search', 'find'],
  newText: ['newText', 'new_text', 'new_string', 'newString', 'new', 'replace', 'replacement'],
  command: ['command', 'cmd'],
  query: ['query', 'q', 'search_query'],
};

const pickArg = (args, name) => {
  for (const key of ARG_ALIASES[name]) {
    if (typeof args[key] === 'string') return args[key];
  }
  return undefined;
};

const parseArguments = (raw) => {
  if (raw && typeof raw === 'object') return raw;
  const text = String(raw || '').trim();
  if (!text) return {};
  try { return JSON.parse(text); } catch { /* aşağıda onarmayı dene */ }
  // Bazı sunucular argümandan sonra fazladan karakter gönderir.
  if (!text.startsWith('{')) return null;
  for (let end = text.indexOf('}'); end !== -1; end = text.indexOf('}', end + 1)) {
    try { return JSON.parse(text.slice(0, end + 1)); } catch { /* sonraki kapanışı dene */ }
  }
  return null;
};

export const toolCallToAction = (call) => {
  const args = parseArguments(call.function?.arguments);
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const filePath = pickArg(args, 'path')?.trim();
  switch (call.function?.name?.trim()) {
    case 'run_command': {
      const command = pickArg(args, 'command')?.trim();
      return command ? { type: 'terminal_action', command } : null;
    }
    case 'list_directory':
    case 'list_dir':
    case 'list_files':
      return { type: 'list_action', path: filePath || '.' };
    case 'read_file': return filePath ? { type: 'read_action', path: filePath } : null;
    case 'write_file':
    case 'create_file': {
      const content = pickArg(args, 'content');
      return filePath && typeof content === 'string' ? { type: 'file_action', path: filePath, content } : null;
    }
    case 'edit_file': {
      const oldText = pickArg(args, 'oldText');
      const newText = pickArg(args, 'newText');
      return filePath && oldText && typeof newText === 'string' ? { type: 'edit_action', path: filePath, oldText, newText } : null;
    }
    case 'delete_file': return filePath ? { type: 'delete_action', path: filePath } : null;
    case 'make_directory':
    case 'create_directory': return filePath ? { type: 'mkdir_action', path: filePath } : null;
    case 'search_web': {
      const query = pickArg(args, 'query')?.trim();
      return query ? { type: 'web_action', query } : null;
    }
    default: return null;
  }
};
