'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const { controlScript, reportDate } = require('../../src/main/tools/daily-receive');
const root = path.resolve(__dirname, '../.tmp/receipt-calendar');
fs.mkdirSync(root, { recursive: true });
for (const key of ['userData', 'sessionData', 'crashDumps']) app.setPath(key, root);
app.setAppLogsPath(root);
app.commandLine.appendSwitch('disable-background-networking');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const page = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const date = reportDate(new Date('2026-11-06T07:00:00Z'));
  const run = script => page.webContents.executeJavaScript(script);
  try {
    for (const scenario of ['reused-british', 'slow-american', 'already-selected', 'associated-popup']) {
      const label = scenario === 'slow-american' ? 'November 6, 2026' : 'Friday, 6 November 2026';
      const html = `<h1>Water Bills Date Wise Receipts Report</h1>
        <input id="from" readonly class="mat-datepicker-input" aria-controls="calendar"><input id="to" readonly class="mat-datepicker-input" aria-controls="calendar">
        <label><input id="detail" type="radio" name="kind" value="detail">Detail</label>
        <button id="show">Show Report</button>
        <mat-calendar id="calendar" style="display:none"><button id="day" aria-label="${label}">6</button></mat-calendar>
        <script>
          let target, closed, changed = new Set(); window.shown = false; window.opened = 0;
          document.querySelectorAll('#from,#to').forEach(input => {
            input.onchange = () => changed.add(input.id);
            input.onclick = () => {
              window.opened++; clearTimeout(closed); target = input;
              setTimeout(() => calendar.style.display='block', ${scenario === 'slow-american' ? 2300 : 100});
            };
          });
          day.onclick = () => {
            target.value=${JSON.stringify(date.display)}; target.dispatchEvent(new Event('change'));
            closed=setTimeout(() => calendar.style.display='none', 250);
          };
          ${scenario === 'already-selected' ? `from.value=${JSON.stringify(date.display)}; to.value=${JSON.stringify(date.display)};` : ''}
          ${scenario === 'associated-popup' ? `const wrong=document.createElement('mat-calendar'); wrong.innerHTML='<button aria-label="${label}">6</button>'; wrong.onclick=()=>{window.wrongCalendar=true}; document.body.append(wrong);` : ''}
          show.onclick=()=>{window.shown=true};
        </script>`;
      await page.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
      assert.equal(await run(controlScript('prepare', date)), true, scenario);
      assert.equal(await run(`document.querySelector('#from').value === ${JSON.stringify(date.display)} && document.querySelector('#to').value === ${JSON.stringify(date.display)} && detail.checked && window.shown`), true, scenario);
      assert.equal(await run('!!window.wrongCalendar'), false, 'An unrelated calendar must never be selected');
      if (scenario === 'already-selected') assert.equal(await run('window.opened'), 0);
    }
    console.log('PASS receipt calendar: reused mounted popup, British/full and American labels, delayed opening, existing dates and input-owned popup selection.');
    page.destroy(); app.exit(0);
  } catch (error) { console.error(error); page.destroy(); app.exit(1); }
});
