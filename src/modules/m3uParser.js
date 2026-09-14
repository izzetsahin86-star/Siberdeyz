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

function createCollector(transform) {
  const channels = [];
  let current = null;

  function pushLine(rawLine) {
    const line = String(rawLine || '').trim();
    if (!line) return;

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
      return;
    }

    if (!line.startsWith('#') && current) {
      current.url = line;
      channels.push(transform(current));
      current = null;
    }
  }

  return {
    pushLine,
    finish() {
      return channels;
    },
  };
}

export function parseM3U(text, transform = (channel) => channel) {
  const collector = createCollector(transform);
  let start = 0;

  while (start <= text.length) {
    const end = text.indexOf('\n', start);
    const rawLine = end === -1 ? text.slice(start) : text.slice(start, end).replace(/\r$/, '');
    collector.pushLine(rawLine);

    if (end === -1) break;
    start = end + 1;
  }

  return collector.finish();
}

export async function parseM3UStream(stream, transform = (channel) => channel) {
  if (!stream) return [];

  const collector = createCollector(transform);
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = '';

  while (true) {
    const { done, value } = await reader.read();
    buffered += decoder.decode(value || new Uint8Array(), { stream: !done });

    let start = 0;
    let end = buffered.indexOf('\n', start);

    while (end !== -1) {
      collector.pushLine(buffered.slice(start, end).replace(/\r$/, ''));
      start = end + 1;
      end = buffered.indexOf('\n', start);
    }

    buffered = buffered.slice(start);

    if (done) break;
  }

  if (buffered) collector.pushLine(buffered);
  return collector.finish();
}
