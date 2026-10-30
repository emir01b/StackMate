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

export const replaceUniqueText = (before, oldText, newText, { allowWhitespace = false } = {}) => {
  if (typeof before !== 'string' || typeof oldText !== 'string' || !oldText || typeof newText !== 'string') {
    throw new Error('Düzenleme metni geçersiz');
  }
  if (before.split(oldText).length === 2) return before.replace(oldText, newText);

  // Tam dosya yenilemede yalnızca satır sonu ve dış boşluk farklarını kabul et.
  if (before.replace(/\r\n/g, '\n').trim() === oldText.replace(/\r\n/g, '\n').trim()) {
    const newline = before.includes('\r\n') ? '\r\n' : '\n';
    let after = newText.replace(/\r\n/g, '\n').replace(/\n/g, newline);
    if (before.endsWith(newline) && !after.endsWith(newline)) after += newline;
    return after;
  }

  if (allowWhitespace) {
    const current = canonicalize(before);
    const needle = canonicalize(oldText).text.trim();
    if (needle.length >= 8) {
      const match = current.text.indexOf(needle);
      if (match >= 0 && current.text.indexOf(needle, match + 1) === -1) {
        const start = current.starts[match];
        const end = current.ends[match + needle.length - 1];
        return before.slice(0, start) + newText + before.slice(end);
      }
    }
  }
  throw new Error('Eski metin dosyada benzersiz biçimde bulunamadı');
};

export const supportsWhitespaceMatch = (filePath) => /\.(?:html?|css|scss|vue|svelte)$/i.test(filePath);
