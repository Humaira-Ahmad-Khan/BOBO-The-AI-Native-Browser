'use strict';

/**
 * Download metadata and controls.
 *
 * Only metadata is stored - never file contents. Nothing is ever executed:
 * "Open" and "Show in folder" are explicit user actions, and a dangerous file
 * type is flagged in the UI and forced through the OS save dialog.
 *
 * The service is Electron-free; `attachDownloads` is the only part that talks
 * to a real session, so tests can drive the record/control logic directly.
 */

const fs = require('node:fs');
const path = require('node:path');
const { cleanText, optionalUrl, safeFileName } = require('./tools/lib');

const DANGEROUS_EXTENSIONS = new Set([
  'exe', 'msi', 'msp', 'bat', 'cmd', 'com', 'cpl', 'scr', 'pif', 'hta',
  'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'reg', 'jar',
  'dll', 'sys', 'lnk', 'iso', 'img', 'apk', 'msix', 'appx', 'appxbundle',
]);

const ACTIVE_STATES = new Set(['progressing', 'paused']);

function reserveDownloadPath(directory, filename) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
    throw new Error('BOBO: invalid download directory');
  }
  const root = fs.realpathSync(directory);
  const clean = safeFileName(filename, 'download').replace(/[. ]+$/, '') || 'download';
  const name = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$) *(?:\.|$)/i.test(clean)
    ? `_${clean}` : clean;
  const extension = path.extname(name);
  const stem = name.slice(0, name.length - extension.length);
  for (let index = 0; index < 10000; index += 1) {
    const candidate = path.join(root, index ? `${stem} (${index})${extension}` : name);
    try {
      fs.closeSync(fs.openSync(candidate, 'wx'));
      return candidate;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('BOBO: no available download filename');
}

function isDangerous(filename) {
  const name = String(filename || '').trim().toLowerCase().replace(/[. ]+$/, '');
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  return DANGEROUS_EXTENSIONS.has(ext);
}

function rowToDownload(row, live) {
  const base = {
    id: row.id,
    url: row.url,
    filename: row.filename,
    path: row.path,
    state: row.state,
    received: row.bytes_received,
    total: row.total_bytes,
    danger: row.danger === 1,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
  };
  if (!live) return base;
  return {
    ...base,
    state: live.state,
    canPause: typeof live.item?.pause === 'function',
    received: live.received,
    total: live.total || base.total,
    path: live.path || base.path,
  };
}

class DownloadsService {
  #store;
  #now;
  #live = new Map();

  constructor({ store, now = () => Date.now() }) {
    this.#store = store;
    this.#now = now;
  }

  #db() {
    return this.#store.open();
  }

  #row(id) {
    return this.#db().prepare('SELECT * FROM downloads WHERE id = ?').get(id) || null;
  }

  start(payload = {}) {
    const url = optionalUrl(payload.url);
    if (!url) throw new Error('BOBO: a download needs an http(s) URL');
    const filename = safeFileName(cleanText(payload.filename, 260), 'download');
    const total = Math.max(0, Math.round(Number(payload.totalBytes) || 0));
    const danger = isDangerous(payload.filename) || isDangerous(filename) ? 1 : 0;
    const result = this.#db()
      .prepare(
        `INSERT INTO downloads (url, filename, path, state, bytes_received, total_bytes, danger, started_at)
         VALUES (?, ?, '', 'progressing', 0, ?, ?, ?)`
      )
      .run(url, filename, total, danger, this.#now());
    return rowToDownload(this.#row(Number(result.lastInsertRowid)));
  }

  /** Attach a live Electron DownloadItem to its database row. */
  bind(id, item) {
    const row = this.#row(id);
    if (!row) return;
    this.#live.set(id, {
      item,
      state: 'progressing',
      received: 0,
      total: row.total_bytes,
      path: '',
    });
  }

  unbind(id) {
    this.#live.delete(id);
  }

  updateLive(id, patch = {}) {
    const live = this.#live.get(id);
    if (!live) return;
    if (patch.state) live.state = patch.state;
    if (Number.isFinite(Number(patch.received))) live.received = Math.max(0, Number(patch.received));
    if (Number.isFinite(Number(patch.total))) live.total = Math.max(0, Number(patch.total));
    if (typeof patch.path === 'string') live.path = patch.path;

    // Persist only pauses/resumes, not every progress tick (that would hammer
    // the database for no benefit; a crash is reconciled as interrupted).
    if (patch.persist) {
      this.#db()
        .prepare('UPDATE downloads SET state = ?, bytes_received = ?, total_bytes = ?, path = ? WHERE id = ?')
        .run(live.state, live.received, live.total, live.path, id);
    }
  }

  finish(id, payload = {}) {
    const live = this.#live.get(id);
    const state = ['completed', 'cancelled', 'interrupted'].includes(payload.state)
      ? payload.state
      : 'interrupted';
    const filePath = typeof payload.path === 'string' && payload.path ? payload.path : live?.path || '';
    const error = cleanText(payload.error, 500);
    const received = Math.max(0, Number(payload.received) || live?.received || 0);
    this.#db()
      .prepare(
        'UPDATE downloads SET state = ?, path = ?, bytes_received = ?, finished_at = ?, error = ?, filename = COALESCE(?, filename) WHERE id = ?'
      )
      .run(state, filePath, received, this.#now(), error, payload.filename || null, id);
    this.#live.delete(id);
    return this.#row(id) ? rowToDownload(this.#row(id)) : null;
  }

  list() {
    const rows = this.#db().prepare('SELECT * FROM downloads ORDER BY started_at DESC, id DESC LIMIT 300').all();
    return rows.map((row) => rowToDownload(row, this.#live.get(row.id)));
  }

  get(id) {
    const row = this.#row(Number(id));
    return row ? rowToDownload(row, this.#live.get(row.id)) : null;
  }

  remove(payload = {}) {
    const id = Number(payload.id ?? payload);
    if (!Number.isInteger(id) || id < 1) throw new Error('BOBO: invalid download id');
    if (this.#live.has(id)) throw new Error('BOBO: cancel this download before removing it');
    const result = this.#db().prepare('DELETE FROM downloads WHERE id = ?').run(id);
    return { ok: true, removed: Number(result.changes) };
  }

  clear() {
    const result = this.#db().prepare('DELETE FROM downloads').run();
    return { ok: true, removed: Number(result.changes) };
  }

  /** Downloads left running by a previous process are dead, not progressing. */
  reconcile() {
    const result = this.#db()
      .prepare("UPDATE downloads SET state = 'interrupted', error = 'BOBO closed before this download finished' WHERE state IN ('progressing','paused')")
      .run();
    return { ok: true, updated: Number(result.changes) };
  }

  pause(id) {
    const live = this.#live.get(Number(id));
    if (!live || !live.item || typeof live.item.pause !== 'function') return { ok: false };
    live.item.pause();
    live.state = 'paused';
    this.updateLive(Number(id), { persist: true });
    return { ok: true, state: 'paused' };
  }

  resume(id) {
    const live = this.#live.get(Number(id));
    if (!live || !live.item || typeof live.item.resume !== 'function') return { ok: false };
    live.item.resume();
    live.state = 'progressing';
    this.updateLive(Number(id), { persist: true });
    return { ok: true, state: 'progressing' };
  }

  cancel(id) {
    const live = this.#live.get(Number(id));
    if (!live || !live.item || typeof live.item.cancel !== 'function') return { ok: false };
    live.item.cancel();
    return { ok: true };
  }

  async open(id) {
    const row = this.#row(Number(id));
    if (!row || row.state !== 'completed' || !row.path) throw new Error('BOBO: this file is not available');
    if (!fs.existsSync(row.path)) throw new Error('BOBO: the file is no longer at that location');
    const { shell } = require('electron');
    const error = await shell.openPath(row.path);
    if (error) throw new Error(`BOBO: ${error}`);
    return { ok: true };
  }

  showInFolder(id) {
    const row = this.#row(Number(id));
    if (!row || !row.path) throw new Error('BOBO: this file has no saved location');
    const { shell } = require('electron');
    shell.showItemInFolder(row.path);
    return { ok: true };
  }

  copyPath(id) {
    const row = this.#row(Number(id));
    if (!row || !row.path) throw new Error('BOBO: file path not available');
    const { clipboard } = require('electron');
    clipboard.writeText(row.path);
    return { ok: true, path: row.path };
  }

  recordInternalExport(payload = {}) {
    const filename = safeFileName(cleanText(payload.filename, 260), 'export');
    const filePath = typeof payload.filePath === 'string' ? payload.filePath : '';
    const total = Math.max(0, Math.round(Number(payload.totalBytes) || 0));
    const now = this.#now();
    const result = this.#db()
      .prepare(
        `INSERT INTO downloads (url, filename, path, state, bytes_received, total_bytes, danger, started_at, finished_at)
         VALUES (?, ?, ?, 'completed', ?, ?, 0, ?, ?)`
      )
      .run('bobo://export', filename, filePath, total, total, now, now);
    return rowToDownload(this.#row(Number(result.lastInsertRowid)));
  }
}

/**
 * Wire a real Electron session to the metadata service.
 *
 * Prefs: { ask: boolean, directory: string }. When "ask" is on (or the file is
 * dangerous) no save path is set, so Chromium shows its own save dialog.
 */
const managedDownloadContents = new WeakSet();

function attachDownloads({ session, service, getPrefs, onChange }) {
  session.on('will-download', (_event, item, contents) => {
    if (contents && managedDownloadContents.has(contents)) return;
    const prefs = getPrefs() || {};
    let record;
    try {
      record = service.start({
        url: item.getURL(),
        filename: item.getFilename(),
        totalBytes: item.getTotalBytes(),
      });
    } catch {
      return; // Not an http(s) download (e.g. blob:): Chromium handles it.
    }

    if (!prefs.ask && !record.danger && prefs.directory) {
      try {
        item.setSavePath(reserveDownloadPath(prefs.directory, item.getFilename()));
      } catch {
        // Leave destination selection to Chromium if the automatic path is unavailable.
      }
    }

    service.bind(record.id, item);

    item.on('updated', (_e, state) => {
      service.updateLive(record.id, {
        state: item.isPaused() ? 'paused' : state === 'interrupted' ? 'paused' : 'progressing',
        received: item.getReceivedBytes(),
        total: item.getTotalBytes(),
        path: item.getSavePath(),
        persist: state !== 'progressing',
      });
      onChange?.();
    });

    item.on('done', (_e, state) => {
      const savePath = item.getSavePath();
      service.finish(record.id, {
        state,
        path: savePath,
        filename: savePath ? path.basename(savePath) : undefined,
        received: item.getReceivedBytes(),
        error: state === 'interrupted' ? 'The download was interrupted.' : '',
      });
      onChange?.();
    });
  });
}

module.exports = {
  ACTIVE_STATES,
  DANGEROUS_EXTENSIONS,
  DownloadsService,
  attachDownloads,
  isDangerous,
  reserveDownloadPath,
  managedDownloadContents,
};
