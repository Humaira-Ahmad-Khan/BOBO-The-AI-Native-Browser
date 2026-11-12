'use strict';
// Offline HTTPS fixtures: initial paint, SPA/full navigation and real input events.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const applicationRoot = process.env.BOBO_SMOKE_APP_ROOT || path.resolve(__dirname, '../..');
const { applyYouTubeTheme, isYouTube } = require(path.join(applicationRoot, 'src/main/youtube-theme'));
const { createYouTubeShorts } = require(path.join(applicationRoot, 'src/main/youtube-shorts'));
const root = fs.mkdtempSync(path.join(__dirname, '.tmp/youtube-navigation-'));
for (const name of ['userData', 'sessionData', 'crashDumps']) app.setPath(name, root);
app.setAppLogsPath(root);
app.commandLine.appendSwitch('disable-background-networking');
app.disableHardwareAcceleration();
const origin = 'https://www.youtube.com', channel = origin + '/@fixture/shorts';
const ids = ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc'];
let theme = 'dark', legacyAppearance = false, win;
const shorts = createYouTubeShorts({ ipcMain, ownerFor: contents => contents === win?.webContents ? {} : null });
ipcMain.on('bobo:youtube:appearance', event => {
  const mode = event.senderFrame === event.sender.mainFrame && isYouTube(event.senderFrame.url) ? theme : 'default';
  event.returnValue = legacyAppearance ? mode : { mode, channelShorts: true };
});
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let n = 0; n < 100; n++) { if (await check()) return; await wait(50); }
  throw new Error('YouTube fixture timed out');
}
app.whenReady().then(async () => {
  session.defaultSession.enableNetworkEmulation({ offline: true });
  session.defaultSession.registerPreloadScript({ type: 'frame', filePath: path.join(applicationRoot, 'src/preload/youtube.js'),
    matches: ['https://www.youtube.com/*', 'https://youtube.com/*', 'https://m.youtube.com/*'] });
  session.defaultSession.protocol.handle('https', request => {
    const url = new URL(request.url);
    const grid = `<main>${ids.map((id, i) => `<ytm-shorts-lockup-view-model><a id="video${i}" href="https://www.youtube.com/shorts/${id}?feature=channel"><span>Video ${i}</span></a></ytm-shorts-lockup-view-model>`).join('<br>')}</main>`;
    const player = `<ytd-shorts style="display:block;height:400px"><input id="comment"><div id="wheel" style="height:300px">Shorts player</div></ytd-shorts>
      <button id="next" aria-label="Next video">Next</button>
      <script>next.onclick=()=>location.assign('/shorts/zzzzzzzzzzz');</script>`;
    return new Response(`<!doctype html><html><head><script>window.initialDark=document.documentElement.hasAttribute('dark');</script>
      <style>html,body,ytd-app{background:white}ytd-app{display:block}button,a{display:inline-block;margin:20px}</style></head>
      <body><ytd-app>${url.pathname.startsWith('/@fixture') ? grid : player}</ytd-app></body></html>`, { headers: { 'content-type': 'text/html' } });
  });
  win = new BrowserWindow({ show: true, width: 1000, height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const wc = win.webContents;
  wc.debugger.attach('1.3');
  wc.on('did-start-navigation', details => { if (details.isMainFrame) shorts.navigated(wc, details.url); });
  wc.on('preload-error', (_event, _path, error) => { throw error; });
  const read = code => wc.executeJavaScript(code);
  const click = async selector => {
    await until(() => !wc.isLoading());
    win.show(); win.focus(); await wait(150); wc.focus(); await wait(100);
    const expression = selector.startsWith('channel:') ?
      `document.getElementById('bobo-channel-shorts-controls')?.shadowRoot.getElementById(${JSON.stringify(selector.slice(8))})` :
      `document.querySelector(${JSON.stringify(selector)})`;
    await until(() => read(`!!(${expression})`));
    const point = await read(`(() => { const r=(${expression}).getBoundingClientRect(); return { x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2) }; })()`);
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await wait(60);
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  };
  const assertDark = async () => {
    assert.equal(await read('window.initialDark'), true, 'saved dark mode applied before the first website script');
    assert.equal(await read('getComputedStyle(document.body).backgroundColor'), 'rgb(15, 15, 15)');
  };
  await wc.loadURL(channel); await assertDark();
  await read("document.documentElement.removeAttribute('dark'); document.querySelector('ytd-app').replaceWith(Object.assign(document.createElement('ytd-app'),{textContent:'SPA replacement'}));");
  await wait(50);
  assert.equal(await read('document.documentElement.hasAttribute("dark")'), true);
  assert.equal(await read('getComputedStyle(document.querySelector("ytd-app")).backgroundColor'), 'rgb(15, 15, 15)');
  await wc.loadURL(channel);
  await read("document.querySelector('#video0').click()");
  await until(() => wc.getURL().includes(ids[0]));
  assert.equal(await read("!!document.getElementById('bobo-channel-shorts-controls')"), false, 'synthetic clicks cannot create a queue');
  await wc.loadURL(channel); await click('#video0');
  await until(() => wc.getURL().includes(ids[0])); await assertDark();
  await until(() => read("!!document.getElementById('bobo-channel-shorts-controls')"));
  assert.equal(await read("document.getElementById('bobo-channel-shorts-controls').shadowRoot.getElementById('previous').disabled"), true);
  assert.ok(await read("document.getElementById('bobo-channel-shorts-controls').getBoundingClientRect().height > 100"), 'both arrows remain visible at the first Short');
  await click('channel:next'); await until(() => wc.getURL() === origin + '/shorts/' + ids[1]); await assertDark();
  await click('channel:previous'); await until(() => wc.getURL() === origin + '/shorts/' + ids[0]);
  await click('#comment');
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'Down' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Down' });
  await wait(100); assert.equal(wc.getURL(), origin + '/shorts/' + ids[0], 'comment editing keeps native keys');
  await click('#wheel');
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'Down' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Down' });
  await until(() => wc.getURL() === origin + '/shorts/' + ids[1]);
  await click('#wheel');
  wc.sendInputEvent({ type: 'mouseWheel', x: 250, y: 200, deltaY: -120, deltaX: 0, canScroll: true });
  await until(() => wc.getURL() === origin + '/shorts/' + ids[2]);
  await click('channel:next'); await until(() => wc.getURL() === channel);
  // A Home-page card may route on pointerdown, before a click handler sees it.
  await wc.loadURL(origin + '/@fixture');
  await read("video0.onpointerdown = () => { history.pushState({}, '', '/shorts/aaaaaaaaaaa'); document.dispatchEvent(new Event('yt-navigate-finish')); }; void 0");
  await click('#video0'); await until(() => wc.getURL().includes(ids[0]));
  await click('channel:next'); await until(() => wc.getURL() === origin + '/shorts/' + ids[1]);
  // Queue survives a canonical YouTube-host change, unlike origin sessionStorage.
  await wc.loadURL('https://youtube.com/shorts/' + ids[1]);
  await click('channel:previous'); await until(() => wc.getURL() === 'https://youtube.com/shorts/' + ids[0]);
  await wc.loadURL(origin + '/');
  assert.equal(await read("!!document.getElementById('bobo-channel-shorts-controls')"), false);
  await wc.loadURL(origin + '/shorts/' + ids[0]); await click('#next');
  await until(() => wc.getURL() === origin + '/shorts/zzzzzzzzzzz');
  theme = 'light'; await wc.reload(); await until(() => !wc.isLoading());
  assert.equal(await read('document.documentElement.hasAttribute("dark")'), false);
  await applyYouTubeTheme(wc, 'dark'); await applyYouTubeTheme(wc, 'default');
  assert.equal(await read('getComputedStyle(document.body).backgroundColor'), 'rgb(255, 255, 255)');
  legacyAppearance = true; theme = 'dark'; await wc.loadURL(channel); await assertDark();
  await click('#video0'); await until(() => wc.getURL().includes(ids[0]));
  assert.equal(await read("!!document.getElementById('bobo-channel-shorts-controls')"), false,
    'older running main processes do not receive unsupported synchronous queue requests');
  console.log('PASS YouTube: document-start dark mode, reload, SPA replacements, channel Shorts Next/Previous/keys/wheel, channel boundary, native ordinary feed, and theme reset.');
  win.destroy(); app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
