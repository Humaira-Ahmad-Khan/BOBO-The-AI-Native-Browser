'use strict';

/**
 * Local SQLite store for structured browser data (bookmarks, history,
 * downloads). Electron-free and synchronous, so `node --test` can exercise it
 * with the same engine the app runs.
 *
 * Guarantees:
 *   - the file lives wherever the caller says (the app passes userData);
 *   - migrations are ordered and run inside one transaction;
 *   - every statement uses bound parameters at the call site;
 *   - open and migration errors preserve the existing database;
 *   - a database written by a newer app is left alone, not "recovered".
 */

const fs = require('node:fs');
const path = require('node:path');

/** Ordered schema steps. Never edit a released step - append a new one. */
const MIGRATIONS = [
  {
    version: 1,
    sql: `
      CREATE TABLE bookmark_folders (
        id         INTEGER PRIMARY KEY,
        parent_id  INTEGER REFERENCES bookmark_folders(id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        position   INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE bookmarks (
        id         INTEGER PRIMARY KEY,
        folder_id  INTEGER NOT NULL REFERENCES bookmark_folders(id) ON DELETE CASCADE,
        url        TEXT NOT NULL,
        title      TEXT NOT NULL,
        favourite  INTEGER NOT NULL DEFAULT 0,
        position   INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX bookmarks_folder ON bookmarks(folder_id, position);
      CREATE INDEX bookmarks_url ON bookmarks(url);

      CREATE TABLE history (
        id         INTEGER PRIMARY KEY,
        url        TEXT NOT NULL,
        title      TEXT NOT NULL DEFAULT '',
        visited_at INTEGER NOT NULL
      );

      CREATE INDEX history_visited ON history(visited_at);
      CREATE INDEX history_url ON history(url);

      CREATE TABLE downloads (
        id             INTEGER PRIMARY KEY,
        url            TEXT NOT NULL,
        filename       TEXT NOT NULL,
        path           TEXT NOT NULL DEFAULT '',
        state          TEXT NOT NULL,
        bytes_received INTEGER NOT NULL DEFAULT 0,
        total_bytes    INTEGER NOT NULL DEFAULT 0,
        danger         INTEGER NOT NULL DEFAULT 0,
        started_at     INTEGER NOT NULL,
        finished_at    INTEGER,
        error          TEXT NOT NULL DEFAULT ''
      );

      CREATE INDEX downloads_started ON downloads(started_at);

      -- Fixed roots: the bar and "Other bookmarks" are not user-deletable.
      INSERT INTO bookmark_folders (id, parent_id, name, position, created_at) VALUES
        (1, NULL, 'Bookmarks bar', 0, CAST(strftime('%s','now') AS INTEGER) * 1000),
        (2, NULL, 'Other bookmarks', 1, CAST(strftime('%s','now') AS INTEGER) * 1000);
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE bills_jobs (
        id           INTEGER PRIMARY KEY,
        name         TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        status       TEXT NOT NULL DEFAULT 'pending',
        total_count  INTEGER NOT NULL DEFAULT 0,
        done_count   INTEGER NOT NULL DEFAULT 0,
        fail_count   INTEGER NOT NULL DEFAULT 0,
        empty_count  INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE bills_queue (
        id             INTEGER PRIMARY KEY,
        job_id         INTEGER NOT NULL REFERENCES bills_jobs(id) ON DELETE CASCADE,
        connection_no  TEXT NOT NULL,
        status         TEXT NOT NULL DEFAULT 'pending',
        consumer_info  TEXT NOT NULL DEFAULT '',
        bills_data     TEXT NOT NULL DEFAULT '',
        error          TEXT NOT NULL DEFAULT '',
        retry_count    INTEGER NOT NULL DEFAULT 0,
        updated_at     INTEGER NOT NULL
      );

      CREATE INDEX bills_queue_job ON bills_queue(job_id, status);

      CREATE TABLE column_presets (
        id           INTEGER PRIMARY KEY,
        domain       TEXT NOT NULL,
        name         TEXT NOT NULL,
        columns_json TEXT NOT NULL,
        created_at   INTEGER NOT NULL
      );

      CREATE INDEX column_presets_domain ON column_presets(domain);
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE saved_tab_groups (
        id         INTEGER PRIMARY KEY,
        name       TEXT NOT NULL,
        color      TEXT NOT NULL DEFAULT 'blue',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE saved_group_tabs (
        id         INTEGER PRIMARY KEY,
        group_id   INTEGER NOT NULL REFERENCES saved_tab_groups(id) ON DELETE CASCADE,
        url        TEXT NOT NULL,
        title      TEXT NOT NULL DEFAULT '',
        position   INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX saved_group_tabs_group ON saved_group_tabs(group_id, position);

      CREATE TABLE sectors (
        id         INTEGER PRIMARY KEY,
        code       TEXT NOT NULL,
        name       TEXT NOT NULL,
        value      TEXT NOT NULL,
        domain     TEXT NOT NULL DEFAULT 'elgcd.punjab.gov.pk',
        created_at INTEGER NOT NULL,
        UNIQUE(code, value, domain)
      );

      CREATE INDEX sectors_lookup ON sectors(domain, code, name);
    `,
  },
];

const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
const NEWER_DB = 'BOBO_NEWER_DB';


const { DatabaseSync } = require('node:sqlite');
const expectedSchemas = new Map();

function storageError(code, message) {
  const error = new Error('BOBO database: ' + message);
  error.code = code;
  return error;
}

function databaseError(error, fallback = 'BOBO_DB_IO') {
  if (typeof error?.code === 'string' && (error.code.startsWith('BOBO_DB_') || error.code === NEWER_DB)) return error;
  const sqlite = Number(error?.errcode) & 255;
  if ([11, 26].includes(sqlite)) return storageError('BOBO_DB_CORRUPT', 'The database is unreadable. Preserve its files and restore a verified backup.');
  if ([5, 6].includes(sqlite) || error?.code === 'EBUSY') return storageError('BOBO_DB_LOCKED', 'The database is busy. Close other programs using it and retry.');
  if ([3, 8, 23].includes(sqlite) || ['EACCES', 'EPERM', 'EROFS'].includes(error?.code)) {
    return storageError('BOBO_DB_PERMISSION', 'The database cannot be written. Check folder permissions and retry.');
  }
  if (sqlite === 13 || ['ENOSPC', 'EDQUOT'].includes(error?.code)) return storageError('BOBO_DB_FULL', 'Storage is full. Free space before retrying.');
  if (sqlite === 14 || ['ENOENT', 'ENOTDIR', 'EISDIR', 'EINVAL'].includes(error?.code)) {
    return storageError('BOBO_DB_PATH', 'The database location is unavailable or invalid.');
  }
  if (sqlite === 10) return storageError('BOBO_DB_IO', 'SQLite reported an I/O error. Keep the database and its sidecars for recovery.');
  return storageError(fallback, fallback === 'BOBO_DB_MIGRATION'
    ? 'The schema update failed and was rolled back. Keep the original database and its migration backup.'
    : 'The storage operation failed. Keep the original files and review the recovery instructions.');
}

function schemaVersion(db) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > LATEST_VERSION) throw storageError(NEWER_DB, 'A newer BOBO version is required to open this database.');
  if (!Number.isSafeInteger(version) || version < 0) throw storageError('BOBO_DB_SCHEMA', 'Invalid schema version.');
  return version;
}

function schemaObjects(db) {
  return db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name")
    .all().map((row) => [row.type, row.name, row.tbl_name, row.sql]);
}

function validateDatabase(db, version, { integrity = true } = {}) {
  if (schemaVersion(db) !== version) throw storageError('BOBO_DB_SCHEMA', 'The schema version does not match the expected version.');
  if (!expectedSchemas.has(version)) {
    const reference = new DatabaseSync(':memory:');
    try {
      for (const step of MIGRATIONS) if (step.version <= version) reference.exec(step.sql);
      expectedSchemas.set(version, JSON.stringify(schemaObjects(reference)));
    } finally { reference.close(); }
  }
  if (JSON.stringify(schemaObjects(db)) !== expectedSchemas.get(version)) {
    throw storageError('BOBO_DB_SCHEMA', 'The database has missing or unexpected schema objects.');
  }
  if (integrity) {
    const checks = db.prepare('PRAGMA integrity_check').all();
    if (checks.length !== 1 || checks[0].integrity_check !== 'ok') {
      throw storageError('BOBO_DB_CORRUPT', 'SQLite integrity validation failed.');
    }
    if (db.prepare('PRAGMA foreign_key_check').get()) {
      throw storageError('BOBO_DB_INTEGRITY', 'The database contains broken record relationships.');
    }
  }
}

function validateDatabaseFile(file, version = LATEST_VERSION) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA trusted_schema = OFF');
    validateDatabase(db, version);
  } finally { db.close(); }
}

class Store {
  #file;
  #db = null;
  #maintenance = false;
  #restartRequired = false;
  #backups = 0;
  #marker;

  constructor({ file }) {
    if (typeof file !== 'string' || !file) throw storageError('BOBO_DB_PATH', 'A storage file is required.');
    this.#file = file;
    this.#marker = file + '.restore-in-progress';
  }

  get file() { return this.#file; }
  get recovered() { return false; }

  open() {
    if (this.#restartRequired) throw storageError('BOBO_DB_RESTORE', 'Restart BOBO to use the restored database.');
    if (this.#maintenance || fs.existsSync(this.#marker)) {
      throw storageError('BOBO_DB_RESTORE', 'A restore needs review. Keep the database and restore files in place.');
    }
    if (this.#db) return this.#db;
    let db;
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true });
      let stat;
      try { stat = fs.lstatSync(this.#file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (stat && !stat.isFile()) throw storageError('BOBO_DB_PATH', 'The database path is not a regular file.');
      if (!stat && ['-wal', '-shm', '-journal'].some((suffix) => fs.existsSync(this.#file + suffix))) {
        throw storageError('BOBO_DB_IO', 'Database sidecars exist without the main file. Preserve them for recovery.');
      }
      if (!stat && fs.readdirSync(path.dirname(this.#file)).some((name) =>
        name.startsWith(path.basename(this.#file) + '.corrupt-') || name.startsWith('before-restore-'))) {
        throw storageError('BOBO_DB_RESTORE', 'The main database is missing and recovery files exist. Preserve them for review.');
      }
      if (stat?.size) {
        const probe = new DatabaseSync(this.#file, { readOnly: true });
        try {
          probe.exec('PRAGMA trusted_schema = OFF');
          validateDatabase(probe, schemaVersion(probe), { integrity: false });
        } finally { probe.close(); }
      }
      db = new DatabaseSync(this.#file);
      db.exec('PRAGMA busy_timeout = 3000; PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF');
      const current = schemaVersion(db);
      validateDatabase(db, current, { integrity: false });
      if (current < LATEST_VERSION) this.#migrate(db, current, Boolean(stat?.size));
      const journal = db.prepare('PRAGMA journal_mode = WAL').get();
      if (journal.journal_mode !== 'wal') throw storageError('BOBO_DB_IO', 'Could not enable WAL mode.');
      this.#db = db;
      return db;
    } catch (error) {
      try { db?.close(); } catch {}
      throw databaseError(error);
    }
  }

  transaction(fn) {
    const db = this.open();
    try {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = fn(db);
        if (typeof result?.then === 'function') throw storageError('BOBO_DB_TRANSACTION', 'Transaction callbacks must be synchronous.');
        db.exec('COMMIT');
        return result;
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch {}
        throw error;
      }
    } catch (error) {
      if (error?.code === 'ERR_SQLITE_ERROR' || error?.errcode) throw databaseError(error);
      throw error;
    }
  }

  close() {
    if (!this.#db) return;
    if (this.#backups) throw storageError('BOBO_DB_LOCKED', 'Wait for the database backup to finish.');
    this.#db.close();
    this.#db = null;
  }

  async withBackup(snapshot) {
    const db = this.open();
    this.#backups++;
    try { return await snapshot(db); }
    finally { this.#backups--; }
  }

  // A synchronous, exclusive restore gate. No application operations can reopen
  // the handle while the replacement callback is running.
  withRestoreLock(replace, recovery) {
    if (this.#backups) throw storageError('BOBO_DB_LOCKED', 'Wait for the database backup to finish.');
    const db = this.open();
    validateDatabase(db, LATEST_VERSION);
    const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    if (checkpoint.busy) throw storageError('BOBO_DB_LOCKED', 'Close other programs using the database before restoring.');
    fs.writeFileSync(this.#marker, JSON.stringify(recovery), { flag: 'wx', mode: 0o600, flush: true });
    this.#maintenance = true;
    let resolved = false;
    try {
      this.close();
      const value = replace();
      this.#restartRequired = true;
      resolved = true;
      return value;
    } catch (error) {
      resolved = error?.code !== 'BOBO_DB_RESTORE_ROLLBACK';
      throw error;
    } finally {
      this.#maintenance = false;
      if (resolved) fs.unlinkSync(this.#marker);
    }
  }

  #migrate(db, current, existing) {
    try {
      if (existing) {
        validateDatabase(db, current);
        const dir = fs.mkdtempSync(path.join(path.dirname(this.#file), 'migration-backup-'));
        const backupFile = path.join(dir, 'bobo.db');
        db.prepare('VACUUM INTO ?').run(backupFile);
        validateDatabaseFile(backupFile, current);
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        if (schemaVersion(db) !== current) throw storageError('BOBO_DB_MIGRATION', 'The schema changed during migration. Retry later.');
        for (const step of MIGRATIONS) {
          if (step.version <= current) continue;
          db.exec(step.sql);
          db.exec('PRAGMA user_version = ' + step.version);
        }
        validateDatabase(db, LATEST_VERSION);
        db.exec('COMMIT');
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch {}
        throw error;
      }
    } catch (error) { throw databaseError(error, 'BOBO_DB_MIGRATION'); }
  }
}

module.exports = { LATEST_VERSION, MIGRATIONS, NEWER_DB, Store, databaseError, storageError, validateDatabaseFile };
