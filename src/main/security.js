'use strict';

/**
 * Main-process security controls.
 *
 * Two jobs:
 *   1. Sender validation for IPC - only BOBO's own local pages (src/renderer/**)
 *      may call into the main process. Remote sites get a rejected promise.
 *   2. Hardening every WebContents created by the app: no <webview>, no
 *      out-of-scheme navigation, no popups, no web permissions.
 */

const { app, session } = require('electron');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { isAllowedNavigationUrl, isLocalRendererUrl, LOCAL_RENDERER_DIR } = require('./navigation');
const pageChannels = require('./ipc-roles');

function authorizeChannel(event, owner, channel) {
  const sender = event.sender;
  const frame = event.senderFrame;
  if (!owner || !frame || sender.isDestroyed() || frame !== sender.mainFrame || frame.url !== sender.getURL()) {
    throw new Error('BOBO: blocked IPC from an untrusted frame');
  }
  let file;
  try { file = fileURLToPath(frame.url); } catch {
    throw new Error('BOBO: blocked IPC from an untrusted page');
  }
  const page = path.basename(file, '.html');
  if (file !== path.join(LOCAL_RENDERER_DIR, `${page}.html`)) {
    throw new Error('BOBO: blocked IPC from an untrusted page');
  }
  const chrome = sender === owner.window.webContents;
  const allowed = chrome === (page === 'index') &&
    Object.hasOwn(pageChannels, page) && pageChannels[page].includes(channel);
  if (!allowed) throw new Error('BOBO: IPC operation is not allowed on this page');
}

/** True when the IPC event came from one of BOBO's own pages. */
function isTrustedSender(event) {
  try {
    const frame = event && event.senderFrame;
    if (!frame) return false;
    return isLocalRendererUrl(frame.url);
  } catch {
    return false;
  }
}

/** Reject an IPC call unless its sender is one of our own pages. */
function assertTrusted(event) {
  if (!isTrustedSender(event)) throw new Error('BOBO: blocked IPC from an untrusted sender');
}

/**
 * Apply hardening to every WebContents the app creates.
 *
 * @param {{ onNewWindow?: (url: string) => void }} options
 *        onNewWindow: open an http(s) window.open() target in a BOBO tab.
 */
function fullscreenPermission(contents, permission, details, canFullscreen) {
  if (permission !== 'fullscreen' || !contents || contents.isDestroyed() ||
      details?.isMainFrame !== true || !canFullscreen?.(contents)) return false;
  try {
    const page = new URL(contents.getURL());
    const requesting = new URL(details.requestingUrl);
    return ['http:', 'https:'].includes(page.protocol) && requesting.origin === page.origin;
  } catch { return false; }
}

function hardenApp({ onNewWindow, canFullscreen, onFullscreenRequest } = {}) {
  // --- Certificate policy -------------------------------------------------
  // BOBO registers NO `certificate-error` handler. Electron's default for an
  // untrusted certificate is to REJECT the navigation (no bypass), and that
  // default is exactly what we want. Any future handler here must call
  // callback(false) - never true - and must never be added just to make a site
  // load. Certificate failures surface on the local error page (ERR_CERT_*).

  // Ordinary fullscreen is available to the active page. Other permissions default to deny.
  const defaultSession = session.defaultSession;
  defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const allowed = fullscreenPermission(contents, permission, details, canFullscreen);
    if (allowed) onFullscreenRequest?.(contents);
    callback(allowed);
  });
  defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) =>
    fullscreenPermission(contents, permission, details, canFullscreen));

  app.on('web-contents-created', (_event, contents) => {
    // <webview> is banned outright; the tag is also disabled in webPreferences.
    contents.on('will-attach-webview', (attachEvent) => attachEvent.preventDefault());

    // Navigation is limited to http/https, whatever initiated it.
    contents.on('will-navigate', (navigateEvent, url) => {
      if (!isAllowedNavigationUrl(url)) navigateEvent.preventDefault();
    });

    // Server-side redirects do NOT raise will-navigate - only will-redirect.
    // Without this check a valid https URL could 30x to a file:, javascript:
    // or other dangerous scheme. A blocked redirect leaves the tab on the last
    // committed (safe) URL.
    contents.on('will-redirect', (redirectEvent, url) => {
      if (!isAllowedNavigationUrl(url)) redirectEvent.preventDefault();
    });

    // A page must not be able to block its own tab from closing.
    contents.on('will-prevent-unload', (unloadEvent) => unloadEvent.preventDefault());

    // window.open / target=_blank: never a new OS window, never an unvalidated URL.
    contents.setWindowOpenHandler(({ url }) => {
      if (isAllowedNavigationUrl(url)) onNewWindow?.(url, contents);
      return { action: 'deny' };
    });
  });
}

module.exports = {
  RENDERER_DIR: LOCAL_RENDERER_DIR,
  assertTrusted,
  authorizeChannel,
  hardenApp,
  fullscreenPermission,
  isLocalRendererUrl,
  isTrustedSender,
};
