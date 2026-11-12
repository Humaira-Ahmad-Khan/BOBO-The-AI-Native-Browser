'use strict';
// Offline Electron integration: real hidden page, form events, blob download and IPC.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, session } = require('electron');
const applicationRoot = process.env.BOBO_SMOKE_APP_ROOT || path.resolve(__dirname, '../..');
const { REPORT_URL, reportDate, downloadDailyReport } = require(path.join(applicationRoot, 'src/main/tools/daily-receive'));
const { STAFF_REPORT_URL, downloadStaffSummary } = require(path.join(applicationRoot, 'src/main/tools/daily-staff-summary'));
const root = path.join(__dirname, '.tmp');
fs.mkdirSync(root, { recursive: true });
const profile = fs.mkdtempSync(path.join(root, 'daily-receive-'));
for (const key of ['userData', 'sessionData', 'crashDumps']) app.setPath(key, profile);
app.setAppLogsPath(profile);
app.commandLine.appendSwitch('disable-background-networking');
app.disableHardwareAcceleration();
let mode = 'report';
let staffFullLoads = 0;
let staffLoads = 0, chooserEvents = 0;
let staleContextInjected = false;
let staffLoadTimes = [];
app.on('web-contents-created', (_event, contents) => {
  contents.on('did-finish-load', () => { if (contents.getURL() === STAFF_REPORT_URL) staffFullLoads++; });
  contents.debugger.on('message', (_event, method) => { if (method === 'Page.fileChooserOpened') chooserEvents++; });
  const send = contents.debugger.sendCommand.bind(contents.debugger);
  contents.debugger.sendCommand = async (...args) => {
    const reply = await send(...args);
    if (args[0] === 'Page.createIsolatedWorld' && !staleContextInjected && contents.getURL() === STAFF_REPORT_URL) {
      staleContextInjected = true;
      const reloaded = new Promise(resolve => contents.once('dom-ready', resolve));
      contents.reload(); await reloaded;
      // Return the real ID from the destroyed document to reproduce the live error.
    }
    return reply;
  };
});
const handlers = new Map();
let fixtureReady;
const register = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => { handlers.set(channel, handler); return register(channel, handler); };
fixtureReady = app.whenReady().then(async () => {
  session.defaultSession.enableNetworkEmulation({ offline: true });
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] },
    ({ url }, done) => done({ cancel: !url.startsWith('https://elgcd.punjab.gov.pk/') && !url.startsWith('https://water-supply-reports.vercel.app/') }));
  await session.defaultSession.cookies.set({ url: REPORT_URL, name: 'fixtureLogin', value: 'yes' });
  session.defaultSession.protocol.handle('https', request => {
    if (request.url === new URL('/hanging-test-image', STAFF_REPORT_URL).href) return new Promise(() => {});
    if (new URL(request.url).pathname === '/daily-staff-receive/export/summary-pdf') {
      const invalid = mode === 'invalidPdf' || mode === 'retry-success' && staffLoads < 3;
      return new Response(invalid ? 'not a PDF' : '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF', {
        headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="staff-summary.pdf"' },
      });
    }
    if (request.url.startsWith(new URL(STAFF_REPORT_URL).origin)) {
      staffLoads++;
      staffLoadTimes.push(Date.now());
      if (mode === 'staffRedirect' && request.url === STAFF_REPORT_URL) return new Response(null, { status: 302, headers: { Location: '/login' } });
      return new Response(mode === 'staffMissing' ? '<h1>Sign in</h1>' : `
        <h1>Daily Receiving Report</h1><img src="/hanging-test-image" alt="" width="1" height="1"><label>Upload Files<input id="headerUpload" type="file" hidden accept=".csv,.xlsx,.xls"></label>
        <label>Upload Daily Received Files<input id="upload" type="file" hidden accept=".csv,.xlsx,.xls"></label>
        <input id="reportUpload" type="file" hidden accept=".csv,.xlsx,.xls">
        <button id="generate" disabled>Generate Staff Report</button><section id="staff"></section>
        <script>
          let name = '';
          upload.onchange = async () => {
            if (headerUpload.files.length) throw Error('The unrelated header upload input was used');
            if (upload.files.length !== 1 || !(await upload.files[0].text()).startsWith('Date,Amount')) throw Error('Wrong source file');
            name = upload.files[0].name; upload.value = ''; setTimeout(() => generate.disabled = false, 350);
          };
          generate.onclick = () => {
            if (!navigator.userActivation.isActive) throw Error('Generate requires a user gesture');
            reportUpload.click();
          };
          reportUpload.onchange = async () => {
            if (reportUpload.files.length !== 1 || reportUpload.files[0].name !== name ||
                !(await reportUpload.files[0].text()).startsWith('Date,Amount')) throw Error('Chooser did not receive the just-downloaded file');
            reportUpload.value = '';
            generate.disabled = true;
            setTimeout(() => {
              staff.innerHTML = '<h2>Staff Daily Progress</h2><p>Uploaded: <span id="uploaded"></span></p><table><tr><td>Dummy Staff</td><td>2400</td></tr></table><a href="/daily-staff-receive/export/summary-pdf?cols=staffName%2Camount">⬇ Summary Page Only</a>';
              uploaded.textContent = name.replace(/[\\s()]+/g, '_');
            }, 500);
          };
        </script>`, { headers: { 'Content-Type': 'text/html' } });
    }
    if (mode === 'redirect' && request.url === REPORT_URL) return new Response(null, {
      status: 302, headers: { Location: '/login' },
    });
    return new Response(['login', 'redirect'].includes(mode) ? '<h1>Sign in</h1>' : `
    <h1>Water Bills Date Wise Receipts Report</h1>
    <label>Receipt Date</label><input id="from" readonly class="mat-datepicker-input"><input id="to" readonly class="mat-datepicker-input">
    <label><input type="radio" name="kind" value="detail">Detail</label>
    <label><input type="radio" name="kind" value="summary" checked>Summary</label>
    <button id="show">Show Report</button><section id="report"></section>
    <mat-progress-spinner style="display:block;width:30px;height:30px;visibility:hidden"></mat-progress-spinner>
    <div aria-busy="true" style="display:none"></div>
    <script>
      let changed = new Set();
      document.querySelectorAll('#from,#to').forEach(el => el.onchange = () => changed.add(el.id));
      document.querySelectorAll('#from,#to').forEach(input => input.onclick = () => {
        const calendar = document.createElement('mat-calendar');
        const day = document.createElement('div');
        day.setAttribute('aria-label', ${JSON.stringify(new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Karachi' }).format(new Date()))});
        const content = document.createElement('button'); content.className = 'mat-calendar-body-cell-content'; content.textContent = 'Today';
        let used = false;
        content.onclick = () => { if (used) return; used = true; input.value = ${JSON.stringify(reportDate().display)}; input.dispatchEvent(new Event('change')); setTimeout(() => calendar.remove(), 600); };
        day.append(content);
        calendar.append(day); document.body.append(calendar);
      });
      show.onclick = () => {
        if (!document.cookie.includes('fixtureLogin=yes')) throw Error('Wrong profile');
        if (changed.size !== 2 || !document.querySelector('[value=detail]').checked) throw Error('Incorrect form events');
        setTimeout(() => {
          const date = from.value;
          report.innerHTML = '<p>Receipt Period: (' + date + ' - ' + date + ')</p><table><tr><td>2400</td></tr></table><button id="excel">Excel</button>';
          excel.onclick = () => {
            const data = new Blob(['Date,Amount\\r\\n' + date + ',2400\\r\\n'], {type:'text/csv'});
            const a = document.createElement('a'); a.href = URL.createObjectURL(data); a.download = ${JSON.stringify(mode === 'unsafe' ? 'portal.exe' : 'portal.csv')}; a.click();
          };
        }, 1200);
      };
    </script>`, { headers: { 'Content-Type': 'text/html' } });
  });
});
require(path.join(applicationRoot, 'src/main/main'));
async function until(read) {
  for (let i = 0; i < 400; i++) { if (await read()) return; await new Promise(resolve => setTimeout(resolve, 40)); }
  for (const win of BrowserWindow.getAllWindows()) console.error(win.webContents.getURL(), await win.webContents.executeJavaScript('document.body.outerHTML.slice(0,2000)'));
  throw new Error('Fixture timed out');
}
app.whenReady().then(async () => {
  await fixtureReady;
  await until(() => BrowserWindow.getAllWindows()[0]?.webContents.getURL().endsWith('/index.html'));
  const owner = BrowserWindow.getAllWindows()[0];
  const run = js => owner.webContents.executeJavaScript(js);
  await until(() => run(`!!document.querySelector('[data-tool-open="daily-receive"]')`));
  await run(`bobo.setBrowserSettings({ downloads: { ask: false, directory: ${JSON.stringify(profile)} } })`);
  await run(`document.querySelector('[data-tool-open="daily-receive"]').click(); document.querySelector('#daily-receive-download').click()`);
  await assert.rejects(() => run('bobo.downloadDailyReceive()'), /already running/);
  await run('bobo.createTab()'); // Switching tabs must not interrupt the job.
  await until(() => run(`document.querySelector('#daily-receive-status').textContent.startsWith('Saved ')`));
  const name = reportDate().name + '.csv';
  assert.equal(fs.readFileSync(path.join(profile, name), 'utf8'), `Date,Amount\r\n${reportDate().display},2400\r\n`);
  const summaryName = reportDate().name.replace(' Daily Receive Amount', ' Daily Staff Receive Summary') + '.pdf';
  assert.ok(fs.readFileSync(path.join(profile, summaryName), 'utf8').startsWith('%PDF-'));
  assert.equal(staleContextInjected, true, 'real document reload invalidated the original context before evaluation');
  assert.equal(BrowserWindow.getAllWindows().length, 1, 'hidden report destroyed');
  const records = await run('bobo.listDownloads()');
  assert.equal(records.filter(item => item.filename === name).length, 1, 'recorded once');
  assert.equal(records.filter(item => item.filename === summaryName).length, 1, 'summary recorded once');
  await run('bobo.downloadDailyReceive()');
  assert.ok(fs.existsSync(path.join(profile, reportDate().name + ' (1).csv')), 'never overwrite previous report');
  assert.ok(fs.existsSync(path.join(profile, summaryName.replace('.pdf', ' (1).pdf'))), 'never overwrite previous PDF');
  assert.equal(staffFullLoads, 0, 'summary export completes despite a resource that prevents full page load');
  assert.equal(chooserEvents, 2, 'each Generate chooser is intercepted with the exact source path, including collision suffixes');
  await assert.rejects(() => handlers.get('bobo:daily-receive:download')({ sender: owner.webContents, senderFrame: owner.webContents.mainFrame }, { url: 'https://evil.test' }), /invalid report/);
  const remote = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await remote.loadURL(REPORT_URL);
  assert.equal(await remote.webContents.executeJavaScript('typeof window.bobo'), 'undefined');
  await assert.rejects(async () => handlers.get('bobo:daily-receive:download')({ sender: remote.webContents, senderFrame: remote.webContents.mainFrame }), /blocked/);
  remote.destroy();
  const listeners = session.defaultSession.listenerCount('will-download');
  mode = 'login';
  await assert.rejects(() => downloadDailyReport({ owner, session: session.defaultSession, directory: profile, timeout: 700 }), /timed out/);
  assert.equal(session.defaultSession.listenerCount('will-download'), listeners, 'timeout listener removed');
  assert.equal(BrowserWindow.getAllWindows().length, 1);
  mode = 'redirect';
  await assert.rejects(() => run('bobo.downloadDailyReceive()'), /Sign in to eLGCDD/);
  mode = 'unsafe';
  await assert.rejects(() => run('bobo.downloadDailyReceive()'), /did not return a CSV or Excel/);
  assert.equal(session.defaultSession.listenerCount('will-download'), listeners);
  mode = 'invalidPdf';
  staffLoads = 0; staffLoadTimes = [];
  await assert.rejects(() => run('bobo.downloadDailyReceive()'), /Source report saved.*invalid PDF content/);
  assert.equal(staffLoads, 4, 'four failed summary attempts, without repeating the source download');
  for (let index = 1; index < 4; index++) assert.ok(staffLoadTimes[index] - staffLoadTimes[index - 1] >= index * 5000,
    'attempts respect the 5/10/15 second retry waits');
  assert.ok(fs.existsSync(path.join(profile, reportDate().name + ' (2).csv')), 'source retained after PDF failure');
  assert.equal(fs.existsSync(path.join(profile, summaryName.replace('.pdf', ' (2).pdf'))), false, 'invalid PDF removed');
  assert.equal(session.defaultSession.listenerCount('will-download'), listeners, 'summary listeners cleaned after failure');
  mode = 'staffMissing';
  await assert.rejects(() => downloadStaffSummary({ owner, session: session.defaultSession, directory: profile,
    sourceFile: path.join(profile, name), date: reportDate(), timeout: 700 }), /timed out/);
  mode = 'staffRedirect';
  await assert.rejects(() => downloadStaffSummary({ owner, session: session.defaultSession, directory: profile,
    sourceFile: path.join(profile, name), date: reportDate(), timeout: 700 }), /sign in|ERR_ABORTED|timed out/i);
  assert.equal(session.defaultSession.listenerCount('will-download'), listeners);
  mode = 'retry-success'; staffLoads = 0;
  const retried = await run('bobo.downloadDailyReceive()');
  assert.equal(retried.attempts, 3, 'stop retrying immediately after the third attempt succeeds');
  assert.equal(staffLoads, 3);
  assert.ok(fs.existsSync(path.join(profile, reportDate().name + ' (3).csv')));
  assert.equal(fs.existsSync(path.join(profile, reportDate().name + ' (4).csv')), false, 'source is downloaded once, not per upload attempt');
  await run('bobo.configureTool("daily-receive", { enabled: false })');
  await assert.rejects(() => run('bobo.downloadDailyReceive()'), /disabled/);
  assert.equal(BrowserWindow.getAllWindows().length, 1);
  console.log('PASS Daily Receive: one-click source download, exact-path chooser interception, user activation, summary PDF, four-attempt limit, success on attempt three, one source download, cookies, dates, tab switching, collision names, download records, IPC denials, cleanup and source preservation.');
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
