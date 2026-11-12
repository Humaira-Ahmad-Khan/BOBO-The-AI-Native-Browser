'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Profiles, COLORS, configureProfilePaths, profileArguments } = require('../../src/main/profiles');

test('profiles preserve the default directory and persist new profile identities', (t) => {
  const root = fs.mkdtempSync(path.join(__dirname, '../.tmp/profiles-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profiles = new Profiles(root);
  assert.equal(profiles.directory('default'), root);
  fs.writeFileSync(path.join(root, 'existing-data'), 'original');
  const work = profiles.edit({ name: 'Work', color: COLORS[1] });
  assert.equal(profiles.directory(work.id), path.join(root, 'profiles', work.id));
  const reopened = new Profiles(root);
  reopened.edit({ id: work.id, name: 'Office', color: COLORS[2] });
  assert.equal(reopened.list()[1].name, 'Office');
  assert.equal(reopened.list()[1].id, work.id);
  assert.equal(fs.readFileSync(path.join(root, 'existing-data'), 'utf8'), 'original');
  assert.throws(() => profiles.directory('../../outside'), /not found/);
  assert.throws(() => profiles.edit({ id: 'missing', name: 'x', color: COLORS[0] }), /not found/);
  const paths = {};
  const app = { getPath: () => root, setPath: (key, value) => { paths[key] = value; }, setAppLogsPath() {} };
  configureProfilePaths(app, ['BOBO', '--bobo-profile=' + work.id]);
  assert.equal(paths.userData, profiles.directory(work.id));
  assert.equal(paths.sessionData, paths.userData);
});

test('profile errors retain the registry and relaunch arguments do not repeat setup', (t) => {
  const root = fs.mkdtempSync(path.join(__dirname, '../.tmp/profiles-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profiles = new Profiles(root);
  fs.writeFileSync(profiles.file, '{broken');
  assert.throws(() => profiles.edit({ name: 'Work', color: COLORS[0] }), /preserved/);
  assert.equal(fs.readFileSync(profiles.file, 'utf8'), '{broken');
  assert.deepEqual(profileArguments(['electron', '.', '--squirrel-firstrun', '--bobo-profile=default'], 'next'),
    ['.', '--bobo-profile=next']);
});
