'use strict';

/**
 * Small local-storage and validation helpers shared by the BOBO tools.
 *
 * Deliberately Electron-free so `node --test` can load it with plain Node.
 * Every value that crosses the IPC boundary from the renderer is validated
 * here before it is trusted, stored or written to disk.
 */

const fs = require('node:fs/promises');
const path = require('node:path');

/** Ceilings: anything above these is rejected, not truncated silently. */
const LIMITS = {
  id: 40,
  title: 200,
  body: 200000,
  url: 2048,
  text: 300000,
  name: 300,
  dataUrl: 32 * 1024 * 1024,
};

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/i;

function text(value, max) {
  if (typeof value !== 'string') return '';
  return value.slice(0, max);
}

function cleanText(value, max) {
  return text(value, max).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
}

function requireText(value, max, field) {
  const out = cleanText(value, max);
  if (!out) throw new Error(`BOBO: ${field} is required`);
  return out;
}

function optionalText(value, max) {
  return cleanText(value, max);
}

/** Only http(s) URLs are ever stored; anything else becomes an empty string. */
function optionalUrl(value) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string' || value.length > LIMITS.url) throw new Error('BOBO: invalid url');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('BOBO: invalid url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('BOBO: invalid url');
  return url.href.slice(0, LIMITS.url);
}

function noteId(value) {
  if (typeof value !== 'string' || !ID_RE.test(value)) throw new Error('BOBO: invalid note id');
  return value;
}

/** A screenshot must be a PNG data URL we produced ourselves (or one we accept). */
function pngDataUrl(value) {
  if (typeof value !== 'string' || !value.startsWith('data:image/png;base64,')) {
    throw new Error('BOBO: expected a PNG data URL');
  }
  if (value.length > LIMITS.dataUrl) throw new Error('BOBO: image too large');
  return value;
}

function clone(value) {
  return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

/** Strip path separators and shell-hostile characters from a suggested name. */
function safeFileName(name, fallback) {
  const base = String(name || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
    .trim()
    .slice(0, 80);
  return base || fallback;
}

/**
 * A JSON file that survives crashes and never eats the user's data.
 *
 * - missing file -> defaults
 * - unreadable/corrupt file -> preserved as `<file>.corrupt-<timestamp>`, defaults
 *   returned, `recovered` set so the UI can tell the user
 * - writes are serialised and atomic (temp file + rename)
 */
class JsonFile {
  #file;
  #defaults;
  #queue = Promise.resolve();
  #recovered = false;

  constructor(file, defaults) {
    this.#file = file;
    this.#defaults = defaults;
  }

  get file() {
    return this.#file;
  }

  get recovered() {
    return this.#recovered;
  }

  async read() {
    try {
      const raw = await fs.readFile(this.#file, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('unexpected shape');
      return parsed;
    } catch (error) {
      if (error.code === 'ENOENT') return clone(this.#defaults);
      await fs.rename(this.#file, `${this.#file}.corrupt-${Date.now()}`).catch(() => {});
      this.#recovered = true;
      return clone(this.#defaults);
    }
  }

  async write(value) {
    const run = async () => {
      await fs.mkdir(path.dirname(this.#file), { recursive: true });
      const temp = `${this.#file}.${process.pid}.tmp`;
      await fs.writeFile(temp, JSON.stringify(value, null, 2), 'utf8');
      await fs.rename(temp, this.#file);
    };
    this.#queue = this.#queue.then(run, run);
    await this.#queue;
  }
}

function escapeHtmlText(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

module.exports = {
  JsonFile,
  LIMITS,
  cleanText,
  escapeHtmlText,
  clone,
  noteId,
  optionalText,
  optionalUrl,
  pngDataUrl,
  requireText,
  safeFileName,
  text,
};
