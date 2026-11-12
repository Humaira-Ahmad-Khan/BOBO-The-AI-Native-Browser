'use strict';

/**
 * Tool settings: enable/disable, toolbar pinning and per-tool preferences.
 *
 * Unknown ids and unknown fields are ignored rather than stored, so a stale
 * renderer cannot write arbitrary keys into the settings file.
 */

const { JsonFile } = require('./lib');
const { DEFAULT_SETTINGS, TOOLS, publicTool } = require('./registry');
const { isSearchEngine, publicSearchEngines } = require('../search');
const { normalizeLauncherPrefs } = require('../google-apps');
const { SAVED_GROUPS_KEYS } = require('../shortcuts');

const TOOL_IDS = new Set(TOOLS.map((tool) => tool.id));
const FONT_SIZES = { min: 13, max: 24 };
const STARTUP_MODES = new Set(['newtab', 'continue', 'specific']);
const MAX_STARTUP_URLS = 20;
const RETENTION_DAYS = new Set([0, 7, 30, 90, 365]);

function startupUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Stored values are filtered; user input is validated with parseStartupUrls. */
function sanitizeStartupUrls(value) {
  if (!Array.isArray(value)) return [];
  return value.map(startupUrl).filter(Boolean).slice(0, MAX_STARTUP_URLS);
}

function parseStartupUrls(value) {
  if (!Array.isArray(value)) throw new Error('BOBO: startup pages must be a list');
  if (value.length > MAX_STARTUP_URLS) throw new Error('BOBO: too many startup pages');
  return value.map((entry) => {
    const url = startupUrl(entry);
    if (!url) throw new Error('BOBO: startup pages must be normal http(s) addresses');
    return url;
  });
}

function clampFontSize(value) {
  const size = Number(value);
  if (!Number.isFinite(size)) return DEFAULT_SETTINGS.reader.fontSize;
  return Math.min(FONT_SIZES.max, Math.max(FONT_SIZES.min, Math.round(size)));
}

class SettingsService {
  #json;

  constructor({ file }) {
    this.#json = new JsonFile(file, DEFAULT_SETTINGS);
  }

  get file() {
    return this.#json.file;
  }

  /** Merge stored settings over the defaults so new fields always exist. */
  async #read() {
    const stored = await this.#json.read();
    const merged = {
      version: DEFAULT_SETTINGS.version,
      tools: {},
      reader: { ...DEFAULT_SETTINGS.reader },
      search: { ...DEFAULT_SETTINGS.search },
      browser: {
        videoDownloadButtons: false,
        alternateYouTube: false,
        youtubeAutoSkip: DEFAULT_SETTINGS.browser.youtubeAutoSkip,
        youtubeTheme: DEFAULT_SETTINGS.browser.youtubeTheme,
        tabs: { ...DEFAULT_SETTINGS.browser.tabs },
        startup: { ...DEFAULT_SETTINGS.browser.startup, urls: [] },
        bookmarks: { ...DEFAULT_SETTINGS.browser.bookmarks },
        downloads: { ...DEFAULT_SETTINGS.browser.downloads },
        history: { ...DEFAULT_SETTINGS.browser.history },
      },
      launcher: normalizeLauncherPrefs(DEFAULT_SETTINGS.launcher),
    };

    for (const tool of TOOLS) {
      const storedTool = stored.tools && stored.tools[tool.id];
      merged.tools[tool.id] = {
        enabled: storedTool ? storedTool.enabled !== false : true,
        pinned: storedTool ? storedTool.pinned === true : tool.pinnedByDefault,
        sidebar: storedTool?.sidebar !== false,
      };
    }

    if (stored.reader && Number.isFinite(Number(stored.reader.fontSize))) {
      merged.reader.fontSize = clampFontSize(stored.reader.fontSize);
    }

    // Files written before the search setting existed simply have no `search`
    // key: they get the default engine, and no other preference is touched.
    if (stored.search && isSearchEngine(stored.search.engine)) {
      merged.search.engine = stored.search.engine;
    }

    const browser = stored.browser && typeof stored.browser === 'object' ? stored.browser : {};
    if (browser.tabs && typeof browser.tabs.restoreSession === 'boolean') {
      merged.browser.tabs.restoreSession = browser.tabs.restoreSession;
    }
    // Files written before "On Startup" existed only had restoreSession.
    if (browser.startup && STARTUP_MODES.has(browser.startup.mode)) {
      merged.browser.startup.mode = browser.startup.mode;
    } else if (browser.tabs && browser.tabs.restoreSession === false) {
      merged.browser.startup.mode = 'newtab';
    }
    if (browser.startup) {
      merged.browser.startup.urls = sanitizeStartupUrls(browser.startup.urls);
    }
    if (SAVED_GROUPS_KEYS.includes(browser.tabs?.savedGroupsShortcut)) {
      merged.browser.tabs.savedGroupsShortcut = browser.tabs.savedGroupsShortcut;
    }
    if (browser.bookmarks && (typeof browser.bookmarks.barVisible === 'boolean' || typeof browser.bookmarks.barVisible === 'string')) {
      merged.browser.bookmarks.barVisible = browser.bookmarks.barVisible;
    }
    if (browser.downloads) {
      if (typeof browser.downloads.ask === 'boolean') merged.browser.downloads.ask = browser.downloads.ask;
      if (typeof browser.downloads.directory === 'string') {
        merged.browser.downloads.directory = browser.downloads.directory.slice(0, 260);
      }
    }
    if (browser.history && RETENTION_DAYS.has(Number(browser.history.retentionDays))) {
      merged.browser.history.retentionDays = Number(browser.history.retentionDays);
    }
    if (['dark', 'light', 'default'].includes(browser.youtubeTheme)) {
      merged.browser.youtubeTheme = browser.youtubeTheme;
    }
    merged.browser.youtubeAutoSkip = browser.youtubeAutoSkip === true;
    merged.browser.alternateYouTube = browser.alternateYouTube === true;
    merged.browser.videoDownloadButtons = browser.videoDownloadButtons === true;

    if (stored.launcher) {
      merged.launcher = normalizeLauncherPrefs(stored.launcher);
    }

    return merged;
  }

  async state() {
    const settings = await this.#read();
    return {
      tools: TOOLS.map((tool) => publicTool(tool, settings)),
      reader: settings.reader,
      search: { engine: settings.search.engine, options: publicSearchEngines() },
      browser: settings.browser,
      recovered: this.#json.recovered,
      storage: this.#json.file,
    };
  }

  /** Cached-by-main browser preferences (no tool data). */
  async browserPrefs() {
    return (await this.#read()).browser;
  }

  /** Only known browser fields are accepted; anything else is ignored. */
  async setBrowserPrefs(payload = {}) {
    const settings = await this.#read();
    if (Object.hasOwn(payload, 'videoDownloadButtons')) {
      if (typeof payload.videoDownloadButtons !== 'boolean') throw new Error('BOBO: invalid video button preference');
      settings.browser.videoDownloadButtons = payload.videoDownloadButtons;
    }
    if (Object.hasOwn(payload, 'alternateYouTube')) {
      if (typeof payload.alternateYouTube !== 'boolean') throw new Error('BOBO: invalid alternate YouTube preference');
      settings.browser.alternateYouTube = payload.alternateYouTube;
    }
    if (Object.hasOwn(payload, 'youtubeAutoSkip')) {
      if (typeof payload.youtubeAutoSkip !== 'boolean') throw new Error('BOBO: invalid YouTube auto-skip preference');
      settings.browser.youtubeAutoSkip = payload.youtubeAutoSkip;
    }
    if (Object.hasOwn(payload, 'youtubeTheme')) {
      if (!['dark', 'light', 'default'].includes(payload.youtubeTheme)) throw new Error('BOBO: invalid YouTube theme');
      settings.browser.youtubeTheme = payload.youtubeTheme;
    }
    const tabs = payload.tabs && typeof payload.tabs === 'object' ? payload.tabs : {};
    const startup = payload.startup && typeof payload.startup === 'object' ? payload.startup : {};
    const bookmarks = payload.bookmarks && typeof payload.bookmarks === 'object' ? payload.bookmarks : {};
    const downloads = payload.downloads && typeof payload.downloads === 'object' ? payload.downloads : {};
    const history = payload.history && typeof payload.history === 'object' ? payload.history : {};

    if (typeof tabs.restoreSession === 'boolean') {
      settings.browser.tabs.restoreSession = tabs.restoreSession;
      settings.browser.startup.mode = tabs.restoreSession ? 'continue' : 'newtab';
    }
    if (Object.hasOwn(startup, 'mode')) {
      if (!STARTUP_MODES.has(startup.mode)) throw new Error('BOBO: unknown startup mode');
      settings.browser.startup.mode = startup.mode;
      // Keep the legacy flag consistent for older settings readers.
      settings.browser.tabs.restoreSession = startup.mode === 'continue';
    }
    if (Object.hasOwn(startup, 'urls')) {
      settings.browser.startup.urls = parseStartupUrls(startup.urls);
    }
    if (tabs.savedGroupsShortcut === '' || SAVED_GROUPS_KEYS.includes(tabs.savedGroupsShortcut)) {
      settings.browser.tabs.savedGroupsShortcut = tabs.savedGroupsShortcut;
    }
    if (typeof bookmarks.barVisible === 'boolean' || typeof bookmarks.barVisible === 'string') {
      settings.browser.bookmarks.barVisible = bookmarks.barVisible;
    }
    if (typeof downloads.ask === 'boolean') {
      settings.browser.downloads.ask = downloads.ask;
    }
    if (typeof downloads.directory === 'string') {
      if (downloads.directory.length > 260 || downloads.directory.includes('\u0000')) {
        throw new Error('BOBO: invalid download folder');
      }
      settings.browser.downloads.directory = downloads.directory.trim();
    }
    if (Object.hasOwn(history, 'retentionDays')) {
      const days = Number(history.retentionDays);
      if (!RETENTION_DAYS.has(days)) throw new Error('BOBO: invalid history retention');
      settings.browser.history.retentionDays = days;
    }

    await this.#json.write(settings);
    return this.state();
  }

  /** The engine the address bar and the New Tab page must use. */
  async searchEngine() {
    return (await this.#read()).search.engine;
  }

  async setSearchEngine(id) {
    if (!isSearchEngine(id)) throw new Error('BOBO: unknown search engine');
    const settings = await this.#read();
    settings.search.engine = id;
    await this.#json.write(settings);
    return this.state();
  }

  /** The locally managed Google services launcher preferences. */
  async launcherPrefs() {
    return (await this.#read()).launcher;
  }

  /**
   * Persist launcher preferences. Only known ids and boolean flags survive;
   * omitted fields keep their current value.
   */
  async setLauncherPrefs(payload = {}) {
    const settings = await this.#read();
    const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
    const next = { ...settings.launcher };
    if (Array.isArray(source.order)) next.order = source.order;
    if (Array.isArray(source.hidden)) next.hidden = source.hidden;
    if (typeof source.openInNewTab === 'boolean') next.openInNewTab = source.openInNewTab;

    settings.launcher = normalizeLauncherPrefs(next);
    await this.#json.write(settings);
    return settings.launcher;
  }

  /** Enable/disable or pin/unpin one tool. */
  async configure(payload) {
    const id = String(payload?.id ?? '');
    if (!TOOL_IDS.has(id)) throw new Error('BOBO: unknown tool');

    const settings = await this.#read();
    const tool = settings.tools[id];

    if (typeof payload.enabled === 'boolean') tool.enabled = payload.enabled;
    if (typeof payload.pinned === 'boolean') tool.pinned = payload.pinned;
    if (typeof payload.sidebar === 'boolean') tool.sidebar = payload.sidebar;

    await this.#json.write(settings);
    return this.state();
  }

  /** Reader preferences (and any future scalar pref, whitelisted by name). */
  async setPrefs(payload) {
    const settings = await this.#read();
    if (payload && payload.fontSize != null) {
      settings.reader.fontSize = clampFontSize(payload.fontSize);
    }
    await this.#json.write(settings);
    return this.state();
  }

  async resetTools() {
    const settings = await this.#read(); // keeps search and any future browser prefs
    settings.tools = Object.fromEntries(
      TOOLS.map((tool) => [tool.id, { enabled: true, pinned: tool.pinnedByDefault }])
    );
    settings.reader = { ...DEFAULT_SETTINGS.reader };
    await this.#json.write(settings);
    return this.state();
  }
}

module.exports = {
  FONT_SIZES,
  MAX_STARTUP_URLS,
  RETENTION_DAYS,
  STARTUP_MODES,
  SettingsService,
  clampFontSize,
  parseStartupUrls,
  sanitizeStartupUrls,
};
