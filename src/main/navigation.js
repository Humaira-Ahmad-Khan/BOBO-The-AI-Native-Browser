'use strict';

/**
 * Address-bar input resolution and local-URL policy: decides whether omnibox
 * text is a URL to visit or a search query, and which file: URLs count as
 * BOBO's own trusted pages.
 *
 * Deliberately pure - no Electron imports - so `node --test tests/unit` can load
 * this file with plain Node and no installed dependencies.
 */

const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { DEFAULT_SEARCH_ENGINE, searchUrl } = require('./search');

const DEFAULT_SEARCH_URL = searchUrl(DEFAULT_SEARCH_ENGINE);

/** BOBO's trusted UI lives here; nothing outside it may call into main. */
const LOCAL_RENDERER_DIR = path.resolve(__dirname, '../renderer');

/** Ceiling: omnibox input longer than this is rejected at the IPC boundary. */
const MAX_INPUT = 4096;

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const LOCAL_RE = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(?:[/?#].*)?$/i;
const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d{1,5})?(?:[/?#].*)?$/i;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?(?:[/?#].*)?$/;

/**
 * Normalise a value to an http(s) URL, or null when it is not a navigable URL.
 * Anything that is not http/https (javascript:, data:, file:, ftp:, ...) is null,
 * so callers can never be talked into navigating to a dangerous scheme.
 */
function toHttpUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname) return null;
    return url.href;
  } catch {
    return null;
  }
}

function isAllowedNavigationUrl(value) {
  return toHttpUrl(value) !== null;
}

function searchResult(query, searchUrl) {
  return { kind: 'search', url: `${searchUrl}${encodeURIComponent(query)}` };
}

/**
 * @param {unknown} raw raw omnibox text
 * @param {string} [searchUrl] search engine base URL, must end with the query placeholder
 * @returns {{kind: 'url'|'search', url: string}|null} null for empty input
 */
function resolveInput(raw, searchUrl = DEFAULT_SEARCH_URL) {
  if (typeof raw !== 'string') return null;

  const input = raw.trim();
  if (!input || input.length > MAX_INPUT) return null;

  // Protocol-relative: //cdn.example.com/x
  if (input.startsWith('//')) {
    const url = toHttpUrl(`https:${input}`);
    return url ? { kind: 'url', url } : searchResult(input, searchUrl);
  }

  // Explicit http(s): keep the user's scheme, normalise the rest.
  if (/^https?:\/\//i.test(input)) {
    const url = toHttpUrl(input);
    return url ? { kind: 'url', url } : searchResult(input, searchUrl);
  }

  // Local development origins default to http, like every other browser.
  if (LOCAL_RE.test(input)) {
    const url = toHttpUrl(`http://${input}`);
    if (url) return { kind: 'url', url };
  }

  // Bare host first: "example.com:8080" must not be mistaken for the scheme
  // "example.com:" by the generic scheme check below.
  if (HOST_RE.test(input) || IPV4_RE.test(input)) {
    const url = toHttpUrl(`https://${input}`);
    if (url) return { kind: 'url', url };
  }

  // Any other scheme (javascript:, data:, file:, mailto:, ftp:, ...) is never
  // navigated to from the omnibox - it is treated as a search instead.
  if (SCHEME_RE.test(input)) return searchResult(input, searchUrl);

  return searchResult(input, searchUrl);
}

/**
 * True when `value` is a file: URL resolving to a file inside src/renderer/.
 * This is the IPC trust boundary: remote http(s) pages, and any file:// outside
 * the app's own UI (including path traversal), return false.
 */
function isLocalRendererUrl(value) {
  if (typeof value !== 'string' || !value.startsWith('file:')) return false;
  try {
    const filePath = path.resolve(fileURLToPath(value));
    const relative = path.relative(LOCAL_RENDERER_DIR, filePath);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}

module.exports = {
  DEFAULT_SEARCH_URL,
  LOCAL_RENDERER_DIR,
  MAX_INPUT,
  isAllowedNavigationUrl,
  isLocalRendererUrl,
  resolveInput,
  toHttpUrl,
};
