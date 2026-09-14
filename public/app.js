const state = {
  channels: [],
  group: 'Tumu',
  search: '',
};

const elements = {
  player: document.querySelector('#player'),
  currentChannel: document.querySelector('#currentChannel'),
  refreshButton: document.querySelector('#refreshButton'),
  searchInput: document.querySelector('#searchInput'),
  groupSelect: document.querySelector('#groupSelect'),
  status: document.querySelector('#status'),
  channelList: document.querySelector('#channelList'),
};

function setStatus(message, type = 'info') {
  elements.status.textContent = message;
  elements.status.dataset.type = type;
}

function getGroups() {
  return ['Tumu', ...new Set(state.channels.map((channel) => channel.group).sort())];
}

function renderGroups() {
  elements.groupSelect.innerHTML = getGroups()
    .map((group) => `<option value="${group}">${group}</option>`)
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
    <button class="channel" type="button" data-id="${channel.id}">
      <span class="channel-logo">${channel.logo ? `<img src="${channel.logo}" alt="" loading="lazy" />` : channel.name.slice(0, 1)}</span>
      <span>
        <strong>${channel.name}</strong>
        <small>${channel.group}</small>
      </span>
    </button>
  `).join('');
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
    setStatus('Railway icin M3U_SOURCE_URL ayari girilmeli.', 'warning');
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

loadChannels().catch((error) => setStatus(error.message, 'error'));
