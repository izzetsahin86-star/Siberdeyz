const PAGE_SIZE = 100;

const state = {
  channels: [],
  groups: ['Tumu'],
  group: 'Tumu',
  type: 'all',
  favoritesOnly: false,
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
};

let searchTimer;

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
  typeButtons: document.querySelectorAll('[data-type-filter]'),
  favoritesFilterButton: document.querySelector('[data-favorites-filter]'),
  controlButtons: document.querySelectorAll('.control-button'),
  player: document.querySelector('#player'),
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
  deleteAllSourcesButton: document.querySelector('#deleteAllSourcesButton'),
  saveSourceButton: document.querySelector('#saveSourceButton'),
  soundToggleInput: document.querySelector('#soundToggleInput'),
  soundStatus: document.querySelector('#soundStatus'),
  searchInput: document.querySelector('#searchInput'),
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

function stopPlayback({ message = 'Yayin kapatildi.', resetSound = false } = {}) {
  elements.player.pause();
  elements.player.removeAttribute('src');
  elements.player.load();
  elements.currentChannel.textContent = 'Henuz secilmedi';
  state.currentChannelId = '';
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
    loadSourceStatus().catch((error) => setSourceStatus(error.message, 'error'));
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

function renderTypeFilters() {
  elements.typeButtons.forEach((button) => {
    button.classList.toggle('is-active', button.dataset.typeFilter === state.type && !state.favoritesOnly);
  });

  elements.favoritesFilterButton.classList.toggle('is-active', state.favoritesOnly);
}

function renderGroups() {
  const groups = state.groups.length ? state.groups : ['Tumu'];

  elements.groupChips.innerHTML = groups.map((group) => `
    <button class="group-chip ${group === state.group ? 'is-active' : ''}" type="button" data-group-value="${escapeHtml(group)}">
      ${escapeHtml(group)}
    </button>
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

function updateAccountsSummary() {
  const count = state.sources.length;
  elements.accountCount.textContent = String(count);
  elements.deleteAllSourcesButton.hidden = count === 0;
}

function renderSources() {
  updateAccountsSummary();

  if (state.sources.length === 0) {
    elements.sourceList.innerHTML = '<div class="empty compact-empty">Kayitli hesap yok. Dosya veya URL ekleyin.</div>';
    return;
  }

  elements.sourceList.innerHTML = state.sources.map((source, index) => {
    const isFile = source.type === 'file';
    const badge = source.active ? 'Aktif' : (isFile ? 'Dosya' : '#' + (index + 1));
    const title = source.label || 'Hesap ' + (index + 1);
    const meta = isFile
      ? ((source.channelCount || 0) + ' yayin')
      : 'Liste URL';

    return [
      '<article class="source-pill-item ' + (source.active ? 'is-active' : '') + '">',
      '<button class="source-pill-select" type="button" data-source-active="' + escapeHtml(source.id) + '">',
      '<span class="source-pill-badge">' + escapeHtml(badge) + '</span>',
      '<span class="source-pill-copy">',
      '<strong>' + escapeHtml(title) + '</strong>',
      '<small>' + escapeHtml(meta) + '</small>',
      '</span>',
      '</button>',
      '<button class="source-pill-delete" type="button" data-source-delete="' + escapeHtml(source.id) + '" aria-label="Hesabi sil">Sil</button>',
      '</article>',
    ].join('');
  }).join('');
}

function setSourceState(data) {
  state.sources = data.sources || [];
  state.activeSourceId = data.activeSourceId || state.sources.find((source) => source.active)?.id || '';
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
  if (sourceId === state.activeSourceId) return;

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
  switchPanel('channels');
  stopPlayback({ message: '', resetSound: false });
  await loadChannels({ force: true, reset: true });
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
  renderTypeFilters();
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
  elements.player.src = `/api/stream/${channel.id}`;
  elements.player.play().catch(() => {
    setStatus('Kanal secildi. Oynat tusuna basin.', 'warning');
  });
  closePanel();
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
  renderTypeFilters();
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

elements.groupChips.addEventListener('click', (event) => {
  const button = event.target.closest('[data-group-value]');
  if (!button) return;
  state.group = button.dataset.groupValue;
  reloadFilteredChannels();
});

elements.typeButtons.forEach((button) => {
  button.addEventListener('click', () => {
    state.type = button.dataset.typeFilter;
    state.favoritesOnly = false;
    reloadFilteredChannels();
  });
});

elements.favoritesFilterButton.addEventListener('click', () => {
  state.favoritesOnly = !state.favoritesOnly;
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

elements.player.addEventListener('playing', () => {
  setStatus(`${elements.currentChannel.textContent} oynatiliyor.`);
});

elements.player.addEventListener('error', () => {
  setStatus('Yayin acilamadi. Baska bir kanal deneyin veya sayfayi yenileyin.', 'error');
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
renderTypeFilters();
renderSources();
applySoundSetting();
