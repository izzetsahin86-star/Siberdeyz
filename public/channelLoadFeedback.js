export function createChannelLoadFeedback({ onRetry, onAccounts } = {}) {
  const channelsView = document.querySelector('#channelsView');
  const toolbar = channelsView?.querySelector('.channel-toolbar');

  if (!channelsView || !toolbar) {
    return {
      start() {},
      success() {},
      fail() {},
      hide() {},
    };
  }

  const root = document.createElement('section');
  root.className = 'channel-load-feedback';
  root.hidden = true;
  root.setAttribute('aria-live', 'polite');
  root.innerHTML = [
    '<div class="channel-load-feedback-icon" aria-hidden="true"><i></i></div>',
    '<div class="channel-load-feedback-copy">',
    '<strong data-channel-load-title>Kanallar yukleniyor</strong>',
    '<span data-channel-load-detail>0 saniye</span>',
    '</div>',
    '<div class="channel-load-feedback-actions" hidden>',
    '<button type="button" data-channel-load-retry>Tekrar Dene</button>',
    '<button type="button" data-channel-load-accounts>Hesaplara Don</button>',
    '</div>',
  ].join('');

  toolbar.insertAdjacentElement('afterend', root);

  const title = root.querySelector('[data-channel-load-title]');
  const detail = root.querySelector('[data-channel-load-detail]');
  const actions = root.querySelector('.channel-load-feedback-actions');
  const retry = root.querySelector('[data-channel-load-retry]');
  const accounts = root.querySelector('[data-channel-load-accounts]');

  let timer = null;
  let hideTimer = null;
  let startedAt = 0;
  let generation = 0;

  function clearTimers() {
    if (timer) clearInterval(timer);
    if (hideTimer) clearTimeout(hideTimer);
    timer = null;
    hideTimer = null;
  }

  function elapsedSeconds() {
    return Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  }

  function updateElapsed() {
    const seconds = elapsedSeconds();
    detail.textContent = seconds + ' saniyedir bekleniyor...';
  }

  function setMode(mode) {
    root.dataset.state = mode;
    actions.hidden = mode !== 'error';
    root.querySelector('.channel-load-feedback-icon').hidden = mode === 'error';
  }

  function start(message = 'Kanallar yukleniyor') {
    generation += 1;
    clearTimers();
    startedAt = Date.now();
    root.hidden = false;
    title.textContent = message;
    detail.textContent = '0 saniyedir bekleniyor...';
    setMode('loading');
    timer = setInterval(updateElapsed, 1000);
  }

  function success(message = 'Kanallar yuklendi.') {
    const currentGeneration = generation;
    const seconds = elapsedSeconds();
    clearTimers();
    root.hidden = false;
    title.textContent = message;
    detail.textContent = 'Yukleme suresi: ' + seconds + ' saniye';
    setMode('success');
    hideTimer = setTimeout(() => {
      if (generation === currentGeneration) root.hidden = true;
    }, 2200);
  }

  function fail(message = 'Kanallar yuklenemedi.') {
    generation += 1;
    const seconds = elapsedSeconds();
    clearTimers();
    root.hidden = false;
    title.textContent = 'Kanallar yuklenemedi';
    detail.textContent = message + (seconds > 0 ? ' · ' + seconds + ' saniye beklendi.' : '');
    setMode('error');
  }

  function hide() {
    generation += 1;
    clearTimers();
    root.hidden = true;
  }

  retry.addEventListener('click', () => {
    retry.disabled = true;
    Promise.resolve(onRetry?.())
      .catch((error) => fail(error?.message || 'Tekrar deneme basarisiz oldu.'))
      .finally(() => {
        retry.disabled = false;
      });
  });

  accounts.addEventListener('click', () => {
    hide();
    onAccounts?.();
  });

  return { start, success, fail, hide };
}
