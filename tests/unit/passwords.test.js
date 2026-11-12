'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PasswordVault, httpsOrigin, loginForm, sameForm, createPasswordManager } = require('../../src/features/password-manager');
const form = { action: 'https://portal.example.test/login', usernameField: 'text:cnic:username', passwordField: 'password:password:current-password' };
const dummy = () => ({ origin: 'https://portal.example.test', username: `dummy-${crypto.randomUUID()}`, password: crypto.randomUUID(), form });
function directory(t) {
  const root = path.join(__dirname, '../.tmp'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'passwords-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}
// Unit-test adapter only. Real DPAPI is exercised by the Electron smoke check.
function encryption() {
  const key = crypto.randomBytes(32);
  return {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async value => {
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]);
    },
    decryptStringAsync: async value => {
      const cipher = crypto.createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      cipher.setAuthTag(value.subarray(12, 28));
      return { result: Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString('utf8') };
    },
  };
}
async function open(directory, safeStorage) {
  const vault = new PasswordVault({ directory, safeStorage, platform: 'win32' }); await vault.open(); return vault;
}
test('HTTPS exact origins only, normalized ports and punycode, no userinfo', () => {
  assert.equal(httpsOrigin('https://EXAMPLE.test:443/login'), 'https://example.test');
  for (const value of ['http://localhost/login', 'http://example.test', 'file:///login', 'javascript:alert(1)', 'https://user:secret@example.test']) assert.throws(() => httpsOrigin(value));
  assert.equal(httpsOrigin('https://éxample.test/'), 'https://xn--xample-9ua.test');
  assert.throws(() => loginForm({ ...form, action: 'https://evil.example.test/login' }, 'https://portal.example.test'));
  assert.equal(sameForm(form, { ...form, usernameField: 'text:email:' }), false);
});
test('explicit consent, encrypted identifiers, restart, multiple accounts, update, edit and delete', async t => {
  const dir = directory(t), storage = encryption(), value = dummy(); let vault = await open(dir, storage);
  assert.equal(vault.enabled(), false); assert.throws(() => vault.save(value, true));
  await vault.setEnabled(true); assert.throws(() => vault.save(value)); await vault.save(value, true);
  const second = dummy(); await vault.save(second, true);
  const bytes = fs.readFileSync(vault.file);
  for (const secret of [value.username, value.password, value.origin, second.username]) assert.equal(bytes.includes(Buffer.from(secret)), false);
  vault = await open(dir, storage); assert.equal(vault.enabled(), true);
  assert.equal(vault.matching(value.origin, form).length, 2);
  assert.equal(JSON.stringify(vault.status()).includes(value.username), false);
  const id = vault.matching(value.origin, form)[0].id; assert.equal(vault.account(id).password, value.password);
  assert.deepEqual(vault.matching('https://other.example.test', { ...form, action: 'https://other.example.test/login' }), []);
  assert.deepEqual(vault.matching(value.origin, { ...form, action: value.origin + '/other-login' }), []);
  const changed = crypto.randomUUID(); await vault.save({ ...value, password: changed }, true);
  assert.equal(vault.account(id).password, changed); assert.equal(vault.status().accounts.length, 2);
  await vault.edit(id, 'dummy-edited-identifier', changed); vault = await open(dir, storage);
  assert.equal(vault.account(id).username, 'dummy-edited-identifier');
  await vault.never(value.origin); assert.deepEqual(vault.matching(value.origin, form), []);
  await assert.rejects(vault.save(value, true)); vault = await open(dir, storage);
  assert.deepEqual(vault.status().never, [value.origin]); await vault.allow(value.origin); await vault.remove(id);
  vault = await open(dir, storage); assert.equal(vault.status().accounts.length, 1); assert.throws(() => vault.account(id));
  await vault.setEnabled(false); assert.deepEqual(vault.matching(value.origin, form), []); assert.equal(vault.status().accounts.length, 1);
});
test('corruption, wrong Windows key, non-Windows and encryption failure preserve existing data', async t => {
  const dir = directory(t), storage = encryption(), vault = await open(dir, storage); await vault.setEnabled(true);
  const original = fs.readFileSync(vault.file), wrongKey = await open(dir, encryption());
  assert.equal(wrongKey.status().failed, true); await assert.rejects(wrongKey.setEnabled(true));
  assert.deepEqual(fs.readFileSync(vault.file), original);
  storage.encryptStringAsync = async () => { throw new Error(); }; await assert.rejects(vault.setEnabled(false));
  assert.equal(vault.enabled(), true); assert.deepEqual(fs.readFileSync(vault.file), original);
  const unavailable = new PasswordVault({ directory: dir, safeStorage: storage, platform: 'linux' });
  await unavailable.open(); assert.equal(unavailable.enabled(), false);
  fs.writeFileSync(vault.file, Buffer.from('invalid dummy vault')); const corrupt = await open(dir, storage);
  assert.equal(corrupt.status().failed, true); assert.equal(fs.readFileSync(vault.file, 'utf8'), 'invalid dummy vault');
});
test('page IPC denies unknown owners, subframes, private tabs, scripts; reveal requires OS authentication', async t => {
  const handlers = new Map(), listeners = new Map(), app = new EventEmitter(), contents = new EventEmitter();
  const frame = { url: 'https://portal.example.test/login' };
  Object.assign(contents, { mainFrame: frame, isDestroyed: () => false, getURL: () => frame.url });
  const window = new EventEmitter(); Object.assign(window, { webContents: {}, isFocused: () => true });
  let privateTab = false, known = true, verify = false, prompts = 0;
  const manager = { activeWebContents: () => contents, tabIdForContents: () => 1, byId: () => ({ private: privateTab }) };
  const ownerFor = () => known ? { window, manager } : null;
  const service = await createPasswordManager({ app, directory: directory(t), safeStorage: encryption(),
    ipcMain: { on: (n, run) => listeners.set(n, run), handle: (n, run) => handlers.set(n, run) },
    dialog: { showMessageBox: async () => { prompts++; return { response: 0 }; } }, ownerFor, verifyUser: async () => verify });
  const vault = service.vault; if (!vault.available) return t.skip('Windows-only controller');
  await vault.setEnabled(true); const value = dummy(); await vault.save(value, true);
  const event = { sender: contents, senderFrame: frame }, page = handlers.get('bobo:passwords:page');
  app.emit('web-contents-created', {}, contents);
  await page(event, { op: 'fill', form }); assert.equal(prompts, 0);
  contents.emit('before-input-event', {}, { type: 'keyDown' }); privateTab = true;
  await page(event, { op: 'fill', form }); assert.equal(prompts, 0); privateTab = false;
  await page({ ...event, senderFrame: { url: frame.url } }, { op: 'fill', form }); assert.equal(prompts, 0);
  known = false; await page(event, { op: 'fill', form }); assert.equal(prompts, 0); known = true;
  contents.emit('before-input-event', {}, { type: 'keyDown' });
  assert.equal((await page(event, { op: 'fill', form })).password, value.password); assert.equal(prompts, 1);
  contents.emit('before-input-event', {}, { type: 'keyDown' });
  assert.deepEqual(await page(event, { op: 'fill', form, username: 'dummy-unknown' }), {});
  assert.equal(prompts, 1, 'a remembered identifier cannot select a different saved account');
  contents.emit('before-input-event', {}, { type: 'keyDown' });
  assert.equal((await page(event, { op: 'fill', form, username: value.username })).password, value.password);
  service.registerSettings({ handle: (n, run) => handlers.set(n, run) });
  const settings = handlers.get('bobo:passwords:manage'), id = vault.status().accounts[0].id;
  await assert.rejects(settings({ op: 'reveal', id }, event), /Verify/);
  assert.equal((await settings({ op: 'unlock' }, event)).authenticated, false); verify = true;
  assert.equal((await settings({ op: 'unlock' }, event)).authenticated, true);
  assert.equal((await settings({ op: 'reveal', id }, event)).password, value.password);
  window.emit('blur'); await assert.rejects(settings({ op: 'reveal', id }, event), /Verify/);
  await settings({ op: 'unlock' }, event); contents.emit('blur');
  await assert.rejects(settings({ op: 'edit', id, username: value.username, password: value.password }, event), /Verify/);
  await settings({ op: 'unlock' }, event); contents.emit('did-start-navigation', { isMainFrame: true, url: frame.url });
  await assert.rejects(settings({ op: 'reveal', id }, event), /Verify/);
});

test('capture requires input and success confirmation; Never Save blocks future capture and fill', async t => {
  const app = new EventEmitter(), contents = new EventEmitter(), handlers = new Map(), listeners = new Map();
  const frame = { url: 'https://portal.example.test/login' };
  Object.assign(contents, { mainFrame: frame, isDestroyed: () => false, getURL: () => frame.url });
  const window = new EventEmitter(); Object.assign(window, { webContents: {}, isFocused: () => true });
  const manager = { activeWebContents: () => contents, tabIdForContents: () => 1, byId: () => ({ private: false }) };
  let response = 2, prompts = 0;
  const confirmations = [];
  const service = await createPasswordManager({ app, directory: directory(t), safeStorage: encryption(),
    ipcMain: { on: (n, run) => listeners.set(n, run), handle: (n, run) => handlers.set(n, run) },
    dialog: { showMessageBox: async (_window, options) => {
      if (options.type === 'info') confirmations.push(options.title);
      else prompts++;
      return { response };
    } }, ownerFor: () => ({ window, manager }) });
  if (!service.vault.available) return t.skip('Windows-only controller');
  const vault = service.vault; await vault.setEnabled(true);
  app.emit('web-contents-created', {}, contents);
  const event = { sender: contents, senderFrame: frame }, value = dummy();
  const capture = () => listeners.get('bobo:passwords:candidate')(event, value);
  const ready = hasLogin => handlers.get('bobo:passwords:page')(event, { op: 'ready', hasLogin });
  capture(); await ready(false); assert.equal(prompts, 0);
  contents.emit('before-input-event', {}, { type: 'keyDown' }); capture();
  await ready(true); assert.equal(prompts, 0); assert.equal(vault.status().accounts.length, 0);
  await ready(false); assert.equal(prompts, 1); assert.equal(vault.status().accounts.length, 0);
  assert.deepEqual(confirmations, [], 'declining never claims a password was saved');
  response = 0; contents.emit('before-input-event', {}, { type: 'keyDown' }); capture();
  contents.emit('did-fail-load', {}, -3, 'Aborted dummy iframe', 'https://captcha.example.test/', false);
  contents.emit('did-fail-load', {}, -3, 'Replaced dummy main document', frame.url, true);
  await ready(false); assert.equal(vault.status().accounts.length, 1);
  assert.deepEqual(confirmations, ['Password Saved']);
  const reopened = await open(path.dirname(vault.file), vault.storage);
  assert.equal(reopened.account(vault.status().accounts[0].id).password, value.password,
    'success notification follows a persistent encrypted write');
  contents.emit('before-input-event', {}, { type: 'keyDown' });
  listeners.get('bobo:passwords:candidate')(event, { ...value, password: crypto.randomUUID() });
  contents.emit('did-fail-load', {}, -105, 'Dummy main-page failure', frame.url, true);
  await ready(false);
  assert.deepEqual(confirmations, ['Password Saved'], 'a failed main page cannot trigger a save confirmation');
  contents.emit('before-input-event', {}, { type: 'keyDown' });
  listeners.get('bobo:passwords:candidate')(event, { ...value, password: crypto.randomUUID() });
  contents.emit('did-start-navigation', { isMainFrame: true, url: 'https://attacker.example.test/' });
  const before = prompts; await ready(false); assert.equal(prompts, before);
  response = 1; contents.emit('before-input-event', {}, { type: 'keyDown' });
  listeners.get('bobo:passwords:candidate')(event, { ...value, password: crypto.randomUUID() });
  await ready(false); assert.equal(vault.blocked(value.origin), true);
  assert.equal(vault.status().accounts.length, 1); assert.deepEqual(vault.matching(value.origin, form), []);
  contents.emit('before-input-event', {}, { type: 'keyDown' }); capture(); await ready(false);
  assert.equal(prompts, before + 1);
  await vault.allow(value.origin);
  response = 0;
  vault.storage.encryptStringAsync = async () => { throw new Error('Simulated disk/encryption failure'); };
  contents.emit('before-input-event', {}, { type: 'keyDown' });
  listeners.get('bobo:passwords:candidate')(event, { ...value, password: crypto.randomUUID() });
  await ready(false);
  assert.deepEqual(confirmations, ['Password Saved'], 'failed writes never show a success notification');
  assert.equal(vault.account(vault.status().accounts[0].id).password, value.password);
});
