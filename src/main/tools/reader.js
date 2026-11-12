'use strict';

/**
 * Reader mode extraction.
 *
 * Security model:
 *   - the extraction script is a FIXED string (no interpolation, no arguments),
 *     so a page can never influence the code that runs against it;
 *   - inputs, textareas, selects, buttons and forms are removed before any text
 *     is read, so passwords, form values and hidden fields cannot leak;
 *   - every attribute is ignored; only text nodes are returned;
 *   - the URL considered authoritative is the one the main process knows
 *     (`webContents.getURL()`), never one the page claims;
 *   - pages with a visible password field, auth-looking URLs or hosts on the
 *     sensitive list are refused outright.
 */

const { isAllowedNavigationUrl } = require('../navigation');
const { isSensitiveUrl } = require('./format');
const { LIMITS } = require('./lib');

/** Fixed script. Deliberately a constant: never build this from user input. */
const EXTRACT_SCRIPT = `(() => {
  const DROP = 'script,style,noscript,template,iframe,frame,object,embed,svg,canvas,input,textarea,select,option,button,form,nav,footer,[hidden],[aria-hidden="true"]';
  const LIMITS = { blocks: 500, chars: 300000 };

  const passwordFields = Array.from(document.querySelectorAll('input[type="password"]'))
    .filter((element) => element.getClientRects().length > 0).length;

  const root = document.querySelector('article, main, [role="main"]') || document.body;
  if (!root) return { ok: false, error: 'This page has no readable content.' };

  const copy = root.cloneNode(true);
  copy.querySelectorAll(DROP).forEach((element) => element.remove());

  const nodes = Array.from(copy.querySelectorAll('h1,h2,h3,h4,p,li,blockquote,pre'));
  const blocks = [];
  let reason = '';
  let chars = 0;
  let previous = '';

  for (const node of nodes) {
    const heading = /^H[1-4]$/.test(node.tagName);
    const value = (node.textContent || '').replace(/\\s+/g, ' ').trim();
    if (!value || value === previous) continue;
    if (!heading && value.length < (node.tagName === 'LI' ? 20 : 40)) continue;

    previous = value;
    blocks.push({ kind: heading ? 'heading' : 'text', text: value });
    chars += value.length;
    if (blocks.length >= LIMITS.blocks || chars >= LIMITS.chars) {
      reason = 'The page was longer than BOBO Reader keeps at once; the start is shown.';
      break;
    }
  }

  if (!blocks.length) {
    const fallback = (copy.textContent || '').replace(/\\s+/g, ' ').trim();
    if (!fallback) return { ok: false, error: 'BOBO found no readable text on this page.' };
    blocks.push({ kind: 'text', text: fallback.slice(0, LIMITS.chars) });
  }

  return {
    ok: true,
    title: String(document.title || '').slice(0, 200),
    blocks,
    text: blocks.map((block) => block.text).join('\\n\\n').slice(0, LIMITS.chars),
    passwordFields,
    truncated: reason
  };
})()`;

/**
 * Mechanics only - no URL policy. Exported for the e2e check, which runs it
 * against a local fixture page.
 *
 * @param {import('electron').WebContents|null} webContents
 */
async function extractFrom(webContents) {
  if (!webContents || webContents.isDestroyed()) {
    return { ok: false, error: 'Open a page in a tab first.' };
  }

  try {
    const result = await webContents.executeJavaScript(EXTRACT_SCRIPT, false);
    if (!result || result.ok !== true) {
      return { ok: false, error: (result && result.error) || 'BOBO found no readable text on this page.' };
    }
    return { ...result, text: String(result.text || '').slice(0, LIMITS.text) };
  } catch (error) {
    return { ok: false, error: `BOBO Reader could not read this page: ${error.message}` };
  }
}

/**
 * Reader entry point used by the app: apply the URL policy, then extract.
 *
 * @param {import('electron').WebContents|null} webContents
 */
async function extract(webContents) {
  if (!webContents || webContents.isDestroyed()) {
    return { ok: false, error: 'Open a page in a tab first.' };
  }

  const url = webContents.getURL();

  if (!isAllowedNavigationUrl(url)) {
    return { ok: false, error: 'BOBO Reader only reads http and https pages.' };
  }
  if (isSensitiveUrl(url)) {
    return {
      ok: false,
      error: 'BOBO Reader stays out of sign-in, webmail, banking and password-manager pages.',
    };
  }

  const document = await extractFrom(webContents);
  if (!document.ok) return document;

  if (document.passwordFields > 0) {
    return {
      ok: false,
      error: 'This page contains a sign-in form, so BOBO Reader will not read it.',
    };
  }

  return {
    ok: true,
    title: document.title,
    url,
    blocks: document.blocks,
    text: document.text,
    truncated: document.truncated || '',
  };
}

/**
 * Comprehensive script that finds PDF URLs from the page by checking:
 * 1. Performance API — catches every network request JS made (PDF.js, XHR, fetch)
 * 2. DOM elements — iframe, embed, object
 * 3. PDF.js / Google Docs viewer iframes
 * 4. All script tag contents (finds PDF URLs in JS variables/configs)
 * 5. Full HTML source scan (catches data-* attrs, inline JSON, etc.)
 * 6. Anchor tags
 * Never interpolated — purely a constant.
 */
const FIND_PDF_SCRIPT = `(() => {
  const found = new Set();
  const isPdf = (s) => s && /\\.pdf(\\?|#|$)/i.test(s);
  const addUrl = (s) => { try { found.add(new URL(String(s), location.href).href); } catch {} };

  // 1. Performance API: captures every resource the page fetched including JS-loaded PDFs
  try {
    for (const entry of performance.getEntriesByType('resource')) {
      if (isPdf(entry.name)) addUrl(entry.name);
    }
  } catch {}

  // 2. Direct DOM embeds
  for (const el of document.querySelectorAll('embed[src], object[data]')) {
    const src = (el.getAttribute('src') || el.getAttribute('data') || '').trim();
    if (isPdf(src)) addUrl(src);
  }

  // 3. iframes: direct PDF, PDF.js viewer, Google Docs/Drive viewer, lazy-loaded
  for (const el of document.querySelectorAll('iframe')) {
    const raw = (el.getAttribute('src') || el.getAttribute('data-src') || '').trim();
    if (!raw) continue;
    if (isPdf(raw)) { addUrl(raw); continue; }
    try {
      const u = new URL(raw, location.href);
      const fileParam = u.searchParams.get('file') || u.searchParams.get('pdf') || '';
      if (fileParam && isPdf(fileParam)) { addUrl(fileParam); continue; }
      if (u.hash && isPdf(decodeURIComponent(u.hash.slice(1)))) {
        addUrl(decodeURIComponent(u.hash.slice(1))); continue;
      }
      // Google Drive file preview: drive.google.com/file/d/{id}/preview or /view
      if (u.hostname === 'drive.google.com') {
        const m = u.pathname.match(/\\/file\\/d\\/([^/]+)\\//);
        if (m) { found.add('https://drive.google.com/uc?export=download&id=' + m[1]); continue; }
      }
      // Google Docs viewer
      if (u.hostname === 'docs.google.com') {
        const gUrl = u.searchParams.get('url') || u.searchParams.get('embedded') || '';
        if (isPdf(gUrl)) { addUrl(gUrl); continue; }
        const m2 = u.pathname.match(/\\/file\\/d\\/([^/]+)\\//);
        if (m2) { found.add('https://drive.google.com/uc?export=download&id=' + m2[1]); continue; }
      }
    } catch {}
  }

  // 4. Scan script tag text for PDF URL patterns (catches JS variables like pdfUrl = "...")
  const pdfUrlRe = /https?:\\/\\/[^\\s'"<>\\\\]+\\.pdf(?:[?#][^\\s'"<>\\\\]*)?/gi;
  for (const el of document.querySelectorAll('script')) {
    const text = el.textContent || '';
    for (const match of text.matchAll(pdfUrlRe)) addUrl(match[0]);
  }

  // 5. Full HTML source scan (data-* attributes, inline JSON, noscript blocks, etc.)
  if (!found.size) {
    for (const match of (document.documentElement.innerHTML || '').matchAll(pdfUrlRe)) {
      addUrl(match[0]);
    }
  }

  // 6. Anchor tags
  for (const el of document.querySelectorAll('a[href]')) {
    if (isPdf(el.getAttribute('href') || '')) addUrl(el.href);
  }

  // Prefer same-origin PDFs first, then others
  const all = [...found];
  const sameOrigin = all.filter(u => { try { return new URL(u).origin === location.origin; } catch { return false; } });
  return (sameOrigin.length ? sameOrigin : all).slice(0, 10);
})()`;

/**
 * Find embedded PDF URLs in the active tab.
 * @param {import('electron').WebContents|null} webContents
 */
async function findEmbeddedPdfs(webContents) {
  if (!webContents || webContents.isDestroyed()) {
    return { ok: false, error: 'No active tab.' };
  }
  try {
    const urls = await webContents.executeJavaScript(FIND_PDF_SCRIPT, false);
    if (!Array.isArray(urls) || !urls.length) {
      return { ok: false, error: 'No embedded PDF found on this page.' };
    }
    return { ok: true, urls };
  } catch (error) {
    return { ok: false, error: `Could not scan page: ${error.message}` };
  }
}

module.exports = { EXTRACT_SCRIPT, FIND_PDF_SCRIPT, extract, extractFrom, findEmbeddedPdfs };
