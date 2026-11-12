'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const { staffScript } = require('../../src/main/tools/daily-staff-summary');
const root = path.resolve(__dirname, '../.tmp/staff-upload');
fs.mkdirSync(root, { recursive: true });
for (const key of ['userData', 'sessionData', 'crashDumps']) app.setPath(key, root);
app.setAppLogsPath(root);
app.commandLine.appendSwitch('disable-background-networking');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const page = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const run = script => page.webContents.executeJavaScript(script);
  const load = content => page.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(content));
  const generate = '<button disabled>Generate Staff Report</button>';
  try {
    const shapes = [
      '<label>Upload Daily Received Files<input id="daily" type="file" hidden></label>',
      '<input id="daily" type="file" hidden><label for="daily">Upload Daily Received Files</label>',
      '<div><span>Upload Daily Received Files</span><input id="daily" type="file" hidden></div>',
    ];
    for (const shape of shapes) {
      await load('<label>Upload Files<input id="header" type="file" hidden></label>' + shape + generate);
      assert.equal((await run(staffScript('upload-status', 'dummy.xlsx'))).ready, true);
      assert.equal(await run(staffScript('upload-target', 'dummy.xlsx')), true);
      assert.equal(await run("document.querySelector('[data-bobo-receipt-upload]').id"), 'daily');
    }
    await load('<input type="file"><input type="file">' + generate);
    assert.match((await run(staffScript('upload-status', 'dummy.xlsx'))).reason, /multiple upload inputs/);
    assert.equal(await run(staffScript('upload-target', 'dummy.xlsx')), false);
    await load('<h1>Loading</h1>');
    assert.match((await run(staffScript('upload-status', 'dummy.xlsx'))).reason, /no file upload/);
    await load('<section><h2>Staff Daily Progress</h2><p>Uploaded: dummy.xlsx</p><table><tr><td>Dummy</td></tr></table><button>⬇ Summary Page Only</button></section>');
    assert.equal((await run(staffScript('report-status', 'dummy.xlsx'))).ready, true);
    await run("const p=document.createElement('div');p.setAttribute('role','progressbar');p.setAttribute('aria-label','Staff performance');p.textContent='75%';document.body.append(p)");
    assert.equal((await run(staffScript('report-status', 'dummy.xlsx'))).ready, true, 'staff performance bars are not loaders');
    await run("document.querySelector('[role=progressbar]').setAttribute('aria-label','Loading report')");
    assert.match((await run(staffScript('report-status', 'dummy.xlsx'))).reason, /loading/);
    await run("document.querySelector('[role=progressbar]').remove()");
    assert.match((await run(staffScript('report-status', 'other.xlsx'))).reason, /filename/);
    await run("document.querySelector('button').disabled=true");
    assert.match((await run(staffScript('report-status', 'dummy.xlsx'))).reason, /disabled/);
    await load('<section><h2>Staff Daily Progress</h2><p>Uploaded: 06-11-26_Daily_Receive_Amount_2.xlsx</p><table><tr><td>Dummy</td></tr></table><button>⬇ Summary Page Only</button></section>');
    assert.equal((await run(staffScript('report-status', '06-11-26 Daily Receive Amount (2).xlsx'))).ready, true);
    assert.equal((await run(staffScript('report-status', '06-11-26 Daily Receive Amount (20).xlsx'))).ready, false);
    await load('<label>Upload Daily Received Files<input type="file"></label><button>Generate Staff Report</button>');
    assert.equal(await run(staffScript('generate', 'dummy.xlsx')), true, 'a successfully assigned upload may have its FileList cleared by the site');
    await run('document.body.remove()');
    assert.match((await run(staffScript('report-status', 'dummy.xlsx'))).reason, /initializing/);
    console.log('PASS staff upload: duplicate inputs, nested/external labels, upload cards and ambiguous/missing input diagnostics.');
    page.destroy(); app.exit(0);
  } catch (error) { console.error(error); page.destroy(); app.exit(1); }
});
