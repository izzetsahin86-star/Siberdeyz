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

export function createPersonVideoScanController({ onSaved } = {}) {
  const elements = {
    name: document.querySelector('#personVideoName'),
    scan: document.querySelector('#personVideoScanButton'),
    status: document.querySelector('#personVideoScanStatus'),
    summary: document.querySelector('#personVideoScanSummary'),
    results: document.querySelector('#personVideoResults'),
    selectAll: document.querySelector('#personVideoSelectAll'),
    clearSelection: document.querySelector('#personVideoClearSelection'),
    deleteAll: document.querySelector('#personVideoDeleteAll'),
    saveBar: document.querySelector('#personVideoSaveBar'),
    saveLabel: document.querySelector('#personVideoSaveLabel'),
    save: document.querySelector('#personVideoSaveButton'),
  };

  let scanId = '';
  let pages = [];
  let media = [];
  let selected = new Set();
  let scanning = false;
  let saving = false;

  function setStatus(message, type = 'info') {
    if (!elements.status) return;
    elements.status.textContent = message || '';
    elements.status.dataset.type = type;
    elements.status.hidden = !message;
  }

  function updateSaveButton() {
    if (!elements.save) return;
    elements.save.disabled = scanning || saving || selected.size === 0;
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

    const items = [
      ['Arama sonucu', Number(summary.searchResults) || 0],
      ['Incelenen sayfa', Number(summary.pagesInspected) || 0],
      ['Medya adayi', Number(summary.mediaDetected) || 0],
      ['Oynatilabilir', Number(summary.playable) || 0],
      ['3 dk alti', Number(summary.shortRemoved) || 0],
      ['Acilmayan', Number(summary.failed) || 0],
    ];
    elements.summary.innerHTML = items.map(([label, value]) => (
      '<span><strong>' + escapeHtml(value) + '</strong><small>' + escapeHtml(label) + '</small></span>'
    )).join('');
    elements.summary.hidden = false;
  }

  function renderResults() {
    if (!elements.results) return;

    if (pages.length === 0 && media.length === 0) {
      elements.results.innerHTML = scanId
        ? '<div class="person-video-empty">Bu kisi icin sonuc bulunamadi.</div>'
        : '<div class="person-video-empty">Kisinin adini yazip video aramasini baslatin.</div>';
      elements.saveBar.hidden = true;
      updateSaveButton();
      return;
    }

    const playableHtml = media.length > 0
      ? '<div class="person-video-group-title">Dogrudan oynatilabilir yayinlar</div>' + media.map((item) => {
        const checked = selected.has(item.id);
        return [
          '<article class="person-video-result is-playable ' + (checked ? 'is-selected' : '') + '">',
          '<label class="person-video-result-main">',
          '<input type="checkbox" data-person-video-select="' + escapeHtml(item.id) + '"' + (checked ? ' checked' : '') + ' />',
          '<span><strong>' + escapeHtml(item.name || 'Kisi Videosu') + '</strong>',
          '<small><b>' + escapeHtml(item.kind || 'VIDEO') + '</b> · ' + escapeHtml(formatDuration(item.durationSeconds)) + ' · ' + escapeHtml(item.sourceHost || '') + '</small>',
          '<em>Dogrudan oynatilabilir</em></span></label>',
          '<a href="' + escapeHtml(item.pageUrl) + '" target="_blank" rel="noopener noreferrer">Kaynak</a>',
          '</article>',
        ].join('');
      }).join('')
      : '';

    const pageHtml = pages.length > 0
      ? '<div class="person-video-group-title">Internette bulunan video sayfalari</div>' + pages.map((item) => [
        '<article class="person-video-result">',
        '<span class="person-video-result-copy"><strong>' + escapeHtml(item.title || 'Video sonucu') + '</strong>',
        '<small>' + escapeHtml(item.sourceHost || '') + '</small>',
        item.description ? '<em>' + escapeHtml(item.description) + '</em>' : '',
        '</span><a href="' + escapeHtml(item.pageUrl) + '" target="_blank" rel="noopener noreferrer">Kaynagi Ac</a>',
        '</article>',
      ].join('')).join('')
      : '';

    elements.results.innerHTML = playableHtml + pageHtml;
    elements.saveBar.hidden = media.length === 0;
    updateSaveButton();
  }

  function reset() {
    scanId = '';
    pages = [];
    media = [];
    selected.clear();
    renderSummary();
    renderResults();
  }

  async function scan() {
    if (scanning) return;
    const name = String(elements.name?.value || '').trim();
    if (name.length < 2) {
      setStatus('Aranacak kisinin adini yazin.', 'warning');
      return;
    }

    scanning = true;
    reset();
    elements.scan.disabled = true;
    elements.scan.textContent = 'Araniyor...';
    setStatus('Internet genelinde video ve yayin sayfalari araniyor...');

    try {
      const response = await fetch('/api/person-video-scan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await readJson(response, 'Kisi video aramasi tamamlanamadi.');
      scanId = data.scanId || '';
      pages = Array.isArray(data.pages) ? data.pages : [];
      media = Array.isArray(data.media) ? data.media : [];
      selected = new Set(media.map((item) => item.id));
      renderSummary(data.summary || {});
      renderResults();
      setStatus(data.message || 'Arama tamamlandi.', media.length > 0 ? 'success' : (pages.length > 0 ? 'warning' : 'error'));
    } catch (error) {
      setStatus(error.message, 'error');
    } finally {
      scanning = false;
      elements.scan.disabled = false;
      elements.scan.textContent = 'Videolari Ara';
      updateSaveButton();
    }
  }

  async function save() {
    if (saving || !scanId || selected.size === 0) return;
    saving = true;
    updateSaveButton();
    setStatus('Secilen yayinlar Web Tarama klasorune kaydediliyor...');

    try {
      const response = await fetch('/api/person-video-scan/' + encodeURIComponent(scanId) + '/save', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ids: [...selected],
          label: String(elements.saveLabel?.value || '').trim(),
        }),
      });
      const data = await readJson(response, 'Kisi videolari kaydedilemedi.');
      setStatus(String(data.saved || selected.size) + ' yayin Web Tarama klasorune kaydedildi.', 'success');
      if (typeof onSaved === 'function') await onSaved(data);
    } catch (error) {
      setStatus(error.message, 'error');
    } finally {
      saving = false;
      updateSaveButton();
    }
  }

  elements.scan?.addEventListener('click', () => scan().catch(() => {}));
  elements.name?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    scan().catch(() => {});
  });
  elements.results?.addEventListener('change', (event) => {
    const checkbox = event.target.closest('[data-person-video-select]');
    if (!checkbox) return;
    if (checkbox.checked) selected.add(checkbox.dataset.personVideoSelect);
    else selected.delete(checkbox.dataset.personVideoSelect);
    renderResults();
  });
  elements.selectAll?.addEventListener('click', () => {
    selected = new Set(media.map((item) => item.id));
    renderResults();
  });
  elements.clearSelection?.addEventListener('click', () => {
    selected.clear();
    renderResults();
  });
  elements.deleteAll?.addEventListener('click', () => {
    if (!scanId) return;
    elements.deleteAll.disabled = true;
    fetch('/api/person-video-scan/' + encodeURIComponent(scanId) + '/results', {
      method: 'DELETE',
      cache: 'no-store',
    })
      .then((response) => readJson(response, 'Kisi video sonuclari silinemedi.'))
      .then((data) => {
        reset();
        setStatus((Number(data.deleted) || 0) + ' sonuc silindi.', 'success');
      })
      .catch((error) => setStatus(error.message, 'error'))
      .finally(() => {
        elements.deleteAll.disabled = false;
      });
  });
  elements.save?.addEventListener('click', () => save().catch(() => {}));

  renderResults();
  return { reset };
}
