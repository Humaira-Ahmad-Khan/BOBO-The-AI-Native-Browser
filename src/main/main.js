'use strict';

/**
 * BOBO main process entry point.
 *
 * Owns the window, the IPC boundary and the chrome <-> tab wiring. Every IPC
 * message is sender-validated (src/main/security.js) and payload-validated here.
 */

const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { fileURLToPath } = require('node:url');
const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, screen, session } = require('electron');
const { configureProfilePaths } = require('./profiles');
const { showProfilePicker } = require('./profile-picker');
let profileContext;
try { profileContext = configureProfilePaths(app); }
catch (error) {
  dialog.showErrorBox('BOBO Profiles', error.message);
  app.exit(1);
}
const { TabManager, NEWTAB_FILE } = require('./tabs');
const { createPasswordManager } = require('../features/password-manager');
const { MAX_WINDOWS, fitBounds } = require('./session-store');
const { MAX_INPUT, isAllowedNavigationUrl } = require('./navigation');
const { assertTrusted, authorizeChannel, hardenApp } = require('./security');
const { shortcutFromInput } = require('./shortcuts');
const { createToolServices } = require('./tools/service');
const { registerToolIpc } = require('./tools/ipc');
const { createBrowserServices } = require('./data');
const { databaseError } = require('./db');
const { makeBackup, restoreFromDialog } = require('./database-backup');
const RESTORE_DATABASE_FLAG = '--bobo-restore-database';
const { registerBrowserIpc } = require('./browser-ipc');
const { attachDownloads } = require('./downloads');
const { searchUrl } = require('./search');
const { SavedGroupsService, VALID_COLORS, savedGroupUrl } = require('./saved-groups');
const { publicGoogleApps } = require('./google-apps');
const { createNewTabService } = require('./newtab');
const { applyYouTubeTheme, isYouTube } = require('./youtube-theme');
const { createYouTubeShorts } = require('./youtube-shorts');
const { setYouTubeAutoSkip } = require('./tools/youtube-skip');
const { watchVideoDownloads } = require('./tools/video-download-overlay');
const { directVideoSource } = require('./tools/social-video');
const { alternateWatchUrl, setAlternateVideoClicks } = require('./tools/ad-free-youtube');
const { APP_ID, handleWindowsInstaller } = require('./windows-installer');

const PRELOAD = path.join(__dirname, '../preload/preload.js');
const CHROME_HTML = path.join(__dirname, '../renderer/index.html');

// Official branding, shipped inside the app package (dev and asar both resolve
// this relative path). The .ico is the Windows shell/taskbar icon.
const APP_ICON = path.join(__dirname, '../assets/logo/BOBO_Arctic_Frost/bobo.ico');

const THEMES = new Set(['dark', 'light']);

// Arctic Frost: Deep Navy chrome in dark mode, Snow White in light mode.
const TITLE_BAR = {
  dark: { color: '#192734', symbolColor: '#a8c4d4', height: 40 },
  light: { color: '#eef6fb', symbolColor: '#192734', height: 40 },
};

/** @type {BrowserWindow|null} */
let win = null;
/** @type {TabManager|null} */
let tabs = null;
const findWindows = new WeakSet();
/** @type {ReturnType<typeof createToolServices>|null} */
let tools = null;
/** @type {ReturnType<typeof createBrowserServices>|null} */
let data = null;
/** @type {ReturnType<typeof registerBrowserIpc>|null} */
let browserIpc = null;
/** @type {SavedGroupsService|null} */
let savedGroups = null;
let savedGroupsShortcut = '';
const tabWindows = new Map();
let youtubeTheme = 'default';
const youtubeShorts = createYouTubeShorts({ ipcMain, ownerFor: tabWindowFor });
// Read only from our isolated YouTube preload. Reply without disk or network work.
ipcMain.on('bobo:youtube:appearance', (event, value) => {
  const allowed = event.senderFrame === event.sender.mainFrame && isYouTube(event.senderFrame?.url);
  const mode = allowed ? youtubeTheme : 'default';
  event.returnValue = value?.channelShorts === true ? { mode, channelShorts: allowed } : mode;
});
let youtubeAutoSkip = false;
let downloadPlayerVideo;
let videoDownloadButtons = false;
let profilePicker = null;
let passwords = null;

function openProfilePicker() {
  if (profilePicker && !profilePicker.isDestroyed()) {
    profilePicker.focus();
    return;
  }
  profilePicker = showProfilePicker({
    app, BrowserWindow, ipcMain, profiles: profileContext.profiles, icon: APP_ICON,
  });
  profilePicker.on('closed', () => { profilePicker = null; });
}

function syncPlayerDownloadButton(contents) {
  return watchVideoDownloads(contents, () => {
    const owner = tabWindowFor(contents);
    return videoDownloadButtons && owner?.manager.activeWebContents() === contents ? owner.window : null;
  }, downloadPlayerVideo, videoDownloadButtons);
}
let alternateVideoClicks = false;

function updateAlternateVideoClicks(state) {
  alternateVideoClicks = state.browser.alternateYouTube === true &&
    state.tools.some((tool) => tool.id === 'ad-free-youtube' && tool.enabled);
  for (const manager of tabWindows.values()) {
    for (const tab of manager.snapshot().tabs) {
      void setAlternateVideoClicks(manager.webContentsForTab(tab.id), alternateVideoClicks).catch(() => {});
    }
  }
}

function tabWindowFor(contents) {
  for (const [window, manager] of tabWindows) {
    if (window.webContents === contents || manager.ownsContents(contents)) return { window, manager };
  }
  return null;
}

function watchYouTubeAutoSkip(contents, enabled) {
  return setYouTubeAutoSkip(contents, enabled, () => {
    const owner = tabWindowFor(contents);
    return owner?.window.isFocused() && owner.manager.activeWebContents() === contents;
  });
}

function savedKey(group) {
  return `${group.id}:${group.createdAt}`;
}

function savedGroupsChanged() {
  for (const manager of tabWindows.values()) manager.broadcast('bobo:saved-groups:changed');
}

function findOpenGroup(group) {
  for (const [window, manager] of tabWindows) {
    const live = manager.savedGroup(savedKey(group));
    if (live) return { window, manager, live };
  }
  return null;
}

function saveLiveGroup(manager, groupId, existing = null) {
  const live = manager.groupInfo(groupId);
  if (!live) throw new Error('This tab group is no longer open.');
  const snapshot = {
    name: live.name,
    color: VALID_COLORS.has(live.color) ? live.color : 'blue',
    tabs: manager.groupTabs(groupId).filter((tab) =>
      !tab.local && !tab.private && (!tab.view || tab.view.webContents.session.isPersistent())
    ),
  };
  if (existing) {
    const current = savedGroups.get(existing.id);
    if (!current || savedKey(current) !== savedKey(existing)) throw new Error('This saved group was deleted.');
    const open = findOpenGroup(current);
    if (open && (open.manager !== manager || open.live.id !== groupId)) {
      throw new Error('Switch to the open saved group before updating it.');
    }
  }
  const saved = existing ? savedGroups.update(existing.id, snapshot) : savedGroups.save(snapshot);
  manager.linkSavedGroup(groupId, savedKey(saved));
  savedGroupsChanged();
  return saved;
}
let theme = 'dark';
let sessionTimer = null;
let downloadsTimer = null;
/** Startup restore must not overwrite the file it is reading from. */
let restoring = false;
/** Set before the window tree is torn down so window 'closed' saves stay quiet. */
let quitting = false;

function broadcastBrowserData(channel, payload) {
  for (const [window, manager] of tabWindows) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
    manager.broadcast(channel, payload);
  }
}

function applyTheme(value) {
  theme = THEMES.has(value) ? value : 'dark';
  for (const [window, manager] of tabWindows) {
    if (window.isDestroyed()) continue;
    window.setTitleBarOverlay?.(TITLE_BAR[theme]);
    window.webContents.send('bobo:theme', theme);
    manager.broadcast('bobo:theme', theme);
  }
}

// --- session persistence ---------------------------------------------------
// Written shortly after the last tab change, and synchronously on close so an
// unexpected shutdown is distinguishable from a clean exit.

function windowSession(window, manager) {
  const state = manager.sessionState();
  let bounds = null;
  let maximized = false;
  try {
    if (!window.isDestroyed()) {
      maximized = window.isMaximized();
      bounds = maximized ? window.getNormalBounds() : window.getBounds();
    }
  } catch {
    // A half-destroyed window is simply saved without geometry.
  }
  return { ...state, bounds, maximized };
}

function saveSession({ cleanExit = false } = {}) {
  if (restoring || !data) return;
  try {
    const windows = [];
    for (const [window, manager] of tabWindows) {
      if (window.isDestroyed()) continue;
      windows.push(windowSession(window, manager));
    }
    data.sessions.write({ windows: windows.slice(0, MAX_WINDOWS) }, { cleanExit });
  } catch {
    // Losing session state must never block the browser from closing.
  }
}

function scheduleSessionSave() {
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => saveSession(), 400);
}

function scheduleDownloadsEvent() {
  if (downloadsTimer) return;
  downloadsTimer = setTimeout(() => {
    downloadsTimer = null;
    browserIpc?.downloadsChanged();
  }, 350);
}

function bookmarksChanged() {
  if (!data) return;
  const payload = { ...data.bookmarks.list(), storage: data.store.file, recovered: data.store.recovered };
  broadcastBrowserData('bobo:bookmarks', payload);
}

async function bookmarkAllTabs(window, manager) {
  const tabs = manager.snapshot().tabs.filter((tab) => !tab.isLocal && /^https?:\/\//i.test(tab.url));
  if (!tabs.length) return;
  const answer = await dialog.showMessageBox(window, {
    type: 'question', message: 'Bookmark all tabs in this window?',
    detail: 'BOBO will save the open webpages in a new folder on the bookmarks bar.',
    buttons: ['Cancel', 'Bookmark all tabs'], defaultId: 0, cancelId: 0,
  });
  if (answer.response !== 1 || window.isDestroyed()) return;
  data.store.transaction(() => {
    const folder = data.bookmarks.addFolder({ name: 'Bookmarked tabs' });
    const seen = new Set();
    for (const tab of tabs) {
      if (seen.has(tab.url)) continue;
      data.bookmarks.add({ url: tab.url, title: tab.title, folderId: folder.id });
      seen.add(tab.url);
    }
  });
  bookmarksChanged();
}

// --- payload validation (the trust boundary is in security.js) -------------

function readTabId(payload) {
  const id = payload && payload.id;
  if (id == null) return null; // null/undefined means "the active tab"
  if (typeof id !== 'number' || !Number.isInteger(id) || id < 1) {
    throw new Error('BOBO: invalid tab id');
  }
  return id;
}

function readText(payload) {
  const text = payload && payload.text;
  if (typeof text !== 'string') throw new Error('BOBO: invalid input');
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > MAX_INPUT) throw new Error('BOBO: invalid input');
  return trimmed;
}

function readBounds(value) {
  if (!value || typeof value !== 'object') throw new Error('BOBO: invalid bounds');
  const numbers = ['x', 'y', 'width', 'height'].map((key) => Number(value[key]));
  if (numbers.some((n) => !Number.isFinite(n) || n < 0 || n > 100000)) {
    throw new Error('BOBO: invalid bounds');
  }
  return {
    x: Math.round(numbers[0]),
    y: Math.round(numbers[1]),
    width: Math.round(numbers[2]),
    height: Math.round(numbers[3]),
  };
}

function readUrlOption(payload) {
  const url = payload && payload.url;
  if (url == null) return undefined;
  if (typeof url !== 'string' || url.length > MAX_INPUT) throw new Error('BOBO: invalid url');
  return url;
}

// --- keyboard shortcuts ----------------------------------------------------
// Raised by Electron itself for every WebContents (chrome, new tab page, error
// page AND remote websites), so browser shortcuts work no matter what has
// focus - and no IPC path exists for a remote page to trigger them.

function wireShortcuts(contents) {
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;

    const owner = tabWindowFor(contents);
    if (!owner) return;
    const { window, manager } = owner;
    const combo = shortcutFromInput(input, savedGroupsShortcut);
    if (!combo) return;

    // Hold-to-repeat: fine for tab cycling, harmful for everything else
    // (Ctrl+W would shred an open session, Ctrl+T would spawn tabs).
    if (input.isAutoRepeat && combo !== 'next-tab' && combo !== 'prev-tab') {
      if (combo.startsWith('zoom-')) event.preventDefault();
      return;
    }

    // Escape stops loading - but not if the user is typing in the BOBO chrome
    // (address bar, search fields): there it belongs to the field, and a local
    // UI page is never "loading" in the first place.
    if (combo === 'stop') {
      if (findWindows.has(window) && contents !== window.webContents) {
        event.preventDefault();
        window.webContents.send('bobo:ui', 'find-close');
        return;
      }
      if (!manager.isLoading()) return;
      if (contents.getURL().startsWith('file://')) return;
    }

    event.preventDefault();
    if (combo === 'saved-groups') {
      tabWindowFor(contents)?.manager.openSettings('tabs');
      return;
    }
    handleShortcut(combo, owner);
  });
}

function handleShortcut(combo, { window: win, manager: tabs }) {
  switch (combo) {
    case 'new-tab':
      tabs.create();
      break;
    case 'close-tab':
      tabs.close(tabs.activeId());
      break;
    case 'reopen-tab':
      tabs.reopenClosed();
      break;
    case 'reload':
      tabs.reload();
      break;
    case 'stop':
      tabs.stop();
      break;
    case 'back':
      tabs.goBack();
      break;
    case 'forward':
      tabs.goForward();
      break;
    case 'next-tab':
      tabs.cycle(1);
      break;
    case 'prev-tab':
      tabs.cycle(-1);
      break;
    case 'focus-omnibox':
      win.webContents.send('bobo:ui', 'focus-omnibox');
      break;
    case 'bookmark-page':
      win.webContents.send('bobo:ui', 'bookmark-page');
      break;
    case 'bookmark-all-tabs':
      void bookmarkAllTabs(win, tabs).catch((error) => dialog.showErrorBox('BOBO Bookmarks', error.message));
      break;
    case 'history':
      tabs.openLibrary('history');
      break;
    case 'downloads':
      tabs.openLibrary('downloads');
      break;
    case 'bookmarks-manager':
      tabs.openLibrary('bookmarks');
      break;
    case 'toggle-bookmarks-bar':
      win.webContents.send('bobo:ui', 'toggle-bookmarks-bar');
      break;
    case 'new-window':
      createWindow();
      break;
    case 'new-private-window':
      win.webContents.send('bobo:ui', 'new-private-window');
      break;
    case 'print':
      tabs.print(tabs.activeId());
      break;
    case 'toggle-fullscreen':
      if (tabs.exitHtmlFullscreen()) break;
      if (win) win.setFullScreen(!win.isFullScreen());
      break;
    case 'zoom-in':
      tabs.zoomIn(tabs.activeId());
      break;
    case 'zoom-out':
      tabs.zoomOut(tabs.activeId());
      break;
    case 'zoom-reset':
      tabs.zoomReset(tabs.activeId());
      break;
    case 'clear-browsing-data':
      win.webContents.send('bobo:ui', 'clear-browsing-data');
      break;
    case 'tab-search':
      win.webContents.send('bobo:ui', 'tab-search');
      break;
    case 'find-in-page':
      win.webContents.send('bobo:ui', 'find-in-page');
      break;
    case 'find-next':
      win.webContents.send('bobo:ui', 'find-next');
      break;
    case 'find-prev':
      win.webContents.send('bobo:ui', 'find-prev');
      break;
    default:
      break;
  }
}

// --- IPC -------------------------------------------------------------------

function registerIpc() {
  const request = new AsyncLocalStorage();
  const ownTabs = () => request.getStore().manager;
  const ownWindow = () => request.getStore().window;
  const navigationTab = (payload, event) => {
    const id = readTabId(payload);
    if (event.sender === ownWindow().webContents) return id ?? ownTabs().activeId();
    const source = ownTabs().tabIdForContents(event.sender);
    if (source == null || (id != null && id !== source)) throw new Error('BOBO: tab ownership mismatch');
    return source;
  };
  const handle = (channel, run, { chromeOnly = false } = {}) => {
    ipcMain.handle(channel, (event, payload) => {
      assertTrusted(event); // throws -> rejected promise in the renderer
      const owner = tabWindowFor(event.sender);
      authorizeChannel(event, owner, channel);
      if (chromeOnly && event.sender !== owner.window.webContents) throw new Error('BOBO: browser chrome required');
      if (payload != null && (typeof payload !== 'object' || Object.getPrototypeOf(payload) !== Object.prototype)) {
        throw new Error('BOBO: invalid IPC payload');
      }
      const activeContents = owner.manager.activeWebContents();
      return request.run({ ...owner, activeContents }, async () => {
        try { return await run(payload, event); }
        catch (error) {
          if (error?.code === 'ERR_SQLITE_ERROR' || error?.errcode) throw databaseError(error);
          throw error;
        }
      });
    });
  };

  handle('bobo:get-state', (_payload, event) => ({
    tabs: managerFor(event).snapshot(), theme,
    profile: profileContext.profiles.list().find(({ id }) => id === profileContext.id),
  }));
  handle('bobo:profiles:choose', () => openProfilePicker(), { chromeOnly: true });
  handle('bobo:newtab:shortcut-icon', async (payload) => {
    if (typeof payload?.origin !== 'string' || payload.origin.length > 512) return null;
    const manager = ownTabs();
    for (const tab of manager.snapshot().tabs) {
      if (tab.isLocal || !tab.favicon) continue;
      try {
        const site = new URL(tab.url);
        const icon = new URL(tab.favicon);
        if (site.origin !== payload.origin || icon.origin !== site.origin ||
            site.protocol !== 'https:' || icon.username || icon.password) continue;
        const contents = manager.webContentsForTab(tab.id);
        if (!contents || contents.isDestroyed()) continue;
        const response = await contents.session.fetch(icon.href, {
          credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(2500),
        });
        const mime = response.headers.get('content-type')?.split(';')[0].trim();
        if (!response.ok || !response.body ||
            !['image/png', 'image/jpeg', 'image/webp', 'image/x-icon', 'image/vnd.microsoft.icon'].includes(mime)) {
          await response.body?.cancel();
          continue;
        }
        const chunks = [];
        let size = 0;
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > 65536) return null;
          chunks.push(chunk);
        }
        return `data:${mime};base64,${Buffer.concat(chunks).toString('base64')}`;
      } catch {}
    }
    return null;
  });
  handle('bobo:youtube:auto-skip', async (payload) => {
    if (typeof payload?.enabled !== 'boolean') throw new Error('BOBO: invalid auto-skip setting');
    const result = await tools.settings.setBrowserPrefs({ youtubeAutoSkip: payload.enabled });
    youtubeAutoSkip = result.browser.youtubeAutoSkip;
    for (const manager of tabWindows.values()) {
      for (const tab of manager.snapshot().tabs) {
        void watchYouTubeAutoSkip(manager.webContentsForTab(tab.id), youtubeAutoSkip).catch(() => {});
      }
      manager.broadcast('bobo:settings', result);
    }
    return youtubeAutoSkip;
  });
  handle('bobo:youtube:theme', async (payload) => {
    const mode = payload?.mode;
    const contents = request.getStore().activeContents;
    if (!['dark', 'light', 'default'].includes(mode) || !contents ||
        contents.isDestroyed() || !isYouTube(contents.getURL())) {
      throw new Error('BOBO: select a theme on a YouTube tab');
    }
    if (!await applyYouTubeTheme(contents, mode)) {
      throw new Error('BOBO could not verify this YouTube layout. Use Appearance in the YouTube menu.');
    }
    const result = await tools.settings.setBrowserPrefs({ youtubeTheme: mode });
    youtubeTheme = mode;
    for (const manager of tabWindows.values()) {
      for (const tab of manager.snapshot().tabs) {
        const other = manager.webContentsForTab(tab.id);
        if (other && isYouTube(other.getURL())) manager.setPageBackground(other, mode === 'dark' ? '#0f0f0f' : '#ffffff');
        if (other !== contents) void applyYouTubeTheme(other, mode).catch(() => {});
      }
      manager.broadcast('bobo:settings', result);
    }
    return mode;
  });

  handle('bobo:search:suggest', (payload) => {
    if (typeof payload?.query !== 'string' || payload.query.length > 200) {
      throw new Error('BOBO: invalid suggestion query');
    }
    const query = payload.query.trim();
    if (!query) return [];
    const bookmarks = data.bookmarks.suggest(query).map((entry) => ({ ...entry, kind: 'bookmark' }));
    const history = data.history.list({ query, limit: 32 }).entries
      .map(({ url, title }) => ({ url, title, kind: 'history' }));
    const seen = new Set();
    return [...bookmarks, ...history].filter(({ url }) => {
      if (seen.has(url)) return false;
      seen.add(url);
      return true;
    }).slice(0, 8);
  });

  handle('bobo:database:backup', async (payload) => {
    if (payload != null) throw new Error('BOBO: backup does not accept arguments');
    const choice = await dialog.showOpenDialog(ownWindow(), {
      title: 'Choose a folder for the unencrypted BOBO database backup',
      properties: ['openDirectory'],
    });
    if (choice.canceled || !choice.filePaths[0]) return { canceled: true };
    return makeBackup(data.store, choice.filePaths[0]);
  });

  let restoreRestartPending = false;
  handle('bobo:database:restart-to-restore', async (payload) => {
    if (payload != null) throw new Error('BOBO: restore does not accept arguments');
    if (restoreRestartPending) return;
    restoreRestartPending = true;
    let result;
    try {
      result = await dialog.showMessageBox(ownWindow(), {
        type: 'warning',
        message: 'Restart BOBO to restore a database backup?',
        detail: 'Restarting interrupts active downloads and tool jobs. After restart, choose the backup and confirm the replacement.',
        buttons: ['Cancel', 'Restart'],
        defaultId: 0,
        cancelId: 0,
      });
    } finally {
      restoreRestartPending = false;
    }
    if (result.response !== 1 || quitting) return;
    const args = process.argv.slice(1).filter((arg) => arg !== RESTORE_DATABASE_FLAG);
    app.relaunch({ args: [...args, RESTORE_DATABASE_FLAG] });
    app.quit();
  });

  handle('bobo:tabs:create', (payload) => ownTabs().create({ url: readUrlOption(payload) }));
  handle('bobo:tabs:close', (payload) => {
    ownTabs().close(readTabId(payload));
    return ownTabs().snapshot();
  });
  handle('bobo:tabs:select', (payload) => ownTabs().select(readTabId(payload)));

  handle('bobo:nav:input', async (payload, event) => {
    const id = navigationTab(payload, event);
    // Resolve with the engine the user picked, so address-bar and New Tab
    // searches always agree (Google by default).
    const engine = tools ? await tools.settings.searchEngine() : undefined;
    return ownTabs().navigate(id, readText(payload), searchUrl(engine));
  });
  handle('bobo:nav:back', (payload, event) => ownTabs().goBack(navigationTab(payload, event)));
  handle('bobo:nav:forward', (payload) => ownTabs().goForward(readTabId(payload)));
  handle('bobo:nav:reload', (payload) => ownTabs().reload(readTabId(payload)));
  handle('bobo:nav:stop', (payload) => ownTabs().stop(readTabId(payload)));
  handle('bobo:nav:home', (payload, event) => ownTabs().home(navigationTab(payload, event)));
  handle('bobo:nav:retry', (payload, event) => ownTabs().retry(navigationTab(payload, event)));

  handle('bobo:chrome:bounds', (payload, event) =>
    tabWindowFor(event.sender)?.manager.setBounds(readBounds(payload))
  );
  handle('bobo:ui:theme', (payload) => {
    applyTheme(payload && payload.theme);
    return theme;
  });

  // BOBO Tools. Registered through the same sender-validated wrapper, so a
  // remote page can no more capture a screen or read notes than it can open a tab.
  downloadPlayerVideo = registerToolIpc({
    handle,
    services: tools,
    downloads: data.downloads,
    downloadsChanged: scheduleDownloadsEvent,
    onToolConfigured: updateAlternateVideoClicks,
    getActiveWebContents: () => {
      const contents = request.getStore().activeContents;
      const manager = ownTabs();
      return manager.byId(manager.tabIdForContents(contents))?.page === 'settings' ? null : contents;
    },
    getToolTabContents: (event, id) => {
      const manager = managerFor(event);
      return manager.byId(id)?.page === 'settings' ? null : manager.webContentsForTab(id);
    },
    getWindow: ownWindow,
    recordDownload: (info) => {
      try {
        const item = data?.downloads?.recordInternalExport(info);
        if (item && ownWindow()?.webContents) {
          ownWindow().webContents.send('bobo:downloads', data.downloads.list());
        }
        return item;
      } catch {}
    },
  });

  // --- advanced tab management --------------------------------------------

  handle('bobo:tabs:pin', (payload) => ownTabs().pin(readTabId(payload)));
  handle('bobo:tabs:duplicate', (payload) => ownTabs().duplicate(readTabId(payload)));
  handle('bobo:tabs:mute', (payload) => ownTabs().mute(readTabId(payload)));
  handle('bobo:tabs:menu', (payload, event) => {
    const { manager, window } = tabWindowFor(event.sender);
    const info = manager.tabInfo(readTabId(payload));
    if (!info) return false;
    const groupOptions = manager.snapshot().groups.filter((group) => group.id !== info.groupId).map((group) => ({
      label: group.name,
      click: () => manager.setTabGroup(info.id, group.id),
    }));
    Menu.buildFromTemplate([
      { label: info.pinned ? 'Unpin tab' : 'Pin tab', click: () => manager.pin(info.id) },
      { label: 'Duplicate tab', click: () => manager.duplicate(info.id) },
      { label: 'Move tab to new window', click: () => detachTab(manager, info.id) },
      { label: 'Reopen closed tab', accelerator: 'Ctrl+Shift+T', enabled: manager.recentlyClosed().length > 0, click: () => manager.reopenClosed() },
      { label: info.muted ? 'Unmute tab' : 'Mute tab', click: () => manager.mute(info.id) },
      { label: 'Add tab to group', enabled: !info.pinned, submenu: [
        { label: 'New group', click: () => manager.createGroup({ name: info.title, tabIds: [info.id] }) },
        ...groupOptions,
      ] },
      { label: 'Remove Tab from Group', visible: Boolean(info.groupId), click: () => manager.setTabGroup(info.id, null) },
      { type: 'separator' },
      { label: 'Close tab', click: () => manager.close(info.id) },
    ]).popup({ window });
    return true;
  });
  handle('bobo:tabs:move', (payload) => {
    const index = Number(payload && payload.index);
    if (!Number.isInteger(index) || index < 0 || index > 500) throw new Error('BOBO: invalid tab position');
    return ownTabs().move(readTabId(payload), index);
  });
  handle('bobo:tabs:detach', (payload) => {
    const id = readTabId(payload);
    if (id == null || !ownTabs().tabInfo(id)) throw new Error('BOBO: unknown tab');
    return detachTab(ownTabs(), id);
  }, { chromeOnly: true });
  handle('bobo:tabs:closed-menu', () => {
    const manager = ownTabs();
    const entries = manager.recentlyClosed();
    Menu.buildFromTemplate(entries.length ? entries.map(entry => ({
      label: entry.title || entry.url, click: () => manager.reopenClosed(entry.id),
    })) : [{ label: 'No recently closed tabs', enabled: false }]).popup({ window: ownWindow() });
  }, { chromeOnly: true });
  // --- live tab groups ----------------------------------------------------
  handle('bobo:tabs:group:create', (payload, event) => managerFor(event).createGroup(payload || {}));
  handle('bobo:tabs:group:update', (payload, event) => managerFor(event).updateGroup(payload?.groupId, payload || {}));
  handle('bobo:tabs:group:toggle', (payload, event) => managerFor(event).toggleGroupCollapse(payload?.groupId));
  handle('bobo:tabs:group:ungroup', (payload, event) => managerFor(event).ungroup(payload?.groupId));
  handle('bobo:tabs:group:close', (payload, event) => managerFor(event).closeGroup(payload?.groupId));
  handle('bobo:tabs:group:set', (payload, event) => managerFor(event).setTabGroup(readTabId(payload), payload?.groupId || null));
  // --- saved tab groups ---------------------------------------------------
  function managerFor(event) {
    const owner = tabWindowFor(event.sender);
    if (owner) return owner.manager;
    throw new Error('BOBO: missing tab window');
  }
  const saveOptions = (manager, group) => {
    const collections = savedGroups.list();
    const linked = collections.find((saved) => savedKey(saved) === group.savedKey);
    const save = (existing) => {
      try {
        saveLiveGroup(manager, group.id, existing);
      } catch (error) {
        dialog.showErrorBox('Saved Groups', error.message);
      }
    };
    return [
      { label: linked ? 'Save as New Group' : 'Save Group', click: () => save() },
      { label: 'Update Saved Group', enabled: Boolean(linked), click: () => save(linked) },
      ...(!linked && collections.length ? [{
        label: 'Update Existing Group',
        submenu: collections.map((saved) => ({
          label: saved.name, enabled: !findOpenGroup(saved), click: () => save(saved),
        })),
      }] : []),
    ];
  };
  handle('bobo:tabs:group:menu', (payload, event) => {
    const { manager, window } = tabWindowFor(event.sender);
    const group = manager.groupInfo(payload?.groupId);
    if (!group) return;
    Menu.buildFromTemplate([
      ...saveOptions(manager, group),
      { label: 'Rename Group…', click: () => window.webContents.send('bobo:ui', {
        action: 'rename-group', groupId: group.id, name: group.name,
      }) },
      { label: 'Change Group Colour', submenu: [...VALID_COLORS].filter((color) => color !== 'gray').map((color) => ({
        label: color, type: 'radio', checked: group.color === color,
        click: () => manager.updateGroup(group.id, { color }),
      })) },
      { label: 'New Tab in Group', click: () => manager.create({ groupId: group.id }) },
      { label: 'Ungroup', click: () => manager.ungroup(group.id) },
      { label: 'Close Group', click: () => manager.closeGroup(group.id) },
    ]).popup({ window });
  });
  handle('bobo:tabs:group:save', (payload, event) => saveLiveGroup(managerFor(event), payload?.groupId));
  handle('bobo:tabs:group:saved-list', () => savedGroups.list().map(({ tabs: entries, ...group }) => ({
    ...group, open: Boolean(findOpenGroup(group)),
  })));
  handle('bobo:tabs:group:saved-delete', (payload) => {
    const deleted = savedGroups.delete(readTabId(payload));
    if (deleted) savedGroupsChanged();
    return deleted;
  });
  handle('bobo:tabs:group:saved-edit', (payload) => {
    const id = readTabId(payload);
    const group = savedGroups.update(id, { name: payload?.name, color: payload?.color });
    if (group) {
      const open = findOpenGroup(group);
      if (open) open.manager.updateGroup(open.live.id, { name: group.name, color: group.color });
      savedGroupsChanged();
    }
    return group;
  });
  handle('bobo:tabs:group:saved-update', (payload) => {
    const group = savedGroups.get(readTabId(payload));
    const open = group && findOpenGroup(group);
    if (!open) throw new Error('Open the group before updating its saved tabs.');
    return saveLiveGroup(open.manager, open.live.id, group);
  });
  handle('bobo:tabs:group:saved-duplicate', (payload) => {
    const group = savedGroups.get(readTabId(payload));
    if (!group) return null;
    const copy = savedGroups.save({ ...group, name: `${group.name.slice(0, 113)} (copy)` });
    savedGroupsChanged();
    return copy;
  });
  handle('bobo:tabs:group:saved-restore', (payload, event) => {
    const group = savedGroups.get(readTabId(payload));
    if (!group) return { status: 'missing' };
    const open = findOpenGroup(group);
    if (open) {
      if (payload?.switchExisting !== true) return { status: 'already-open' };
      open.manager.selectGroup(open.live.id);
      open.window.focus();
      return { status: 'switched' };
    }
    if (payload?.switchExisting === true) return { status: 'closed' };
    const urls = group.tabs.map(({ url }) => savedGroupUrl(url));
    if (!urls.length || urls.some((url) => !url)) return { status: 'unsafe' };
    const manager = managerFor(event);
    const tabIds = urls.map((url) => manager.create({ url, background: true }));
    const live = manager.createGroup({ name: group.name, color: group.color, tabIds });
    manager.linkSavedGroup(live.id, savedKey(group));
    manager.selectGroup(live.id);
    savedGroupsChanged();
    return { status: 'opened' };
  });
  // --- find in page -------------------------------------------------------
  const chromeOnly = { chromeOnly: true };
  handle('bobo:find:in-page', (payload) => {
    const id = readTabId(payload);
    if (!findWindows.has(ownWindow()) || typeof payload?.text !== 'string' || !payload.text.trim()
      || payload.text.length > MAX_INPUT || !Number.isSafeInteger(payload.token)) return;
    ownTabs().findInPage(id, payload.text, payload);
  }, chromeOnly);
  handle('bobo:find:stop', (payload) => ownTabs().stopFindInPage(readTabId(payload)), chromeOnly);
  handle('bobo:find:visibility', (payload) => {
    if (payload?.open === true) findWindows.add(ownWindow());
    else findWindows.delete(ownWindow());
    if (findWindows.has(ownWindow())) ownWindow().webContents.focus();
    else if (payload?.restoreFocus === true) ownTabs().focusActivePage();
  }, chromeOnly);
  handle('bobo:library:open', (payload) => {
    const view = payload && payload.view;
    return ownTabs().openLibrary(['bookmarks', 'history', 'downloads'].includes(view) ? view : 'bookmarks');
  });
  handle('bobo:settings:open', (payload, event) => {
    const view = payload && payload.view ? String(payload.view) : 'search';
    return managerFor(event).openSettings(view);
  });
  handle('bobo:zoom:in', (payload) => ownTabs().zoomIn(readTabId(payload)));
  handle('bobo:zoom:out', (payload) => ownTabs().zoomOut(readTabId(payload)));
  handle('bobo:zoom:reset', (payload) => ownTabs().zoomReset(readTabId(payload)));
  handle('bobo:zoom:level', (payload) => ownTabs().zoomLevel(readTabId(payload)));
  handle('bobo:print', (payload) => ownTabs().print(readTabId(payload)));
  handle('bobo:window:new', () => {
    return Boolean(createWindow());
  });
  handle('bobo:window:quit', () => {
    app.quit();
    return true;
  });
  handle('bobo:window:fullscreen', () => {
    if (ownTabs().exitHtmlFullscreen()) return ownWindow().isFullScreen();
    if (ownWindow()) {
      ownWindow().setFullScreen(!ownWindow().isFullScreen());
      return ownWindow().isFullScreen();
    }
    return false;
  });
  handle('bobo:bookmarks:menu', async (payload) => {
    const manager = ownTabs();
    const window = ownWindow();
    const folderId = payload?.folderId;
    const overflowStart = payload?.overflowStart;
    if (folderId != null && (!Number.isInteger(folderId) || folderId < 1)) return false;
    if (overflowStart != null && (folderId !== 1 || !Number.isSafeInteger(overflowStart) || overflowStart < 0)) return false;

    const list = data.bookmarks.list();
    const order = (a, b) => a.position - b.position || a.id - b.id;
    const build = (parentId, start = 0) => [
      ...list.folders.filter((folder) => folder.parentId === parentId),
      ...list.bookmarks.filter((bookmark) => bookmark.folderId === parentId),
    ].sort(order).slice(start).map((entry) => entry.url
      ? { label: entry.title, click: () => manager.navigate(null, entry.url) }
      : { label: entry.name, submenu: build(entry.id) });

    const prefs = folderId == null ? await tools.settings.browserPrefs() : null;
    const barMode = prefs?.bookmarks?.barVisible;
    const send = (command) => () => window.webContents.send('bobo:ui', command);
    const reading = list.folders.find((folder) => folder.parentId === 2 && folder.name === 'Reading list');
    const active = manager.activeTab();
    const canBookmark = Boolean(active && !active.local && /^https?:\/\//i.test(active.url));
    const template = folderId != null ? build(folderId, overflowStart) : [
      { label: 'Bookmark this tab…', enabled: canBookmark, click: send('bookmark-page') },
      { label: 'Bookmark all tabs…', click: () => {
        void bookmarkAllTabs(window, manager).catch((error) => dialog.showErrorBox('BOBO Bookmarks', error.message));
      } },
      { type: 'separator' },
      { label: 'Show bookmarks bar', submenu: [
        { label: 'Always show', type: 'radio', checked: barMode === true || barMode === 'always', click: send('bookmarks-bar-always') },
        { label: 'Only show on New Tab page', type: 'radio', checked: barMode === 'newtab', click: send('bookmarks-bar-newtab') },
        { label: 'Always hide', type: 'radio', checked: barMode === false || barMode === 'never', click: send('bookmarks-bar-never') },
      ] },
      { label: 'Show bookmarks in side panel', click: send('bookmarks-side-panel') },
      { label: 'Open bookmarks manager', click: () => manager.openLibrary('bookmarks') },
      { label: 'Import bookmarks and settings…', click: send('bookmarks-import') },
      { label: 'Reading list', submenu: [
        { label: 'Add current page', enabled: canBookmark, click: () => {
          try {
            data.store.transaction(() => {
              const folder = reading || data.bookmarks.addFolder({ name: 'Reading list', parentId: 2 });
              if (!data.bookmarks.list().bookmarks.some((item) => item.folderId === folder.id && item.url === active.url)) {
                data.bookmarks.add({ url: active.url, title: active.title, folderId: folder.id });
              }
            });
            bookmarksChanged();
          } catch (error) { dialog.showErrorBox('BOBO Reading List', error.message); }
        } },
        ...(reading ? build(reading.id) : []),
      ] },
      { type: 'separator' },
      ...build(1),
      { label: 'Other bookmarks', submenu: build(2) },
    ];
    if (!template.length) return false;
    Menu.buildFromTemplate(template).popup({ window: ownWindow() });
    return true;
  });
  handle('bobo:ui:overlay', (payload) => {
    const open = !!(payload && payload.open);
    ownTabs().setOverlay(open);
    return { open };
  });

  // --- New Tab page: local attachments + Google services launcher ---------
  // The picker returns display metadata and opaque image handles.

  const newTabService = createNewTabService({ getWindow: ownWindow });

  const isNewTab = (sender) => {
    try { return !sender.isDestroyed() && fileURLToPath(sender.getURL()) === NEWTAB_FILE; }
    catch { return false; }
  };
  handle('bobo:newtab:pick-attachments', (payload, event) => {
    const kind = payload && payload.kind;
    if (kind !== 'images' && kind !== 'files') {
      throw new Error('BOBO: invalid attachment type');
    }
    return newTabService.pickAttachments(kind, isNewTab(event.sender) ? event.sender : null);
  });
  handle('bobo:newtab:lens', async (payload, event) => {
    const sender = event.sender;
    if (!isNewTab(sender) || event.senderFrame !== sender.mainFrame || typeof payload?.imageId !== 'string') {
      throw new Error('BOBO: image search is available from the New Tab page.');
    }
    const manager = managerFor(event);
    const result = await newTabService.searchImage(sender, payload.imageId, () => isNewTab(sender));
    if (result.url && isNewTab(sender)) manager.create({ url: result.url });
    return { canceled: Boolean(result.canceled) };
  });
  handle('bobo:newtab:apps:get', async () => ({
    apps: publicGoogleApps(),
    prefs: await tools.settings.launcherPrefs(),
  }));
  handle('bobo:newtab:apps:set', async (payload) => ({
    prefs: await tools.settings.setLauncherPrefs(payload),
  }));

  passwords?.registerSettings({ handle });

  // --- bookmarks, history, downloads, settings, privacy --------------------

  browserIpc = registerBrowserIpc({
    onPrivacyCleared: () => { for (const manager of tabWindows.values()) manager.clearRecentlyClosed(); },
    handle,
    services: data,
    settings: tools.settings,
    getWindow: ownWindow,
    emit: (channel, payload) => {
      if (channel === 'bobo:settings') {
        const nextVideoButtons = payload.browser?.videoDownloadButtons === true;
        if (nextVideoButtons !== videoDownloadButtons) {
          videoDownloadButtons = nextVideoButtons;
          for (const manager of tabWindows.values()) {
            for (const tab of manager.snapshot().tabs) {
              void syncPlayerDownloadButton(manager.webContentsForTab(tab.id)).catch(() => {});
            }
          }
        }
        savedGroupsShortcut = payload.browser?.tabs?.savedGroupsShortcut || '';
        void tools.settings.state().then(updateAlternateVideoClicks).catch(() => {});
      }
      broadcastBrowserData(channel, payload);
    },
  });
}

// --- window ----------------------------------------------------------------

function detachTab(manager, id) {
  if (!manager.tabInfo(id)) return null;
  const cursor = screen.getCursorScreenPoint();
  const target = createWindow({ empty: true, bounds: { x: cursor.x - 120, y: cursor.y - 20, width: 1100, height: 760 } });
  return target ? manager.transferTo(id, target.manager) : null;
}

function createWindow(options = {}) {
  if (tabWindows.size >= MAX_WINDOWS) return null;
  const geometry = options.bounds ? fitBounds(options.bounds, screen.getAllDisplays()) : null;
  win = new BrowserWindow({
    ...(geometry || { width: 1280, height: 840 }),
    minWidth: 640,
    minHeight: 420,
    show: false,
    backgroundColor: '#192734',
    title: 'BOBO',
    icon: APP_ICON,
    // Native Windows caption buttons, kept out of the way of the tab strip.
    titleBarStyle: 'hidden',
    titleBarOverlay: TITLE_BAR[theme],
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
    },
  });

  const currentWindow = win;
  tabs = new TabManager({
    window: win,
    onChange: (snapshot) => {
      if (!currentWindow.isDestroyed() && !currentWindow.webContents.isDestroyed()) {
        currentWindow.webContents.send('bobo:tabs', snapshot);
      }
      scheduleSessionSave();
    },
    onVisit: (visit) => {
      try {
        data?.history.record(visit);
        broadcastBrowserData('bobo:history', { recorded: true });
      } catch {
        // History is bookkeeping: never let it break a page load.
      }
    },
    onFoundInPage: (result) => {
      if (!currentWindow.isDestroyed()) currentWindow.webContents.send('bobo:find:result', result);
    },
  });
  tabWindows.set(currentWindow, tabs);

  // Restore the previous session, open the configured startup pages, or a
  // BOBO new-tab page.
  if (options.restore) tabs.restore(options.restore);
  else if (Array.isArray(options.urls) && options.urls.length) {
    const ids = options.urls
      .filter((url) => isAllowedNavigationUrl(url))
      .map((url) => tabs.create({ url, background: true }));
    if (ids.length) tabs.select(ids[0]);
    else tabs.create();
  } else if (!options.empty) tabs.create();

  // No menu bar: browser shortcuts come from the preload key bridge, and the
  // app-level commands live in the BOBO panel. Keeps the hidden title bar clean.
  Menu.setApplicationMenu(null);

  currentWindow.once('ready-to-show', () => currentWindow.show());
  win.loadFile(CHROME_HTML);
  if (options.maximized) currentWindow.maximize();
  win.on('close', () => {
    clearTimeout(sessionTimer);
    // Save the last window before its tab manager is removed during teardown.
    if (tabWindows.size === 1 && !quitting) {
      quitting = true;
      saveSession({ cleanExit: true });
    }
  });
  win.on('closed', () => {
    tabWindows.delete(currentWindow);
    if (win === currentWindow) {
      findWindows.delete(currentWindow);
      [win, tabs] = [...tabWindows].at(-1) || [null, null];
    }
    if (!quitting) saveSession();
  });
  return { window: currentWindow, manager: tabs };
}

// --- context menu ----------------------------------------------------------
// A native popup window, so it draws above the WebContentsView - unlike any
// overlay we could paint inside the page, which the site view would cover.

function showContextMenu(params, contents) {
  const owner = tabWindowFor(contents);
  if (!owner) return;
  const { window: win, manager: tabs } = owner;

  const template = [];

  const videoSource = params.mediaType === 'video' ? directVideoSource(params.srcURL) : null;
  if (videoSource && downloadPlayerVideo) {
    template.push({ label: 'Download this video…', click: () => {
      void downloadPlayerVideo(win, videoSource).catch((error) => dialog.showErrorBox('BOBO Video Downloader', error.message));
    } });
  }

  if (params.isEditable) {
    template.push(
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { type: 'separator' },
      { role: 'selectAll' }
    );
  } else if (params.selectionText) {
    template.push({ role: 'copy' });
  }

  if (params.linkURL) {
    if (template.length) template.push({ type: 'separator' });
    if (isAllowedNavigationUrl(params.linkURL)) {
      template.push({
        label: 'Open link in new tab',
        click: () => tabs?.create({ url: params.linkURL }),
      });
      template.push({ label: 'Open link in new window', click: () => createWindow({ urls: [params.linkURL] }) });
    }
    template.push({
      label: 'Copy link address',
      click: () => clipboard.writeText(params.linkURL),
    });
  }

  if (!template.length) return;
  Menu.buildFromTemplate(template).popup({ window: win });
}

// --- boot ------------------------------------------------------------------

function boot() {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    if (process.platform === 'win32') {
      app.setAppUserModelId(app.isPackaged ? APP_ID : 'com.bobo.browser');
    }
    if (process.argv.includes('--bobo-choose-profile') ||
        (!profileContext.selected && profileContext.profiles.list().length > 1)) {
      openProfilePicker();
      return;
    }

    // Must run before any WebContents exists, so every one of them is hardened.
    hardenApp({
      canFullscreen: (contents) => tabWindowFor(contents)?.manager.canFullscreen(contents) === true,
      onFullscreenRequest: (contents) => tabWindowFor(contents)?.manager.prepareFullscreen(),
      onNewWindow: (url, contents) => {
      const manager = tabWindowFor(contents)?.manager;
      const afterId = url.startsWith('https://www.yout-ube.com/watch?') ? manager?.tabIdForContents(contents) : null;
      manager?.create({ url, afterId });
    } });

    // Tool data and browser data
    session.defaultSession.registerPreloadScript({ type: 'frame',
      filePath: path.join(__dirname, '../preload/youtube.js'),
      matches: ['https://www.youtube.com/*', 'https://youtube.com/*', 'https://m.youtube.com/*'],
    });
    data = createBrowserServices({ dataDir: app.getPath('userData') });
    if (process.argv.includes(RESTORE_DATABASE_FLAG)) {
      try {
        const result = await restoreFromDialog(data.store);
        if (!result.canceled) {
          data = createBrowserServices({ dataDir: app.getPath('userData') });
        }
      } catch (error) {
        dialog.showErrorBox('BOBO could not restore its database', databaseError(error).message);
      }
    }
    savedGroups = new SavedGroupsService({ store: data.store });
    tools = createToolServices({
      dataDir: path.join(app.getPath('userData'), 'tools'),
      store: data.store,
    });
    try {
      tools.billsService.recoverInterrupted();
    } catch (error) {
      dialog.showErrorBox('BOBO could not open its database', databaseError(error).message);
      app.quit();
      return;
    }

    passwords = await createPasswordManager({ app, directory: app.getPath('userData'),
      safeStorage: require('electron').safeStorage, ipcMain, dialog, ownerFor: tabWindowFor });
    registerIpc();

    // Downloads are recorded only after their preferences have loaded.
    browserIpc.ready.then(() => {
      try {
        data.downloads.reconcile();
      } catch {
        // A broken downloads table must not stop the browser from starting.
      }
      attachDownloads({
        session: session.defaultSession,
        service: data.downloads,
        getPrefs: browserIpc.getDownloadPrefs,
        onChange: scheduleDownloadsEvent,
      });
    });

    app.on('web-contents-created', (_event, contents) => {
      let lastAlternateWatch;
      contents.on('did-start-navigation', details => {
        if (details.isMainFrame) youtubeShorts.navigated(contents, details.url);
        if (details.isMainFrame && !details.isSameDocument) {
          tabWindowFor(contents)?.manager.setPageBackground(contents,
            isYouTube(details.url) && youtubeTheme === 'dark' ? '#0f0f0f' : '#ffffff');
        }
      });
      const openAlternateWatch = async (url) => {
        const alternate = alternateWatchUrl(url);
        if (!alternate && isYouTube(url)) lastAlternateWatch = undefined;
        if (!alternate || alternate === lastAlternateWatch || !tabWindowFor(contents)) return;
        const settings = await tools.settings.state();
        if (contents.isDestroyed() || contents.getURL() !== url ||
            alternate === lastAlternateWatch ||
            !settings.browser.alternateYouTube ||
            !settings.tools.some((tool) => tool.id === 'ad-free-youtube' && tool.enabled)) return;
        lastAlternateWatch = alternate;
        await contents.loadURL(alternate);
      };
      contents.on('did-navigate', (_event, url) => {
        void openAlternateWatch(url).catch(() => {});
      });
      contents.on('did-navigate-in-page', (_event, url, mainFrame) => {
        if (mainFrame) void openAlternateWatch(url).catch(() => {});
      });
      contents.on('dom-ready', () => {
        void setAlternateVideoClicks(contents, alternateVideoClicks).catch(() => {});
        if (videoDownloadButtons) void syncPlayerDownloadButton(contents).catch(() => {});
        if (youtubeAutoSkip) void watchYouTubeAutoSkip(contents, true).catch(() => {});
        if (youtubeTheme !== 'default') void applyYouTubeTheme(contents, youtubeTheme).catch(() => {});
      });
      contents.on('context-menu', (_event, params) => showContextMenu(params, contents));
      wireShortcuts(contents);
    });

    // Restore normal tabs after a restart. An unclean shutdown asks first;
    // otherwise the startup preference decides (continue / new tab / pages).
    const previous = data.sessions.read();
    const prefs = await tools.settings.browserPrefs().catch(() => null);
    videoDownloadButtons = prefs?.videoDownloadButtons === true;
    await tools.settings.state().then(updateAlternateVideoClicks).catch(() => {});
    youtubeTheme = prefs?.youtubeTheme ?? 'default';
    youtubeAutoSkip = prefs?.youtubeAutoSkip === true;
    savedGroupsShortcut = prefs?.tabs?.savedGroupsShortcut || '';
    const startupMode = prefs?.startup?.mode
      || (prefs?.tabs?.restoreSession === false ? 'newtab' : 'continue');
    const startupUrls = Array.isArray(prefs?.startup?.urls) ? prefs.startup.urls : [];
    const restorable = previous.windows.filter((window) => window.tabs.length);

    let restoreWindows = null;
    let skipRestore = false;
    if (previous.cleanExit === false && restorable.length) {
      const answer = await dialog.showMessageBox({
        type: 'warning',
        title: "BOBO Didn't Close Correctly",
        message: 'Restore your previous tabs?',
        detail: 'BOBO did not shut down cleanly (a crash, power loss or forced exit). '
          + 'Restoring is safest; starting fresh keeps a recovery copy of the old session.',
        buttons: ['Restore tabs', 'Start fresh'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (answer.response === 0) {
        restoreWindows = previous.windows;
      } else {
        data.sessions.preserve('crash');
        skipRestore = true;
      }
    }

    if (!restoreWindows && !skipRestore) {
      if (startupMode === 'continue' && restorable.length) restoreWindows = previous.windows;
      else if (startupMode === 'specific' && startupUrls.length) restoreWindows = 'urls';
    }

    restoring = true;
    try {
      if (Array.isArray(restoreWindows)) {
        for (const window of restoreWindows.slice(0, MAX_WINDOWS)) {
          createWindow({
            restore: window,
            bounds: window.bounds,
            maximized: window.maximized,
          });
        }
        if (!tabWindows.size) createWindow();
      } else if (restoreWindows === 'urls') {
        createWindow({ urls: startupUrls });
      } else {
        createWindow();
      }
    } finally {
      restoring = false;
    }
    saveSession();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

void handleWindowsInstaller({ app, dialog }).then((handled) => {
  if (!handled) boot();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  if (quitting) return;
  quitting = true;
  clearTimeout(sessionTimer);
  saveSession({ cleanExit: true });
});

app.on('will-quit', () => {
  try { data?.store.close(); } catch {
    console.warn('BOBO database could not close cleanly.');
  }
});
