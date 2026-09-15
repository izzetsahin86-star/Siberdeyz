function formatSeekTime(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';

  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remaining = total % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`;
  }

  return `${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function canSeek(player) {
  const duration = Number(player.duration);
  return Number.isFinite(duration) && duration > 0 && player.readyState > 0;
}

export function attachPlayerGestureSeek(player, overlay) {
  let gesture = null;
  let hideTimer = 0;

  function hideOverlay() {
    window.clearTimeout(hideTimer);
    overlay.root.hidden = true;
    overlay.root.dataset.direction = '';
  }

  function showOverlay(deltaSeconds, targetTime) {
    const rounded = Math.round(deltaSeconds / 5) * 5;
    const prefix = rounded >= 0 ? '+' : '−';
    const absolute = Math.abs(rounded);

    overlay.root.hidden = false;
    overlay.root.dataset.direction = rounded >= 0 ? 'forward' : 'backward';
    overlay.delta.textContent = prefix + formatSeekTime(absolute);
    overlay.target.textContent = formatSeekTime(targetTime);
  }

  function isNativeControlZone(event) {
    const rect = player.getBoundingClientRect();
    const localY = event.clientY - rect.top;
    const blockedHeight = Math.max(58, rect.height * 0.22);
    return localY >= rect.height - blockedHeight;
  }

  function targetForPointer(clientX) {
    if (!gesture) return null;

    const duration = Number(player.duration);
    const rect = gesture.rect;
    const dx = clientX - gesture.startX;
    const secondsPerFullWidth = 120;
    const rawDelta = (dx / Math.max(rect.width, 1)) * secondsPerFullWidth;
    const snappedDelta = Math.round(rawDelta / 5) * 5;
    const target = clamp(gesture.startTime + snappedDelta, 0, duration);

    return {
      delta: target - gesture.startTime,
      target,
      dx,
    };
  }

  function commitSeek(targetTime) {
    try {
      if (typeof player.fastSeek === 'function') {
        player.fastSeek(targetTime);
      } else {
        player.currentTime = targetTime;
      }
    } catch {
      player.currentTime = targetTime;
    }
  }

  function onPointerDown(event) {
    if (event.pointerType === 'mouse') return;
    if (!canSeek(player)) return;
    if (isNativeControlZone(event)) return;

    const rect = player.getBoundingClientRect();
    gesture = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startTime: Number(player.currentTime) || 0,
      rect,
      active: false,
      lastTarget: Number(player.currentTime) || 0,
    };

    try {
      player.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is optional on some Safari versions.
    }
  }

  function onPointerMove(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;

    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;

    if (!gesture.active) {
      if (Math.abs(dx) < 14) return;
      if (Math.abs(dx) <= Math.abs(dy) * 1.25) {
        gesture = null;
        hideOverlay();
        return;
      }

      gesture.active = true;
    }

    event.preventDefault();

    const next = targetForPointer(event.clientX);
    if (!next) return;

    gesture.lastTarget = next.target;
    showOverlay(next.delta, next.target);
  }

  function finishPointer(event, cancelled = false) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;

    const currentGesture = gesture;
    gesture = null;

    try {
      player.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture release is optional.
    }

    if (!cancelled && currentGesture.active) {
      const delta = currentGesture.lastTarget - currentGesture.startTime;
      if (Math.abs(delta) >= 5) {
        commitSeek(currentGesture.lastTarget);
      }
    }

    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(hideOverlay, 320);
  }

  player.addEventListener('pointerdown', onPointerDown);
  player.addEventListener('pointermove', onPointerMove, { passive: false });
  player.addEventListener('pointerup', (event) => finishPointer(event, false));
  player.addEventListener('pointercancel', (event) => finishPointer(event, true));
  player.addEventListener('lostpointercapture', () => {
    if (!gesture) return;
    gesture = null;
    hideOverlay();
  });

  player.addEventListener('emptied', hideOverlay);
  player.addEventListener('ended', hideOverlay);

  return {
    destroy() {
      hideOverlay();
    },
  };
}
