'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { reserveDownloadPath, managedDownloadContents } = require('../downloads');
const { browserUserAgent } = require('../browser-user-agent');
const STAFF_REPORT_URL = 'https://water-supply-reports.vercel.app/daily-staff-receive';

// Runs only in the dedicated report window. It receives a filename, never file contents.
function staffControls(action, filename) {
  const body = document.body;
  if (!body) return ['upload-status', 'report-status'].includes(action) ?
    { ready: false, reason: 'the report document is still initializing' } : false;
  const text = value => String(value || '').replace(/\s+/g, ' ').trim();
  const fileKey = value => text(value).toLowerCase().replace(/[\s_()-]/g, '');
  const visible = el => el.getClientRects().length && !el.disabled && el.getAttribute('aria-disabled') !== 'true' &&
    el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  const buttons = (pattern, includeDisabled = false) => [...document.querySelectorAll('button, a, input[type="button"], input[type="submit"]')]
    .filter(el => (includeDisabled ? el.getClientRects().length : visible(el)) &&
      pattern.test(text(el.textContent || el.value).replace(/^[^a-z0-9]+/i, '')));
  const inputs = [...document.querySelectorAll('input[type="file"]')];
  const named = inputs.filter(input => {
    if (/Upload Daily Received Files/i.test([...input.labels || []].map(label => label.textContent).join(' ') +
        ' ' + (input.getAttribute('aria-label') || ''))) return true;
    let container = input.parentElement;
    for (let depth = 0; container && container !== document.body && depth < 4; depth++, container = container.parentElement) {
      if (/Upload Daily Received Files/i.test(container.textContent) && container.querySelectorAll('input[type="file"]').length === 1) return true;
    }
    return false;
  });
  const upload = named.length === 1 ? named[0] : inputs.length === 1 ? inputs[0] : null;
  const generate = buttons(/^Generate Staff Report$/i);
  // Staff performance bars are report data, not loading indicators.
  const busy = [...document.querySelectorAll('[aria-busy="true"], [role="progressbar"]')].some(el => visible(el) &&
    (el.getAttribute('aria-busy') === 'true' || /\b(?:loading|processing|generating)\b/i.test(
      `${el.getAttribute('aria-label') || ''} ${el.getAttribute('aria-valuetext') || ''}`)));
  const uploadReason = !inputs.length ? 'the page has no file upload input yet' :
    !upload ? 'multiple upload inputs are present but Daily Received Files is not uniquely labelled' :
      upload.disabled ? 'the daily-received-file input is disabled' :
        buttons(/^Generate Staff Report$/i, true).length !== 1 ? 'Generate Staff Report is missing or ambiguous' : '';
  if (action === 'upload-status') return { ready: !uploadReason, reason: uploadReason };
  if (action === 'upload-ready') return !uploadReason;
  if (action === 'upload-target') {
    if (uploadReason) return false;
    document.querySelectorAll('[data-bobo-receipt-upload]').forEach(el => el.removeAttribute('data-bobo-receipt-upload'));
    upload.setAttribute('data-bobo-receipt-upload', 'true');
    return true;
  }
  if (action === 'generate') {
    // The caller already assigned the source through CDP. React upload handlers
    // may clear FileList after parsing, before displaying the report filename.
    if (generate.length !== 1 || busy) return false;
    generate[0].click(); return true;
  }
  const summary = buttons(/^Summary Page Only$/i);
  const candidates = buttons(/^Summary Page Only$/i, true);
  const unavailable = reason => action === 'report-status' ? { ready: false, reason } : false;
  if (busy) return unavailable('the website still shows an active loading indicator');
  if (candidates.length !== 1) return unavailable(/No daily report generated/i.test(body.textContent) ?
    'the website has not generated a daily report from the uploaded file' : 'Summary Page Only is missing or ambiguous');
  if (summary.length !== 1) return unavailable('Summary Page Only is disabled');
  // Bind the export to the newly uploaded source, rather than a previously displayed report.
  let container = summary[0].parentElement;
  while (container && container !== body) {
    const content = text(container.innerText || container.textContent);
    const uploaded = [...content.matchAll(/Uploaded\s*:\s*(.+?\.(?:xlsx|xls|csv))(?=\s|$|Report)/gi)]
      .some(match => fileKey(match[1]) === fileKey(filename));
    if (/Staff Daily Progress/i.test(content) && /Uploaded\s*:/i.test(content) &&
        uploaded && container.querySelector('table, [role="table"]')) {
      if (action === 'summary-target') return summary[0].tagName === 'A' ?
        { kind: 'url', url: summary[0].href } : { kind: 'button' };
      if (action === 'summary') summary[0].click();
      return action === 'report-status' ? { ready: true, reason: '' } : true;
    }
    container = container.parentElement;
  }
  return unavailable('the staff report table does not identify the newly uploaded filename');
}

function staffScript(action, filename) {
  return `(${staffControls.toString()})(${JSON.stringify(action)},${JSON.stringify(filename)})`;
}

function isStaffPage(value) {
  try {
    const url = new URL(value), target = new URL(STAFF_REPORT_URL);
    return !url.username && !url.password && url.origin === target.origin &&
      url.pathname.replace(/\/$/, '') === target.pathname;
  } catch { return false; }
}

function isStaffSummaryUrl(value) {
  try {
    const url = new URL(value), target = new URL(STAFF_REPORT_URL);
    return !url.username && !url.password && url.origin === target.origin &&
      url.pathname === target.pathname + '/export/summary-pdf';
  } catch { return false; }
}

async function downloadStaffSummary({ owner, session, directory, sourceFile, date, recordDownload, onProgress, timeout = 90000 }) {
  const { app, BrowserWindow } = require('electron');
  if (owner.isDestroyed()) throw new Error('The originating browser window closed.');
  if (!path.isAbsolute(sourceFile) || !['.csv', '.xlsx', '.xls'].includes(path.extname(sourceFile).toLowerCase())) {
    throw new Error('Only the downloaded CSV or Excel report can be uploaded.');
  }
  const source = await fs.stat(sourceFile);
  if (!source.isFile() || !source.size || source.size > 64 * 1024 * 1024) throw new Error('The source report is empty or exceeds the 64 MB upload limit.');
  if (owner.isDestroyed()) throw new Error('The originating browser window closed.');
  const filename = path.basename(sourceFile);
  const page = new BrowserWindow({ show: false, width: 1400, height: 1000,
    webPreferences: { session, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const wc = page.webContents;
  wc.setUserAgent(browserUserAgent(wc.getUserAgent(), app.getName()));
  managedDownloadContents.add(wc);
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  let deniedNavigation = false;
  const guard = (event, url) => { if (!isStaffPage(url)) { deniedNavigation = true; event.preventDefault(); } };
  wc.on('will-navigate', guard); wc.on('will-redirect', guard);
  let settled = false, armed = false, item, filePath, accepted = false, stage = 'opening Daily Staff Receive', waitingReason = '';
  let fail, finish;
  const result = new Promise((resolve, reject) => {
    finish = value => { if (!settled) { settled = true; resolve(value); } };
    fail = error => { if (!settled) { settled = true; reject(error); } };
  });
  const timer = setTimeout(() => fail(new Error(`Daily Staff Receive timed out while ${stage}${waitingReason ? `: ${waitingReason}` : ''}. Check its login, saved staff assignments and report controls.`)), timeout);
  const ownerClosed = () => fail(new Error('Report cancelled because its browser window closed.'));
  owner.once('closed', ownerClosed);
  page.once('closed', () => fail(new Error('Daily Staff Receive was closed.')));
  wc.on('render-process-gone', () => fail(new Error('Daily Staff Receive stopped. Please retry.')));
  const onDownload = (_event, download, sourceContents) => {
    if (sourceContents !== wc) return;
    if (!armed || item || settled) { download.cancel(); return; }
    item = download;
    if (path.extname(item.getFilename()).toLowerCase() !== '.pdf') {
      item.cancel(); fail(new Error('Summary Page Only did not return a PDF.')); return;
    }
    try {
      filePath = reserveDownloadPath(directory, date.name.replace(' Daily Receive Amount', ' Daily Staff Receive Summary') + '.pdf');
      item.setSavePath(filePath);
    } catch { item.cancel(); fail(new Error('Could not save the summary PDF in Downloads.')); return; }
    item.once('done', async (_event, state) => {
      if (settled) return;
      try {
        if (state !== 'completed') throw new Error('Summary PDF download was interrupted.');
        const handle = await fs.open(filePath, 'r');
        try {
          const header = Buffer.alloc(5);
          if ((await handle.read(header, 0, 5, 0)).bytesRead !== 5 || header.toString('ascii') !== '%PDF-') {
            throw new Error('The report site returned invalid PDF content.');
          }
        } finally { await handle.close(); }
        if (settled) return;
        const stat = await fs.stat(filePath);
        if (settled) return;
        recordDownload?.({ filename: path.basename(filePath), filePath, totalBytes: stat.size, source: 'daily-staff-summary' });
        accepted = true; finish({ filePath });
      } catch (error) { fail(error); }
    });
  };
  session.on('will-download', onDownload);
  const check = () => {
    if (!isStaffPage(wc.getURL())) throw new Error('Open Daily Staff Receive and sign in in this BOBO profile before retrying.');
  };
  let documentReady, contextId, documentReadyAt = 0, documentWasReady = false;
  const documentLoaded = new Promise(resolve => { documentReady = () => {
    contextId = undefined;
    if (isStaffPage(wc.getURL())) { documentWasReady = true; documentReadyAt = Date.now(); resolve(true); }
  }; });
  wc.on('dom-ready', documentReady);
  const navigating = details => {
    if (details.isMainFrame && !details.isSameDocument) { contextId = undefined; documentReadyAt = 0; }
  };
  wc.on('did-start-navigation', navigating);
  let reportFrameId, chooserAllowed = false, chooserUsed = false;
  const onDebuggerMessage = (_event, method, params) => {
    if (method === 'Runtime.executionContextsCleared' ||
        method === 'Runtime.executionContextDestroyed' && params.executionContextId === contextId) contextId = undefined;
    if (method !== 'Page.fileChooserOpened') return;
    void (async () => {
      check();
      if (settled) return;
      if (!chooserAllowed || chooserUsed || params.frameId !== reportFrameId ||
          !Number.isInteger(params.backendNodeId) || params.backendNodeId <= 0) {
        throw new Error('An unexpected report file chooser was blocked.');
      }
      chooserUsed = true;
      chooserAllowed = false;
      const { node } = await wc.debugger.sendCommand('DOM.describeNode', { backendNodeId: params.backendNodeId });
      if (node.localName !== 'input' || !node.attributes?.some((attribute, index, attributes) =>
        index % 2 === 0 && attribute === 'type' && attributes[index + 1] === 'file')) throw new Error('The report chooser is not a file input.');
      if (settled) return;
      check();
      // Supply only this job's completed source, irrespective of the picker's last folder.
      await wc.debugger.sendCommand('DOM.setFileInputFiles', { backendNodeId: params.backendNodeId, files: [sourceFile] });
    })().catch(fail);
  };
  wc.debugger.on('message', onDebuggerMessage);
  const ensureContext = async () => {
    check();
    const age = documentReadyAt ? Date.now() - documentReadyAt : 0;
    if (age < 1500) await new Promise(resolve => setTimeout(resolve, 1500 - age));
    if (settled) return;
    check();
    if (contextId != null) return;
    const { frameTree } = await wc.debugger.sendCommand('Page.getFrameTree');
    if (!isStaffPage(frameTree.frame.url)) throw new Error('The report frame changed before upload.');
    reportFrameId = frameTree.frame.id;
    await wc.debugger.sendCommand('Page.enable');
    await wc.debugger.sendCommand('Runtime.enable');
    await wc.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true });
    const world = await wc.debugger.sendCommand('Page.createIsolatedWorld', {
      frameId: reportFrameId, worldName: 'BOBO daily staff report',
    });
    contextId = world.executionContextId;
  };
  const evaluate = async action => {
    // executeJavaScript/loadURL can wait for the full load event, including stalled
    // images. This dedicated debugger evaluates the ready document independently.
    for (let recovery = 0; recovery < 3 && !settled; recovery++) {
      try {
        await ensureContext();
        if (settled) break;
        const response = await wc.debugger.sendCommand('Runtime.evaluate', {
          expression: staffScript(action, filename), contextId, returnByValue: true, awaitPromise: true,
          userGesture: action === 'generate' || action === 'summary',
        });
        if (response.exceptionDetails) throw new Error('Could not read Daily Staff Receive controls.');
        return response.result.value;
      } catch (error) {
        if (wc.isDestroyed() || !/cannot find context|execution context.*destroyed|no frame with given id/i.test(error.message)) throw error;
        contextId = undefined;
        waitingReason = 'the page changed; waiting for its new document context';
        // A destroyed context may have followed a successful click. Do not repeat it.
        if (/execution context.*destroyed/i.test(error.message) && ['generate', 'summary'].includes(action)) return true;
        await new Promise(resolve => setTimeout(resolve, 500 * (recovery + 1)));
      }
    }
    return ['upload-status', 'report-status'].includes(action) ? { ready: false, reason: waitingReason } : false;
  };
  const waitFor = async action => {
    while (!settled) {
      check();
      if (action === 'upload-ready' || action === 'ready') {
        const status = await evaluate(action === 'ready' ? 'report-status' : 'upload-status');
        waitingReason = status.reason;
        if (status.ready) { waitingReason = ''; return true; }
      } else {
        const value = await evaluate(action);
        if (value) return value;
        if (action === 'summary' || action === 'summary-target') waitingReason = (await evaluate('report-status')).reason;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return false;
  };
  const work = async () => {
    onProgress?.('upload');
    wc.debugger.attach('1.3');
    void wc.loadURL(STAFF_REPORT_URL).catch(error => {
      if (settled) return;
      if (!deniedNavigation && (error.errno === -3 || error.code === 'ERR_ABORTED') && documentWasReady && isStaffPage(wc.getURL())) return;
      fail(new Error(deniedNavigation ? 'Daily Staff Receive redirected away from its report page. Open it and sign in in this BOBO profile before retrying.' :
        'Could not open Daily Staff Receive. Check its connection and certificate.'));
    });
    if (!await Promise.race([documentLoaded, result.then(() => false)]) || settled) return;
    check();
    stage = 'finding the Daily Received Files upload control';
    if (!await waitFor('upload-ready')) return;
    check();
    if (!await waitFor('upload-target')) return;
    // CDP assigns only this source to the labelled daily-receipts input, not the header's duplicate input.
    const { root } = await wc.debugger.sendCommand('DOM.getDocument');
    const { nodeIds } = await wc.debugger.sendCommand('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'input[type="file"][data-bobo-receipt-upload="true"]' });
    if (nodeIds.length !== 1) throw new Error('The report upload control changed. Please retry.');
    check();
    await wc.debugger.sendCommand('DOM.setFileInputFiles', { nodeId: nodeIds[0], files: [sourceFile] });
    if (settled) return;
    stage = 'generating the staff report'; onProgress?.('generate');
    await new Promise(resolve => setTimeout(resolve, 750));
    chooserAllowed = true;
    if (!await waitFor('generate')) return;
    stage = 'waiting for Staff Daily Progress for the uploaded file';
    if (!await waitFor('ready')) return;
    chooserAllowed = false;
    if (settled) return;
    stage = 'downloading Summary Page Only'; onProgress?.('summary');
    check();
    const target = await waitFor('summary-target');
    if (!target || settled) return;
    if (target.kind === 'url') {
      if (!isStaffSummaryUrl(target.url)) throw new Error('The summary link is not the approved HTTPS PDF export route.');
      check(); armed = true;
      // The export is an attachment route, not a page navigation. Keep navigation
      // confined to the report while delivering its PDF through the download manager.
      wc.downloadURL(target.url);
    } else if (target.kind === 'button') {
      armed = true;
      await waitFor('summary');
    } else throw new Error('The summary export control changed.');
  };
  void work().catch(fail);
  try { return await result; }
  finally {
    clearTimeout(timer); owner.removeListener('closed', ownerClosed);
    wc.removeListener('dom-ready', documentReady);
    wc.removeListener('did-start-navigation', navigating);
    wc.debugger.removeListener('message', onDebuggerMessage);
    session.removeListener('will-download', onDownload);
    if (item && item.getState() !== 'completed') item.cancel();
    if (!page.isDestroyed()) {
      // Destruction also detaches the debugger and cancels intercepted choosers.
      page.destroy();
    }
    managedDownloadContents.delete(wc);
    if (filePath && !accepted) await fs.unlink(filePath).catch(() => {});
  }
}

module.exports = { STAFF_REPORT_URL, isStaffPage, isStaffSummaryUrl, staffScript, downloadStaffSummary };

