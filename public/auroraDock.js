/* Aurora dock decoration only.
   Adds SVG icons to existing control buttons; no player/API/application state changes. */
(() => {
  'use strict';

  const icons = {
    stop: '<rect x="6" y="6" width="12" height="12" rx="3"/>',
    next: '<path d="m5 4 11 8L5 20Z"/><path d="M19 5v14"/>',
    reload: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1"/>',
    channels: '<rect x="3" y="4" width="18" height="13" rx="3"/><path d="M8 21h8m-4-4v4m-3-9 5 3V7Z"/>',
    accounts: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
    webscan: '<circle cx="10" cy="10" r="7"/><path d="m15 15 6 6M3 10h14M10 3a13 13 0 0 1 0 14 13 13 0 0 1 0-14"/>',
    settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
  };

  function decorateDock() {
    document.querySelectorAll('.control-button').forEach((button) => {
      if (button.querySelector('.aurora-dock-icon')) return;

      const key = button.dataset.action || button.dataset.panel;
      const shape = icons[key];
      if (!shape) return;

      const icon = document.createElement('span');
      icon.className = 'aurora-dock-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${shape}</svg>`;
      button.prepend(icon);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', decorateDock, { once: true });
  } else {
    decorateDock();
  }
})();
