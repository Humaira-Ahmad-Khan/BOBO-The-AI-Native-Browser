'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, dialog, ipcMain, session } = require('electron');
const root = path.join(__dirname, '.tmp'); fs.mkdirSync(root, { recursive: true });
const profile = fs.mkdtempSync(path.join(root, 'export-pages-'));
for (const name of ['userData', 'sessionData', 'crashDumps']) app.setPath(name, profile);
app.setAppLogsPath(profile); app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-networking');
const url = 'https://elgcd.punjab.gov.pk/e-billing/consumers-list';
let saves = 0;
dialog.showSaveDialog = async () => ({ canceled: false, filePath: path.join(profile, `export-${++saves}.csv`) });
const handlers = new Map(); const register = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => { handlers.set(channel, handler); return register(channel, handler); };
app.whenReady().then(() => {
  session.defaultSession.enableNetworkEmulation({ offline: true });
  session.defaultSession.protocol.handle('https', () => new Response(`
    <table><thead><tr>${['Sr #', 'Consumer Name', 'F/H Name', 'Mobile', 'Sector', 'Locality', 'Address', 'Order No.', 'Rate Type', 'Connection No.', 'Old Connection No.', 'Connection Date', 'Status', 'Consumer Status', 'Actions'].map(c => '<th>' + c + '</th>').join('')}</tr></thead><tbody></tbody></table>
    <mat-paginator>
      <select><option value="100">100</option><option value="5000">5000</option></select>
      <span class="mat-paginator-page-size-value">100</span><span class="mat-paginator-range-label"></span>
      <button class="mat-paginator-navigation-first" aria-label="First page">First</button>
      <button class="mat-paginator-navigation-next" aria-label="Next page">Next</button>
    </mat-paginator>
    <script>
      const total = 27892; let current = 2; let size = 100; let failAt = 0;
      window.pageClicks = 0;
      function render(next) {
        current = next;
        const start = (current - 1) * size + 1; const end = Math.min(current * size, total);
        document.querySelector('.mat-paginator-range-label').textContent = start.toLocaleString('en-US') + ' – ' + end.toLocaleString('en-US') + ' of 27,892';
        document.querySelector('.mat-paginator-page-size-value').textContent = size.toLocaleString('en-US');
        document.querySelector('.mat-paginator-navigation-first').disabled = current === 1;
        document.querySelector('.mat-paginator-navigation-next').disabled = end === total || current === failAt;
        // Counter changes before the asynchronous table update, as on the portal.
        setTimeout(() => {
          let html = '';
          for (let n = start; n <= end; n++) {
            html += '<tr>';
            for (let col = 0; col < 15; col++) html += '<td>' + (col === 9 ? String(90000000 + n) : col === 0 ? n : 'Value ' + col + '-' + n) + '</td>';
            html += '</tr>';
          }
          document.querySelector('tbody').innerHTML = html;
        }, 150);
      }
      document.querySelector('select').onchange = event => { size = Number(event.target.value); render(1); };
      document.querySelector('.mat-paginator-navigation-first').onclick = () => { pageClicks++; render(1); };
      document.querySelector('.mat-paginator-navigation-next').onclick = () => { pageClicks++; render(current + 1); };
      window.breakNext = () => { failAt = 2; };
      render(current);
    </script>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
});
require('../../src/main/main');
let diagnose;
async function until(read, label) {
  for (let i = 0; i < 1500; i++) {
    if (await read()) return;
    if (diagnose && i % 50 === 0) {
      const status = await diagnose();
      console.log(label, status);
      if (/Error:|No incomplete|^Saved /.test(status)) throw Error(label + ': ' + status);
    }
    await new Promise(r => setTimeout(r, 40));
  }
  throw Error('Timed out: ' + label + ' / ' + (diagnose ? await diagnose() : ''));
}
app.whenReady().then(async () => {
  await until(() => BrowserWindow.getAllWindows()[0]?.webContents.getURL().endsWith('/index.html'), 'chrome');
  const win = BrowserWindow.getAllWindows()[0]; const run = js => win.webContents.executeJavaScript(js);
  diagnose = () => run('document.querySelector("#export-status").textContent');
  await until(() => run('typeof bobo.collectExportPages === "function"'), 'bridge');
  const tabId = await run(`bobo.createTab(${JSON.stringify(url)})`);
  let page;
  await until(() => { page = win.contentView.children.find(view => view.webContents?.getURL() === url)?.webContents; return Boolean(page); }, 'page');
  await until(() => page.executeJavaScript('document.querySelectorAll("tbody tr").length === 100'), 'initial rows');
  await run('document.querySelector("[data-tool-open=export]").click()');
  await run('document.querySelector("#export-inspect-btn").click()');
  await until(() => run('document.querySelectorAll("#export-columns-grid input").length === 15'), 'columns');
  const detected = await run('bobo.inspectTable()');
  console.log('Initial inspection', JSON.stringify({ total: detected.totalRecords, start: detected.rangeStart, end: detected.rangeEnd, pages: detected.totalPages, pageSize: detected.pageSize }));
  console.log('Counter', await page.executeJavaScript('document.querySelector(".mat-paginator-range-label").textContent'));
  const choose = async scope => run(`(() => {
    document.querySelector('#export-clear-cols').click();
    document.querySelector('#export-columns-grid input[data-column="Connection No."]').click();
    document.querySelector('input[name="export-scope"][value="${scope}"]').checked = true;
    document.querySelector('#export-page-from').value = '1'; document.querySelector('#export-page-to').value = '5';
    document.querySelector('#export-start-btn').click();
  })()`);
  await choose('all');
  await run('bobo.createTab()'); // Export must remain bound to the original tab.
  await until(() => run('document.querySelector("#export-status").textContent.startsWith("Saved 27,892 rows from 6")'), 'all six pages');
  const read = number => fs.readFileSync(path.join(profile, `export-${number}.csv`), 'utf8').trimEnd().split('\r\n');
  let lines = read(1);
  assert.equal(lines.length, 27893); assert.equal(lines[0], '\uFEFF"Connection No."');
  assert.equal(lines[1], '"90000001"'); assert.equal(lines.at(-1), '"90027892"');
  assert.equal(new Set(lines.slice(1)).size, 27892, 'no missing or repeated connections');
  await choose('range');
  await until(() => run('document.querySelector("#export-status").textContent.startsWith("Saved 25,000 rows from 5")'), 'pages one to five');
  lines = read(2); assert.equal(lines.length, 25001); assert.equal(lines.at(-1), '"90025000"');
  // Current-page export must read fresh source rows, even after previous pagination.
  const clicks = await page.executeJavaScript('pageClicks');
  await choose('current');
  await until(() => run('document.querySelector("#export-status").textContent.startsWith("Saved 5,000 rows from 1")'), 'current page');
  lines = read(3); assert.equal(lines.length, 5001); assert.equal(lines[1], '"90020001"');
  assert.equal(await page.executeJavaScript('pageClicks'), clicks);
  await page.executeJavaScript('breakNext()');
  await choose('all');
  await until(() => run('document.querySelector("#export-status").textContent.includes("No incomplete export was saved")'), 'blocked next page');
  assert.equal(saves, 3, 'failure never saves a partial file');
  await assert.rejects(() => run(`bobo.collectExportPages({tabId:${tabId},pageId:-1,scope:'all'})`), /unavailable/);
  await assert.rejects(async () => handlers.get('bobo:export:collect-pages')({ sender: page, senderFrame: page.mainFrame }, {}), /blocked/);
  console.log('PASS Data Export: 27,892 rows across six 5,000-row pages; range 1–5 exports 25,000; current page; selected single column; page-size change; delayed rows; tab switching; no duplicate rows; incomplete export and wrong sender rejected.');
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
