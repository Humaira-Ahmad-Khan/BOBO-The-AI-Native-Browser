'use strict';

// Offline regression for persistent hidden Angular loading elements.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const { controlScript, reportDate } = require('../../src/main/tools/daily-receive');
const root = path.resolve(__dirname, '../.tmp/receipt-readiness');
fs.mkdirSync(root, { recursive: true });
for (const key of ['userData', 'sessionData', 'crashDumps']) app.setPath(key, root);
app.setAppLogsPath(root);
app.commandLine.appendSwitch('disable-background-networking');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const page = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const date = reportDate(new Date('2026-11-06T07:00:00Z'));
  const html = `<input type="date" value="${date.iso}"><input type="date" value="${date.iso}">
    <label><input id="detail" type="radio" value="detail" checked>Detail</label>
    <button id="excel">Excel</button><p id="period">Receipt Period: ( 6/11/2026 - 6/11/2026 )</p>
    <table><tr><td>Dummy receipt</td></tr></table>
    <mat-progress-spinner style="display:block;width:30px;height:30px;visibility:hidden"></mat-progress-spinner>
    <div aria-busy="true" style="display:none"></div>
    <ngx-spinner><div class="ngx-spinner-overlay" style="display:none">Loading</div></ngx-spinner>`;
  const run = script => page.webContents.executeJavaScript(script);
  const status = () => run(controlScript('status', date));
  try {
    await page.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    assert.equal((await status()).ready, true, 'hidden loading elements must not block a completed report');
    await run("document.querySelector('mat-progress-spinner').style.visibility='visible'");
    assert.match((await status()).reason, /active loading/);
    await run("document.querySelector('mat-progress-spinner').style.opacity='0'");
    assert.equal((await status()).ready, true, 'transparent spinner is inactive');
    await run("document.querySelector('.ngx-spinner-overlay').style.display='block'");
    assert.match((await status()).reason, /active loading/);
    await run("document.querySelector('.ngx-spinner-overlay').style.display='none'; document.querySelector('#period').textContent='Receipt Period: ( 5/11/2026 - 5/11/2026 )'");
    assert.match((await status()).reason, /receipt period/);
    await run("document.querySelector('#period').textContent='Receipt Period: ( 06/11/2026 - 06/11/2026 )'; document.querySelector('input[type=date]').value='2026-11-05'");
    assert.match((await status()).reason, /date fields/);
    await run(`document.querySelector('input[type=date]').value=${JSON.stringify(date.iso)}; document.querySelector('#detail').checked=false`);
    assert.match((await status()).reason, /Detail/);
    await run("document.querySelector('#detail').checked=true; document.querySelector('#excel').remove()");
    assert.match((await status()).reason, /Excel/);
    console.log('PASS receipt readiness: hidden/transparent spinners ignored, visible loaders block, date variants match, wrong period/inputs/Detail/export are diagnosed.');
    page.destroy(); app.exit(0);
  } catch (error) { console.error(error); page.destroy(); app.exit(1); }
});
