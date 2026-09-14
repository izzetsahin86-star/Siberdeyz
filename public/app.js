const state = {
  channels: [],
  group: 'Tumu',
  search: '',
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

function resetPlayer() {
  elements.player.pause();
  elements.player.removeAttribute('src');
  elements.player.load();
  elements.currentChannel.textContent = 'Henuz secilmedi';
}

function getGroups() {
  return ['Tumu', ...new Set(state.channels.map((channel) => channel.group).sort())];
}

function renderGroups() {
  elements.groupSelect.innerHTML = getGroups()
    .map((group) => `<option value="${escapeHtml(group)}">${escapeHtml(group)}</option>`)
    .join('');
  elements.groupSelect.value = state.group;
}

function getVisibleChannels() {
  const search = state.search.toLocaleLowerCase('tr-TR');
  return state.channels.filter((channel) => {
    const groupMatches = state.group === 'Tumu' || channel.group === state.group;
    const searchMatches = channel.name.toLocaleLowerCase('tr-TR').includes(search);
    return groupMatches && searchMatches;
  });
}

function renderChannels() {
  const channels = getVisibleChannels();

  if (channels.length === 0) {
    elements.channelList.innerHTML = '<div class="empty">Kanal bulunamadi.</div>';
    return;
  }

  elements.channelList.innerHTML = channels.map((channel) => `
    <button class="channel" type="button" data-id="${escapeHtml(channel.id)}">
      <span class="channel-logo">${channel.logo ? `<img src="${escapeHtml(channel.logo)}" alt="" loading="lazy" />` : escapeHtml(channel.name.slice(0, 1))}</span>
      <span>
        <strong>${escapeHtml(channel.name)}</strong>
        <small>${escapeHtml(channel.group)}</small>
      </span>
    </button>
  `).join('');
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
  setSourceStatus('Yayin kaydediliyor...');

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
  await loadChannels(true);
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
  state.group = 'Tumu';
  resetPlayer();
  renderGroups();
  renderChannels();
  setStatus('Yayin silindi. Yeni yayin URL yukleyin.', 'warning');
  setSourceStatus('Kayitli yayin yok. URL girip Yukle tusuna basin.', 'warning');
}

async function loadChannels(force = false) {
  setStatus('Yayin listesi yukleniyor...');
  const response = await fetch(`/api/channels${force ? '?refresh=1' : ''}`);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Yayin listesi alinamadi');
  }

  if (!data.sourceReady) {
    state.channels = [];
    renderGroups();
    renderChannels();
    setStatus('Kayitli yayin yok. Once yayin URL yukleyin.', 'warning');
    return;
  }

  state.channels = data.channels;
  renderGroups();
  renderChannels();
  setStatus(`${state.channels.length} yayin hazir.`);
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

elements.channelList.addEventListener('click', (event) => {
  const button = event.target.closest('.channel');
  if (button) playChannel(button.dataset.id);
});

elements.searchInput.addEventListener('input', (event) => {
  state.search = event.target.value;
  renderChannels();
});

elements.groupSelect.addEventListener('change', (event) => {
  state.group = event.target.value;
  renderChannels();
});

elements.refreshButton.addEventListener('click', () => {
  loadChannels(true).catch((error) => setStatus(error.message, 'error'));
});

elements.saveSourceButton.addEventListener('click', () => {
  saveSource().catch((error) => setSourceStatus(error.message, 'error'));
});

elements.deleteSourceButton.addEventListener('click', () => {
  deleteSource().catch((error) => setSourceStatus(error.message, 'error'));
});

loadSourceStatus().catch((error) => setSourceStatus(error.message, 'error'));
loadChannels().catch((error) => setStatus(error.message, 'error'));
