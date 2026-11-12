'use strict';

/**
 * Window/tab session persistence.
 *
 * Kept as a small JSON file rather than SQLite: it is written shortly after the
 * last tab change, read once at startup, and losing it must never damage real
 * browser data. Writes are atomic; a corrupt file is quarantined and treated as
 * "no previous session", so the browser still opens.
 *
 * Schema v2 stores every normal window with its geometry, pinned/grouped tabs
 * and per-URL crash counts. Version 1 files (a single flat tab list) are still
 * read and converted, so upgrading loses nothing.
 *
 * Only normal http(s) tabs are stored. Local BOBO pages, private tabs, form
 * contents and cookies are deliberately not part of this file.
 */

const fs = require('node:fs');
const path = require('node:path');
const { VALID_COLORS } = require('./saved-groups');

const VERSION = 2;
const MAX_WINDOWS = 8;
const MAX_TABS = 50;
const MAX_GROUPS = 32;
const MAX_CLOSED = 12;
const MAX_TITLE = 200;
const MAX_NAME = 120;
const MAX_CRASH_COUNT = 10;

/** A restored window larger/smaller than this is treated as corrupt. */
const BOUNDS_LIMITS = { width: [480, 12000], height: [320, 12000], offset: 50000 };

const DEFAULT_BOUNDS = { x: 80, y: 60, width: 1280, height: 840 };

const EMPTY = { version: VERSION, windows: [], cleanExit: true, savedAt: 0 };

const GROUP_KEY = /^[A-Za-z0-9:_-]{1,80}$/;
const SAVED_KEY = /^\d{1,16}:\d{1,16}$/;

function isWebUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
  } catch {
    return false;
  }
}

function cleanBounds(value) {
  if (!value || typeof value !== 'object') return null;
  const numbers = ['x', 'y', 'width', 'height'].map((key) => Number(value[key]));
  if (numbers.some((n) => !Number.isFinite(n))) return null;
  const [x, y, width, height] = numbers.map((n) => Math.round(n));
  if (width < BOUNDS_LIMITS.width[0] || width > BOUNDS_LIMITS.width[1]
    || height < BOUNDS_LIMITS.height[0] || height > BOUNDS_LIMITS.height[1]
    || Math.abs(x) > BOUNDS_LIMITS.offset || Math.abs(y) > BOUNDS_LIMITS.offset) {
    return null;
  }
  return { x, y, width, height };
}

/**
 * Keep a restored window reachable when monitors changed since the last run.
 * `displays` is the array Electron's screen.getAllDisplays() returns.
 */
function fitBounds(bounds, displays, fallback = DEFAULT_BOUNDS) {
  const requested = cleanBounds(bounds) || { ...fallback };
  const areas = (Array.isArray(displays) ? displays : [])
    .map((display) => display?.workArea || display?.bounds)
    .filter((area) => area && ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(Number(area[key]))));
  if (!areas.length) return requested;

  const visible = (area) => {
    const width = Math.min(requested.x + requested.width, area.x + area.width) - Math.max(requested.x, area.x);
    const height = Math.min(requested.y + requested.height, area.y + area.height) - Math.max(requested.y, area.y);
    return Math.max(0, width) >= 160 && Math.max(0, height) >= 120;
  };
  if (areas.some(visible)) return requested;

  const area = areas[0];
  const width = Math.min(requested.width, Number(area.width));
  const height = Math.min(requested.height, Number(area.height));
  return {
    x: Math.round(Number(area.x) + (Number(area.width) - width) / 2),
    y: Math.round(Number(area.y) + (Number(area.height) - height) / 2),
    width: Math.round(width),
    height: Math.round(height),
  };
}

function sanitizeGroup(input) {
  if (!input || typeof input !== 'object') return null;
  const key = typeof input.key === 'string' ? input.key : '';
  if (!GROUP_KEY.test(key)) return null;
  const color = String(input.color || 'blue').toLowerCase();
  return {
    key,
    name: (typeof input.name === 'string' ? input.name : 'New Group').trim().slice(0, MAX_NAME) || 'New Group',
    color: VALID_COLORS.has(color) ? color : 'blue',
    collapsed: input.collapsed === true,
    ...(typeof input.savedKey === 'string' && SAVED_KEY.test(input.savedKey)
      ? { savedKey: input.savedKey } : {}),
  };
}

function sanitizeWindow(input) {
  const source = input && typeof input === 'object' ? input : {};
  const groups = [];
  const groupKeys = new Set();
  const addGroup = (group) => {
    if (!group || groupKeys.has(group.key) || groups.length >= MAX_GROUPS) return;
    groupKeys.add(group.key);
    groups.push(group);
  };

  for (const raw of Array.isArray(source.groups) ? source.groups.slice(0, MAX_GROUPS) : []) {
    addGroup(sanitizeGroup(raw));
  }

  const tabEntries = (Array.isArray(source.tabs) ? source.tabs : [])
    .slice(0, MAX_TABS)
    .flatMap((tab, index) => {
      if (!tab || typeof tab !== 'object' || tab.private === true || tab.isLocal === true) return [];
      if (!isWebUrl(tab.url)) return [];

      // Version 1 stored group metadata on each tab instead of a group list.
      const legacy = tab.savedGroup;
      let groupKey = typeof tab.groupKey === 'string' && GROUP_KEY.test(tab.groupKey) ? tab.groupKey : null;
      if (legacy && typeof legacy.key === 'string' && SAVED_KEY.test(legacy.key)) {
        addGroup(sanitizeGroup({
          key: legacy.key,
          name: legacy.name,
          color: legacy.color,
          savedKey: legacy.key,
        }));
        groupKey = groupKey || legacy.key;
      }
      if (groupKey && !groupKeys.has(groupKey)) groupKey = null;

      const crashCount = Number(tab.crashCount);
      return [{
        index,
        entry: {
          url: tab.url,
          title: (typeof tab.title === 'string' ? tab.title : '').trim().slice(0, MAX_TITLE),
          pinned: tab.pinned === true,
          groupKey,
          crashCount: Number.isInteger(crashCount) ? Math.max(0, Math.min(MAX_CRASH_COUNT, crashCount)) : 0,
        },
      }];
    });
  const tabs = tabEntries.map(({ entry }) => entry);

  const requestedIndex = Number.isInteger(source.activeIndex) ? source.activeIndex : 0;
  const activeEntry = tabEntries.find(({ index }) => index >= requestedIndex);
  const activeIndex = activeEntry ? tabs.indexOf(activeEntry.entry) : Math.max(0, tabs.length - 1);

  const closed = (Array.isArray(source.closed) ? source.closed : [])
    .slice(0, MAX_CLOSED)
    .filter((entry) => entry && entry.private !== true && isWebUrl(entry.url))
    .map((entry) => ({
      url: String(entry.url),
      title: String(entry.title || '').slice(0, MAX_TITLE),
    }));

  return {
    bounds: cleanBounds(source.bounds) || { ...DEFAULT_BOUNDS },
    maximized: source.maximized === true,
    activeIndex,
    tabs,
    groups,
    closed,
  };
}

function sanitize(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const rawWindows = Array.isArray(input.windows)
    ? input.windows
    : Array.isArray(input.tabs)
      ? [{ tabs: input.tabs, activeIndex: input.activeIndex, closed: input.closed, groups: input.groups }]
      : [];

  const windows = rawWindows.slice(0, MAX_WINDOWS).map(sanitizeWindow);
  return {
    version: VERSION,
    windows,
    cleanExit: input.cleanExit === true,
    savedAt: Number(input.savedAt) || 0,
  };
}

class SessionStore {
  #file;
  #recovered = false;

  constructor({ file }) {
    if (typeof file !== 'string' || !file) throw new Error('BOBO: session store needs a file');
    this.#file = file;
  }

  get file() {
    return this.#file;
  }

  get recovered() {
    return this.#recovered;
  }

  read() {
    try {
      const raw = fs.readFileSync(this.#file, 'utf8');
      return sanitize(JSON.parse(raw));
    } catch (error) {
      if (error.code === 'ENOENT') return sanitize(EMPTY);
      try {
        fs.renameSync(this.#file, `${this.#file}.corrupt-${Date.now()}`);
      } catch {
        // If it cannot be moved aside, starting empty is still safe.
      }
      this.#recovered = true;
      return sanitize(EMPTY);
    }
  }

  write(payload, { cleanExit = false } = {}) {
    const data = sanitize({ ...payload, cleanExit, savedAt: Date.now() });
    fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    const temp = `${this.#file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(temp, this.#file);
    return data;
  }

  /**
   * Copy the current session aside before it is replaced (for example when the
   * user chooses "start fresh" after a crash). Returns the backup path or null.
   */
  preserve(tag = 'recovery') {
    const safeTag = String(tag).replace(/[^a-z0-9-]/gi, '').slice(0, 24) || 'recovery';
    try {
      if (!fs.existsSync(this.#file)) return null;
      const target = `${this.#file}.${safeTag}-${Date.now()}.json`;
      fs.copyFileSync(this.#file, target);
      return target;
    } catch {
      return null;
    }
  }
}

module.exports = {
  BOUNDS_LIMITS,
  DEFAULT_BOUNDS,
  EMPTY,
  MAX_CLOSED,
  MAX_CRASH_COUNT,
  MAX_TABS,
  MAX_WINDOWS,
  SessionStore,
  VERSION,
  fitBounds,
  sanitize,
  sanitizeWindow,
};
