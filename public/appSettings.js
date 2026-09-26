import { createAccountCleanupSettings } from './accountCleanupSettings.js';

const DEFAULT_SETTINGS = Object.freeze({
  startupSound: false,
  autoScanMinutes: 1440,
  failureThreshold: 3,
  automaticDeleteDays: 0,
  automaticDeleteScans: 50,
  playbackMode: 'auto',
  autoRetry: true,
  retryCount: 3,
  defaultPanel: 'channels',
  channelDensity: 'compact',
});

function normalizeSettings(value = {}) {
  return {
    ...DEFAULT_SETTINGS,
    ...(value && typeof value === 'object' ? value : {}),
  };
}

async function readJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Ayar islemi tamamlanamadi.');
  return data;
}

export function createAppSettingsController({
  onSettingsChange = () => {},
  onCacheCleared = () => {},
  onLogout = () => {},
} = {}) {
  let settings = { ...DEFAULT_SETTINGS };
  let saveQueue = Promise.resolve();
  const cleanupSettings = createAccountCleanupSettings({ save });

  const elements = {
    startupSound: document.querySelector('#startupSoundSetting'),
    autoScanMinutes: document.querySelector('#autoScanMinutesSetting'),
    failureThreshold: document.querySelector('#failureThresholdSetting'),
    playbackMode: document.querySelector('#playbackModeSetting'),
    autoRetry: document.querySelector('#autoRetrySetting'),
    retryCount: document.querySelector('#retryCountSetting'),
    defaultPanel: document.querySelector('#defaultPanelSetting'),
    channelDensity: document.querySelector('#channelDensitySetting'),
    clearCache: document.querySelector('#clearCacheButton'),
    logout: document.querySelector('#logoutButton'),
    status: document.querySelector('#settingsStatus'),
  };

  function setStatus(message, type = 'info') {
    if (!elements.status) return;
    elements.status.textContent = message;
    elements.status.dataset.type = type;
    elements.status.hidden = !message;
  }

  function render() {
    cleanupSettings.render(settings);
    if (elements.startupSound) elements.startupSound.checked = Boolean(settings.startupSound);
    if (elements.autoScanMinutes) elements.autoScanMinutes.value = String(settings.autoScanMinutes);
    if (elements.failureThreshold) elements.failureThreshold.value = String(settings.failureThreshold);
    if (elements.playbackMode) elements.playbackMode.value = settings.playbackMode;
    if (elements.autoRetry) elements.autoRetry.checked = Boolean(settings.autoRetry);
    if (elements.retryCount) {
      elements.retryCount.value = String(settings.retryCount);
      elements.retryCount.disabled = !settings.autoRetry;
    }
    if (elements.defaultPanel) elements.defaultPanel.value = settings.defaultPanel;
    if (elements.channelDensity) elements.channelDensity.value = settings.channelDensity;
  }

  function notify(initial = false) {
    onSettingsChange({ ...settings }, { initial });
  }

  async function load() {
    const response = await fetch('/api/settings', { cache: 'no-store' });
    settings = normalizeSettings(await readJson(response));
    render();
    notify(true);
    setStatus('');
    return { ...settings };
  }

  function save(patch) {
    saveQueue = saveQueue.catch(() => {}).then(async () => {
      setStatus('Kaydediliyor...');
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      settings = normalizeSettings(await readJson(response));
      render();
      notify(false);
      setStatus('Ayar kaydedildi.', 'success');
      return { ...settings };
    }).catch((error) => {
      setStatus(error.message, 'error');
      throw error;
    });

    return saveQueue;
  }

  function bindSelect(element, key, transform = (value) => value) {
    if (!element) return;
    element.addEventListener('change', () => {
      save({ [key]: transform(element.value) }).catch(() => {});
    });
  }

  function bindCheckbox(element, key) {
    if (!element) return;
    element.addEventListener('change', () => {
      save({ [key]: element.checked }).catch(() => {});
    });
  }

  bindCheckbox(elements.startupSound, 'startupSound');
  bindSelect(elements.autoScanMinutes, 'autoScanMinutes', Number);
  bindSelect(elements.failureThreshold, 'failureThreshold', Number);
  bindSelect(elements.playbackMode, 'playbackMode');
  bindCheckbox(elements.autoRetry, 'autoRetry');
  bindSelect(elements.retryCount, 'retryCount', Number);
  bindSelect(elements.defaultPanel, 'defaultPanel');
  bindSelect(elements.channelDensity, 'channelDensity');

  elements.clearCache?.addEventListener('click', async () => {
    elements.clearCache.disabled = true;
    setStatus('Onbellek temizleniyor...');

    try {
      const response = await fetch('/api/settings/cache/clear', { method: 'POST' });
      await readJson(response);
      setStatus('Kanal onbellegi temizlendi.', 'success');
      await onCacheCleared();
    } catch (error) {
      setStatus(error.message, 'error');
    } finally {
      elements.clearCache.disabled = false;
    }
  });

  elements.logout?.addEventListener('click', async () => {
    elements.logout.disabled = true;
    setStatus('Cikis yapiliyor...');

    try {
      try {
        const resetResponse = await fetch('/api/source/active/reset', {
          method: 'POST',
          cache: 'no-store',
        });
        if (resetResponse.ok) await resetResponse.json().catch(() => ({}));
      } catch {
        // Yeni giris de aktif kaynagi sifirlar; cikisi engelleme.
      }

      const response = await fetch('/api/admin/logout', {
        method: 'POST',
        cache: 'no-store',
      });
      await readJson(response);
      await onLogout();
    } catch (error) {
      setStatus(error.message, 'error');
      elements.logout.disabled = false;
    }
  });

  return {
    load,
    save,
    getSettings() {
      return { ...settings };
    },
  };
}
