function normalizeWebAddress(value) {
  const input = String(value || '').trim();
  if (!input) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) return input;
  return 'https://' + input.replace(/^\/+/, '');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  }[char]));
}

function formatDuration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return 'Suresi bilinmiyor';

  const total = Math.round(value);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  if (hours > 0) return hours + ' sa ' + String(minutes).padStart(2, '0') + ' dk';
  return minutes + ':' + String(secs).padStart(2, '0');
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
  if (document.querySelector('link[data-site-name-scan-style]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/siteNameScan.css';
  link.dataset.siteNameScanStyle = 'true';
  document.head.appendChild(link);
}

function buildModuleUi() {
  const root = document.querySelector('#webScanView');
  const tabs = root?.querySelector('.web-scan-mode-tabs');
  const fullSection = document.querySelector('#fullSiteScanSection');
  if (!root || !tabs || !fullSection) return null;

  let tab = document.querySelector('#siteNameScanModeTab');
  if (!tab) {
    tab = document.createElement('button');
    tab.id = 'siteNameScanModeTab';
    tab.className = 'web-scan-mode-tab';
    tab.type = 'button';
    tab.textContent = 'Isimle Tarama';
    tabs.appendChild(tab);
  }

  let section = document.querySelector('#siteNameScanSection');
  if (!section) {
    section = document.createElement('section');
    section.id = 'siteNameScanSection';
    section.className = 'web-scan-mode-section site-name-scan-section';
    section.hidden = true;
    section.innerHTML = [
      '<div class="site-name-scan-intro">',
      '<strong>Site icinde isim ara ve yayinlari bul</strong>',
      '<small>Once isimle eslesen sayfalar bulunur, sonra bu sayfalardaki yayinlar mevcut Web Tarama mantigiyla dogrulanir.</small>',
      '</div>',
      '<div class="site-name-toolbar">',
      '<input id="siteNameScanUrl" type="url" placeholder="ornek-site.com" autocomplete="off" inputmode="url" />',
      '<input id="siteNameScanQuery" type="search" placeholder="Aranacak isim" autocomplete="off" />',
      '<select id="siteNameScanLimit" aria-label="Taranacak sayfa limiti">',
      '<option value="30">30 sayfa</option>',
      '<option value="60" selected>60 sayfa</option>',
      '<option value="100">100 sayfa</option>',
      '</select>',
      '<button id="siteNameScanStart" type="button">Ismi Ara</button>',
      '</div>',
      '<div class="site-name-progress-wrap">',
      '<div id="siteNameScanStatus" class="site-name-status" hidden></div>',
      '<div id="siteNameScanProgress" class="site-name-progress" hidden><i id="siteNameScanProgressFill"></i><span id="siteNameScanProgressText">0%</span></div>',
      '<div id="siteNameScanStats" class="site-name-stats"></div>',
      '<div class="site-name-actions">',
      '<button id="siteNameScanPause" type="button" hidden>Duraklat</button>',
      '<button id="siteNameScanResume" type="button" hidden>Devam Et</button>',
      '<button id="siteNameScanStop" type="button" hidden>Durdur</button>',
      '</div>',
      '</div>',
      '<div id="siteNameScanMatches" class="site-name-matches" hidden></div>',
      '<div class="site-name-results-wrap">',
      '<div class="site-name-tools">',
      '<button id="siteNameScanSelectAll" type="button">Tumunu Sec</button>',
      '<button id="siteNameScanClearSelection" type="button">Secimi Temizle</button>',
      '<button id="siteNameScanDeleteAll" class="site-name-delete-all" type="button">Tumunu Sil</button>',
      '</div>',
      '<div id="siteNameScanResults" class="site-name-results"></div>',
      '</div>',
      '<div id="siteNameScanSaveBar" class="site-name-save-bar" hidden>',
      '<input id="siteNameScanSaveLabel" type="text" maxlength="80" placeholder="Kayit adi (istege bagli)" autocomplete="off" />',
      '<button id="siteNameScanSave" type="button">Secilenleri Kaydet</button>',
      '</div>',
    ].join('');

    fullSection.insertAdjacentElement('afterend', section);
  }

  return { root, tabs, tab, section };
}

export function createSiteNameScanController({ onSaved } = {}) {
  ensureStylesheet();
  const ui = buildModuleUi();
  if (!ui) return { refresh() {}, destroy() {} };

  const elements = {
    tab: ui.tab,
    section: ui.section,
    quickSection: document.querySelector('#quickWebScanSection'),
    fullSection: document.querySelector('#fullSiteScanSection'),
    existingTabs: ui.tabs.querySelectorAll('[data-web-scan-mode]'),
    url: document.querySelector('#siteNameScanUrl'),
    query: document.querySelector('#siteNameScanQuery'),
    limit: document.querySelector('#siteNameScanLimit'),
    start: document.querySelector('#siteNameScanStart'),
    status: document.querySelector('#siteNameScanStatus'),
    progress: document.querySelector('#siteNameScanProgress'),
    progressFill: document.querySelector('#siteNameScanProgressFill'),
    progressText: document.querySelector('#siteNameScanProgressText'),
    stats: document.querySelector('#siteNameScanStats'),
    pause: document.querySelector('#siteNameScanPause'),
    resume: document.querySelector('#siteNameScanResume'),
    stop: document.querySelector('#siteNameScanStop'),
    matches: document.querySelector('#siteNameScanMatches'),
    results: document.querySelector('#siteNameScanResults'),
    selectAll: document.querySelector('#siteNameScanSelectAll'),
    clearSelection: document.querySelector('#siteNameScanClearSelection'),
    deleteAll: document.querySelector('#siteNameScanDeleteAll'),
    saveBar: document.querySelector('#siteNameScanSaveBar'),
    saveLabel: document.querySelector('#siteNameScanSaveLabel'),
    save: document.querySelector('#siteNameScanSave'),
  };

  let snapshot = null;
  let selected = new Set();
  let knownResultIds = new Set();
  let pollTimer = null;
  let saving = false;
  let refreshing = false;

  function setStatus(message, type = 'info') {
    elements.status.textContent = message || '';
    elements.status.dataset.type = type;
    elements.status.hidden = !message;
  }

  function setModeName() {
    elements.existingTabs.forEach((button) => button.classList.remove('is-active'));
    elements.tab.classList.add('is-active');
    if (elements.quickSection) elements.quickSection.hidden = true;
    if (elements.fullSection) elements.fullSection.hidden = true;
    elements.section.hidden = false;

    const quickUrl = String(document.querySelector('#webScanUrl')?.value || '').trim();
    const fullUrl = String(document.querySelector('#fullSiteScanUrl')?.value || '').trim();
    if (!elements.url.value) elements.url.value = quickUrl || fullUrl;

    refresh().catch(() => {});
  }

  function leaveNameMode() {
    elements.tab.classList.remove('is-active');
    elements.section.hidden = true;
    stopPolling();
  }

  elements.tab.addEventListener('click', setModeName);
  elements.existingTabs.forEach((button) => button.addEventListener('click', leaveNameMode));

  function progressPercent(data) {
    if (!data) return 0;
    const p = data.progress || {};
    const limit = Math.max(1, Number(data.pageLimit) || 1);

    if (data.phase === 'searching' || data.phase === 'queued') {
      return Math.min(45, Math.round((Math.min(limit, Number(p.pagesVisited) || 0) / limit) * 45));
    }

    if (data.phase === 'discovering') {
      const matches = Math.max(1, Number(p.matchesFound) || 1);
      const scanned = Math.min(matches, Number(p.matchPagesScanned) || 0);
      return Math.min(75, 45 + Math.round((scanned / matches) * 30));
    }

    if (data.phase === 'testing') {
      const found = Math.max(1, Number(p.mediaFound) || 1);
      const tested = Math.min(found, Number(p.mediaTested) || 0);
      return Math.min(99, 75 + Math.round((tested / found) * 24));
    }

    if (['completed', 'stopped', 'failed'].includes(data.status)) return 100;
    return 0;
  }

  function renderStats(data) {
    const p = data?.progress || {};
    const items = [
      ['Sayfa', (Number(p.pagesVisited) || 0) + '/' + (Number(data?.pageLimit) || 0)],
      ['Eslesen', Number(p.matchesFound) || 0],
      ['Taranan eslesme', Number(p.matchPagesScanned) || 0],
      ['Medya', Number(p.mediaFound) || 0],
      ['Test', Number(p.mediaTested) || 0],
      ['Uygun', Number(p.accepted) || 0],
      ['3 dk alti', Number(p.shortRemoved) || 0],
      ['Acilmayan', Number(p.mediaFailed) || 0],
    ];

    elements.stats.innerHTML = items.map(([label, value]) => (
      '<span><strong>' + escapeHtml(value) + '</strong><small>' + escapeHtml(label) + '</small></span>'
    )).join('');
  }

  function renderMatches(data) {
    const matches = Array.isArray(data?.matches) ? data.matches : [];
    if (!matches.length) {
      elements.matches.hidden = true;
      elements.matches.innerHTML = '';
      return;
    }

    elements.matches.hidden = false;
    elements.matches.innerHTML = [
      '<div class="site-name-match-head"><strong>Eslesen Sayfalar</strong><span>' + matches.length + '</span></div>',
      '<div class="site-name-match-list">',
      ...matches.map((item) => (
        '<div class="site-name-match-item"><strong>' + escapeHtml(item.title || 'Eslesen sayfa') + '</strong>'
        + '<small>' + escapeHtml(item.url || '') + '</small></div>'
      )),
      '</div>',
    ].join('');
  }

  function syncSelected(results) {
    const current = new Set(results.map((item) => item.id));
    selected = new Set([...selected].filter((id) => current.has(id)));

    for (const result of results) {
      if (!knownResultIds.has(result.id)) {
        knownResultIds.add(result.id);
        selected.add(result.id);
      }
    }
  }

  function renderResults(data) {
    const results = Array.isArray(data?.results) ? data.results : [];
    syncSelected(results);

    if (!results.length) {
      elements.results.innerHTML = isActiveStatus(data?.status)
        ? '<div class="site-name-empty">Tarama suruyor. Uygun yayinlar burada gorunecek.</div>'
        : '<div class="site-name-empty">Kaydedilebilir yayin bulunamadi.</div>';
      elements.saveBar.hidden = true;
      updateSaveButton();
      return;
    }

    elements.results.innerHTML = results.map((candidate) => {
      const checked = selected.has(candidate.id);
      const unknown = candidate.durationStatus === 'unknown';
      return [
        '<label class="site-name-result ' + (checked ? 'is-selected' : '') + '">',
        '<input type="checkbox" data-site-name-select="' + escapeHtml(candidate.id) + '"' + (checked ? ' checked' : '') + ' />',
        '<span>',
        '<strong>' + escapeHtml(candidate.name || 'Isim Tarama Yayini') + '</strong>',
        '<small><b>' + escapeHtml(candidate.kind || 'VIDEO') + '</b> · ' + escapeHtml(formatDuration(candidate.durationSeconds)) + '</small>',
        '<em class="' + (unknown ? 'is-unknown' : 'is-ready') + '">'
          + (unknown ? 'Suresi bilinmiyor · Manuel kontrol' : '3 dakika filtresini gecti')
          + '</em>',
        '<small class="site-name-source-page">' + escapeHtml(candidate.sourcePage || '') + '</small>',
        '</span>',
        '</label>',
      ].join('');
    }).join('');

    elements.saveBar.hidden = false;
    updateSaveButton();
  }

  function updateControls(data) {
    const status = String(data?.status || '');
    const active = isActiveStatus(status);
    const paused = status === 'paused';

    elements.start.disabled = active;
    elements.start.textContent = active ? 'Tarama Calisiyor' : 'Ismi Ara';
    elements.pause.hidden = !active || paused || status === 'stopping';
    elements.resume.hidden = !paused;
    elements.stop.hidden = !active || status === 'stopping';
  }

  function updateSaveButton() {
    elements.save.disabled = (
      saving
      || selected.size === 0
      || !snapshot?.jobId
      || isActiveStatus(snapshot?.status)
    );
    elements.save.textContent = saving
      ? 'Kaydediliyor...'
      : ('Secilenleri Kaydet (' + selected.size + ')');
  }

  function render(data) {
    snapshot = data || null;

    if (!data) {
      elements.progress.hidden = true;
      elements.stats.innerHTML = '';
      elements.matches.hidden = true;
      elements.matches.innerHTML = '';
      elements.results.innerHTML = '<div class="site-name-empty">Site adresini ve aranacak ismi girin.</div>';
      elements.saveBar.hidden = true;
      updateControls(null);
      setStatus('');
      return;
    }

    const percent = progressPercent(data);
    elements.progress.hidden = false;
    elements.progressFill.style.width = percent + '%';
    elements.progressText.textContent = percent + '%';

    renderStats(data);
    renderMatches(data);
    renderResults(data);
    updateControls(data);

    const type = data.status === 'failed'
      ? 'error'
      : (data.status === 'completed' ? 'success' : (data.status === 'paused' ? 'warning' : 'info'));
    setStatus(data.message || 'Isim taramasi calisiyor...', type);

    if (isActiveStatus(data.status)) startPolling();
    else stopPolling();
  }

  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      const response = await fetch('/api/site-name-scan/status', { cache: 'no-store' });
      const data = await readJson(response, 'Isim tarama durumu alinamadi.');
      render(data);
    } finally {
      refreshing = false;
    }
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      refresh().catch((error) => setStatus(error.message, 'error'));
    }, 1200);
  }

  function stopPolling() {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
  }

  async function start() {
    const url = normalizeWebAddress(elements.url.value);
    const query = String(elements.query.value || '').replace(/\s+/g, ' ').trim();

    if (!url) {
      setStatus('Taranacak web sitesi adresini girin.', 'warning');
      return;
    }

    if (query.length < 2) {
      setStatus('Aranacak isim en az 2 karakter olmali.', 'warning');
      return;
    }

    elements.url.value = url;
    selected.clear();
    knownResultIds.clear();
    elements.start.disabled = true;
    setStatus('Site icinde "' + query + '" araniyor...');

    try {
      const response = await fetch('/api/site-name-scan/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          url,
          query,
          limit: Number(elements.limit.value) || 60,
        }),
      });
      const data = await readJson(response, 'Isim taramasi baslatilamadi.');
      render(data);
      startPolling();
    } catch (error) {
      elements.start.disabled = false;
      setStatus(error.message, 'error');
    }
  }

  async function action(endpoint, fallback) {
    const response = await fetch(endpoint, { method: 'POST' });
    const data = await readJson(response, fallback);
    render(data);
  }

  async function save() {
    if (saving || !snapshot?.jobId || selected.size === 0) return;
    saving = true;
    updateSaveButton();
    setStatus('Secilen yayinlar Web Tarama klasorune kaydediliyor...');

    try {
      const response = await fetch('/api/site-name-scan/' + encodeURIComponent(snapshot.jobId) + '/save', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ids: [...selected],
          label: String(elements.saveLabel.value || '').trim(),
        }),
      });
      const data = await readJson(response, 'Isim tarama sonuclari kaydedilemedi.');
      setStatus(String(data.saved || selected.size) + ' yayin Web Tarama klasorune kaydedildi.', 'success');
      if (typeof onSaved === 'function') await onSaved(data);
    } catch (error) {
      setStatus(error.message, 'error');
    } finally {
      saving = false;
      updateSaveButton();
    }
  }

  elements.start.addEventListener('click', () => start().catch(() => {}));
  elements.url.addEventListener('blur', () => {
    const normalized = normalizeWebAddress(elements.url.value);
    if (normalized) elements.url.value = normalized;
  });

  for (const input of [elements.url, elements.query]) {
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      start().catch(() => {});
    });
  }

  elements.pause.addEventListener('click', () => {
    action('/api/site-name-scan/pause', 'Tarama duraklatilamadi.').catch((error) => setStatus(error.message, 'error'));
  });

  elements.resume.addEventListener('click', () => {
    action('/api/site-name-scan/resume', 'Taramaya devam edilemedi.').catch((error) => setStatus(error.message, 'error'));
  });

  elements.stop.addEventListener('click', () => {
    action('/api/site-name-scan/stop', 'Tarama durdurulamadi.').catch((error) => setStatus(error.message, 'error'));
  });

  elements.results.addEventListener('change', (event) => {
    const checkbox = event.target.closest('[data-site-name-select]');
    if (!checkbox) return;
    if (checkbox.checked) selected.add(checkbox.dataset.siteNameSelect);
    else selected.delete(checkbox.dataset.siteNameSelect);
    renderResults(snapshot);
  });

  elements.selectAll.addEventListener('click', () => {
    selected = new Set((snapshot?.results || []).map((item) => item.id));
    renderResults(snapshot);
  });

  elements.clearSelection.addEventListener('click', () => {
    selected.clear();
    renderResults(snapshot);
  });

  elements.deleteAll.addEventListener('click', () => {
    if (!snapshot?.jobId || !(snapshot.results || []).length) return;

    elements.deleteAll.disabled = true;
    fetch('/api/site-name-scan/' + encodeURIComponent(snapshot.jobId) + '/results', {
      method: 'DELETE',
      cache: 'no-store',
    })
      .then((response) => readJson(response, 'Isim tarama sonuclari silinemedi.'))
      .then((data) => {
        selected.clear();
        knownResultIds.clear();
        render(null);
        setStatus((Number(data.deleted) || 0) + ' tarama sonucu silindi.', 'success');
      })
      .catch((error) => setStatus(error.message, 'error'))
      .finally(() => {
        elements.deleteAll.disabled = false;
      });
  });

  elements.save.addEventListener('click', () => save().catch(() => {}));

  render(null);

  return {
    refresh,
    destroy() {
      stopPolling();
    },
  };
}
