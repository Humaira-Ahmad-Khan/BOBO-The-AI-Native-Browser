'use strict';

/**
 * Tab-engine smoke check - run with `npm run smoke`.
 *
 * Drives the real TabManager in a hidden window: create, switch, cycle and close
 * tabs, and verify the window recovers when the last tab closes. Only BOBO's own
 * local pages are loaded, so this makes no network request.
 *
 * It cannot prove a click on the tab strip reaches this code (that is the
 * renderer/IPC path); it proves the tab engine behind it behaves.
 */

const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');
const { TabManager } = require('../../src/main/tabs');

const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${message}`);
};

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  let ok = false;
  try {
    ok = await main();
  } catch (error) {
    console.error(error);
  }
  app.exit(ok ? 0 : 1);
});

async function main() {
  // The new-tab page inside each view asks for state on load; answer it so the
  // check output stays about the tab engine (the real handler lives in main.js).
  ipcMain.handle('bobo:get-state', () => ({ tabs: { activeId: null, tabs: [] }, theme: 'dark' }));

  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 640,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, '../../src/renderer/index.html'));

  const snapshots = [];
  const tabs = new TabManager({
    window: win,
    onChange: (snapshot) => snapshots.push(snapshot),
  });

  // --- create -------------------------------------------------------------
  const first = tabs.create();
  await wait(400);
  let state = tabs.snapshot();
  check(state.tabs.length === 1, 'first tab created');
  check(state.activeId === first, 'first tab is active');
  check(state.tabs[0].isLocal, 'first tab is a local BOBO page');
  check(state.tabs[0].title === 'New Tab', `new tab title is "New Tab" (got "${state.tabs[0].title}")`);
  check(snapshots.length > 0, 'state changes are pushed to the chrome');

  // --- create a second tab ------------------------------------------------
  const second = tabs.create();
  await wait(400);
  state = tabs.snapshot();
  check(state.tabs.length === 2, 'second tab created');
  check(state.activeId === second, 'new tab takes focus');
  check(first !== second, 'tab ids are unique');

  // --- switch -------------------------------------------------------------
  tabs.select(first);
  state = tabs.snapshot();
  check(state.activeId === first, 'select() switches the active tab');
  check(tabs.select(9999) === false, 'select() rejects an unknown tab id');

  // --- cycle --------------------------------------------------------------
  tabs.cycle(1);
  check(tabs.snapshot().activeId === second, 'cycle(1) wraps to the other tab');
  tabs.cycle(1);
  check(tabs.snapshot().activeId === first, 'cycle() wraps around the tab strip');

  // --- home ---------------------------------------------------------------
  tabs.home(first);
  await wait(250);
  check(tabs.snapshot().tabs[0].url === '', 'home() returns the tab to the new-tab page');

  // --- close --------------------------------------------------------------
  tabs.close(second);
  state = tabs.snapshot();
  check(state.tabs.length === 1, 'close() removes the tab');
  check(state.activeId === first, 'active tab is unchanged when another tab closes');

  tabs.close(first);
  await wait(400);
  state = tabs.snapshot();
  check(state.tabs.length === 1, 'closing the last tab opens a fresh one');
  check(state.activeId === state.tabs[0].id, 'the fresh tab is active');

  // --- reopen -------------------------------------------------------------
  check(tabs.reopenClosed() === null, 'reopenClosed() ignores local pages (nothing to restore)');

  win.destroy();

  console.log(`\n${failures.length === 0 ? 'PASS' : 'FAILED'} - ${failures.length} problem(s)`);
  for (const failure of failures) console.log(`  - ${failure}`);
  return failures.length === 0;
}
