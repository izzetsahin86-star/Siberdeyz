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

export function createFullSiteScanController({ onSaved } = {}) {
  const elements = {
    modeButtons: document.querySelectorAll('[data-web-scan-mode]'),
    quickSection: document.querySelector('#quickWebScanSection'),
    fullSection: document.querySelector('#fullSiteScanSection'),
    personSection: document.querySelector('#personVideoScanSection'),
    url: document.querySelector('#fullSiteScanUrl'),
    limit: document.querySelector('#fullSiteScanLimit'),
    start: document.querySelector('#fullSiteScanStart'),
    status: document.querySelector('#fullSiteScanStatus'),
    progress: document.querySelector('#fullSiteScanProgress'),
    progressFill: document.querySelector('#fullSiteScanProgressFill'),
    progressText: document.querySelector('#fullSiteScanProgressText'),
    stats: document.querySelector('#fullSiteScanStats'),
    pause: document.querySelector('#fullSiteScanPause'),
    resume: document.querySelector('#fullSiteScanResume'),
    stop: document.querySelector('#fullSiteScanStop'),
    results: document.querySelector('#fullSiteScanResults'),
    selectAll: document.querySelector('#fullSiteScanSelectAll'),
    clearSelection: document.querySelector('#fullSiteScanClearSelection'),
    deleteAll: document.querySelector('#fullSiteScanDeleteAll'),
    saveBar: document.querySelector('#fullSiteScanSaveBar'),
    saveLabel: document.querySelector('#fullSiteScanSaveLabel'),
    save: document.querySelector('#fullSiteScanSave'),
  };

  let snapshot = null;
  let selected = new Set();
  let knownResultIds = new Set();
  let dismissedResultIds = new Set();
  let pollTimer = null;
  let saving = false;
  let refreshing = false;

  function setStatus(message, type = 'info') {
    if (!elements.status) return;
    elements.status.textContent = message || '';
    elements.status.dataset.type = type;
    elements.status.hidden = !message;
  }

  function setMode(mode) {
    const selectedMode = ['quick', 'full', 'person'].includes(mode) ? mode : 'quick';

    elements.modeButtons.forEach((button) => {
      button.classList.toggle('is-active', button.dataset.webScanMode === selectedMode);
    });

    if (elements.quickSection) elements.quickSection.hidden = selectedMode !== 'quick';
    if (elements.fullSection) elements.fullSection.hidden = selectedMode !== 'full';
    if (elements.personSection) elements.personSection.hidden = selectedMode !== 'person';

    if (selectedMode === 'full') {
      const quickUrl = String(document.querySelector('#webScanUrl')?.value || '').trim();
      if (!elements.url.value && quickUrl) elements.url.value = quickUrl;
      refresh().catch(() => {});
    } else {
      stopPolling();
    }
  }

  function progressPercent(data) {
    if (!data) return 0;
    const progress = data.progress || {};
    const limit = Math.max(1, Number(data.pageLimit) || 1);
    const pages = Math.min(limit, Number(progress.pagesVisited) || 0);

    if (data.phase === 'testing' || ['completed', 'stopped'].includes(data.status)) {
      const found = Math.max(1, Number(progress.mediaFound) || 1);
      const tested = Math.min(found, Number(progress.mediaTested) || 0);
      return Math.min(100, 70 + Math.round((tested / found) * 30));
    }

    if (data.status === 'failed') return 100;
    return Math.min(70, Math.round((pages / limit) * 70));
  }

  function renderStats(data) {
    if (!elements.stats) return;
    const p = data?.progress || {};

    const items = [
      ['Sayfa', (Number(p.pagesVisited) || 0) + '/' + (Number(data?.pageLimit) || 0)],
      ['Kuyruk', Number(p.pagesQueued) || 0],
      ['Dinamik', Number(p.dynamicPages) || 0],
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

  function syncSelectedWithResults(results) {
    const currentIds = new Set(results.map((item) => item.id));

    selected = new Set([...selected].filter((id) => currentIds.has(id)));

    for (const result of results) {
      if (!knownResultIds.has(result.id)) {
        knownResultIds.add(result.id);
        selected.add(result.id);
      }
    }
  }

  function renderResults(data) {
    const results = (Array.isArray(data?.results) ? data.results : [])
      .filter((item) => !dismissedResultIds.has(item.id));
    syncSelectedWithResults(results);

    if (results.length === 0) {
      elements.results.innerHTML = isActiveStatus(data?.status)
        ? '<div class="full-site-empty">Tarama suruyor. Uygun yayinlar test asamasinda burada gorunecek.</div>'
        : '<div class="full-site-empty">Kaydedilebilir yayin bulunamadi.</div>';
      elements.saveBar.hidden = true;
      updateSaveButton();
      return;
    }

    elements.results.innerHTML = results.map((candidate) => {
      const checked = selected.has(candidate.id);
      const unknown = candidate.durationStatus === 'unknown';

      return [
        '<label class="full-site-result ' + (checked ? 'is-selected' : '') + '">',
        '<input type="checkbox" data-full-site-select="' + escapeHtml(candidate.id) + '"' + (checked ? ' checked' : '') + ' />',
        '<span>',
        '<strong>' + escapeHtml(candidate.name || 'Site Yayini') + '</strong>',
        '<small><b>' + escapeHtml(candidate.kind || 'VIDEO') + '</b> · ' + escapeHtml(formatDuration(candidate.durationSeconds)) + '</small>',
        '<em class="' + (unknown ? 'is-unknown' : 'is-ready') + '">'
          + (unknown ? 'Suresi bilinmiyor · Manuel kontrol' : '3 dakika filtresini gecti')
          + '</em>',
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
    elements.pause.hidden = !active || paused || status === 'stopping';
    elements.resume.hidden = !paused;
    elements.stop.hidden = !active || status === 'stopping';

    if (active) {
      elements.start.textContent = 'Tarama Calisiyor';
    } else {
      elements.start.textContent = 'Tum Siteyi Tara';
    }
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
      elements.results.innerHTML = '<div class="full-site-empty">Henuz Tum Site taramasi baslatilmadi.</div>';
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
    renderResults(data);
    updateControls(data);

    const statusType = data.status === 'failed'
      ? 'error'
      : (data.status === 'completed' ? 'success' : (data.status === 'paused' ? 'warning' : 'info'));

    setStatus(data.message || 'Tum Site taramasi calisiyor...', statusType);

    if (isActiveStatus(data.status)) startPolling();
    else stopPolling();
  }

  async function refresh() {
    if (refreshing) return;
    refreshing = true;

    try {
      const response = await fetch('/api/full-site-scan/status', { cache: 'no-store' });
      const data = await readJson(response, 'Tum Site tarama durumu alinamadi.');
      render(data);
    } finally {
      refreshing = false;
    }
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      refresh().catch((error) => {
        setStatus(error.message, 'error');
      });
    }, 1200);
  }

  function stopPolling() {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
  }

  async function start() {
    const url = normalizeWebAddress(elements.url.value);
    if (!url) {
      setStatus('Taranacak web sitesi adresini girin.', 'warning');
      return;
    }

    elements.url.value = url;
    selected.clear();
    knownResultIds.clear();
    dismissedResultIds.clear();
    elements.start.disabled = true;
    setStatus('Tum Site taramasi baslatiliyor...');

    try {
      const response = await fetch('/api/full-site-scan/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          url,
          limit: Number(elements.limit.value) || 50,
        }),
      });
      const data = await readJson(response, 'Tum Site taramasi baslatilamadi.');
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
      const response = await fetch('/api/full-site-scan/' + encodeURIComponent(snapshot.jobId) + '/save', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ids: [...selected],
          label: String(elements.saveLabel.value || '').trim(),
        }),
      });
      const data = await readJson(response, 'Tum Site sonuclari kaydedilemedi.');

      setStatus(String(data.saved || selected.size) + ' yayin Web Tarama klasorune kaydedildi.', 'success');
      if (typeof onSaved === 'function') await onSaved(data);
    } catch (error) {
      setStatus(error.message, 'error');
    } finally {
      saving = false;
      updateSaveButton();
    }
  }

  elements.modeButtons.forEach((button) => {
    button.addEventListener('click', () => setMode(button.dataset.webScanMode || 'quick'));
  });

  elements.start?.addEventListener('click', () => start().catch(() => {}));

  elements.url?.addEventListener('blur', () => {
    const normalized = normalizeWebAddress(elements.url.value);
    if (normalized) elements.url.value = normalized;
  });

  elements.url?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    start().catch(() => {});
  });

  elements.pause?.addEventListener('click', () => {
    action('/api/full-site-scan/pause', 'Tarama duraklatilamadi.').catch((error) => setStatus(error.message, 'error'));
  });

  elements.resume?.addEventListener('click', () => {
    action('/api/full-site-scan/resume', 'Taramaya devam edilemedi.').catch((error) => setStatus(error.message, 'error'));
  });

  elements.stop?.addEventListener('click', () => {
    action('/api/full-site-scan/stop', 'Tarama durdurulamadi.').catch((error) => setStatus(error.message, 'error'));
  });

  elements.results?.addEventListener('change', (event) => {
    const checkbox = event.target.closest('[data-full-site-select]');
    if (!checkbox) return;

    if (checkbox.checked) selected.add(checkbox.dataset.fullSiteSelect);
    else selected.delete(checkbox.dataset.fullSiteSelect);

    renderResults(snapshot);
  });

  elements.selectAll?.addEventListener('click', () => {
    selected = new Set(
      (snapshot?.results || [])
        .filter((item) => !dismissedResultIds.has(item.id))
        .map((item) => item.id)
    );
    renderResults(snapshot);
  });

  elements.clearSelection?.addEventListener('click', () => {
    selected.clear();
    renderResults(snapshot);
  });

  elements.deleteAll?.addEventListener('click', () => {
    const visibleResults = (snapshot?.results || [])
      .filter((item) => !dismissedResultIds.has(item.id));

    if (!snapshot?.jobId || visibleResults.length === 0) return;

    elements.deleteAll.disabled = true;
    setStatus('Tarama sonuclari kalici olarak siliniyor...');

    fetch('/api/full-site-scan/' + encodeURIComponent(snapshot.jobId) + '/results', {
      method: 'DELETE',
      cache: 'no-store',
    })
      .then((response) => readJson(response, 'Tum Site tarama sonuclari silinemedi.'))
      .then((data) => {
        selected.clear();
        knownResultIds.clear();
        dismissedResultIds.clear();

        if (data.cleared) {
          render(null);
        } else {
          render(data);
        }

        setStatus((Number(data.deleted) || 0) + ' tarama sonucu kalici olarak silindi.', 'success');
      })
      .catch((error) => setStatus(error.message, 'error'))
      .finally(() => {
        elements.deleteAll.disabled = false;
      });
  });

  elements.save?.addEventListener('click', () => save().catch(() => {}));

  render(null);

  return {
    refresh,
    destroy() {
      stopPolling();
    },
  };
}
