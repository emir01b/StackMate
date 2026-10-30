// Backend yolları sunucunun işletim sistemine aittir: Windows'ta "\", macOS/Linux'ta "/" kullanılır.
const isWindowsPath = (value) => /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');

export const pathSeparator = (basePath) => (isWindowsPath(basePath || '') ? '\\' : '/');

const splitSegments = (value) => String(value || '').split(/[\\/]+/).filter(segment => segment && segment !== '.');

/** Proje köküne göreceli parçaları sunucu ayırıcısıyla ekler. */
export const joinProjectPath = (basePath, ...relativeParts) => {
  const separator = pathSeparator(basePath);
  const segments = relativeParts.flatMap(splitSegments);
  const base = basePath.length > 1 ? basePath.replace(/[\\/]+$/, '') : basePath;
  if (!segments.length) return base;
  return base + (base.endsWith(separator) ? '' : separator) + segments.join(separator);
};

/** Explorer ağacındaki "KökAdı/alt/dosya" yolunu kök adı olmadan döndürür. */
export const treePathToRelative = (treePath) => splitSegments(treePath).slice(1).join('/');

const sameText = (a, b, caseInsensitive) => (caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b);

/**
 * Modelin ürettiği yolu proje köküne göreceli, "/" ayırıcılı biçime getirir.
 * Mutlak yol proje içindeyse göreceli hale gelir; dışındaysa olduğu gibi kalır ve backend reddeder.
 */
export const normalizeAgentPath = (actionPath, { basePath = '', projectName = '' } = {}) => {
  let value = String(actionPath || '').trim().replace(/^[`'"]+|[`'"]+$/g, '').trim();
  if (!value) return '';
  const windows = isWindowsPath(basePath) || isWindowsPath(value);
  if (basePath) {
    const baseSegments = splitSegments(basePath);
    const valueSegments = splitSegments(value);
    const absolute = isWindowsPath(value) || value.startsWith('/');
    if (absolute && valueSegments.length >= baseSegments.length
      && baseSegments.every((segment, index) => sameText(segment, valueSegments[index], windows))) {
      return valueSegments.slice(baseSegments.length).join('/');
    }
    if (isWindowsPath(value)) return value;
  }
  const segments = splitSegments(value);
  const rootName = projectName || splitSegments(basePath).pop();
  // Model bazen proje klasörünün adını yolun başına ekler ("proje/src/a.js").
  if (rootName && segments.length > 1 && sameText(segments[0], rootName, windows)) segments.shift();
  return segments.join('/');
};

/** Agent yolunu backend'e gönderilecek tam yola çevirir. */
export const resolveAgentPath = (basePath, actionPath) => {
  const relative = normalizeAgentPath(actionPath, { basePath });
  if (isWindowsPath(relative)) return relative;
  return joinProjectPath(basePath, relative);
};

// Windows'ta geçersiz karakterler ve ayrılmış adlar; proje her iki sistemde de taşınabilir kalsın diye her yerde uygulanır.
const INVALID_NAME_CHARS = /[<>:"\\|?*]/;
// eslint-disable-next-line no-control-regex -- kontrol karakterleri Windows dosya adlarında geçersizdir.
const CONTROL_CHARS = /[\u0000-\u001f]/;
const RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/** Dosya/klasör adını (veya "a/b.txt" gibi iç içe yolu) doğrular; geçerliyse boş metin döner. */
export const validateEntryName = (value) => {
  const name = String(value || '').trim();
  if (!name) return 'Ad boş olamaz';
  const segments = name.replace(/\/+$/, '').split('/');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') return 'Geçersiz yol parçası';
    if (INVALID_NAME_CHARS.test(segment) || CONTROL_CHARS.test(segment)) return 'Ad şu karakterleri içeremez: < > : " \\ | ? *';
    if (RESERVED_NAME.test(segment)) return `"${segment}" Windows'ta ayrılmış bir addır`;
    if (/[. ]$/.test(segment)) return 'Ad nokta veya boşlukla bitemez';
    if (segment.length > 255) return 'Ad çok uzun';
  }
  return '';
};

/** Proje köküne göreli yolun üst klasörü ("" kök demektir). */
export const parentOfRelative = (relativePath) => relativePath.split('/').slice(0, -1).join('/');
