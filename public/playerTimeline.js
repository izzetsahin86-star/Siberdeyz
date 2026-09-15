function formatTime(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';

  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainingSeconds = total % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
  }

  return `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function attachPlaybackTimeline(player, elements) {
  const {
    root,
    currentTime,
    durationTime,
    progressFill,
    track,
  } = elements;

  let animationFrame = 0;
  let dragging = false;
  let activePointerId = null;
  let previewTime = 0;

  function getDuration() {
    const duration = Number(player.duration);
    return Number.isFinite(duration) && duration > 0 ? duration : 0;
  }

  function setVisual(time, duration) {
    const safeTime = clamp(Number(time) || 0, 0, duration || 0);
    const ratio = duration > 0 ? clamp(safeTime / duration, 0, 1) : 0;

    currentTime.textContent = formatTime(safeTime);
    durationTime.textContent = duration > 0 ? formatTime(duration) : '--:--';
    progressFill.style.transform = `scaleX(${ratio})`;
    track.style.setProperty('--timeline-progress', `${ratio * 100}%`);
    track.setAttribute('aria-valuemax', String(Math.round(duration || 0)));
    track.setAttribute('aria-valuenow', String(Math.round(safeTime)));
    track.setAttribute('aria-valuetext', formatTime(safeTime) + ' / ' + formatTime(duration));
  }

  function sync() {
    const duration = getDuration();
    const seekable = duration > 0;

    root.hidden = !seekable;
    track.tabIndex = seekable ? 0 : -1;

    if (!seekable) {
      dragging = false;
      activePointerId = null;
      setVisual(0, 0);
      return;
    }

    if (dragging) {
      setVisual(previewTime, duration);
      return;
    }

    setVisual(Number(player.currentTime) || 0, duration);
  }

  function frame() {
    sync();

    if (!player.paused && !player.ended) {
      animationFrame = requestAnimationFrame(frame);
    } else {
      animationFrame = 0;
    }
  }

  function start() {
    if (animationFrame) return;
    animationFrame = requestAnimationFrame(frame);
  }

  function stop() {
    if (animationFrame) {
      cancelAnimationFrame(animationFrame);
      animationFrame = 0;
    }

    sync();
  }

  function timeFromClientX(clientX) {
    const duration = getDuration();
    if (!duration) return 0;

    const rect = track.getBoundingClientRect();
    const ratio = clamp((clientX - rect.left) / Math.max(rect.width, 1), 0, 1);
    return ratio * duration;
  }

  function previewAt(clientX) {
    const duration = getDuration();
    if (!duration) return;

    previewTime = timeFromClientX(clientX);
    setVisual(previewTime, duration);
  }

  function commit(time) {
    const duration = getDuration();
    if (!duration) return;

    const target = clamp(Number(time) || 0, 0, duration);

    try {
      if (typeof player.fastSeek === 'function') {
        player.fastSeek(target);
      } else {
        player.currentTime = target;
      }
    } catch {
      player.currentTime = target;
    }
  }

  function onPointerDown(event) {
    if (!getDuration()) return;

    dragging = true;
    activePointerId = event.pointerId;
    previewAt(event.clientX);

    try {
      track.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is optional on older Safari versions.
    }

    event.preventDefault();
  }

  function onPointerMove(event) {
    if (!dragging || event.pointerId !== activePointerId) return;
    previewAt(event.clientX);
    event.preventDefault();
  }

  function finishPointer(event, cancelled = false) {
    if (!dragging || event.pointerId !== activePointerId) return;

    if (!cancelled) {
      previewAt(event.clientX);
      commit(previewTime);
    }

    dragging = false;
    activePointerId = null;

    try {
      track.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture release is optional.
    }

    sync();
  }

  function onKeyDown(event) {
    const duration = getDuration();
    if (!duration) return;

    const current = Number(player.currentTime) || 0;
    let target = null;

    if (event.key === 'ArrowLeft') target = current - 5;
    if (event.key === 'ArrowRight') target = current + 5;
    if (event.key === 'Home') target = 0;
    if (event.key === 'End') target = duration;

    if (target === null) return;

    event.preventDefault();
    commit(target);
    sync();
  }

  ['loadedmetadata', 'durationchange', 'timeupdate', 'seeking', 'seeked', 'ratechange', 'emptied']
    .forEach((eventName) => player.addEventListener(eventName, sync));

  player.addEventListener('play', start);
  player.addEventListener('pause', stop);
  player.addEventListener('ended', stop);

  track.addEventListener('pointerdown', onPointerDown);
  track.addEventListener('pointermove', onPointerMove, { passive: false });
  track.addEventListener('pointerup', (event) => finishPointer(event, false));
  track.addEventListener('pointercancel', (event) => finishPointer(event, true));
  track.addEventListener('keydown', onKeyDown);

  sync();

  return {
    sync,
    destroy() {
      stop();
    },
  };
}
