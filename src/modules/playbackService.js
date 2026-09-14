export function getPlaybackInfo(channel) {
  if (!channel) return null;

  const url = String(channel.url || '').toLocaleLowerCase('tr-TR');
  const format = url.includes('.m3u8') ? 'hls' : 'direct';

  return {
    channelId: channel.id,
    format,
    streamPath: `/api/stream/${channel.id}`,
    message: format === 'hls'
      ? 'HLS yayin algilandi.'
      : 'Direkt yayin denenecek. Tarayici desteklemezse sonraki adimda HLS oynatici eklenebilir.',
  };
}
