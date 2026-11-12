'use strict';

const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const APP_ID = 'com.squirrel.bobo.BOBO';
const EVENTS = new Set([
  '--squirrel-install', '--squirrel-updated', '--squirrel-uninstall',
  '--squirrel-obsolete', '--squirrel-firstrun',
]);
const run = promisify(execFile);

async function handleWindowsInstaller({ app, dialog, argv = process.argv,
  exe = process.execPath, platform = process.platform, execute = run }) {
  const event = argv[1];
  if (platform !== 'win32' || !app.isPackaged || !EVENTS.has(event)) return false;
  const updater = path.resolve(path.dirname(exe), '..', 'Update.exe');
  const appExe = path.basename(exe);
  const shortcut = (command, locations) => execute(updater,
    [command, appExe, `--shortcut-locations=${locations}`], { windowsHide: true, timeout: 10000 });
  try {
    if (event === '--squirrel-firstrun') {
      await app.whenReady();
      const answer = await dialog.showMessageBox({
        type: 'info',
        title: 'BOBO Setup',
        message: 'BOBO is installed',
        detail: 'Open BOBO now or find it in the Start menu. To pin it to the taskbar, open BOBO, right-click its taskbar icon and choose Pin to taskbar.',
        checkboxLabel: 'Create a desktop shortcut',
        buttons: ['Finish', 'Open BOBO'],
        defaultId: 0,
        cancelId: 0,
      });
      if (answer.checkboxChecked) await shortcut('--createShortcut', 'Desktop');
      if (answer.response === 1) return false;
    } else if (event === '--squirrel-install' || event === '--squirrel-updated') {
      await shortcut('--createShortcut', 'StartMenu');
    } else if (event === '--squirrel-uninstall') {
      await shortcut('--removeShortcut', 'StartMenu,Desktop');
    }
  } catch {
    dialog.showErrorBox('BOBO Setup', 'Windows could not update the BOBO shortcuts. You can still open BOBO from its installation folder.');
  }
  app.quit();
  return true;
}

module.exports = { APP_ID, handleWindowsInstaller };
