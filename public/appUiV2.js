const VALID_MODES = new Set(['classic', 'v2']);

let mounted = false;
let observer = null;

function getMode(value) {
  return VALID_MODES.has(String(value || '')) ? String(value) : 'classic';
}

function clickClassicControl(selector) {
  const control = document.querySelector(selector);
  if (control instanceof HTMLElement) control.click();
}

function syncV2State() {
  const shell = document.querySelector('#appShell');
  const panel = document.querySelector('#bottomPanel');
  const dock = document.querySelector('#v2TabBar');

  if (!(shell instanceof HTMLElement) || !(panel instanceof HTMLElement) || !(dock instanceof HTMLElement)) return;

  const activePanel = String(panel.dataset.open || 'none');
  const panelOpen = activePanel !== 'none';

  shell.classList.toggle('v2-panel-open', panelOpen);

  dock.querySelectorAll('[data-v2-panel]').forEach((button) => {
    const target = button.getAttribute('data-v2-panel') || '';
    button.classList.toggle('is-active', target === activePanel || (target === 'home' && !panelOpen));
  });
}

function mountV2Controls() {
  if (mounted) return;

  const shell = document.querySelector('#appShell');
  const panel = document.querySelector('#bottomPanel');
  if (!(shell instanceof HTMLElement) || !(panel instanceof HTMLElement)) return;

  const playerActions = document.createElement('section');
  playerActions.id = 'v2PlayerActions';
  playerActions.className = 'v2-player-actions';
  playerActions.setAttribute('aria-label', 'Oynatici islemleri');
  playerActions.innerHTML = `
    <button type="button" data-v2-action="stop"><span aria-hidden="true">■</span><small>Kapat</small></button>
    <button type="button" data-v2-action="next"><span aria-hidden="true">▶︎</span><small>Sonraki</small></button>
    <button type="button" data-v2-action="reload"><span aria-hidden="true">↻</span><small>Yenile</small></button>
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

    requestAnimationFrame(syncV2State);
  });

  shell.append(playerActions, tabBar);

  observer = new MutationObserver(syncV2State);
  observer.observe(panel, { attributes: true, attributeFilter: ['data-open', 'aria-hidden'] });

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
