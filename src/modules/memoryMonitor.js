// Low-overhead runtime visibility for diagnosing Railway memory spikes.
const SAMPLE_INTERVAL_MS = 5 * 60 * 1000;
const WARNING_RSS_MB = 700;
const bytesToMb = (bytes) => Math.round(bytes / (1024 * 1024));

export function startMemoryMonitor() {
  const timer = setInterval(() => {
    const { rss, heapUsed, external } = process.memoryUsage();
    const message = '[memory] rss=' + bytesToMb(rss)
      + 'MB heap=' + bytesToMb(heapUsed)
      + 'MB external=' + bytesToMb(external) + 'MB';
    if (bytesToMb(rss) >= WARNING_RSS_MB) console.warn(message + ' (high usage)');
    else console.info(message);
  }, SAMPLE_INTERVAL_MS);

  timer.unref?.();
}
