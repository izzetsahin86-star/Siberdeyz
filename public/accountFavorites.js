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
  const selectorWrap = document.querySelector('#favoriteAccountSelectorWrap');
  const selector = document.querySelector('#favoriteAccountSelector');

  if (!accountsView || !selectorWrap || !selector) {
    return {
      load: async () => {},
      render() {},
      isFavorite() { return false; },
      toggle: async () => {},
    };
  }

  let ids = new Set();

  function sourceMap() {
    return new Map((getSources?.() || []).map((source) => [String(source.id), source]));
  }

  function render() {
    const sources = sourceMap();
    const favorites = Array.from(ids)
      .map((id) => sources.get(id))
      .filter(Boolean);
    const activeFavorite = favorites.find((source) => source.active);

    selectorWrap.hidden = favorites.length === 0;
    selector.innerHTML = [
      '<option value="">Favori hesap sec</option>',
      ...favorites.map((source) => {
        const title = source.label || source.fileName || 'Hesap';
        return '<option value="' + escapeHtml(source.id) + '">' + escapeHtml(title) + '</option>';
      }),
    ].join('');
    selector.value = activeFavorite ? String(activeFavorite.id) : '';
  }

  async function load() {
    const response = await fetch('/api/account-favorites', { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) throw new Error(data.error || 'Favori hesaplar okunamadi.');

    ids = new Set(data.ids || []);
    render();
    onChanged?.();
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

  selector.addEventListener('change', () => {
    const id = selector.value;
    if (!id) return;
    activateSource?.(id)
      .then(() => render())
      .catch((error) => {
        setStatus?.(error.message, 'error');
        render();
      });
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
