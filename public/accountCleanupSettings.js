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
      <select id="accountCleanupMode"><option value="scans">Tarama sayısına göre</option><option value="days">Gün sayısına göre</option></select>
    </label>
    <label class="setting-select-row"><span>Kaç taramada silinsin?</span>
      <input id="accountCleanupScans" type="number" min="1" max="10000" step="1" value="50" inputmode="numeric" style="width:100%;min-width:0;font-size:16px" />
    </label>
    <label class="setting-select-row"><span>Kaç gün çalışmazsa silinsin?</span>
      <input id="accountCleanupDays" type="number" min="1" max="3650" step="1" value="7" inputmode="numeric" disabled style="width:100%;min-width:0;font-size:16px" />
    </label>
    <div class="setting-card-head"><p>Tarama sayısı 1–10000, gün sayısı 1–3650 olabilir. Hesap aktif çıkarsa sayaç ve süre sıfırlanır. Otomatik tarama kapalıysa silme yapılmaz.</p></div>
    <button id="saveAccountCleanupDays" class="setting-action-button" type="button">Silme ayarını kaydet</button>
    <p id="accountCleanupStatus" class="settings-status" role="status" aria-live="polite"></p>`;
  const danger = grid.querySelector('.setting-card-danger');
  grid.insertBefore(card, danger);
  const mode = card.querySelector('#accountCleanupMode');
  const days = card.querySelector('#accountCleanupDays');
  const scans = card.querySelector('#accountCleanupScans');
  const button = card.querySelector('#saveAccountCleanupDays');
  const status = card.querySelector('#accountCleanupStatus');
  mode.addEventListener('change', () => {
    days.disabled = mode.value !== 'days';
    scans.disabled = mode.value !== 'scans';
  });
  button.addEventListener('click', async () => {
    if (mode.value === 'days' && (!days.value || !days.checkValidity())) {
      status.textContent = '1 ile 3650 arasında tam gün girin.';
      status.dataset.type = 'error';
      days.reportValidity();
      return;
    }
    if (mode.value === 'scans' && (!scans.value || !scans.checkValidity())) {
      status.textContent = '1 ile 10000 arasında tam tarama sayısı girin.';
      status.dataset.type = 'error';
      scans.reportValidity();
      return;
    }
    button.disabled = true;
    status.textContent = 'Kaydediliyor…';
    try {
      await save({
        automaticDeleteDays: mode.value === 'days' ? Number(days.value) : 0,
        automaticDeleteScans: Number(scans.value),
      });
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
      const scanCount = Number(settings.automaticDeleteScans) || 50;
      mode.value = count > 0 ? 'days' : 'scans';
      days.value = String(count || 7);
      days.disabled = count === 0;
      scans.value = String(scanCount);
      scans.disabled = count > 0;
    },
  };
}
