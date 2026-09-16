function formatDuration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return 'Suresi bilinmiyor';

  const total = Math.round(value);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  if (hours > 0) {
    return hours + ' sa ' + String(minutes).padStart(2, '0') + ' dk';
  }

  return minutes + ':' + String(secs).padStart(2, '0');
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

function normalizeWebAddress(value) {
  const input = String(value || '').trim();
  if (!input) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) return input;
  return 'https://' + input.replace(/^\/+/, '');
}

async function readJson(response, fallbackMessage) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || fallbackMessage);
  return data;
}

export function createWebScanController({ onSaved } = {}) {
  const elements = {
    url: document.querySelector('#webScanUrl'),
    scan: document.querySelector('#webScanButton'),
    status: document.querySelector('#webScanStatus'),
    summary: document.querySelector('#webScanSummary'),
    results: document.querySelector('#webScanResults'),
    saveBar: document.querySelector('#webScanSaveBar'),
    saveLabel: document.querySelector('#webScanSaveLabel'),
    save: document.querySelector('#webScanSaveButton'),
    selectAll: document.querySelector('#webScanSelectAll'),
    clearSelection: document.querySelector('#webScanClearSelection'),
    deleteAll: document.querySelector('#webScanDeleteAll'),
  };

  let scanId = '';
  let candidates = [];
  let selected = new Set();
  let scanning = false;
  let saving = false;

  function setStatus(message, type = 'info') {
    if (!elements.status) return;
    elements.status.textContent = message;
    elements.status.dataset.type = type;
    elements.status.hidden = !message;
  }

  function updateSaveButton() {
    if (!elements.save) return;
    elements.save.disabled = saving || scanning || selected.size === 0;
    elements.save.textContent = saving
      ? 'Kaydediliyor...'
      : ('Secilenleri Kaydet (' + selected.size + ')');
  }

  function renderSummary(summary = {}) {
    if (!elements.summary) return;

    if (!scanId) {
      elements.summary.hidden = true;
      elements.summary.innerHTML = '';
      return;
    }

    const parts = [
      ['Bulunan', Number(summary.detected) || 0],
      ['Uygun', Number(summary.accepted) || 0],
      ['3 dk alti elendi', Number(summary.shortRemoved) || 0],
      ['Acilmayan', Number(summary.failed) || 0],
      ['Suresi bilinmiyor', Number(summary.unknownDuration) || 0],
      ['Gezilen sayfa', Number(summary.pagesVisited) || 0],
      ['Detay sayfasi', Number(summary.detailPagesVisited) || 0],
      ['Iframe', Number(summary.iframeFramesSeen) || 0],
      ['XHR/JS', Number(summary.responseBodiesScanned) || 0],
    ];

    elements.summary.innerHTML = parts.map(([label, value]) => (
      '<span><strong>' + escapeHtml(value) + '</strong><small>' + escapeHtml(label) + '</small></span>'
    )).join('');
    elements.summary.hidden = false;
  }

  function renderResults() {
    if (!elements.results) return;

    if (candidates.length === 0) {
      elements.results.innerHTML = scanId
        ? '<div class="web-scan-empty">Kaydedilebilir yayin kalmadi.</div>'
        : '<div class="web-scan-empty">Site adresini girip taramayi baslatin.</div>';
      if (elements.saveBar) elements.saveBar.hidden = true;
      updateSaveButton();
      return;
    }

    elements.results.innerHTML = candidates.map((candidate) => {
      const isUnknown = candidate.durationStatus === 'unknown';
      const isSelected = selected.has(candidate.id);

      return [
        '<article class="web-scan-result ' + (isSelected ? 'is-selected' : '') + '">',
        '<label class="web-scan-result-main">',
        '<input type="checkbox" data-web-scan-select="' + escapeHtml(candidate.id) + '"' + (isSelected ? ' checked' : '') + ' />',
        '<span class="web-scan-result-copy">',
        '<strong>' + escapeHtml(candidate.name || 'Web Yayin') + '</strong>',
        '<small><b>' + escapeHtml(candidate.kind || 'VIDEO') + '</b> · ' + escapeHtml(formatDuration(candidate.durationSeconds)) + '</small>',
        isUnknown
          ? '<em class="web-scan-unknown">Suresi bilinmiyor · Manuel kontrol</em>'
          : '<em class="web-scan-ready">3 dakika filtresini gecti</em>',
        '</span>',
        '</label>',
        '<button class="web-scan-remove" type="button" data-web-scan-remove="' + escapeHtml(candidate.id) + '">Sil</button>',
        '</article>',
      ].join('');
    }).join('');

    if (elements.saveBar) elements.saveBar.hidden = false;
    updateSaveButton();
  }

  function resetScan() {
    scanId = '';
    candidates = [];
    selected = new Set();
    renderSummary();
    renderResults();
  }

  async function scan() {
    if (scanning) return;

    const url = normalizeWebAddress(elements.url?.value);
    if (!url) {
      setStatus('Taranacak web sitesi adresini girin.', 'warning');
      return;
    }

    if (elements.url) elements.url.value = url;

    scanning = true;
    resetScan();
    elements.scan.disabled = true;
    elements.scan.textContent = 'Taraniyor...';
    setStatus('Derin tarama basladi: ana sayfa, video detaylari, iframe ve ag istekleri inceleniyor...');

    try {
      const response = await fetch('/api/web-scan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const data = await readJson(response, 'Web taramasi tamamlanamadi.');

      scanId = data.scanId || '';
      candidates = Array.isArray(data.candidates) ? data.candidates : [];
      selected = new Set(candidates.map((candidate) => candidate.id));

      renderSummary(data.summary || {});
      renderResults();

      if (candidates.length > 0) {
        setStatus(
          candidates.length + ' uygun yayin bulundu. Suresi bilinmeyenleri manuel kontrol edip istemediklerinizi silin.',
          'success'
        );
      } else {
        const shortOnly = Number(data.summary?.shortRemoved) > 0
          && Number(data.summary?.detected) === Number(data.summary?.shortRemoved);

        setStatus(
          shortOnly
            ? 'Bulunan medyalarin tamami 3 dakikanin altinda oldugu icin otomatik elendi.'
            : (data.message || 'Derin tarama tamamlandi ancak kaydedilebilir yayin bulunamadi.'),
          data.summary?.protectionDetected ? 'error' : 'warning'
        );
      }
    } catch (error) {
      setStatus(error.message, 'error');
    } finally {
      scanning = false;
      elements.scan.disabled = false;
      elements.scan.textContent = 'Siteyi Tara';
      updateSaveButton();
    }
  }

  async function save() {
    if (saving || !scanId || selected.size === 0) return;

    saving = true;
    updateSaveButton();
    setStatus('Secilen yayinlar Web Tarama klasorune kaydediliyor...');

    try {
      const response = await fetch('/api/web-scan/' + encodeURIComponent(scanId) + '/save', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ids: [...selected],
          label: String(elements.saveLabel?.value || '').trim(),
        }),
      });
      const data = await readJson(response, 'Web tarama sonuclari kaydedilemedi.');

      setStatus(
        String(data.saved || selected.size) + ' yayin Web Tarama klasorune kaydedildi.',
        'success'
      );

      if (typeof onSaved === 'function') await onSaved(data);
    } catch (error) {
      setStatus(error.message, 'error');
    } finally {
      saving = false;
      updateSaveButton();
    }
  }

  elements.scan?.addEventListener('click', () => {
    scan().catch(() => {});
  });

  elements.url?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    scan().catch(() => {});
  });

  elements.url?.addEventListener('blur', () => {
    const normalized = normalizeWebAddress(elements.url.value);
    if (normalized) elements.url.value = normalized;
  });


  elements.results?.addEventListener('change', (event) => {
    const checkbox = event.target.closest('[data-web-scan-select]');
    if (!checkbox) return;

    const id = checkbox.dataset.webScanSelect;
    if (checkbox.checked) selected.add(id);
    else selected.delete(id);
    renderResults();
  });

  elements.results?.addEventListener('click', (event) => {
    const remove = event.target.closest('[data-web-scan-remove]');
    if (!remove) return;

    const id = remove.dataset.webScanRemove;
    candidates = candidates.filter((candidate) => candidate.id !== id);
    selected.delete(id);
    renderResults();
  });

  elements.selectAll?.addEventListener('click', () => {
    selected = new Set(candidates.map((candidate) => candidate.id));
    renderResults();
  });

  elements.clearSelection?.addEventListener('click', () => {
    selected.clear();
    renderResults();
  });

  elements.deleteAll?.addEventListener('click', () => {
    if (!scanId || candidates.length === 0) return;

    elements.deleteAll.disabled = true;
    setStatus('Tarama sonuclari kalici olarak siliniyor...');

    fetch('/api/web-scan/' + encodeURIComponent(scanId) + '/results', {
      method: 'DELETE',
      cache: 'no-store',
    })
      .then((response) => readJson(response, 'Tarama sonuclari silinemedi.'))
      .then((data) => {
        candidates = [];
        selected.clear();
        scanId = '';
        renderSummary();
        renderResults();
        setStatus((Number(data.deleted) || 0) + ' tarama sonucu kalici olarak silindi.', 'success');
      })
      .catch((error) => setStatus(error.message, 'error'))
      .finally(() => {
        elements.deleteAll.disabled = false;
      });
  });

  elements.save?.addEventListener('click', () => {
    save().catch(() => {});
  });

  renderResults();

  return {
    reset: resetScan,
  };
}
