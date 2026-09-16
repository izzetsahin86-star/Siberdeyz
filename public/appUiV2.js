const VALID_MODES = new Set(['classic', 'v2']);

const PAGE_META = Object.freeze({
  channels: { title: 'Kanallar', subtitle: 'Yayinlarini bul ve hemen oynat' },
  accounts: { title: 'Hesaplar', subtitle: 'Kaynaklarini ve baglantilarini yonet' },
  webscan: { title: 'Web Tarama', subtitle: 'Web uzerinden yayinlari yakala' },
  settings: { title: 'Ayarlar', subtitle: 'Siberdeyz deneyimini ozellestir' },
});

let mounted = false;
let panelObserver = null;
let smartObserver = null;

function getMode(value) {
  return VALID_MODES.has(String(value || '')) ? String(value) : 'classic';
}

function clickClassicControl(selector) {
  const control = document.querySelector(selector);
  if (control instanceof HTMLElement) control.click();
}

function refreshSmartButtons() {
  const buttons = [
    document.querySelector('#webScanButton'),
    document.querySelector('#fullSiteScanStart'),
    document.querySelector('#scanAllAccountsButton'),
  ];

  buttons.forEach((button) => {
    if (!(button instanceof HTMLButtonElement)) return;
    const text = String(button.textContent || '').toLocaleLowerCase('tr-TR');
    const processing = button.disabled && (
      text.includes('tara')
      || text.includes('bek')
      || text.includes('islen')
      || text.includes('kontrol')
    );
    button.classList.toggle('v2-is-processing', processing);
  });
}

function syncV2State({ animate = false } = {}) {
  const shell = document.querySelector('#appShell');
  const panel = document.querySelector('#bottomPanel');
  const dock = document.querySelector('#v2TabBar');
  const subtitle = document.querySelector('#v2PageSubtitle');

  if (!(shell instanceof HTMLElement) || !(panel instanceof HTMLElement) || !(dock instanceof HTMLElement)) return;

  const activePanel = String(panel.dataset.open || 'none');
  const panelOpen = activePanel !== 'none';
  const meta = PAGE_META[activePanel];

  shell.classList.toggle('v2-panel-open', panelOpen);
  shell.dataset.v2Page = panelOpen ? activePanel : 'home';

  if (subtitle instanceof HTMLElement) {
    subtitle.textContent = meta?.subtitle || 'Canli yayin merkeziniz';
  }

  dock.querySelectorAll('[data-v2-panel]').forEach((button) => {
    const target = button.getAttribute('data-v2-panel') || '';
    button.classList.toggle('is-active', target === activePanel || (target === 'home' && !panelOpen));
  });

  if (animate && panelOpen) {
    panel.classList.remove('v2-page-enter');
    void panel.offsetWidth;
    panel.classList.add('v2-page-enter');
  }

  refreshSmartButtons();
}

function addPressFeedback(root) {
  root.addEventListener('pointerdown', (event) => {
    const button = event.target.closest('button');
    if (!(button instanceof HTMLElement)) return;
    button.classList.add('v2-pressed');
  });

  const clear = () => {
    root.querySelectorAll('.v2-pressed').forEach((button) => button.classList.remove('v2-pressed'));
  };

  root.addEventListener('pointerup', clear);
  root.addEventListener('pointercancel', clear);
  root.addEventListener('pointerleave', clear);
}

function mountV2Controls() {
  if (mounted) return;

  const shell = document.querySelector('#appShell');
  const panel = document.querySelector('#bottomPanel');
  const header = document.querySelector('.app-header');
  const sheetHeader = panel?.querySelector('.sheet-header');

  if (!(shell instanceof HTMLElement) || !(panel instanceof HTMLElement)) return;

  if (header instanceof HTMLElement && !header.querySelector('#v2HeaderStatus')) {
    const status = document.createElement('div');
    status.id = 'v2HeaderStatus';
    status.className = 'v2-header-status';
    status.innerHTML = '<i aria-hidden="true"></i><span>Yayin Merkezi</span>';
    header.append(status);
  }

  if (sheetHeader instanceof HTMLElement && !sheetHeader.querySelector('#v2PageSubtitle')) {
    const subtitle = document.createElement('small');
    subtitle.id = 'v2PageSubtitle';
    subtitle.className = 'v2-page-subtitle';
    subtitle.textContent = 'Canli yayin merkeziniz';
    sheetHeader.querySelector('strong')?.insertAdjacentElement('afterend', subtitle);
  }

  const playerActions = document.createElement('section');
  playerActions.id = 'v2PlayerActions';
  playerActions.className = 'v2-player-actions';
  playerActions.setAttribute('aria-label', 'Oynatici islemleri');
  playerActions.innerHTML = `
    <button type="button" data-v2-action="stop"><span class="v2-action-icon" aria-hidden="true">■</span><small>Kapat</small></button>
    <button type="button" data-v2-action="next"><span class="v2-action-icon" aria-hidden="true">▶︎</span><small>Sonraki</small></button>
    <button type="button" data-v2-action="reload"><span class="v2-action-icon" aria-hidden="true">↻</span><small>Yenile</small></button>
  `;

  const tabBar = document.createElement('nav');
  tabBar.id = 'v2TabBar';
  tabBar.className = 'v2-tab-bar';
  tabBar.setAttribute('aria-label', 'Uygulama menusu');
  tabBar.innerHTML = `
    <button type="button" data-v2-panel="home"><span aria-hidden="true">⌂</span><small>Ana</small></button>
    <button type="button" data-v2-panel="channels"><span aria-hidden="true">▤</span><small>Kanallar</small></button>
    <button type="button" data-v2-panel="accounts"><span aria-hidden="true">◉</span><small>Hesaplar</small></button>
    <button type="button" data-v2-panel="webscan"><span aria-hidden="true">⌕</span><small>Tarama</small></button>
    <button type="button" data-v2-panel="settings"><span aria-hidden="true">⚙︎</span><small>Ayarlar</small></button>
  `;

  playerActions.addEventListener('click', (event) => {
    const button = event.target.closest('[data-v2-action]');
    if (!(button instanceof HTMLElement)) return;

    const action = button.dataset.v2Action;
    if (!action) return;

    clickClassicControl(`.control-button[data-action="${action}"]`);
  });

  tabBar.addEventListener('click', (event) => {
    const button = event.target.closest('[data-v2-panel]');
    if (!(button instanceof HTMLElement)) return;

    const target = button.dataset.v2Panel;
    if (!target) return;

    if (target === 'home') {
      const close = document.querySelector('#closePanelButton');
      if (close instanceof HTMLElement) close.click();
    } else {
      clickClassicControl(`.control-button[data-panel="${target}"]`);
    }

    requestAnimationFrame(() => syncV2State({ animate: true }));
  });

  shell.append(playerActions, tabBar);
  addPressFeedback(playerActions);
  addPressFeedback(tabBar);

  panelObserver = new MutationObserver(() => syncV2State({ animate: true }));
  panelObserver.observe(panel, { attributes: true, attributeFilter: ['data-open', 'aria-hidden'] });

  smartObserver = new MutationObserver(refreshSmartButtons);
  [
    document.querySelector('#webScanButton'),
    document.querySelector('#fullSiteScanStart'),
    document.querySelector('#scanAllAccountsButton'),
  ].forEach((button) => {
    if (button instanceof HTMLElement) {
      smartObserver.observe(button, {
        attributes: true,
        childList: true,
        characterData: true,
        subtree: true,
        attributeFilter: ['disabled'],
      });
    }
  });

  mounted = true;
  syncV2State();
}

export function applyAppUiMode(value) {
  const mode = getMode(value);
  document.documentElement.dataset.interfaceMode = mode;

  if (mode === 'v2') {
    mountV2Controls();
    syncV2State();
  }
}

export function getAppUiMode() {
  return getMode(document.documentElement.dataset.interfaceMode);
}
