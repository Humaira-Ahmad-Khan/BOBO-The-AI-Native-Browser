'use strict';

/**
 * IPC surface for browser data: bookmarks, history, downloads, browser
 * settings and privacy clearing.
 *
 * Registered through main.js's sender-validated `handle` wrapper, so a remote
 * website can no more read bookmarks than it can capture a screenshot. IDs and
 * payloads are validated by the services before any SQL runs.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { app, dialog, session } = require('electron');
const { safeFileName } = require('./tools/lib');

const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

function resolveDirectory(prefs) {
  return prefs.directory || app.getPath('downloads');
}

function confirm(win, options) {
  return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
}

function registerBrowserIpc({ handle, services, settings, getWindow, emit, onPrivacyCleared }) {
  const { bookmarks, history, downloads, sessions, store } = services;

  // --- bookmarks -----------------------------------------------------------

  const list = () => ({ ...bookmarks.list(), storage: store.file, recovered: store.recovered });
  const changed = () => emit('bobo:bookmarks', list());

  handle('bobo:bookmarks:list', list);
  handle('bobo:bookmarks:favourites', () => bookmarks.favourites());
  handle('bobo:bookmarks:find', (payload) => bookmarks.findByUrl(payload && payload.url));
  handle('bobo:bookmarks:toggle', (payload) => {
    const result = bookmarks.toggle(payload || {});
    changed();
    return result;
  });
  handle('bobo:bookmarks:add', (payload) => {
    const bookmark = bookmarks.add(payload || {});
    changed();
    return bookmark;
  });
  handle('bobo:bookmarks:update', (payload) => {
    const bookmark = bookmarks.update(payload || {});
    changed();
    return bookmark;
  });
  handle('bobo:bookmarks:remove', (payload) => {
    const result = bookmarks.remove(payload || {});
    changed();
    return result;
  });
  handle('bobo:bookmarks:folder:add', (payload) => {
    const folder = bookmarks.addFolder(payload || {});
    changed();
    return folder;
  });
  handle('bobo:bookmarks:folder:rename', (payload) => {
    const folder = bookmarks.renameFolder(payload || {});
    changed();
    return folder;
  });
  handle('bobo:bookmarks:folder:remove', (payload) => {
    const result = bookmarks.removeFolder(payload || {});
    changed();
    return result;
  });

  handle('bobo:bookmarks:import', async () => {
    const win = getWindow();
    const options = {
      title: 'Import Bookmarks & Favourites',
      filters: [{ name: 'Bookmark HTML', extensions: ['html', 'htm'] }],
      properties: ['openFile'],
    };
    const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    const file = picked && !picked.canceled ? picked.filePaths[0] : '';
    if (!file) return { ok: true, canceled: true };

    const info = await fs.stat(file);
    if (info.size > MAX_IMPORT_BYTES) throw new Error('BOBO: that bookmark file is too large');

    const html = await fs.readFile(file, 'utf8');
    const preview = bookmarks.previewImport(html);
    const answer = await confirm(win, {
      type: 'question',
      title: 'Import Bookmarks & Favourites',
      message: path.basename(file),
      detail: `${preview.bookmarks} valid bookmarks, ${preview.folders} folders, ${preview.invalid} invalid entries, ${preview.duplicates} duplicates. Import skips duplicates. Import and Match Order also puts matching items in the same folder in the order shown in the export.`,
      buttons: ['Cancel', 'Import', 'Import and Match Order'],
      defaultId: 0,
      cancelId: 0,
    });
    if (answer.response !== 1 && answer.response !== 2) return { ok: true, canceled: true };
    const result = bookmarks.importHtml({ html, matchOrder: answer.response === 2 });
    changed();
    return { ...result, file };
  });

  handle('bobo:bookmarks:export', async () => {
    const { html } = bookmarks.exportHtml();
    const win = getWindow();
    const options = {
      title: 'Export BOBO bookmarks',
      defaultPath: path.join(app.getPath('downloads'), safeFileName('bobo-bookmarks.html', 'bobo-bookmarks.html')),
      filters: [{ name: 'Bookmark HTML', extensions: ['html'] }],
    };
    const picked = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (!picked || picked.canceled || !picked.filePath) return { ok: true, canceled: true };
    await fs.writeFile(picked.filePath, html, 'utf8');
    return { ok: true, path: picked.filePath };
  });

  handle('bobo:bookmarks:clear', async () => {
    const answer = await confirm(getWindow(), {
      type: 'warning',
      buttons: ['Cancel', 'Delete bookmarks'],
      defaultId: 0,
      cancelId: 0,
      message: 'Delete every bookmark and folder?',
      detail: 'The Bookmarks bar and Other bookmarks stay, but everything inside them is removed. This cannot be undone.',
    });
    if (answer.response !== 1) return { ok: true, canceled: true };
    const result = bookmarks.clear();
    changed();
    return result;
  });

  // --- history -------------------------------------------------------------

  handle('bobo:history:list', (payload) => ({ ...history.list(payload || {}), storage: store.file }));
  handle('bobo:history:remove', (payload) => {
    const result = history.remove(payload || {});
    emit('bobo:history', { removed: result.removed });
    return result;
  });
  handle('bobo:history:clear', async (payload) => {
    const range = payload?.range;
    if (!['hour', 'day', 'week', 'month', 'all'].includes(range)) throw new Error('BOBO: unknown history range');
    const label = range === 'all' ? 'all browsing history' : `history from the last ${range === 'month' ? '4 weeks' : range}`;
    const answer = await confirm(getWindow(), {
      type: 'warning',
      buttons: ['Cancel', 'Clear history'],
      defaultId: 0,
      cancelId: 0,
      message: `Clear ${label}?`,
      detail: 'This removes browsing history only. Bookmarks, downloads, cookies, cache and site storage are kept.',
    });
    if (answer.response !== 1) return { ok: true, canceled: true };
    const result = history.clear({ range });
    emit('bobo:history', { cleared: result.removed });
    return result;
  });

  // --- downloads -----------------------------------------------------------

  let prefs = { ask: true, directory: '' };
  const ready = settings
    .state()
    .then((state) => {
      prefs = state.browser.downloads;
    })
    .catch(() => {});

  const downloadsChanged = () => emit('bobo:downloads', downloads.list());

  handle('bobo:downloads:list', () => downloads.list());
  handle('bobo:downloads:prefs', () => ({
    ask: prefs.ask,
    directory: resolveDirectory(prefs),
    chosen: prefs.directory,
  }));
  handle('bobo:downloads:pause', (payload) => downloads.pause(payload && payload.id));
  handle('bobo:downloads:resume', (payload) => downloads.resume(payload && payload.id));
  handle('bobo:downloads:cancel', (payload) => downloads.cancel(payload && payload.id));
  handle('bobo:downloads:remove', (payload) => {
    const result = downloads.remove(payload || {});
    downloadsChanged();
    return result;
  });
  handle('bobo:downloads:clear', () => {
    const result = downloads.clear();
    downloadsChanged();
    return result;
  });
  handle('bobo:downloads:open', (payload) => downloads.open(payload && payload.id));
  handle('bobo:downloads:show', (payload) => downloads.showInFolder(payload && payload.id));
  handle('bobo:downloads:copy-path', (payload) => downloads.copyPath(payload && payload.id));

  handle('bobo:downloads:choose-folder', async () => {
    const win = getWindow();
    const options = {
      title: 'Choose the BOBO download folder',
      defaultPath: resolveDirectory(prefs),
      properties: ['openDirectory', 'createDirectory'],
    };
    const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    const directory = picked && !picked.canceled ? picked.filePaths[0] : '';
    return { ok: true, canceled: !directory, directory };
  });

  // --- browser settings ----------------------------------------------------

  handle('bobo:settings:browser', async () => (await settings.state()).browser);

  handle('bobo:settings:set-browser', async (payload) => {
    const state = await settings.setBrowserPrefs(payload || {});
    prefs = state.browser.downloads;
    emit('bobo:settings', { browser: state.browser });
    return state;
  });

  // --- privacy -------------------------------------------------------------

  handle('bobo:privacy:clear', async (payload) => {
    const what = payload && payload.what === 'cache' ? 'cache' : payload && payload.what === 'all' ? 'all' : 'cookies';
    const answer = await confirm(getWindow(), {
      type: 'warning',
      buttons: ['Cancel', 'Clear'],
      defaultId: 0,
      cancelId: 0,
      message:
        what === 'cache'
          ? 'Clear the page cache?'
          : what === 'all'
            ? 'Clear cookies, site data and the cache?'
            : 'Clear cookies and site data?',
      detail:
        what === 'cache'
          ? 'Pages will reload from the network. You stay signed in.'
          : 'Every website will forget you, including sites you are signed into now. BOBO cannot undo this.',
    });
    if (answer.response !== 1) return { ok: true, canceled: true };

    const target = session.defaultSession;
    if (what !== 'cache') await target.clearStorageData();
    if (what !== 'cookies') await target.clearCache();
    onPrivacyCleared?.();
    return { ok: true, cleared: what };
  });

  return {
    downloadsChanged,
    getDownloadPrefs: () => ({ ask: prefs.ask, directory: resolveDirectory(prefs) }),
    ready,
    sessionState: () => sessions.read(),
  };
}

module.exports = { registerBrowserIpc };
