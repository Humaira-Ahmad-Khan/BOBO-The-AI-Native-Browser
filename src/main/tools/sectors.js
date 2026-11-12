'use strict';

/**
 * SQLite persistence and query service for the BOBO Quick Sector Selector.
 * Caches sector dropdown options locally for instant, offline-capable search
 * and DOM auto-selection on municipal e-billing portals (e.g. elgcd.punjab.gov.pk).
 */

const DEFAULT_DOMAIN = 'elgcd.punjab.gov.pk';

class SectorSelectorService {
  #store;

  constructor({ store }) {
    if (!store) throw new Error('BOBO: SectorSelectorService requires a database store');
    this.#store = store;
  }

  #db() {
    return this.#store.open();
  }

  saveSectors(items, domain = DEFAULT_DOMAIN) {
    if (!Array.isArray(items)) throw new Error('BOBO: items must be an array');
    const cleanDomain = String(domain || DEFAULT_DOMAIN).trim().toLowerCase();
    const now = Date.now();
    const db = this.#db();

    const insertStmt = db.prepare(`
      INSERT INTO sectors (code, name, value, domain, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(code, value, domain) DO UPDATE SET
        name = excluded.name,
        created_at = excluded.created_at
    `);

    let saved = 0;
    this.#store.transaction(() => {
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const code = String(item.code || '').trim();
        const value = String(item.value || '').trim();
        const name = String(item.name || '').trim();

        // Skip placeholders
        if (!value || !code || isPlaceholder(name)) continue;

        insertStmt.run(code, name, value, cleanDomain, now);
        saved++;
      }
    });

    return { ok: true, saved, total: this.countSectors(cleanDomain) };
  }

  listSectors(query = '', domain = DEFAULT_DOMAIN) {
    const cleanDomain = String(domain || DEFAULT_DOMAIN).trim().toLowerCase();
    const q = String(query || '').trim();
    const db = this.#db();

    if (!q) {
      return db.prepare(`
        SELECT id, code, name, value, domain
        FROM sectors
        WHERE domain = ?
        ORDER BY CAST(code AS INTEGER) ASC, name ASC
        LIMIT 200
      `).all(cleanDomain);
    }

    const pattern = `%${q}%`;
    return db.prepare(`
      SELECT id, code, name, value, domain
      FROM sectors
      WHERE domain = ? AND (code LIKE ? OR name LIKE ?)
      ORDER BY CAST(code AS INTEGER) ASC, name ASC
      LIMIT 100
    `).all(cleanDomain, pattern, pattern);
  }

  countSectors(domain = DEFAULT_DOMAIN) {
    const cleanDomain = String(domain || DEFAULT_DOMAIN).trim().toLowerCase();
    const row = this.#db().prepare(`
      SELECT COUNT(*) AS count FROM sectors WHERE domain = ?
    `).get(cleanDomain);
    return row ? row.count : 0;
  }

  clearSectors(domain = DEFAULT_DOMAIN) {
    const cleanDomain = String(domain || DEFAULT_DOMAIN).trim().toLowerCase();
    const info = this.#db().prepare(`
      DELETE FROM sectors WHERE domain = ?
    `).run(cleanDomain);
    return { ok: true, deleted: info.changes };
  }
}

function isPlaceholder(text) {
  const lower = String(text || '').trim().toLowerCase();
  return (
    !lower ||
    lower.startsWith('select') ||
    lower.startsWith('--') ||
    lower === 'choose sector' ||
    lower === 'all sectors' ||
    lower === 'none'
  );
}

module.exports = { SectorSelectorService, DEFAULT_DOMAIN, isPlaceholder };
