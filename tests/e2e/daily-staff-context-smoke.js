'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, session } = require('electron');
const { downloadStaffSummary } = require('../../src/main/tools/daily-staff-summary');
const { reportDate } = require('../../src/main/tools/daily-receive');
const root = path.resolve(__dirname, '../.tmp/staff-context');
fs.mkdirSync(root, { recursive: true });
for (const key of ['userData', 'sessionData', 'crashDumps']) app.setPath(key, root);
app.setAppLogsPath(root);
app.commandLine.appendSwitch('disable-background-networking');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  session.defaultSession.enableNetworkEmulation({ offline: true });
  session.defaultSession.protocol.handle('https', () => new Response(`
    <label>Upload Daily Received Files<input type="file" id="upload"></label>
    <button id="generate" disabled>Generate Staff Report</button><section id="report"></section>
    <script>
      let name;
      upload.onchange=()=>{name=upload.files[0].name;upload.value='';generate.disabled=false};
      generate.onclick=()=>{report.innerHTML='<h2>Staff Daily Progress</h2><p>Uploaded: '+name+'</p><table><tr><td>Dummy</td></tr></table><button id="summary">Summary Page Only</button>';
        summary.onclick=()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['%PDF-1.4\\n%%EOF']));a.download='summary.pdf';a.click()}};
    </script>`, { headers: { 'Content-Type': 'text/html' } }));
  const owner = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  let invalidated = false, missingContextErrors = 0;
  app.on('web-contents-created', (_event, contents) => {
    const send = contents.debugger.sendCommand.bind(contents.debugger);
    contents.debugger.sendCommand = async (...args) => {
      try {
        const reply = await send(...args);
        if (args[0] === 'Page.createIsolatedWorld' && !invalidated) {
          invalidated = true;
          const ready = new Promise(resolve => contents.once('dom-ready', resolve));
          contents.reload(); await ready;
        }
        return reply;
      } catch (error) {
        if (/cannot find context/i.test(error.message)) missingContextErrors++;
        throw error;
      }
    };
  });
  const sourceFile = path.join(root, 'dummy.csv'); fs.writeFileSync(sourceFile, 'Date,Amount\n2026-11-06,1\n');
  try {
    // Direct helper invocation has no outer job retries: recovery must happen inside this attempt.
    const result = await downloadStaffSummary({ owner, session: session.defaultSession, directory: root,
      sourceFile, date: reportDate(), timeout: 15000 });
    assert.equal(invalidated, true);
    assert.ok(missingContextErrors > 0, 'actual stale-context protocol error was reproduced');
    assert.ok(fs.readFileSync(result.filePath, 'utf8').startsWith('%PDF-'));
    console.log('PASS context reload regression: real document reload causes missing-context error, then the same attempt recovers and downloads its dummy PDF.');
    owner.destroy(); app.exit(0);
  } catch (error) { console.error(error); owner.destroy(); app.exit(1); }
});
