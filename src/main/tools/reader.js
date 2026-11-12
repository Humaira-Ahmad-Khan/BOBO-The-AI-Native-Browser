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

module.exports = { EXTRACT_SCRIPT, extract, extractFrom };
