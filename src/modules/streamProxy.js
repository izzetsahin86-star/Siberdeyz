import { findChannel } from './playlistService.js';

export async function proxyStream(req, res) {
  const channel = await findChannel(req.params.id);

  if (!channel) {
    res.status(404).json({ error: 'Yayin bulunamadi' });
    return;
  }

  const upstream = await fetch(channel.url, {
    headers: {
      'user-agent': req.get('user-agent') || 'Siberdeyz-IPTV-Player/1.0',
      range: req.get('range') || '',
    },
  });

  res.status(upstream.status);

  for (const [key, value] of upstream.headers.entries()) {
    const lowerKey = key.toLowerCase();
    if (['content-type', 'content-length', 'content-range', 'accept-ranges'].includes(lowerKey)) {
      res.setHeader(key, value);
    }
  }

  if (!res.getHeader('content-type')) {
    res.setHeader('content-type', 'video/mp2t');
  }

  if (!upstream.body) {
    res.end();
    return;
  }

  const reader = upstream.body.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (error) {
    res.destroy(error);
  }
}
