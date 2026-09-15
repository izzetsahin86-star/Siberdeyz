const PAGE_SIZE = 100;

const state = {
  channels: [],
  groups: ['Tumu'],
  group: 'Tumu',
  type: 'all',
  favoritesOnly: false,
  categoryOpen: false,
  search: '',
  total: 0,
  allTotal: 0,
  hasMore: false,
  loading: false,
  started: false,
  adminPassword: '',
  soundEnabled: false,
  sources: [],
  activeSourceId: '',
  currentChannelId: '',
  activePanel: '',
  accountSearch: '',
  accountStatus: 'all',
  accountHealth: {},
  accountScanningIds: new Set(),
  accountScanningAll: false,
};

let searchTimer;
let playbackFallbackHandler = null;

function applyStandaloneClass() {
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  document.documentElement.classList.toggle('is-standalone', isStandalone);
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch(() => {});
  });
}

function applyLaunchPanelPreference() {
  const panel = new URLSearchParams(window.location.search).get('panel');
  if (['channels', 'accounts', 'settings'].includes(panel)) switchPanel(panel);
}

const elements = {
  loginScreen: document.querySelector('#loginScreen'),
  loginForm: document.querySelector('#loginForm'),
  loginStatus: document.querySelector('#loginStatus'),
  loginButton: document.querySelector('#loginButton'),
  appShell: document.querySelector('#appShell'),
  bottomPanel: document.querySelector('#bottomPanel'),
  panelTitle: document.querySelector('#panelTitle'),
  closePanelButton: document.querySelector('#closePanelButton'),
  channelsView: document.querySelector('#channelsView'),
  accountsView: document.querySelector('#accountsView'),
  settingsView: document.querySelector('#settingsView'),
  groupChips: document.querySelector('#groupChips'),
  categoryToggle: document.querySelector('#categoryToggle'),
  currentGroupLabel: document.querySelector('#currentGroupLabel'),
  controlButtons: document.querySelectorAll('.control-button'),
  player: document.querySelector('#player'),
  simpleTimeline: document.querySelector('#simpleTimeline'),
  simpleCurrentTime: document.querySelector('#simpleCurrentTime'),
  simpleSeekSlider: document.querySelector('#simpleSeekSlider'),
  simpleDurationTime: document.querySelector('#simpleDurationTime'),
  currentChannel: document.querySelector('#currentChannel'),
  adminPasswordInput: document.querySelector('#adminPasswordInput'),
  sourceNameInput: document.querySelector('#sourceNameInput'),
  sourceInput: document.querySelector('#sourceInput'),
  sourceFileInput: document.querySelector('#sourceFileInput'),
  sourceUrlForm: document.querySelector('#sourceUrlForm'),
  toggleUrlFormButton: document.querySelector('#toggleUrlFormButton'),
  sourceStatus: document.querySelector('#sourceStatus'),
  sourceList: document.querySelector('#sourceList'),
  accountCount: document.querySelector('#accountCount'),
  accountSearchInput: document.querySelector('#accountSearchInput'),
  accountStatusFilter: document.querySelector('#accountStatusFilter'),
  accountScanSummary: document.querySelector('#accountScanSummary'),
  accountRenderHint: document.querySelector('#accountRenderHint'),
  scanAllAccountsButton: document.querySelector('#scanAllAccountsButton'),
  deleteAllSourcesButton: document.querySelector('#deleteAllSourcesButton'),
  saveSourceButton: document.querySelector('#saveSourceButton'),
  soundToggleInput: document.querySelector('#soundToggleInput'),
  soundStatus: document.querySelector('#soundStatus'),
  searchInput: document.querySelector('#searchInput'),
  channelCategorySelect: document.querySelector('#channelCategorySelect'),
  status: document.querySelector('#status'),
  channelList: document.querySelector('#channelList'),
  loadMoreButton: document.querySelector('#loadMoreButton'),
};

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  }[char]));
}

function setTextStatus(element, message, type = 'info') {
  if (!element) return;
  element.textContent = message;
  element.dataset.type = type;
  element.hidden = !message;
}

function setStatus(message, type = 'info') {
  setTextStatus(elements.status, message, type);
}

function setSourceStatus(message, type = 'info') {
  setTextStatus(elements.sourceStatus, message, type);
}

function setLoginStatus(message, type = 'info') {
  setTextStatus(elements.loginStatus, message, type);
}

function getAdminPassword() {
  return state.adminPassword;
}

function setLoading(isLoading) {
  state.loading = isLoading;
  elements.loadMoreButton.disabled = isLoading;
}

function applySoundSetting() {
  elements.player.muted = !state.soundEnabled;
  elements.soundToggleInput.checked = state.soundEnabled;
  elements.soundStatus.textContent = state.soundEnabled
    ? 'Ses acik. Uygulama kapaninca tekrar sessiz baslar.'
    : 'Video her acilista sessiz baslar.';
}

function formatSimpleTime(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';

  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainingSeconds = total % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
  }

  return `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
}

function updateSimpleTimeline() {
  const duration = Number(elements.player.duration);
  const isSeekable = Number.isFinite(duration) && duration > 0;

  elements.simpleTimeline.hidden = !isSeekable;

  if (!isSeekable) {
    elements.simpleSeekSlider.value = '0';
    elements.simpleCurrentTime.textContent = '00:00';
    elements.simpleDurationTime.textContent = '--:--';
    elements.simpleSeekSlider.style.setProperty('--seek-progress', '0%');
    return;
  }

  const currentTime = Math.min(Math.max(Number(elements.player.currentTime) || 0, 0), duration);
  const progress = Math.min(1000, Math.max(0, Math.round((currentTime / duration) * 1000)));

  elements.simpleCurrentTime.textContent = formatSimpleTime(currentTime);
  elements.simpleDurationTime.textContent = formatSimpleTime(duration);
  elements.simpleSeekSlider.value = String(progress);
  elements.simpleSeekSlider.style.setProperty('--seek-progress', `${progress / 10}%`);
}

function clearChannelState() {
  state.channels = [];
  state.groups = ['Tumu'];
  state.group = 'Tumu';
  state.total = 0;
  state.allTotal = 0;
  state.hasMore = false;
  renderGroups();
  renderChannels();
}

function clearPlaybackFallback() {
  if (!playbackFallbackHandler) return;
  elements.player.removeEventListener('error', playbackFallbackHandler);
  playbackFallbackHandler = null;
}

function getDirectPlaybackUrl(channel) {
  try {
    const parsed = new URL(String(channel?.url || ''), window.location.href);
    const extensionMatch = parsed.pathname.toLocaleLowerCase('tr-TR').match(/\.([a-z0-9]+)$/i);
    const extension = extensionMatch ? extensionMatch[1] : '';
    const browserNative = ['m3u8', 'mp4', 'mov', 'm4v', '3gp', '3g2'].includes(extension);
    const transportSafe = window.location.protocol !== 'https:' || parsed.protocol === 'https:';

    return browserNative && transportSafe ? parsed.toString() : '';
  } catch {
    return '';
  }
}

function setPlaybackSource(channel) {
  clearPlaybackFallback();

  const fallbackUrl = `/api/play/${channel.id}`;
  const directUrl = getDirectPlaybackUrl(channel);

  if (!directUrl) {
    elements.player.src = fallbackUrl;
    return;
  }

  playbackFallbackHandler = () => {
    if (state.currentChannelId !== channel.id) return;

    clearPlaybackFallback();
    elements.player.pause();
    elements.player.src = fallbackUrl;
    elements.player.load();
    elements.player.play().catch(() => {
      setStatus('Yayin uyumluluk motoruyla acilmaya hazirlaniyor.', 'warning');
    });
  };

  elements.player.addEventListener('error', playbackFallbackHandler, { once: true });
  elements.player.src = directUrl;
}

function stopPlayback({ message = 'Yayin kapatildi.', resetSound = false } = {}) {
  clearPlaybackFallback();
  elements.player.pause();
  elements.player.removeAttribute('src');
  elements.player.load();
  elements.currentChannel.textContent = 'Henuz secilmedi';
  state.currentChannelId = '';
  updateSimpleTimeline();
  if (resetSound) {
    state.soundEnabled = false;
    applySoundSetting();
  }
  setPanelCompact(false);
  if (message) setStatus(message);
}

function resetPlayer() {
  stopPlayback({ message: '', resetSound: true });
}

function showApp() {
  elements.loginScreen.hidden = true;
  elements.appShell.hidden = false;
  applySoundSetting();
  applyLaunchPanelPreference();

  if (!state.started) {
    state.started = true;
    loadSourceStatus()
      .then(() => loadAccountHealth())
      .catch((error) => setSourceStatus(error.message, 'error'));
    loadChannels({ reset: true }).catch((error) => {
      setLoading(false);
      setStatus(error.message, 'error');
    });
  }
}

function closePanel() {
  state.activePanel = '';
  elements.bottomPanel.dataset.open = 'none';
  elements.bottomPanel.dataset.compact = 'false';
  elements.bottomPanel.setAttribute('aria-hidden', 'true');

  elements.controlButtons.forEach((button) => {
    if (button.dataset.panel) button.classList.remove('is-active');
  });
}

function setPanelCompact(isCompact) {
  elements.bottomPanel.dataset.compact = isCompact ? 'true' : 'false';
  if (isCompact) closePanel();
}

function switchPanel(panelName) {
  const panels = {
    channels: elements.channelsView,
    accounts: elements.accountsView,
    settings: elements.settingsView,
  };

  const titles = {
    channels: 'Kanallar',
    accounts: 'Hesaplar',
    settings: 'Ayarlar',
  };

  if (!panels[panelName]) return;

  Object.entries(panels).forEach(([name, panel]) => {
    panel.hidden = name !== panelName;
  });

  state.activePanel = panelName;
  elements.panelTitle.textContent = titles[panelName] || 'Panel';
  elements.bottomPanel.dataset.open = panelName;
  elements.bottomPanel.dataset.compact = 'false';
  elements.bottomPanel.setAttribute('aria-hidden', 'false');

  elements.controlButtons.forEach((button) => {
    button.classList.toggle('is-active', button.dataset.panel === panelName);
  });
}

async function login(adminPassword) {
  elements.loginButton.disabled = true;
  setLoginStatus('Sifre kontrol ediliyor...');

  const response = await fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ adminPassword }),
  });
  const data = await response.json();
  elements.loginButton.disabled = false;

  if (!response.ok) {
    throw new Error(data.error || 'Giris yapilamadi');
  }

  state.adminPassword = adminPassword;
  elements.adminPasswordInput.value = '';
  setLoginStatus('');
  showApp();
}

function renderGroups() {
  const groups = state.groups.length ? state.groups : ['Tumu'];
  const currentGroup = groups.includes(state.group) ? state.group : 'Tumu';

  state.group = currentGroup;
  elements.currentGroupLabel.textContent = currentGroup;
  elements.categoryToggle.setAttribute('aria-expanded', state.categoryOpen ? 'true' : 'false');
  elements.categoryToggle.classList.toggle('is-open', state.categoryOpen);
  elements.groupChips.hidden = !state.categoryOpen;

  elements.groupChips.innerHTML = groups.map((group) => `
    <button class="group-chip ${group === currentGroup ? 'is-active' : ''}" type="button" data-group-value="${escapeHtml(group)}">
      ${escapeHtml(group)}
    </button>
  `).join('');

  elements.channelCategorySelect.innerHTML = groups.map((group) => `
    <option value="${escapeHtml(group)}"${group === currentGroup ? ' selected' : ''}>${escapeHtml(group)}</option>
  `).join('');
}

function renderLoadMore() {
  elements.loadMoreButton.hidden = !state.hasMore || state.channels.length === 0;
  elements.loadMoreButton.textContent = `Daha fazla goster (${state.channels.length}/${state.total})`;
}

function typeLabel(type) {
  return ({ live: 'Canli TV', movie: 'Film', series: 'Dizi' }[type] || 'Yayin');
}

function renderChannels() {
  if (state.channels.length === 0) {
    elements.channelList.innerHTML = '<div class="empty">Kanal bulunamadi.</div>';
    renderLoadMore();
    return;
  }

  elements.channelList.innerHTML = state.channels.map((channel) => `
    <article class="channel-card">
      <button class="favorite-button ${channel.favorite ? 'is-active' : ''}" type="button" data-favorite-id="${escapeHtml(channel.id)}" aria-label="Favori">
        ${channel.favorite ? '★' : '☆'}
      </button>
      <button class="channel" type="button" data-id="${escapeHtml(channel.id)}">
        <span class="channel-logo">${channel.logo ? `<img src="${escapeHtml(channel.logo)}" alt="" loading="lazy" />` : escapeHtml(channel.name.slice(0, 1))}</span>
        <span class="channel-copy">
          <strong>${escapeHtml(channel.name)}</strong>
          <small><span>${escapeHtml(typeLabel(channel.type))}</span><span>${escapeHtml(channel.group)}</span></small>
        </span>
      </button>
    </article>
  `).join('');
  renderLoadMore();
}

function accountHealthStatus(source) {
  if (source.type === 'file') return 'unsupported';
  return state.accountHealth[source.id]?.status || 'unscanned';
}

function accountStatusLabel(status) {
  return ({
    active: 'Aktif',
    expired: 'Suresi bitmis',
    failed: 'Calismiyor',
    unsupported: 'Dosya',
    unscanned: 'Taranmamis',
  }[status] || 'Taranmamis');
}

function accountConnectionLabel(health) {
  if (!health || health.protocol !== 'xtream') return '';

  const active = Number(health.activeConnections) || 0;
  const max = Number(health.maxConnections) || 0;
  return (max > 0 ? max : '∞') + '/' + active;
}

function accountExpiryLabel(health) {
  if (!health?.expiresAt) return '';

  const timestamp = Date.parse(health.expiresAt);
  if (!Number.isFinite(timestamp)) return '';

  return new Intl.DateTimeFormat('tr-TR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(new Date(timestamp));
}

function updateAccountScanSummary() {
  const counts = {
    active: 0,
    expired: 0,
    failed: 0,
    unscanned: 0,
  };

  for (const source of state.sources) {
    if (source.type === 'file') continue;
    const status = accountHealthStatus(source);
    if (status in counts) counts[status] += 1;
  }

  for (const [status, count] of Object.entries(counts)) {
    const element = elements.accountScanSummary?.querySelector('[data-account-stat="' + status + '"]');
    if (!element) continue;

    const label = ({
      active: 'Aktif',
      expired: 'Suresi biten',
      failed: 'Calismayan',
      unscanned: 'Taranmamis',
    }[status]);

    element.textContent = label + ' ' + count;
    element.dataset.count = String(count);
  }
}

function updateAccountsSummary() {
  const count = state.sources.length;
  elements.accountCount.textContent = String(count);
  elements.deleteAllSourcesButton.hidden = count === 0;
  elements.scanAllAccountsButton.hidden = !state.sources.some((source) => source.type === 'url');
  elements.scanAllAccountsButton.disabled = state.accountScanningAll;
  elements.scanAllAccountsButton.textContent = state.accountScanningAll ? 'Taraniyor...' : 'Hesaplari Tara';
  updateAccountScanSummary();
}

function getFilteredSources() {
  const search = state.accountSearch.trim().toLocaleLowerCase('tr-TR');
  const statusFilter = state.accountStatus;

  return state.sources.filter((source) => {
    const status = accountHealthStatus(source);
    const statusMatches = statusFilter === 'all'
      || (statusFilter === 'unscanned' && (status === 'unscanned' || status === 'unsupported'))
      || status === statusFilter;

    if (!statusMatches) return false;
    if (!search) return true;

    const haystack = [
      source.label,
      source.url,
      source.fileName,
      accountStatusLabel(status),
    ]
      .filter(Boolean)
      .join(' ')
      .toLocaleLowerCase('tr-TR');

    return haystack.includes(search);
  });
}

function renderSources() {
  updateAccountsSummary();

  if (state.sources.length === 0) {
    elements.sourceList.innerHTML = '<div class="empty compact-empty">Kayitli hesap yok. Dosya veya URL ekleyin.</div>';
    elements.accountRenderHint.hidden = true;
    return;
  }

  const filtered = getFilteredSources();
  const visible = filtered.slice(0, 200);

  if (visible.length === 0) {
    elements.sourceList.innerHTML = '<div class="empty compact-empty">Aramaya uygun hesap bulunamadi.</div>';
  } else {
    elements.sourceList.innerHTML = visible.map((source, index) => {
      const sourceIndex = state.sources.indexOf(source);
      const isFile = source.type === 'file';
      const health = state.accountHealth[source.id];
      const healthStatus = accountHealthStatus(source);
      const scanning = state.accountScanningIds.has(source.id);
      const title = source.label || 'Hesap ' + (sourceIndex + 1);
      const connection = accountConnectionLabel(health);
      const expiry = accountExpiryLabel(health);
      const statusLabel = accountStatusLabel(healthStatus);
      const metaParts = [];

      if (isFile) {
        metaParts.push((source.channelCount || 0) + ' yayin');
      } else {
        if (connection) metaParts.push('Baglanti ' + connection);
        if (expiry) metaParts.push('Bitis ' + expiry);
        if (health?.checkedAt) metaParts.push('Tarandi');
        if (metaParts.length === 0) metaParts.push('Liste URL');
      }

      const showManualScan = !isFile && healthStatus !== 'active';

      return [
        '<article class="source-pill-item ' + (source.active ? 'is-active ' : '') + 'health-' + escapeHtml(healthStatus) + '">',
        '<button class="source-pill-select" type="button" data-source-active="' + escapeHtml(source.id) + '">',
        '<span class="source-health-badge" data-health="' + escapeHtml(healthStatus) + '">' + escapeHtml(statusLabel) + '</span>',
        '<span class="source-pill-copy">',
        '<strong>' + escapeHtml(title) + '</strong>',
        '<small>' + escapeHtml(metaParts.join(' · ')) + '</small>',
        '</span>',
        '</button>',
        '<div class="source-pill-actions">',
        showManualScan
          ? '<button class="source-pill-scan" type="button" data-account-scan="' + escapeHtml(source.id) + '"' + (scanning ? ' disabled' : '') + '>' + (scanning ? '...' : 'Tara') + '</button>'
          : '',
        '<button class="source-pill-delete" type="button" data-source-delete="' + escapeHtml(source.id) + '" aria-label="Hesabi sil">Sil</button>',
        '</div>',
        '</article>',
      ].join('');
    }).join('');
  }

  const hiddenCount = Math.max(0, filtered.length - visible.length);
  elements.accountRenderHint.hidden = hiddenCount === 0;
  elements.accountRenderHint.textContent = hiddenCount > 0
    ? filtered.length + ' sonuc bulundu. Performans icin ilk 200 hesap gosteriliyor; aramayi daraltin.'
    : '';
}

function setSourceState(data) {
  state.sources = data.sources || [];
  state.activeSourceId = data.activeSourceId || state.sources.find((source) => source.active)?.id || '';

  const validIds = new Set(state.sources.map((source) => source.id));
  state.accountHealth = Object.fromEntries(
    Object.entries(state.accountHealth).filter(([id]) => validIds.has(id))
  );

  renderSources();

  if (data.hasSource) {
    setSourceStatus(`${state.sources.length} hesap kayitli.`);
  } else {
    setSourceStatus('Hesap yok. Yayin URL yukleyin.', 'warning');
  }
}

function buildChannelUrl({ force = false, offset = 0 } = {}) {
  const params = new URLSearchParams({
    limit: String(PAGE_SIZE),
    offset: String(offset),
    group: state.group,
    type: state.type,
    favorites: state.favoritesOnly ? '1' : '0',
    q: state.search,
  });

  if (force) params.set('refresh', '1');
  return `/api/channels?${params.toString()}`;
}

async function loadSourceStatus() {
  const response = await fetch('/api/source');
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Yayin kaynagi okunamadi');
  }

  setSourceState(data);
}

async function loadAccountHealth() {
  const response = await fetch('/api/account-health');
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Hesap tarama bilgileri okunamadi');
  }

  state.accountHealth = data.accounts || {};
  renderSources();
}

async function scanSingleAccount(sourceId) {
  const adminPassword = getAdminPassword();
  state.accountScanningIds.add(sourceId);
  renderSources();

  try {
    const response = await fetch('/api/account-health/' + encodeURIComponent(sourceId) + '/scan', {
      method: 'POST',
      headers: { 'x-admin-password': adminPassword },
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Hesap taranamadi');
    }

    state.accountHealth[data.id] = data.health;
    renderSources();
    setSourceStatus('Hesap taramasi tamamlandi.');
  } finally {
    state.accountScanningIds.delete(sourceId);
    renderSources();
  }
}

async function scanAllAccounts() {
  if (state.accountScanningAll) return;

  const ids = state.sources
    .filter((source) => source.type === 'url')
    .map((source) => source.id);

  if (ids.length === 0) return;

  state.accountScanningAll = true;
  updateAccountsSummary();
  const adminPassword = getAdminPassword();

  try {
    for (let offset = 0; offset < ids.length; offset += 100) {
      const batch = ids.slice(offset, offset + 100);
      batch.forEach((id) => state.accountScanningIds.add(id));
      renderSources();

      setSourceStatus(
        'Hesaplar taraniyor... ' + Math.min(offset + batch.length, ids.length) + '/' + ids.length
      );

      const response = await fetch('/api/account-health/scan', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-admin-password': adminPassword,
        },
        body: JSON.stringify({ ids: batch }),
      });
      const data = await response.json();

      batch.forEach((id) => state.accountScanningIds.delete(id));

      if (!response.ok) {
        throw new Error(data.error || 'Hesap taramasi tamamlanamadi');
      }

      for (const result of data.results || []) {
        state.accountHealth[result.id] = result.health;
      }

      renderSources();
    }

    setSourceStatus(ids.length + ' hesap tarandi.');
  } finally {
    state.accountScanningAll = false;
    state.accountScanningIds.clear();
    renderSources();
  }
}

async function saveSource() {
  const url = elements.sourceInput.value.trim();
  const label = elements.sourceNameInput.value.trim();
  const adminPassword = getAdminPassword();

  if (!url) {
    setSourceStatus('Once yayin URL girin.', 'warning');
    return;
  }

  elements.saveSourceButton.disabled = true;
  setSourceStatus('Hesap kaydediliyor...');

  const response = await fetch('/api/source', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-admin-password': adminPassword,
    },
    body: JSON.stringify({ url, label }),
  });
  const data = await response.json();

  elements.saveSourceButton.disabled = false;

  if (!response.ok) {
    throw new Error(data.error || 'Yayin kaydedilemedi');
  }

  elements.sourceInput.value = '';
  elements.sourceNameInput.value = '';
  elements.sourceUrlForm.hidden = true;
  elements.toggleUrlFormButton.classList.remove('is-active');
  setSourceState(data);
  switchPanel('channels');
  stopPlayback({ message: '', resetSound: false });
  await loadChannels({ force: true, reset: true });
}

async function uploadSourceFiles() {
  const files = Array.from(elements.sourceFileInput.files || []);

  if (files.length === 0) return;

  const adminPassword = getAdminPassword();
  const manualLabel = files.length === 1 ? elements.sourceNameInput.value.trim() : '';
  let importedTotal = 0;

  elements.sourceFileInput.disabled = true;
  elements.saveSourceButton.disabled = true;

  try {
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];

      if (file.size > 45 * 1024 * 1024) {
        throw new Error(file.name + ' cok buyuk. Dosyayi daha kucuk parcalara ayirin.');
      }

      setSourceStatus(file.name + ' yukleniyor... (' + (index + 1) + '/' + files.length + ')');
      const content = await file.text();

      const response = await fetch('/api/source/file', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-admin-password': adminPassword,
        },
        body: JSON.stringify({
          fileName: file.name,
          label: manualLabel,
          content,
        }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || file.name + ' yuklenemedi');
      }

      importedTotal += data.imported || 0;
      setSourceState(data);
    }

    elements.sourceNameInput.value = '';
    setSourceStatus(files.length + ' dosya kaydedildi, ' + importedTotal + ' kayit eklendi.');
    switchPanel('channels');
    stopPlayback({ message: '', resetSound: false });
    await loadChannels({ force: true, reset: true });
  } finally {
    elements.sourceFileInput.value = '';
    elements.sourceFileInput.disabled = false;
    elements.saveSourceButton.disabled = false;
  }
}

async function deleteSource(sourceId) {
  const adminPassword = getAdminPassword();
  setSourceStatus('Hesap siliniyor...');

  const response = await fetch(`/api/source/${encodeURIComponent(sourceId)}`, {
    method: 'DELETE',
    headers: { 'x-admin-password': adminPassword },
  });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Yayin silinemedi');
  }

  setSourceState(data);
  stopPlayback({ message: 'Hesap silindi.', resetSound: false });

  if (!data.hasSource) {
    clearChannelState();
    setStatus('Hesap yok. Hesaplardan yayin URL yukleyin.', 'warning');
    return;
  }

  await loadChannels({ force: true, reset: true });
}

async function deleteAllSources() {
  if (state.sources.length === 0) return;

  const total = state.sources.length;
  const approved = window.confirm(total + ' hesabi ve iclerindeki tum yayinlari silmek istiyor musunuz? Bu islem geri alinamaz.');
  if (!approved) return;

  const adminPassword = getAdminPassword();
  elements.deleteAllSourcesButton.disabled = true;
  elements.sourceFileInput.disabled = true;
  elements.toggleUrlFormButton.disabled = true;
  setSourceStatus(total + ' hesap siliniyor...');

  try {
    const response = await fetch('/api/source', {
      method: 'DELETE',
      headers: { 'x-admin-password': adminPassword },
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Hesaplar silinemedi');
    }

    setSourceState(data);
    stopPlayback({ message: 'Tum hesaplar silindi.', resetSound: false });
    clearChannelState();
    setStatus('Hesap yok. Hesaplardan yeni yayin ekleyin.', 'warning');
    setSourceStatus('Tum hesaplar silindi.');
  } finally {
    elements.deleteAllSourcesButton.disabled = false;
    elements.sourceFileInput.disabled = false;
    elements.toggleUrlFormButton.disabled = false;
  }
}

async function activateSource(sourceId) {
  const isAlreadyActive = sourceId === state.activeSourceId;

  if (!isAlreadyActive) {
    const adminPassword = getAdminPassword();
    setSourceStatus('Hesap aciliyor...');

    const response = await fetch(`/api/source/${encodeURIComponent(sourceId)}/active`, {
      method: 'PUT',
      headers: { 'x-admin-password': adminPassword },
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Hesap acilamadi');
    }

    setSourceState(data);
    stopPlayback({ message: '', resetSound: false });
  }

  state.group = 'Tumu';
  state.type = 'all';
  state.favoritesOnly = false;
  state.search = '';
  state.channels = [];
  state.hasMore = false;
  elements.searchInput.value = '';

  renderGroups();
  renderChannels();
  switchPanel('channels');

  setSourceStatus('Hesap acildi. Kanallar yukleniyor...');
  await loadChannels({ force: !isAlreadyActive, reset: true });
  setSourceStatus('Hesap aktif. Kanallar yuklendi.');
}

async function toggleFavorite(channelId) {
  const channel = state.channels.find((item) => item.id === channelId);
  if (!channel) return;

  const response = await fetch(`/api/favorites/${channelId}`, {
    method: channel.favorite ? 'DELETE' : 'POST',
  });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Favori guncellenemedi');
  }

  const favoriteIds = data.ids || [];
  state.channels = state.channels.map((item) => ({ ...item, favorite: favoriteIds.includes(item.id) }));
  renderChannels();
}

async function loadChannels({ force = false, reset = false } = {}) {
  if (state.loading) return;

  const offset = reset ? 0 : state.channels.length;
  const waitingText = offset === 0
    ? 'Liste cekiliyor... Buyuk listelerde ilk sonuc 10-20 saniye surebilir.'
    : 'Daha fazla kanal yukleniyor...';

  setLoading(true);
  setStatus(waitingText);

  const response = await fetch(buildChannelUrl({ force, offset }));
  const data = await response.json();
  setLoading(false);

  if (!response.ok) {
    throw new Error(data.error || 'Yayin listesi alinamadi');
  }

  if (!data.sourceReady) {
    clearChannelState();
    setStatus('Hesap yok. Hesaplardan yayin URL yukleyin.', 'warning');
    return;
  }

  state.channels = reset ? data.channels : [...state.channels, ...data.channels];
  state.groups = data.groups || ['Tumu'];
  state.total = data.total || 0;
  state.allTotal = data.allTotal || state.total;
  state.hasMore = Boolean(data.hasMore);

  renderGroups();
  renderChannels();

  const filterText = state.total === state.allTotal ? '' : `, filtre sonucu ${state.total}`;
  setStatus(`${state.channels.length}/${state.total} gosteriliyor. Toplam ${state.allTotal} yayin${filterText}.`);
}

async function playChannel(channelId) {
  const channel = state.channels.find((item) => item.id === channelId);
  if (!channel) return;

  state.currentChannelId = channel.id;
  elements.currentChannel.textContent = channel.name;
  elements.player.muted = !state.soundEnabled;
  setPlaybackSource(channel);
  updateSimpleTimeline();
  elements.player.play().catch(() => {
    setStatus('Kanal secildi. Oynat tusuna basin.', 'warning');
  });
  setPanelCompact(true);
}

async function playNextChannel() {
  if (state.channels.length === 0) {
    await loadChannels({ reset: true });
  }

  if (state.channels.length === 0) {
    setStatus('Sonraki yayin icin kanal yok.', 'warning');
    return;
  }

  let nextIndex = 0;
  const currentIndex = state.channels.findIndex((channel) => channel.id === state.currentChannelId);
  if (currentIndex >= 0) nextIndex = currentIndex + 1;

  if (nextIndex >= state.channels.length && state.hasMore) {
    await loadChannels();
  }

  if (nextIndex >= state.channels.length) nextIndex = 0;
  const next = state.channels[nextIndex];

  if (next) await playChannel(next.id);
}

function reloadFilteredChannels() {
  state.channels = [];
  state.hasMore = false;
  setPanelCompact(false);
  renderGroups();
  renderChannels();
  loadChannels({ reset: true }).catch((error) => {
    setLoading(false);
    setStatus(error.message, 'error');
  });
}

elements.loginForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const adminPassword = elements.adminPasswordInput.value.trim();

  if (!adminPassword) {
    setLoginStatus('Sifre girin.', 'warning');
    return;
  }

  login(adminPassword).catch((error) => setLoginStatus(error.message, 'error'));
});

elements.categoryToggle.addEventListener('click', () => {
  state.categoryOpen = !state.categoryOpen;
  renderGroups();
});

elements.groupChips.addEventListener('click', (event) => {
  const button = event.target.closest('[data-group-value]');
  if (!button) return;

  state.group = button.dataset.groupValue;
  state.categoryOpen = false;
  reloadFilteredChannels();
});

elements.closePanelButton.addEventListener('click', closePanel);

elements.controlButtons.forEach((button) => {
  button.addEventListener('click', () => {
    if (button.dataset.panel) {
      if (state.activePanel === button.dataset.panel && elements.bottomPanel.dataset.open !== 'none') {
        closePanel();
      } else {
        switchPanel(button.dataset.panel);
      }
      return;
    }

    if (button.dataset.action === 'stop') stopPlayback();
    if (button.dataset.action === 'next') playNextChannel().catch((error) => setStatus(error.message, 'error'));
    if (button.dataset.action === 'reload') window.location.reload();
  });
});

elements.channelList.addEventListener('click', (event) => {
  const favoriteButton = event.target.closest('[data-favorite-id]');
  if (favoriteButton) {
    toggleFavorite(favoriteButton.dataset.favoriteId).catch((error) => setStatus(error.message, 'error'));
    return;
  }

  const button = event.target.closest('.channel');
  if (button) playChannel(button.dataset.id);
});

elements.deleteAllSourcesButton.addEventListener('click', () => {
  deleteAllSources().catch((error) => setSourceStatus(error.message, 'error'));
});

elements.sourceList.addEventListener('click', (event) => {
  const scanButton = event.target.closest('[data-account-scan]');
  if (scanButton) {
    scanSingleAccount(scanButton.dataset.accountScan)
      .catch((error) => setSourceStatus(error.message, 'error'));
    return;
  }

  const deleteButton = event.target.closest('[data-source-delete]');
  if (deleteButton) {
    deleteSource(deleteButton.dataset.sourceDelete).catch((error) => setSourceStatus(error.message, 'error'));
    return;
  }

  const activeButton = event.target.closest('[data-source-active]');
  if (activeButton) {
    activateSource(activeButton.dataset.sourceActive).catch((error) => setSourceStatus(error.message, 'error'));
  }
});

elements.searchInput.addEventListener('input', (event) => {
  state.search = event.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(reloadFilteredChannels, 250);
});

elements.channelCategorySelect.addEventListener('change', (event) => {
  state.group = event.target.value || 'Tumu';
  state.categoryOpen = false;
  reloadFilteredChannels();
});

elements.accountSearchInput.addEventListener('input', (event) => {
  state.accountSearch = event.target.value;
  renderSources();
});

elements.accountStatusFilter.addEventListener('change', (event) => {
  state.accountStatus = event.target.value;
  renderSources();
});

elements.scanAllAccountsButton.addEventListener('click', () => {
  scanAllAccounts().catch((error) => setSourceStatus(error.message, 'error'));
});

elements.soundToggleInput.addEventListener('change', (event) => {
  state.soundEnabled = event.target.checked;
  applySoundSetting();
});

['loadedmetadata', 'durationchange', 'timeupdate', 'emptied']
  .forEach((eventName) => {
    elements.player.addEventListener(eventName, updateSimpleTimeline);
  });

elements.simpleSeekSlider.addEventListener('input', (event) => {
  const duration = Number(elements.player.duration);
  if (!Number.isFinite(duration) || duration <= 0) return;

  const progress = Number(event.target.value) || 0;
  const previewTime = (progress / 1000) * duration;
  elements.simpleCurrentTime.textContent = formatSimpleTime(previewTime);
  elements.simpleSeekSlider.style.setProperty('--seek-progress', `${progress / 10}%`);
});

elements.simpleSeekSlider.addEventListener('change', (event) => {
  const duration = Number(elements.player.duration);
  if (!Number.isFinite(duration) || duration <= 0) return;

  const progress = Number(event.target.value) || 0;
  elements.player.currentTime = (progress / 1000) * duration;
  updateSimpleTimeline();
});

elements.loadMoreButton.addEventListener('click', () => {
  loadChannels().catch((error) => {
    setLoading(false);
    setStatus(error.message, 'error');
  });
});

elements.toggleUrlFormButton.addEventListener('click', () => {
  elements.sourceUrlForm.hidden = !elements.sourceUrlForm.hidden;
  elements.toggleUrlFormButton.classList.toggle('is-active', !elements.sourceUrlForm.hidden);

  if (!elements.sourceUrlForm.hidden && window.matchMedia('(min-width: 861px)').matches) {
    elements.sourceInput.focus();
  }
});

elements.sourceFileInput.addEventListener('change', () => {
  uploadSourceFiles().catch((error) => {
    elements.sourceFileInput.disabled = false;
    elements.saveSourceButton.disabled = false;
    setSourceStatus(error.message, 'error');
  });
});

elements.saveSourceButton.addEventListener('click', () => {
  saveSource().catch((error) => {
    elements.saveSourceButton.disabled = false;
    setLoading(false);
    setSourceStatus(error.message, 'error');
  });
});

applyStandaloneClass();
registerServiceWorker();
renderGroups();
renderSources();
applySoundSetting();
updateSimpleTimeline();
