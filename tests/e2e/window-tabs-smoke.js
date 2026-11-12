'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, Menu, ipcMain, session } = require('electron');
const root = path.join(__dirname, '.tmp'); fs.mkdirSync(root, { recursive: true });
const profile = fs.mkdtempSync(path.join(root, 'window-tabs-'));
for (const name of ['userData', 'sessionData', 'crashDumps']) app.setPath(name, profile);
app.setAppLogsPath(profile); app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-networking');
const url = 'https://window-tabs.test/page';
const handlers = new Map(); const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (name, fn) => { handlers.set(name, fn); return handle(name, fn); };
let menu;
Menu.buildFromTemplate = template => { menu = template; return { popup() {} }; };
app.whenReady().then(() => {
  session.defaultSession.enableNetworkEmulation({ offline: true });
  session.defaultSession.protocol.handle('https', () => new Response('<title>Window test</title><h1>Fixture</h1><a href="/next">Link</a>',
    { headers: { 'Content-Type': 'text/html' } }));
});
require('../../src/main/main');
async function until(read) { for (let i = 0; i < 250; i++) { if (await read()) return; await new Promise(r => setTimeout(r, 20)); } throw Error('Timed out'); }
app.whenReady().then(async () => {
  await until(() => BrowserWindow.getAllWindows()[0]?.webContents.getURL().endsWith('/index.html'));
  const first = BrowserWindow.getAllWindows()[0];
  const run = js => first.webContents.executeJavaScript(js);
  await until(() => run('typeof bobo.newWindow === "function"'));
  await run('document.querySelector("[data-action=menu-new-window]").click()');
  await until(() => BrowserWindow.getAllWindows().length === 2);
  const second = BrowserWindow.getAllWindows().find(w => w !== first);
  await until(() => second.webContents.getURL().endsWith('/index.html'));
  assert.equal((await run('bobo.getState()')).tabs.tabs.length, 1);
  const id = await run(`bobo.createTab(${JSON.stringify(url)})`);
  const contents = () => first.contentView.children.find(view => view.webContents?.getURL() === url)?.webContents;
  await until(() => contents());
  const page = contents(); await until(() => !page.isLoading());
  await page.executeJavaScript('window.keepThisState = 42');
  page.emit('context-menu', {}, { linkURL: url + '?next=1' });
  assert.ok(menu.find(item => item.label === 'Open link in new window'));
  menu.find(item => item.label === 'Open link in new window').click();
  await until(() => BrowserWindow.getAllWindows().length === 3);
  const moved = await run(`bobo.detachTab(${id})`);
  await until(() => BrowserWindow.getAllWindows().length === 4);
  const destination = BrowserWindow.getAllWindows().find(w => w.contentView.children.some(view => view.webContents === page));
  assert.ok(destination && destination !== first);
  assert.equal(await page.executeJavaScript('keepThisState'), 42);
  await until(async () => (await destination.webContents.executeJavaScript('bobo.getState()')).tabs.activeId === moved);
  assert.equal((await run('bobo.getState()')).tabs.tabs.some(t => t.url === url), false);
  await assert.rejects(async () => handlers.get('bobo:tabs:detach')({ sender: page, senderFrame: page.mainFrame }, { id: moved }), /blocked/);
  await assert.rejects(() => run('bobo.detachTab(999999)'), /unknown tab/);
  await destination.webContents.executeJavaScript(`bobo.closeTab(${moved})`);
  await destination.webContents.executeJavaScript('bobo.recentlyClosedTabs()');
  assert.equal(menu[0].label, 'Window test');
  menu[0].click();
  await until(async () => (await destination.webContents.executeJavaScript('bobo.getState()')).tabs.tabs.some(t => t.url === url));
  // Exercise the renderer's out-of-strip drag route, then Escape cancellation.
  await run(`(() => {
    const tab = document.querySelector('.tab');
    const transfer = new DataTransfer();
    tab.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }));
    tab.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer, clientY: 250, screenX: 200, screenY: 250 }));
  })()`);
  await until(() => BrowserWindow.getAllWindows().length === 5);
  await until(async () => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.webContents.isLoading() || !window.webContents.getURL().endsWith('/index.html')) return false;
    }
    return true;
  });
  await new Promise(resolve => setTimeout(resolve, 300));
  const count = BrowserWindow.getAllWindows().length;
  await run(`(() => {
    const tab = document.querySelector('.tab'); const transfer = new DataTransfer();
    tab.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    tab.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer, clientY: 250, screenX: 200, screenY: 250 }));
  })()`);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(BrowserWindow.getAllWindows().length, count, 'Escape cancels tear-off');
  console.log('PASS: New Window UI, context link new window, live tab transfer without reload, correct owner, remote and invalid sender denial, Recently Closed menu and drag-out renderer route.');
  for (const window of BrowserWindow.getAllWindows()) { window.destroy(); await until(() => window.isDestroyed()); }
  await new Promise(resolve => setTimeout(resolve, 100));
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
