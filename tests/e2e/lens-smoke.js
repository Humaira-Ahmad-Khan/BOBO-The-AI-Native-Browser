'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, dialog, session } = require('electron');

const root = path.join(__dirname, '.tmp');
fs.mkdirSync(root, { recursive: true });
const profile = fs.mkdtempSync(path.join(root, 'lens-'));
for (const key of ['userData', 'sessionData', 'crashDumps']) app.setPath(key, profile);
app.setAppLogsPath(profile);
app.commandLine.appendSwitch('disable-background-networking');
app.disableHardwareAcceleration();

const image = path.resolve(__dirname, '../../src/assets/logo/BOBO_Arctic_Frost/BOBO_Arctic_Frost_512.png');
const results = 'https://lens.google.com/search?p=fixture';
let consent = 0;
let requests = 0;
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [image] });
dialog.showMessageBox = async (_window, options) => {
  assert.equal(options.defaultId, 0);
  assert.match(options.message, /BOBO_Arctic_Frost_512\.png.*Google Lens/);
  return { response: consent };
};
global.fetch = async (url, options) => {
  requests++;
  assert.equal(url, 'https://lens.google.com/v3/upload');
  assert.equal(options.method, 'POST');
  assert.equal(options.redirect, 'manual');
  assert.equal(options.credentials, 'omit');
  const fields = [...options.body.entries()];
  assert.equal(fields.length, 1);
  assert.equal(fields[0][0], 'encoded_image');
  assert.equal(fields[0][1].name, 'image.png');
  assert.deepEqual(Buffer.from(await fields[0][1].arrayBuffer()).subarray(0, 8),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return new Response(null, { status: 303, headers: { location: results } });
};
app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] },
    ({ url }, done) => done({ cancel: url !== results }));
  session.defaultSession.protocol.handle('https', () => new Response('<title>Lens fixture</title>', {
    headers: { 'Content-Type': 'text/html' },
  }));
});

require('../../src/main/main');

async function until(read, expected) {
  let actual;
  for (let i = 0; i < 125; i++) {
    actual = await read();
    if (actual === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.equal(actual, expected);
}

app.whenReady().then(async () => {
  const active = () => BrowserWindow.getAllWindows()[0]?.contentView.children.at(-1)?.webContents;
  await until(() => active()?.getURL().endsWith('/newtab.html'), true);
  const tab = active();
  const run = (js) => tab.executeJavaScript(js);
  await until(() => run('!!document.querySelector("#btn-search-cam")'), true);
  await run('document.querySelector("#btn-search-cam").click(); document.querySelector("#btn-image-choose").click()');
  await until(() => run('!document.querySelector("#btn-image-search").hidden'), true);
  assert.equal(requests, 0);
  await run('document.querySelector("#btn-image-search").click()');
  await until(() => run('document.querySelector("#image-dialog-status").textContent'), 'Search canceled.');
  assert.equal(requests, 0);
  consent = 1;
  await run('document.querySelector("#btn-image-search").click()');
  await until(() => active()?.getURL(), results);
  assert.equal(requests, 1);
  console.log('Lens confirmation and selected-image upload smoke check passed');
}).then(() => app.exit(0), (error) => {
  console.error(error);
  app.exit(1);
});
