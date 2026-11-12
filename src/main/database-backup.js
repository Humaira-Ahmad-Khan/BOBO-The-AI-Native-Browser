'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { backup, DatabaseSync } = require('node:sqlite');
const { LATEST_VERSION, databaseError, storageError, validateDatabaseFile } = require('./db');

const FORMAT = 'bobo-sqlite-backup-v1';
const SIDECARS = ['-wal', '-shm', '-journal'];

async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function makeStandalone(file) {
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA trusted_schema = OFF');
    if (db.prepare('PRAGMA journal_mode = DELETE').get().journal_mode !== 'delete') {
      throw storageError('BOBO_DB_IO', 'Could not prepare a standalone database snapshot.');
    }
  } finally { db.close(); }
}

async function removeStage(directory, file) {
  for (const suffix of ['', ...SIDECARS]) await fsp.unlink(file + suffix).catch(() => {});
  await fsp.rmdir(directory).catch(() => {});
}

async function makeBackup(store, destination, { signal } = {}) {
  if (typeof destination !== 'string' || !path.isAbsolute(destination)) {
    throw storageError('BOBO_DB_PATH', 'Choose an absolute backup folder.');
  }
  if (signal?.aborted) throw storageError('BOBO_DB_CANCELLED', 'Backup was canceled.');
  store.open();
  const staging = await fsp.mkdtemp(path.join(path.dirname(store.file), 'backup-stage-'))
    .catch((error) => { throw databaseError(error); });
  const staged = path.join(staging, 'snapshot.sqlite');
  const name = `bobo-${new Date().toISOString().slice(0, 10)}-${randomUUID()}.sqlite`;
  const file = path.join(destination, name);
  const manifestPath = `${file}.json`;
  let published = false;
  let manifestOwned = false;
  try {
    signal?.throwIfAborted();
    await store.withBackup((db) => backup(db, staged));
    signal?.throwIfAborted();
    makeStandalone(staged);
    validateDatabaseFile(staged);
    const manifest = {
      format: FORMAT, version: LATEST_VERSION, createdAt: new Date().toISOString(),
      sha256: await digest(staged),
    };
    signal?.throwIfAborted();
    await fsp.copyFile(staged, file, fs.constants.COPYFILE_EXCL);
    published = true;
    signal?.throwIfAborted();
    if (await digest(file) !== manifest.sha256) throw storageError('BOBO_DB_MANIFEST', 'The exported backup checksum did not match.');
    signal?.throwIfAborted();
    const handle = await fsp.open(manifestPath, 'wx', 0o600);
    manifestOwned = true;
    try { await handle.writeFile(JSON.stringify(manifest, null, 2)); }
    finally { await handle.close(); }
    return { file, manifestPath, version: manifest.version };
  } catch (error) {
    if (published) await fsp.unlink(file).catch(() => {});
    if (manifestOwned) await fsp.unlink(manifestPath).catch(() => {});
    if (signal?.aborted) throw storageError('BOBO_DB_CANCELLED', 'Backup was canceled.');
    throw databaseError(error);
  } finally {
    await removeStage(staging, staged);
  }
}

async function readManifest(file) {
  const manifestPath = `${file}.json`;
  const stat = await fsp.lstat(manifestPath);
  if (!stat.isFile() || stat.size > 4096) throw storageError('BOBO_DB_MANIFEST', 'The backup manifest is invalid.');
  let manifest;
  try { manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8')); } catch {
    throw storageError('BOBO_DB_MANIFEST', 'The backup manifest cannot be read.');
  }
  if (manifest?.format !== FORMAT || manifest.version !== LATEST_VERSION ||
    !/^[a-f0-9]{64}$/.test(manifest.sha256) || typeof manifest.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(manifest.createdAt))) {
    throw storageError('BOBO_DB_MANIFEST', 'The backup format or schema version is unsupported.');
  }
  return manifest;
}

// Trusted main-process entry point. The caller supplies native selection and confirmation.
async function restoreBackup(store, selectedFile, confirm) {
  if (typeof selectedFile !== 'string' || !path.isAbsolute(selectedFile) || typeof confirm !== 'function') {
    throw storageError('BOBO_DB_PATH', 'Select and confirm a backup file.');
  }
  const staging = await fsp.mkdtemp(path.join(path.dirname(store.file), 'restore-stage-'))
    .catch((error) => { throw databaseError(error); });
  const staged = path.join(staging, 'snapshot.sqlite');
  const rollback = path.join(path.dirname(store.file), `before-restore-${randomUUID()}.sqlite`);
  let preserveStaging = false;
  try {
    const stat = await fsp.lstat(selectedFile);
    if (!stat.isFile()) throw storageError('BOBO_DB_PATH', 'Select a regular backup file.');
    const manifest = await readManifest(selectedFile);
    await fsp.copyFile(selectedFile, staged, fs.constants.COPYFILE_EXCL);
    if (await digest(staged) !== manifest.sha256) throw storageError('BOBO_DB_MANIFEST', 'The backup checksum did not match.');
    validateDatabaseFile(staged);
    if (await confirm({ version: manifest.version, createdAt: manifest.createdAt }) !== true) {
      return { canceled: true };
    }
    if (await digest(staged) !== manifest.sha256) throw storageError('BOBO_DB_MANIFEST', 'The staged backup changed.');
    makeStandalone(staged);
    validateDatabaseFile(staged);
    store.withRestoreLock(() => {
      if (SIDECARS.some((suffix) => fs.existsSync(store.file + suffix))) {
        throw storageError('BOBO_DB_LOCKED', 'Database sidecars are still in use. Close other programs and retry.');
      }
      fs.renameSync(store.file, rollback);
      let installed = false;
      try {
        fs.renameSync(staged, store.file);
        installed = true;
        validateDatabaseFile(store.file);
      } catch (error) {
        try {
          if (installed) fs.renameSync(store.file, staged);
          fs.renameSync(rollback, store.file);
        } catch {
          throw storageError('BOBO_DB_RESTORE_ROLLBACK', 'Restore rollback needs manual recovery. Preserve all database files.');
        }
        throw error;
      }
    }, { rollback: path.basename(rollback), staging: path.basename(staging) });
    return { canceled: false, rollback };
  } catch (error) {
    preserveStaging = error?.code === 'BOBO_DB_RESTORE_ROLLBACK';
    throw databaseError(error);
  } finally {
    if (!preserveStaging) {
      await removeStage(staging, staged);
    }
  }
}

async function restoreFromDialog(store, window) {
  const { dialog } = require('electron');
  const parent = window ? [window] : [];
  const choice = await dialog.showOpenDialog(...parent, {
    title: 'Select a BOBO database backup',
    properties: ['openFile'],
    filters: [{ name: 'BOBO database backup', extensions: ['sqlite'] }],
  });
  if (choice.canceled || !choice.filePaths[0]) return { canceled: true };
  return restoreBackup(store, choice.filePaths[0], async ({ version, createdAt }) => {
    const result = await dialog.showMessageBox(...parent, {
      type: 'warning', title: 'Restore BOBO database',
      message: `Replace BOBO’s local database with the backup from ${createdAt}?`,
      detail: `Schema ${version}. This replaces local bookmarks, history, saved groups, downloads and tool database records. Chromium cookies and separate preferences are excluded.`,
      buttons: ['Cancel', 'Restore'], cancelId: 0, defaultId: 0,
    });
    return result.response === 1;
  });
}

module.exports = { makeBackup, restoreBackup, restoreFromDialog };
