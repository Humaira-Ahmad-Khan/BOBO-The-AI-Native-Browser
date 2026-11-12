'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { PasswordVault, httpsOrigin, loginForm } = require('./index');

// Only an OS-owned Windows Hello prompt can grant reveal/edit access. No fallback.
function verifyWindowsUser() {
  if (process.platform !== 'win32') return Promise.resolve(false);
  return new Promise(resolve => {
    const script = fs.readFileSync(path.join(__dirname, 'verify-user.ps1'), 'utf8');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 60000, maxBuffer: 1024 },
      (error, stdout) => resolve(!error && stdout.trim() === 'BOBO_VERIFIED'));
  });
}

async function createPasswordManager({ directory, safeStorage, ipcMain, dialog, ownerFor, app, verifyUser = verifyWindowsUser }) {
  const vault = new PasswordVault({ directory, safeStorage,
    disabled: process.env.BOBO_DISABLE_PASSWORD_MANAGER === '1' });
  await vault.open();
  const pending = new Map();
  const busy = new Set();
  const grants = new Map();
  const watchedSettings = new WeakSet();
  const gestures = new WeakMap();
  app.on('web-contents-created', (_event, contents) => {
    contents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown') gestures.set(contents, Date.now());
    });
    contents.on('before-mouse-event', (_event, input) => {
      if (input.type === 'mouseDown') gestures.set(contents, Date.now());
    });
    contents.on('did-start-navigation', details => {
      if (!details.isMainFrame) return;
      try { if (pending.get(contents)?.origin !== httpsOrigin(details.url)) clear(contents); }
      catch { clear(contents); }
    });
    contents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
      // CAPTCHA/subframe failures and replaced loads do not establish login failure.
      if (isMainFrame && code !== -3) clear(contents);
    });
    contents.on('render-process-gone', () => clear(contents));
    contents.once('destroyed', () => { clear(contents); grants.delete(contents); });
  });
  const consumeGesture = contents => {
    const time = gestures.get(contents) || 0;
    gestures.delete(contents);
    return Date.now() - time < 5000;
  };
  const clear = contents => {
    const item = pending.get(contents);
    if (item) clearTimeout(item.timer);
    pending.delete(contents);
  };
  function page(event) {
    const contents = event.sender;
    const owner = ownerFor(contents);
    if (!owner || contents.isDestroyed() || event.senderFrame !== contents.mainFrame ||
        event.senderFrame.url !== contents.getURL() || owner.manager.activeWebContents() !== contents ||
        !owner.window.isFocused() || owner.window.webContents === contents ||
        owner.manager.byId(owner.manager.tabIdForContents(contents))?.private !== false) throw new Error();
    const origin = httpsOrigin(event.senderFrame.url);
    return { ...owner, contents, frame: event.senderFrame, origin, url: event.senderFrame.url };
  }
  function stillPage(context) {
    try {
      return !context.contents.isDestroyed() && context.contents.mainFrame === context.frame &&
        context.contents.getURL() === context.url && ownerFor(context.contents)?.manager.activeWebContents() === context.contents;
    } catch { return false; }
  }
  const message = (window, options) => dialog.showMessageBox(window, {
    type: 'question', noLink: true, defaultId: 0, cancelId: options.buttons.length - 1, ...options,
  });
  const reportError = window => dialog.showMessageBox(window, { type: 'error',
    message: 'BOBO could not update the password vault.', detail: 'Existing data has been preserved. Please try again.', buttons: ['OK'] });

  ipcMain.on('bobo:passwords:candidate', (event, value) => {
    try {
      const context = page(event);
      if (!vault.enabled() || vault.blocked(context.origin) || busy.has(context.contents)) return;
      if (!consumeGesture(context.contents)) return;
      const form = loginForm(value?.form, context.origin);
      if (typeof value.username !== 'string' || !value.username || value.username.length > 512 ||
          typeof value.password !== 'string' || !value.password || value.password.length > 4096) return;
      clear(context.contents);
      const timer = setTimeout(() => clear(context.contents), 60000);
      timer.unref();
      pending.set(context.contents, { origin: context.origin, form, username: value.username,
        password: value.password, timer });
    } catch { /* Untrusted, private, non-HTTPS and subframe senders are denied. */ }
  });

  ipcMain.handle('bobo:passwords:page', async (event, value) => {
    let context;
    let acquired = false;
    try {
      context = page(event);
      if (!vault.enabled()) { clear(context.contents); return { enabled: false }; }
      if (value?.op === 'status') return { enabled: !vault.blocked(context.origin) };
      if (busy.has(context.contents)) return {};
      if (value?.op === 'ready') {
        const candidate = pending.get(context.contents);
        if (!candidate) return {};
        if (candidate.origin !== context.origin || vault.blocked(context.origin)) { clear(context.contents); return {}; }
        if (value.hasLogin !== false) return {};
        clear(context.contents);
        busy.add(context.contents);
        acquired = true;
        const old = vault.matching(candidate.origin, candidate.form).find(a => a.username === candidate.username);
        if (old && vault.account(old.id).password === candidate.password) return {};
        const answer = await message(context.window, {
          title: old ? 'Update Password' : 'Save Password',
          message: `${old ? 'Update' : 'Save'} password for ${candidate.origin}?`,
          detail: 'Only approve if your sign-in succeeded. Your identifier and password will be encrypted for this Windows account.',
          buttons: [old ? 'Update' : 'Save', 'Never Save', 'Not Now'],
        });
        if (!stillPage(context)) return {};
        if (answer.response === 0) {
          await vault.save(candidate, true);
          await dialog.showMessageBox(context.window, {
            type: 'info', title: old ? 'Password Updated' : 'Password Saved',
            message: old ? 'Your saved password has been updated.' : 'Your password has been saved.',
            detail: 'Your identifier and password are encrypted in this BOBO profile on this computer. They will be available after restarting BOBO. To fill them, focus the empty login field and choose your saved account.',
            buttons: ['OK'], noLink: true,
          });
        }
        if (answer.response === 1) await vault.never(context.origin);
        return {};
      }
      if (value?.op === 'fill') {
        if (!consumeGesture(context.contents)) return {};
        if (value.username !== undefined && (typeof value.username !== 'string' || value.username.length > 512)) return {};
        const form = loginForm(value.form, context.origin);
        const accounts = vault.matching(context.origin, form)
          .filter(account => !value.username || account.username === value.username);
        if (!accounts.length || accounts.length > 20) return {};
        busy.add(context.contents);
        acquired = true;
        const answer = await message(context.window, { title: 'Choose Saved Account',
          message: `Fill a saved account on ${context.origin}?`,
          detail: 'Choose the account you want to fill. BOBO will not submit the form.',
          buttons: [...accounts.map(a => a.username.replace(/[\r\n\t&]/g, ' ').slice(0, 80)), 'Cancel'],
        });
        if (answer.response >= accounts.length || !stillPage(context) || !vault.enabled() || vault.blocked(context.origin)) return {};
        const account = vault.account(accounts[answer.response].id);
        // The invoke reply is delivered only to the original isolated preload/frame.
        return { username: account.username, password: account.password };
      }
      return {};
    } catch {
      if (context && busy.has(context.contents)) await reportError(context.window);
      return {};
    } finally { if (acquired) busy.delete(context.contents); }
  });

  // Registered through the browser's normal sender and page-role authorization.
  function registerSettings({ handle }) {
    handle('bobo:passwords:manage', async (value, event) => {
      const owner = ownerFor(event.sender);
      const frame = event.senderFrame;
      const op = value?.op;
      if (op === 'status') return vault.status();
      if (op === 'enable') {
        await vault.setEnabled(value.enabled);
        for (const contents of pending.keys()) clear(contents);
        grants.clear();
        return vault.status();
      }
      if (op === 'allow') { await vault.allow(value.origin); return vault.status(); }
      if (op === 'delete') {
        const answer = await message(owner.window, { message: 'Delete this saved account?', buttons: ['Delete', 'Cancel'] });
        if (answer.response === 0 && event.sender.mainFrame === frame) await vault.remove(value.id);
        return vault.status();
      }
      if (op === 'unlock') {
        if (busy.has(event.sender)) return { authenticated: false };
        busy.add(event.sender);
        try {
          const verified = await verifyUser();
          if (!verified || event.sender.isDestroyed() || event.sender.mainFrame !== frame ||
              event.sender.getURL() !== frame.url || owner.manager.activeWebContents() !== event.sender) return { authenticated: false };
          grants.set(event.sender, { frame, until: Date.now() + 30000 });
          if (!watchedSettings.has(event.sender)) {
            watchedSettings.add(event.sender);
            const revoke = () => grants.delete(event.sender);
            owner.window.on('blur', revoke);
            event.sender.on('blur', revoke);
            event.sender.on('did-start-navigation', revoke);
            event.sender.once('destroyed', () => { revoke(); owner.window.removeListener('blur', revoke); });
          }
          return { authenticated: true };
        } finally { busy.delete(event.sender); }
      }
      if (op === 'lock') { grants.delete(event.sender); return {}; }
      const grant = grants.get(event.sender);
      if (!grant || grant.frame !== frame || grant.until < Date.now() ||
          !owner.window.isFocused() || owner.manager.activeWebContents() !== event.sender) throw new Error('Verify your Windows identity first.');
      if (op === 'reveal') {
        const { id, origin, username, password } = vault.account(value.id);
        return { id, origin, username, password };
      }
      if (op === 'edit') {
        grants.delete(event.sender);
        await vault.edit(value.id, value.username, value.password);
        await dialog.showMessageBox(owner.window, { type: 'info', title: 'Password Updated',
          message: 'Your saved account has been updated.',
          detail: 'The changes have been saved to the encrypted password vault in this BOBO profile.',
          buttons: ['OK'], noLink: true });
        return vault.status();
      }
      throw new Error('Unknown password manager action.');
    });
  }
  return { registerSettings, vault };
}

module.exports = { createPasswordManager, verifyWindowsUser };
