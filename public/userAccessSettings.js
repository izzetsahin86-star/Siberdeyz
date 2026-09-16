function formatDate(value) {
  if (!value) return 'Henuz giris yapmadi';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  return new Intl.DateTimeFormat('tr-TR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

async function readJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Kullanici islemi tamamlanamadi.');
  return data;
}

export function createUserAccessSettingsController() {
  const elements = {
    card: document.querySelector('#userAccessCard'),
    label: document.querySelector('#userAccessLabel'),
    generate: document.querySelector('#generateUserPasswordButton'),
    generatedBox: document.querySelector('#generatedUserPasswordBox'),
    generatedPassword: document.querySelector('#generatedUserPassword'),
    copy: document.querySelector('#copyGeneratedUserPasswordButton'),
    accountTarget: document.querySelector('#userAccountTarget'),
    accountLabel: document.querySelector('#userAccountLabel'),
    accountUrl: document.querySelector('#userAccountUrl'),
    assignAccount: document.querySelector('#assignUserAccountButton'),
    list: document.querySelector('#userAccessList'),
    status: document.querySelector('#userAccessStatus'),
  };

  let role = '';
  let users = [];

  function setStatus(message, type = 'info') {
    if (!elements.status) return;
    elements.status.textContent = message;
    elements.status.dataset.type = type;
    elements.status.hidden = !message;
  }

  function render() {
    if (!elements.list) return;

    if (elements.accountTarget) {
      const selected = elements.accountTarget.value;
      elements.accountTarget.innerHTML = [
        '<option value="">Kullanici secin</option>',
        ...users.map((user) => '<option value="' + escapeHtml(user.id) + '">' + escapeHtml(user.label || 'Kullanici') + '</option>'),
      ].join('');

      if (users.some((user) => user.id === selected)) {
        elements.accountTarget.value = selected;
      }

      elements.accountTarget.disabled = users.length === 0;
    }

    if (elements.assignAccount) {
      elements.assignAccount.disabled = users.length === 0;
    }

    if (users.length === 0) {
      elements.list.innerHTML = '<div class="user-access-empty">Henuz kullanici sifresi uretilmedi.</div>';
      return;
    }

    elements.list.innerHTML = users.map((user) => [
      '<article class="user-access-item">',
      '<div class="user-access-copy">',
      '<strong>' + escapeHtml(user.label || 'Kullanici') + '</strong>',
      '<small>Olusturma: ' + escapeHtml(formatDate(user.createdAt)) + '</small>',
      '<small>Son giris: ' + escapeHtml(formatDate(user.lastLoginAt)) + '</small>',
      '</div>',
      '<button type="button" class="user-access-revoke" data-revoke-user="' + escapeHtml(user.id) + '">Iptal Et</button>',
      '</article>',
    ].join('')).join('');
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;',
    }[char]));
  }

  async function load() {
    if (role !== 'admin') return;
    const response = await fetch('/api/admin/users', { cache: 'no-store' });
    const data = await readJson(response);
    users = Array.isArray(data.users) ? data.users : [];
    render();
  }

  async function generate() {
    if (role !== 'admin') return;

    elements.generate.disabled = true;
    setStatus('Kullanici sifresi uretiliyor...');

    try {
      const response = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: elements.label?.value || '' }),
      });
      const data = await readJson(response);

      if (elements.generatedPassword) elements.generatedPassword.textContent = data.password || '';
      if (elements.generatedBox) elements.generatedBox.hidden = false;
      if (elements.label) elements.label.value = '';

      setStatus('Sifre olusturuldu. Bu sifre yalnizca simdi gosterilir.', 'success');
      await load();
    } catch (error) {
      setStatus(error.message, 'error');
    } finally {
      elements.generate.disabled = false;
    }
  }

  async function assignAccount() {
    if (role !== 'admin') return;

    const userId = String(elements.accountTarget?.value || '').trim();
    const url = String(elements.accountUrl?.value || '').trim();
    const label = String(elements.accountLabel?.value || '').trim();

    if (!userId) {
      setStatus('Once URL atanacak kullaniciyi secin.', 'warning');
      return;
    }

    if (!url) {
      setStatus('Atanacak yayin URL adresini girin.', 'warning');
      return;
    }

    elements.assignAccount.disabled = true;
    setStatus('URL hesabi kullaniciya ataniyor...');

    try {
      const response = await fetch('/api/admin/users/' + encodeURIComponent(userId) + '/source', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url, label }),
      });
      const data = await readJson(response);
      const user = users.find((item) => item.id === userId);

      if (elements.accountUrl) elements.accountUrl.value = '';
      if (elements.accountLabel) elements.accountLabel.value = '';

      setStatus(
        (user?.label || 'Kullanici')
        + ' hesabina URL eklendi. Toplam hesap: '
        + String(data.sourceCount || 0),
        'success'
      );
    } catch (error) {
      setStatus(error.message, 'error');
    } finally {
      elements.assignAccount.disabled = users.length === 0;
    }
  }

  async function revoke(userId) {
    if (role !== 'admin') return;
    const user = users.find((item) => item.id === userId);
    const label = user?.label || 'Bu kullanici';

    if (!window.confirm(label + ' erisimini iptal etmek istiyor musunuz?')) return;

    setStatus('Kullanici erisimi iptal ediliyor...');

    try {
      const response = await fetch('/api/admin/users/' + encodeURIComponent(userId), {
        method: 'DELETE',
      });
      const data = await readJson(response);
      users = Array.isArray(data.users) ? data.users : [];
      render();
      setStatus('Kullanici erisimi iptal edildi.', 'success');
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  elements.generate?.addEventListener('click', () => {
    generate().catch(() => {});
  });

  elements.assignAccount?.addEventListener('click', () => {
    assignAccount().catch(() => {});
  });

  elements.copy?.addEventListener('click', async () => {
    const password = String(elements.generatedPassword?.textContent || '').trim();
    if (!password) return;

    try {
      await navigator.clipboard.writeText(password);
      setStatus('Sifre panoya kopyalandi.', 'success');
    } catch {
      setStatus('Sifreyi ekrandan kopyalayabilirsiniz.', 'warning');
    }
  });

  elements.list?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-revoke-user]');
    if (!button) return;
    revoke(button.dataset.revokeUser).catch(() => {});
  });

  return {
    async setSession(session = {}) {
      role = session.role === 'admin' ? 'admin' : 'user';
      if (elements.card) elements.card.hidden = role !== 'admin';

      if (role === 'admin') {
        await load();
      } else {
        users = [];
        render();
        if (elements.generatedBox) elements.generatedBox.hidden = true;
      }
    },
    load,
  };
}
