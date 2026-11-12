'use strict';

/**
 * Browsing history: successful normal-mode visits only.
 *
 * Local BOBO pages, failed loads and private tabs never reach this service -
 * the tab manager decides what to record, and the IPC layer additionally only
 * accepts http(s) origins.
 */

const { cleanText, optionalUrl } = require('./tools/lib');

const MAX_TITLE = 200;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

const RANGES = {
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 28 * 24 * 60 * 60 * 1000,
};

function historyUrl(value) {
  const valid = optionalUrl(value);
  if (!valid) return '';
  const url = new URL(valid);
  url.username = '';
  url.password = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^(?:access[-_]?token|refresh[-_]?token|id[-_]?token|token|password|passwd|secret|api[-_]?key|session[-_]?id|code|otp)$/i.test(key)) {
      url.searchParams.delete(key);
    }
  }
  if (/(?:^|[&#?])(?:access_token|id_token|refresh_token|password|code)=/i.test(url.hash)) url.hash = '';
  return url.href;
}

function limitOf(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.round(n)));
}

function rowToEntry(row) {
  return { id: row.id, url: row.url, title: row.title, visitedAt: row.visited_at };
}

class HistoryService {
  #store;
  #now;

  constructor({ store, now = () => Date.now() }) {
    this.#store = store;
    this.#now = now;
  }

  #db() {
    return this.#store.open();
  }

  /** Returns the stored visit, or null when the URL is not a normal web page. */
  record(payload = {}) {
    const url = historyUrl(payload.url);
    if (!url) return null;
    const title = cleanText(payload.title, MAX_TITLE) || url;
    const visitedAt = Number.isFinite(Number(payload.visitedAt)) ? Math.round(Number(payload.visitedAt)) : this.#now();
    const result = this.#db()
      .prepare('INSERT INTO history (url, title, visited_at) VALUES (?, ?, ?)')
      .run(url, title, visitedAt);
    return rowToEntry(this.#db().prepare('SELECT * FROM history WHERE id = ?').get(Number(result.lastInsertRowid)));
  }

  list(payload = {}) {
    const query = cleanText(payload.query, 200);
    const limit = limitOf(payload.limit);
    const offset = Math.max(0, Math.round(Number(payload.offset) || 0));

    if (!query) {
      const rows = this.#db()
        .prepare('SELECT * FROM history ORDER BY visited_at DESC, id DESC LIMIT ? OFFSET ?')
        .all(limit, offset);
      return { entries: rows.map(rowToEntry), total: this.count(), limit, offset };
    }

    const like = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = this.#db()
      .prepare(
        `SELECT * FROM history
         WHERE url LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\'
         ORDER BY visited_at DESC, id DESC LIMIT ? OFFSET ?`
      )
      .all(like, like, limit, offset);
    const total = this.#db()
      .prepare(
        `SELECT COUNT(*) AS n FROM history WHERE url LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\'`
      )
      .get(like, like);
    return { entries: rows.map(rowToEntry), total: Number(total.n) || 0, limit, offset };
  }

  count() {
    const row = this.#db().prepare('SELECT COUNT(*) AS n FROM history').get();
    return Number(row.n) || 0;
  }

  remove(payload = {}) {
    const id = Number(payload.id ?? payload);
    if (!Number.isInteger(id) || id < 1) throw new Error('BOBO: invalid history id');
    const result = this.#db().prepare('DELETE FROM history WHERE id = ?').run(id);
    return { ok: true, removed: Number(result.changes) };
  }

  /** range: 'hour' | 'day' | 'week' | 'month' | 'all'. */
  clear(payload = {}) {
    const range = payload.range;
    if (range === 'all') {
      const result = this.#db().prepare('DELETE FROM history').run();
      return { ok: true, removed: Number(result.changes) };
    }
    if (!Object.hasOwn(RANGES, range)) throw new Error('BOBO: unknown history range');
    const cutoff = this.#now() - RANGES[range];
    const result = this.#db().prepare('DELETE FROM history WHERE visited_at >= ?').run(cutoff);
    return { ok: true, removed: Number(result.changes) };
  }
}

module.exports = { HistoryService, RANGES, rowToEntry, historyUrl };
