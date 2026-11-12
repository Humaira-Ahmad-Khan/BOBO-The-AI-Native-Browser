'use strict';

/**
 * IPC surface for BOBO Tools.
 *
 * Every channel here is registered through the same sender-validated `handle`
 * wrapper the rest of the app uses (src/main/main.js), so a remote website gets
 * a rejected promise, never data. Payloads are validated before anything is
 * stored, written or shown.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow, clipboard, dialog } = require('electron');
const { LIMITS, cleanText, optionalUrl, pngDataUrl, safeFileName, text } = require('./lib');
const { readerToMarkdown } = require('./format');
const { formatCsv, mergeCsvFiles, buildPdfHtml, parseCsvLine } = require('./export');
const { SCAN_SCRIPT, portalUrl, billPrintsFolder, resolveBillView, saveBillPdf, markBillSaved } = require('./bill-prints');
const { scrapePage } = require('./scraper');
const { captureLinkedIn } = require('./linkedin-capture');
const { recognizeScreenshot } = require('./screenshot-ocr');
const { collectTablePages } = require('./table-pages');
const { downloadDailyReceive } = require('./daily-receive');
const { SocialVideoQueue, findPageVideos, playerVideoSource } = require('./social-video');

const MAX_BLOCKS = 500;

async function printReportPdf(html, landscape = false) {
  const report = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false },
  });
  try {
    await report.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    return await report.webContents.printToPDF({ landscape, printBackground: true, pageSize: 'A4' });
  } finally {
    if (!report.isDestroyed()) report.destroy();
  }
}
const FIND_SECTOR_SELECT = `
  const selects = Array.from(document.querySelectorAll('select'));
  const sectorSelect = selects.find(s => Array.from(s.options).some(o => /^select sector$/i.test(o.text.trim())))
    || selects.find(s => /sector/i.test(s.id + ' ' + s.name + ' ' + s.getAttribute('aria-label')))
    || selects.find(s => Array.from(s.labels || []).some(label => /^sector$/i.test(label.textContent.trim())))
    || selects.find(s => Array.from(s.options).some(o => /^\\d+\\s*[-–]/.test(o.text.trim())));
`;

function pad(value) {
  return String(value).padStart(2, '0');
}

/** bobo-screenshot-20261103-152010.png */
function stampedName(prefix, extension, when = new Date()) {
  const date = `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}`;
  const time = `${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}`;
  return `${prefix}-${date}-${time}.${extension}`;
}

/** Validate a Reader document coming back from the renderer before saving it. */
function readReaderDocument(value) {
  if (!value || typeof value !== 'object') throw new Error('BOBO: invalid document');

  const blocks = (Array.isArray(value.blocks) ? value.blocks : [])
    .slice(0, MAX_BLOCKS)
    .map((block) => ({
      kind: block && block.kind === 'heading' ? 'heading' : 'text',
      text: cleanText(block && block.text, 5000),
    }))
    .filter((block) => block.text);

  if (!blocks.length) throw new Error('BOBO: nothing to save');

  return {
    title: cleanText(value.title, LIMITS.title) || 'Untitled page',
    url: optionalUrl(value.url),
    blocks,
  };
}

async function confirmDestructive(win, what) {
  const options = {
    type: 'warning',
    buttons: ['Cancel', 'Delete'],
    defaultId: 0,
    cancelId: 0,
    message:
      what === 'all'
        ? 'Delete all BOBO tool data?'
        : 'Delete all BOBO notes?',
    detail:
      what === 'all'
        ? 'This removes every saved note and resets the tool settings. It cannot be undone.'
        : 'Every saved note is deleted. This cannot be undone.',
  };
  const result = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  return result.response === 1;
}

/**
 * @param {{
 *   handle: (channel: string, run: (payload: unknown) => unknown) => void,
 *   services: ReturnType<import('./service').createToolServices>,
 *   getActiveWebContents: () => import('electron').WebContents|null,
 *   getWindow: () => import('electron').BrowserWindow|null,
 *   recordDownload?: (info: { filename: string, filePath: string, totalBytes: number, source?: string }) => void
 * }} options
 */
function registerToolIpc({ handle, services, getActiveWebContents, getToolTabContents, getWindow, recordDownload, downloads, downloadsChanged, onToolConfigured }) {
  const { settings, notes, screenshots, reader, exportService, billsService, transcriptService, sectorsService } = services;
  const printBatches = new WeakMap();
  const dailyReports = new WeakSet();
  handle('bobo:daily-receive:download', async (payload, event) => {
    if (payload != null && Object.keys(payload).length) throw new Error('BOBO: invalid report request');
    const window = getWindow();
    if (dailyReports.has(window)) throw new Error('A daily report is already running in this window.');
    dailyReports.add(window);
    try {
      const state = await settings.state();
      if (!state.tools.some(tool => tool.id === 'daily-receive' && tool.enabled)) throw new Error('Daily Receive Amount is disabled.');
      const directory = state.browser?.downloads?.directory || app.getPath('downloads');
      return await downloadDailyReceive({ owner: window, session: event.sender.session, directory, recordDownload,
        onProgress: (stage, progress) => { if (!window.isDestroyed()) window.webContents.send('bobo:daily-receive:progress', { stage, ...progress }); } });
    } finally { dailyReports.delete(window); }
  }, { chromeOnly: true });
  function billPrintBatch() {
    const window = getWindow();
    let batch = printBatches.get(window);
    if (!batch) {
      batch = { items: new Map(), folder: '', downloads: new Map(), views: Promise.resolve(), id: 0 };
      printBatches.set(window, batch);
    }
    return batch;
  }
  const socialVideo = new SocialVideoQueue({
    file: path.join(services.dataDir, 'social-video.json'), downloads, changed: downloadsChanged,
  });

  const askWhereToSave = async (options) => {
    const win = getWindow();
    const result = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options);
    return result && !result.canceled && result.filePath ? result.filePath : '';
  };

  // --- tools: state, enable/disable, pinning, preferences ------------------

  handle('bobo:tools:state', () => settings.state());

  handle('bobo:tools:configure', async (payload) => {
    const state = await settings.configure(payload);
    if (payload?.id === 'ad-free-youtube') onToolConfigured?.(state);
    return state;
  });

  handle('bobo:tools:prefs', (payload) => settings.setPrefs(payload));

  handle('bobo:settings:search', (payload) => settings.setSearchEngine(payload && payload.engine));

  handle('bobo:tools:copy-text', async (payload) => {
    const value = text(payload && payload.text, LIMITS.text);
    if (!value) throw new Error('BOBO: nothing to copy');
    await clipboard.writeText(value);
    return { ok: true };
  });

  handle('bobo:tools:clear', async (payload) => {
    const what = payload && payload.what === 'all' ? 'all' : 'notes';
    if (!(await confirmDestructive(getWindow(), what))) return { ok: true, canceled: true };

    await notes.clear();
    if (what === 'all') await settings.resetTools();
    return { ok: true, cleared: what };
  });

  // --- screenshot ----------------------------------------------------------

  handle('bobo:screenshot:capture', () => screenshots.capture(getActiveWebContents()));
  handle('bobo:screenshot:ocr', (payload) => recognizeScreenshot(payload?.dataUrl));
  handle('bobo:linkedin:capture', (payload) => captureLinkedIn(getActiveWebContents(), payload?.mode));
  handle('bobo:linkedin:save-text', async (payload) => {
    const value = text(payload?.text, 100000);
    if (!value) throw new Error('BOBO: no post text to save');
    const file = await askWhereToSave({
      title: 'Save LinkedIn post text',
      defaultPath: path.join(app.getPath('downloads'), stampedName('linkedin-post', 'txt')),
      filters: [{ name: 'Plain text', extensions: ['txt'] }],
    });
    if (!file) return { canceled: true };
    await fs.writeFile(file, value, 'utf8');
    return { path: file };
  });

  handle('bobo:screenshot:copy', (payload) => screenshots.copy(payload && payload.dataUrl));

  handle('bobo:screenshot:save', async (payload) => {
    const dataUrl = pngDataUrl(payload && payload.dataUrl);
    const file = await askWhereToSave({
      title: 'Save BOBO screenshot',
      defaultPath: path.join(app.getPath('downloads'), stampedName('bobo-screenshot', 'png')),
      filters: [{ name: 'PNG image', extensions: ['png'] }],
    });
    if (!file) return { ok: true, canceled: true };
    const res = await screenshots.save(dataUrl, file);
    recordDownload?.({
      filename: path.basename(file),
      filePath: file,
      totalBytes: res.bytes || 1024,
      source: 'screenshot',
    });
    return res;
  });

  // --- notes ---------------------------------------------------------------

  handle('bobo:notes:list', () => notes.list());

  handle('bobo:notes:save', (payload) => notes.save(payload && payload.note));

  handle('bobo:notes:delete', (payload) => notes.remove(payload));

  handle('bobo:notes:export', async (payload) => {
    const { text: markdown, name } = await notes.markdown(payload);
    const file = await askWhereToSave({
      title: 'Export BOBO notes',
      defaultPath: path.join(app.getPath('downloads'), `${safeFileName(name, 'bobo-notes')}.md`),
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: 'Text', extensions: ['txt'] },
      ],
    });
    if (!file) return { ok: true, canceled: true };
    await fs.writeFile(file, markdown, 'utf8');
    recordDownload?.({
      filename: path.basename(file),
      filePath: file,
      totalBytes: Buffer.byteLength(markdown, 'utf8'),
      source: 'notes',
    });
    return { ok: true, path: file };
  });

  // --- reader --------------------------------------------------------------

  handle('bobo:reader:extract', () => reader.extract(getActiveWebContents()));

  handle('bobo:reader:find-pdf', () => reader.findEmbeddedPdfs(getActiveWebContents()));

  handle('bobo:reader:download-pdf', async (payload) => {
    const url = payload && typeof payload.url === 'string' ? payload.url.trim() : '';
    if (!url || !/^https?:\/\//i.test(url)) throw new Error('BOBO: invalid PDF URL');
    // Allow direct .pdf URLs and Google Drive download URLs
    const isDirectPdf = /\.pdf(\?|#|$)/i.test(url);
    const isDriveDownload = /^https:\/\/drive\.google\.com\/uc\?/i.test(url) && url.includes('export=download');
    if (!isDirectPdf && !isDriveDownload) throw new Error('BOBO: URL does not look like a PDF');

    const wc = getActiveWebContents();
    if (!wc || wc.isDestroyed()) throw new Error('No active tab to download from.');

    const directory = (await settings.state()).browser?.downloads?.directory || app.getPath('downloads');

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Download did not start in time.')), 15000);

      wc.session.once('will-download', (_event, item) => {
        clearTimeout(timeout);
        const filename = item.getFilename() || 'study-material.pdf';
        const filePath = path.join(directory, filename);
        item.setSavePath(filePath);
        item.once('done', (_e, state) => {
          if (state === 'completed') {
            recordDownload?.({ filename, filePath, totalBytes: item.getTotalBytes(), source: 'reader' });
            resolve({ ok: true, path: filePath, filename });
          } else {
            reject(new Error(`Download ${state}.`));
          }
        });
      });

      wc.downloadURL(url);
    });
  });

  handle('bobo:reader:save', async (payload) => {
    const document = readReaderDocument(payload && payload.doc);
    const file = await askWhereToSave({
      title: 'Save BOBO Reader page',
      defaultPath: path.join(
        app.getPath('downloads'),
        `${safeFileName(document.title, 'bobo-page')}.md`
      ),
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: 'Text', extensions: ['txt'] },
      ],
    });
    if (!file) return { ok: true, canceled: true };
    const md = readerToMarkdown(document);
    await fs.writeFile(file, md, 'utf8');
    recordDownload?.({
      filename: path.basename(file),
      filePath: file,
      totalBytes: Buffer.byteLength(md, 'utf8'),
      source: 'reader',
    });
    return { ok: true, path: file };
  });

  handle('bobo:reader:save-pdf', async (payload) => {
    const document = readReaderDocument(payload && payload.doc);
    const file = await askWhereToSave({
      title: 'Save page as PDF',
      defaultPath: path.join(
        app.getPath('downloads'),
        `${safeFileName(document.title, 'bobo-page')}.pdf`
      ),
      filters: [{ name: 'PDF Documents', extensions: ['pdf'] }],
    });
    if (!file) return { ok: true, canceled: true };

    const bodyLines = (document.blocks || []).map((block) => {
      if (block.kind === 'heading') return `<h2>${block.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</h2>`;
      return `<p>${block.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`;
    }).join('\n');

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>${document.title.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</title>
<style>
  body { font-family: Georgia, serif; font-size: 13pt; line-height: 1.7; margin: 2cm 2.5cm; color: #111; }
  h1 { font-size: 18pt; margin-bottom: 4px; }
  h2 { font-size: 14pt; margin-top: 1.4em; margin-bottom: 4px; color: #1a1a1a; }
  p { margin: 0.5em 0 1em; }
  .meta { font-size: 10pt; color: #555; margin-bottom: 1.5em; }
</style>
</head><body>
<h1>${document.title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</h1>
${document.url ? `<p class="meta">Source: ${document.url.replace(/&/g, '&amp;')}</p>` : ''}
${bodyLines}
</body></html>`;

    const pdfData = await printReportPdf(html, false);
    await fs.writeFile(file, pdfData);
    recordDownload?.({
      filename: path.basename(file),
      filePath: file,
      totalBytes: pdfData.length,
      source: 'reader',
    });
    return { ok: true, path: file };
  });

  // --- data export ---------------------------------------------------------

  const collectingTables = new WeakSet();
  handle('bobo:export:inspect-table', async () => {
    const contents = getActiveWebContents();
    return { ...await exportService.inspectTable(contents), pageId: contents.id };
  });
  handle('bobo:export:collect-pages', async (payload, event) => {
    if (!Number.isSafeInteger(payload?.tabId) || !Number.isSafeInteger(payload?.pageId)) throw new Error('BOBO: invalid source tab');
    const contents = getToolTabContents(event, payload.tabId);
    if (!contents || contents.isDestroyed() || contents.id !== payload.pageId) throw new Error('The source table tab is closed or unavailable.');
    if (collectingTables.has(contents)) throw new Error('An export is already running on this table.');
    const window = getWindow();
    const throttled = contents.getBackgroundThrottling();
    collectingTables.add(contents);
    try {
      contents.setBackgroundThrottling(false);
      return await collectTablePages(contents, wc => exportService.inspectTable(wc), payload, progress => {
        if (!window.isDestroyed()) window.webContents.send('bobo:export:progress', { ...progress, pageId: contents.id });
      });
    } finally {
      if (!contents.isDestroyed()) contents.setBackgroundThrottling(throttled);
      collectingTables.delete(contents);
    }
  }, { chromeOnly: true });
  handle('bobo:csv-extractor:page', async (payload, event) => {
    const contents = payload?.tabId == null
      ? getActiveWebContents()
      : getToolTabContents(event, payload.tabId);
    if (!contents || contents.isDestroyed() ||
      !/^https:\/\/elgcd\.punjab\.gov\.pk\/e-billing\/consumers-list\/?(?:[?#].*)?$/i.test(contents.getURL())) {
      throw new Error(payload?.tabId == null
        ? 'Open eLGCDD Consumer List in the active tab.'
        : 'The source tab is closed or no longer on eLGCDD Consumer List.');
    }
    if (payload?.pageId != null && payload.pageId !== contents.id) {
      throw new Error('Return to the Consumer List tab where the export started.');
    }
    const direction = payload?.direction;
    if (collectingTables.has(contents)) throw new Error('Data Export is already using this table. Wait for it to finish.');
    if (direction === 'first' || direction === 'next') {
      const selector = `.mat-mdc-paginator-navigation-${direction}, .mat-paginator-navigation-${direction}, button[aria-label^="${direction} page" i]`;
      const clicked = await contents.executeJavaScript(`(() => {
        if (location.origin !== 'https://elgcd.punjab.gov.pk' ||
          location.pathname.replace(/\\/$/, '') !== '/e-billing/consumers-list') return false;
        const button = document.querySelector(${JSON.stringify(selector)});
        if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return false;
        button.click();
        return true;
      })()`);
      if (!clicked) throw new Error(`The ${direction} page button is unavailable.`);
      return;
    }
    return { ...await exportService.inspectTable(contents), pageId: contents.id };
  });
  handle('bobo:scraper:extract', (payload) => scrapePage(getActiveWebContents(), payload?.mode, exportService));
  handle('bobo:video:queue', () => socialVideo.snapshot());
  handle('bobo:video:find-page', () => findPageVideos(getActiveWebContents()));
  handle('bobo:video:add', (payload) => socialVideo.add(payload?.urls));
  handle('bobo:video:import', (payload) => {
    if (typeof payload?.text !== 'string' || payload.text.length > 128000) throw new Error('Import a TXT or CSV file under 128 KB.');
    const lines = payload.text.split(/\r?\n/);
    const urls = payload.csv === true
      ? lines.flatMap((line) => parseCsvLine(line)).map((cell) => cell.trim()).filter((cell) => /^https?:\/\//i.test(cell))
      : lines.map((line) => line.trim()).filter(Boolean);
    if (!urls.length) throw new Error('No video URLs found in the file.');
    return socialVideo.add(urls);
  });
  handle('bobo:video:analyse', (payload) => socialVideo.analyse(payload?.id));
  handle('bobo:video:remove', (payload) => socialVideo.remove(payload?.id));
  handle('bobo:video:stop', () => socialVideo.stop());
  handle('bobo:video:start', (payload) => {
    return socialVideo.start(payload?.retry === true, typeof payload?.id === 'string' ? payload.id : undefined);
  });
  handle('bobo:video:folder', async () => {
    const options = { title: 'Choose video download folder', properties: ['openDirectory', 'createDirectory'] };
    const win = getWindow();
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (!result.canceled && result.filePaths[0]) await socialVideo.setFolder(result.filePaths[0]);
    return socialVideo.snapshot();
  });

  handle('bobo:export:save-csv', async (payload) => {
    const columns = Array.isArray(payload?.columns) ? payload.columns : [];
    const rows = Array.isArray(payload?.rows) ? payload.rows : [];
    if (!columns.length) throw new Error('BOBO: No columns to export');

    const csvContent = formatCsv(columns, rows);
    const defaultName = stampedName(safeFileName(payload?.tableName || 'bobo-export', 'bobo-export'), 'csv');
    const file = await askWhereToSave({
      title: 'Save Exported CSV Table',
      defaultPath: path.join(app.getPath('downloads'), defaultName),
      filters: [{ name: 'CSV Files', extensions: ['csv'] }],
    });
    if (!file) return { ok: true, canceled: true };

    await fs.writeFile(file, csvContent, 'utf8');
    recordDownload?.({
      filename: path.basename(file),
      filePath: file,
      totalBytes: Buffer.byteLength(csvContent, 'utf8'),
      source: 'data-export',
    });
    return { ok: true, path: file, rowCount: rows.length };
  });

  handle('bobo:export:save-pdf', async (payload) => {
    const columns = Array.isArray(payload?.columns) ? payload.columns : [];
    const rows = Array.isArray(payload?.rows) ? payload.rows : [];
    if (!columns.length) throw new Error('BOBO: No columns to export');

    const htmlContent = buildPdfHtml({
      title: payload?.title || 'Data Export Report',
      url: payload?.url || '',
      columns,
      rows,
      metadata: payload?.metadata || {},
    });

    const defaultName = stampedName(safeFileName(payload?.title || 'bobo-report', 'bobo-report'), 'pdf');
    const file = await askWhereToSave({
      title: 'Save PDF Report',
      defaultPath: path.join(app.getPath('downloads'), defaultName),
      filters: [{ name: 'PDF Documents', extensions: ['pdf'] }],
    });
    if (!file) return { ok: true, canceled: true };

    // Print the captured table in isolation, even if the user switched tabs.
    const pdfData = await printReportPdf(htmlContent, columns.length > 6);
    await fs.writeFile(file, pdfData);
    recordDownload?.({
      filename: path.basename(file),
      filePath: file,
      totalBytes: pdfData.length,
      source: 'data-export',
    });
    return { ok: true, path: file };
  });

  handle('bobo:export:merge-csv', async (payload) => {
    const win = getWindow();
    const picked = win
      ? await dialog.showOpenDialog(win, {
          title: 'Select CSV files to merge',
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: 'CSV Files', extensions: ['csv'] }],
        })
      : await dialog.showOpenDialog({
          title: 'Select CSV files to merge',
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: 'CSV Files', extensions: ['csv'] }],
        });

    if (!picked || picked.canceled || !picked.filePaths?.length) {
      return { ok: true, canceled: true };
    }

    const mergeResult = await mergeCsvFiles(picked.filePaths, {
      dedupeKey: payload?.dedupeKey || null,
    });

    const saveFile = await askWhereToSave({
      title: 'Save Combined Merged CSV',
      defaultPath: path.join(app.getPath('downloads'), stampedName('bobo-merged-export', 'csv')),
      filters: [{ name: 'CSV Files', extensions: ['csv'] }],
    });
    if (!saveFile) return { ok: true, canceled: true };

    await fs.writeFile(saveFile, mergeResult.csv, 'utf8');
    recordDownload?.({
      filename: path.basename(saveFile),
      filePath: saveFile,
      totalBytes: Buffer.byteLength(mergeResult.csv, 'utf8'),
      source: 'data-export',
    });
    return {
      ok: true,
      path: saveFile,
      headers: mergeResult.headers,
      rowCount: mergeResult.rowCount,
      fileCount: mergeResult.fileCount,
    };
  });

  handle('bobo:export:presets:list', (payload) => exportService.listPresets(payload));
  handle('bobo:export:presets:save', (payload) => exportService.savePreset(payload));
  handle('bobo:export:presets:delete', (payload) => exportService.deletePreset(payload));

  // --- bills history extraction --------------------------------------------

  handle('bobo:bills:create-job', (payload) => billsService.createJob(payload));
  handle('bobo:bills:get-job', (payload) => billsService.getJob(payload?.jobId));
  handle('bobo:bills:list-jobs', () => billsService.listJobs());
  handle('bobo:bills:get-queue', (payload) => billsService.getQueue(payload?.jobId, payload?.recent === true));
  handle('bobo:bills:process-item', async (payload, event) => {
    const contents = getToolTabContents(event, payload?.tabId);
    if (!contents || contents.isDestroyed()) throw new Error('The billing tab is closed.');
    if (collectingTables.has(contents)) throw new Error('Another extraction is already using this tab.');
    const throttled = contents.getBackgroundThrottling();
    collectingTables.add(contents);
    try {
      contents.setBackgroundThrottling(false);
      return await billsService.processSingle(contents, payload?.jobId, payload?.queueItemId);
    } finally {
      if (!contents.isDestroyed()) contents.setBackgroundThrottling(throttled);
      collectingTables.delete(contents);
    }
  });
  handle('bobo:bills:pause', () => billsService.pause());
  handle('bobo:bills:resume', () => billsService.resume());
  handle('bobo:bills:stop', () => billsService.stop());
  handle('bobo:bills:retry', (payload) => billsService.retryFailed(payload?.jobId));
  handle('bobo:bills:retry-empty', (payload) => billsService.retryEmpty(payload?.jobId));
  handle('bobo:bills:repair-ids', (payload) => billsService.repairSpreadsheetIds(payload?.jobId));
  const billsRunOwners = new WeakSet();
  handle('bobo:bills:run-state', (payload, event) => {
    if (!billsRunOwners.has(event.sender)) {
      billsRunOwners.add(event.sender);
      const owner = event.sender.id;
      event.sender.once('destroyed', () => billsService.releaseOwner(owner));
    }
    return billsService.setRunning(payload?.jobId, payload?.running, event.sender.id);
  });
  handle('bobo:bills:clear-all', async () => {
    const options = { type: 'warning', buttons: ['Cancel', 'Delete all extraction jobs'], defaultId: 0, cancelId: 0,
      message: 'Delete all saved Bills History jobs?',
      detail: 'Saved queues and extracted results will be removed. Exported files remain on disk. Stop running queues first.' };
    const win = getWindow();
    const result = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    return result.response === 1 ? billsService.clearAllJobs() : { ok: true, canceled: true };
  });
  handle('bobo:bills:clear', (payload) => billsService.clearJob(payload?.jobId));

  handle('bobo:bills:export-csv', async (payload) => {
    const jobId = payload?.jobId;
    const allJobs = payload?.allJobs === true;
    if (!jobId && !allJobs) throw new Error('BOBO: Job ID required');
    const connNo = payload?.connectionNo;
    const merged = payload?.merged === true;
    if (allJobs) {
      const jobs = billsService.listJobs().filter((job) => job.completed > 0).sort((a, b) => a.id - b.id);
      if (!jobs.length) throw new Error('BOBO: No saved job has completed records to export');
      const win = getWindow();
      const confirm = {
        type: 'question', buttons: ['Cancel', 'Export into one folder'], defaultId: 1, cancelId: 0,
        message: `Export ${jobs.length} job(s) into one folder?`,
        detail: jobs.map((job) => `${job.name}: ${job.completed} downloaded`).join('\n').slice(0, 1500)
          + '\n\nClear old jobs first if they should not be included.',
      };
      if ((win ? await dialog.showMessageBox(win, confirm) : await dialog.showMessageBox(confirm)).response !== 1) {
        return { ok: true, canceled: true };
      }
      const options = { title: 'Choose the history folder', defaultPath: app.getPath('downloads'),
        properties: ['openDirectory', 'createDirectory'] };
      const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      if (picked.canceled || !picked.filePaths.length) return { ok: true, canceled: true };
      const { directory, files, skipped, failed, summary } = await billsService.exportHistoryFolder(
        jobs.map((job) => job.id), picked.filePaths[0]);
      for (const { filePath, totalBytes } of files) {
        recordDownload?.({ filename: path.basename(filePath), filePath, totalBytes, source: 'bills-history' });
      }
      return { ok: true, path: directory, recordsCount: files.length, skipped, failed, summary };
    }
    if (!connNo && !merged) {
      const options = {
        title: 'Choose the history folder',
        defaultPath: app.getPath('downloads'),
        properties: ['openDirectory', 'createDirectory'],
      };
      const win = getWindow();
      const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      if (picked.canceled || !picked.filePaths.length) return { ok: true, canceled: true };
      const { directory, files, skipped, failed, summary } = await billsService.exportHistoryFolder(jobId, picked.filePaths[0]);
      for (const { filePath, totalBytes } of files) {
        recordDownload?.({ filename: path.basename(filePath), filePath, totalBytes, source: 'bills-history' });
      }
      return { ok: true, path: directory, recordsCount: files.length, skipped, failed, summary };
    }
    const csvContent = merged
      ? billsService.exportCombinedCsv(jobId)
      : billsService.exportIndividualCsv(jobId, connNo);

    const baseName = merged ? 'BOBO_Bills_History_Combined' : `${connNo}_bills_history`;
    const file = await askWhereToSave({
      title: 'Export Bills History CSV',
      defaultPath: path.join(app.getPath('downloads'), stampedName(baseName, 'csv')),
      filters: [{ name: 'CSV Files', extensions: ['csv'] }],
    });
    if (!file) return { ok: true, canceled: true };

    await fs.writeFile(file, csvContent, 'utf8');
    recordDownload?.({
      filename: path.basename(file),
      filePath: file,
      totalBytes: Buffer.byteLength(csvContent, 'utf8'),
      source: 'bills-history',
    });
    return { ok: true, path: file };
  });

  handle('bobo:bills:export-connections', async (payload) => {
    const jobId = payload?.jobId;
    if (!jobId) throw new Error('BOBO: Job ID required');
    const mode = ['empty', 'failed'].includes(payload?.mode) ? payload.mode : 'non-empty';
    const { csv, count } = billsService.exportConnectionListCsv(jobId, mode);
    if (!count) {
      throw new Error(`BOBO: This job has no ${mode} connections to export yet.`);
    }

    const baseName = { empty: 'BOBO_Bills_Empty_Connections', failed: 'BOBO_Bills_Failed_Connections' }[mode]
      || 'BOBO_Bills_NonEmpty_Connections';
    const file = await askWhereToSave({
      title: 'Export Connection Numbers CSV',
      defaultPath: path.join(app.getPath('downloads'), stampedName(baseName, 'csv')),
      filters: [{ name: 'CSV Files', extensions: ['csv'] }],
    });
    if (!file) return { ok: true, canceled: true };

    await fs.writeFile(file, csv, 'utf8');
    recordDownload?.({
      filename: path.basename(file),
      filePath: file,
      totalBytes: Buffer.byteLength(csv, 'utf8'),
      source: 'bills-history',
    });
    return { ok: true, path: file, count };
  });

  handle('bobo:prints:scan', async (payload) => {
    const batch = billPrintBatch();
    if (batch.downloads.size) throw new Error('Pause the batch before scanning another list.');
    const wc = getActiveWebContents();
    if (!wc || wc.isDestroyed() || !portalUrl(wc.getURL())) {
      throw new Error('Open the eLGCDD Water Print Bills list in the active tab.');
    }
    const pageUrl = wc.getURL();
    const items = await wc.executeJavaScript(SCAN_SCRIPT);
    if (!Array.isArray(items) || !items.length) {
      throw new Error('No bill View links found. Open the Water Print Bills locality list and wait for its rows to load.');
    }
    const added = [];
    const queue = payload?.append === true ? batch.items : new Map();
    const seen = new Map([...queue.values()].map((item) => [item.key, item]));
    for (const raw of items.slice(0, 5000)) {
      const url = portalUrl(raw?.url);
      const locality = cleanText(raw?.locality, 120);
      const token = typeof raw?.token === 'string' && /^[a-f0-9-]{36}$/i.test(raw.token) ? raw.token : '';
      if ((!url && !token) || !locality) continue;
      const sector = cleanText(raw.sector, 120);
      const bills = cleanText(raw.bills, 20);
      const fileNumber = cleanText(raw.fileNumber, 80);
      const key = url || (typeof raw.billKey === 'string' && raw.billKey.length <= 16000
        ? raw.billKey : JSON.stringify([locality, sector, fileNumber, bills]));
      const rowKey = typeof raw.rowKey === 'string' ? raw.rowKey.slice(0, 16000) : '';
      const source = { key, url, token, rowKey, contents: wc, pageUrl, session: wc.session };
      const existing = seen.get(key);
      if (existing) {
        Object.assign(existing, source);
        continue;
      }
      const item = { id: ++batch.id, locality, sector, bills, fileNumber };
      const entry = { ...item, ...source };
      queue.set(item.id, entry);
      seen.set(key, entry);
      added.push(item);
    }
    batch.items = queue;
    if (payload?.append !== true) batch.folder = '';
    return added;
  });
  handle('bobo:prints:folder', async () => {
    const batch = billPrintBatch();
    if (batch.folder) return batch.folder;
    const options = { title: 'Choose Bill Prints download folder', properties: ['openDirectory', 'createDirectory'] };
    const win = getWindow();
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths.length) return null;
    const folder = billPrintsFolder(result.filePaths[0]);
    await fs.mkdir(folder, { recursive: true });
    if (!(await fs.lstat(folder)).isDirectory()) throw new Error('Invalid Bill Prints folder.');
    batch.folder = folder;
    return folder;
  });
  handle('bobo:prints:download', async (payload) => {
    const batch = billPrintBatch();
    const item = batch.items.get(payload?.id);
    if (!item || !batch.folder) throw new Error('Select a Bill Prints queue and destination first.');
    if (batch.downloads.has(item.id) || batch.downloads.size >= 3) throw new Error('No Bill Prints download slot is available.');
    const minutes = Number(payload?.minutes);
    const timeout = Number.isFinite(minutes) ? Math.max(1, Math.min(30, minutes)) : 10;
    const controller = new AbortController();
    batch.downloads.set(item.id, controller);
    try {
      const waitMs = Math.round(timeout * 60000);
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(waitMs)]);
      let url = item.url;
      if (!url) {
        const view = batch.views.then(() => resolveBillView(item, signal, waitMs));
        batch.views = view.catch(() => {});
        url = await view;
      }
      const { filePath, totalBytes } = await saveBillPdf(item.session, { ...item, url }, batch.folder, signal);
      recordDownload?.({ filename: path.basename(filePath), filePath, totalBytes, source: 'bill-prints' });
      markBillSaved(item).catch(() => {});
      return { filename: path.basename(filePath) };
    } finally {
      batch.downloads.delete(item.id);
    }
  });
  handle('bobo:prints:stop', () => {
    const batch = billPrintBatch();
    for (const controller of batch.downloads.values()) controller.abort();
  });
  handle('bobo:prints:csv', async () => {
    const batch = billPrintBatch();
    if (!batch.items.size) throw new Error('Scan a billing list first.');
    const file = await askWhereToSave({
      title: 'Save Bill Prints locality CSV',
      defaultPath: path.join(batch.folder || app.getPath('downloads'), 'Localities.csv'),
      filters: [{ name: 'CSV Files', extensions: ['csv'] }],
    });
    if (!file) return null;
    const csv = formatCsv(['Locality', 'Sector', 'File Number', 'Bills'], [...batch.items.values()].map(
      ({ locality, sector, fileNumber, bills }) => [locality, sector, fileNumber, bills]
    ));
    await fs.writeFile(file, csv, 'utf8');
    return file;
  });

  // --- youtube transcript --------------------------------------------------

  handle('bobo:transcript:detect', (payload) =>
    transcriptService.detectAndExtract(getActiveWebContents(), { language: payload?.language }));
  handle('bobo:transcript:seek', (payload, event) => {
    const contents = getToolTabContents(event, payload?.tabId);
    if (!contents || contents.getURL() !== payload?.url) {
      throw new Error('The original video tab is closed or has moved. Extract the transcript again.');
    }
    return transcriptService.seek(contents, payload?.seconds);
  });
  handle('bobo:transcript:export', async (payload) => {
    const segments = Array.isArray(payload?.segments) ? payload.segments : [];
    if (!segments.length || segments.length > 20000 || segments.some((cue) =>
      !cue || typeof cue.text !== 'string' || cue.text.length > 10000 ||
      !Number.isFinite(cue.start) || cue.start < 0)) {
      throw new Error('BOBO: invalid transcript segments');
    }
    const format = String(payload?.format || 'txt').toLowerCase();
    if (!['txt', 'srt', 'vtt', 'csv', 'pdf'].includes(format)) throw new Error('BOBO: unsupported transcript format');
    const content = transcriptService.formatTranscript(segments, format, {
      title: payload?.title || 'YouTube Video',
      url: payload?.url || '',
    });

    const ext = format;
    const defaultName = stampedName(safeFileName(payload?.title || 'youtube-transcript', 'transcript'), ext);
    const file = await askWhereToSave({
      title: `Export Transcript as ${format.toUpperCase()}`,
      defaultPath: path.join(app.getPath('downloads'), defaultName),
      filters: [{ name: `${format.toUpperCase()} Files`, extensions: [ext] }],
    });
    if (!file) return { ok: true, canceled: true };

    if (format === 'pdf' && !/\.pdf$/i.test(file)) throw new Error('Choose a .pdf filename.');
    const output = format === 'pdf' ? await printReportPdf(content) : content;
    await fs.writeFile(file, output, 'utf8');
    recordDownload?.({
      filename: path.basename(file),
      filePath: file,
      totalBytes: Buffer.byteLength(output, 'utf8'),
      source: 'youtube-transcript',
    });
    return { ok: true, path: file };
  });

  // --- quick sector selector -----------------------------------------------

  handle('bobo:sectors:inspect', async () => {
    const wc = getActiveWebContents();
    if (!wc || wc.isDestroyed()) return { found: false, error: 'No active tab' };

    const inspectScript = `
      (() => {
        try {
          ${FIND_SECTOR_SELECT}
          if (!sectorSelect) return { found: false, sectors: [] };

          const sectors = [];
          for (const opt of sectorSelect.options) {
            const val = opt.value ? opt.value.trim() : '';
            const txt = opt.text ? opt.text.trim() : '';
            if (!val || !txt) continue;
            if (/^(select|--|all|choose)/i.test(txt)) continue;

            let code = val;
            const match = txt.match(/^(\\d+)\\s*[-–]\\s*(.+)$/);
            if (match) {
              code = match[1];
            }
            sectors.push({ code, name: txt, value: val });
          }
          return { found: true, count: sectors.length, sectors };
        } catch (err) {
          return { found: false, error: String(err), sectors: [] };
        }
      })()
    `;

    const url = new URL(wc.getURL());
    if (!/^https?:$/.test(url.protocol)) return { found: false, error: 'Open the billing page first.' };
    return { ...await wc.executeJavaScript(inspectScript), domain: url.hostname };
  });

  handle('bobo:sectors:save', (payload) => {
    const items = Array.isArray(payload?.sectors) ? payload.sectors : [];
    return sectorsService.saveSectors(items, payload?.domain);
  });

  handle('bobo:sectors:list', (payload) => {
    return sectorsService.listSectors(payload?.query, payload?.domain);
  });

  handle('bobo:sectors:select', async (payload) => {
    const wc = getActiveWebContents();
    if (!wc || wc.isDestroyed()) return { ok: false, error: 'No active tab' };

    const targetValue = JSON.stringify(String(payload?.value || ''));
    const targetCode = JSON.stringify(String(payload?.code || ''));
    const domain = JSON.stringify(String(payload?.domain || ''));

    const selectScript = `
      (() => {
        try {
          if (!/^https?:$/.test(location.protocol) || (${domain} && location.hostname !== ${domain})) {
            return { ok: false, error: 'Open the billing page where this sector was saved.' };
          }
          ${FIND_SECTOR_SELECT}
          if (!sectorSelect) return { ok: false, error: 'Sector dropdown not found on current page' };

          const targetVal = ${targetValue};
          const targetC = ${targetCode};

          const opt = Array.from(sectorSelect.options).find(o =>
            (targetVal && o.value.trim() === targetVal.trim()) ||
            (targetC && (
              o.text.trim().startsWith(targetC + ' ') ||
              o.text.trim().startsWith(targetC + '–') ||
              o.text.trim().startsWith(targetC + '-')
            ))
          );
          if (!opt) return { ok: false, error: 'Matching sector option not found in dropdown' };

          sectorSelect.value = opt.value;
          sectorSelect.dispatchEvent(new Event('input', { bubbles: true }));
          sectorSelect.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true, selected: opt.text.trim(), value: opt.value };
        } catch (err) {
          return { ok: false, error: String(err) };
        }
      })()
    `;

    return wc.executeJavaScript(selectScript);
  });

  handle('bobo:sectors:clear', (payload) => {
    return sectorsService.clearSectors(payload?.domain);
  });
  return async function downloadPlayerVideo(window, source) {
    const url = playerVideoSource(source);
    if (!url) throw new Error('This player does not expose a supported direct video file.');
    const settingsState = await settings.state();
    if (!settingsState.tools.some((tool) => tool.id === 'social-video' && tool.enabled)) return;
    const destination = await socialVideo.snapshot();
    if (window.isDestroyed()) return;
    if (!destination.folder) {
      const folder = await dialog.showOpenDialog(window, {
        title: 'Choose video download folder', properties: ['openDirectory', 'createDirectory'],
      });
      if (folder.canceled || !folder.filePaths[0]) return;
      await socialVideo.setFolder(folder.filePaths[0]);
    }
    const publicUrl = url.split('?')[0];
    const state = await socialVideo.add([publicUrl]);
    const task = state.tasks.find(({ source: value }) => value === publicUrl);
    if (task?.status === 'Completed') return;
    if (!task) throw new Error('The video queue is full.');
    const result = await socialVideo.start(true, task.id, url);
    const saved = result.tasks.find(({ id }) => id === task.id);
    if (saved?.status === 'Failed') throw new Error(saved.error);
  };
}

module.exports = { readReaderDocument, registerToolIpc, safeFileName, stampedName };
