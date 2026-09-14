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
};

let searchTimer;

const elements = {
  loginScreen: document.querySelector('#loginScreen'),
  loginForm: document.querySelector('#loginForm'),
  loginStatus: document.querySelector('#loginStatus'),
  loginButton: document.querySelector('#loginButton'),
  appShell: document.querySelector('#appShell'),
  bottomPanel: document.querySelector('#bottomPanel'),
  channelsView: document.querySelector('#channelsView'),
  settingsView: document.querySelector('#settingsView'),
  headerSourceStatus: document.querySelector('#headerSourceStatus'),
  groupChips: document.querySelector('#groupChips'),
  typeButtons: document.querySelectorAll('[data-type-filter]'),
  favoritesFilterButton: document.querySelector('[data-favorites-filter]'),
  controlButtons: document.querySelectorAll('.control-button'),
  player: document.querySelector('#player'),
  currentChannel: document.querySelector('#currentChannel'),
  refreshButton: document.querySelector('#refreshButton'),
  adminPasswordInput: document.querySelector('#adminPasswordInput'),
  sourceInput: document.querySelector('#sourceInput'),
  sourceStatus: document.querySelector('#sourceStatus'),
  saveSourceButton: document.querySelector('#saveSourceButton'),
  deleteSourceButton: document.querySelector('#deleteSourceButton'),
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
  element.textContent = message;
  element.dataset.type = type;
}

function setStatus(message, type = 'info') {
  setTextStatus(elements.status, message, type);
}

function setSourceStatus(message, type = 'info') {
  setTextStatus(elements.sourceStatus, message, type);
  elements.headerSourceStatus.textContent = message;
  elements.headerSourceStatus.dataset.type = type;
}

function setLoginStatus(message, type = 'info') {
  setTextStatus(elements.loginStatus, message, type);
}

function getAdminPassword() {
  return state.adminPassword;
}

function setLoading(isLoading) {
  state.loading = isLoading;
  elements.refreshButton.disabled = isLoading;
  elements.loadMoreButton.disabled = isLoading;
}

function applySoundSetting() {
  elements.player.muted = !state.soundEnabled;
  elements.soundToggleInput.checked = state.soundEnabled;
  elements.soundStatus.textContent = state.soundEnabled
    ? 'Ses acik. Uygulama kapaninca tekrar sessiz baslar.'
    : 'Video her acilista sessiz baslar.';
}

function resetPlayer() {
  elements.player.pause();
  elements.player.removeAttribute('src');
  elements.player.load();
  elements.currentChannel.textContent = 'Henuz secilmedi';
  state.soundEnabled = false;
  applySoundSetting();
}

function showApp() {
  elements.loginScreen.hidden = true;
  elements.appShell.hidden = false;
  applySoundSetting();

  if (!state.started) {
    state.started = true;
    loadSourceStatus().catch((error) => setSourceStatus(error.message, 'error'));
    loadChannels({ reset: true }).catch((error) => {
      setLoading(false);
      setStatus(error.message, 'error');
    });
  }
}

function setPanelCompact(isCompact) {
  elements.bottomPanel.dataset.compact = isCompact ? 'true' : 'false';
}

function switchPanel(panelName) {
  const isSettings = panelName === 'settings';
  elements.channelsView.hidden = isSettings;
  elements.settingsView.hidden = !isSettings;
  elements.bottomPanel.dataset.open = panelName;
  setPanelCompact(false);

  elements.controlButtons.forEach((button) => {
    button.classList.toggle('is-active', button.dataset.panel === panelName);
  });
}

async function toggleFullscreen() {
  const target = elements.player;

  if (target.webkitEnterFullscreen) {
    target.webkitEnterFullscreen();
    return;
  }

  if (!document.fullscreenElement && target.requestFullscreen) {
    await target.requestFullscreen();
    return;
  }

  if (document.exitFullscreen) await document.exitFullscreen();
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

  if (data.hasSource) {
    setSourceStatus(`Kayitli liste: ${data.url}`);
    elements.deleteSourceButton.disabled = false;
  } else {
    setSourceStatus('Liste yok. Ayarlardan URL yukleyin.', 'warning');
    elements.deleteSourceButton.disabled = true;
  }
}

async function saveSource() {
  const url = elements.sourceInput.value.trim();
  const adminPassword = getAdminPassword();

  if (!url) {
    setSourceStatus('Once yayin URL girin.', 'warning');
    return;
  }

  elements.saveSourceButton.disabled = true;
  setSourceStatus('Liste kaydedildi. Kanallar cekiliyor...');

  const response = await fetch('/api/source', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-admin-password': adminPassword,
    },
    body: JSON.stringify({ url }),
  });
  const data = await response.json();

  elements.saveSourceButton.disabled = false;

  if (!response.ok) {
    throw new Error(data.error || 'Yayin kaydedilemedi');
  }

  elements.sourceInput.value = '';
  setSourceStatus(`Kaydedildi: ${data.url}`);
  switchPanel('channels');
  await loadChannels({ force: true, reset: true });
}

async function deleteSource() {
  const adminPassword = getAdminPassword();
  elements.deleteSourceButton.disabled = true;
  setSourceStatus('Liste siliniyor...');

  const response = await fetch('/api/source', {
    method: 'DELETE',
    headers: { 'x-admin-password': adminPassword },
  });
  const data = await response.json();

  if (!response.ok) {
    elements.deleteSourceButton.disabled = false;
    throw new Error(data.error || 'Yayin silinemedi');
  }

  state.channels = [];
  state.groups = ['Tumu'];
  state.group = 'Tumu';
  state.total = 0;
  state.allTotal = 0;
  state.hasMore = false;
  resetPlayer();
  renderGroups();
  renderChannels();
  setStatus('Liste silindi. Yeni yayin URL yukleyin.', 'warning');
  setSourceStatus('Liste yok. Ayarlardan URL yukleyin.', 'warning');
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
    state.channels = [];
    state.groups = ['Tumu'];
    state.group = 'Tumu';
    state.total = 0;
    state.allTotal = 0;
    state.hasMore = false;
    renderGroups();
    renderChannels();
    setStatus('Liste yok. Ayarlardan yayin URL yukleyin.', 'warning');
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

  elements.currentChannel.textContent = channel.name;
  elements.player.muted = !state.soundEnabled;
  elements.player.src = `/api/stream/${channel.id}`;
  elements.player.play().catch(() => {
    setStatus('Kanal secildi. Oynat tusuna basin.', 'warning');
  });
  setPanelCompact(true);
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

elements.controlButtons.forEach((button) => {
  button.addEventListener('click', () => {
    if (button.dataset.panel) switchPanel(button.dataset.panel);
    if (button.dataset.action === 'fullscreen') toggleFullscreen().catch(() => setStatus('Tam ekran acilamadi.', 'warning'));
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

elements.searchInput.addEventListener('input', (event) => {
  state.search = event.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(reloadFilteredChannels, 250);
});

elements.soundToggleInput.addEventListener('change', (event) => {
  state.soundEnabled = event.target.checked;
  applySoundSetting();
});

elements.refreshButton.addEventListener('click', () => {
  loadChannels({ force: true, reset: true }).catch((error) => {
    setLoading(false);
    setStatus(error.message, 'error');
  });
});

elements.loadMoreButton.addEventListener('click', () => {
  loadChannels().catch((error) => {
    setLoading(false);
    setStatus(error.message, 'error');
  });
});

elements.saveSourceButton.addEventListener('click', () => {
  saveSource().catch((error) => {
    elements.saveSourceButton.disabled = false;
    setLoading(false);
    setSourceStatus(error.message, 'error');
  });
});

elements.deleteSourceButton.addEventListener('click', () => {
  deleteSource().catch((error) => setSourceStatus(error.message, 'error'));
});

renderGroups();
renderTypeFilters();
applySoundSetting();
