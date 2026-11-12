'use strict';

function alternateWatchUrl(input) {
  try {
    const text = input.trim();
    const url = new URL(/^(?:www\.|m\.)?youtube\.com\//i.test(text) ? `https://${text}` : text);
    if (!['https://youtube.com', 'https://www.youtube.com', 'https://m.youtube.com'].includes(url.origin) ||
        url.username || url.password || url.pathname !== '/watch') return null;
    const video = url.searchParams.get('v');
    if (!/^[A-Za-z0-9_-]{11}$/.test(video ?? '')) return null;
    return `https://www.yout-ube.com/watch?v=${video}`;
  } catch {
    return null;
  }
}

async function setAlternateVideoClicks(contents, enabled) {
  if (!contents || contents.isDestroyed()) return;
  const { isYouTube } = require('../youtube-theme');
  if (!isYouTube(contents.getURL())) return;
  await contents.executeJavaScriptInIsolatedWorld(1105, [{ code: `(() => {
    if (!(${isYouTube.toString()})(location.href)) return;
    globalThis.boboAlternateVideoClicks = ${enabled === true};
    if (globalThis.boboAlternateListener) return;
    globalThis.boboAlternateListener = true;
    window.addEventListener('click', (event) => {
      if (!globalThis.boboAlternateVideoClicks || !event.isTrusted || event.button !== 0 ||
          event.ctrlKey || event.shiftKey || event.altKey || event.metaKey ||
          !['/', '/results'].includes(location.pathname)) return;
      const anchor = event.target instanceof Element && event.target.closest('a[href]');
      const alternate = anchor && (${alternateWatchUrl.toString()})(anchor.href);
      if (!alternate) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      window.open(alternate, '_blank', 'noopener,noreferrer');
    }, true);
  })()` }]);
}

module.exports = { alternateWatchUrl, setAlternateVideoClicks };
