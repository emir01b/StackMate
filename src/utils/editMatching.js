const canonicalize = (input) => {
  let text = '';
  const starts = [];
  const ends = [];
  for (let index = 0; index < input.length;) {
    const start = index;
    if (/\s/.test(input[index])) {
      while (index < input.length && /\s/.test(input[index])) index++;
      // Biçimlendirilmiş HTML'de etiketler arasındaki satır sonları sıkıştırılmış dosyada olmayabilir.
      if (text.endsWith('>') && input[index] === '<') continue;
      text += ' ';
    } else {
      text += input[index];
      index++;
    }
    starts.push(start);
    ends.push(index);
  }
  return { text, starts, ends };
};

// String.replace kullanılmaz: yeni metindeki "$&", "$'" gibi diziler özel anlam taşır.
const spliceText = (text, start, end, insert) => text.slice(0, start) + insert + text.slice(end);

const findAll = (haystack, needle, limit = 3) => {
  const found = [];
  for (let index = haystack.indexOf(needle); index !== -1 && found.length < limit; index = haystack.indexOf(needle, index + 1)) {
    found.push(index);
  }
  return found;
};

const duplicateError = (count) => new Error(`Eski metin dosyada ${count > 2 ? 'birçok' : count} kez geçiyor; benzersiz olması için OLD'a çevresindeki satırları da ekleyin`);
const notFoundError = () => new Error('Eski metin dosyada bulunamadı; OLD dosyadaki metinle birebir ve benzersiz olmalı');

const leadingWhitespace = (line) => line.match(/^[ \t]*/)[0];

const trimBlankLines = (lines) => {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) start++;
  while (end > start && !lines[end - 1].trim()) end--;
  return lines.slice(start, end);
};

// Satır bazlı eşleşme: önce satır sonu boşluklarını, sonra girintiyi yok sayar.
const replaceByLines = (text, oldText, newText) => {
  const fileLines = text.split('\n');
  const oldLines = trimBlankLines(oldText.split('\n'));
  if (!oldLines.length || oldLines.join('').trim().length < 3) return null;
  const newLines = newText === '' ? [] : newText.replace(/^\n/, '').replace(/\n$/, '').split('\n');

  for (const compare of [(line) => line.trimEnd(), (line) => line.trim()]) {
    const wanted = oldLines.map(compare);
    const matches = [];
    for (let start = 0; start + wanted.length <= fileLines.length && matches.length < 3; start++) {
      if (wanted.every((line, offset) => compare(fileLines[start + offset]) === line)) matches.push(start);
    }
    if (matches.length > 1) throw duplicateError(matches.length);
    if (matches.length === 1) {
      const start = matches[0];
      const anchor = oldLines.findIndex(line => line.trim());
      const modelIndent = leadingWhitespace(oldLines[anchor]);
      const fileIndent = leadingWhitespace(fileLines[start + anchor]);
      const adjusted = modelIndent === fileIndent ? newLines : newLines.map(line => (
        line.startsWith(modelIndent) ? fileIndent + line.slice(modelIndent.length) : line
      ));
      return [...fileLines.slice(0, start), ...adjusted, ...fileLines.slice(start + oldLines.length)].join('\n');
    }
  }
  return null;
};

export const replaceUniqueText = (before, oldText, newText, { allowWhitespace = false } = {}) => {
  if (typeof before !== 'string' || typeof oldText !== 'string' || !oldText || typeof newText !== 'string') {
    throw new Error('Düzenleme metni geçersiz');
  }
  const exact = findAll(before, oldText);
  if (exact.length > 1) throw duplicateError(exact.length);
  if (exact.length === 1) return spliceText(before, exact[0], exact[0] + oldText.length, newText);

  const crlf = before.includes('\r\n');
  const toFileNewlines = (value) => {
    const normalized = value.replace(/\r\n/g, '\n');
    return crlf ? normalized.replace(/\n/g, '\r\n') : normalized;
  };

  // Model çıktısı genelde LF kullanır; CRLF dosyada aynı metni dosyanın satır sonlarıyla dene.
  const adaptedOld = toFileNewlines(oldText);
  if (adaptedOld !== oldText) {
    const adapted = findAll(before, adaptedOld);
    if (adapted.length > 1) throw duplicateError(adapted.length);
    if (adapted.length === 1) return spliceText(before, adapted[0], adapted[0] + adaptedOld.length, toFileNewlines(newText));
  }

  const normalizedBefore = before.replace(/\r\n/g, '\n');
  const normalizedOld = oldText.replace(/\r\n/g, '\n');
  const normalizedNew = newText.replace(/\r\n/g, '\n');

  // Tam dosya yenilemede yalnızca satır sonu ve dış boşluk farklarını kabul et.
  if (normalizedBefore.trim() === normalizedOld.trim()) {
    let after = toFileNewlines(normalizedNew);
    const newline = crlf ? '\r\n' : '\n';
    if (before.endsWith(newline) && !after.endsWith(newline)) after += newline;
    return after;
  }

  const byLines = replaceByLines(normalizedBefore, normalizedOld, normalizedNew);
  if (byLines !== null) return crlf ? byLines.replace(/\n/g, '\r\n') : byLines;

  if (allowWhitespace) {
    const current = canonicalize(before);
    const needle = canonicalize(oldText).text.trim();
    if (needle.length >= 8) {
      const matches = findAll(current.text, needle);
      if (matches.length > 1) throw duplicateError(matches.length);
      if (matches.length === 1) {
        const start = current.starts[matches[0]];
        const end = current.ends[matches[0] + needle.length - 1];
        return spliceText(before, start, end, newText);
      }
    }
  }
  throw notFoundError();
};

export const supportsWhitespaceMatch = (filePath) => /\.(?:html?|css|scss|vue|svelte)$/i.test(filePath);
