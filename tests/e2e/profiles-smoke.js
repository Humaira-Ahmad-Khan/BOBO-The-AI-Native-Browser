'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, dialog, session } = require('electron');
const { Profiles, COLORS } = require('../../src/main/profiles');

const name = process.argv[2];
const phase = process.argv[3];
assert.match(name || '', /^[a-z0-9-]+$/i);
assert.ok(['default', 'work', 'verify', 'picker'].includes(phase));
const root = path.join(__dirname, '.tmp', 'profiles-' + name);
fs.mkdirSync(root, { recursive: true });
for (const key of ['userData', 'sessionData', 'crashDumps']) app.setPath(key, root);
app.setAppLogsPath(root);
app.commandLine.appendSwitch('disable-background-networking');
app.disableHardwareAcceleration();
dialog.showMessageBox = async () => ({ response: 1 });
const registry = new Profiles(root);
if (phase === 'default') registry.edit({ name: 'Work', color: COLORS[1] });
const work = registry.list().find((profile) => profile.name === 'Work');
assert.ok(work);
if (phase !== 'picker') process.argv.push('--bobo-profile=' + (phase === 'work' ? work.id : 'default'));
let relaunch;
app.relaunch = (options) => { relaunch = options; };
app.whenReady().then(() => {
  if (phase === 'picker') return;
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, done) => done({ cancel: true }));
});
require('../../src/main/main');
async function until(read, expected) {
  let actual;
  for (let index = 0; index < 150; index++) {
    actual = await read();
    if (actual === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.equal(actual, expected);
}
const watchdog = setTimeout(() => {
  console.error('Profile smoke timed out', BrowserWindow.getAllWindows().map((window) => window.webContents.getURL()));
  app.exit(1);
}, 20000);
app.whenReady().then(async () => {
  const file = phase === 'picker' ? '/profiles.html' : '/index.html';
  await until(() => BrowserWindow.getAllWindows()[0]?.webContents.getURL().endsWith(file), true);
  const window = BrowserWindow.getAllWindows()[0];
  const run = (code) => window.webContents.executeJavaScript(code);
  if (phase === 'picker') {
    await until(() => run('document.querySelectorAll(".profile-card").length'), 2);
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    await run('document.querySelector("#profile-add").click()');
    await run(`document.querySelector('#profile-name').value = 'Personal';
      document.querySelector('#editor-save').click();`);
    await until(() => run('document.querySelectorAll(".profile-card").length'), 3);
    assert.equal(registry.list().length, 3);
    assert.equal(await run('typeof window.bobo'), 'undefined');
    const foreign = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await foreign.loadURL('about:blank');
    const { ipcMain } = require('electron');
    const entry = ipcMain._invokeHandlers.get('bobo:profiles:list');
    assert.throws(() => entry({ sender: foreign.webContents, senderFrame: foreign.webContents.mainFrame }), /denied/);
    assert.throws(() => entry({ sender: window.webContents, senderFrame: { url: window.webContents.getURL() } }), /denied/);
    foreign.destroy();
    await run(`document.querySelector('[data-profile="${work.id}"]').click()`);
    await until(() => Boolean(relaunch), true);
    assert.ok(relaunch.args.includes('--bobo-profile=' + work.id));
    console.log('Profile picker added a profile, rejected a foreign frame and selected Work');
  } else {
    const cookies = await session.defaultSession.cookies.get({ url: 'https://profiles.test' });
    const bookmarks = await run('bobo.listBookmarks()');
    if (phase === 'work') {
      assert.equal(cookies.length, 0);
      assert.equal(bookmarks.bookmarks.length, 0);
      assert.equal(app.getPath('userData'), registry.directory(work.id));
    }
    if (phase === 'verify') {
      assert.equal(cookies.find((cookie) => cookie.name === 'profile-cookie').value, 'default');
      assert.ok(bookmarks.bookmarks.some((bookmark) => bookmark.title === 'default bookmark'));
      assert.ok(!bookmarks.bookmarks.some((bookmark) => bookmark.title === 'work bookmark'));
      console.log('Original profile retained its cookie and bookmarks after using Work');
    } else {
      await session.defaultSession.cookies.set({ url: 'https://profiles.test', name: 'profile-cookie', value: phase,
        expirationDate: Date.now() / 1000 + 3600 });
      await session.defaultSession.cookies.flushStore();
      await run(`bobo.addBookmark({ url: 'https://profiles.test/${phase}', title: '${phase} bookmark' })`);
      console.log('Seeded isolated ' + phase + ' profile');
    }
  }
  clearTimeout(watchdog);
  app.quit();
}).catch((error) => { console.error(error); app.exit(1); });
