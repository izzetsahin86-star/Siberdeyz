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

export function attachPlaybackTimeline(player, elements) {
  const {
    root,
    currentTime,
    durationTime,
    progressFill,
  } = elements;

  let animationFrame = 0;

  function isFiniteDuration() {
    const duration = Number(player.duration);
    return Number.isFinite(duration) && duration > 0;
  }

  function sync() {
    const duration = Number(player.duration);
    const seekable = isFiniteDuration();

    root.hidden = !seekable;

    if (!seekable) {
      currentTime.textContent = '00:00';
      durationTime.textContent = '--:--';
      progressFill.style.transform = 'scaleX(0)';
      return;
    }

    const time = Math.min(Math.max(Number(player.currentTime) || 0, 0), duration);
    const ratio = duration > 0 ? Math.min(1, Math.max(0, time / duration)) : 0;

    currentTime.textContent = formatTime(time);
    durationTime.textContent = formatTime(duration);
    progressFill.style.transform = `scaleX(${ratio})`;
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

  ['loadedmetadata', 'durationchange', 'timeupdate', 'seeking', 'seeked', 'ratechange', 'emptied']
    .forEach((eventName) => player.addEventListener(eventName, sync));

  player.addEventListener('play', start);
  player.addEventListener('pause', stop);
  player.addEventListener('ended', stop);

  sync();

  return {
    sync,
    destroy() {
      stop();
    },
  };
}
