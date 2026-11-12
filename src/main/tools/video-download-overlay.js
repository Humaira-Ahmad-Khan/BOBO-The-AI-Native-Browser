'use strict';

const { classifyVideo, playerVideoSource } = require('./social-video');
const watches = new WeakMap();

function attachVideoButton() {
  globalThis.boboRemoveVideoButton?.();
  const events = new AbortController();
  let selected;
  const buttons = new Map();

  function source(video) {
    if (!video?.isConnected || video.mediaKeys) return '';
    try {
      const url = new URL(video.currentSrc || video.src || video.querySelector('source[src]')?.src);
      return url.protocol === 'https:' && !url.username && !url.password &&
        /\.(mp4|webm|ogv|ogg)$/i.test(url.pathname) ? url.href : '';
    } catch { return ''; }
  }
  function createButton(video) {
    const button = document.createElement('button');
    button.type = 'button';
    button.style.cssText = 'position:fixed;z-index:2147483647;padding:7px 11px;border:1px solid #8dc4db;border-radius:7px;background:#172633;color:white;font:13px system-ui;cursor:pointer';
    button.addEventListener('click', (event) => {
      if (!event.isTrusted) return;
      event.preventDefault();
      event.stopPropagation();
      if (visibleRect(video)) selected = source(video);
    });
    document.documentElement.append(button);
    return button;
  }
  function visibleRect(video) {
    if (!video.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return null;
    const rect = video.getBoundingClientRect();
    const width = Math.min(innerWidth, rect.right) - Math.max(0, rect.left);
    const height = Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top);
    return width >= 180 && height >= 85 ? rect : null;
  }
  function refresh() {
    const visible = new Set();
    for (const video of [...document.querySelectorAll('video')].slice(0, 100)) {
      const rect = visibleRect(video);
      if (!rect) continue;
      visible.add(video);
      const button = buttons.get(video) || createButton(video);
      buttons.set(video, button);
      const available = Boolean(source(video));
      const label = available ? 'Download video' : 'Download unavailable';
      if (button.textContent !== label) button.textContent = label;
      button.disabled = !available;
      button.title = available ? 'Save this video with BOBO' : 'This player does not expose a supported video file.';
      button.style.opacity = available ? '1' : '0.7';
      button.style.top = `${Math.max(8, rect.top + 8)}px`;
      button.style.left = `${Math.max(8, Math.min(innerWidth, rect.right) - button.offsetWidth - 8)}px`;
    }
    for (const [video, button] of buttons) {
      if (visible.has(video)) continue;
      button.remove();
      buttons.delete(video);
    }
  }
  document.addEventListener('scroll', refresh, { passive: true, capture: true, signal: events.signal });
  window.addEventListener('resize', refresh, { signal: events.signal });
  const timer = setInterval(refresh, 350);
  refresh();
  globalThis.boboTakeVideoDownload = () => {
    const value = selected;
    selected = '';
    return value || null;
  };
  globalThis.boboRemoveVideoButton = () => {
    events.abort();
    clearInterval(timer);
    for (const button of buttons.values()) button.remove();
    delete globalThis.boboTakeVideoDownload;
    delete globalThis.boboRemoveVideoButton;
  };
}

async function watchVideoDownloads(contents, currentWindow, download, enabled) {
  if (!contents || contents.isDestroyed()) return;
  if (enabled && watches.has(contents)) return;
  watches.get(contents)?.();
  const url = contents.getURL();
  if (!download || classifyVideo(url).platform === 'Direct media') return;
  if (!enabled) {
    await contents.executeJavaScriptInIsolatedWorld(1104, [{ code: 'globalThis.boboRemoveVideoButton?.()' }]);
    return;
  }
  const origin = new URL(url).origin;
  const frame = contents.mainFrame;
  let timer;
  let stopped = false;
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    contents.removeListener('destroyed', stop);
    contents.removeListener('did-navigate', stop);
    watches.delete(contents);
  };
  watches.set(contents, stop);
  contents.once('destroyed', stop);
  contents.once('did-navigate', stop);
  const run = (code) => contents.executeJavaScriptInIsolatedWorld(1104, [{ code }]);
  try {
    await run(`if (location.origin === ${JSON.stringify(origin)}) (${attachVideoButton.toString()})()`);
  } catch {
    return stop();
  }
  async function poll() {
    if (stopped) return;
    const window = currentWindow();
    try {
      if (window) {
        const url = playerVideoSource(await run('globalThis.boboTakeVideoDownload?.() ?? null'));
        if (url && !stopped && contents.mainFrame === frame && currentWindow() === window) {
          await download(window, url);
        }
      }
    } catch (error) {
      if (!stopped && currentWindow() === window) {
        const { dialog } = require('electron');
        dialog.showErrorBox('BOBO Video Downloader', error.message);
      }
    }
    if (!stopped) timer = setTimeout(poll, 350);
  }
  if (!stopped) timer = setTimeout(poll, 350);
}

module.exports = { watchVideoDownloads };
