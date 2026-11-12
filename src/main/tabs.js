'use strict';

/**
 * Tab management built on WebContentsView (the supported architecture -
 * BrowserView is deprecated and <webview> is not used anywhere in BOBO).
 *
 * Only the active tab's view is attached to the window; switching tabs
 * detaches the outgoing view and attaches the incoming one. Inactive views and
 * their WebContents stay alive, so tab state (scroll, form input, history) is
 * preserved across switches.
 */

const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { app, WebContentsView } = require('electron');
const { browserUserAgent } = require('./browser-user-agent');
const { resolveInput, isLocalRendererUrl } = require('./navigation');

const PRELOAD = path.join(__dirname, '../preload/preload.js');
const RENDERER_DIR = path.resolve(__dirname, '../renderer');
const NEWTAB_FILE = path.join(RENDERER_DIR, 'newtab.html');
const ERROR_FILE = path.join(RENDERER_DIR, 'error.html');
const LIBRARY_FILE = path.join(RENDERER_DIR, 'library.html');
const SETTINGS_FILE = path.join(RENDERER_DIR, 'settings.html');

/** Ceiling: how many closed tabs Ctrl+Shift+T can reopen. */
const MAX_CLOSED = 12;
const CLOSED_TTL = 5 * 60 * 1000;

/** After this many renderer crashes a restored tab is not loaded automatically. */
const CRASH_LOOP_LIMIT = 3;

/** ERR_ABORTED - a navigation superseded by another one, not a real failure. */
const ERR_ABORTED = -3;

function localPageOf(url) {
  try {
    if (typeof url !== 'string' || !url.startsWith('file:')) return null;
    const filePath = path.resolve(fileURLToPath(url));
    if (filePath === NEWTAB_FILE) return 'newtab';
    if (filePath === ERROR_FILE) return 'error';
    if (filePath === LIBRARY_FILE) return 'library';
    if (filePath === SETTINGS_FILE) return 'settings';
    return null;
  } catch {
    return null;
  }
}

/** Back/forward state, tolerating both the current and the legacy Electron API. */
function navState(webContents) {
  try {
    const history = webContents.navigationHistory;
    if (history && typeof history.canGoBack === 'function') {
      return { back: history.canGoBack(), forward: history.canGoForward() };
    }
    return { back: webContents.canGoBack(), forward: webContents.canGoForward() };
  } catch {
    return { back: false, forward: false };
  }
}

function callHistory(webContents, name) {
  try {
    const history = webContents.navigationHistory;
    if (history && typeof history[name] === 'function') history[name]();
    else if (typeof webContents[name] === 'function') webContents[name]();
  } catch {
    // No history to move through - ignore, same as a disabled button.
  }
}

class TabManager {
  #window;
  #onChange;
  #onVisit;
  #onFoundInPage;
  #tabs = [];
  #groups = new Map();
  #nextId = 1;
  #activeId = null;
  #attachedId = null;
  #closed = [];
  #closedSequence = 0;
  #closedTimer;
  #closing = new Map();
  #disposed = false;
  #bounds = { x: 0, y: 0, width: 0, height: 0 };
  #overlay = false;
  #htmlFullscreenId = null;
  #fullscreenRestore = false;

  constructor({ window, onChange, onVisit, onFoundInPage }) {
    this.#window = window;
    this.#onChange = typeof onChange === 'function' ? onChange : () => {};
    this.#onVisit = typeof onVisit === 'function' ? onVisit : () => {};
    this.#onFoundInPage = typeof onFoundInPage === 'function' ? onFoundInPage : () => {};
    window.on('resize', () => this.#applyBounds());
    window.once('closed', () => {
      this.#disposed = true;
      setImmediate(() => this.dispose());
    });
  }

  activeId() {
    return this.#activeId;
  }

  canFullscreen(contents) {
    return !this.#overlay && contents === this.activeWebContents();
  }

  prepareFullscreen() {
    if (this.#htmlFullscreenId == null) this.#fullscreenRestore = this.#window.isFullScreen();
  }

  #leaveHtmlFullscreen() {
    if (this.#htmlFullscreenId == null) return;
    this.#htmlFullscreenId = null;
    if (!this.#window.isDestroyed()) this.#window.setFullScreen(this.#fullscreenRestore);
    this.#applyBounds();
  }

  exitHtmlFullscreen() {
    const tab = this.byId(this.#htmlFullscreenId);
    if (!tab?.view) return false;
    void tab.view.webContents.executeJavaScript('document.fullscreenElement && document.exitFullscreen()').catch(() => {});
    this.#leaveHtmlFullscreen();
    return true;
  }

  /** True when the active tab is mid-load (used by the Escape shortcut). */
  isLoading(id) {
    const tab = this.byId(id == null ? this.#activeId : id);
    return !!tab && tab.loading;
  }

  byId(id) {
    return this.#tabs.find((tab) => tab.id === id) || null;
  }

  /**
   * WebContents of the active tab, or null.
   * The tools use this to capture the visible page / read its text: they can
   * only ever reach the tab the user is looking at.
   */
  activeWebContents() {
    return this.#webContents(this.#activeId);
  }

  webContentsForTab(id) {
    return Number.isSafeInteger(id) ? this.#webContents(id) : null;
  }

  /** A small read-only view of the active tab for the shortcut handlers. */
  activeTab() {
    const tab = this.byId(this.#activeId);
    return tab ? { id: tab.id, url: tab.url, title: tab.title, pinned: tab.pinned } : null;
  }

  /** Read-only tab info for native menus, without exposing the internal tab. */
  tabInfo(id) {
    const tab = this.byId(id == null ? this.#activeId : id);
    if (!tab) return null;
    return { id: tab.id, url: tab.url, title: tab.title, pinned: tab.pinned, muted: tab.muted, groupId: tab.groupId };
  }

  /** Remember the content area reported by the renderer and apply it. */
  setBounds(bounds) {
    this.#bounds = bounds;
    this.#applyBounds();
  }

  snapshot() {
    return {
      activeId: this.#activeId,
      zoom: this.zoomLevel(this.#activeId),
      groups: Array.from(this.#groups.values()),
      tabs: this.#tabs.map((tab) => {
        const contents = tab.view?.webContents;
        const live = contents && !contents.isDestroyed();
        const state = live ? navState(contents) : { back: false, forward: false };
        return {
          id: tab.id,
          groupId: tab.groupId || null,
          title: tab.title,
          url: tab.url,
          favicon: tab.favicon,
          loading: tab.loading,
          canGoBack: state.back,
          canGoForward: state.forward,
          isLocal: tab.local,
          page: tab.page,
          pinned: tab.pinned,
          muted: tab.muted,
          audible: !tab.muted && Boolean(live) && contents.isCurrentlyAudible(),
          deferred: Boolean(tab.deferred),
          crashLoop: Boolean(tab.deferred?.blocked),
          error: tab.error,
        };
      }),
    };
  }

  create(options = {}) {
    const previous = options.url && this.#takeClosed(entry => entry.url === options.url);
    if (previous) {
      options = { ...options, pinned: options.pinned ?? (options.groupId ? false : previous.pinned) };
      if (options.restoreGroup && !options.groupId && previous.group) options.groupId = this.#groups.has(previous.group.id)
        ? previous.group.id : this.createGroup({ name: previous.group.name, color: previous.group.color }).id;
    }
    const tab = {
      id: this.#nextId++,
      view: null,
      title: 'New Tab',
      url: '',
      favicon: '',
      loading: false,
      local: true,
      page: 'newtab',
      pinned: options.pinned === true,
      private: options.private === true,
      muted: false,
      error: null,
      pendingVisit: null,
      groupId: options.groupId || null,
      crashCount: 0,
      deferred: null,
      reopenState: previous || null,
    };

    this.#tabs.push(tab);
    if (previous) { tab.title = previous.title; tab.muted = previous.muted; }
    if (tab.pinned) this.#moveTo(tab, this.#pinnedCount() - 1);
    else if (options.afterId != null) {
      const opener = this.#tabs.findIndex((entry) => entry.id === options.afterId);
      if (opener >= 0) this.#moveTo(tab, Math.max(this.#pinnedCount(), opener + 1));
    }

    if (options.page === 'library') this.#openLocal(tab, LIBRARY_FILE, options.view);
    else if (options.page === 'settings') this.#openLocal(tab, SETTINGS_FILE, options.view);
    else if (options.url) {
      const target = resolveInput(options.url);
      if (target) this.#load(tab, target.url);
      else this.#openNewTab(tab);
    } else this.#openNewTab(tab);

    if (options.background === true) this.#emit();
    else this.select(tab.id);
    return tab.id;
  }

  select(id) {
    const tab = this.byId(id);
    if (!tab) return false;
    if (id !== this.#activeId) this.exitHtmlFullscreen();

    if (id !== this.#activeId) this.stopFindInPage(this.#activeId);
    this.#ensureView(tab);

    if (this.#attachedId !== id && !this.#overlay) {
      this.#detach();
      this.#window.contentView.addChildView(tab.view);
      this.#attachedId = id;
      this.#applyBounds();
      tab.view.webContents.focus();
    }

    this.#activeId = id;
    this.#setTitle(tab);
    this.#materialize(tab);
    this.#emit();
    return true;
  }

  /** Hide the page while a chrome-only overlay (tab search) is open. */
  setOverlay(open) {
    const next = open === true;
    if (next === this.#overlay) return;
    if (next) this.exitHtmlFullscreen();
    this.#overlay = next;
    if (next) {
      this.#detach();
      return;
    }
    const tab = this.byId(this.#activeId);
    if (!tab) return;
    this.#ensureView(tab);
    this.#window.contentView.addChildView(tab.view);
    this.#attachedId = tab.id;
    this.#applyBounds();
    tab.view.webContents.focus();
  }

  close(id) {
    const tab = this.byId(id);
    if (!tab) return;
    if (id === this.#htmlFullscreenId) this.exitHtmlFullscreen();

    const index = this.#tabs.indexOf(tab);
    const wasActive = this.#activeId === tab.id;

    let entry;
    if (tab.url && !tab.local && !tab.private && tab.url.length <= 2048) {
      entry = { id: ++this.#closedSequence, url: tab.url, title: tab.title.slice(0, 200),
        closedAt: Date.now(), pinned: tab.pinned, muted: tab.muted, index,
        zoom: tab.view?.webContents.getZoomFactor() || 1, scroll: null,
        group: tab.groupId ? { ...this.#groups.get(tab.groupId) } : null };
      this.#closed.unshift(entry);
      if (this.#closed.length > MAX_CLOSED) this.#closed.length = MAX_CLOSED;
      this.recentlyClosed();
    }

    if (wasActive) this.#detach();
    this.#tabs.splice(index, 1);
    if (tab.groupId) {
      const remaining = this.#tabs.some((t) => t.groupId === tab.groupId);
      if (!remaining) this.#groups.delete(tab.groupId);
    }
    const contents = tab.view?.webContents;
    if (contents && !contents.isDestroyed()) {
      this.#unwire(tab);
      // Capture coordinates only; retain neither page text nor a running hidden tab.
      if (entry && !tab.loading && !tab.error && this.#closing.size < 2) {
        let captured;
        entry.ready = new Promise(resolve => { captured = resolve; });
        const finish = () => {
          const pending = this.#closing.get(contents);
          if (!pending) return;
          clearTimeout(pending.timer); this.#closing.delete(contents);
          captured();
          if (!contents.isDestroyed()) contents.close();
        };
        this.#closing.set(contents, { timer: setTimeout(finish, 100), finish });
        void contents.executeJavaScript('({x:scrollX,y:scrollY})').then(position => {
          if (Number.isFinite(position?.x) && Number.isFinite(position?.y)) entry.scroll = position;
        }).catch(() => {}).finally(finish);
      } else contents.close();
    }

    if (wasActive) {
      const next = this.#tabs[index] || this.#tabs[index - 1] || null;
      if (next) this.select(next.id);
      else this.create(); // Keep the window open with one fresh tab.
    }
    this.#emit();
  }

  recentlyClosed() {
    clearTimeout(this.#closedTimer);
    this.#closed = this.#closed.filter(entry => Date.now() - entry.closedAt < CLOSED_TTL);
    const oldest = this.#closed.at(-1);
    if (oldest && !this.#disposed) {
      this.#closedTimer = setTimeout(() => this.recentlyClosed(), Math.max(1, oldest.closedAt + CLOSED_TTL - Date.now() + 1));
      this.#closedTimer.unref();
    }
    return this.#closed.map(({ id, url, title }) => ({ id, url, title }));
  }

  #takeClosed(matches) {
    this.recentlyClosed();
    const index = this.#closed.findIndex(matches);
    return index < 0 ? null : this.#closed.splice(index, 1)[0];
  }

  reopenClosed(id) {
    const entry = this.#takeClosed(entry => id == null || entry.id === id);
    if (!entry) return null;
    // Let create use the same state path as reopening the URL from the address bar.
    this.#closed.unshift(entry);
    const restored = this.create({ url: entry.url, restoreGroup: true });
    this.move(restored, entry.index);
    return restored;
  }

  #unwire(tab) {
    for (const [name, listener] of tab.listeners || []) tab.view?.webContents.removeListener(name, listener);
    tab.listeners = [];
  }

  transferTo(id, destination) {
    const tab = this.byId(id);
    if (!tab || destination === this || destination.#disposed) return null;
    this.exitHtmlFullscreen(); this.stopFindInPage(id);
    const group = this.#groups.get(tab.groupId);
    const index = this.#tabs.indexOf(tab);
    const active = this.#activeId === id;
    if (active) this.#detach();
    this.#unwire(tab);
    this.#tabs.splice(index, 1);
    if (tab.groupId && !this.#tabs.some(entry => entry.groupId === tab.groupId)) this.#groups.delete(tab.groupId);
    tab.id = destination.#nextId++;
    tab.groupId = group ? destination.createGroup({ name: group.name, color: group.color }).id : null;
    destination.#tabs.push(tab);
    if (tab.view) destination.#wire(tab);
    if (tab.pinned) destination.move(tab.id, 0);
    destination.select(tab.id);
    if (active) {
      this.#activeId = null;
      const next = this.#tabs[index] || this.#tabs[index - 1];
      if (next) this.select(next.id); else this.create();
    }
    this.#emit();
    return tab.id;
  }

  clearRecentlyClosed() { clearTimeout(this.#closedTimer); this.#closed = []; }

  dispose() {
    this.#disposed = true;
    this.clearRecentlyClosed();
    for (const pending of this.#closing.values()) pending.finish();
    this.#closing.clear();
    for (const tab of this.#tabs) {
      this.#unwire(tab);
      if (tab.view && !tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    }
    this.#tabs = [];
  }

  /** Toggle pinning. Pinned tabs keep their own block at the start. */
  pin(id) {
    const tab = this.byId(id == null ? this.#activeId : id);
    if (!tab) return null;
    tab.pinned = !tab.pinned;
    // End of the pinned block, or the start of the unpinned one.
    this.#moveTo(tab, tab.pinned ? this.#pinnedCount() - 1 : this.#pinnedCount());
    this.#emit();
    return tab.pinned;
  }

  /** Drag-and-drop reorder; pinned and unpinned tabs never mix. */
  move(id, index) {
    const tab = this.byId(id);
    if (!tab) return false;
    const pinned = this.#pinnedCount();
    const min = tab.pinned ? 0 : pinned;
    const max = tab.pinned ? Math.max(0, pinned - 1) : this.#tabs.length - 1;
    const target = Math.min(max, Math.max(min, Math.round(Number(index) || 0)));
    this.#moveTo(tab, target);
    this.#emit();
    return true;
  }

  duplicate(id) {
    const tab = this.byId(id == null ? this.#activeId : id);
    if (!tab) return null;
    const index = this.#tabs.indexOf(tab);
    const copy = this.create({
      url: tab.url || undefined,
      page: tab.page === 'library' ? 'library' : undefined,
      pinned: tab.pinned,
      background: true,
    });
    this.#moveTo(this.byId(copy), index + 1);
    this.select(copy);
    return copy;
  }

  mute(id) {
    const tab = this.byId(id == null ? this.#activeId : id);
    if (!tab) return null;
    tab.muted = !tab.muted;
    tab.view?.webContents?.setAudioMuted(tab.muted);
    this.#emit();
    return tab.muted;
  }

  /** Open (or reuse) the in-tab Library: bookmarks, history, downloads. */
  openLibrary(view) {
    const existing = this.#tabs.find((tab) => tab.page === 'library');
    if (existing) {
      this.#openLocal(existing, LIBRARY_FILE, view);
      this.select(existing.id);
      return existing.id;
    }
    return this.create({ page: 'library', view });
  }

  /** Open (or reuse) the in-tab Settings. */
  openSettings(view) {
    const existing = this.#tabs.find((tab) => tab.page === 'settings');
    if (existing) {
      this.#openLocal(existing, SETTINGS_FILE, view);
      this.select(existing.id);
      return existing.id;
    }
    return this.create({ page: 'settings', view });
  }

  zoomIn(id) {
    return this.#stepZoom(id, 'in');
  }

  zoomOut(id) {
    return this.#stepZoom(id, 'out');
  }

  #stepZoom(id, direction) {
    const wc = this.#webContents(id);
    if (!wc) return 100;
    const current = this.zoomLevel(id);
    const steps = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500];
    const next = direction === 'in'
      ? steps.find((level) => level > current) ?? steps.at(-1)
      : steps.findLast((level) => level < current) ?? steps[0];
    wc.setZoomFactor(next / 100);
    this.#emit();
    return next;
  }

  zoomReset(id) {
    const wc = this.#webContents(id);
    if (!wc) return 100;
    wc.setZoomFactor(1);
    this.#emit();
    return 100;
  }

  zoomLevel(id) {
    const wc = this.#webContents(id);
    if (!wc) return 100;
    return Math.round((wc.getZoomFactor() || 1) * 100);
  }

  print(id) {
    const wc = this.#webContents(id);
    if (wc) wc.print();
  }

  // --- find in page -------------------------------------------------------

  findInPage(id, text, options = {}) {
    if (id !== this.#activeId) return;
    const tab = this.byId(id);
    const contents = this.#webContents(id);
    if (!tab || !contents) return;
    const matchCase = options.matchCase === true;
    const previous = tab.find;
    const newSession = options.advance !== true || previous?.text !== text || previous.matchCase !== matchCase;
    const requestId = contents.findInPage(text, {
      forward: options.forward !== false,
      findNext: newSession,
      matchCase,
    });
    tab.find = { requestId, token: options.token, text, matchCase };
  }

  stopFindInPage(id) {
    const tab = this.byId(id);
    if (!tab?.find) return;
    tab.find = null;
    this.#webContents(id)?.stopFindInPage('clearSelection');
  }

  focusActivePage() {
    if (!this.#overlay) this.#webContents(this.#activeId)?.focus();
  }

  setPageBackground(contents, color) {
    const tab = this.byId(this.tabIdForContents(contents));
    tab?.view?.setBackgroundColor(color);
  }

  // --- tab groups ----------------------------------------------------------

  createGroup({ name, color = 'blue', tabIds = [] } = {}) {
    const id = 'grp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    const group = {
      id,
      name: String(name || '').trim() || 'New Group',
      color: String(color || 'blue').toLowerCase(),
      collapsed: false,
    };
    this.#groups.set(id, group);

    if (Array.isArray(tabIds) && tabIds.length) {
      for (const tabId of tabIds) {
        const tab = this.byId(tabId);
        if (tab && !tab.pinned) {
          tab.groupId = id;
        }
      }
    }
    this.#emit();
    return group;
  }

  updateGroup(id, updates = {}) {
    const group = this.#groups.get(id);
    if (!group) return null;
    if (typeof updates.name === 'string') group.name = updates.name.trim().slice(0, 120) || group.name;
    if (typeof updates.color === 'string') group.color = String(updates.color).toLowerCase();
    if (typeof updates.collapsed === 'boolean') group.collapsed = updates.collapsed;
    this.#emit();
    return group;
  }

  toggleGroupCollapse(id) {
    const group = this.#groups.get(id);
    if (!group) return false;
    group.collapsed = !group.collapsed;
    this.#emit();
    return group.collapsed;
  }

  ungroup(id) {
    if (!this.#groups.has(id)) return false;
    for (const tab of this.#tabs) {
      if (tab.groupId === id) tab.groupId = null;
    }
    this.#groups.delete(id);
    this.#emit();
    return true;
  }

  closeGroup(id) {
    if (!this.#groups.has(id)) return false;
    const toClose = this.#tabs.filter((tab) => tab.groupId === id);
    for (const tab of toClose) {
      this.close(tab.id);
    }
    this.#groups.delete(id);
    this.#emit();
    return true;
  }

  setTabGroup(tabId, groupId) {
    const tab = this.byId(tabId);
    if (!tab) return false;
    if (!groupId) {
      tab.groupId = null;
      this.#emit();
      return true;
    }
    if (!this.#groups.has(groupId)) return false;
    tab.groupId = groupId;
    this.#emit();
    return true;
  }

  groupInfo(id) {
    return this.#groups.get(id) || null;
  }

  groupTabs(id) {
    return this.#tabs.filter((tab) => tab.groupId === id);
  }

  ownsContents(contents) {
    return this.tabIdForContents(contents) !== null;
  }

  tabIdForContents(contents) {
    return this.#tabs.find((tab) => tab.view?.webContents === contents)?.id ?? null;
  }

  savedGroup(key) {
    return [...this.#groups.values()].find((group) => group.savedKey === key && this.groupTabs(group.id).length);
  }

  linkSavedGroup(id, key) {
    const group = this.#groups.get(id);
    if (!group) return;
    group.savedKey = key;
    this.#emit();
  }

  selectGroup(id) {
    const group = this.#groups.get(id);
    const first = this.groupTabs(id)[0];
    if (!group || !first) return false;
    group.collapsed = false;
    return this.select(first.id);
  }

  /**
   * Persistable part of one window: normal web tabs, their order, pins, live
   * groups and per-URL crash counts. Local pages, private tabs and form data
   * are deliberately excluded.
   */
  sessionState() {
    const open = this.#tabs.filter((tab) => !tab.local && tab.url && !tab.private);
    const liveGroups = new Set(open.map((tab) => tab.groupId).filter(Boolean));
    return {
      tabs: open.map((tab) => {
        const group = this.groupInfo(tab.groupId);
        return {
          url: tab.url,
          title: tab.title,
          pinned: tab.pinned,
          groupKey: group ? group.id : null,
          crashCount: tab.crashCount || 0,
        };
      }),
      groups: [...this.#groups.values()]
        .filter((group) => liveGroups.has(group.id))
        .map((group) => ({
          key: group.id,
          name: group.name,
          color: group.color,
          collapsed: group.collapsed,
          ...(group.savedKey ? { savedKey: group.savedKey } : {}),
        })),
      activeIndex: Math.max(
        0,
        open.findIndex((tab) => tab.id === this.#activeId)
      ),
      closed: this.#closed.slice(0, MAX_CLOSED),
    };
  }

  /**
   * Rebuild tabs saved by a previous run. Only the selected tab is materialised
   * (and loaded) immediately; every other tab is a cheap placeholder that keeps
   * its order, pin, group and crash count until the user selects it.
   */
  restore(state = {}) {
    const saved = Array.isArray(state.tabs) ? state.tabs : [];
    if (Array.isArray(state.closed)) {
      this.#closed = state.closed
        .filter((entry) => entry && typeof entry.url === 'string')
        .slice(0, MAX_CLOSED)
        .map((entry) => ({ url: entry.url, title: String(entry.title || '') }));
    }

    const liveGroups = new Map();
    for (const savedGroup of Array.isArray(state.groups) ? state.groups : []) {
      const group = this.createGroup({ name: savedGroup.name, color: savedGroup.color });
      group.collapsed = savedGroup.collapsed === true;
      if (savedGroup.savedKey) this.linkSavedGroup(group.id, savedGroup.savedKey);
      liveGroups.set(savedGroup.key, group.id);
    }

    if (!saved.length) {
      this.create();
      return;
    }

    const ids = saved.map((entry) => this.#addPlaceholder(entry, liveGroups.get(entry.groupKey) || null));
    const index = Math.min(Math.max(0, Number(state.activeIndex) || 0), ids.length - 1);
    this.select(ids[index]);
  }

  /** Move selection by `delta`, wrapping around. */
  cycle(delta) {
    if (this.#tabs.length < 2) return;
    const current = this.#tabs.findIndex((tab) => tab.id === this.#activeId);
    const next = this.#tabs[(current + delta + this.#tabs.length) % this.#tabs.length];
    this.select(next.id);
  }

  navigate(id, text, engineUrl) {
    const tab = this.byId(id == null ? this.#activeId : id);
    if (!tab) return false;
    const target = resolveInput(text, engineUrl);
    if (!target) return false;
    tab.reopenState = this.#takeClosed(entry => entry.url === target.url);
    this.#load(tab, target.url);
    this.#emit();
    return true;
  }

  goBack(id) {
    const webContents = this.#webContents(id);
    if (webContents) callHistory(webContents, 'goBack');
    this.#emit();
  }

  goForward(id) {
    const webContents = this.#webContents(id);
    if (webContents) callHistory(webContents, 'goForward');
    this.#emit();
  }

  reload(id) {
    const tab = this.byId(id == null ? this.#activeId : id);
    if (!tab) return;
    tab.error = null;
    if (tab.page === 'library') this.#openLocal(tab, LIBRARY_FILE);
    else if (tab.page === 'settings') this.#openLocal(tab, SETTINGS_FILE);
    else if (tab.url && !tab.local) this.#load(tab, tab.url);
    else this.#openNewTab(tab);
    this.#emit();
  }

  stop(id) {
    const webContents = this.#webContents(id);
    if (webContents) webContents.stop();
    this.#emit();
  }

  home(id) {
    const tab = this.byId(id == null ? this.#activeId : id);
    if (!tab) return;
    this.#openNewTab(tab);
    this.#emit();
  }

  /** Retry the URL that failed (from the error page). */
  retry(id) {
    const tab = this.byId(id == null ? this.#activeId : id);
    if (!tab) return;
    tab.error = null;
    tab.crashCount = 0;
    tab.deferred = null;
    if (tab.page === 'library') this.#openLocal(tab, LIBRARY_FILE);
    else if (tab.url) this.#load(tab, tab.url);
    else this.#openNewTab(tab);
    this.#emit();
  }

  /** Send an event only to BOBO's own local pages, never to remote sites. */
  broadcast(channel, payload) {
    for (const tab of this.#tabs) {
      const webContents = tab.view?.webContents;
      if (!webContents || webContents.isDestroyed()) continue;
      if (!isLocalRendererUrl(webContents.getURL())) continue;
      webContents.send(channel, payload);
    }
  }

  // --- internals -----------------------------------------------------------

  #createView() {
    const view = new WebContentsView({
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        spellcheck: false,
      },
      // A dragged link/file must not silently navigate the tab - real browsers
      // ask first, and an unasked-for navigation can leave an attacker page.
      navigateOnDragDrop: false,
    });
    view.webContents.setUserAgent(browserUserAgent(view.webContents.getUserAgent(), app.getName()));
    return view;
  }

  /** A restored tab that has not been selected yet. No renderer exists. */
  #addPlaceholder(entry, groupId) {
    const crashCount = Math.max(0, Number(entry.crashCount) || 0);
    const tab = {
      id: this.#nextId++,
      view: null,
      title: String(entry.title || '').trim() || 'New Tab',
      url: String(entry.url),
      favicon: '',
      loading: false,
      local: false,
      page: null,
      pinned: entry.pinned === true,
      private: false,
      muted: false,
      error: null,
      pendingVisit: null,
      groupId,
      crashCount,
      deferred: { url: String(entry.url), blocked: crashCount >= CRASH_LOOP_LIMIT },
    };
    this.#tabs.push(tab);
    if (tab.pinned) this.#moveTo(tab, this.#pinnedCount() - 1);
    return tab.id;
  }

  #ensureView(tab) {
    if (tab.view) return tab.view;
    tab.view = this.#createView();
    this.#wire(tab);
    return tab.view;
  }

  /** Load a deferred restored tab, or explain why it was quarantined. */
  #materialize(tab) {
    if (!tab.deferred || !tab.view) return;
    const deferred = tab.deferred;
    tab.deferred = null;
    if (deferred.blocked) {
      this.#showError(tab, {
        code: 'crash-loop',
        desc: `This page crashed ${tab.crashCount} times and was not loaded automatically. Retry only if you trust the page.`,
        url: deferred.url,
      });
      return;
    }
    this.#load(tab, deferred.url);
  }

  #pinnedCount() {
    return this.#tabs.filter((tab) => tab.pinned).length;
  }

  #moveTo(tab, index) {
    const from = this.#tabs.indexOf(tab);
    if (from < 0) return;
    this.#tabs.splice(from, 1);
    const to = Math.max(0, Math.min(this.#tabs.length, Math.round(Number(index) || 0)));
    this.#tabs.splice(to, 0, tab);
  }

  #wire(tab) {
    const webContents = tab.view.webContents;
    tab.listeners = [];
    const on = (name, listener) => {
      const owned = (...args) => { if (this.byId(tab.id) === tab) listener(...args); };
      tab.listeners.push([name, owned]); webContents.on(name, owned);
    };

    on('enter-html-full-screen', () => {
      if (!this.canFullscreen(webContents)) {
        void webContents.executeJavaScript('document.fullscreenElement && document.exitFullscreen()').catch(() => {});
        return;
      }
      this.#htmlFullscreenId = tab.id;
      this.#window.setFullScreen(true);
      this.#applyBounds();
    });
    on('leave-html-full-screen', () => {
      if (this.#htmlFullscreenId === tab.id) this.#leaveHtmlFullscreen();
    });
    on('destroyed', () => {
      if (this.#htmlFullscreenId === tab.id) this.#leaveHtmlFullscreen();
    });
    on('zoom-changed', (_event, direction) => {
      if (tab.id !== this.#activeId || (direction !== 'in' && direction !== 'out')) return;
      this.#stepZoom(tab.id, direction);
    });

    on('page-title-updated', (event, title) => {
      event.preventDefault();
      tab.title = (title || '').trim() || 'New Tab';
      this.#setTitle(tab);
      this.#emit();
    });

    on('page-favicon-updated', (_event, favicons) => {
      tab.favicon = (Array.isArray(favicons) && favicons.find(Boolean)) || '';
      this.#emit();
    });

    on('did-start-loading', () => {
      tab.loading = true;
      this.#emit();
    });

    on('did-stop-loading', () => {
      tab.loading = false;
      const previous = tab.reopenState;
      tab.reopenState = null;
      if (previous && !tab.error && webContents.getURL() === previous.url) {
        tab.muted = previous.muted;
        webContents.setZoomFactor(previous.zoom);
        webContents.setAudioMuted(previous.muted);
        void Promise.resolve(previous.ready).then(() => {
          if (previous.scroll && this.byId(tab.id) === tab && !webContents.isDestroyed() &&
              !tab.loading && webContents.getURL() === previous.url) {
            return webContents.executeJavaScript(`scrollTo(${JSON.stringify(previous.scroll.x)},${JSON.stringify(previous.scroll.y)})`);
          }
        }).catch(() => {});
      }
      // One history record per committed navigation, with the final title.
      if (tab.pendingVisit && !tab.error && !tab.local && !tab.private) {
        this.#onVisit({ url: tab.pendingVisit.url, title: tab.title });
      }
      tab.pendingVisit = null;
      // A page that loaded successfully has recovered; stop counting crashes.
      if (!tab.error) tab.crashCount = 0;
      this.#emit();
    });

    on('did-navigate', (_event, url) => this.#commit(tab, url));
    on('did-start-navigation', ({ isMainFrame }) => {
      if (!isMainFrame || tab.id !== this.#activeId) return;
      this.stopFindInPage(tab.id);
      this.#onFoundInPage({ tabId: tab.id, reset: true });
    });
    on('did-navigate-in-page', (_event, url, isMainFrame) => {
      // Sub-frame hash/history changes must never take over the address bar.
      if (isMainFrame) this.#commit(tab, url);
    });

    on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === ERR_ABORTED) return;
      if (this.byId(tab.id) !== tab) return;
      tab.url = url || tab.url;
      tab.local = false;
      this.#showError(tab, { code, desc: description, url: tab.url });
    });

    on('render-process-gone', (_event, details) => {
      if (details && details.reason === 'clean-exit') return;
      if (this.byId(tab.id) !== tab) return;
      tab.crashCount = Math.min(10, (tab.crashCount || 0) + 1);
      this.#showError(tab, {
        code: tab.crashCount >= CRASH_LOOP_LIMIT ? 'crash-loop' : 'crashed',
        desc: tab.crashCount >= CRASH_LOOP_LIMIT
          ? `This page crashed ${tab.crashCount} times. It will not be restored automatically next time.`
          : `The page process exited unexpectedly (${(details && details.reason) || 'unknown'}).`,
        url: tab.url,
      });
    });

    on('found-in-page', (_event, result) => {
      if (tab.id === this.#activeId && tab.find?.requestId === result.requestId && result.finalUpdate) {
        this.#onFoundInPage({
          tabId: tab.id,
          token: tab.find.token,
          activeMatchOrdinal: result.activeMatchOrdinal,
          matches: result.matches,
        });
      }
    });
  }

  #commit(tab, url) {
    const page = localPageOf(url);
    if (page === 'error') return; // Keep the failed URL visible in the address bar.

    if (page) {
      tab.url = '';
      tab.local = true;
      tab.page = page;
    } else {
      tab.url = url;
      tab.local = false;
      tab.page = null;
      tab.pendingVisit = { url };
    }
    tab.error = null;
    this.#setTitle(tab);
    this.#emit();
  }

  #load(tab, url) {
    const view = this.#ensureView(tab);
    tab.url = url;
    tab.local = false;
    tab.error = null;
    view.webContents.loadURL(url).catch(() => {
      // `did-fail-load` reports the failure with a proper error page.
    });
  }

  #openNewTab(tab) {
    this.#openLocal(tab, NEWTAB_FILE);
  }

  #openLocal(tab, file, view) {
    const contents = this.#ensureView(tab).webContents;
    tab.url = '';
    tab.local = true;
    tab.page = file === LIBRARY_FILE ? 'library' : file === SETTINGS_FILE ? 'settings' : 'newtab';
    tab.error = null;
    tab.pendingVisit = null;
    const options = view ? { query: { view: String(view) } } : undefined;
    contents.loadFile(file, options).catch(() => {});
  }

  #showError(tab, error) {
    const contents = this.#ensureView(tab).webContents;
    tab.error = error;
    tab.loading = false;
    contents
      .loadFile(ERROR_FILE, {
        query: {
          code: String(error.code),
          desc: String(error.desc || ''),
          url: String(error.url || ''),
        },
      })
      .catch(() => {});
    this.#emit();
  }

  #webContents(id) {
    const tab = this.byId(id == null ? this.#activeId : id);
    if (!tab?.view) return null;
    return tab.view.webContents.isDestroyed() ? null : tab.view.webContents;
  }

  #detach() {
    if (this.#attachedId == null) return;
    const tab = this.byId(this.#attachedId);
    if (tab?.view) {
      try {
        this.#window.contentView.removeChildView(tab.view);
      } catch {
        // View was never attached or already removed.
      }
    }
    this.#attachedId = null;
  }

  #applyBounds() {
    if (this.#overlay) return; // the page is hidden behind a chrome overlay
    const tab = this.byId(this.#attachedId);
    if (!tab?.view) return;
    const { x, y, width, height } = this.#bounds;
    if (this.#htmlFullscreenId === tab.id) {
      const [fullWidth, fullHeight] = this.#window.getContentSize();
      tab.view.setBounds({ x: 0, y: 0, width: fullWidth, height: fullHeight });
      return;
    }
    tab.view.setBounds({ x, y, width: Math.max(0, width), height: Math.max(0, height) });
  }

  #setTitle(tab) {
    if (tab.id !== this.#activeId || this.#window.isDestroyed()) return;
    this.#window.setTitle(tab.title ? `${tab.title} - BOBO` : 'BOBO');
  }

  #emit() {
    if (this.#disposed) return;
    this.#onChange(this.snapshot());
  }
}

module.exports = { TabManager, NEWTAB_FILE, ERROR_FILE, PRELOAD };
