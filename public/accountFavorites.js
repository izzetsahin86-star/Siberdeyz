function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function createAccountFavoritesController({
  accountsView,
  getSources,
  activateSource,
  setStatus,
  onChanged,
}) {
  const anchor = accountsView?.querySelector('.account-list-head');
  if (!accountsView || !anchor) {
    return {
      load: async () => {},
      render() {},
      isFavorite() { return false; },
      toggle: async () => {},
    };
  }

  const section = document.createElement('section');
  section.className = 'favorite-accounts';
  section.hidden = true;
  section.innerHTML = [
    '<div class="favorite-accounts-head">',
    '<strong>Favori Hesaplar</strong>',
    '<span id="favoriteAccountCount">0</span>',
    '</div>',
    '<div class="favorite-account-pills" role="list" aria-label="Favori hesaplar"></div>',
  ].join('');
  anchor.parentNode.insertBefore(section, anchor);

  const pillList = section.querySelector('.favorite-account-pills');
  const count = section.querySelector('#favoriteAccountCount');
  let ids = new Set();

  function sourceMap() {
    return new Map((getSources?.() || []).map((source) => [String(source.id), source]));
  }

  function render() {
    const sources = sourceMap();
    const favorites = Array.from(ids)
      .map((id) => sources.get(id))
      .filter(Boolean);

    section.hidden = favorites.length === 0;
    count.textContent = String(favorites.length);

    pillList.innerHTML = favorites.map((source) => {
      const title = source.label || source.fileName || 'Hesap';
      const active = source.active ? ' is-active' : '';
      return [
        '<span class="favorite-account-pill' + active + '" role="listitem">',
        '<button class="favorite-account-open" type="button" data-favorite-account-open="' + escapeHtml(source.id) + '" title="' + escapeHtml(title) + '">',
        '<span aria-hidden="true">★</span>',
        '<strong>' + escapeHtml(title) + '</strong>',
        '</button>',
        '<button class="favorite-account-remove" type="button" data-favorite-account-remove="' + escapeHtml(source.id) + '" aria-label="' + escapeHtml(title) + ' favorilerden cikar">×</button>',
        '</span>',
      ].join('');
    }).join('');
  }

  async function load() {
    const response = await fetch('/api/account-favorites', { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) throw new Error(data.error || 'Favori hesaplar okunamadi.');

    ids = new Set(data.ids || []);
    render();
  }

  async function setFavorite(id, favorite) {
    const response = await fetch('/api/account-favorites/' + encodeURIComponent(id), {
      method: favorite ? 'POST' : 'DELETE',
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) throw new Error(data.error || 'Favori hesap guncellenemedi.');

    ids = new Set(data.ids || []);
    render();
    onChanged?.();
    setStatus?.(favorite ? 'Hesap favorilere eklendi.' : 'Hesap favorilerden cikarildi.');
  }

  async function toggle(id) {
    const key = String(id || '');
    if (!key) return;
    await setFavorite(key, !ids.has(key));
  }

  section.addEventListener('click', (event) => {
    const remove = event.target.closest('[data-favorite-account-remove]');
    if (remove) {
      setFavorite(remove.dataset.favoriteAccountRemove, false)
        .catch((error) => setStatus?.(error.message, 'error'));
      return;
    }

    const open = event.target.closest('[data-favorite-account-open]');
    if (open) {
      activateSource?.(open.dataset.favoriteAccountOpen)
        .catch((error) => setStatus?.(error.message, 'error'));
    }
  });

  return {
    load,
    render,
    isFavorite(id) {
      return ids.has(String(id || ''));
    },
    toggle,
  };
}
