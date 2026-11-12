'use strict';

/**
 * Bookmarks: folders, the bar, favourites, Chrome HTML import/export.
 *
 * Pure domain layer over the SQLite store - no Electron, no file dialogs. The
 * renderer never sees SQL; the IPC layer validates the same shapes again.
 *
 * Roots are fixed rows: 1 = Bookmarks bar, 2 = Other bookmarks. They can be
 * renamed by the user but never deleted, so a bookmark always has a home.
 */

const { cleanText, optionalUrl } = require('./tools/lib');

const ROOT_BAR = 1;
const ROOT_OTHER = 2;
const ROOTS = [ROOT_BAR, ROOT_OTHER];
const MAX_TITLE = 200;
const MAX_NAME = 120;
const MAX_IMPORT_BYTES = 8 * 1024 * 1024;
const MAX_IMPORT_NODES = 20000;

function normalizeUrl(value) {
  const url = optionalUrl(value);
  if (!url) throw new Error('BOBO: a bookmark needs an http(s) URL');
  return url;
}

function defaultTitle(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || url;
  } catch {
    return url;
  }
}

function folderName(value) {
  const name = cleanText(value, MAX_NAME);
  if (!name) throw new Error('BOBO: a folder needs a name');
  return name;
}

function readId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw new Error('BOBO: invalid id');
  return id;
}

function rowToBookmark(row) {
  return {
    id: row.id,
    folderId: row.folder_id,
    url: row.url,
    title: row.title,
    favourite: row.favourite === 1,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToFolder(row) {
  return {
    id: row.id,
    parentId: row.parent_id,
    name: row.name,
    position: row.position,
    root: row.parent_id == null,
  };
}

// --- Chrome bookmark HTML ---------------------------------------------------

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(value) {
  return String(value).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    const named = ENTITIES[body.toLowerCase()];
    return named == null ? match : named;
  });
}

function stripTags(value) {
  return decodeEntities(String(value).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function hrefOf(attributes) {
  const match = /href\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attributes || '');
  return match ? decodeEntities(match[1] ?? match[2] ?? '') : '';
}

/**
 * Parse a Netscape/Chrome bookmark export into nested nodes.
 * Unknown URLs (javascript:, place:, file:) are ignored, never stored.
 */
function parseBookmarkHtml(html, stats = { invalid: 0 }) {
  if (typeof html !== 'string') throw new Error('BOBO: invalid bookmark file');
  if (html.length > MAX_IMPORT_BYTES) throw new Error('BOBO: bookmark file is too large');
  html = html.replace(/<!--[\s\S]*?(?:-->|$)|<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '');

  const root = { children: [] };
  const stack = [root];
  let pendingFolder = '';
  let nodes = 0;

  const tokens = /<h3\b[^>]*>([\s\S]*?)<\/h3>|<a\b([^>]*)>([\s\S]*?)<\/a>|<\/dl\s*>|<dl\b[^>]*>/gi;
  let match;

  while ((match = tokens.exec(html))) {
    if (++nodes > MAX_IMPORT_NODES) throw new Error('BOBO: bookmark file has too many entries');

    if (match[1] !== undefined) {
      pendingFolder = stripTags(match[1]).slice(0, MAX_NAME);
      continue;
    }

    if (match[2] !== undefined) {
      const href = hrefOf(match[2]);
      const title = stripTags(match[3]).slice(0, MAX_TITLE);
      let url = '';
      try { if (href) url = optionalUrl(href); } catch {}
      if (!url) stats.invalid += 1;
      if (url) stack[stack.length - 1].children.push({ type: 'bookmark', url, title: title || defaultTitle(url) });
      pendingFolder = '';
      continue;
    }

    if (/^<dl/i.test(match[0])) {
      if (pendingFolder) {
        const folder = { type: 'folder', name: pendingFolder, children: [] };
        stack[stack.length - 1].children.push(folder);
        stack.push(folder);
        pendingFolder = '';
      }
      continue;
    }

    if (stack.length > 1) stack.pop();
    pendingFolder = '';
  }

  return root.children;
}

function isRootName(name) {
  const value = String(name || '').toLowerCase();
  return value === 'bookmarks bar' || value === 'bookmarks toolbar' || value === 'favorites bar';
}

function isOtherName(name) {
  const value = String(name || '').toLowerCase();
  return value === 'other bookmarks' || value === 'other favorites' || value === 'bookmarks menu';
}

function folderHtml(folder, children, indent) {
  const pad = '  '.repeat(indent);
  const lines = [`${pad}<DT><H3>${escapeHtml(folder.name)}</H3>`, `${pad}<DL><p>`];
  for (const child of children.folders) lines.push(folderHtml(child, child.children, indent + 1));
  for (const bookmark of children.bookmarks) {
    lines.push(
      `${'  '.repeat(indent + 1)}<DT><A HREF="${escapeHtml(bookmark.url)}">${escapeHtml(bookmark.title)}</A>`
    );
  }
  lines.push(`${pad}</DL><p>`);
  return lines.join('\n');
}

/** Render a Chrome-compatible export from flat folder/bookmark rows. */
function toBookmarkHtml(folders, bookmarks) {
  const byParent = new Map();
  for (const folder of folders) {
    if (!byParent.has(folder.parentId)) byParent.set(folder.parentId, []);
    byParent.get(folder.parentId).push(folder);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.position - b.position || a.id - b.id);

  const byFolder = new Map();
  for (const bookmark of bookmarks) {
    if (!byFolder.has(bookmark.folderId)) byFolder.set(bookmark.folderId, []);
    byFolder.get(bookmark.folderId).push(bookmark);
  }
  for (const list of byFolder.values()) list.sort((a, b) => a.position - b.position || a.id - b.id);

  const build = (folder) => ({
    folders: (byParent.get(folder.id) || []).map((child) => ({ ...child, children: build(child) })),
    bookmarks: byFolder.get(folder.id) || [],
  });

  const roots = [...(byParent.get(null) || [])].sort((a, b) => a.position - b.position || a.id - b.id);
  const body = roots.map((folder) => folderHtml(folder, build(folder), 1)).join('\n');

  return [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<!-- This is an automatically generated file. It will be read and overwritten. -->',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>',
    body,
    '</DL><p>',
    '',
  ].join('\n');
}

// --- service ----------------------------------------------------------------

class BookmarksService {
  #store;
  #now;

  constructor({ store, now = () => Date.now() }) {
    this.#store = store;
    this.#now = now;
  }

  #db() {
    return this.#store.open();
  }

  #folder(id) {
    const row = this.#db().prepare('SELECT * FROM bookmark_folders WHERE id = ?').get(readId(id));
    return row ? rowToFolder(row) : null;
  }

  #nextPosition(folderId) {
    const row = this.#db()
      .prepare(`SELECT COALESCE(MAX(position), -1) + 1 AS next FROM (
        SELECT position FROM bookmarks WHERE folder_id = ?
        UNION ALL SELECT position FROM bookmark_folders WHERE parent_id = ?
      )`)
      .get(folderId, folderId);
    return Number(row.next) || 0;
  }

  list() {
    const folders = this.#db()
      .prepare('SELECT * FROM bookmark_folders ORDER BY parent_id IS NOT NULL, position, id')
      .all()
      .map(rowToFolder);
    const bookmarks = this.#db()
      .prepare('SELECT * FROM bookmarks ORDER BY position, id')
      .all()
      .map(rowToBookmark);
    return { folders, bookmarks, roots: ROOTS };
  }

  favourites() {
    return this.#db()
      .prepare('SELECT * FROM bookmarks WHERE favourite = 1 ORDER BY position, id')
      .all()
      .map(rowToBookmark);
  }

  suggest(query) {
    const escaped = query.replace(/[\\%_]/g, '\\$&');
    return this.#db().prepare(
      `SELECT url, title FROM bookmarks
       WHERE title LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\'
       ORDER BY title LIKE ? ESCAPE '\\' DESC, favourite DESC, updated_at DESC LIMIT 8`
    ).all(`%${escaped}%`, `%${escaped}%`, `${escaped}%`);
  }

  findByUrl(value) {
    const url = optionalUrl(value);
    if (!url) return null;
    const row = this.#db()
      .prepare('SELECT * FROM bookmarks WHERE url = ? ORDER BY id LIMIT 1')
      .get(url);
    return row ? rowToBookmark(row) : null;
  }

  add(payload = {}) {
    const url = normalizeUrl(payload.url);
    const folder = this.#folder(payload.folderId ?? ROOT_BAR) || this.#folder(ROOT_BAR);
    const title = cleanText(payload.title, MAX_TITLE) || defaultTitle(url);
    const favourite = payload.favourite === true ? 1 : 0;
    const now = this.#now();

    const result = this.#db()
      .prepare(
        `INSERT INTO bookmarks (folder_id, url, title, favourite, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(folder.id, url, title, favourite, this.#nextPosition(folder.id), now, now);

    const row = this.#db().prepare('SELECT * FROM bookmarks WHERE id = ?').get(Number(result.lastInsertRowid));
    return rowToBookmark(row);
  }

  update(payload = {}) {
    const id = readId(payload.id);
    const row = this.#db().prepare('SELECT * FROM bookmarks WHERE id = ?').get(id);
    if (!row) throw new Error('BOBO: bookmark not found');

    const url = payload.url === undefined ? row.url : normalizeUrl(payload.url);
    const title =
      payload.title === undefined ? row.title : cleanText(payload.title, MAX_TITLE) || defaultTitle(url);
    const favourite = payload.favourite === undefined ? row.favourite : payload.favourite === true ? 1 : 0;
    let folderId = row.folder_id;
    let position = row.position;

    if (payload.folderId !== undefined) {
      const folder = this.#folder(payload.folderId);
      if (!folder) throw new Error('BOBO: folder not found');
      if (folder.id !== row.folder_id) {
        folderId = folder.id;
        position = this.#nextPosition(folder.id);
      }
    }

    this.#db()
      .prepare(
        `UPDATE bookmarks SET url = ?, title = ?, favourite = ?, folder_id = ?, position = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(url, title, favourite, folderId, position, this.#now(), id);

    return rowToBookmark(this.#db().prepare('SELECT * FROM bookmarks WHERE id = ?').get(id));
  }

  remove(payload = {}) {
    const id = readId(payload.id ?? payload);
    const result = this.#db().prepare('DELETE FROM bookmarks WHERE id = ?').run(id);
    return { ok: true, removed: Number(result.changes) };
  }

  /** Star button: save the page, or remove it if it is already saved. */
  toggle(payload = {}) {
    const existing = this.findByUrl(payload.url);
    if (existing) {
      this.remove({ id: existing.id });
      return { ok: true, bookmarked: false };
    }
    const bookmark = this.add({ url: payload.url, title: payload.title, folderId: payload.folderId });
    return { ok: true, bookmarked: true, bookmark };
  }

  addFolder(payload = {}) {
    const name = folderName(payload.name);
    const parentId = payload.parentId == null ? ROOT_BAR : readId(payload.parentId);
    if (!this.#folder(parentId)) throw new Error('BOBO: parent folder not found');
    const now = this.#now();
    const result = this.#db()
      .prepare('INSERT INTO bookmark_folders (parent_id, name, position, created_at) VALUES (?, ?, ?, ?)')
      .run(parentId, name, this.#nextPosition(parentId), now);

    return rowToFolder(
      this.#db().prepare('SELECT * FROM bookmark_folders WHERE id = ?').get(Number(result.lastInsertRowid))
    );
  }

  renameFolder(payload = {}) {
    const id = readId(payload.id);
    if (!this.#folder(id)) throw new Error('BOBO: folder not found');
    const name = folderName(payload.name);
    this.#db().prepare('UPDATE bookmark_folders SET name = ? WHERE id = ?').run(name, id);
    return this.#folder(id);
  }

  removeFolder(payload = {}) {
    const id = readId(payload.id ?? payload);
    const folder = this.#folder(id);
    if (!folder) throw new Error('BOBO: folder not found');
    if (folder.root) throw new Error('BOBO: the bar and Other bookmarks cannot be deleted');
    const result = this.#db().prepare('DELETE FROM bookmark_folders WHERE id = ?').run(id);
    return { ok: true, removed: Number(result.changes) };
  }

  previewImport(html) {
    const stats = { bookmarks: 0, folders: 0, invalid: 0, duplicates: 0 };
    const nodes = parseBookmarkHtml(html, stats);
    const seen = new Set(this.#db().prepare('SELECT url FROM bookmarks').all().map((row) => row.url));
    const pending = [...nodes];
    while (pending.length) {
      const node = pending.pop();
      if (node.type === 'folder') {
        stats.folders += 1;
        pending.push(...node.children);
      } else {
        stats.bookmarks += 1;
        if (seen.has(node.url)) stats.duplicates += 1;
        seen.add(node.url);
      }
    }
    return stats;
  }

  /** Merge a browser HTML export, keeping existing bookmarks. */
  importHtml(payload = {}) {
    const nodes = parseBookmarkHtml(payload.html);
    const db = this.#db();
    const existing = new Set(db.prepare('SELECT url FROM bookmarks').all().map((row) => row.url));
    const seen = new Set();
    const orderedFolders = new Set();
    const stats = { added: 0, skipped: 0, folders: 0 };

    const insertFolder = (name, parentId) => {
      const found = db
        .prepare('SELECT * FROM bookmark_folders WHERE parent_id = ? AND lower(name) = lower(?)')
        .get(parentId, name);
      if (found) {
        if (payload.matchOrder === true && !orderedFolders.has(found.id)) {
          db.prepare('UPDATE bookmark_folders SET position = ? WHERE id = ?')
            .run(this.#nextPosition(parentId), found.id);
          orderedFolders.add(found.id);
        }
        return found.id;
      }
      stats.folders += 1;
      const result = db
        .prepare('INSERT INTO bookmark_folders (parent_id, name, position, created_at) VALUES (?, ?, ?, ?)')
        .run(parentId, name, this.#nextPosition(parentId), this.#now());
      const id = Number(result.lastInsertRowid);
      orderedFolders.add(id);
      return id;
    };

    const insertBookmark = (node, folderId) => {
      if (!node.url) return;
      if (existing.has(node.url) || seen.has(node.url)) {
        if (payload.matchOrder === true && !seen.has(node.url)) {
          const match = db.prepare('SELECT id FROM bookmarks WHERE folder_id = ? AND url = ? ORDER BY position, id LIMIT 1')
            .get(folderId, node.url);
          if (match) db.prepare('UPDATE bookmarks SET position = ? WHERE id = ?')
            .run(this.#nextPosition(folderId), match.id);
        }
        seen.add(node.url);
        stats.skipped += 1;
        return;
      }
      seen.add(node.url);
      stats.added += 1;
      db.prepare(
        `INSERT INTO bookmarks (folder_id, url, title, favourite, position, created_at, updated_at)
         VALUES (?, ?, ?, 0, ?, ?, ?)`
      ).run(folderId, node.url, node.title, this.#nextPosition(folderId), this.#now(), this.#now());
    };

    const walk = (list, parentId) => {
      for (const node of list) {
        if (node.type === 'folder') {
          walk(node.children, insertFolder(node.name, parentId));
        } else {
          insertBookmark(node, parentId);
        }
      }
    };

    this.#store.transaction(() => {
      for (const node of nodes) {
        if (node.type === 'folder' && (isRootName(node.name) || isOtherName(node.name))) {
          walk(node.children, isRootName(node.name) ? ROOT_BAR : ROOT_OTHER);
        } else if (node.type === 'folder') {
          walk([node], ROOT_OTHER);
        } else {
          insertBookmark(node, ROOT_BAR);
        }
      }
    });

    return { ok: true, ...stats };
  }

  exportHtml() {
    const { folders, bookmarks } = this.list();
    return { ok: true, html: toBookmarkHtml(folders, bookmarks) };
  }

  clear() {
    const removed = this.#db().prepare('DELETE FROM bookmarks').run();
    this.#db().prepare('DELETE FROM bookmark_folders WHERE parent_id IS NOT NULL').run();
    return { ok: true, removed: Number(removed.changes) };
  }
}

module.exports = {
  BookmarksService,
  ROOT_BAR,
  ROOT_OTHER,
  defaultTitle,
  parseBookmarkHtml,
  toBookmarkHtml,
};
