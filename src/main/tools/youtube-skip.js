'use strict';

const { isYouTube } = require('../youtube-theme');
const polling = new WeakMap();

function watchSkipButton(enabled) {
  globalThis.boboSkipObserver?.();
  delete globalThis.boboSkipObserver;
  if (!enabled) return;
  let attempted;
  let clicked = new WeakSet();
  const selector = '.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern';
  const controls = 'button, [role="button"]';
  const adControls = '.ytp-ad-module, .ytp-ad-skip-button-container, .ytp-skip-ad-button-container';
  const check = () => {
    const player = document.querySelector('#movie_player');
    if (!player) return;
    const playingAd = player.matches('.ad-showing, .ad-interrupting');
    for (const button of player.querySelectorAll(controls)) {
      const knownSkip = button.matches(selector) || button.closest(selector);
      const label = button.getAttribute('aria-label') || button.textContent;
      const labelledSkip = /^(skip|skip ads?)$/i.test(label.trim());
      if (!(knownSkip || (labelledSkip && (playingAd || button.closest(adControls))))) continue;
      if (button.matches(':disabled') || button.closest('[aria-disabled="true"], [inert]') ||
          !button.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true }) ||
          !button.getBoundingClientRect().width || !button.getBoundingClientRect().height) {
        clicked.delete(button);
        continue;
      }
      if (clicked.has(button)) continue;
      clicked.add(button);
      attempted = { button, at: performance.now() };
      button.click();
      break;
    }
  };
  let pending = null;
  const schedule = () => {
    if (pending != null) return;
    pending = setTimeout(() => { pending = null; check(); }, 40);
  };
  const observer = new MutationObserver((records) => {
    for (const { target, attributeName } of records) {
      if ((attributeName === 'disabled' && target.disabled) ||
          (attributeName === 'aria-disabled' && target.getAttribute('aria-disabled') === 'true')) clicked.delete(target);
      if (attributeName === 'class' && target.id === 'movie_player' &&
          !target.matches('.ad-showing, .ad-interrupting')) {
        clicked = new WeakSet();
      }
    }
    schedule();
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true,
    characterData: true, attributeFilter: ['class', 'disabled', 'aria-disabled', 'aria-label', 'style', 'hidden', 'inert'] });
  document.addEventListener('transitionend', schedule, true);
  document.addEventListener('animationend', schedule, true);
  globalThis.boboSkipFallback = () => {
    if (!attempted || performance.now() - attempted.at < 350) return null;
    const { button } = attempted;
    attempted = null;
    if (!button.closest('#movie_player') || button.matches(':disabled') ||
        button.closest('[aria-disabled="true"], [inert]') || !button.checkVisibility({
          opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true,
        })) return null;
    const { x, y, width, height } = button.getBoundingClientRect();
    const center = { x: x + width / 2, y: y + height / 2 };
    if (!width || !height || !button.contains(document.elementFromPoint(center.x, center.y))) return null;
    return center;
  };
  globalThis.boboSkipObserver = () => {
    observer.disconnect();
    clearTimeout(pending);
    document.removeEventListener('transitionend', schedule, true);
    document.removeEventListener('animationend', schedule, true);
    delete globalThis.boboSkipFallback;
  };
  check();
}

async function setYouTubeAutoSkip(contents, enabled, canClick = () => false) {
  if (!contents || contents.isDestroyed()) return;
  polling.get(contents)?.();
  polling.delete(contents);
  if (!isYouTube(contents.getURL())) return;
  const run = (code) => contents.executeJavaScriptInIsolatedWorld(1103, [{ code }]);
  let timer;
  let stopped = false;
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    contents.removeListener('destroyed', stop);
    contents.removeListener('did-navigate', stop);
  };
  polling.set(contents, stop);
  contents.once('destroyed', stop);
  contents.once('did-navigate', stop);
  try {
    await run(`if ((${isYouTube.toString()})(location.href)) (${watchSkipButton.toString()})(${enabled === true});`);
  } catch (error) {
    stop();
    throw error;
  }
  if (!enabled || stopped) return stop();
  const check = async () => {
    if (stopped) return;
    try {
      const url = contents.getURL();
      if (canClick() && isYouTube(url)) {
        const point = await run('globalThis.boboSkipFallback?.() ?? null');
        if (point && !stopped && canClick() && contents.getURL() === url) {
          const zoom = contents.getZoomFactor();
          const input = { x: Math.round(point.x * zoom), y: Math.round(point.y * zoom), button: 'left', clickCount: 1 };
          contents.sendInputEvent({ ...input, type: 'mouseDown' });
          contents.sendInputEvent({ ...input, type: 'mouseUp' });
        }
      }
    } catch {
      return stop();
    }
    if (!stopped) timer = setTimeout(check, 250);
  };
  timer = setTimeout(check, 250);
}

module.exports = { setYouTubeAutoSkip };
