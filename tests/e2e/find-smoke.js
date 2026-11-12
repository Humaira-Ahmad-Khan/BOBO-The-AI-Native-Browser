'use strict';

// Run with the repository's installed Electron. All pages are served in-process.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, session } = require('electron');

process.on('uncaughtException', (error) => {
  console.error(error);
  app.exit(1);
});

const temp = path.join(__dirname, '.tmp');
fs.mkdirSync(temp, { recursive: true });
const profile = fs.mkdtempSync(path.join(temp, 'find-profile-'));
for (const key of ['userData', 'sessionData', 'crashDumps']) app.setPath(key, profile);
app.setAppLogsPath(profile);
app.commandLine.appendSwitch('disable-background-networking');
app.disableHardwareAcceleration();

app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] },
    ({ url }, done) => done({ cancel: !url.startsWith('https://find.test/') }));
  session.defaultSession.protocol.handle('https', (request) => new Response(
    request.url.endsWith('/other') ? '<p>Different page</p>'
      : '<body style="background:white;color:black"><p>NoorPura</p><p>noorpura</p>'
        + '<p style="margin-top:1500px">NoorPura</p></body>',
    { headers: { 'Content-Type': 'text/html' } }
  ));
});

require('../../src/main/main');

const delay = () => new Promise((resolve) => setTimeout(resolve, 40));
async function until(read, expected, label) {
  let actual;
  for (let attempt = 0; attempt < 125; attempt++) {
    actual = await read();
    if (actual === expected) return;
    await delay();
  }
  assert.equal(actual, expected, label);
}

function key(contents, keyCode, modifiers = []) {
  contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
}

async function main() {
  await until(() => BrowserWindow.getAllWindows()[0]?.webContents.getURL().endsWith('/index.html'),
    true, 'chrome loaded');
  const win = BrowserWindow.getAllWindows()[0];
  win.show();
  const chrome = win.webContents;
  const run = (js) => chrome.executeJavaScript(js);
  const page = () => win.contentView.children.find((view) => view.webContents !== chrome)?.webContents;
  const focus = () => run('document.activeElement.id');
  const visible = () => run('!document.querySelector("#find-bar-row").hidden');
  const counter = () => run('document.querySelector("#find-count").textContent');
  const count = (expected) => until(counter,
    expected, 'match counter');
  const caseCount = () => until(async () => /^[12] \/ 2$/.test(await counter()), true, 'case-sensitive count');
  const query = (text) => run(`{
    const field = document.querySelector('#find-input');
    field.value = ${JSON.stringify(text)};
    field.dispatchEvent(new Event('input'));
  }`);

  const first = await run('bobo.createTab("https://find.test/first")');
  await until(() => page()?.getURL(), 'https://find.test/first', 'website loaded');
  const firstPage = page();
  const nativeStop = firstPage.stopFindInPage.bind(firstPage);
  let stopped;
  firstPage.stopFindInPage = (action) => {
    stopped = action;
    return nativeStop(action);
  };
  assert.equal(await firstPage.executeJavaScript('typeof window.bobo?.findInPage'), 'undefined');
  assert.equal(firstPage.getLastWebPreferences().sandbox, true);
  assert.equal(firstPage.getLastWebPreferences().contextIsolation, true);
  firstPage.focus();
  key(firstPage, 'F', ['control']);
  await until(focus, 'find-input', 'Ctrl+F focuses the find field');
  await query('NoorPura');
  await count('1 / 3');
  async function highlightColors() {
    const image = await firstPage.capturePage().catch(() => null);
    if (!image || image.isEmpty()) return '';
    const { width, height } = image.getSize();
    const pixels = image.toBitmap();
    let orange = 0;
    let yellow = 0;
    for (let y = 0; y < Math.min(100, height); y++) {
      for (let x = 0; x < Math.min(180, width); x++) {
        const i = (y * width + x) * 4;
        if (pixels[i + 2] < 230 || pixels[i] > 110) continue;
        if (pixels[i + 1] > 225) yellow++;
        else if (pixels[i + 1] > 100) orange++;
      }
    }
    // A highlight covers far more pixels than colored subpixel text edges.
    return `${orange > 100},${yellow > 100}`;
  }
  await until(highlightColors, 'true,true', 'active and inactive matches use distinct highlights');
  key(chrome, 'Enter');
  await count('2 / 3');
  key(chrome, 'Enter');
  await count('3 / 3');
  await until(() => firstPage.executeJavaScript('scrollY > 0'), true, 'active match scrolls into view');
  key(chrome, 'Enter', ['shift']);
  await count('2 / 3');
  key(chrome, 'F3', ['shift']);
  await count('1 / 3');
  key(chrome, 'F3');
  await count('2 / 3');
  await run('document.querySelector("#find-prev").click()');
  await count('1 / 3');
  await run('document.querySelector("#find-next").click()');
  await count('2 / 3');
  await run('document.querySelector("#find-case").click()');
  await caseCount();
  await query('absent');
  await count('No matches');
  await query('NoorPura');
  await caseCount();
  stopped = undefined;
  key(chrome, 'Escape');
  await until(visible, false, 'Escape closes Find');
  await until(() => stopped, 'clearSelection', 'Escape stops the native search');
  // Force a fresh compositor frame before sampling the cleared page.
  await firstPage.executeJavaScript("document.body.style.color = '#111'; scrollTo(0, 0)");
  await until(highlightColors, 'false,false', 'closing Find clears native highlights');

  firstPage.focus();
  key(firstPage, 'F', ['control']);
  await caseCount();
  const second = await run('bobo.createTab("https://find.test/other")');
  await until(visible, false, 'switching tabs closes Find');
  await until(() => page()?.getURL(), 'https://find.test/other', 'second website loaded');
  key(page(), 'F', ['control']);
  await count('No matches');
  await run(`bobo.navigate(${second}, "https://find.test/first")`);
  await until(visible, false, 'navigation closes Find');
  await run(`bobo.selectTab(${first})`);
  firstPage.focus();
  key(firstPage, 'F', ['control']);
  await caseCount();
  key(chrome, 'L', ['control']);
  await until(focus, 'omnibox-input', 'Ctrl+L still focuses the address bar');
  await run(`bobo.closeTab(${first})`);
  await until(visible, false, 'closing the active tab closes Find');

  const internal = await run('bobo.createTab()');
  await until(() => page()?.getURL().endsWith('/newtab.html'), true, 'internal tab loaded');
  key(page(), 'F', ['control']);
  await until(focus, 'find-input', 'Ctrl+F opens Find on a BOBO page');
  await query('BOBO');
  await until(async () => /^\d+ \/ [1-9]\d*$/.test(await counter()), true, 'internal page match');
  await run('document.querySelector("#find-close").click()');
  await until(visible, false, 'close button hides Find');
  await run(`bobo.closeTab(${internal})`);
  console.log('Find in Page smoke check passed');
}

app.whenReady().then(main).then(() => app.exit(0), (error) => {
  console.error(error);
  app.exit(1);
});
