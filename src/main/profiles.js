'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const COLORS = ['#287ca7', '#7157b8', '#b65b27', '#2c8068', '#b94671'];
const DEFAULT = { id: 'default', name: 'Default', color: COLORS[0] };
const validId = (id) => id === 'default' || /^[a-f0-9-]{36}$/.test(id);

class Profiles {
  constructor(root) {
    this.root = root;
    this.file = path.join(root, 'profiles.json');
  }

  list() {
    let data;
    try { data = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return [{ ...DEFAULT }];
      throw new Error('BOBO could not read its profile list. The existing file has been preserved.');
    }
    if (!data || data.version !== 1 || !Array.isArray(data.profiles) || data.profiles.length > 32 ||
        !data.profiles.some((entry) => entry.id === 'default') ||
        new Set(data.profiles.map((entry) => entry.id)).size !== data.profiles.length ||
        data.profiles.some((entry) => !validId(entry.id) || typeof entry.name !== 'string' ||
          !entry.name.trim() || entry.name.length > 50 || !COLORS.includes(entry.color))) {
      throw new Error('BOBO found an invalid profile list. The existing file has been preserved.');
    }
    return data.profiles;
  }

  directory(id) {
    if (!this.list().some((profile) => profile.id === id)) throw new Error('BOBO profile not found.');
    return id === 'default' ? this.root : path.join(this.root, 'profiles', id);
  }

  edit({ id, name, color }) {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 50 || !COLORS.includes(color)) {
      throw new Error('Choose a profile name of 1–50 characters and a profile colour.');
    }
    return this.#update((profiles) => {
      let entry = profiles.find((profile) => profile.id === id);
      if (id && !entry) throw new Error('BOBO profile not found.');
      if (!entry) {
        if (profiles.length >= 32) throw new Error('BOBO supports up to 32 profiles.');
        entry = { id: randomUUID() };
        profiles.push(entry);
      }
      Object.assign(entry, { name: name.trim(), color });
      return entry;
    });
  }

  /**
   * Remove a profile from the list. The Default profile can never be removed.
   * The profile's data folder is left on disk untouched, so nothing is lost.
   */
  remove(id) {
    if (id === 'default') throw new Error('The Default profile cannot be deleted.');
    return this.#update((profiles) => {
      const index = profiles.findIndex((profile) => profile.id === id);
      if (index < 0) throw new Error('BOBO profile not found.');
      return profiles.splice(index, 1)[0];
    });
  }

  #update(change) {
    fs.mkdirSync(this.root, { recursive: true });
    const lock = this.file + '.lock';
    const handle = fs.openSync(lock, 'wx');
    const temporary = this.file + '.' + randomUUID() + '.tmp';
    try {
      const profiles = this.list();
      const entry = change(profiles);
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, profiles }, null, 2), { flag: 'wx', flush: true });
      fs.renameSync(temporary, this.file);
      return entry;
    } finally {
      fs.closeSync(handle);
      fs.unlinkSync(lock);
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}

function configureProfilePaths(app, argv = process.argv) {
  const profiles = new Profiles(app.getPath('userData'));
  if (argv.some((arg) => arg.startsWith('--squirrel-'))) {
    return { profiles, id: 'default', selected: false };
  }
  const selected = argv.find((arg) => arg.startsWith('--bobo-profile='));
  const id = selected ? selected.slice('--bobo-profile='.length) : 'default';
  const directory = profiles.directory(id);
  if (id !== 'default') {
    fs.mkdirSync(directory, { recursive: true });
    app.setPath('userData', directory);
    app.setPath('sessionData', directory);
    const dumps = path.join(directory, 'crashDumps');
    fs.mkdirSync(dumps, { recursive: true });
    app.setPath('crashDumps', dumps);
    app.setAppLogsPath(path.join(directory, 'logs'));
  }
  return { profiles, id, selected: Boolean(selected) };
}

function profileArguments(argv, id) {
  const args = argv.slice(1).filter((arg) => !arg.startsWith('--bobo-profile=') &&
    arg !== '--bobo-choose-profile' && arg !== '--bobo-restore-database' && !arg.startsWith('--squirrel-'));
  return [...args, id ? `--bobo-profile=${id}` : '--bobo-choose-profile'];
}

module.exports = { COLORS, Profiles, configureProfilePaths, profileArguments };
