function normalizeWebAddress(value) {
  const input = String(value || '').trim();
  if (!input) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) return input;
  return 'https://' + input.replace(/^\/+/, '');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  }[character]));
}

function formatDuration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return 'Sure bilinmiyor';

  const total = Math.round(value);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remaining = total % 60;
  return hours > 0
    ? hours + ' sa ' + String(minutes).padStart(2, '0') + ' dk'
    : minutes + ':' + String(remaining).padStart(2, '0');
}

function sourceLabel(value) {
  try {
    return new URL(String(value || '')).hostname.replace(/^www\./i, '');
  } catch {
    return 'Kaynak sayfa';
  }
}

async function readJson(response, fallbackMessage) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || fallbackMessage);
  return data;
}

function isActiveStatus(status) {
  return ['running', 'paused', 'stopping'].includes(String(status || ''));
}

function ensureStylesheet() {
  if (document.querySelector('link[data-media-finder-pro-style]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/mediaFinderPro.css';
  link.dataset.mediaFinderProStyle = 'true';
  document.head.appendChild(link);
}

function buildUi() {
  const root = document.querySelector('#webScanView');
  const tabs = root?.querySelector('.web-scan-mode-tabs');
  const fullSection = document.querySelector('#fullSiteScanSection');
  if (!root || !tabs || !fullSection) return null;

  const tab = document.createElement('button');
  tab.id = 'mediaFinderProTab';
  tab.className = 'web-scan-mode-tab media-finder-pro-tab';
  tab.type = 'button';
  tab.textContent = 'Yayin Bul Pro';
  tabs.appendChild(tab);

  const section = document.createElement('section');
  section.id = 'mediaFinderProSection';
  section.className = 'web-scan-mode-section media-finder-pro-section';
  section.hidden = true;
  section.innerHTML = [
    '<div class="media-pro-input-card">',
    '<div class="media-pro-mode-switch" role="tablist" aria-label="Yayin bulma yontemi">',
    '<button type="button" class="is-active" data-media-pro-mode="search">Sitede Film / Oyuncu Ara</button>',
    '<button type="button" data-media-pro-mode="direct">Yayin Linkinden Bul</button>',
    '</div>',
    '<div id="mediaProSearchForm" class="media-pro-form media-pro-search-form">',
    '<input id="mediaProSiteUrl" type="url" placeholder="ornek-site.com" autocomplete="off" inputmode="url" />',
    '<input id="mediaProQuery" type="search" placeholder="Film veya oyuncu adi" autocomplete="off" />',
    '<select id="mediaProLimit" aria-label="Taranacak sayfa limiti">',
    '<option value="20">20 sayfa</option><option value="40" selected>40 sayfa</option><option value="80">80 sayfa</option><option value="120">120 sayfa</option>',
    '</select>',
    '<button id="mediaProSearchStart" type="button">Pro Ara</button>',
    '</div>',
    '<div id="mediaProDirectForm" class="media-pro-form media-pro-direct-form" hidden>',
    '<input id="mediaProDirectUrl" type="url" placeholder="Video yayin veya video sayfasi linki" autocomplete="off" inputmode="url" />',
    '<button id="mediaProDirectStart" type="button">Yayini Bul</button>',
    '</div>',
    '</div>',
    '<div class="media-pro-progress-wrap">',
    '<div id="mediaProStatus" class="media-pro-status" hidden></div>',
    '<div id="mediaProProgress" class="media-pro-progress" hidden><i id="mediaProProgressFill"></i><span id="mediaProProgressText">0%</span></div>',
    '<div id="mediaProStats" class="media-pro-stats"></div>',
    '<div class="media-pro-actions"><button id="mediaProPause" type="button" hidden>Duraklat</button><button id="mediaProResume" type="button" hidden>Devam Et</button><button id="mediaProStop" type="button" hidden>Durdur</button></div>',
    '</div>',
    '<div class="media-pro-results-wrap">',
    '<div class="media-pro-tools"><span id="mediaProResultCount">0 yayin</span><button id="mediaProSelectAll" type="button">Tumunu Sec</button><button id="mediaProClearSelection" type="button">Secimi Temizle</button><button id="mediaProDeleteAll" class="media-pro-delete-all" type="button">Sonuclari Sil</button></div>',
    '<div id="mediaProResults" class="media-pro-results"></div>',
    '</div>',
    '<div id="mediaProSaveBar" class="media-pro-save-bar" hidden>',
    '<input id="mediaProSaveLabel" type="text" maxlength="80" placeholder="Kayit adi (istege bagli)" autocomplete="off" />',
    '<button id="mediaProSave" type="button">Secilenleri Kaydet</button>',
    '</div>',
  ].join('');
  fullSection.insertAdjacentElement('afterend', section);

  return { root, tabs, tab, section };
}

export function createMediaFinderProController({ onSaved } = {}) {
  ensureStylesheet();
  const ui = buildUi();
  if (!ui) return { refresh() {}, destroy() {} };

  const elements = {
    tab: ui.tab,
    section: ui.section,
    quickSection: document.querySelector('#quickWebScanSection'),
    fullSection: document.querySelector('#fullSiteScanSection'),
    existingTabs: ui.tabs.querySelectorAll('[data-web-scan-mode]'),
    modeButtons: ui.section.querySelectorAll('[data-media-pro-mode]'),
    searchForm: document.querySelector('#mediaProSearchForm'),
    directForm: document.querySelector('#mediaProDirectForm'),
    siteUrl: document.querySelector('#mediaProSiteUrl'),
    query: document.querySelector('#mediaProQuery'),
    limit: document.querySelector('#mediaProLimit'),
    searchStart: document.querySelector('#mediaProSearchStart'),
    directUrl: document.querySelector('#mediaProDirectUrl'),
    directStart: document.querySelector('#mediaProDirectStart'),
    status: document.querySelector('#mediaProStatus'),
    progress: document.querySelector('#mediaProProgress'),
    progressFill: document.querySelector('#mediaProProgressFill'),
    progressText: document.querySelector('#mediaProProgressText'),
    stats: document.querySelector('#mediaProStats'),
    pause: document.querySelector('#mediaProPause'),
    resume: document.querySelector('#mediaProResume'),
    stop: document.querySelector('#mediaProStop'),
    results: document.querySelector('#mediaProResults'),
    resultCount: document.querySelector('#mediaProResultCount'),
    selectAll: document.querySelector('#mediaProSelectAll'),
    clearSelection: document.querySelector('#mediaProClearSelection'),
    deleteAll: document.querySelector('#mediaProDeleteAll'),
    saveBar: document.querySelector('#mediaProSaveBar'),
    saveLabel: document.querySelector('#mediaProSaveLabel'),
    save: document.querySelector('#mediaProSave'),
  };

  let inputMode = 'search';
  let state = null;
  let selected = new Set();
  let knownResultIds = new Set();
  let pollingTimer = null;
  let refreshing = false;
  let saving = false;

  function setStatus(message, type = 'info') {
    elements.status.textContent = message || '';
    elements.status.dataset.type = type;
    elements.status.hidden = !message;
  }

  function stopPolling() {
    if (!pollingTimer) return;
    clearInterval(pollingTimer);
    pollingTimer = null;
  }

  function startPolling() {
    if (pollingTimer) return;
    pollingTimer = setInterval(() => {
      refresh().catch((error) => setStatus(error.message, 'error'));
    }, 1_200);
  }

  function openModule() {
    elements.existingTabs.forEach((button) => button.classList.remove('is-active'));
    elements.tab.classList.add('is-active');
    elements.quickSection.hidden = true;
    elements.fullSection.hidden = true;
    elements.section.hidden = false;

    const inheritedUrl = String(document.querySelector('#webScanUrl')?.value || document.querySelector('#fullSiteScanUrl')?.value || '').trim();
    if (!elements.siteUrl.value && inheritedUrl) elements.siteUrl.value = inheritedUrl;
    refresh().catch((error) => setStatus(error.message, 'error'));
  }

  function closeModule() {
    elements.tab.classList.remove('is-active');
    elements.section.hidden = true;
    stopPolling();
  }

  function setInputMode(mode) {
    if (isActiveStatus(state?.status)) return;
    inputMode = mode === 'direct' ? 'direct' : 'search';
    elements.modeButtons.forEach((button) => {
      button.classList.toggle('is-active', button.dataset.mediaProMode === inputMode);
    });
    elements.searchForm.hidden = inputMode !== 'search';
    elements.directForm.hidden = inputMode !== 'direct';
  }

  function progressPercent(data) {
    if (!data) return 0;
    if (['completed', 'stopped', 'failed'].includes(data.status)) return 100;

    const progress = data.progress || {};
    if (data.phase === 'queued') return 3;
    if (data.phase === 'searching') {
      const limit = Math.max(1, Number(data.pageLimit) || 1);
      return Math.min(45, 6 + Math.round((Math.min(limit, Number(progress.pagesVisited) || 0) / limit) * 39));
    }
    if (data.phase === 'discovering') {
      const pages = Math.max(1, Number(progress.matchesFound) || 1);
      const scanned = Math.min(pages, Number(progress.matchPagesScanned) || 0);
      return Math.min(75, 46 + Math.round((scanned / pages) * 29));
    }
    if (data.phase === 'testing') {
      const found = Math.max(1, Number(progress.mediaFound) || 1);
      const tested = Math.min(found, Number(progress.mediaTested) || 0);
      return Math.min(99, 76 + Math.round((tested / found) * 23));
    }
    return 1;
  }

  function renderStats(data) {
    const progress = data?.progress || {};
    const values = [
      ['Sayfa', Number(progress.pagesVisited) || 0],
      ['Eslesen', Number(progress.matchesFound) || 0],
      ['Aday', Number(progress.mediaFound) || 0],
      ['Test', Number(progress.mediaTested) || 0],
      ['Calisan', Number(progress.accepted) || 0],
      ['Kisa', Number(progress.shortRemoved) || 0],
      ['DRM', Number(progress.drmRemoved) || 0],
      ['Hata', (Number(progress.mediaFailed) || 0) + (Number(progress.searchErrors) || 0)],
    ];

    elements.stats.innerHTML = values.map(([label, value]) => (
      '<span><strong>' + escapeHtml(value) + '</strong><small>' + escapeHtml(label) + '</small></span>'
    )).join('');
  }

  function syncSelection(results) {
    const currentIds = new Set(results.map((result) => result.id));
    selected = new Set([...selected].filter((id) => currentIds.has(id)));

    for (const result of results) {
      if (knownResultIds.has(result.id)) continue;
      knownResultIds.add(result.id);
      selected.add(result.id);
    }
  }

  function updateSaveButton() {
    elements.save.disabled = saving || selected.size === 0 || isActiveStatus(state?.status) || !state?.jobId;
    elements.save.textContent = saving
      ? 'Kaydediliyor...'
      : ('Secilenleri Kaydet (' + selected.size + ')');
  }

  function renderResults(data) {
    const results = Array.isArray(data?.results) ? data.results : [];
    syncSelection(results);
    elements.resultCount.textContent = results.length + ' yayin';

    if (!results.length) {
      elements.results.innerHTML = isActiveStatus(data?.status)
        ? '<div class="media-pro-empty"><i></i><strong>Pro tarama devam ediyor</strong><span>Calisan yayinlar bulundukca burada listelenecek.</span></div>'
        : '<div class="media-pro-empty"><i></i><strong>Yayin bulunmadi</strong><span>Site ve isimle arayin veya dogrudan yayin linki yapistirin.</span></div>';
      elements.saveBar.hidden = true;
      updateSaveButton();
      return;
    }

    elements.results.innerHTML = results.map((result) => {
      const checked = selected.has(result.id);
      const unknown = result.durationStatus === 'unknown';
      return [
        '<label class="media-pro-result ' + (checked ? 'is-selected' : '') + '">',
        '<input type="checkbox" data-media-pro-select="' + escapeHtml(result.id) + '"' + (checked ? ' checked' : '') + ' />',
        '<span class="media-pro-result-copy">',
        '<strong>' + escapeHtml(result.name || 'Bulunan Yayin') + '</strong>',
        '<small><b>' + escapeHtml(result.kind || 'VIDEO') + '</b> · ' + escapeHtml(formatDuration(result.durationSeconds)) + ' · ' + escapeHtml(sourceLabel(result.sourcePage)) + '</small>',
        '<em class="' + (unknown ? 'is-unknown' : 'is-ready') + '">'
          + (unknown ? 'Yayin dogrulandi · Sure bilgisi yok' : (result.explicitlyRequested ? 'Yapistirilan yayin dogrulandi' : 'Pro dogrulamadan gecti'))
          + '</em>',
        '</span>',
        '</label>',
      ].join('');
    }).join('');

    elements.saveBar.hidden = false;
    updateSaveButton();
  }

  function renderControls(data) {
    const status = String(data?.status || '');
    const active = isActiveStatus(status);
    const paused = status === 'paused';
    elements.searchStart.disabled = active;
    elements.directStart.disabled = active;
    elements.modeButtons.forEach((button) => { button.disabled = active; });
    elements.pause.hidden = !active || paused || status === 'stopping';
    elements.resume.hidden = !paused;
    elements.stop.hidden = !active || status === 'stopping';
    elements.searchStart.textContent = active && data?.mode === 'search' ? 'Pro Araniyor' : 'Pro Ara';
    elements.directStart.textContent = active && data?.mode === 'direct' ? 'Yayin Araniyor' : 'Yayini Bul';
    elements.deleteAll.disabled = active || !data?.jobId;
  }

  function render(data) {
    state = data || null;
    if (!data) {
      elements.progress.hidden = true;
      elements.stats.innerHTML = '';
      elements.results.innerHTML = '<div class="media-pro-empty"><i></i><strong>Yayin Bul Pro hazir</strong><span>Iki arama yonteminden birini secip islemi baslatin.</span></div>';
      elements.resultCount.textContent = '0 yayin';
      elements.saveBar.hidden = true;
      renderControls(null);
      setStatus('');
      updateSaveButton();
      return;
    }

    const percent = progressPercent(data);
    elements.progress.hidden = false;
    elements.progressFill.style.width = percent + '%';
    elements.progressText.textContent = percent + '%';
    renderStats(data);
    renderResults(data);
    renderControls(data);

    const type = data.status === 'failed'
      ? 'error'
      : (data.status === 'completed' ? (data.results?.length ? 'success' : 'warning') : (data.status === 'paused' ? 'warning' : 'info'));
    setStatus(data.message || 'Yayin Bul Pro calisiyor...', type);
    if (isActiveStatus(data.status)) startPolling();
    else stopPolling();
  }

  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      const response = await fetch('/api/media-finder-pro/status', { cache: 'no-store' });
      render(await readJson(response, 'Yayin Bul Pro durumu alinamadi.'));
    } finally {
      refreshing = false;
    }
  }

  async function start(mode) {
    if (isActiveStatus(state?.status)) return;
    const searchMode = mode === 'search';
    const urlInput = searchMode ? elements.siteUrl : elements.directUrl;
    const url = normalizeWebAddress(urlInput.value);
    const query = searchMode ? String(elements.query.value || '').replace(/\s+/g, ' ').trim() : '';

    if (!url) {
      setStatus(searchMode ? 'Aranacak site adresini girin.' : 'Video yayin veya video sayfasi linkini girin.', 'warning');
      return;
    }
    if (searchMode && query.length < 2) {
      setStatus('Film veya oyuncu adi en az 2 karakter olmali.', 'warning');
      return;
    }

    urlInput.value = url;
    selected.clear();
    knownResultIds.clear();
    renderControls({ status: 'running', mode });
    setStatus(searchMode ? ('Site icinde "' + query + '" Pro motorla araniyor...') : 'Yayin baglantisi Pro motorla inceleniyor...');

    try {
      const response = await fetch('/api/media-finder-pro/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mode,
          url,
          query,
          limit: Number(elements.limit.value) || 40,
        }),
      });
      render(await readJson(response, 'Yayin Bul Pro baslatilamadi.'));
      startPolling();
    } catch (error) {
      renderControls(state);
      setStatus(error.message, 'error');
    }
  }

  async function runAction(action, fallbackMessage) {
    const response = await fetch('/api/media-finder-pro/' + action, { method: 'POST' });
    render(await readJson(response, fallbackMessage));
  }

  async function save() {
    if (saving || !state?.jobId || !selected.size) return;
    saving = true;
    updateSaveButton();
    setStatus('Secilen yayinlar Web Tarama hesaplarina kaydediliyor...');

    try {
      const response = await fetch('/api/media-finder-pro/' + encodeURIComponent(state.jobId) + '/save', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ids: [...selected],
          label: String(elements.saveLabel.value || '').trim(),
        }),
      });
      const data = await readJson(response, 'Yayin Bul Pro sonuclari kaydedilemedi.');
      setStatus((Number(data.saved) || selected.size) + ' yayin kaydedildi ve aktif hesap yapildi.', 'success');
      if (typeof onSaved === 'function') await onSaved(data);
    } catch (error) {
      setStatus(error.message, 'error');
    } finally {
      saving = false;
      updateSaveButton();
    }
  }

  ui.tab.addEventListener('click', openModule);
  elements.existingTabs.forEach((button) => button.addEventListener('click', closeModule));
  elements.modeButtons.forEach((button) => button.addEventListener('click', () => setInputMode(button.dataset.mediaProMode)));
  elements.searchStart.addEventListener('click', () => start('search').catch(() => {}));
  elements.directStart.addEventListener('click', () => start('direct').catch(() => {}));

  for (const input of [elements.siteUrl, elements.query]) {
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      start('search').catch(() => {});
    });
  }
  elements.directUrl.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    start('direct').catch(() => {});
  });
  for (const input of [elements.siteUrl, elements.directUrl]) {
    input.addEventListener('blur', () => {
      const normalized = normalizeWebAddress(input.value);
      if (normalized) input.value = normalized;
    });
  }

  elements.pause.addEventListener('click', () => runAction('pause', 'Yayin Bul Pro duraklatilamadi.').catch((error) => setStatus(error.message, 'error')));
  elements.resume.addEventListener('click', () => runAction('resume', 'Yayin Bul Pro devam ettirilemedi.').catch((error) => setStatus(error.message, 'error')));
  elements.stop.addEventListener('click', () => runAction('stop', 'Yayin Bul Pro durdurulamadi.').catch((error) => setStatus(error.message, 'error')));

  elements.results.addEventListener('change', (event) => {
    const checkbox = event.target.closest('[data-media-pro-select]');
    if (!checkbox) return;
    if (checkbox.checked) selected.add(checkbox.dataset.mediaProSelect);
    else selected.delete(checkbox.dataset.mediaProSelect);
    renderResults(state);
  });
  elements.selectAll.addEventListener('click', () => {
    selected = new Set((state?.results || []).map((result) => result.id));
    renderResults(state);
  });
  elements.clearSelection.addEventListener('click', () => {
    selected.clear();
    renderResults(state);
  });
  elements.deleteAll.addEventListener('click', async () => {
    if (!state?.jobId || isActiveStatus(state.status)) return;
    elements.deleteAll.disabled = true;
    try {
      const response = await fetch('/api/media-finder-pro/' + encodeURIComponent(state.jobId) + '/results', { method: 'DELETE' });
      const data = await readJson(response, 'Yayin Bul Pro sonuclari silinemedi.');
      selected.clear();
      knownResultIds.clear();
      render(null);
      setStatus((Number(data.deleted) || 0) + ' yayin sonucu silindi.', 'success');
    } catch (error) {
      setStatus(error.message, 'error');
    } finally {
      elements.deleteAll.disabled = false;
    }
  });
  elements.save.addEventListener('click', () => save().catch(() => {}));

  setInputMode('search');
  render(null);

  return {
    refresh,
    destroy() {
      stopPolling();
    },
  };
}
