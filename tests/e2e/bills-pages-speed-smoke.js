'use strict';
// Offline Chromium + SQLite fixture: no portal credentials or external requests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, session } = require('electron');
const { Store } = require('../../src/main/db');
const { BillsExtractionService, BILLS_COLUMNS, READ_RESULTS_SCRIPT } = require('../../src/main/tools/bills');
const root = path.join(__dirname, '.tmp');
fs.mkdirSync(root, { recursive: true });
const profile = fs.mkdtempSync(path.join(root, 'bills-pages-'));
for (const key of ['userData', 'sessionData', 'crashDumps']) app.setPath(key, profile);
app.setAppLogsPath(profile);
app.commandLine.appendSwitch('disable-background-networking');
app.disableHardwareAcceleration();
const target = 'https://elgcd.punjab.gov.pk/e-billing/water-bill-history';
let store;
app.whenReady().then(async () => {
  session.defaultSession.protocol.handle('https', (request) => {
    if (!request.url.startsWith(target)) return new Response('', { status: 403 });
    const mode = new URL(request.url).searchParams.get('mode') || 'single';
    if (new URL(request.url).searchParams.has('response')) return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    return new Response(`<!doctype html><meta charset="utf-8">
      <input id="Connection_No"><button id="submit">Show History</button><div id="result"></div>
      <div id="pager"><mat-paginator><span class="mat-paginator-page-size-value">10</span>
      <span class="mat-paginator-range-label"></span><button aria-label="first page">First</button>
      <button aria-label="next page">Next</button></mat-paginator></div>
      <script>
      const mode = ${JSON.stringify(mode)};
      const total = ['pages','broken'].includes(mode) ? 123 : 1;
      if (total === 1) document.querySelector('#pager').remove();
      let page = 0, account = '99999999';
      function render(empty = false) {
        document.querySelector('#result').innerHTML = empty
          ? '<table><tr><th>Bill No</th></tr><tr><td>No Records Found</td></tr></table>'
          : '<table><tr><td>Connection No</td><td>' + account + '</td></tr></table><table><tr>'
            + ${JSON.stringify(BILLS_COLUMNS.slice(5))}.map(h => '<th>' + h + '</th>').join('') + '</tr>'
            + Array.from({length: Math.min(10, total-page*10)}, (_, i) => '<tr>'
              + Array.from({length:16}, (_, col) => '<td>' + (col === 0 ? page*10+i+1 : col === 1 ? 'B-'+(page*10+i+1) : account) + '</td>').join('')
              + '</tr>').join('') + '</table>';
        const label = document.querySelector('.mat-paginator-range-label');
        if (label) label.textContent = (page*10+1) + ' – ' + Math.min(total,(page+1)*10) + ' of ' + total;
        const next = document.querySelector('[aria-label="next page"]');
        if (next) next.disabled = (page+1)*10 >= total || (mode === 'broken' && page === 1);
      }
      render();
      document.querySelector('#submit').onclick = () => {
        if (mode === 'unchanged') { const toast = document.createElement('p'); toast.textContent='Loading'; document.body.append(toast); return; }
        const nextAccount = document.querySelector('input').value;
        setTimeout(async () => {
          if (mode === 'empty') await fetch(location.href + '&response=1');
          account = nextAccount; page = 0; render(mode === 'empty');
        }, mode === 'slow' ? 1800 : 40);
      };
      document.querySelector('[aria-label="first page"]')?.addEventListener('click', () => { page=0; render(); });
      document.querySelector('[aria-label="next page"]')?.addEventListener('click', () => setTimeout(() => { page++; render(); }, 40));
      </script>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  });
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const wc = win.webContents;
  store = new Store({ file: path.join(profile, 'test.db') });
  const service = new BillsExtractionService({ store });
  const lookup = async (mode, number) => {
    await wc.loadURL(target + '?mode=' + mode);
    const job = service.createJob({ connectionNumbers: [number] });
    const row = service.getQueue(job.id)[0];
    const started = Date.now();
    const pending = service.processSingle(wc, job.id, row.id);
    if (mode === 'slow') {
      assert.throws(() => service.clearJob(job.id), /Stop this queue/);
      assert.throws(() => service.clearAllJobs(), /Stop this queue/);
      assert.throws(() => service.repairSpreadsheetIds(job.id), /Stop extraction/);
    }
    const result = await pending;
    return { result, job, row, elapsed: Date.now() - started };
  };
  const fast = await lookup('single', '=09010199');
  assert.equal(fast.result.count, 1);
  assert.ok(fast.elapsed < 1000, `Fast DOM result took ${fast.elapsed} ms`);
  // Measure the old fixed-delay approach against the same fixture.
  const cold = Date.now();
  await wc.executeJavaScript(`document.querySelector('input').value='09010198'; document.querySelector('#submit').click()`);
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal((await wc.executeJavaScript(READ_RESULTS_SCRIPT)).details.connectionNo, '09010198');
  const baseline = Date.now() - cold;
  const slow = await lookup('slow', '09010197');
  assert.equal(slow.result.count, 1);
  assert.ok(slow.elapsed >= 1800, 'Read the stale previous connection before response');
  const all = await lookup('pages', '09010196');
  assert.equal(all.result.count, 123);
  const data = JSON.parse(store.open().prepare('SELECT bills_data FROM bills_queue WHERE id=?').get(all.row.id).bills_data);
  assert.equal(data.length, 123);
  assert.equal(new Set(data.map(row => row[1])).size, 123);
  assert.equal(data.at(-1)[1], 'B-123');
  assert.equal(service.getQueue(all.job.id, true)[0].billCount, 123);
  const broken = await lookup('broken', '09010195');
  assert.equal(broken.result.ok, false);
  assert.equal(service.getJob(broken.job.id).completed, 0);
  assert.equal(service.getJob(broken.job.id).failed, 1);
  const empty = await lookup('empty', '09010194');
  assert.equal(empty.result.empty, true);
  const unchanged = await lookup('unchanged', '09010193');
  assert.equal(unchanged.result.ok, false);
  assert.equal(service.getJob(unchanged.job.id).empty, 0);
  assert.equal(service.getJob(unchanged.job.id).completed, 0);
  const merged = service.exportCombinedCsv(all.job.id);
  assert.equal(merged.trim().split('\r\n').length, 124);
  fs.writeFileSync(path.join(profile, 'all-pages.csv'), merged);
  console.log(`PASS Bills pages and speed: 13 pages / 123 unique bills in one CSV; partial page failure not completed; stale/unchanged results rejected; fresh empty accepted. Fixed wait ${baseline} ms vs ready DOM ${fast.elapsed} ms (${Math.round((1-fast.elapsed/baseline)*100)}% less local wait).`);
  win.destroy();
}).then(() => { store?.close(); app.exit(0); }, error => { console.error(error); store?.close(); app.exit(1); });
