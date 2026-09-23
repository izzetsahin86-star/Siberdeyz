import { attachPlaybackTimeline } from './playerTimeline.js';
import { sourceHasMultipleConnections } from './accountMultiConnection.js';
import { createAppSettingsController } from './appSettings.js';
import { createUserAccessSettingsController } from './userAccessSettings.js';
import { createWebScanController } from './webScan.js';
import { createFullSiteScanController } from './fullSiteScan.js';
import { createMediaFinderProV2Controller } from './mediaFinderProV2.js';
import { createChannelLoadFeedback } from './channelLoadFeedback.js';
import { attachDesktopLayout, isDesktopLayout } from './desktopLayout.js';

const PAGE_SIZE = 100;
const ACCOUNT_PAGE_SIZE = 100;

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
  soundEnabled: false,
  sessionRole: '',
  sessionUserId: '',
  sessionLabel: '',
  appSettings: {
    startupSound: false,
    autoScanMinutes: 60,
    failureThreshold: 3,
    playbackMode: 'auto',
    autoRetry: true,
    retryCount: 3,
    defaultPanel: 'channels',
    channelDensity: 'compact',
  },
  sources: [],
  activeSourceId: '',
  currentChannelId: '',
  activePanel: '',
  accountSearch: '',
  accountStatus: 'all',
  accountPage: 0,
  accountHealth: {},
  accountAutoScanStatus: null,
  accountFailureThreshold: 3,
  accountFailureRecords: {},
  accountPersistentFailedIds: new Set(),
  accountScanningIds: new Set(),
  accountScanningAll: false,
};

let searchTimer;
let playbackErrorHandler = null;
let playbackRetryTimer = null;
let playbackRetryAttempt = 0;
let playbackUsingCompatibility = false;
let settingsController = null;
let userAccessController = null;
let webScanController = null;
let fullSiteScanController = null;
let mediaFinderProV2Controller = null;
let channelLoadFeedback = null;
let startupSessionReset = Promise.resolve();

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
  const requestedPanel = new URLSearchParams(window.location.search).get('panel');
  const panel = ['channels', 'accounts', 'settings'].includes(requestedPanel)
    ? requestedPanel
    : state.appSettings.defaultPanel;

  if (['channels', 'accounts', 'settings'].includes(panel)) switchPanel(panel);
}

const elements = {
  loginScreen: document.querySelector('#loginScreen'),
  loginForm: document.querySelector('#loginForm'),
  loginStatus: document.querySelector('#loginStatus'),
  loginButton: document.querySelector('#loginButton'),
  appShell: document.querySelector('#appShell'),
  activeAccountHeader: document.querySelector('#activeAccountHeader'),
  activeAccountName: document.querySelector('#activeAccountName'),
  bottomPanel: document.querySelector('#bottomPanel'),
  panelTitle: document.querySelector('#panelTitle'),
  closePanelButton: document.querySelector('#closePanelButton'),
  channelsView: document.querySelector('#channelsView'),
  accountsView: document.querySelector('#accountsView'),
  webScanView: document.querySelector('#webScanView'),
  settingsView: document.querySelector('#settingsView'),
  groupChips: document.querySelector('#groupChips'),
  categoryToggle: document.querySelector('#categoryToggle'),
  currentGroupLabel: document.querySelector('#currentGroupLabel'),
  controlButtons: document.querySelectorAll('.control-button'),
  watchArea: document.querySelector('.watch-area'),
  player: document.querySelector('#player'),
  playbackTimeline: document.querySelector('#playbackTimeline'),
  playbackCurrentTime: document.querySelector('#playbackCurrentTime'),
  playbackDurationTime: document.querySelector('#playbackDurationTime'),
  playbackProgressFill: document.querySelector('#playbackProgressFill'),
  playbackTimelineTrack: document.querySelector('#playbackTimelineTrack'),
  currentChannel: document.querySelector('#currentChannel'),
  deleteSelectedWebScanButton: document.querySelector('#deleteSelectedWebScanButton'),
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
  accountAutoScanStatus: document.querySelector('#accountAutoScanStatus'),
  accountRenderHint: document.querySelector('#accountRenderHint'),
  accountTransferBar: document.querySelector('#accountTransferBar'),
  accountTransferUser: document.querySelector('#accountTransferUser'),
  scanAllAccountsButton: document.querySelector('#scanAllAccountsButton'),
  deletePersistentFailedButton: document.querySelector('#deletePersistentFailedButton'),
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

function getActiveSource() {
  return state.sources.find((source) => source.id === state.activeSourceId)
    || state.sources.find((source) => source.active)
    || null;
}

function renderActiveAccountHeader() {
  const source = getActiveSource();
  const label = String(source?.label || '').trim();

  if (elements.activeAccountName) {
    elements.activeAccountName.textContent = label || 'Aktif hesap yok';
    elements.activeAccountName.title = label || 'Aktif hesap secilmedi';
  }

  if (elements.activeAccountHeader) {
    elements.activeAccountHeader.dataset.active = String(Boolean(source));
  }
}

function updateSelectedWebScanDeleteButton() {
  if (!elements.deleteSelectedWebScanButton) return;

  const source = getActiveSource();
  const visible = Boolean(
    state.currentChannelId
    && source
    && source.type === 'file'
    && source.sourceKind === 'web-scan'
  );

  elements.deleteSelectedWebScanButton.hidden = !visible;

  if (!visible) {
    elements.deleteSelectedWebScanButton.disabled = false;
    elements.deleteSelectedWebScanButton.textContent = 'Yayini Sil';
  }
}

async function deleteSelectedWebScanChannel() {
  const channelId = String(state.currentChannelId || '');
  const source = getActiveSource();

  if (!channelId || !source || source.sourceKind !== 'web-scan') return;

  const channel = state.channels.find((item) => item.id === channelId);
  const channelName = channel?.name || elements.currentChannel.textContent || 'Secili yayin';

  if (!window.confirm('"' + channelName + '" Web Tarama hesabindan silinsin mi?')) return;

  elements.deleteSelectedWebScanButton.disabled = true;
  elements.deleteSelectedWebScanButton.textContent = 'Siliniyor...';

  try {
    const response = await fetch('/api/web-scan/channel/' + encodeURIComponent(channelId), {
      method: 'DELETE',
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || 'Yayin silinemedi.');
    }

    stopPlayback({ message: '', resetSound: false });
    setSourceState(data);

    state.group = 'Tumu';
    state.type = 'all';
    state.favoritesOnly = false;
    state.search = '';
    state.channels = [];
    state.hasMore = false;
    elements.searchInput.value = '';

    if (data.hasSource) {
      await loadChannels({ force: true, reset: true });
    } else {
      clearChannelState();
    }

    setStatus(
      data.sourceRemoved
        ? channelName + ' silindi. Bos Web Tarama hesabi da kaldirildi.'
        : channelName + ' Web Tarama hesabindan silindi.'
    );
  } finally {
    updateSelectedWebScanDeleteButton();
  }
}

function setLoading(isLoading) {
  state.loading = isLoading;
  elements.loadMoreButton.disabled = isLoading;
}

function applySoundSetting() {
  elements.player.muted = !state.soundEnabled;
  elements.soundToggleInput.checked = state.soundEnabled;
  elements.soundStatus.textContent = state.soundEnabled
    ? 'Oynatici sesi acik.'
    : 'Oynatici sesi kapali.';
}

function applyAppSettings(settings, { initial = false } = {}) {
  state.appSettings = {
    ...state.appSettings,
    ...(settings || {}),
  };

  document.documentElement.dataset.channelDensity = state.appSettings.channelDensity;

  if (initial) {
    state.soundEnabled = Boolean(state.appSettings.startupSound);
    applySoundSetting();
  }

  loadAccountAutoScanStatus().catch(() => {});
  loadAccountFailureStatus().then(() => renderSources()).catch(() => {});
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
  if (playbackErrorHandler) {
    elements.player.removeEventListener('error', playbackErrorHandler);
    playbackErrorHandler = null;
  }

  if (playbackRetryTimer) {
    clearTimeout(playbackRetryTimer);
    playbackRetryTimer = null;
  }

  playbackRetryAttempt = 0;
  playbackUsingCompatibility = false;
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
  const mode = state.appSettings.playbackMode || 'auto';

  playbackUsingCompatibility = mode === 'compatibility' || !directUrl;
  elements.player.src = playbackUsingCompatibility ? fallbackUrl : directUrl;

  playbackErrorHandler = () => {
    if (state.currentChannelId !== channel.id) return;

    if (mode === 'auto' && !playbackUsingCompatibility) {
      playbackUsingCompatibility = true;
      playbackRetryAttempt = 0;
      elements.player.pause();
      elements.player.src = fallbackUrl;
      elements.player.load();
      elements.player.play().catch(() => {
        setStatus('Yayin uyumluluk motoruyla acilmaya hazirlaniyor.', 'warning');
      });
      return;
    }

    const retryCount = Math.max(1, Number(state.appSettings.retryCount) || 3);

    if (!state.appSettings.autoRetry || playbackRetryAttempt >= retryCount) {
      setStatus('Yayin baglantisi kesildi.', 'error');
      return;
    }

    playbackRetryAttempt += 1;
    const retryUrl = playbackUsingCompatibility || !directUrl ? fallbackUrl : directUrl;
    setStatus(
      'Yayin yeniden baglaniyor... ' + playbackRetryAttempt + '/' + retryCount,
      'warning'
    );

    clearTimeout(playbackRetryTimer);
    playbackRetryTimer = setTimeout(() => {
      if (state.currentChannelId !== channel.id) return;

      elements.player.pause();
      elements.player.src = retryUrl;
      elements.player.load();
      elements.player.play().catch(() => {});
    }, 900);
  };

  elements.player.addEventListener('error', playbackErrorHandler);
}

function stopPlayback({ message = 'Yayin kapatildi.', resetSound = false } = {}) {
  clearPlaybackFallback();
  elements.player.pause();
  unlockMobilePlayerLayout();
  if ('srcObject' in elements.player) elements.player.srcObject = null;
  elements.player.removeAttribute('src');
  elements.player.load();
  elements.currentChannel.textContent = 'Henuz secilmedi';
  state.currentChannelId = '';
  updateSelectedWebScanDeleteButton();
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
      .then(() => {
        if (!state.activeSourceId) {
          clearChannelState();
          setStatus(
            state.sources.length
              ? 'Yayin secmek icin Hesaplar bolumunden bir hesap acin.'
              : 'Hesap yok. Hesaplardan yayin URL yukleyin.',
            'warning'
          );
          return;
        }

        return loadChannels({ reset: true });
      })
      .catch((error) => {
        setLoading(false);
        setSourceStatus(error.message, 'error');
        setStatus(error.message, 'error');
      });

    loadAccountHealth().catch((error) => setSourceStatus(error.message, 'error'));
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
  // Desktop keeps the library alongside the existing player.
  if (isDesktopLayout()) return;
  elements.bottomPanel.dataset.compact = isCompact ? 'true' : 'false';

  if (isCompact) {
    elements.bottomPanel.classList.add('is-closing-for-playback');
    closePanel();
    void elements.bottomPanel.offsetHeight;
    elements.bottomPanel.classList.remove('is-closing-for-playback');
  }
}

function switchPanel(panelName) {
  const panels = {
    channels: elements.channelsView,
    accounts: elements.accountsView,
    webscan: elements.webScanView,
    settings: elements.settingsView,
  };

  const titles = {
    channels: 'Kanallar',
    accounts: 'Hesaplar',
    webscan: 'Web Tarama',
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

  if (panelName === 'accounts') {
    loadAccountHealth().catch((error) => setSourceStatus(error.message, 'error'));
    loadAccountTransferUsers().catch((error) => setSourceStatus(error.message, 'error'));
  }
}

async function loadAccountTransferUsers() {
  if (!elements.accountTransferBar || !elements.accountTransferUser) return;

  if (state.sessionRole !== 'admin') {
    elements.accountTransferBar.hidden = true;
    elements.accountTransferUser.innerHTML = '<option value="">Kullanici secin</option>';
    return;
  }

  const selected = elements.accountTransferUser.value;
  const response = await fetch('/api/admin/users', { cache: 'no-store' });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || 'Kullanici listesi alinamadi.');
  }

  const users = Array.isArray(data.users) ? data.users : [];
  elements.accountTransferUser.innerHTML = [
    '<option value="">Kullanici secin</option>',
    ...users.map((user) => (
      '<option value="' + escapeHtml(user.id) + '">'
      + escapeHtml(user.label || 'Kullanici')
      + '</option>'
    )),
  ].join('');

  if (users.some((user) => user.id === selected)) {
    elements.accountTransferUser.value = selected;
  }

  elements.accountTransferBar.hidden = users.length === 0;
}

async function transferAccountToUser(sourceId) {
  if (state.sessionRole !== 'admin') return;

  const userId = String(elements.accountTransferUser?.value || '').trim();
  if (!userId) {
    setSourceStatus('Once hesabin aktarilacagi kullaniciyi secin.', 'warning');
    return;
  }

  const source = state.sources.find((item) => item.id === sourceId);
  if (!source || source.type !== 'url') {
    setSourceStatus('Yalnizca URL hesaplari kullaniciya aktarilabilir.', 'warning');
    return;
  }

  setSourceStatus((source.label || 'Hesap') + ' kullaniciya aktariliyor...');

  const response = await fetch(
    '/api/admin/users/' + encodeURIComponent(userId) + '/source-copy',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceId }),
    }
  );
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || 'Hesap kullaniciya aktarilamadi.');
  }

  const selectedName = elements.accountTransferUser?.selectedOptions?.[0]?.textContent || 'Kullanici';
  setSourceStatus(
    (source.label || 'Hesap')
    + ' → '
    + selectedName
    + ' aktarildi. Kullanici hesap sayisi: '
    + String(data.sourceCount || 0),
    'success'
  );
}

async function login(adminPassword) {
  await startupSessionReset;
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

  state.sessionRole = data.role || 'user';
  state.sessionUserId = data.userId || '';
  state.sessionLabel = data.label || '';
  elements.adminPasswordInput.value = '';
  setLoginStatus('');

  try {
    await settingsController?.load();
  } catch {
    applyAppSettings(state.appSettings, { initial: true });
  }

  try {
    await userAccessController?.setSession(data);
  } catch {
    // Kullanici yonetimi ana uygulama girisini engellememeli.
  }

  await resetActiveSourceForNewSession();

  // A new authenticated session always starts with no selected source or playback.
  stopPlayback({ message: '', resetSound: false });
  showApp();
}

async function clearPreviousAdminSession() {
  try {
    await fetch('/api/admin/logout', {
      method: 'POST',
      cache: 'no-store',
      keepalive: true,
    });
  } catch {
    // Uygulama her yeni acilista giris ekranindan baslar.
  }
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

function formatAccountAutoScanTime(value) {
  const timestamp = Date.parse(String(value || ''));
  if (!Number.isFinite(timestamp)) return '';

  return new Intl.DateTimeFormat('tr-TR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

function renderAccountAutoScanStatus() {
  const status = state.accountAutoScanStatus;

  if (!status) {
    elements.accountAutoScanStatus.textContent = 'Otomatik tarama: Durum okunuyor...';
    elements.accountAutoScanStatus.dataset.running = 'false';
    return;
  }

  if (!status.enabled) {
    elements.accountAutoScanStatus.textContent = 'Otomatik tarama: Kapali';
    elements.accountAutoScanStatus.dataset.running = 'false';
    return;
  }

  const lastStarted = formatAccountAutoScanTime(status.lastStartedAt);
  const nextRun = formatAccountAutoScanTime(status.nextRunAt);
  const parts = ['Otomatik tarama: ' + String(status.intervalMinutes || 60) + ' dk'];

  if (status.running) {
    const progress = status.totalAccounts > 0
      ? String(status.lastScannedCount || 0) + '/' + String(status.totalAccounts)
      : 'basladi';

    parts.push('Taraniyor ' + progress);
  } else if (lastStarted) {
    parts.push('Son baslangic ' + lastStarted);
  } else {
    parts.push('Henuz otomatik tarama baslamadi');
  }

  if (nextRun) parts.push('Sonraki ' + nextRun);
  if (status.lastError) parts.push('Son hata: ' + status.lastError);

  elements.accountAutoScanStatus.textContent = parts.join(' · ');
  elements.accountAutoScanStatus.dataset.running = status.running ? 'true' : 'false';
}

async function loadAccountAutoScanStatus() {
  try {
    const response = await fetch('/api/account-auto-scan');
    const data = await response.json();

    if (!response.ok) return;

    state.accountAutoScanStatus = data;
    renderAccountAutoScanStatus();
  } catch {
    // Otomatik tarama durum bilgisi ana hesap ekranini engellememeli.
  }
}

function updateAccountScanSummary() {
  const counts = {
    active: 0,
    expired: 0,
    failed: 0,
    unscanned: 0,
    multi: 0,
  };

  for (const source of state.sources) {
    if (source.type === 'file') continue;

    const status = accountHealthStatus(source);
    if (status in counts) counts[status] += 1;
    if (sourceHasMultipleConnections(source, state.accountHealth)) counts.multi += 1;
  }

  for (const [status, count] of Object.entries(counts)) {
    const element = elements.accountScanSummary?.querySelector('[data-account-stat="' + status + '"]');
    if (!element) continue;

    const label = ({
      active: 'Aktif',
      expired: 'Suresi biten',
      failed: 'Calismayan',
      unscanned: 'Taranmamis',
      multi: 'Coklu baglanti',
    }[status]);

    element.textContent = label + ' ' + count;
    element.dataset.count = String(count);
  }
}

function getAccountDeleteScope() {
  if (state.accountStatus === 'all') return state.sources;

  return state.sources.filter((source) => (
    source.type === 'url'
    && accountHealthStatus(source) === state.accountStatus
  ));
}

function accountDeleteButtonLabel(count) {
  if (state.accountStatus === 'all') return 'Hepsini Sil';

  const labels = {
    active: 'Aktifleri Sil',
    expired: 'Suresi Bitenleri Sil',
    failed: 'Calismayanlari Sil',
    unscanned: 'Taranmamislari Sil',
  };

  return (labels[state.accountStatus] || 'Secilenleri Sil') + ' (' + count + ')';
}

function accountDeleteScopeText() {
  return ({
    all: 'tum',
    active: 'aktif',
    expired: 'suresi biten',
    failed: 'calismayan',
    unscanned: 'taranmamis',
  }[state.accountStatus] || 'secilen');
}

function updateAccountsSummary() {
  const count = state.sources.length;
  const deleteScope = getAccountDeleteScope();
  const persistentFailedCount = state.accountPersistentFailedIds.size;

  elements.accountCount.textContent = String(count);
  elements.deleteAllSourcesButton.hidden = deleteScope.length === 0;
  elements.deleteAllSourcesButton.textContent = accountDeleteButtonLabel(deleteScope.length);
  elements.deletePersistentFailedButton.hidden = persistentFailedCount === 0;
  elements.deletePersistentFailedButton.textContent = 'Kalici Calismayanlari Sil (' + persistentFailedCount + ')';
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
      || (statusFilter === 'multi' && sourceHasMultipleConnections(source, state.accountHealth))
      || (statusFilter === 'unscanned' && (status === 'unscanned' || status === 'unsupported'))
      || status === statusFilter;

    if (!statusMatches) return false;
    if (!search) return true;

    const haystack = [
      source.label,
      source.url,
      source.fileName,
      accountStatusLabel(status),
      sourceHasMultipleConnections(source, state.accountHealth) ? 'Coklu baglanti' : '',
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
    elements.accountRenderHint.innerHTML = '';
    state.accountPage = 0;
    return;
  }

  const filtered = getFilteredSources();
  const pageCount = Math.max(1, Math.ceil(filtered.length / ACCOUNT_PAGE_SIZE));
  state.accountPage = Math.min(Math.max(0, state.accountPage), pageCount - 1);

  const pageStart = state.accountPage * ACCOUNT_PAGE_SIZE;
  const pageEnd = Math.min(pageStart + ACCOUNT_PAGE_SIZE, filtered.length);
  const visible = filtered.slice(pageStart, pageEnd);

  if (visible.length === 0) {
    elements.sourceList.innerHTML = '<div class="empty compact-empty">Aramaya uygun hesap bulunamadi.</div>';
  } else {
    elements.sourceList.innerHTML = visible.map((source) => {
      const sourceIndex = state.sources.indexOf(source);
      const isFile = source.type === 'file';
      const health = state.accountHealth[source.id];
      const healthStatus = accountHealthStatus(source);
      const scanning = state.accountScanningIds.has(source.id);
      const title = source.label || 'Hesap ' + (sourceIndex + 1);
      const connection = accountConnectionLabel(health);
      const expiry = accountExpiryLabel(health);
      const isPersistentFailed = state.accountPersistentFailedIds.has(source.id);
      const failureRecord = state.accountFailureRecords[source.id];
      const isWebScan = source.sourceKind === 'web-scan' || source.folder === 'Web Tarama';
      const statusLabel = isWebScan
        ? 'Web Tarama'
        : (isPersistentFailed ? 'Kalici calismiyor' : accountStatusLabel(healthStatus));
      const metaParts = [];

      if (isPersistentFailed) {
        metaParts.push(
          (failureRecord?.consecutiveFailures || state.accountFailureThreshold)
          + ' otomatik taramada ust uste calismadi'
        );
      }

      if (isFile) {
        metaParts.push((source.channelCount || 0) + ' yayin');
        if (isWebScan) metaParts.push('Web Tarama klasoru');
      } else {
        if (connection) metaParts.push('Baglanti ' + connection);
        if (expiry) metaParts.push('Bitis ' + expiry);
        if (health?.checkedAt) metaParts.push('Tarandi');
        if (metaParts.length === 0) metaParts.push('Liste URL');
      }

      const showManualScan = !isFile;

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
        state.sessionRole === 'admin' && !isFile
          ? '<button class="source-pill-transfer" type="button" data-source-transfer="' + escapeHtml(source.id) + '">Aktar</button>'
          : '',
        showManualScan
          ? '<button class="source-pill-scan" type="button" data-account-scan="' + escapeHtml(source.id) + '"' + (scanning ? ' disabled' : '') + '>' + (scanning ? '...' : 'Tara') + '</button>'
          : '',
        '<button class="source-pill-delete" type="button" data-source-delete="' + escapeHtml(source.id) + '" aria-label="Hesabi sil">Sil</button>',
        '</div>',
        '</article>',
      ].join('');
    }).join('');
  }

  const hasPagination = filtered.length > ACCOUNT_PAGE_SIZE;
  elements.accountRenderHint.hidden = !hasPagination;

  if (hasPagination) {
    elements.accountRenderHint.innerHTML = [
      '<span class="account-page-summary">',
      escapeHtml(filtered.length) + ' sonuc · ' + escapeHtml(pageStart + 1) + '-' + escapeHtml(pageEnd),
      '</span>',
      '<span class="account-page-controls">',
      '<button type="button" data-account-page="prev"' + (state.accountPage === 0 ? ' disabled' : '') + '>Onceki</button>',
      '<strong>' + escapeHtml(state.accountPage + 1) + ' / ' + escapeHtml(pageCount) + '</strong>',
      '<button type="button" data-account-page="next"' + (state.accountPage >= pageCount - 1 ? ' disabled' : '') + '>Sonraki</button>',
      '</span>',
    ].join('');
  } else {
    elements.accountRenderHint.innerHTML = '';
  }
}

function setSourceState(data) {
  state.sources = data.sources || [];
  state.activeSourceId = data.activeSourceId || state.sources.find((source) => source.active)?.id || '';

  const validIds = new Set(state.sources.map((source) => source.id));
  state.accountHealth = Object.fromEntries(
    Object.entries(state.accountHealth).filter(([id]) => validIds.has(id))
  );
  state.accountFailureRecords = Object.fromEntries(
    Object.entries(state.accountFailureRecords).filter(([id]) => validIds.has(id))
  );
  state.accountPersistentFailedIds = new Set(
    Array.from(state.accountPersistentFailedIds).filter((id) => validIds.has(id))
  );

  renderSources();
  renderActiveAccountHeader();
  updateSelectedWebScanDeleteButton();

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

async function resetActiveSourceForNewSession() {
  const response = await fetch('/api/source/active/reset', {
    method: 'POST',
    cache: 'no-store',
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || 'Yeni oturum temiz baslatilamadi.');
  }

  setSourceState(data);
  clearChannelState();
}

async function loadAccountHealth() {
  const response = await fetch('/api/account-health');
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Hesap tarama bilgileri okunamadi');
  }

  state.accountHealth = data.accounts || {};
  await Promise.all([
    loadAccountAutoScanStatus(),
    loadAccountFailureStatus(),
  ]);
  renderSources();
}

async function loadAccountFailureStatus() {
  try {
    const response = await fetch('/api/account-failures');
    const data = await response.json();

    if (!response.ok) return false;

    state.accountFailureThreshold = Number(data.threshold) || 3;
    state.accountFailureRecords = data.accounts || {};
    state.accountPersistentFailedIds = new Set(data.persistentIds || []);
    return true;
  } catch {
    return false;
  }
}

async function scanSingleAccount(sourceId) {
  state.accountScanningIds.add(sourceId);
  renderSources();

  try {
    const response = await fetch('/api/account-health/' + encodeURIComponent(sourceId) + '/scan', {
      method: 'POST',
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
  setSourceStatus('Hesap siliniyor...');

  const response = await fetch(`/api/source/${encodeURIComponent(sourceId)}`, {
    method: 'DELETE',
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

async function deletePersistentFailedAccounts() {
  const ids = Array.from(state.accountPersistentFailedIds)
    .filter((id) => state.sources.some((source) => source.id === id && source.type === 'url'));

  if (ids.length === 0) return;

  const approved = window.confirm(
    ids.length
    + ' hesap 3 otomatik taramada ust uste calismadi. Kalici calismayan olarak isaretlenen bu hesaplari silmek istiyor musunuz? Bu islem geri alinamaz.'
  );
  if (!approved) return;

  elements.deletePersistentFailedButton.disabled = true;
  elements.deleteAllSourcesButton.disabled = true;
  elements.sourceFileInput.disabled = true;
  elements.toggleUrlFormButton.disabled = true;

  try {
    let data;

    for (let offset = 0; offset < ids.length; offset += 100) {
      const batch = ids.slice(offset, offset + 100);
      setSourceStatus(
        'Kalici calismayan hesaplar siliniyor... '
        + Math.min(offset + batch.length, ids.length) + '/' + ids.length
      );

      const response = await fetch('/api/source/bulk-delete', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ ids: batch }),
      });
      data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Kalici calismayan hesaplar silinemedi');
      }
    }

    setSourceState(data);
    stopPlayback({ message: '', resetSound: false });

    if (!data.hasSource) {
      clearChannelState();
      setStatus('Hesap yok. Hesaplardan yeni yayin ekleyin.', 'warning');
    } else {
      state.group = 'Tumu';
      state.type = 'all';
      state.favoritesOnly = false;
      state.search = '';
      state.channels = [];
      state.hasMore = false;
      elements.searchInput.value = '';

      renderGroups();
      renderChannels();
      await loadChannels({ force: true, reset: true });
    }

    await loadAccountFailureStatus();
    renderSources();
    setSourceStatus(ids.length + ' kalici calismayan hesap silindi.');
  } finally {
    elements.deletePersistentFailedButton.disabled = false;
    elements.deleteAllSourcesButton.disabled = false;
    elements.sourceFileInput.disabled = false;
    elements.toggleUrlFormButton.disabled = false;
    renderSources();
  }
}

async function deleteAllSources() {
  const targets = getAccountDeleteScope();
  if (targets.length === 0) return;

  const total = targets.length;
  const scopeText = accountDeleteScopeText();
  const approved = window.confirm(
    total + ' ' + scopeText + ' hesabi ve iclerindeki tum yayinlari silmek istiyor musunuz? Bu islem geri alinamaz.'
  );
  if (!approved) return;

  elements.deleteAllSourcesButton.disabled = true;
  elements.sourceFileInput.disabled = true;
  elements.toggleUrlFormButton.disabled = true;
  setSourceStatus(total + ' ' + scopeText + ' hesap siliniyor...');

  try {
    let data;

    if (state.accountStatus === 'all') {
      const response = await fetch('/api/source', {
        method: 'DELETE',
            });
      data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Hesaplar silinemedi');
      }
    } else {
      const ids = targets.map((source) => source.id);

      for (let offset = 0; offset < ids.length; offset += 100) {
        const batch = ids.slice(offset, offset + 100);
        setSourceStatus(
          scopeText + ' hesaplar siliniyor... '
          + Math.min(offset + batch.length, ids.length) + '/' + ids.length
        );

        const response = await fetch('/api/source/bulk-delete', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            },
          body: JSON.stringify({ ids: batch }),
        });
        data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || 'Secilen hesaplar silinemedi');
        }
      }
    }

    setSourceState(data);
    stopPlayback({ message: '', resetSound: false });

    if (!data.hasSource) {
      clearChannelState();
      setStatus('Hesap yok. Hesaplardan yeni yayin ekleyin.', 'warning');
    } else {
      state.group = 'Tumu';
      state.type = 'all';
      state.favoritesOnly = false;
      state.search = '';
      state.channels = [];
      state.hasMore = false;
      elements.searchInput.value = '';

      renderGroups();
      renderChannels();
      await loadChannels({ force: true, reset: true });
    }

    setSourceStatus(total + ' ' + scopeText + ' hesap silindi.');
  } finally {
    elements.deleteAllSourcesButton.disabled = false;
    elements.sourceFileInput.disabled = false;
    elements.toggleUrlFormButton.disabled = false;
    renderSources();
  }
}

async function activateSource(sourceId) {
  const isAlreadyActive = sourceId === state.activeSourceId;

  if (!isAlreadyActive) {
      setSourceStatus('Hesap aciliyor...');

    const response = await fetch(`/api/source/${encodeURIComponent(sourceId)}/active`, {
      method: 'PUT',
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
  const isInitialLoad = offset === 0;
  const waitingText = isInitialLoad
    ? 'Liste cekiliyor... Buyuk listelerde ilk sonuc 10-20 saniye surebilir.'
    : 'Daha fazla kanal yukleniyor...';
  const activeSource = getActiveSource();
  const loadLabel = activeSource?.label
    ? activeSource.label + ' kanallari yukleniyor'
    : 'Kanallar yukleniyor';

  const requestController = new AbortController();
  const timeoutId = setTimeout(() => requestController.abort(), 60000);

  setLoading(true);
  setStatus(waitingText);
  if (isInitialLoad) channelLoadFeedback?.start(loadLabel);

  try {
    const response = await fetch(buildChannelUrl({ force, offset }), {
      signal: requestController.signal,
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Yayin listesi alinamadi');
    }

    if (!data.sourceReady) {
      clearChannelState();
      const message = 'Bu hesapta yuklenebilir kanal bulunamadi.';
      setStatus(message, 'warning');
      if (isInitialLoad) channelLoadFeedback?.fail(message);
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
    const readyText = `${state.channels.length}/${state.total} gosteriliyor. Toplam ${state.allTotal} yayin${filterText}.`;
    setStatus(readyText);
    if (isInitialLoad) {
      channelLoadFeedback?.success(
        state.allTotal > 0
          ? state.allTotal + ' kanal yuklendi.'
          : 'Kanal listesi yuklendi.'
      );
    }
  } catch (error) {
    const message = error?.name === 'AbortError'
      ? 'Kanal listesi 60 saniye icinde yuklenemedi.'
      : (error?.message || 'Kanal listesi yuklenemedi.');
    setStatus(message, 'error');
    if (isInitialLoad) channelLoadFeedback?.fail(message);
    const reportedError = new Error(message);
    reportedError.cause = error;
    throw reportedError;
  } finally {
    clearTimeout(timeoutId);
    setLoading(false);
  }
}

function lockMobilePlayerLayout() {
  if (!elements.watchArea || !window.matchMedia('(max-width: 860px)').matches) return;

  const rect = elements.watchArea.getBoundingClientRect();
  if (!Number.isFinite(rect.height) || rect.height <= 0) return;

  const height = Math.round(rect.height);
  elements.watchArea.style.height = height + 'px';
  elements.watchArea.style.minHeight = height + 'px';
  elements.watchArea.style.maxHeight = height + 'px';
  elements.watchArea.dataset.playerLocked = 'true';
}

function unlockMobilePlayerLayout() {
  if (!elements.watchArea) return;

  elements.watchArea.style.removeProperty('height');
  elements.watchArea.style.removeProperty('min-height');
  elements.watchArea.style.removeProperty('max-height');
  delete elements.watchArea.dataset.playerLocked;
}

async function playChannel(channelId) {
  const channel = state.channels.find((item) => item.id === channelId);
  if (!channel) return;

  const activeElement = document.activeElement;
  if (activeElement && activeElement !== document.body && typeof activeElement.blur === 'function') {
    activeElement.blur();
  }

  lockMobilePlayerLayout();
  setPanelCompact(true);
  state.currentChannelId = channel.id;
  elements.currentChannel.textContent = channel.name;
  updateSelectedWebScanDeleteButton();
  elements.player.muted = !state.soundEnabled;
  setPlaybackSource(channel);
  elements.player.play().catch(() => {
    setStatus('Kanal secildi. Oynat tusuna basin.', 'warning');
  });
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

elements.deleteSelectedWebScanButton?.addEventListener('click', () => {
  deleteSelectedWebScanChannel().catch((error) => {
    setStatus(error.message, 'error');
    updateSelectedWebScanDeleteButton();
  });
});


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

elements.deletePersistentFailedButton.addEventListener('click', () => {
  deletePersistentFailedAccounts().catch((error) => setSourceStatus(error.message, 'error'));
});

elements.deleteAllSourcesButton.addEventListener('click', () => {
  deleteAllSources().catch((error) => setSourceStatus(error.message, 'error'));
});

elements.sourceList.addEventListener('click', (event) => {
  const transferButton = event.target.closest('[data-source-transfer]');
  if (transferButton) {
    transferAccountToUser(transferButton.dataset.sourceTransfer)
      .catch((error) => setSourceStatus(error.message, 'error'));
    return;
  }

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
  state.accountPage = 0;
  renderSources();
});

elements.accountStatusFilter.addEventListener('change', (event) => {
  state.accountStatus = event.target.value;
  state.accountPage = 0;
  renderSources();
});

elements.accountRenderHint.addEventListener('click', (event) => {
  const button = event.target.closest('[data-account-page]');
  if (!button || button.disabled) return;

  if (button.dataset.accountPage === 'prev') {
    state.accountPage = Math.max(0, state.accountPage - 1);
  }

  if (button.dataset.accountPage === 'next') {
    state.accountPage += 1;
  }

  renderSources();
  elements.sourceList.scrollTop = 0;
});

elements.scanAllAccountsButton.addEventListener('click', () => {
  scanAllAccounts().catch((error) => setSourceStatus(error.message, 'error'));
});

elements.soundToggleInput.addEventListener('change', (event) => {
  state.soundEnabled = event.target.checked;
  applySoundSetting();
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

window.addEventListener('siberdeyz:source-updated', (event) => {
  const data = event.detail;
  if (data && Array.isArray(data.sources)) {
    setSourceState(data);
    renderSources();
  } else {
    loadSources().catch(() => {});
  }
});

elements.player.playsInline = true;
elements.player.setAttribute('playsinline', '');
elements.player.setAttribute('webkit-playsinline', '');

userAccessController = createUserAccessSettingsController();

webScanController = createWebScanController({
  async onSaved(data) {
    setSourceState(data);
    stopPlayback({ message: '', resetSound: false });
    state.group = 'Tumu';
    state.type = 'all';
    state.favoritesOnly = false;
    state.search = '';
    state.channels = [];
    state.hasMore = false;
    elements.searchInput.value = '';
    renderGroups();
    renderChannels();

    try {
      await loadChannels({ force: true, reset: true });
    } catch (error) {
      setStatus(error.message, 'error');
    }
  },
});

fullSiteScanController = createFullSiteScanController({
  async onSaved(data) {
    setSourceState(data);
    stopPlayback({ message: '', resetSound: false });
    state.group = 'Tumu';
    state.type = 'all';
    state.favoritesOnly = false;
    state.search = '';
    state.channels = [];
    state.hasMore = false;
    elements.searchInput.value = '';
    renderGroups();
    renderChannels();

    try {
      await loadChannels({ force: true, reset: true });
    } catch (error) {
      setStatus(error.message, 'error');
    }
  },
});

mediaFinderProV2Controller = createMediaFinderProV2Controller({
  async onSaved(data) {
    setSourceState(data);
    stopPlayback({ message: '', resetSound: false });
    state.group = 'Tumu';
    state.type = 'all';
    state.favoritesOnly = false;
    state.search = '';
    state.channels = [];
    state.hasMore = false;
    elements.searchInput.value = '';
    renderGroups();
    renderChannels();

    try {
      await loadChannels({ force: true, reset: true });
    } catch (error) {
      setStatus(error.message, 'error');
    }
  },
});

channelLoadFeedback = createChannelLoadFeedback({
  async onRetry() {
    state.channels = [];
    state.hasMore = false;
    renderChannels();
    await loadChannels({ force: true, reset: true });
  },
  onAccounts() {
    switchPanel('accounts');
  },
});

settingsController = createAppSettingsController({
  onSettingsChange(settings, meta) {
    applyAppSettings(settings, meta);
  },
  async onCacheCleared() {
    state.channels = [];
    state.hasMore = false;
    await loadChannels({ force: true, reset: true });
  },
  async onLogout() {
    stopPlayback({ message: '', resetSound: true });
    window.location.reload();
  },
});

applyStandaloneClass();
attachDesktopLayout({ openPanel: switchPanel });
registerServiceWorker();
startupSessionReset = clearPreviousAdminSession();
renderGroups();
renderSources();
renderAccountAutoScanStatus();
applySoundSetting();
// Do not let Safari/browser media restoration leak a previous playback into login.
stopPlayback({ message: '', resetSound: false });

attachPlaybackTimeline(elements.player, {
  root: elements.playbackTimeline,
  currentTime: elements.playbackCurrentTime,
  durationTime: elements.playbackDurationTime,
  progressFill: elements.playbackProgressFill,
  track: elements.playbackTimelineTrack,
});
