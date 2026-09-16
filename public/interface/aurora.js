/* Optional presentation module. No API calls, player commands or application state writes. */
(() => {
  'use strict';
  const root = document.documentElement;
  const key = 'siberdeyz.interface.v1';
  const requested = new URLSearchParams(location.search).get('interface');
  let mode = 'aurora';
  try { mode = localStorage.getItem(key) === 'classic' ? 'classic' : 'aurora'; } catch {}
  if (requested === 'classic' || requested === 'aurora') {
    mode = requested;
    try { localStorage.setItem(key, mode); } catch {}
  }
  root.dataset.interface = mode;

  document.addEventListener('DOMContentLoaded', () => {
    const header = document.querySelector('.app-header');
    const settings = document.querySelector('.settings-grid');
    if (!header || !settings) return;

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'interface-toggle';
    header.append(toggle);

    const card = document.createElement('section');
    card.className = 'setting-card interface-card';
    card.innerHTML = '<div class="setting-card-head"><h2>Arayüz</h2><p>Görünüm değişir, yayınınız devam eder.</p></div><label class="setting-select-row"><span>Tasarım</span><select id="interfaceMode"><option value="aurora">Aurora</option><option value="classic">Klasik</option></select></label><p class="interface-note" role="status" aria-live="polite"></p>';
    settings.prepend(card);
    const select = card.querySelector('select');
    const note = card.querySelector('.interface-note');
    const themeMeta = document.querySelector('meta[name="theme-color"]');
    const initialThemeColor = themeMeta?.content;
    function render() {
      root.dataset.interface = mode;
      select.value = mode;
      toggle.textContent = mode === 'aurora' ? 'Klasik görünüm' : 'Aurora’yı dene';
      toggle.setAttribute('aria-label', mode === 'aurora' ? 'Klasik arayüze dön' : 'Aurora arayüzüne geç');
      if (themeMeta) themeMeta.content = mode === 'aurora' ? '#080e19' : initialThemeColor;
    }
    function change(next) {
      mode = next === 'classic' ? 'classic' : 'aurora';
      try {
        localStorage.setItem(key, mode);
        note.textContent = 'Görünüm tercihiniz bu cihazda kaydedildi.';
      } catch { note.textContent = 'Görünüm değişti. Bu tarayıcı tercihi kalıcı olarak kaydedemiyor.'; }
      render();
    }
    toggle.addEventListener('click', () => change(mode === 'aurora' ? 'classic' : 'aurora'));
    select.addEventListener('change', () => change(select.value));

    const icons = {
      stop: '<rect x="6" y="6" width="12" height="12" rx="3"/>',
      next: '<path d="m5 4 11 8L5 20Z"/><path d="M19 5v14"/>',
      reload: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1"/>',
      channels: '<rect x="3" y="4" width="18" height="13" rx="3"/><path d="M8 21h8m-4-4v4m-3-9 5 3V7Z"/>',
      accounts: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
      webscan: '<circle cx="10" cy="10" r="7"/><path d="m15 15 6 6M3 10h14M10 3a13 13 0 0 1 0 14 13 13 0 0 1 0-14"/>',
      settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
    };
    document.querySelectorAll('.control-button').forEach(button => {
      const icon = document.createElement('span');
      icon.className = 'aurora-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${icons[button.dataset.action || button.dataset.panel] || ''}</svg>`;
      button.prepend(icon);
    });
    // Keep sheets above the dock even when text size or orientation changes.
    const dock = document.querySelector('.control-panel');
    if (dock && 'ResizeObserver' in window) {
      new ResizeObserver(() => {
        if (mode === 'aurora' && dock.getBoundingClientRect().height > 0) {
          root.style.setProperty('--aurora-dock', `${Math.ceil(dock.getBoundingClientRect().height) + 16}px`);
        }
      }).observe(dock);
    }
    const playbackStatus = document.createElement('span');
    playbackStatus.className = 'aurora-playback-status';
    playbackStatus.textContent = 'Yayın merkezi';
    document.querySelector('.brand-block')?.append(playbackStatus);
    const player = document.querySelector('#player');
    const messages = { playing: 'Şimdi oynatılıyor', waiting: 'Yayın yükleniyor…', pause: 'Yayın duraklatıldı', ended: 'Yayın sona erdi', emptied: 'Yayın merkezi', error: 'Yayın bağlantısı kesildi' };
    for (const [event, message] of Object.entries(messages)) {
      player?.addEventListener(event, () => { playbackStatus.textContent = message; });
    }
    render();
  }, { once: true });
})();
