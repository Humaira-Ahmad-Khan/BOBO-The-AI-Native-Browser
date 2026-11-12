'use strict';

// Two separate Electron processes prove OS-backed persistence across restart.
// PowerShell: & .\node_modules\electron\dist\electron.exe tests/e2e/passwords-smoke.js --stage=save
// PowerShell: & .\node_modules\electron\dist\electron.exe tests/e2e/passwords-smoke.js --stage=verify
// All content is intercepted locally; no server, network or real accounts.
const { app, BrowserWindow, ipcMain, safeStorage, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const assert = require('node:assert/strict');
const applicationRoot = process.env.BOBO_SMOKE_APP_ROOT || path.resolve(__dirname, '../..');
const { PasswordVault, createPasswordManager } = require(path.join(applicationRoot, 'src/features/password-manager'));
const { assertTrusted, authorizeChannel } = require(path.join(applicationRoot, 'src/main/security'));
const root = path.resolve(__dirname, '../.tmp/passwords-smoke');
fs.mkdirSync(root, { recursive: true });
app.setPath('userData', path.join(root, 'profile'));
app.setPath('sessionData', path.join(root, 'session'));
app.setPath('crashDumps', path.join(root, 'crashes'));
app.setAppLogsPath(path.join(root, 'logs'));
app.commandLine.appendSwitch('disable-background-networking');
app.disableHardwareAcceleration();
const origin = 'https://elgcdd.example.test';
const angularForm = process.argv.includes('--angular-form');
const legacyControls = process.argv.includes('--legacy-controls');
const form = { action: origin + '/login', usernameField: angularForm ? 'text:formcontrol:username:off' : legacyControls ? 'text:legacy-cnic:username' : 'text:cnic:username', passwordField: angularForm ? 'password:formcontrol:password:off' : legacyControls ? 'password:legacy-password:current-password' : 'password:password:current-password' };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
let step = 'startup';
const trace = [];
const nativeSubmission = process.argv.includes('--native-submit');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let n = 0; n < 80; n++) { if (await check()) return; await wait(100); }
  throw new Error('Dummy login flow timed out.');
}
const fixture = `<!doctype html><meta charset="utf-8">${angularForm ? '<form>' : '<form method="post" action="/login">'}
  <label>CNIC <input ${angularForm ? 'formcontrolname="username" autocomplete="off" placeholder="CNIC"' : legacyControls ? 'id="legacy-cnic" formcontrolname="username" autocomplete="username"' : 'name="cnic" autocomplete="username"'}></label>
  <label>Password <input type="password" ${angularForm ? 'formcontrolname="password" autocomplete="off" placeholder="Password"' : legacyControls ? 'id="legacy-password" formcontrolname="password" autocomplete="current-password"' : 'name="password" autocomplete="current-password"'}></label>
  <button type="submit">Sign In</button></form><script>
  window.submitted = 0;
  document.querySelector('form').addEventListener('submit', event => {
    ${nativeSubmission ? 'window.submitted++;' : "event.preventDefault(); window.submitted++; const login=event.currentTarget; login.querySelector('input[type=password]').disabled=true; setTimeout(()=>login.remove(),1600);"}
  });</script>`;

app.whenReady().then(async () => {
  try {
    // Overriding the protocol inside this test's isolated session avoids all network.
    session.defaultSession.protocol.handle('https', request => new Response(
      nativeSubmission && request.method === 'POST' ? '<!doctype html><h1>Dummy signed-in page</h1>' : fixture,
      { headers: { 'content-type': 'text/html' } }));
    session.defaultSession.protocol.handle('http', () => new Response(fixture, { headers: { 'content-type': 'text/html' } }));
    const stage = process.argv.find(value => value.startsWith('--stage='))?.split('=')[1];
    assert.ok(['save', 'verify'].includes(stage));
    let window;
    const ownerWindow = new EventEmitter();
    Object.assign(ownerWindow, { webContents: {}, isFocused: () => true });
    const manager = { activeWebContents: () => window?.webContents, tabIdForContents: () => 1, byId: () => ({ private: false }) };
    const prompts = [];
    let choice = 0;
    const testIpc = { on: (name, run) => ipcMain.on(name, (...args) => { trace.push('candidate'); run(...args); }),
      handle: (name, run) => ipcMain.handle(name, async (...args) => {
        const op = args[1]?.op; trace.push(`page:${op}`);
        const reply = await run(...args);
        if (op === 'status') trace.push(`enabled:${reply.enabled}`);
        return reply;
      }) };
    const service = await createPasswordManager({ app, directory: root, safeStorage, ipcMain: testIpc, verifyUser: async () => false,
      ownerFor: contents => contents === window?.webContents ? { window: ownerWindow, manager } : null,
      dialog: { showMessageBox: async (_owner, options) => { prompts.push(options.title); return { response: choice }; } } });
    assert.equal(service.vault.available, true, 'Windows DPAPI must be available');
    if (stage === 'save') {
      step = 'initializing dummy vault';
      // This fixed, ignored test profile contains generated dummy accounts only.
      for (const account of service.vault.status().accounts) await service.vault.remove(account.id);
      await service.vault.setEnabled(true);
    } else { step = 'restart persistence'; assert.equal(service.vault.status().accounts.length, 1, 'Saved account survives a separate process'); }
    window = new BrowserWindow({ show: true, width: 900, height: 600,
      webPreferences: { preload: path.join(applicationRoot, 'src/preload/preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const wc = window.webContents;
    wc.on('before-mouse-event', (_event, input) => trace.push(`mouse:${input.type}`));
    let preloadFailure = false;
    wc.on('preload-error', () => { preloadFailure = true; });
    const read = code => wc.executeJavaScript(code);
    const click = async selector => {
      window.show(); window.focus();
      await wait(150);
      wc.focus(); await wait(50);
      trace.push(`focused:${window.isFocused()}`);
      const box = await read(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2)}; })()`);
      wc.sendInputEvent({ type: 'mouseDown', ...box, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', ...box, button: 'left', clickCount: 1 });
      await wait(200);
    };
    await wc.loadURL(origin + '/login'); await wait(1500);
    assert.equal(preloadFailure, false);
    assert.equal(await read('typeof window.bobo'), 'undefined', 'Remote main world has no browser or vault API');
    if (stage === 'save') {
      step = 'trusted submission save';
      const username = String(crypto.randomInt(100000000, 999999999)) + '0000', password = crypto.randomUUID();
      await read(`document.querySelector('[name=cnic],[formcontrolname=username]').value = ${JSON.stringify(username)}; document.querySelector('[name=password],[formcontrolname=password]').value = ${JSON.stringify(password)};`);
      await click('button');
      trace.push(`submitted:${await read('window.submitted')}`);
      if (!nativeSubmission) {
        await wait(1100);
        assert.equal(service.vault.status().accounts.length, 0, 'disabled login fields are not proof of successful sign-in');
      }
      await until(() => service.vault.status().accounts.length === 1);
      assert.deepEqual(service.vault.account(service.vault.status().accounts[0].id).form, form,
        'new Angular support preserves existing named and ID-based account bindings');
      assert.ok(prompts.includes('Save Password'));
      await until(() => prompts.includes('Password Saved'));
      const bytes = fs.readFileSync(service.vault.file);
      assert.equal(bytes.includes(Buffer.from(username)), false); assert.equal(bytes.includes(Buffer.from(password)), false);
      fs.writeFileSync(path.join(root, 'expected.json'), JSON.stringify({ username: hash(username), password: hash(password) }));
    } else {
      step = 'script focus refusal';
      const expected = JSON.parse(fs.readFileSync(path.join(root, 'expected.json'), 'utf8'));
      // Script-created focus is not sufficient to request a credential.
      await read("document.querySelector('[name=cnic],[formcontrolname=username]').focus()"); await wait(300);
      assert.equal(prompts.length, 0);
      await read('document.activeElement.blur()');
      // Exercise a fresh document after script-created focus was refused.
      await wc.reload(); await wait(1500);
      step = 'trusted focus fill';
      await click('[name=cnic],[formcontrolname=username]');
      await until(async () => await read("document.querySelector('[name=password],[formcontrolname=password]').value.length > 0"));
      assert.equal(hash(await read("document.querySelector('[name=cnic],[formcontrolname=username]').value")), expected.username);
      assert.equal(hash(await read("document.querySelector('[name=password],[formcontrolname=password]').value")), expected.password);
      assert.equal(await read('window.submitted'), 0, 'Filling never submits the login');
      step = 'update prompt';
      const id = service.vault.status().accounts[0].id;
      const updated = crypto.randomUUID();
      await read(`document.querySelector('[name=password],[formcontrolname=password]').value = ${JSON.stringify(updated)}`);
      await click('button');
      await until(() => service.vault.account(id).password === updated);
      assert.ok(prompts.includes('Update Password'));
      await until(() => prompts.includes('Password Updated'));
      step = 'multiple accounts';
      const other = { origin, username: 'dummy-second-account', password: crypto.randomUUID(), form };
      await service.vault.save(other, true);
      assert.equal(service.vault.matching(origin, form).length, 2);
      step = 'second account focus';
      await wc.loadURL(origin + '/login'); await wait(1500); choice = 1;
      await click('[name=cnic],[formcontrolname=username]');
      await until(async () => await read("document.querySelector('[name=password],[formcontrolname=password]').value.length > 0"));
      assert.equal(await read("document.querySelector('[name=cnic],[formcontrolname=username]').value"), other.username);
      assert.equal(await read('window.submitted'), 0); choice = 0;
      step = 'remembered identifier';
      await wc.loadURL(origin + '/login'); await wait(500);
      await read(`document.querySelector('[name=cnic],[formcontrolname=username]').value = ${JSON.stringify(other.username)}`);
      await click('[name=password],[formcontrolname=password]');
      await until(async () => await read("document.querySelector('[name=password],[formcontrolname=password]').value.length > 0"));
      assert.equal(await read("document.querySelector('[name=cnic],[formcontrolname=username]').value"), other.username);
      assert.equal(await read("document.querySelector('[name=password],[formcontrolname=password]').value"), other.password);
      assert.equal(await read('window.submitted'), 0);
      step = 'unknown remembered identifier';
      await wc.loadURL(origin + '/login'); await wait(500);
      await read("document.querySelector('[name=cnic],[formcontrolname=username]').value = 'dummy-unsaved-identifier'");
      const beforeUnknown = prompts.length;
      await click('[name=password],[formcontrolname=password]'); await wait(300);
      assert.equal(prompts.length, beforeUnknown);
      assert.equal(await read("document.querySelector('[name=password],[formcontrolname=password]').value"), '');
      if (angularForm) {
        step = 'uncancelled unnamed GET refusal';
        await wc.loadURL(origin + '/login'); await wait(500);
        await read(`document.querySelector('[formcontrolname=username]').value = ${JSON.stringify(other.username)};
          document.querySelector('[formcontrolname=password]').value = ${JSON.stringify(other.password)};
          const f = document.querySelector('form'); f.replaceWith(f.cloneNode(true)); void 0;`);
        assert.ok(await read("document.querySelector('[formcontrolname=password]').value.length > 0"));
        const captures = trace.filter(item => item === 'candidate').length;
        await click('button'); await wait(300);
        assert.equal(trace.filter(item => item === 'candidate').length, captures,
          'Angular-shaped forms must actually cancel native submission before capture');
        assert.equal(new URL(wc.getURL()).search, '', 'unnamed controls cannot put credentials in a GET query');
      }
      step = 'unsafe form refusal';
      const unsafe = [
        "document.querySelector('[name=password],[formcontrolname=password]').style.display='none'",
        "document.querySelector('form').method='get'",
        "document.querySelector('form').action='https://phishing.example.test/login'",
        "document.querySelector('[name=password],[formcontrolname=password]').autocomplete='new-password'",
        "document.querySelector('button').setAttribute('formaction','https://phishing.example.test/login')",
        "document.querySelector('form').insertAdjacentHTML('afterbegin','<input name=email>')",
      ];
      for (const mutation of unsafe) {
        await wc.loadURL(origin + '/login'); await wait(400); await read(mutation);
        const before = prompts.length; await click('[name=cnic],[formcontrolname=username]');
        assert.equal(prompts.length, before); assert.equal(await read("document.querySelector('[name=password],[formcontrolname=password]').value"), '');
      }
      step = 'iframe refusal';
      await wc.loadURL(origin + '/login'); await wait(400);
      await read("document.querySelector('form').remove(); const f=document.createElement('iframe'); f.src='https://phishing.example.test/login'; document.body.append(f)");
      await until(() => wc.mainFrame.frames.length === 1);
      await wait(500);
      const child = wc.mainFrame.frames[0], beforeFrame = prompts.length;
      await child.executeJavaScript("document.querySelector('[name=cnic],[formcontrolname=username]').focus()"); await wait(300);
      assert.equal(prompts.length, beforeFrame);
      assert.equal(await child.executeJavaScript("document.querySelector('[name=password],[formcontrolname=password]').value"), '');
      step = 'phishing refusal';
      await wc.loadURL('https://phishing.example.test/login'); await wait(1500);
      const count = prompts.length; await click('[name=cnic],[formcontrolname=username]');
      assert.equal(prompts.length, count); assert.equal(await read("document.querySelector('[name=password],[formcontrolname=password]').value"), '');
      step = 'HTTP refusal';
      await wc.loadURL('http://elgcdd.example.test/login'); await wait(300); await click('[name=cnic],[formcontrolname=username]');
      assert.equal(prompts.length, count, 'HTTP has no autofill');
      step = 'persistent deletion';
      service.registerSettings({ handle: (channel, run) => ipcMain.handle(channel, (event, payload) => {
        const owner = { window: ownerWindow, manager };
        assertTrusted(event); authorizeChannel(event, owner, channel);
        return run(payload, event);
      }) });
      ipcMain.handle('bobo:get-state', () => ({ theme: 'dark', searchEngine: 'google' }));
      ipcMain.handle('bobo:settings:browser', () => ({}));
      ipcMain.handle('bobo:downloads:prefs', () => ({ directory: root, ask: true }));
      ipcMain.handle('bobo:tools:state', () => ({ tools: [], prefs: {}, browser: {} }));
      ipcMain.handle('bobo:tabs:group:saved-list', () => []);
      step = 'Settings role and locked UI';
      await wc.loadFile(path.join(applicationRoot, 'src/renderer/settings.html'), { query: { view: 'passwords' } });
      await until(async () => (await read("document.getElementById('passwords-accounts').children.length")) === 2);
      assert.equal(await read("typeof window.bobo.passwordManager"), 'function');
      assert.equal(await read("document.getElementById('passwords-secret').value"), '');
      assert.equal(await read("document.getElementById('passwords-editor').open"), false);
      await read("document.querySelector('#passwords-accounts button').click()"); await wait(200);
      assert.equal(await read("document.getElementById('passwords-editor').open"), false, 'Failed OS authentication never opens the editor');
      assert.equal(await read("document.getElementById('passwords-secret').value"), '');
      step = 'persistent deletion';
      await service.vault.remove(id); await service.vault.remove(service.vault.status().accounts[0].id);
      const reopened = new PasswordVault({ directory: root, safeStorage }); await reopened.open();
      assert.equal(reopened.status().accounts.length, 0, 'Deletion persists');
    }
    window.destroy(); console.log(`Password manager ${stage}: PASS (dummy data only)`); app.exit(0);
  } catch (error) {
    // Assertions may contain plaintext expected/actual values. Do not log them.
    const locations = [...String(error.stack || '').matchAll(/passwords-smoke\.js:\d+:\d+/g)].map(match => match[0]).join(', ');
    console.error(`Password manager smoke: FAIL at ${step} (${locations}); ${trace.slice(-20).join(', ')}. Credential values are not logged.`); app.exit(1);
  }
});
