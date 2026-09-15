export function hasMultipleConnections(health) {
  if (!health || health.protocol !== 'xtream') return false;

  const maxConnections = Number(health.maxConnections);
  return Number.isFinite(maxConnections) && maxConnections > 1;
}

export function sourceHasMultipleConnections(source, healthMap = {}) {
  if (!source || source.type !== 'url') return false;
  return hasMultipleConnections(healthMap[source.id]);
}
