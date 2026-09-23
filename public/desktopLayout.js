/* Desktop presentation adapter. Existing controls, video and application state stay
   in place: no duplicate player, account store or API requests. */
export const DESKTOP_QUERY = '(min-width: 1024px) and (hover: hover) and (pointer: fine)';

export function isDesktopDevice(navigator, mediaMatches) {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return mediaMatches && !ios;
}

export function isDesktopLayout() {
  return isDesktopDevice(window.navigator, window.matchMedia(DESKTOP_QUERY).matches);
}

export function attachDesktopLayout({ openPanel }) {
  const root = document.documentElement;
  const shell = document.querySelector('#appShell');
  const panel = document.querySelector('#bottomPanel');
  const controls = document.querySelector('.control-panel');
  const header = document.querySelector('.app-header');
  const watch = document.querySelector('.watch-area');
  const channel = document.querySelector('#currentChannel');
  const video = document.querySelector('#player');
  const media = window.matchMedia(DESKTOP_QUERY);
  let additions = [];
  let observer;
  const labels = { channels: 'Yayın merkezi', accounts: 'Hesap yönetimi', webscan: 'Web tarama', settings: 'Ayarlar', none: 'İzleme alanı' };

  function sync() {
    const title = header.querySelector('.desktop-heading h1');
    if (title) title.textContent = labels[panel.dataset.open] || labels.channels;
    const empty = watch.querySelector('.desktop-player-empty');
    if (empty) empty.hidden = Boolean(video.getAttribute('src') || video.srcObject || channel.textContent !== 'Henuz secilmedi');
    controls.querySelectorAll('[data-panel]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.panel === panel.dataset.open));
    });
  }

  function add(parent, className, markup) {
    const node = document.createElement('div');
    node.className = className;
    node.innerHTML = markup;
    parent.prepend(node);
    additions.push(node);
  }

  function update() {
    const enabled = isDesktopLayout();
    if (enabled === (root.dataset.desktopLayout === 'true')) return;
    if (!enabled) {
      observer?.disconnect();
      additions.forEach(node => node.remove());
      additions = [];
      controls.querySelectorAll('[data-panel]').forEach(button => button.removeAttribute('aria-pressed'));
      delete root.dataset.desktopLayout;
      return;
    }
    root.dataset.desktopLayout = 'true';
    add(controls, 'desktop-brand', '<span class="desktop-brand-mark" aria-hidden="true">S</span><strong>Siberdeyz<small>YAYIN MERKEZİ</small></strong>');
    add(header, 'desktop-heading', '<span>KİŞİSEL YAYIN ALANINIZ</span><h1>Yayın merkezi</h1>');
    add(controls, 'desktop-shortcuts', '<span>Klavye kısayolları</span><p><kbd>/</kbd> Kanal ara</p><p><kbd>Alt</kbd> + <kbd>1–4</kbd> Bölümler</p>');
    add(watch, 'desktop-player-empty', '<span class="desktop-play-mark" aria-hidden="true">▷</span><strong>İzlemeye hazır</strong><span>Listeden bir yayın seçin.</span><small>Hesaplar bölümünden yayın listenizi ekleyebilirsiniz.</small>');
    observer = new MutationObserver(sync);
    observer.observe(panel, { attributes: true, attributeFilter: ['data-open'] });
    observer.observe(channel, { childList: true, characterData: true, subtree: true });
    observer.observe(video, { attributes: true, attributeFilter: ['src'] });
    sync();
  }

  document.addEventListener('keydown', event => {
    if (!isDesktopLayout() || shell.hidden || event.defaultPrevented || event.isComposing) return;
    if (event.target.closest('input, select, textarea, [contenteditable="true"]')) return;
    if (event.key === '/' && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      openPanel('channels');
      document.querySelector('#searchInput').focus();
    } else if (event.altKey && !event.ctrlKey && !event.metaKey && /^[1-4]$/.test(event.key)) {
      event.preventDefault();
      openPanel(['channels', 'accounts', 'webscan', 'settings'][Number(event.key) - 1]);
    }
  });
  media.addEventListener('change', update);
  update();
}
