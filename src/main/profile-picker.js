'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { COLORS, profileArguments } = require('./profiles');

function showProfilePicker({ app, BrowserWindow, ipcMain, profiles, icon }) {
  const file = path.join(__dirname, '../renderer/profiles.html');
  const expected = pathToFileURL(file).href;
  const picker = new BrowserWindow({
    title: 'Who’s using BOBO?', width: 1040, height: 700, minWidth: 640, minHeight: 480, icon,
    backgroundColor: '#eef6fb',
    webPreferences: {
      preload: path.join(__dirname, '../preload/profiles-preload.js'),
      partition: 'profile-picker-' + randomUUID(),
      sandbox: true, contextIsolation: true, nodeIntegration: false,
    },
  });
  picker.webContents.session.setPermissionCheckHandler(() => false);
  picker.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  const channels = [];
  const handle = (channel, run) => {
    channels.push(channel);
    ipcMain.handle(channel, (event, payload) => {
      if (picker.isDestroyed() || event.sender !== picker.webContents ||
          event.senderFrame !== picker.webContents.mainFrame ||
          event.senderFrame.url !== expected || picker.webContents.getURL() !== expected) {
        throw new Error('BOBO: profile operation denied.');
      }
      if (payload != null && (typeof payload !== 'object' || Object.getPrototypeOf(payload) !== Object.prototype)) {
        throw new Error('BOBO: invalid profile request.');
      }
      return run(payload);
    });
  };
  handle('bobo:profiles:list', () => ({ profiles: profiles.list(), colors: COLORS }));
  handle('bobo:profiles:edit', (payload) => profiles.edit(payload || {}));
  handle('bobo:profiles:remove', (payload) => profiles.remove(payload?.id));
  let launching = false;
  handle('bobo:profiles:open', (payload) => {
    profiles.directory(payload?.id);
    if (launching) return;
    launching = true;
    app.relaunch({ args: profileArguments(process.argv, payload.id) });
    app.quit();
  });
  picker.webContents.on('will-navigate', (event) => event.preventDefault());
  picker.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  picker.on('closed', () => {
    for (const channel of channels) ipcMain.removeHandler(channel);
  });
  void picker.loadFile(file);
  return picker;
}

module.exports = { showProfilePicker };
