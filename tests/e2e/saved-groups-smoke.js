'use strict';

// Run twice with installed Electron and the same unique profile name.
// electron tests/e2e/saved-groups-smoke.js NAME
// electron tests/e2e/saved-groups-smoke.js NAME --restart
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, Menu, session } = require('electron');
const { TabManager } = require('../../src/main/tabs');
const { Store } = require('../../src/main/db');

const name = process.argv[2];
assert.match(name || '', /^[a-z0-9-]+$/i, 'supply a unique test profile name');
const restarting = process.argv.includes('--restart');
const profile = path.join(__dirname, '.tmp', `saved-groups-${name}`);
if (!restarting) assert.equal(fs.existsSync(profile), false, 'use a fresh test profile');
fs.mkdirSync(profile, { recursive: true });
for (const key of ['userData', 'sessionData', 'crashDumps']) app.setPath(key, profile);
app.setAppLogsPath(profile);
app.commandLine.appendSwitch('disable-background-networking');
app.disableHardwareAcceleration();

function fail(error) {
  console.error(error);
  app.exit(1);
}
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] },
    ({ url }, done) => done({ cancel: !url.startsWith('https://groups.test/') }));
  session.defaultSession.protocol.handle('https', () =>
    new Response('<title>Saved groups fixture</title><p>Local fixture</p>', {
      headers: { 'Content-Type': 'text/html' },
    }));
});

let contextMenu;
Menu.prototype.popup = function () { contextMenu = this; };
const create = TabManager.prototype.create;
TabManager.prototype.create = function (options = {}) {
  return create.call(this, { ...options, private: options.url === 'https://groups.test/private' });
};

require('../../src/main/main');

async function until(read, expected, label) {
  let actual;
  for (let attempt = 0; attempt < 125; attempt++) {
    actual = await read();
    if (actual === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.equal(actual, expected, label);
}

async function main() {
  await until(() => BrowserWindow.getAllWindows()[0]?.webContents.getURL().endsWith('/index.html'),
    true, 'chrome loaded');
  const win = BrowserWindow.getAllWindows()[0];
  win.show();
  const chrome = (js) => win.webContents.executeJavaScript(js);
  const call = (method, ...args) => chrome(`bobo.${method}(...${JSON.stringify(args)})`);
  const snapshot = async () => (await call('getState')).tabs;
  const groups = () => call('listSavedTabGroups');
  const activePage = () => win.contentView.children.find((view) => view.webContents !== win.webContents)?.webContents;
  const settingsReady = async () => {
    await until(() => activePage()?.getURL().endsWith('/settings.html?view=tabs'), true, 'Tabs settings loaded');
    const page = activePage();
    const run = (js) => page.executeJavaScript(js);
    await until(() => run('!!document.querySelector(".saved-group-item")'), true, 'Saved Groups cards loaded');
    return run;
  };
  const groupMenu = async (label) => {
    contextMenu = undefined;
    await chrome(`document.querySelector('.tab-group-label').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))`);
    await until(() => Boolean(contextMenu), true, 'group context menu');
    const item = contextMenu.items.find((entry) => entry.label === label);
    assert.ok(item?.enabled, label);
    item.click();
  };
  const assertLive = async (name, color, paths) => {
    const state = await snapshot();
    const group = state.groups.find((entry) => entry.name === name);
    assert.ok(group);
    assert.equal(group.color, color);
    assert.equal(group.collapsed, false);
    const tabs = state.tabs.filter((tab) => tab.groupId === group.id);
    assert.deepEqual(tabs.map((tab) => new URL(tab.url).pathname), paths);
    assert.equal(state.activeId, tabs[0].id);
    await until(() => chrome(`document.querySelector('.tab-group-label[data-group-id="${group.id}"]')?.dataset.groupColor`),
      color, 'group label colour');
    return group;
  };

  if (restarting) {
    await until(async () => (await groups()).length, 2, 'saved groups survive restart');
    const saved = (await groups()).find((group) => group.name === 'Renamed');
    assert.equal(saved.tabCount, 2);
    await assertLive('Renamed', 'purple', ['/first', '/third']);
    assert.deepEqual(await call('restoreSavedTabGroup', saved.id), { status: 'already-open' });
    const copy = (await groups()).find((group) => group.name === 'Renamed (copy)');
    await call('closeTabGroup', (await snapshot()).groups[0].id);
    assert.deepEqual(await call('restoreSavedTabGroup', copy.id), { status: 'opened' });
    await assertLive('Renamed (copy)', 'purple', ['/first', '/third']);
    assert.equal(await call('deleteSavedTabGroup', copy.id), true);
    assert.equal((await groups()).length, 1);
    console.log('Saved Groups restart check passed');
    return;
  }

  const first = await call('createTab', 'https://groups.test/first?token=test#secret');
  const second = await call('createTab', 'https://groups.test/second');
  const privateTab = await call('createTab', 'https://groups.test/private');
  const localTab = await call('createTab');
  const live = await call('createTabGroup', { name: 'Research', color: 'green', tabIds: [first, second, privateTab, localTab] });
  await groupMenu('Save Group');
  const [saved] = await groups();
  assert.equal(saved.name, 'Research');
  assert.equal(saved.tabCount, 2, 'private and internal tabs are excluded');
  assert.equal(saved.color, 'green');
  await call('closeTabGroup', live.id);
  assert.equal((await groups())[0].open, false);
  await chrome('document.querySelector("[data-action=saved-groups]").click()');
  let settings = await settingsReady();
  await settings('document.querySelector(".btn-open-group").click()');
  await until(() => activePage()?.getURL(), 'https://groups.test/first', 'one-click restore strips query and fragment');
  const restored = await assertLive('Research', 'green', ['/first', '/second']);
  assert.equal(await activePage().executeJavaScript(
    'typeof window.bobo'
  ), 'undefined', 'a website has no BOBO bridge');

  const store = new Store({ file: path.join(profile, 'bobo.db') });
  const db = store.open();
  const legacy = Number(db.prepare(
    "INSERT INTO saved_tab_groups (name, color, created_at, updated_at) VALUES ('Legacy', 'blue', 1, 1)"
  ).run().lastInsertRowid);
  db.prepare('INSERT INTO saved_group_tabs (group_id, url) VALUES (?, ?)').run(legacy, 'file:///internal.html');
  store.close();
  const tabCount = (await snapshot()).tabs.length;
  assert.deepEqual(await call('restoreSavedTabGroup', legacy), { status: 'unsafe' });
  assert.equal((await snapshot()).tabs.length, tabCount);
  assert.equal(await call('deleteSavedTabGroup', legacy), true);

  await call('openSettings', 'tabs');
  settings = await settingsReady();
  await settings('document.querySelector(".btn-open-group").click()');
  await until(() => settings('document.querySelector(".btn-open-group").textContent'), 'Switch to Open Group', 'duplicate offer');
  assert.equal((await snapshot()).tabs.filter((tab) => tab.groupId === restored.id).length, 2);
  await settings('document.querySelector(".btn-open-group").click()');
  await until(() => activePage()?.getURL(), 'https://groups.test/first', 'switch to open group');

  const current = await snapshot();
  await call('closeTab', current.tabs.find((tab) => tab.url === 'https://groups.test/second').id);
  const third = await call('createTab', 'https://groups.test/third');
  assert.equal(await call('setTabGroup', third, restored.id), true);
  assert.equal((await groups())[0].tabCount, 2);
  await groupMenu('Update Saved Group');
  await call('openSettings', 'tabs');
  settings = await settingsReady();
  await settings(`{
    const form = document.querySelector('.saved-group-edit');
    form.elements.name.value = 'Renamed';
    form.elements.color.value = 'purple';
    form.requestSubmit();
  }`);
  await until(async () => (await groups())[0].name, 'Renamed', 'manager rename');
  await until(() => settings('document.querySelector(".saved-group-name").textContent'), 'Renamed', 'renamed card rendered');
  assert.equal((await groups())[0].color, 'purple');
  await settings('document.querySelector(".btn-copy-group").click()');
  await until(async () => (await groups()).length, 2, 'duplicate saved collection');
  await until(() => settings('document.querySelectorAll(".saved-group-item").length'), 2, 'duplicate card rendered');
  await settings(`{
    const search = document.querySelector('#saved-groups-search');
    search.value = 'copy';
    search.dispatchEvent(new Event('input'));
  }`);
  assert.equal(await settings('document.querySelectorAll(".saved-group-item").length'), 1);
  await settings(`{
    const shortcut = document.querySelector('#saved-groups-shortcut');
    shortcut.value = 'g';
    shortcut.dispatchEvent(new Event('change'));
  }`);
  await until(async () => (await call('browserSettings')).tabs.savedGroupsShortcut, 'g', 'shortcut assigned');
  await call('restoreSavedTabGroup', saved.id, true);
  await until(() => activePage()?.getURL(), 'https://groups.test/first', 'group active');
  activePage().sendInputEvent({ type: 'keyDown', keyCode: 'G', modifiers: ['control', 'shift'] });
  await settingsReady();
  await call('restoreSavedTabGroup', saved.id, true);
  await assertLive('Renamed', 'purple', ['/first', '/third']);
  console.log('Saved Groups interaction check passed');
}

app.whenReady().then(main).then(() => {
  BrowserWindow.getAllWindows()[0]?.close();
  app.exit(0);
}, fail);
