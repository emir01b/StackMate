const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

const dataDir = process.env.STACKMATE_DATA_DIR || path.join(
  process.platform === 'win32'
    ? (process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'))
    : (process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')),
  'StackMate',
);
const settingsPath = path.join(dataDir, 'settings.json');

const defaults = {
  ai: {
    provider: 'local',
    localBaseUrl: `http://127.0.0.1:${Number(process.env.LM_STUDIO_PORT || 1234)}/v1`,
    remoteBaseUrl: '',
    apiKey: '',
    model: '',
    temperature: 0.2,
    maxTokens: 8192,
    autoContinue: true,
    useNativeTools: true,
    maxAutoSteps: 20,
  },
  editor: { fontSize: 14, tabSize: 2, wordWrap: true, minimap: true, autoSave: true, autoSaveDelay: 1000 },
  appearance: { density: 'comfortable', accent: 'blue' },
};

const normalizeUrl = (value, remote) => {
  if (value === '') return '';
  if (typeof value !== 'string') throw new Error('API adresi geçersiz');
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('API adresi HTTP(S) taban adresi olmalı');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (remote && url.protocol !== 'https:' && !loopback) throw new Error('Uzak API anahtarı için HTTPS gerekli');
  url.pathname = url.pathname.replace(/\/(chat\/completions|models)\/?$/i, '').replace(/\/+$/, '');
  if (!url.pathname || url.pathname === '/') url.pathname = '/v1';
  return url.toString().replace(/\/$/, '');
};

const boundedNumber = (value, min, max, name, integer = false) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`${name} ${min}-${max} aralığında olmalı`);
  }
  return value;
};

const readSettings = () => {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    return {
      ai: { ...defaults.ai, ...(saved.ai || {}) },
      editor: { ...defaults.editor, ...(saved.editor || {}) },
      appearance: { ...defaults.appearance, ...(saved.appearance || {}) },
    };
  } catch { return structuredClone(defaults); }
};

const publicSettings = (settings) => ({
  ai: { ...settings.ai, apiKey: undefined, apiKeySet: !!settings.ai.apiKey },
  editor: settings.editor,
  appearance: settings.appearance,
});

const updateSettings = (current, input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Ayarlar geçersiz');
  const aiInput = input.ai || {};
  const editorInput = input.editor || {};
  const appearanceInput = input.appearance || {};
  const next = structuredClone(current);
  if ('provider' in aiInput) {
    if (!['local', 'remote'].includes(aiInput.provider)) throw new Error('Sağlayıcı geçersiz');
    next.ai.provider = aiInput.provider;
  }
  if ('localBaseUrl' in aiInput) next.ai.localBaseUrl = normalizeUrl(aiInput.localBaseUrl, false);
  if ('remoteBaseUrl' in aiInput) next.ai.remoteBaseUrl = normalizeUrl(aiInput.remoteBaseUrl, true);
  if ('model' in aiInput) {
    if (typeof aiInput.model !== 'string' || aiInput.model.length > 200) throw new Error('Model adı geçersiz');
    next.ai.model = aiInput.model.trim();
  }
  if ('apiKey' in aiInput) {
    if (typeof aiInput.apiKey !== 'string' || aiInput.apiKey.length > 10000) throw new Error('API anahtarı geçersiz');
    next.ai.apiKey = aiInput.apiKey.trim();
  }
  if ('temperature' in aiInput) next.ai.temperature = boundedNumber(aiInput.temperature, 0, 2, 'Sıcaklık');
  if ('maxTokens' in aiInput) next.ai.maxTokens = boundedNumber(aiInput.maxTokens, 256, 32768, 'Token sınırı', true);
  if ('autoContinue' in aiInput) next.ai.autoContinue = !!aiInput.autoContinue;
  if ('useNativeTools' in aiInput) next.ai.useNativeTools = !!aiInput.useNativeTools;
  if ('maxAutoSteps' in aiInput) next.ai.maxAutoSteps = boundedNumber(aiInput.maxAutoSteps, 1, 100, 'Otomatik adım sınırı', true);
  if (next.ai.provider === 'remote' && !next.ai.remoteBaseUrl) throw new Error('Uzak API adresini girin');
  if (!next.ai.localBaseUrl) throw new Error('Yerel API adresini girin');

  if ('fontSize' in editorInput) next.editor.fontSize = boundedNumber(editorInput.fontSize, 10, 28, 'Yazı boyutu', true);
  if ('tabSize' in editorInput) next.editor.tabSize = boundedNumber(editorInput.tabSize, 1, 8, 'Girinti', true);
  if ('wordWrap' in editorInput) next.editor.wordWrap = !!editorInput.wordWrap;
  if ('minimap' in editorInput) next.editor.minimap = !!editorInput.minimap;
  if ('autoSave' in editorInput) next.editor.autoSave = !!editorInput.autoSave;
  if ('autoSaveDelay' in editorInput) next.editor.autoSaveDelay = boundedNumber(editorInput.autoSaveDelay, 300, 10000, 'Otomatik kaydetme gecikmesi', true);
  if ('density' in appearanceInput) {
    if (!['comfortable', 'compact'].includes(appearanceInput.density)) throw new Error('Görünüm yoğunluğu geçersiz');
    next.appearance.density = appearanceInput.density;
  }
  if ('accent' in appearanceInput) {
    if (!['blue', 'violet', 'teal'].includes(appearanceInput.accent)) throw new Error('Vurgu rengi geçersiz');
    next.appearance.accent = appearanceInput.accent;
  }
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const temporary = path.join(dataDir, `settings-${randomUUID()}.tmp`);
  fs.writeFileSync(temporary, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, settingsPath);
  return next;
};

const activeConnection = (settings) => {
  const remote = settings.ai.provider === 'remote';
  const base = remote ? settings.ai.remoteBaseUrl : settings.ai.localBaseUrl;
  if (!base) throw new Error('API adresi ayarlanmamış');
  return { base, apiKey: remote ? settings.ai.apiKey : '' };
};

const endpointUrl = (base, route) => new URL(`${base.replace(/\/+$/, '')}/${route}`);

module.exports = { readSettings, publicSettings, updateSettings, activeConnection, endpointUrl, settingsPath };
