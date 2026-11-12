'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function httpsOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('HTTPS required.');
  return url.origin;
}

function loginForm(value, origin) {
  if (!value || typeof value !== 'object') throw new Error('Invalid login form.');
  const { action, usernameField, passwordField } = value;
  const url = new URL(action);
  if (httpsOrigin(action) !== origin || url.search || url.hash ||
      typeof usernameField !== 'string' || !usernameField || usernameField.length > 256 ||
      typeof passwordField !== 'string' || !passwordField || passwordField.length > 256) {
    throw new Error('Invalid login form.');
  }
  return { action: url.origin + url.pathname, usernameField, passwordField };
}

function login(value) {
  const origin = httpsOrigin(value.origin);
  if (typeof value.username !== 'string' || !value.username || value.username.length > 512 ||
      typeof value.password !== 'string' || !value.password || value.password.length > 4096) {
    throw new Error('Invalid account.');
  }
  return { origin, username: value.username, password: value.password, form: loginForm(value.form, origin) };
}

function sameForm(a, b) {
  return a.action === b.action && a.usernameField === b.usernameField && a.passwordField === b.passwordField;
}

// The entire payload is OS-encrypted, including identifiers, origins and exclusions.
// No shared database, backup service, tool or AI module receives this service.
class PasswordVault {
  #state = { version: 1, enabled: false, accounts: [], never: [] };
  #tail = Promise.resolve();
  constructor({ directory, safeStorage, platform = process.platform, disabled = false }) {
    this.file = path.join(directory, 'bobo-passwords.vault');
    this.storage = safeStorage;
    this.platform = platform;
    this.disabled = disabled;
    this.available = false;
    this.failed = false;
  }
  async open() {
    try {
      this.available = this.platform === 'win32' && !this.disabled &&
        await this.storage.isAsyncEncryptionAvailable();
      if (!this.available) return;
      let encrypted;
      try { encrypted = fs.readFileSync(this.file); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      if (encrypted.length > 16 * 1024 * 1024) throw new Error();
      const { result } = await this.storage.decryptStringAsync(encrypted);
      const state = JSON.parse(result);
      if (state.version !== 1 || typeof state.enabled !== 'boolean' || !Array.isArray(state.accounts) ||
          state.accounts.length > 1000 || !Array.isArray(state.never) || state.never.length > 1000) throw new Error();
      for (const account of state.accounts) {
        login(account);
        if (typeof account.id !== 'string' || !/^[\da-f-]{36}$/.test(account.id)) throw new Error();
      }
      if (new Set(state.accounts.map(a => a.id)).size !== state.accounts.length) throw new Error();
      for (const origin of state.never) if (httpsOrigin(origin) !== origin) throw new Error();
      this.#state = state;
    } catch {
      // Preserve unreadable ciphertext. Never replace a damaged or foreign-user vault.
      this.failed = true;
      this.available = false;
    }
  }
  status() {
    return { available: this.available, enabled: this.available && this.#state.enabled,
      failed: this.failed, accounts: this.#state.accounts.map(({ id, origin }, i) =>
        ({ id, origin, label: `Account ${i + 1}` })), never: [...this.#state.never] };
  }
  enabled() { return this.available && this.#state.enabled; }
  blocked(origin) { return !this.enabled() || this.#state.never.includes(httpsOrigin(origin)); }
  matching(origin, form) {
    if (this.blocked(origin)) return [];
    const valid = loginForm(form, httpsOrigin(origin));
    return this.#state.accounts.filter(a => a.origin === origin && sameForm(a.form, valid))
      .map(a => ({ id: a.id, username: a.username }));
  }
  account(id) {
    if (!this.available) throw new Error('Password vault unavailable.');
    const account = this.#state.accounts.find(a => a.id === id);
    if (!account) throw new Error('Account no longer exists.');
    return { ...account, form: { ...account.form } };
  }
  #change(change) {
    const task = this.#tail.then(async () => {
      if (!this.available) throw new Error('Password vault unavailable; existing data has been preserved.');
      const next = structuredClone(this.#state);
      const result = change(next);
      const encrypted = await this.storage.encryptStringAsync(JSON.stringify(next));
      const temporary = this.file + '.' + randomUUID() + '.tmp';
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(temporary, encrypted, { flag: 'wx', mode: 0o600, flush: true });
        fs.renameSync(temporary, this.file);
        this.#state = next;
        return result;
      } finally {
        try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw new Error('Could not clean password vault staging file.'); }
      }
    });
    this.#tail = task.catch(() => {});
    return task.catch(() => { throw new Error('Could not update password vault; please try again.'); });
  }
  setEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw new Error('Invalid setting.');
    return this.#change(s => { s.enabled = enabled; });
  }
  save(value, consent) {
    if (consent !== true || !this.enabled()) throw new Error('Explicit consent required.');
    const account = login(value);
    return this.#change(s => {
      if (!s.enabled || s.never.includes(account.origin)) throw new Error();
      const old = s.accounts.find(a => a.origin === account.origin && a.username === account.username && sameForm(a.form, account.form));
      if (old) Object.assign(old, account);
      else {
        if (s.accounts.length >= 1000) throw new Error();
        s.accounts.push({ id: randomUUID(), ...account });
      }
    });
  }
  edit(id, username, password) {
    const account = login({ ...this.account(id), username, password });
    return this.#change(s => {
      const target = s.accounts.find(a => a.id === id);
      if (!target) throw new Error();
      if (s.accounts.some(a => a.id !== id && a.origin === account.origin && a.username === username && sameForm(a.form, account.form))) throw new Error();
      Object.assign(target, account);
    });
  }
  remove(id) { return this.#change(s => { s.accounts = s.accounts.filter(a => a.id !== id); }); }
  never(origin) {
    const valid = httpsOrigin(origin);
    return this.#change(s => {
      if (!s.never.includes(valid)) {
        if (s.never.length >= 1000) throw new Error();
        s.never.push(valid);
      }
    });
  }
  allow(origin) { const valid = httpsOrigin(origin); return this.#change(s => { s.never = s.never.filter(o => o !== valid); }); }
}

module.exports = { PasswordVault, httpsOrigin, loginForm, sameForm,
  createPasswordManager: options => require('./service').createPasswordManager(options) };
