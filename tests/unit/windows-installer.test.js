'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { handleWindowsInstaller } = require('../../src/main/windows-installer');

function fixture(event, answer = {}) {
  const calls = [];
  const exe = path.resolve('fixture', 'app-0.1.1', 'BOBO.exe');
  const args = {
    platform: 'win32',
    argv: [exe, event],
    exe,
    app: {
      isPackaged: true,
      whenReady: async () => {},
      quit: () => calls.push('quit'),
    },
    dialog: {
      showMessageBox: async (options) => { calls.push(options.buttons); return answer; },
      showErrorBox: () => assert.fail('Unexpected setup error'),
    },
    execute: async (file, argv) => {
      assert.equal(file, path.resolve('fixture', 'Update.exe'));
      calls.push(argv);
    },
  };
  return { args, calls };
}

test('installer setup and upgrade create a Start menu shortcut without starting the browser', async () => {
  for (const event of ['--squirrel-install', '--squirrel-updated']) {
    const { args, calls } = fixture(event);
    assert.equal(await handleWindowsInstaller(args), true);
    assert.deepEqual(calls, [['--createShortcut', 'BOBO.exe', '--shortcut-locations=StartMenu'], 'quit']);
  }
});

test('finish keeps the browser closed and creates a desktop shortcut only if checked', async () => {
  for (const checkboxChecked of [true, false]) {
    const { args, calls } = fixture('--squirrel-firstrun', { response: 0, checkboxChecked });
    assert.equal(await handleWindowsInstaller(args), true);
    assert.deepEqual(calls, [
      ['Finish', 'Open BOBO'],
      ...(checkboxChecked ? [['--createShortcut', 'BOBO.exe', '--shortcut-locations=Desktop']] : []),
      'quit',
    ]);
  }
});

test('Open BOBO and ordinary launches continue into browser startup', async () => {
  const first = fixture('--squirrel-firstrun', { response: 1 });
  assert.equal(await handleWindowsInstaller(first.args), false);
  assert.deepEqual(first.calls, [['Finish', 'Open BOBO']]);
  const ordinary = fixture(undefined);
  assert.equal(await handleWindowsInstaller(ordinary.args), false);
  assert.deepEqual(ordinary.calls, []);
});
