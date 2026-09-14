const PAGE_SIZE = 100;

const state = {
  channels: [],
  groups: ['Tumu'],
  group: 'Tumu',
  search: '',
  total: 0,
  allTotal: 0,
  hasMore: false,
  loading: false,
};

const elements = {
  player: document.querySelector('#player'),
  currentChannel: document.querySelector('#currentChannel'),
  refreshButton: document.querySelector('#refreshButton'),
  sourceInput: document.querySelector('#sourceInput'),
  sourceStatus: document.querySelector('#sourceStatus'),
  saveSourceButton: document.querySelector('#saveSourceButton'),
  deleteSourceButton: document.querySelector('#deleteSourceButton'),
  searchInput: document.querySelector('#searchInput'),
  groupSelect: document.querySelector('#groupSelect'),
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

function setStatus(message, type = 'info') {
  elements.status.textContent = message;
  elements.status.dataset.type = type;
}

function setSourceStatus(message, type = 'info') {
  elements.sourceStatus.textContent = message;
  elements.sourceStatus.dataset.type = type;
}

function setLoading(isLoading) {
  state.loading = isLoading;
  elements.refreshButton.disabled = isLoading;
  elements.loadMoreButton.disabled = isLoading;
}

function resetPlayer() {
  elements.player.pause();
  elements.player.removeAttribute('src');
  elements.player.load();
  elements.currentChannel.textContent = 'Henuz secilmedi';
}

function renderGroups() {
  elements.groupSelect.innerHTML = state.groups
    .map((group) => `<option value="${escapeHtml(group)}">${escapeHtml(group)}</option>`)
    .join('');
  elements.groupSelect.value = state.group;
}

function renderLoadMore() {
  elements.loadMoreButton.hidden = !state.hasMore || state.channels.length === 0;
  elements.loadMoreButton.textContent = `Daha fazla goster (${state.channels.length}/${state.total})`;
}

function renderChannels() {
  if (state.channels.length === 0) {
    elements.channelList.innerHTML = '<div class="empty">Kanal bulunamadi.</div>';
    renderLoadMore();
    return;
  }

  elements.channelList.innerHTML = state.channels.map((channel) => `
    <button class="channel" type="button" data-id="${escapeHtml(channel.id)}">
      <span class="channel-logo">${channel.logo ? `<img src="${escapeHtml(channel.logo)}" alt="" loading="lazy" />` : escapeHtml(channel.name.slice(0, 1))}</span>
      <span>
        <strong>${escapeHtml(channel.name)}</strong>
        <small>${escapeHtml(channel.group)}</small>
      </span>
    </button>
  `).join('');
  renderLoadMore();
}

function buildChannelUrl({ force = false, offset = 0 } = {}) {
  const params = new URLSearchParams({
    limit: String(PAGE_SIZE),
    offset: String(offset),
    group: state.group,
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
    setSourceStatus(`Kayitli yayin: ${data.url}`);
    elements.deleteSourceButton.disabled = false;
  } else {
    setSourceStatus('Kayitli yayin yok. URL girip Yukle tusuna basin.', 'warning');
    elements.deleteSourceButton.disabled = true;
  }
}

async function saveSource() {
  const url = elements.sourceInput.value.trim();
  if (!url) {
    setSourceStatus('Once yayin URL girin.', 'warning');
    return;
  }

  elements.saveSourceButton.disabled = true;
  setSourceStatus('Yayin kaydedildi. Liste cekiliyor, ilk yukleme 10-20 saniye surebilir...');

  const response = await fetch('/api/source', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  const data = await response.json();

  elements.saveSourceButton.disabled = false;

  if (!response.ok) {
    throw new Error(data.error || 'Yayin kaydedilemedi');
  }

  elements.sourceInput.value = '';
  setSourceStatus(`Kaydedildi: ${data.url}`);
  await loadChannels({ force: true, reset: true });
}

async function deleteSource() {
  elements.deleteSourceButton.disabled = true;
  setSourceStatus('Yayin siliniyor...');

  const response = await fetch('/api/source', { method: 'DELETE' });
  const data = await response.json();

  if (!response.ok) {
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
  setStatus('Yayin silindi. Yeni yayin URL yukleyin.', 'warning');
  setSourceStatus('Kayitli yayin yok. URL girip Yukle tusuna basin.', 'warning');
}

async function loadChannels({ force = false, reset = false } = {}) {
  if (state.loading) return;

  const offset = reset ? 0 : state.channels.length;
  const waitingText = offset === 0
    ? 'Yayin listesi cekiliyor... Bu liste buyukse ilk sonuc 10-20 saniye surebilir.'
    : 'Devam kanallari yukleniyor...';

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
    state.total = 0;
    state.allTotal = 0;
    state.hasMore = false;
    renderGroups();
    renderChannels();
    setStatus('Kayitli yayin yok. Once yayin URL yukleyin.', 'warning');
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
  setStatus(`${state.channels.length}/${state.total} kanal gosteriliyor. Toplam ${state.allTotal} yayin bulundu${filterText}.`);
}

function playChannel(channelId) {
  const channel = state.channels.find((item) => item.id === channelId);
  if (!channel) return;

  elements.currentChannel.textContent = channel.name;
  elements.player.src = `/api/stream/${channel.id}`;
  elements.player.play().catch(() => {
    setStatus('Oynatma baslatilamadi. Kanal secildi, oynat tusuna basin.', 'warning');
  });
}

function reloadFilteredChannels() {
  state.channels = [];
  state.hasMore = false;
  renderChannels();
  loadChannels({ reset: true }).catch((error) => {
    setLoading(false);
    setStatus(error.message, 'error');
  });
}

elements.channelList.addEventListener('click', (event) => {
  const button = event.target.closest('.channel');
  if (button) playChannel(button.dataset.id);
});

elements.searchInput.addEventListener('input', (event) => {
  state.search = event.target.value;
  reloadFilteredChannels();
});

elements.groupSelect.addEventListener('change', (event) => {
  state.group = event.target.value;
  reloadFilteredChannels();
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

loadSourceStatus().catch((error) => setSourceStatus(error.message, 'error'));
loadChannels({ reset: true }).catch((error) => {
  setLoading(false);
  setStatus(error.message, 'error');
});
