'use strict';
// Local loopback HTTP fixture only; no public websites or external services.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { performance } = require('node:perf_hooks');
const { app, BrowserWindow, session } = require('electron');
const { TabManager } = require('../../src/main/tabs');
const root = path.join(__dirname, '.tmp');
fs.mkdirSync(root, { recursive: true });
const profile = fs.mkdtempSync(path.join(root, 'reopening-'));
for (const name of ['userData', 'sessionData', 'crashDumps']) app.setPath(name, profile);
app.setAppLogsPath(profile);
app.commandLine.appendSwitch('disable-background-networking');
app.disableHardwareAcceleration();
const baseline = process.argv.includes('--baseline');
const hits = new Map();
const server = http.createServer(async (req, res) => {
  hits.set(req.url, (hits.get(req.url) || 0) + 1);
  await new Promise(resolve => setTimeout(resolve, 180));
  res.setHeader('Cache-Control', req.url === '/private' ? 'no-store' : 'public, max-age=3600');
  if (req.url === '/style.css') { res.setHeader('Content-Type', 'text/css'); res.end('body{height:5000px;background:#eee}'); return; }
  res.setHeader('Content-Type', 'text/html');
  res.end('<title>Local reopening fixture</title><link rel="stylesheet" href="/style.css"><h1>Cache fixture</h1><script>window.fixtureReady=true</script>');
});
async function until(read) {
  for (let i = 0; i < 250; i++) { if (await read()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw Error('Timed out');
}
app.whenReady().then(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] },
    ({ url }, done) => done({ cancel: !url.startsWith(origin + '/') }));
  assert.equal(session.defaultSession.isPersistent(), true, 'normal tabs use persistent Chromium cache');
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const manager = new TabManager({ window });
  manager.setBounds({ x: 0, y: 0, width: 800, height: 600 });
  const ready = async id => {
    const wc = manager.webContentsForTab(id);
    await until(async () => !wc.isLoading() && await wc.executeJavaScript('window.fixtureReady === true'));
    return wc;
  };
  const samples = [];
  for (let i = 0; i < 3; i++) {
    await session.defaultSession.clearCache();
    const start = performance.now();
    const id = manager.create({ url: origin + '/public' });
    const wc = await ready(id);
    assert.equal(wc.session, session.defaultSession);
    const cold = performance.now() - start;
    await wc.executeJavaScript('scrollTo(0, 850)');
    manager.close(id);
    const startReopen = performance.now();
    const next = manager.reopenClosed();
    const reopened = await ready(next);
    const warm = performance.now() - startReopen;
    if (!baseline) await until(async () => await reopened.executeJavaScript('scrollY') === 850);
    assert.notEqual(reopened.id, wc.id, 'closed pages are destroyed, never left running');
    samples.push({ cold: Math.round(cold), reopened: Math.round(warm) });
    manager.close(next);
  }
  const before = hits.get('/private') || 0;
  let id = manager.create({ url: origin + '/private' }); await ready(id); manager.close(id);
  id = manager.reopenClosed(); await ready(id);
  assert.equal(hits.get('/private'), before + 2, 'no-store pages are fetched again');
  if (!baseline) {
    manager.close(id);
    const sameUrl = manager.create({ url: origin + '/private' });
    await ready(sameUrl);
    assert.equal(manager.recentlyClosed().some(entry => entry.url === origin + '/private'), false, 'same URL consumes its reopening state');
    id = sameUrl;
    const other = new BrowserWindow({ show: false });
    const destination = new TabManager({ window: other });
    destination.setBounds({ x: 0, y: 0, width: 700, height: 500 });
    const original = manager.webContentsForTab(id);
    const moved = manager.transferTo(id, destination);
    assert.equal(destination.webContentsForTab(moved), original, 'detach preserves live contents');
    assert.equal(manager.ownsContents(original), false);
    assert.equal(destination.ownsContents(original), true);
    await original.executeJavaScript('document.title="Moved title"');
    await until(() => destination.tabInfo(moved).title === 'Moved title');
    assert.notEqual(manager.activeTab()?.title, 'Moved title', 'events follow new owner');
    other.destroy();
    await until(() => original.isDestroyed());
    const clock = Date.now;
    const recent = manager.create({ url: origin + '/public' }); await ready(recent); manager.close(recent);
    assert.ok(manager.recentlyClosed().length);
    try { Date.now = () => clock() + 300001; assert.equal(manager.recentlyClosed().length, 0, 'metadata expires after five minutes'); }
    finally { Date.now = clock; }
    manager.clearRecentlyClosed();
    assert.equal(manager.reopenClosed(), null);
    for (let i = 0; i < 15; i++) {
      const pending = manager.create({ url: origin + '/pending-' + i, background: true });
      manager.close(pending);
    }
    assert.equal(manager.recentlyClosed().length, 12, 'recent metadata has a strict entry limit');
    const privateTab = manager.create({ url: origin + '/private-fixture', private: true, background: true });
    manager.close(privateTab);
    assert.equal(manager.recentlyClosed().some(entry => entry.url.endsWith('/private-fixture')), false, 'private tabs never enter reopening state');
    manager.clearRecentlyClosed();
  }
  const result = { samples, pageRequests: hits.get('/public'), cssRequests: hits.get('/style.css') };
  fs.writeFileSync(path.join(root, baseline ? 'tab-reopening-baseline.json' : 'tab-reopening-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  window.destroy();
  await new Promise(resolve => setTimeout(resolve, 100));
  server.close(); app.exit(0);
}).catch(error => { console.error(error); server.close(); app.exit(1); });
