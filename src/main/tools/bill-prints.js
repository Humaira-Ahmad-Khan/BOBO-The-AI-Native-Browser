'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { net } = require('electron');
const { safeFileName } = require('./lib');

const PORTAL = 'https://elgcd.punjab.gov.pk';
const SCAN_SCRIPT = `(() => {
  if (location.origin !== ${JSON.stringify(PORTAL)}) return [];
  const items = [];
  for (const table of document.querySelectorAll('table, mat-table, [role="table"]')) {
    const headings = Array.from(table.querySelectorAll('th, mat-header-cell, [role="columnheader"]'),
      cell => cell.textContent.trim());
    const locality = headings.findIndex(label => /locality/i.test(label));
    if (locality < 0) continue;
    const sector = headings.findIndex(label => /sector/i.test(label));
    const bills = headings.findIndex(label => /bill count|(?:total|no\\.? of|number of)\\s*(?:water\\s*)?bills|^bills$/i.test(label));
    const fileNumber = headings.findIndex(label => /^file number$/i.test(label));
    const serial = headings.findIndex(label => /^sr\\s*#$/i.test(label));
    let rows = Array.from(table.querySelectorAll('tr, mat-row, [role="row"]'));
    try {
      const jq = window.jQuery;
      if (jq?.fn?.dataTable?.isDataTable(table)) {
        const loaded = jq(table).DataTable().rows({search: 'applied', order: 'applied'}).nodes().toArray();
        if (loaded.length) rows = loaded;
      }
    } catch {}
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('td, mat-cell, [role="cell"]'), cell => cell.textContent.trim());
      if (!cells[locality]) continue;
      for (const link of row.querySelectorAll('a[href], button, input[type="button"], [role="button"]')) {
        const label = (link.textContent || link.value || link.title || '').trim();
        let raw = link.getAttribute('href');
        if (!raw || /^(#|javascript:)/i.test(raw)) {
          const action = link.getAttribute('onclick') || '';
          raw = link.getAttribute('data-url') || link.getAttribute('data-href')
            || action.match(/(?:open\\s*\\(\\s*|location(?:\\.href)?\\s*=\\s*)['"]([^'"]+)['"]/)?.[1];
        }
        let url;
        try { if (raw) url = new URL(raw, document.baseURI); } catch {}
        const view = /^view$/i.test(label);
        if (!view && !(url && /\\.pdf$|print.*bill|bill.*print/i.test(url.pathname))) continue;
        if (url && (url.origin !== location.origin || url.href === location.href)) continue;
        if (!url && (!view || !link.isConnected || (bills < 0 && fileNumber < 0))) continue;
        const token = link.isConnected ? link.getAttribute('data-bobo-print-view') || crypto.randomUUID() : '';
        if (token) link.setAttribute('data-bobo-print-view', token);
        const rowKey = JSON.stringify(Array.from(row.querySelectorAll('td, mat-cell, [role="cell"]'))
          .filter(cell => !cell.contains(link) && !cell.querySelector('[data-bobo-print-view]'))
          .map(cell => cell.textContent.trim()));
        const billKey = JSON.stringify(cells.filter((_cell, index) => index !== serial
          && !/^(url|actions?)$/i.test(headings[index])));
        items.push({ url: url?.href, token, locality: cells[locality], sector: cells[sector] || '',
          bills: cells[bills] || '', fileNumber: cells[fileNumber] || '', rowKey, billKey });
        break;
      }
    }
  }
  return items;
})()`;

function portalUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === PORTAL && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

async function markBillSaved(item) {
  const wc = item.contents;
  if (!item.token || wc.isDestroyed() || wc.getURL() !== item.pageUrl) return;
  await wc.executeJavaScript(`(() => {
    if (location.href !== ${JSON.stringify(item.pageUrl)}) return;
    const link = document.querySelector('[data-bobo-print-view="' + ${JSON.stringify(item.token)} + '"]');
    const row = link?.closest('tr, mat-row, [role="row"]');
    if (!row || link.nextElementSibling?.hasAttribute('data-bobo-print-saved')) return;
    const rowKey = JSON.stringify(Array.from(row.querySelectorAll('td, mat-cell, [role="cell"]'))
      .filter(cell => !cell.contains(link) && !cell.querySelector('[data-bobo-print-view]'))
      .map(cell => cell.textContent.trim()));
    if (rowKey !== ${JSON.stringify(item.rowKey)}) return;
    const marker = document.createElement('span');
    marker.setAttribute('data-bobo-print-saved', '');
    marker.textContent = ' ✓ Saved';
    marker.style.color = '#17663b';
    marker.style.fontWeight = 'bold';
    link.after(marker);
  })()`);
}

async function resolveBillView(item, signal, timeout) {
  const wc = item.contents;
  if (wc.isDestroyed() || wc.getURL() !== item.pageUrl) {
    throw new Error('Return to this locality’s list page and scan it again.');
  }
  signal.throwIfAborted();
  const cancel = () => {
    if (!wc.isDestroyed() && wc.getURL() === item.pageUrl) {
      wc.executeJavaScript(`window.__boboCancelBillView?.()`).catch(() => {});
    }
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const result = await wc.executeJavaScript(`new Promise((resolve, reject) => {
      if (window.location.href !== ${JSON.stringify(item.pageUrl)}) { resolve(null); return; }
      const view = document.querySelector('[data-bobo-print-view="' + ${JSON.stringify(item.token)} + '"]');
      if (!view) { reject(new Error('Display the locality row and scan again.')); return; }
      const originalOpen = window.open;
      const preventHash = (event) => {
        if (event.target.closest('a[href^="#"]')) event.preventDefault();
      };
      const finish = (url) => {
        clearTimeout(timer);
        if (window.open === intercept) window.open = originalOpen;
        delete window.__boboCancelBillView;
        view.removeEventListener('click', preventHash, true);
        resolve(url);
      };
      const capture = (value) => {
        if (!value || value === 'about:blank') return;
        try { finish(new URL(String(value), document.baseURI).href); } catch { finish(null); }
      };
      const location = { assign: capture, replace: capture };
      Object.defineProperty(location, 'href', { set: capture });
      const popup = { close() {}, focus() {}, closed: false };
      Object.defineProperty(popup, 'location', { get: () => location, set: capture });
      const intercept = (url) => { capture(url); return popup; };
      const timer = setTimeout(() => finish(null), ${timeout});
      window.__boboCancelBillView = () => finish(null);
      window.open = intercept;
      view.addEventListener('click', preventHash, true);
      try { view.click(); } catch { finish(null); }
    })`);
    signal.throwIfAborted();
    if (!portalUrl(result)) throw new Error('View did not open a supported bill PDF.');
    return result;
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

function billPrintsFolder(parent, date = new Date()) {
  const stamp = [date.getDate(), date.getMonth() + 1, date.getFullYear() % 100]
    .map(value => String(value).padStart(2, '0')).join('');
  return path.join(parent, `${stamp} Bill Prints Download`);
}

async function saveBillPdf(browserSession, item, folder, signal) {
  let url = portalUrl(item.url);
  if (!url) throw new Error('Invalid portal download link.');
  signal.throwIfAborted();
  const requestPdf = (url) => new Promise((resolve, reject) => {
    const request = net.request({ url, session: browserSession, useSessionCookies: true, redirect: 'manual' });
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      reject(error);
      request.abort();
    };
    const abort = () => fail(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    request.on('error', fail);
    const redirect = (location) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      resolve({ location });
      request.abort();
    };
    request.on('redirect', (_status, _method, nextUrl) => redirect(nextUrl));
    request.on('response', (response) => {
      response.on('error', fail);
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        const location = response.headers.location;
        redirect(Array.isArray(location) ? location[0] : location);
        return;
      }
      if (response.statusCode !== 200) {
        fail(new Error(`Portal download failed (HTTP ${response.statusCode}).`));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > 128 * 1024 * 1024) fail(new Error('The PDF exceeds the 128 MB file limit.'));
        else chunks.push(chunk);
      });
      response.on('end', () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        resolve({ contents: Buffer.concat(chunks, size) });
      });
    });
    request.end();
  });
  let contents;
  for (let redirects = 0; ; redirects++) {
    signal.throwIfAborted();
    const result = await requestPdf(url);
    if (result.contents) {
      contents = result.contents;
      break;
    }
    if (!result.location || redirects >= 5) throw new Error('The portal did not finish redirecting to the bill PDF.');
    try { url = portalUrl(new URL(result.location, url)); } catch { url = null; }
    if (!url) throw new Error('The bill link redirected outside the supported portal.');
  }
  if (contents.subarray(0, 5).toString() !== '%PDF-') {
    throw new Error('The portal returned something other than a PDF. Check your login and the print link.');
  }
  let name = safeFileName(item.locality, 'Locality').replace(/[. ]+$/, '') || 'Locality';
  if (/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(name)) name = `_${name}`;
  for (let suffix = 1; ; suffix++) {
    signal.throwIfAborted();
    const filePath = path.join(folder, `${name}${suffix === 1 ? '' : ` (${suffix})`}.pdf`);
    const file = await fs.open(filePath, 'wx').catch((error) => {
      if (error.code !== 'EEXIST') throw error;
      return null;
    });
    if (!file) continue;
    try {
      await file.writeFile(contents);
      await file.close();
    } catch (error) {
      await file.close().catch(() => {});
      await fs.unlink(filePath).catch(() => {});
      throw error;
    }
    return { filePath, totalBytes: contents.length };
  }
}

module.exports = { SCAN_SCRIPT, portalUrl, billPrintsFolder, resolveBillView, saveBillPdf, markBillSaved };
