function parseAttributes(line) {
  const attributes = {};
  const pattern = /([a-zA-Z0-9_-]+)="([^"]*)"/g;
  let match;

  while ((match = pattern.exec(line)) !== null) {
    attributes[match[1]] = match[2];
  }

  return attributes;
}

function parseTitle(line) {
  const commaIndex = line.lastIndexOf(',');
  return commaIndex >= 0 ? line.slice(commaIndex + 1).trim() : 'Isimsiz Yayin';
}

export function parseM3U(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const channels = [];
  let current = null;

  for (const line of lines) {
    if (line.startsWith('#EXTINF')) {
      const attributes = parseAttributes(line);
      current = {
        id: String(channels.length + 1),
        name: parseTitle(line),
        logo: attributes['tvg-logo'] || '',
        group: attributes['group-title'] || 'Genel',
        tvgId: attributes['tvg-id'] || '',
        url: '',
      };
      continue;
    }

    if (!line.startsWith('#') && current) {
      current.url = line;
      channels.push(current);
      current = null;
    }
  }

  return channels;
}
