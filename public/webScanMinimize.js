export function attachWebScanMinimize({ bottomPanel, panelTitle, closeButton } = {}) {
  const header = closeButton?.parentElement;
  if (!bottomPanel || !panelTitle || !closeButton || !header) {
    return { sync() {}, reset() {} };
  }

  let button = header.querySelector('#minimizeWebScanButton');

  if (!button) {
    button = document.createElement('button');
    button.id = 'minimizeWebScanButton';
    button.className = 'sheet-minimize';
    button.type = 'button';
    button.textContent = 'Kucult';
    button.setAttribute('aria-label', 'Web Tarama penceresini kucult');
    button.setAttribute('aria-expanded', 'true');
    closeButton.insertAdjacentElement('beforebegin', button);
  }

  function isWebScanOpen() {
    return bottomPanel.dataset.open === 'webscan';
  }

  function setMinimized(value) {
    const minimized = Boolean(value) && isWebScanOpen();
    bottomPanel.dataset.minimized = minimized ? 'true' : 'false';
    button.textContent = minimized ? 'Ac' : 'Kucult';
    button.setAttribute('aria-expanded', minimized ? 'false' : 'true');
    button.setAttribute(
      'aria-label',
      minimized ? 'Web Tarama penceresini ac' : 'Web Tarama penceresini kucult'
    );
  }

  button.addEventListener('click', () => {
    if (!isWebScanOpen()) return;
    setMinimized(bottomPanel.dataset.minimized !== 'true');
  });

  header.addEventListener('dblclick', (event) => {
    if (!isWebScanOpen()) return;
    if (event.target.closest('button')) return;
    setMinimized(bottomPanel.dataset.minimized !== 'true');
  });

  function sync() {
    const webScanOpen = isWebScanOpen();
    button.hidden = !webScanOpen;
    if (!webScanOpen) setMinimized(false);
  }

  function reset() {
    setMinimized(false);
    sync();
  }

  sync();
  return { sync, reset };
}
