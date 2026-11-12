'use strict';

function isYouTube(value) {
  try {
    const url = new URL(value);
    return !url.username && !url.password &&
      ['https://youtube.com', 'https://www.youtube.com', 'https://m.youtube.com'].includes(url.origin);
  } catch { return false; }
}

// Self-contained so the main process can also apply a changed preference.
function setYouTubeAppearance(mode) {
  const root = document.documentElement;
  if (!root || !['default', 'dark', 'light'].includes(mode)) return false;
  const key = 'data-bobo-youtube-theme', original = 'data-bobo-youtube-original-dark';
  const styleId = 'bobo-youtube-appearance';
  globalThis.boboYouTubeAppearance?.disconnect();
  if (!root.hasAttribute(original)) root.setAttribute(original, root.hasAttribute('dark') ? '1' : '0');
  root.setAttribute(key, mode);
  const enforce = () => {
    // Isolated worlds and SPA transitions share the current DOM mode.
    const current = root.getAttribute(key);
    if (!['dark', 'light'].includes(current)) return;
    const dark = current === 'dark', base = dark ? '#0f0f0f' : '#ffffff';
    if (root.hasAttribute('dark') !== dark) root.toggleAttribute('dark', dark);
    const css = `:root { color-scheme:${current} !important;
      --yt-spec-base-background:${base} !important;
      --yt-spec-raised-background:${dark ? '#272727' : '#f2f2f2'} !important;
      --yt-spec-menu-background:${dark ? '#282828' : '#ffffff'} !important;
      --yt-spec-general-background-a:${base} !important;
      --yt-spec-general-background-b:${base} !important;
      --yt-spec-text-primary:${dark ? '#f1f1f1' : '#0f0f0f'} !important;
      --yt-spec-text-secondary:${dark ? '#aaaaaa' : '#606060'} !important;
      --yt-spec-icon-active-other:${dark ? '#ffffff' : '#0f0f0f'} !important;
      --yt-spec-badge-chip-background:${dark ? '#272727' : '#f2f2f2'} !important;
      --yt-spec-10-percent-layer:${dark ? '#ffffff1a' : '#0000001a'} !important;
    }
    html, body, ytd-app, ytm-app, ytd-masthead, ytm-mobile-topbar-renderer {
      background-color:${base} !important; color:${dark ? '#f1f1f1' : '#0f0f0f'} !important;
      color-scheme:${current} !important;
    }`;
    let style = document.getElementById(styleId);
    if (!style) { style = document.createElement('style'); style.id = styleId; root.append(style); }
    if (style.textContent !== css) style.textContent = css;
  };
  if (mode === 'default') {
    document.getElementById(styleId)?.remove();
    root.toggleAttribute('dark', root.getAttribute(original) === '1');
    return true;
  }
  enforce();
  const observer = new MutationObserver(enforce);
  observer.observe(root, { attributes: true, attributeFilter: ['dark', key], childList: true, subtree: true });
  globalThis.boboYouTubeAppearance = observer;
  return root.hasAttribute('dark') === (mode === 'dark');
}

function installChannelShorts(ipcRenderer) {
  const videoId = value => {
    try {
      const url = new URL(value, location.href);
      if (!isYouTube(url.href)) return null;
      return url.pathname.match(/^\/shorts\/([A-Za-z0-9_-]{11})\/?$/)?.[1] || null;
    } catch { return null; }
  };
  const channelPage = () => /^\/(?:@[^/]+|(?:channel|c|user)\/[^/]+)(?:\/(?:shorts|featured|videos))?\/?$/.test(location.pathname);
  const query = value => ipcRenderer.sendSync('bobo:youtube:channel-shorts', value);
  let queue = query({ op: 'get' }), navigating = false, scheduled = false;
  let host, nativeStyle;
  const context = () => {
    const index = queue?.ids.indexOf(videoId(location.href)) ?? -1;
    return index < 0 ? null : { index, queue };
  };
  const editable = target => target instanceof Element &&
    target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="dialog"]');
  const move = (event, offset) => {
    const state = context();
    if (!event.isTrusted || !state) return false;
    event.preventDefault(); event.stopImmediatePropagation();
    if (navigating || state.index + offset < 0) return true;
    const next = queue.ids[state.index + offset];
    navigating = true;
    location.assign(next ? new URL('/shorts/' + next, location.origin).href : queue.channel);
    return true;
  };
  const render = () => {
    scheduled = false;
    const state = context();
    if (!state) { host?.remove(); nativeStyle?.remove(); return; }
    if (!document.documentElement) return;
    if (!host) {
      host = document.createElement('div'); host.id = 'bobo-channel-shorts-controls';
      const shadow = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = `:host { position:fixed!important; right:20px!important; top:50%!important;
        transform:translateY(-50%)!important; z-index:2147483000!important; display:flex!important;
        flex-direction:column!important; align-items:center!important; gap:12px!important; }
        button { width:48px;height:48px;border:1px solid #666;border-radius:50%;background:#272727;
          color:#fff;font:28px Arial;cursor:pointer; } button:hover { background:#444; }
        button:focus-visible { outline:3px solid #b8e9ff; } button:disabled { opacity:.45;cursor:default; }
        span { color:#eee;background:#202020;padding:3px 6px;border-radius:4px;font:11px Arial; }`;
      shadow.append(style);
      const previous = document.createElement('button'); previous.type = 'button';
      previous.id = 'previous'; previous.textContent = '↑'; previous.setAttribute('aria-label', 'Previous channel Short');
      previous.addEventListener('click', event => move(event, -1));
      const counter = document.createElement('span'); counter.id = 'counter';
      const next = document.createElement('button'); next.type = 'button';
      next.id = 'next'; next.textContent = '↓'; next.setAttribute('aria-label', 'Next channel Short');
      next.addEventListener('click', event => move(event, 1));
      shadow.append(previous, counter, next);
      nativeStyle = document.createElement('style'); nativeStyle.id = 'bobo-channel-shorts-native-controls';
      nativeStyle.textContent = '#navigation-button-down,#navigation-button-up,button[aria-label^="Next video"],button[aria-label^="Previous video"],button[title^="Next video"],button[title^="Previous video"]{display:none!important}';
    }
    const previous = host.shadowRoot.getElementById('previous');
    previous.disabled = state.index === 0;
    previous.title = previous.disabled ? 'First loaded Short in this channel' : 'Previous Short in this channel';
    host.shadowRoot.getElementById('next').title = state.index + 1 < queue.ids.length ? 'Next Short in this channel' : 'Return to this channel’s Shorts';
    host.shadowRoot.getElementById('counter').textContent = `${state.index + 1} / ${queue.ids.length}`;
    if (!nativeStyle.isConnected) document.documentElement.append(nativeStyle);
    if (!host.isConnected) document.documentElement.append(host);
  };
  const schedule = () => {
    if (!scheduled) { scheduled = true; queueMicrotask(render); }
  };
  const capture = event => {
    if (!event.isTrusted || event.button !== 0 || event.ctrlKey || event.shiftKey || event.altKey || event.metaKey || !channelPage()) return;
    const path = event.composedPath();
    const target = path.find(node => node instanceof Element);
    if (target?.closest('ytd-guide-renderer,ytd-mini-guide-renderer,nav,aside,header')) return;
    const anchor = path.find(node => node instanceof HTMLAnchorElement && node.hasAttribute('href')) || target?.closest('a[href]');
    const card = target?.closest('ytm-shorts-lockup-view-model,yt-lockup-view-model,ytd-reel-item-renderer');
    const link = anchor || card?.querySelector('a[href*="/shorts/"]');
    const selected = link && videoId(link.href);
    if (!selected || link.target && link.target !== '_self') return;
    const collection = link.closest('ytd-rich-grid-renderer,ytd-grid-renderer,ytm-rich-grid-renderer,ytd-reel-shelf-renderer') ||
      link.closest('ytd-browse,main,[role="main"]') ||
      document.querySelector('ytd-browse[page-subtype="channels"],main,[role="main"]') || card || link;
    const ids = [...new Set([...collection.querySelectorAll('a[href]')].map(a => videoId(a.href)).filter(Boolean))].slice(0, 500);
    if (!ids.includes(selected)) ids.push(selected);
    queue = query({ op: 'capture', ids: ids.slice(-500), selected });
  };
  // Capture before YouTube's pointer handler can replace a card or change the route.
  window.addEventListener('pointerdown', capture, true);
  window.addEventListener('click', event => {
    capture(event);
    if (!event.isTrusted || event.button !== 0 || event.ctrlKey || event.shiftKey || event.altKey || event.metaKey || editable(event.target)) return;
    const target = event.target instanceof Element ? event.target : null;
    const control = target?.closest('button,[role="button"]');
    if (!control || !context()) return;
    const label = control.getAttribute('aria-label') || control.getAttribute('title') || '';
    if (control.closest('#navigation-button-down') || /^Next video(?:\s|$)/i.test(label)) move(event, 1);
    else if (control.closest('#navigation-button-up') || /^Previous video(?:\s|$)/i.test(label)) move(event, -1);
  }, true);
  window.addEventListener('keydown', event => {
    if (editable(event.target) || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
    if (event.key === 'ArrowDown') move(event, 1);
    else if (event.key === 'ArrowUp') move(event, -1);
  }, true);
  window.addEventListener('wheel', event => {
    const target = event.target instanceof Element ? event.target : null;
    if (event.ctrlKey || Math.abs(event.deltaY) < 20 || Math.abs(event.deltaY) <= Math.abs(event.deltaX) ||
        !target || editable(target) ||
        target.closest('ytd-comments,ytd-engagement-panel-section-list-renderer,#comments,ytd-guide-renderer,ytd-mini-guide-renderer,nav,aside')) return;
    move(event, event.deltaY > 0 ? 1 : -1);
  }, { capture: true, passive: false });
  const refresh = () => { navigating = false; queue = query({ op: 'get' }); schedule(); };
  document.addEventListener('yt-navigate-finish', refresh);
  addEventListener('popstate', refresh);
  addEventListener('pageshow', refresh);
  new MutationObserver(schedule).observe(document, { childList: true, subtree: true });
  schedule();
}

if (typeof module !== 'undefined') module.exports = { isYouTube, setYouTubeAppearance };
if (typeof window !== 'undefined' && process.isMainFrame && isYouTube(location.href)) {
  const { ipcRenderer } = require('electron');
  // Only an in-memory appearance preference; no page API or secrets are exposed.
  const appearance = ipcRenderer.sendSync('bobo:youtube:appearance', { channelShorts: true });
  const mode = typeof appearance === 'string' ? appearance : appearance?.mode;
  if (!setYouTubeAppearance(mode)) {
    const observer = new MutationObserver(() => {
      if (setYouTubeAppearance(mode)) observer.disconnect();
    });
    observer.observe(document, { childList: true, subtree: true });
  }
  // A running development process may still have the previous main module loaded.
  if (appearance?.channelShorts === true) installChannelShorts(ipcRenderer);
}
