'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { reserveDownloadPath } = require('../downloads');
const { browserUserAgent } = require('../browser-user-agent');

const REPORT_URL = 'https://elgcd.punjab.gov.pk/e-billing/water-receipt-date-wise-report';

function reportDate(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Karachi', day: '2-digit', month: '2-digit', year: 'numeric',
  }).formatToParts(now).map(({ type, value }) => [type, value]));
  return { display: `${parts.day}/${parts.month}/${parts.year}`,
    iso: `${parts.year}-${parts.month}-${parts.day}`,
    name: `${parts.day}-${parts.month}-${parts.year.slice(-2)} Daily Receive Amount` };
}

// Executed only in our dedicated, same-profile report page; never exposes a bridge.
async function reportControls(action, date) {
  const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
  const visible = el => el && el.getClientRects().length && !el.disabled &&
    el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  const matchesDate = value => {
    const text = normalize(value);
    if (text === date.iso) return true;
    const parts = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    return !!parts && `${parts[1].padStart(2, '0')}/${parts[2].padStart(2, '0')}/${parts[3]}` === date.display;
  };
  const button = pattern => [...document.querySelectorAll('button, a, input[type="button"], input[type="submit"]')]
    .find(el => visible(el) && pattern.test(normalize(el.textContent || el.value)));
  const material = el => el.matches('[matstartdate], [matenddate], .mat-datepicker-input, .mat-date-range-input-start, .mat-date-range-input-end');
  let dates = [...document.querySelectorAll('input')].filter(el => visible(el) &&
    (el.type === 'date' || /date/i.test([el.name, el.id, el.placeholder, el.getAttribute('formcontrolname')].join(' ')) ||
      material(el) || /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(el.value)));
  // The portal also renders the range as two unnamed, initially empty text inputs.
  if (!dates.length && /Water Bills Date Wise Receipts Report/i.test(document.body.textContent)) {
    dates = [...document.querySelectorAll('input')].filter(el => visible(el) && el.type === 'text');
  }
  const detail = [...document.querySelectorAll('input[type="radio"]')].find(el =>
    /\bdetail\b/i.test([...el.labels || []].map(label => label.textContent).join(' ') ||
      el.closest('label')?.textContent || el.value));
  if (action === 'prepare') {
    const show = button(/^show reports?$/i);
    if (dates.length !== 2 || !detail || !show) return false;
    for (const input of dates) {
      if (matchesDate(input.value)) continue;
      if (input.readOnly || material(input)) {
        input.focus();
        input.click();
        const labelText = value => normalize(value).replace(/[,\u200e\u200f]/g, '').toLowerCase();
        const labels = new Set(['en-US', 'en-GB'].flatMap(locale => ['long', 'full'].map(dateStyle =>
          labelText(new Intl.DateTimeFormat(locale, { dateStyle }).format(new Date(date.iso + 'T12:00:00'))))));
        let day;
        for (let attempt = 0; attempt < 100; attempt++) {
          const popupId = input.getAttribute('aria-controls') || input.getAttribute('aria-owns');
          const popup = popupId && document.getElementById(popupId);
          // Material may reuse a mounted calendar. Prefer the input's own popup;
          // otherwise use the newest visible one, not an outgoing animated popup.
          day = [...document.querySelectorAll('mat-calendar [aria-label]')].reverse()
            .find(el => (!popup || popup.contains(el)) && labels.has(labelText(el.getAttribute('aria-label'))) &&
              visible(el) && el.getAttribute('aria-disabled') !== 'true' && !el.closest('[aria-disabled="true"]'));
          if (day) break;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        if (!day) throw new Error('Could not select today in the portal’s receipt calendar.');
        const target = day.querySelector('button, .mat-calendar-body-cell-content') || day;
        target.focus();
        target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
        target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
        target.click();
        for (let attempt = 0; !matchesDate(input.value) && attempt < 40; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        if (!matchesDate(input.value)) throw new Error('The receipt calendar did not accept today’s date.');
        const calendar = day.closest('mat-calendar');
        for (let attempt = 0; calendar?.isConnected && visible(calendar) && attempt < 40; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        continue;
      }
      const value = input.type === 'date' || material(input) ? date.iso : date.display;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('blur', { bubbles: true }));
      if (!matchesDate(input.value)) throw new Error('The portal did not accept today’s receipt dates.');
    }
    detail.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    if (!detail.checked) throw new Error('Could not select the Detail report.');
    const submit = button(/^show reports?$/i);
    if (!submit) throw new Error('The Show Report control is unavailable after selecting Detail.');
    submit.click();
    return true;
  }
  const excel = button(/^excel$/i);
  const period = normalize(document.body.innerText).match(/Receipt Period\s*:\s*\(?\s*(\d{1,2}\/\d{1,2}\/\d{4})\s*[-–]\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
  const reason = !excel ? 'the Excel export control is unavailable' :
    !period || !matchesDate(period[1]) || !matchesDate(period[2]) ? 'the receipt period has not changed to today' :
      !detail?.checked ? 'Detail is no longer selected' :
        dates.length !== 2 || dates.some(input => !matchesDate(input.value)) ? 'the receipt date fields do not both show today' :
          !document.querySelector('table, mat-table') ? 'the receipt table has not appeared' :
            [...document.querySelectorAll('[aria-busy="true"], mat-progress-spinner, mat-spinner, [role="progressbar"], ngx-spinner .ngx-spinner-overlay')]
              .some(visible) ? 'the portal still shows an active loading indicator' : '';
  if (action === 'status') return { ready: !reason, reason };
  if (reason) return false;
  if (action === 'export') excel.click();
  return true;
}

function controlScript(action, date) {
  return `(${reportControls.toString()})(${JSON.stringify(action)},${JSON.stringify(date)})`;
}

async function downloadDailyReport({ owner, session, directory, recordDownload, now = new Date(), timeout = 90000 }) {
  const { app, BrowserWindow } = require('electron');
  if (owner.isDestroyed()) throw new Error('The originating browser window closed.');
  const date = reportDate(now);
  const page = new BrowserWindow({ show: false, width: 1200, height: 850,
    webPreferences: { session, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const wc = page.webContents;
  wc.setUserAgent(browserUserAgent(wc.getUserAgent(), app.getName()));
  // This page owns its downloads; ordinary tabs continue through the normal manager.
  const { managedDownloadContents } = require('../downloads');
  managedDownloadContents.add(wc);
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  const origin = new URL(REPORT_URL).origin;
  const guard = (event, url) => { if (new URL(url).origin !== origin) event.preventDefault(); };
  wc.on('will-navigate', guard);
  wc.on('will-redirect', guard);
  let timer, item, filePath, armed = false, settled = false, stage = 'loading the report page', waitingReason = '';
  let fail;
  const result = new Promise((resolve, reject) => {
    fail = error => { if (!settled) { settled = true; reject(error); } };
    timer = setTimeout(() => fail(new Error(`The receipt report timed out while ${stage}${waitingReason ? `: ${waitingReason}` : ''}. Retry or open the receipt report to check its controls.`)), timeout);
    wc.on('render-process-gone', () => fail(new Error('The receipt report page stopped. Try again.')));
    const onDownload = (_event, download, source) => {
      if (source !== wc) return;
      if (!armed || item) { download.cancel(); return; }
      item = download;
      const extension = path.extname(item.getFilename()).toLowerCase();
      if (!['.csv', '.xlsx', '.xls'].includes(extension)) {
        item.cancel(); fail(new Error('The portal did not return a CSV or Excel report.')); return;
      }
      try {
        filePath = reserveDownloadPath(directory, date.name + extension);
        item.setSavePath(filePath);
      } catch (error) { item.cancel(); fail(error); return; }
      item.once('done', async (_event, state) => {
        if (settled) return;
        try {
          if (state !== 'completed') throw new Error('The receipt report download was interrupted. Try again.');
          const stat = await fs.stat(filePath);
          if (!stat.size) throw new Error('The portal returned an empty file.');
          recordDownload?.({ filename: path.basename(filePath), filePath, totalBytes: stat.size, source: 'daily-receive' });
          settled = true;
          resolve({ filePath, date: date.display });
        } catch (error) { fail(error); }
      });
    };
    session.on('will-download', onDownload);
    page.once('closed', () => { session.removeListener('will-download', onDownload); fail(new Error('Report cancelled.')); });
  });
  // Attach a rejection handler before loading or polling so cancellation is never unhandled.
  const work = async () => {
    await wc.loadURL(REPORT_URL);
    stage = 'finding the receipt date fields and Detail control';
    const check = () => {
      const url = new URL(wc.getURL());
      if (url.origin !== origin || url.pathname !== new URL(REPORT_URL).pathname) {
        throw new Error('Sign in to eLGCDD in this BOBO profile, then try Daily Receive Amount again.');
      }
    };
    const waitFor = async action => {
      while (!settled) {
        check();
        if (action === 'ready') {
          const state = await wc.executeJavaScript(controlScript('status', date));
          waitingReason = state.reason;
          if (state.ready) return;
        } else if (await wc.executeJavaScript(controlScript(action, date))) return;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    };
    await waitFor('prepare');
    stage = 'waiting for today’s Detail report';
    await new Promise(resolve => setTimeout(resolve, 1000));
    await waitFor('ready');
    if (settled) return;
    armed = true;
    stage = 'waiting for the portal’s Excel download';
    if (!await wc.executeJavaScript(controlScript('export', date))) throw new Error('The report changed before export. Please retry.');
  };
  const ownerClosed = () => fail(new Error('Report cancelled because its browser window closed.'));
  owner.once('closed', ownerClosed);
  void work().catch(fail);
  try { return await result; }
  finally {
    clearTimeout(timer);
    owner.removeListener('closed', ownerClosed);
    const completed = item?.getState() === 'completed';
    if (item && !completed) item.cancel();
    if (!page.isDestroyed()) page.destroy();
    managedDownloadContents.delete(wc);
    if (filePath && !completed) await fs.unlink(filePath).catch(() => {});
  }
}

async function downloadDailyReceive(options) {
  const now = options.now ?? new Date();
  options.onProgress?.('source');
  const source = await downloadDailyReport({ ...options, now });
  const { downloadStaffSummary } = require('./daily-staff-summary');
  const maxAttempts = 4;
  let lastError, attempts = 0;
  for (let attempt = 1; attempt <= maxAttempts && !options.owner.isDestroyed(); attempt++) {
    attempts = attempt;
    const progress = { attempt, maxAttempts };
    try {
      const summary = await downloadStaffSummary({ ...options, sourceFile: source.filePath, date: reportDate(now),
        onProgress: stage => options.onProgress?.(stage, progress) });
      return { ...source, pdfPath: summary.filePath, attempts };
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts && !options.owner.isDestroyed()) {
        for (let retryIn = attempt * 5; retryIn > 0 && !options.owner.isDestroyed(); retryIn--) {
          options.onProgress?.('retry', { attempt: attempt + 1, maxAttempts, retryIn });
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }
  }
  throw new Error(`Source report saved at ${source.filePath}. Summary PDF step failed after ${attempts} attempts: ${lastError?.message || 'The originating browser window closed.'}`);
}

module.exports = { REPORT_URL, reportDate, controlScript, downloadDailyReport, downloadDailyReceive };
