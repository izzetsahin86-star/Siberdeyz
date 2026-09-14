const MOVIE_WORDS = ['film', 'movie', 'cinema', 'sinema', 'vod'];
const SERIES_WORDS = ['dizi', 'series', 'sezon', 'season', 'episode', 'bolum'];

function includesAny(value, words) {
  const normalized = String(value || '').toLocaleLowerCase('tr-TR');
  return words.some((word) => normalized.includes(word));
}

export function getChannelType(channel) {
  const text = `${channel.name} ${channel.group}`;

  if (includesAny(text, SERIES_WORDS)) return 'series';
  if (includesAny(text, MOVIE_WORDS)) return 'movie';
  return 'live';
}

export function enrichChannel(channel) {
  return {
    ...channel,
    type: getChannelType(channel),
  };
}
