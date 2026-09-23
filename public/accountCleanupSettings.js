// Isolated settings card shared by mobile and desktop.
export function createAccountCleanupSettings({ save }) {
  const grid = document.querySelector('#settingsView .settings-grid');
  if (!grid) return { render() {} };
  const card = document.createElement('section');
  card.className = 'setting-card';
  card.id = 'accountCleanupSettings';
  card.innerHTML = `
    <div class="setting-card-head"><h2>Çalışmayan hesapları otomatik sil</h2>
    <p>Hesap aktif çıkarsa bekleme süresi sıfırlanır. Silme, süre dolduktan sonra yeniden başarısız sonuç veren ilk otomatik taramada yapılır.</p></div>
    <label class="setting-select-row"><span>Silme kuralı</span>
      <select id="accountCleanupMode"><option value="scans">50 otomatik tarama</option><option value="days">Gün sayısına göre</option></select>
    </label>
    <label class="setting-select-row"><span>Kaç gün çalışmazsa silinsin?</span>
      <input id="accountCleanupDays" type="number" min="1" max="3650" step="1" value="7" inputmode="numeric" disabled style="width:100%;min-width:0;font-size:16px" />
    </label>
    <div class="setting-card-head"><p>1–3650 gün. Süre ilk başarısız otomatik taramadan hesaplanır. Eski kayıtlarda bilinen kalıcı hata tarihi kullanılır. Otomatik tarama kapalıysa silme yapılmaz.</p></div>
    <button id="saveAccountCleanupDays" class="setting-action-button" type="button">Silme ayarını kaydet</button>
    <p id="accountCleanupStatus" class="settings-status" role="status" aria-live="polite"></p>`;
  const danger = grid.querySelector('.setting-card-danger');
  grid.insertBefore(card, danger);
  const mode = card.querySelector('#accountCleanupMode');
  const days = card.querySelector('#accountCleanupDays');
  const button = card.querySelector('#saveAccountCleanupDays');
  const status = card.querySelector('#accountCleanupStatus');
  mode.addEventListener('change', () => { days.disabled = mode.value !== 'days'; });
  button.addEventListener('click', async () => {
    if (mode.value === 'days' && (!days.value || !days.checkValidity())) {
      status.textContent = '1 ile 3650 arasında tam gün girin.';
      status.dataset.type = 'error';
      days.reportValidity();
      return;
    }
    button.disabled = true;
    status.textContent = 'Kaydediliyor…';
    try {
      await save({ automaticDeleteDays: mode.value === 'days' ? Number(days.value) : 0 });
      status.textContent = 'Silme ayarı kaydedildi.';
      status.dataset.type = 'success';
    } catch (error) {
      status.textContent = error.message;
      status.dataset.type = 'error';
    } finally { button.disabled = false; }
  });
  return {
    render(settings) {
      const count = Number(settings.automaticDeleteDays) || 0;
      mode.value = count > 0 ? 'days' : 'scans';
      days.value = String(count || 7);
      days.disabled = count === 0;
    },
  };
}
