// Keep automatic recovery/deletion visible without changing either device layout.
export function attachAccountHealthRefresh({ shouldRefresh, refresh }) {
  let running = false;
  async function tick() {
    if (running || document.hidden || !shouldRefresh()) return;
    running = true;
    try { await refresh(); }
    catch { /* The next refresh retries; existing account data stays usable. */ }
    finally { running = false; }
  }
  setInterval(tick, 30000);
  document.addEventListener('visibilitychange', tick);
}
