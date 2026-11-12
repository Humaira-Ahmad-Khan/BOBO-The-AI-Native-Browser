'use strict';

const { MAX_INPUT } = require('./navigation');

/**
 * SQLite persistence service for Microsoft Edge-style Saved Tab Groups.
 * Groups can be saved to disk, listed, deleted, and reopened with one click.
 */

const VALID_COLORS = new Set([
  'blue',
  'grey',
  'gray',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan',
  'orange',
]);

function savedGroupUrl(value) {
  if (typeof value !== 'string' || value.length > MAX_INPUT || !/^https?:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password) return null;
    // Query strings and fragments may carry session tokens or OAuth responses.
    url.search = '';
    url.hash = '';
    return url.href.length <= MAX_INPUT ? url.href : null;
  } catch {
    return null;
  }
}

function cleanTabs(tabs) {
  if (!Array.isArray(tabs)) throw new Error('BOBO: invalid saved tabs');
  const clean = tabs.flatMap((tab) => {
    const url = !tab?.private && !tab?.isLocal && savedGroupUrl(tab?.url);
    return url ? [{ url }] : [];
  });
  if (!clean.length) throw new Error('This group has no eligible web tabs to save.');
  return clean;
}

class SavedGroupsService {
  #store;

  constructor({ store }) {
    if (!store) throw new Error('BOBO: SavedGroupsService needs a database store');
    this.#store = store;
  }

  #db() {
    return this.#store.open();
  }

  save({ name, color = 'blue', tabs = [] }) {
    const title = String(name || '').trim().slice(0, 120) || 'Saved Group';
    const entries = cleanTabs(tabs);
    const cleanColor = VALID_COLORS.has(String(color).toLowerCase()) ? String(color).toLowerCase() : 'blue';
    const now = Date.now();
    const db = this.#db();

    const insertGroup = db.prepare(`
      INSERT INTO saved_tab_groups (name, color, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `);

    return this.#store.transaction(() => {
      const info = insertGroup.run(title, cleanColor, now, now);
      const groupId = Number(info.lastInsertRowid);

      this.#writeTabs(groupId, entries);

      return this.get(groupId);
    });
  }

  #writeTabs(id, entries) {
    const insert = this.#db().prepare(
      'INSERT INTO saved_group_tabs (group_id, url, position) VALUES (?, ?, ?)'
    );
    entries.forEach(({ url }, position) => insert.run(id, url, position));
  }

  update(id, { name, color, tabs } = {}) {
    const current = this.get(id);
    if (!current) return null;
    const title = name === undefined ? current.name : typeof name === 'string' && name.trim().slice(0, 120);
    const tint = color === undefined ? current.color : color;
    if (!title || !VALID_COLORS.has(tint)) throw new Error('Enter a group name and choose a valid colour.');
    const entries = tabs === undefined ? null : cleanTabs(tabs);
    return this.#store.transaction(() => {
      const db = this.#db();
      db.prepare('UPDATE saved_tab_groups SET name = ?, color = ?, updated_at = ? WHERE id = ?')
        .run(title, tint, Math.max(Date.now(), current.updatedAt + 1), id);
      if (entries) {
        db.prepare('DELETE FROM saved_group_tabs WHERE group_id = ?').run(id);
        this.#writeTabs(id, entries);
      }
      return this.get(id);
    });
  }

  list() {
    const db = this.#db();
    const groups = db.prepare(`
      SELECT id, name, color, created_at AS createdAt, updated_at AS updatedAt
      FROM saved_tab_groups
      ORDER BY updated_at DESC
    `).all();

    const tabStmt = db.prepare(`
      SELECT id, group_id AS groupId, url, title, position
      FROM saved_group_tabs
      WHERE group_id = ?
      ORDER BY position ASC, id ASC
    `);

    return groups.map((group) => {
      const groupTabs = tabStmt.all(group.id);
      return {
        ...group,
        tabCount: groupTabs.length,
        tabs: groupTabs,
      };
    });
  }

  get(id) {
    const db = this.#db();
    const group = db.prepare(`
      SELECT id, name, color, created_at AS createdAt, updated_at AS updatedAt
      FROM saved_tab_groups
      WHERE id = ?
    `).get(Number(id));

    if (!group) return null;

    const tabs = db.prepare(`
      SELECT id, group_id AS groupId, url, title, position
      FROM saved_group_tabs
      WHERE group_id = ?
      ORDER BY position ASC, id ASC
    `).all(group.id);

    return {
      ...group,
      tabCount: tabs.length,
      tabs,
    };
  }

  delete(id) {
    const numId = Number(id);
    if (!Number.isInteger(numId) || numId < 1) return false;
    const stmt = this.#db().prepare(`DELETE FROM saved_tab_groups WHERE id = ?`);
    const info = stmt.run(numId);
    return info.changes > 0;
  }
}

module.exports = { SavedGroupsService, VALID_COLORS, savedGroupUrl };
