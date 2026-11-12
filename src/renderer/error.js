'use strict';

/**
 * BOBO navigation error page. Loaded into the failing tab by the main process
 * with ?code=&desc=&url= so the address bar keeps showing what was attempted.
 */

(() => {
  const api = window.bobo;
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code') || 'Error';
  const url = params.get('url') || '';

  // net error codes (Chromium) -> plain language
  const FRIENDLY = {
    '-6': 'BOBO does not know how to open this type of address.',
    '-7': 'The address could not be found. Check it for typos.',
    '-8': 'This address is overloaded at the moment. Try again shortly.',
    '-9': 'The server is not reachable right now.',
    '-101': 'The network connection was reset.',
    '-102': 'The server refused the connection.',
    '-103': 'The connection was interrupted.',
    '-104': 'The server took too long to respond.',
    '-105': 'The server could not be found. Check the address or your connection.',
    '-106': 'There is no internet connection.',
    '-107': 'The server presented an invalid security certificate.',
    '-110': 'The connection could not be securely established.',
    '-118': 'The server took too long to respond.',
    crashed: 'The page stopped responding and was stopped to protect BOBO.',
    'crash-loop': 'This page crashed several times, so BOBO did not reload it automatically.',
  };

  const description = FRIENDLY[code] || params.get('desc') || 'BOBO could not load this page.';

  document.getElementById('error-code').textContent = code;
  document.getElementById('error-desc').textContent = description;
  document.getElementById('error-url').textContent = url;

  const title = url ? (() => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  })() : '';
  if (title) document.title = `Can't reach ${title} - BOBO`;

  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action]');
    if (!target || !api) return;
    switch (target.dataset.action) {
      case 'retry':
        api.retry(null);
        break;
      case 'back':
        api.back(null);
        break;
      case 'home':
        api.home(null);
        break;
      case 'close':
        api.closeTab(null);
        break;
      default:
        break;
    }
  });

  if (api) {
    api
      .getState()
      .then((payload) => {
        if (!payload || !payload.theme) return;
        document.documentElement.dataset.theme = payload.theme;
      })
      .catch(() => {});
  }
})();
