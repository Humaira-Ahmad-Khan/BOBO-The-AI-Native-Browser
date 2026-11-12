'use strict';
// Explicit, per-run human network/upload approval is required. Not in the default test suite.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
if (!process.argv.includes('--approved-dummy-upload')) app.exit(2);
const { downloadStaffSummary, STAFF_REPORT_URL } = require('../../src/main/tools/daily-staff-summary');
const { reportDate } = require('../../src/main/tools/daily-receive');
const { hardenApp } = require('../../src/main/security');
const base = path.resolve(__dirname, '../.tmp');
fs.mkdirSync(base, { recursive: true });
const root = fs.mkdtempSync(path.join(base, 'staff-live-'));
const diagnostic = process.argv.includes('--diagnostic-session');
const commandFile = path.join(base, 'staff-live-command.json');
let reportPage, destroyReport;
for (const key of ['userData', 'sessionData', 'crashDumps']) app.setPath(key, root);
app.setAppLogsPath(root);
app.commandLine.appendSwitch('disable-background-networking');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  hardenApp();
  const targetOrigin = new URL(STAFF_REPORT_URL).origin;
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] },
    ({ url }, done) => done({ cancel: new URL(url).origin !== targetOrigin }));
  const owner = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  app.on('web-contents-created', (_event, contents) => {
    const send = contents.debugger.sendCommand.bind(contents.debugger);
    contents.debugger.sendCommand = async (...args) => {
      const reply = await send(...args);
      if (reply.exceptionDetails) console.error('Dummy-only script exception:', reply.exceptionDetails.exception?.className, 'at line', reply.exceptionDetails.lineNumber);
      return reply;
    };
    contents.on('dom-ready', () => {
      if (diagnostic && contents.getURL().startsWith(STAFF_REPORT_URL) && !reportPage) {
        reportPage = BrowserWindow.fromWebContents(contents);
        destroyReport = reportPage.destroy.bind(reportPage);
        reportPage.destroy = () => {};
      }
    });
  });
  const date = reportDate();
  const sourceFile = path.join(root, 'bobo-dummy-receipts.csv');
  fs.writeFileSync(sourceFile, 'Received Date,Sector,Locality,Arrears,Amount Receive,Amount Received,Consumer Name,Connection No\r\n' +
    `${date.display},BOBO TEST SECTOR,BOBO TEST LOCALITY,0,1,1,BOBO DUMMY ACCOUNT,0000000\r\n`);
  let stage = 'starting';
  try {
    const result = await downloadStaffSummary({ owner, session: session.defaultSession, directory: root, sourceFile, date,
      timeout: 90000, onProgress: value => { stage = value; console.log(`Dummy live test stage: ${value}`); } });
    console.log(`PASS live dummy summary PDF (${fs.statSync(result.filePath).size} bytes). Real source reports were not read.`);
    owner.destroy(); app.exit(0);
  } catch (error) {
    console.error(`Live dummy test stopped at ${stage}: ${error.message}`);
    if (diagnostic && reportPage && !reportPage.isDestroyed()) {
      const wc = reportPage.webContents;
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
      let armed = false;
      session.defaultSession.on('will-download', (_event, item, contents) => {
        if (contents !== wc) return;
        if (!armed || path.extname(item.getFilename()).toLowerCase() !== '.pdf') { item.cancel(); return; }
        armed = false;
        const file = path.join(root, 'dummy-diagnostic-summary.pdf');
        item.setSavePath(file);
        item.once('done', (_event, state) => {
          const valid = state === 'completed' && fs.readFileSync(file).subarray(0, 5).toString('ascii') === '%PDF-';
          console.log(`Diagnostic PDF: ${valid ? 'PASS' : 'FAIL'}${valid ? ` (${fs.statSync(file).size} bytes)` : ''}`);
        });
      });
      const inspect = async () => {
        delete require.cache[require.resolve('./daily-staff-diagnostic')];
        await require('./daily-staff-diagnostic').run('inspect', { wc, filename: path.basename(sourceFile) });
      };
      await inspect();
      console.log('DIAGNOSTIC SESSION READY. One dummy upload only. Commands: inspect, export, stop.');
      const timer = setInterval(async () => {
        if (!fs.existsSync(commandFile)) return;
        let command;
        try { command = JSON.parse(fs.readFileSync(commandFile, 'utf8')); fs.unlinkSync(commandFile); }
        catch { return; }
        try {
          if (command === 'inspect') await inspect();
          if (command === 'export') {
            delete require.cache[require.resolve('./daily-staff-diagnostic')];
            armed = true;
            await require('./daily-staff-diagnostic').run('export', { wc, filename: path.basename(sourceFile) });
          }
          if (command === 'stop') { clearInterval(timer); destroyReport(); owner.destroy(); app.exit(0); }
        } catch (failure) { console.error('Dummy diagnostic command failed:', failure.message); }
      }, 250);
      return;
    }
    owner.destroy(); app.exit(1);
  }
});
